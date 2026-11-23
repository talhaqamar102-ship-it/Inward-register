import {
  OrderWipState,
  escapeHtml,
  formatCurrentDateDDMMYYYY,
  getAlterationReqNumber,
  normalizeBaseReqNumber
} from '../utils/requisitionLogic';
import {
  closeModal,
  exportTableToCSV,
  openModal,
  printDocument,
  showToast
} from '../utils/domModalsAndPrint';
import { renderApp } from '../appContext';
import { saveTailorName, state } from '../state/appState';
import { saveCurrentOrderWipState, syncBackendData } from '../state/syncService';

export function attachRepairHandlers(): void {
  const defaultAltId = getAlterationReqNumber(state.packingWip.selectedBatch);
  const batchSelect = document.getElementById('defect-batch-id') as HTMLSelectElement | null;
  const articleSelect = document.getElementById('defect-article') as HTMLSelectElement | null;
  const tailorSelect = document.getElementById('defect-tailor-select') as HTMLSelectElement | null;
  const tailorInput = document.getElementById('defect-tailor') as HTMLInputElement | null;

  batchSelect?.addEventListener('change', () => {
    state.repairForm.batchId = batchSelect.value;
    state.repairForm.article = '';
    renderApp();
  });

  articleSelect?.addEventListener('change', () => {
    state.repairForm.article = articleSelect.value;
    renderApp();
  });

  // --- Section: Form Controls & Tailor Assignment ---
  document.getElementById('btn-repair-toggle-all')?.addEventListener('click', () => {
    (state.repairForm as any).showAllBatches = !(state.repairForm as any).showAllBatches;
    if (!(state.repairForm as any).showAllBatches) {
      state.repairForm.batchId = '';
    }
    renderApp();
  });

  document.getElementById('btn-repair-max-qty')?.addEventListener('click', () => {
    const btn = document.getElementById('btn-repair-max-qty');
    const qtyInput = document.getElementById('defect-qty') as HTMLInputElement | null;
    const maxVal = btn?.getAttribute('data-max-qty') || '0';
    if (qtyInput) qtyInput.value = maxVal;
  });

  const getTailor = (fallback: string): string => {
    const selected = tailorSelect?.value || '__custom__';
    const name = selected === '__custom__' ? tailorInput?.value.trim() || '' : selected;
    state.repairForm.tailor = name;
    return name || fallback;
  };
  const applyAlterationOutcome = (batchId: string, quantity: number, outcome: 'repaired' | 'scrapped'): boolean => {
    const reqNumber = normalizeBaseReqNumber(batchId);
    const wip = normalizeBaseReqNumber(state.packingWip.selectedBatch) === reqNumber
      ? state.packingWip
      : state.ordersWipMap[reqNumber] as OrderWipState | undefined;
    if (!wip) {
      showToast(`No Packing Hall WIP record is available for ${batchId}; the alteration was not closed.`);
      return false;
    }
    const availableAlteration = Math.max(0, Number(wip.inAlteration || 0) - Number(wip.scrappedPairs || 0));
    if (quantity > availableAlteration) {
      showToast(`Only ${availableAlteration} pairs are currently in alteration for ${batchId}.`);
      return false;
    }

    if (outcome === 'repaired') {
      wip.inAlteration = Math.max(0, Number(wip.inAlteration || 0) - quantity);
      wip.stage1In = Number(wip.stage1In || 0) + quantity;
    } else {
      wip.scrappedPairs = Number(wip.scrappedPairs || 0) + quantity;
    }
    if (wip === state.packingWip) {
      saveCurrentOrderWipState();
    } else {
      state.ordersWipMap[reqNumber] = JSON.parse(JSON.stringify(wip));
    }
    return true;
  };

  tailorSelect?.addEventListener('change', () => {
    state.repairForm.tailor = tailorSelect.value === '__custom__' ? (tailorInput?.value || '') : tailorSelect.value;
  });
  tailorInput?.addEventListener('input', () => {
    if (tailorSelect?.value === '__custom__') state.repairForm.tailor = tailorInput.value;
  });

  const getDefectSummaryForReq = (reqNumber: string): string => {
    const activeReasons = Array.from(new Set(
      state.defectList
        .filter(d => (d.rawStatus === 'SENT_FOR_ALTERATION' || d.status === 'In Rework') && normalizeBaseReqNumber(d.reqNumber || d.id) === reqNumber)
        .map(d => String(d.defectClass || '').trim())
        .filter(Boolean)
    ));
    return activeReasons.length > 0 ? activeReasons.join(', ') : 'Workmanship Defect';
  };

  document.getElementById('btn-assign-tailor')?.addEventListener('click', async () => {
    const batchId = (document.getElementById('defect-batch-id') as HTMLSelectElement)?.value || defaultAltId;
    const tailor = getTailor('');
    if (!tailor) {
      showToast('Select or enter a tailor name before assigning.');
      return;
    }
    const qtyNum = parseInt((document.getElementById('defect-qty') as HTMLInputElement)?.value || '0', 10) || 0;
    const targetReq = normalizeBaseReqNumber(batchId);
    const openServerRows = state.defectList.filter(
      d => d.altId && d.rawStatus === 'SENT_FOR_ALTERATION' && normalizeBaseReqNumber(d.reqNumber || d.id) === targetReq
    );
    if (openServerRows.length > 0) {
      const totalOpen = openServerRows.reduce((sum, d) => sum + Number(d.pairsCount || 0), 0);
      const assignQty = qtyNum > 0 ? qtyNum : totalOpen;
      if (assignQty <= 0 || assignQty > totalOpen) {
        showToast(`Enter an assign quantity between 1 and ${totalOpen} pairs.`);
        return;
      }
      try {
        const res = await fetch('/api/alterations/assign', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reqNumber: targetReq, tailorName: tailor, pairsCount: assignQty })
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || 'Unable to assign tailor.');
        }
        saveTailorName(tailor);
        await syncBackendData();
        showToast(`Assigned ${assignQty} pairs of ${batchId} to ${tailor}.`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Unable to assign tailor.');
      }
      return;
    }
    state.defectList.forEach(d => {
      if (normalizeBaseReqNumber(d.reqNumber || d.id) === targetReq && (d.rawStatus === 'SENT_FOR_ALTERATION' || d.status === 'In Rework')) {
        d.tailor = tailor;
      }
    });
    saveTailorName(tailor);
    renderApp();
    showToast(`Assigned ${batchId} to ${tailor}.`);
  });

  const handleAlterationSubmit = async (isScrap: boolean) => {
    const batchId = (document.getElementById('defect-batch-id') as HTMLSelectElement)?.value || defaultAltId;
    const article = (document.getElementById('defect-article') as HTMLSelectElement)?.value || state.packingWip.article || '---';
    const po = (document.getElementById('defect-po') as HTMLSelectElement)?.value || state.packingWip.po || '---';
    const targetReq = normalizeBaseReqNumber(batchId);
    const defectType = getDefectSummaryForReq(targetReq);
    const tailor = getTailor(isScrap ? 'Scrap Authority' : 'Supervisor A');
    const qtyNum = parseInt((document.getElementById('defect-qty') as HTMLInputElement)?.value || '0', 10) || 0;

    if (qtyNum <= 0) {
      showToast(isScrap ? 'Enter a scrap quantity greater than zero.' : 'Enter a repair quantity greater than zero.');
      return;
    }
    const openServerRows = state.defectList.filter(
      d => d.altId && d.rawStatus === 'SENT_FOR_ALTERATION' && normalizeBaseReqNumber(d.reqNumber || d.id) === targetReq
    );

    if (openServerRows.length > 0) {
      const totalOpen = openServerRows.reduce((sum, d) => sum + Number(d.pairsCount || 0), 0);
      if (qtyNum > totalOpen) {
        showToast(`Only ${totalOpen} pairs are currently pending alteration for ${batchId}.`);
        return;
      }
      try {
        let remaining = qtyNum;
        for (const row of openServerRows) {
          if (remaining <= 0) break;
          const rowPairs = Number(row.pairsCount || 0);
          const pairsCount = Math.min(remaining, rowPairs);
          const res = await fetch(`/api/alterations/${row.altId}/repair`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tailorName: tailor,
              isScrap,
              deductionRate: 150,
              pairsCount
            })
          });
          const json = await res.json();
          if (!res.ok || !json.success) {
            throw new Error(json.error || 'Unable to save alteration outcome.');
          }
          remaining -= pairsCount;
        }
        saveTailorName(tailor);
        state.repairForm.qty = '';
        await syncBackendData();
        showToast(isScrap
          ? `Alteration ${batchId} (${qtyNum} pairs) logged as Scrap.`
          : `Alteration ${batchId} (${qtyNum} pairs) marked complete and returned to STAGE 1 Checking.`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Unable to save alteration outcome.');
      }
      return;
    }

    if (!applyAlterationOutcome(batchId, qtyNum, isScrap ? 'scrapped' : 'repaired')) return;
    saveTailorName(tailor);
    state.defectList.unshift({
      id: batchId,
      date: formatCurrentDateDDMMYYYY(),
      origin: 'Stage 1 Checking',
      article,
      po,
      defectClass: defectType,
      qty: `${qtyNum} Prs`,
      tailor,
      status: isScrap ? 'Scrapped' : 'Completed',
      route: isScrap ? 'Scrap Ledger' : 'Auto-Return to Stage 1 Checking',
      actionText: isScrap ? 'Scrapped' : 'Verified'
    });
    renderApp();
    showToast(isScrap
      ? `Alteration ${batchId} logged as Scrap/Unrepairable.`
      : `Alteration ${batchId} marked complete and auto-routed to STAGE 1 Checking.`);
  };

  // --- Section: Complete Repair & Scrap Actions ---
  document.getElementById('btn-complete-repair')?.addEventListener('click', () => void handleAlterationSubmit(false));
  document.getElementById('btn-log-scrap')?.addEventListener('click', () => void handleAlterationSubmit(true));

  // --- Section: Split Return / Scrap Modal & Row Actions ---
  document.querySelectorAll<HTMLElement>('[data-alt-split-id]').forEach(btn => {
    btn.addEventListener('click', () => {
      const altId = Number(btn.getAttribute('data-alt-split-id') || 0);
      const totalPairs = Number(btn.getAttribute('data-alt-pairs') || 0);
      const rowTailor = btn.getAttribute('data-alt-tailor') || 'Supervisor A';
      const rowReq = btn.getAttribute('data-alt-req') || defaultAltId;
      if (!altId || totalPairs <= 0) return;

      openModal(`Split Outcome — ${escapeHtml(rowReq)}`, `
        <div style="font-size: 13px;">
          <p style="margin: 0 0 12px; color: var(--ink-700);">
            Batch with <strong>${escapeHtml(rowTailor)}</strong>: <strong>${totalPairs} Pairs</strong> pending. Enter how many pairs are returning repaired to Stage 1 and/or scrapped.
          </p>
          <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 14px;">
            <div class="form-group">
              <label for="alt-split-return">Return to Stage 1 (Repaired)</label>
              <input type="number" id="alt-split-return" class="form-input" min="0" max="${totalPairs}" value="${totalPairs}" />
            </div>
            <div class="form-group">
              <label for="alt-split-scrap">Log as Scrap (Unrepairable)</label>
              <input type="number" id="alt-split-scrap" class="form-input" min="0" max="${totalPairs}" value="0" />
            </div>
          </div>
          <div id="alt-split-summary" style="padding: 8px 10px; border: 1px solid var(--border-subtle); border-radius: 4px; background: var(--ink-50); font-size: 12px; color: var(--ink-700); margin-bottom: 14px;">
            Remaining in Rework after save: <strong>0 Pairs</strong>
          </div>
          <div style="display: flex; justify-content: flex-end; gap: 8px;">
            <button type="button" class="btn-outline" data-modal-cancel>Cancel</button>
            <button type="button" class="btn-primary" id="btn-confirm-alt-split">Confirm Outcome</button>
          </div>
        </div>
      `, false, { hideGlobalFooter: true });

      const returnInput = document.getElementById('alt-split-return') as HTMLInputElement | null;
      const scrapInput = document.getElementById('alt-split-scrap') as HTMLInputElement | null;
      const summaryEl = document.getElementById('alt-split-summary');
      const updateSummary = () => {
        const retVal = Math.max(0, parseInt(returnInput?.value || '0', 10) || 0);
        const scrVal = Math.max(0, parseInt(scrapInput?.value || '0', 10) || 0);
        const rem = totalPairs - retVal - scrVal;
        if (summaryEl) {
          summaryEl.innerHTML = rem < 0
            ? `<span style="color: #991B1B; font-weight: 700;">Total (${retVal + scrVal}) exceeds ${totalPairs} pending pairs.</span>`
            : `Remaining in Rework after save: <strong>${rem} Pairs</strong>`;
        }
      };

      scrapInput?.addEventListener('input', () => {
        const scrVal = Math.min(totalPairs, Math.max(0, parseInt(scrapInput.value || '0', 10) || 0));
        if (returnInput) returnInput.value = String(Math.max(0, totalPairs - scrVal));
        updateSummary();
      });
      returnInput?.addEventListener('input', updateSummary);

      let splitInFlight = false;
      document.getElementById('btn-confirm-alt-split')?.addEventListener('click', async () => {
        if (splitInFlight) return;
        const retVal = Math.max(0, parseInt(returnInput?.value || '0', 10) || 0);
        const scrVal = Math.max(0, parseInt(scrapInput?.value || '0', 10) || 0);
        if (retVal + scrVal <= 0 || retVal + scrVal > totalPairs) {
          showToast(`Enter valid Return + Scrap quantities between 1 and ${totalPairs} pairs.`);
          return;
        }
        splitInFlight = true;
        const effectiveTailor = getTailor(rowTailor) || rowTailor;
        try {
          if (retVal > 0) {
            const res = await fetch(`/api/alterations/${altId}/repair`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tailorName: effectiveTailor, isScrap: false, deductionRate: 150, pairsCount: retVal })
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Unable to return repaired pairs.');
          }
          if (scrVal > 0) {
            const res = await fetch(`/api/alterations/${altId}/repair`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tailorName: effectiveTailor, isScrap: true, deductionRate: 150, pairsCount: scrVal })
            });
            const json = await res.json();
            if (!res.ok || !json.success) throw new Error(json.error || 'Unable to log scrap pairs.');
          }
          closeModal();
          saveTailorName(effectiveTailor);
          await syncBackendData();
          showToast(`Processed ${rowReq}: ${retVal} returned to Stage 1, ${scrVal} scrapped.`);
        } catch (err) {
          showToast(err instanceof Error ? err.message : 'Unable to save split outcome.');
        } finally {
          splitInFlight = false;
        }
      });
    });
  });

  document.querySelectorAll<HTMLElement>('[data-alt-row-return], [data-alt-row-scrap]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isScrap = btn.hasAttribute('data-alt-row-scrap');
      const altId = Number(btn.getAttribute(isScrap ? 'data-alt-row-scrap' : 'data-alt-row-return') || 0);
      if (!altId) return;
      const qtyInput = document.querySelector<HTMLInputElement>(`[data-alt-qty-id="${altId}"]`);
      const maxPairs = Number(qtyInput?.getAttribute('max') || 0);
      const pairsCount = parseInt(qtyInput?.value || '0', 10) || 0;
      if (pairsCount <= 0 || (maxPairs > 0 && pairsCount > maxPairs)) {
        showToast(`Enter a valid quantity between 1 and ${maxPairs || 1} pairs.`);
        return;
      }
      const rowTailor = btn.getAttribute('data-alt-tailor') || '';
      const tailor = getTailor(rowTailor || (isScrap ? 'Scrap Authority' : 'Supervisor A'));
      try {
        const res = await fetch(`/api/alterations/${altId}/repair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tailorName: tailor, isScrap, deductionRate: 150, pairsCount })
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || 'Unable to update alteration record.');
        }
        saveTailorName(tailor);
        await syncBackendData();
        showToast(json.data?.message || (isScrap ? `${pairsCount} pairs logged as Scrap.` : `${pairsCount} pairs returned to STAGE 1 Checking.`));
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Unable to update alteration record.');
      }
    });
  });

  document.querySelectorAll<HTMLElement>('[data-alt-row-print]').forEach(btn => {
    btn.addEventListener('click', () => {
      const selBatch = btn.getAttribute('data-alt-req') || defaultAltId;
      const selArt = (document.getElementById('defect-article') as HTMLSelectElement | HTMLElement | null)?.textContent?.trim()
        || (document.getElementById('defect-article') as HTMLSelectElement | null)?.value
        || state.packingWip.article
        || '---';
      const selPo = (document.getElementById('defect-po') as HTMLElement | null)?.textContent?.replace(/^PO\s+/i, '').trim()
        || state.packingWip.po
        || '---';
      const selColor = (document.getElementById('defect-color') as HTMLElement | null)?.textContent?.replace(/^Colour\s+/i, '').trim()
        || '---';
      const selDefect = btn.getAttribute('data-alt-defect') || getDefectSummaryForReq(normalizeBaseReqNumber(selBatch));
      const selTailor = escapeHtml(btn.getAttribute('data-alt-tailor') || getTailor('---'));
      const altId = btn.getAttribute('data-alt-row-print') || '';
      const qtyInput = document.querySelector<HTMLInputElement>(`[data-alt-qty-id="${altId}"]`);
      const selQty = qtyInput?.value || btn.getAttribute('data-alt-pairs') || '0';

      const docHtml = `
        <div style="border: 2px dashed var(--ink-900); padding: 18px; background: var(--white); color: var(--ink-950); font-family: sans-serif;">
          <div style="text-align: center; border-bottom: 2px solid var(--ink-900); padding-bottom: 10px; margin-bottom: 14px;">
            <div style="font-size: 18px; font-weight: 800; color: var(--ink-950); letter-spacing: 0.05em;">MANDATORY REWORK ROUTE TAG</div>
            <div style="font-size: 12px; font-weight: bold; color: var(--ink-600);">الٹریشن اور مرمت کا سرکاری روٹ کارڈ</div>
          </div>
          <div class="printable-meta-grid" style="color: var(--ink-950);">
            <div><span>Alteration Requisition #:</span> <strong>${escapeHtml(selBatch)}</strong></div>
            <div><span>Parent Requisition #:</span> <strong>${escapeHtml(normalizeBaseReqNumber(selBatch))}</strong></div>
            <div><span>Article Name:</span> <strong>${escapeHtml(selArt)}</strong></div>
            <div><span>Color:</span> <strong>${escapeHtml(selColor)}</strong></div>
            <div><span>PO Number:</span> <strong>${escapeHtml(selPo)}</strong></div>
            <div><span>Defect Category:</span> <strong>${escapeHtml(selDefect)}</strong></div>
            <div><span>Batch Quantity:</span> <strong>${escapeHtml(selQty)} Pairs</strong></div>
            <div><span>Assigned Master Tailor:</span> <strong>${selTailor}</strong></div>
            <div><span>Max Rework Policy:</span> <strong>Strict 2-Cycle Limit &rarr; Auto-Scrap</strong></div>
          </div>
          <div style="background: var(--ink-100); border: 1px solid var(--ink-900); padding: 10px; border-radius: 4px; text-align: center; font-weight: 800; font-size: 12px; margin: 14px 0; color: var(--ink-950);">
            SHOP-FLOOR ENFORCEMENT: ALL REPAIRED UNITS MUST RETURN DIRECTLY TO STAGE 1 CHECKING FOR 100% RE-INSPECTION. SKIPPING INSPECTION IS SYSTEM-BLOCKED.
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 20px; border-top: 1px dashed var(--ink-500); padding-top: 8px;">
            <span>Tailor Sign (درزی دستخط): _______________</span>
            <span>Alteration Bay Lead: _______________</span>
            <span>Approved By: _______________</span>
          </div>
        </div>
      `;

      openModal(`Alteration Route Tag - ${selBatch}`, docHtml);
      printDocument(`Alteration Route Tag - ${selBatch}`, docHtml);
    });
  });

  document.querySelectorAll<HTMLElement>('[data-alt-return-id], [data-alt-scrap-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const isScrap = btn.hasAttribute('data-alt-scrap-id');
      const altId = Number(btn.getAttribute(isScrap ? 'data-alt-scrap-id' : 'data-alt-return-id') || 0);
      if (!altId) return;
      const tailor = getTailor(isScrap ? 'Scrap Authority' : 'Supervisor A');
      try {
        const res = await fetch(`/api/alterations/${altId}/repair`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tailorName: tailor, isScrap, deductionRate: 150 })
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          throw new Error(json.error || 'Unable to update alteration record.');
        }
        saveTailorName(tailor);
        await syncBackendData();
        showToast(json.data?.message || (isScrap ? `Alteration #${altId} logged as Scrap.` : `Alteration #${altId} returned to STAGE 1 Checking.`));
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Unable to update alteration record.');
      }
    });
  });

  // --- Section: Defect Tag Print & Pareto Export ---
  document.getElementById('btn-print-defect-tag')?.addEventListener('click', () => {
    const selBatch = (document.getElementById('defect-batch-id') as HTMLSelectElement)?.value || defaultAltId;
    const selArt = (document.getElementById('defect-article') as HTMLSelectElement)?.value || state.packingWip.article || '---';
    const selPo = (document.getElementById('defect-po') as HTMLSelectElement)?.value || state.packingWip.po || '---';
    const selColor = (document.getElementById('defect-color') as HTMLInputElement)?.value || '---';
    const selDefect = getDefectSummaryForReq(normalizeBaseReqNumber(selBatch));
    const selTailor = escapeHtml(getTailor('---'));
    const selQty = (document.getElementById('defect-qty') as HTMLInputElement)?.value || '0';

    const docHtml = `
      <div style="border: 2px dashed var(--ink-900); padding: 18px; background: var(--white); color: var(--ink-950); font-family: sans-serif;">
        <div style="text-align: center; border-bottom: 2px solid var(--ink-900); padding-bottom: 10px; margin-bottom: 14px;">
          <div style="font-size: 18px; font-weight: 800; color: var(--ink-950); letter-spacing: 0.05em;">MANDATORY REWORK ROUTE TAG</div>
          <div style="font-size: 12px; font-weight: bold; color: var(--ink-600);">الٹریشن اور مرمت کا سرکاری روٹ کارڈ</div>
        </div>
        <div class="printable-meta-grid" style="color: var(--ink-950);">
          <div><span>Alteration Requisition #:</span> <strong>${escapeHtml(selBatch)}</strong></div>
          <div><span>Parent Requisition #:</span> <strong>${escapeHtml(normalizeBaseReqNumber(selBatch))}</strong></div>
          <div><span>Article Name:</span> <strong>${escapeHtml(selArt)}</strong></div>
          <div><span>Color:</span> <strong>${escapeHtml(selColor)}</strong></div>
          <div><span>PO Number:</span> <strong>${escapeHtml(selPo)}</strong></div>
          <div><span>Defect Category:</span> <strong>${escapeHtml(selDefect)}</strong></div>
          <div><span>Batch Quantity:</span> <strong>${escapeHtml(selQty)} Pairs</strong></div>
          <div><span>Assigned Master Tailor:</span> <strong>${selTailor}</strong></div>
          <div><span>Max Rework Policy:</span> <strong>Strict 2-Cycle Limit &rarr; Auto-Scrap</strong></div>
        </div>
        <div style="background: var(--ink-100); border: 1px solid var(--ink-900); padding: 10px; border-radius: 4px; text-align: center; font-weight: 800; font-size: 12px; margin: 14px 0; color: var(--ink-950);">
          SHOP-FLOOR ENFORCEMENT: ALL REPAIRED UNITS MUST RETURN DIRECTLY TO STAGE 1 CHECKING FOR 100% RE-INSPECTION. SKIPPING INSPECTION IS SYSTEM-BLOCKED.
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 20px; border-top: 1px dashed var(--ink-500); padding-top: 8px;">
          <span>Tailor Sign (درزی دستخط): _______________</span>
          <span>Alteration Bay Lead: _______________</span>
          <span>Approved By: _______________</span>
        </div>
      </div>
    `;

    openModal(`Alteration Route Tag - ${selBatch}`, docHtml);
    printDocument(`Alteration Route Tag - ${selBatch}`, docHtml);
  });

  document.getElementById('btn-export-pareto')?.addEventListener('click', () => {
    exportTableToCSV('Alteration_Rework_Pareto.csv', state.defectList);
    showToast('Rework Pareto Analysis CSV generated.');
  });

  document.getElementById('btn-print-defect-sheet')?.addEventListener('click', () => {
    const tableRows = state.defectList.map((d, i) => `
      <tr>
        <td style="border: 1px solid var(--border-strong); padding: 6px; text-align: center;">${i + 1}</td>
        <td style="border: 1px solid var(--border-strong); padding: 6px;"><strong>${d.id}</strong></td>
        <td style="border: 1px solid var(--border-strong); padding: 6px;">${d.article} (PO: ${d.po})</td>
        <td style="border: 1px solid var(--border-strong); padding: 6px;"><strong>${d.defectClass}</strong></td>
        <td style="border: 1px solid var(--border-strong); padding: 6px; text-align: right; font-weight: bold;">${d.qty}</td>
        <td style="border: 1px solid var(--border-strong); padding: 6px;">${d.tailor}</td>
        <td style="border: 1px solid var(--border-strong); padding: 6px; text-align: center;">Cycle 1 / 2</td>
        <td style="border: 1px solid var(--border-strong); padding: 6px; text-align: center; font-weight: bold;">${d.status}</td>
      </tr>
    `).join('');

    const totDefects = state.defectList.reduce((acc, x) => acc + (parseInt(String(x.qty), 10) || 0), 0);

    const docHtml = `
      <div class="printable-slip-box">
        <div class="printable-slip-header">
          <h2 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--ink-950);">HAMMAD INDUSTRIES &bull; DAILY DEFECT &amp; ALTERATION SUMMARY LOG</h2>
          <p style="margin: 3px 0 0; font-size: 11px; text-transform: uppercase; color: var(--ink-600);">
            Alteration &amp; Repair Bay #2 (${defaultAltId}) &bull; Date: ${formatCurrentDateDDMMYYYY()}
          </p>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 11px;">
          <thead>
            <tr style="background: var(--ink-100); color: var(--ink-950);">
              <th style="border: 1px solid var(--border-strong); padding: 6px; text-align: center;">#</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px;">Alteration Req #</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px;">Article &amp; PO</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px;">Defect Reason</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px; text-align: right;">Pairs</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px;">Master Tailor</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px; text-align: center;">Reworks</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px; text-align: center;">Status</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || `<tr><td colspan="8" style="border: 1px solid var(--border-strong); padding: 12px; text-align: center;">No alteration entries recorded.</td></tr>`}
            <tr style="background: var(--ink-50); font-weight: bold;">
              <td colspan="4" style="border: 1px solid var(--border-strong); padding: 6px; text-align: right;">Total Active Alteration Units:</td>
              <td style="border: 1px solid var(--border-strong); padding: 6px; text-align: right;">${totDefects} Pairs</td>
              <td colspan="3" style="border: 1px solid var(--border-strong); padding: 6px; text-align: center; color: var(--ink-600);">(Enforcing 100% Return to Stage 1)</td>
            </tr>
          </tbody>
        </table>
        <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 25px; border-top: 1px dashed var(--ink-500); padding-top: 8px;">
          <span>Alteration Supervisor: ___________________</span>
          <span>Lead QA Inspector: ___________________</span>
          <span>Approved By: ___________________</span>
        </div>
      </div>
    `;

    openModal('Daily Defect & Alteration Summary Log', docHtml);
    printDocument('Daily Defect & Alteration Summary Log', docHtml);
  });
}
