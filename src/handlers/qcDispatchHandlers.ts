import {
  canExecuteStage5CartonPacking,
  escapeHtml,
  formatCurrentDateDDMMYYYY,
  normalizeBaseReqNumber,
  scaleSizeBreakdown
} from '../utils/requisitionLogic';
import {
  buildDispatchManifestPrintHtml,
  computeQcDispatchMetrics,
  QcDispatchReqRow
} from '../components/superUserView';
import {
  closeModal,
  exportTableToCSV,
  openModal,
  printDocument,
  showToast
} from '../utils/domModalsAndPrint';
import { renderApp } from '../appContext';
import { logAuditEvent, state } from '../state/appState';
import {
  applyServerRequisition,
  isPersistedRequisition,
  postWipStageUpdate,
  saveCurrentOrderWipState,
  switchActiveOrder,
  syncBackendData
} from '../state/syncService';

const releaseInFlightReqs = new Set<string>();

export function buildQcDispatchRows(): QcDispatchReqRow[] {
  const activeReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
  const seen = new Set<string>();
  const rows: QcDispatchReqRow[] = [];

  for (const [rawKey, entry] of Object.entries(state.ordersWipMap || {})) {
    const reqNumber = normalizeBaseReqNumber(rawKey);
    if (!reqNumber || seen.has(reqNumber) || !isPersistedRequisition(reqNumber)) continue;
    seen.add(reqNumber);

    const isActive = reqNumber === activeReq;
    const wipSource: any = isActive ? state.packingWip : entry;
    const rawCartons: any[] = isActive
      ? state.cartons
      : (Array.isArray((entry as any)?.cartons) ? (entry as any).cartons : []);
    const stage4Passed = Number(wipSource?.stage4Passed || 0);
    if (stage4Passed <= 0) continue;

    rows.push({
      reqNumber,
      orderId: String(wipSource?.parentOrderId || ''),
      article: String(wipSource?.article || ''),
      po: String(wipSource?.po || ''),
      stage4Passed,
      finalQcApproved: Boolean(wipSource?.finalQcApproved),
      dispatched: String(wipSource?.reqStatus || '').toUpperCase() === 'DISPATCHED',
      cartons: rawCartons.map(c => {
        const modeRaw = String(c.shippingMode || 'UNASSIGNED').toUpperCase();
        const shippingMode: 'UNASSIGNED' | 'AIR' | 'SEA' =
          modeRaw === 'AIR' || modeRaw === 'SEA' ? modeRaw : 'UNASSIGNED';
        return {
          cartonNo: String(c.cartonNo || ''),
          pairs: Number(c.pairs || 0),
          dims: String(c.dims || '60 × 40 × 35'),
          cbm: Number(c.cbm ?? 0.084),
          shippingMode,
          sealNo: String(c.sealNo || '')
        };
      })
    });
  }

  return rows.sort((a, b) => a.reqNumber.localeCompare(b.reqNumber));
}

export function attachCartonDispatchHandlers(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-carton-dispatch-mode]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const mode = (btn.getAttribute('data-carton-dispatch-mode') || '').toUpperCase() as 'AIR' | 'SEA' | 'UNASSIGNED';
      const cartonNo = btn.getAttribute('data-carton-no') || '';
      if (!cartonNo || !['AIR', 'SEA', 'UNASSIGNED'].includes(mode)) return;

      const baseReq = normalizeBaseReqNumber(btn.getAttribute('data-req-number') || state.packingWip.selectedBatch);
      if (baseReq !== normalizeBaseReqNumber(state.packingWip.selectedBatch)) {
        switchActiveOrder(baseReq);
      }
      btn.disabled = true;

      try {
        if (isPersistedRequisition(baseReq)) {
          const res = await fetch(`/api/wip/${encodeURIComponent(baseReq)}/dispatch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ shippingMode: mode, cartonBarcodes: [cartonNo] })
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json.success) {
            throw new Error(json.error || 'Unable to update carton shipping mode.');
          }
          if (json.data) {
            applyServerRequisition(json.data, true);
          } else {
            await syncBackendData();
          }
        } else {
          const target = state.cartons.find(c => c.cartonNo === cartonNo);
          if (target) {
            target.shippingMode = mode;
            target.dispatchedAt = mode === 'UNASSIGNED' ? null : new Date().toISOString();
          }
          saveCurrentOrderWipState();
        }
        showToast(`${cartonNo} marked ${mode === 'UNASSIGNED' ? 'Ready' : `Sent by ${mode}`}.`);
        renderApp();
      } catch (err) {
        showToast(err instanceof Error ? err.message : 'Unable to update carton shipping mode.');
      } finally {
        btn.disabled = false;
      }
    });
  });
}

// Handlers for Screen 4: Final QC (No Buyer)
export function attachQCHandlers(): void {
  attachCartonDispatchHandlers();
  document.getElementById('btn-print-carton-labels')?.addEventListener('click', () => {
    const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
    const article = state.qcOrder.article || state.packingWip.article || '---';
    const po = state.qcOrder.po || state.packingWip.po || '---';
    const totalPairs = state.cartons.reduce((sum, c) => sum + Number(c.pairs || 0), 0);
    const totalCbm = state.cartons.reduce((sum, c) => sum + Number(c.cbm || 0.084), 0);
    const airCount = state.cartons.filter(c => c.shippingMode === 'AIR').length;
    const seaCount = state.cartons.filter(c => c.shippingMode === 'SEA').length;
    const firstCtn = state.cartons[0];
    const modeSummary =
      airCount > 0 && seaCount > 0
        ? `SPLIT: ${airCount} AIR / ${seaCount} SEA`
        : airCount > 0
          ? `AIR (${airCount} CTN)`
          : seaCount > 0
            ? `SEA (${seaCount} CTN)`
            : 'READY FOR DISPATCH';

    const docHtml = `
      <div style="border: 2px solid var(--ink-950); padding: 20px; font-family: monospace; background: var(--white); color: var(--ink-950);">
        <div style="text-align: center; border-bottom: 2px solid var(--ink-950); padding-bottom: 10px; margin-bottom: 14px;">
          <div style="font-size: 19px; font-weight: 800; color: var(--ink-950);">HAMMAD INDUSTRIES &bull; EXPORT MASTER CARTON</div>
          <div style="font-size: 11px; color: var(--ink-600);">INTERNATIONAL EXPORT SHIPPING LABEL &bull; THERMAL DIRECT / A4</div>
        </div>
        <div class="printable-meta-grid" style="font-size: 12.5px;">
          <div><span>REQUISITION #:</span> <strong>${escapeHtml(baseReq)}</strong></div>
          <div><span>CARTONS:</span> <strong>${firstCtn ? `${escapeHtml(firstCtn.cartonNo)} OF ${state.cartons.length}` : '0'}</strong></div>
          <div><span>ARTICLE:</span> <strong>${escapeHtml(article)}</strong></div>
          <div><span>PO NUMBER:</span> <strong>${po !== '---' ? `PO ${escapeHtml(po)}` : '---'}</strong></div>
          <div><span>QUANTITY:</span> <strong>${firstCtn ? firstCtn.pairs : 0} PRS/CTN (${totalPairs} TOTAL)</strong></div>
          <div><span>SHIPPING MODE:</span> <strong>${escapeHtml(modeSummary)}</strong></div>
          <div><span>DIMENSIONS:</span> <strong>${escapeHtml(firstCtn?.dims || '60 × 40 × 35')} CM</strong></div>
          <div><span>TOTAL VOLUME:</span> <strong>${totalCbm.toFixed(3)} CBM</strong></div>
          <div><span>QC TAMPER SEAL:</span> <strong>${escapeHtml(firstCtn?.sealNo || '---')} (VERIFIED)</strong></div>
          <div><span>AQL 1.5 AUDIT:</span> <strong>PASSED &bull; CLEARED FOR EXPORT</strong></div>
        </div>
        <div style="border: 2px solid var(--ink-950); padding: 14px; text-align: center; background: var(--ink-50); font-weight: 800; font-size: 15px; letter-spacing: 0.12em; margin: 14px 0;">
          ||||| ||||||| |||| |||||||| ||||| |||||| ||||||||<br/>
          *${escapeHtml(firstCtn?.cartonNo || baseReq)}*
        </div>
        <div style="display: flex; justify-content: space-between; font-size: 11px; border-top: 1px dashed var(--ink-950); padding-top: 8px;">
          <span>Tamper Seal Status: VERIFIED &bull; INTACT</span>
          <span>Approved By: ___________________</span>
        </div>
      </div>
    `;

    openModal('Master Carton Shipping Labels (A4/Thermal)', docHtml);
    printDocument('Master Carton Shipping Labels (A4/Thermal)', docHtml);
  });

  document.getElementById('btn-export-packing-list')?.addEventListener('click', () => {
    exportTableToCSV('Master_Carton_Packing_List.csv', state.cartons);
    showToast('Commercial Export Packing List downloaded.');
  });

  document.getElementById('btn-dispatch-gate')?.addEventListener('click', async () => {
    state.packingWip.finalQcApproved = true;
    saveCurrentOrderWipState();
    logAuditEvent(
      'FINAL_QC_APPROVE',
      state.packingWip.selectedBatch,
      'Awaiting Final QC',
      'Final QC Approved & Cleared for Stage 5 / Dispatch',
      state.packingWip.parentOrderId
    );
    openModal('Export Dispatch Clearance Slip', `
      <div style="text-align: center; padding: 10px;">
        <div style="color: var(--ink-950); font-size: 32px; margin-bottom: 6px;">✓</div>
        <h3 style="margin: 0; color: var(--ink-950);">CONTAINER GATE RELEASE &amp; FINAL QC AUTHORIZED</h3>
        <p style="color: var(--ink-600); font-size: 13px; margin-top: 4px;">AQL 1.5 final clearance approved. Stage 5 Master Carton Packing unlocked.</p>
      </div>
    `);
    renderApp();
  });
}

export function openStage5BoxingModal(): void {
  if (!state.currentUser || state.currentUser.role !== 'SUPER_USER') {
    showToast('Master carton creation and QC are managed by Super User in QC & Dispatch.');
    return;
  }
  const gateCheck = canExecuteStage5CartonPacking(state.packingWip);
  if (!gateCheck.allowed) {
    showToast(gateCheck.reason);
    return;
  }

  const readyPairs = Number(state.packingWip.stage4Passed || gateCheck.readyPairs || 0);
  const alreadyBoxed = state.cartons.reduce((sum, c) => sum + Number(c.pairs || 0), 0);
  const remainingToBox = Math.max(0, readyPairs - alreadyBoxed);
  if (remainingToBox <= 0) {
    showToast('All Stage 4 approved pairs are already boxed. Assign Air or Sea dispatch in the Master Shipping Carton Manifest.');
    return;
  }

  const defaultPairsPerCtn = Math.min(30, remainingToBox);
  const lastDimsMatch = String(state.cartons[state.cartons.length - 1]?.dims || '').match(
    /(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)\D+(\d+(?:\.\d+)?)/
  );
  const [defL, defW, defH] = lastDimsMatch
    ? [lastDimsMatch[1], lastDimsMatch[2], lastDimsMatch[3]]
    : ['60', '40', '35'];

  openModal('Process Stage 5: 2nd Packing (Master Cartons)', `
    <div style="font-size: 13px;">
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; padding: 10px 12px; border: 1px solid var(--border); border-radius: 6px; background: var(--ink-50); margin-bottom: 12px; font-variant-numeric: tabular-nums;">
        <div><div style="font-size: 11px; color: var(--ink-500);">QC Approved</div><strong>${readyPairs.toLocaleString()} prs</strong></div>
        <div><div style="font-size: 11px; color: var(--ink-500);">Already Boxed</div><strong>${alreadyBoxed.toLocaleString()} prs</strong></div>
        <div><div style="font-size: 11px; color: var(--ink-500);">Remaining</div><strong>${remainingToBox.toLocaleString()} prs</strong></div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
        <div class="form-group" style="margin-bottom: 0;">
          <label for="step5-pairs-input">Pairs to box now (max ${remainingToBox}):</label>
          <input type="number" id="step5-pairs-input" class="form-input" min="1" max="${remainingToBox}" value="${remainingToBox}" />
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label for="step5-pairs-per-ctn-input">Pairs / master carton:</label>
          <input type="number" id="step5-pairs-per-ctn-input" class="form-input" min="1" value="${defaultPairsPerCtn}" />
        </div>
      </div>
      <div class="form-group" style="margin-bottom: 12px;">
        <label>Master carton size (L &times; W &times; H cm):</label>
        <div style="display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 8px;">
          <input type="number" id="step5-dim-l" class="form-input" min="1" step="0.1" value="${defL}" placeholder="L (cm)" aria-label="Length in cm" />
          <input type="number" id="step5-dim-w" class="form-input" min="1" step="0.1" value="${defW}" placeholder="W (cm)" aria-label="Width in cm" />
          <input type="number" id="step5-dim-h" class="form-input" min="1" step="0.1" value="${defH}" placeholder="H (cm)" aria-label="Height in cm" />
        </div>
      </div>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
        <div class="form-group" style="margin-bottom: 0;">
          <label for="step5-ship-mode">Shipping mode:</label>
          <select id="step5-ship-mode" class="form-input">
            <option value="SEA" selected>By Sea (SEA)</option>
            <option value="AIR">By Air (AIR)</option>
            <option value="UNASSIGNED">Ready (assign Air / Sea later)</option>
          </select>
        </div>
        <div class="form-group" style="margin-bottom: 0;">
          <label for="step5-prefix-input">Carton seal batch prefix:</label>
          <input type="text" id="step5-prefix-input" class="form-input" value="FSKD-44" />
        </div>
      </div>
      <div id="step5-live-preview" style="padding: 8px 12px; border-radius: 6px; border: 1px dashed var(--border); font-size: 12px; color: var(--ink-700); margin-bottom: 14px; font-variant-numeric: tabular-nums;">
        --
      </div>
      <div style="display: flex; justify-content: flex-end; gap: 8px;">
        <button type="button" class="btn-outline" data-modal-cancel>Cancel</button>
        <button type="button" class="btn-primary" id="btn-submit-step5-action">Seal &amp; Add to Shipping Manifest &rarr;</button>
      </div>
    </div>
  `, false, { hideGlobalFooter: true });

  const updateStep5Preview = () => {
    const pairsToBox = parseInt((document.getElementById('step5-pairs-input') as HTMLInputElement)?.value || '0', 10) || 0;
    const perCtn = parseInt((document.getElementById('step5-pairs-per-ctn-input') as HTMLInputElement)?.value || '0', 10) || 0;
    const l = parseFloat((document.getElementById('step5-dim-l') as HTMLInputElement)?.value || '0') || 0;
    const w = parseFloat((document.getElementById('step5-dim-w') as HTMLInputElement)?.value || '0') || 0;
    const h = parseFloat((document.getElementById('step5-dim-h') as HTMLInputElement)?.value || '0') || 0;
    const mode = (document.getElementById('step5-ship-mode') as HTMLSelectElement)?.value || 'UNASSIGNED';
    const previewEl = document.getElementById('step5-live-preview');
    if (!previewEl) return;
    const ctnCount = pairsToBox > 0 && perCtn > 0 ? Math.ceil(pairsToBox / perCtn) : 0;
    const cbmPerCtn = l > 0 && w > 0 && h > 0 ? (l * w * h) / 1000000 : 0;
    const totalCbm = ctnCount * cbmPerCtn;
    const modeLabel = mode === 'AIR' ? 'By Air (AIR)' : mode === 'SEA' ? 'By Sea (SEA)' : 'Ready (Unassigned)';
    previewEl.textContent = `${ctnCount} carton${ctnCount === 1 ? '' : 's'} · ${totalCbm.toFixed(3)} CBM total (${cbmPerCtn.toFixed(4)} CBM/ctn) · ${modeLabel}`;
  };

  ['step5-pairs-input', 'step5-pairs-per-ctn-input', 'step5-dim-l', 'step5-dim-w', 'step5-dim-h', 'step5-ship-mode'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateStep5Preview);
    document.getElementById(id)?.addEventListener('change', updateStep5Preview);
  });
  updateStep5Preview();

  let step5InFlight = false;
  document.getElementById('btn-submit-step5-action')?.addEventListener('click', async (event) => {
    if (step5InFlight) return;
    const pairsToBox = parseInt((document.getElementById('step5-pairs-input') as HTMLInputElement)?.value || '0', 10) || 0;
    const pairsPerCarton = parseInt((document.getElementById('step5-pairs-per-ctn-input') as HTMLInputElement)?.value || '0', 10) || 0;
    const l = parseFloat((document.getElementById('step5-dim-l') as HTMLInputElement)?.value || '0') || 0;
    const w = parseFloat((document.getElementById('step5-dim-w') as HTMLInputElement)?.value || '0') || 0;
    const h = parseFloat((document.getElementById('step5-dim-h') as HTMLInputElement)?.value || '0') || 0;
    const shippingMode = ((document.getElementById('step5-ship-mode') as HTMLSelectElement)?.value || 'UNASSIGNED') as 'UNASSIGNED' | 'AIR' | 'SEA';
    const sealPrefix = ((document.getElementById('step5-prefix-input') as HTMLInputElement)?.value || 'FSKD-44').trim() || 'FSKD-44';

    if (pairsToBox <= 0 || pairsToBox > remainingToBox) {
      showToast(`Enter pairs to box between 1 and ${remainingToBox}.`);
      return;
    }
    if (pairsPerCarton <= 0) {
      showToast('Pairs per master carton must be at least 1.');
      return;
    }
    if (l <= 0 || w <= 0 || h <= 0) {
      showToast('Enter valid carton dimensions (L, W, H in cm).');
      return;
    }

    const dimensionsCm = `${l}x${w}x${h}`;
    const submitBtn = event.currentTarget as HTMLButtonElement | null;
    step5InFlight = true;
    if (submitBtn) submitBtn.disabled = true;

    try {
      const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
      const newCartonsCount = Math.ceil(pairsToBox / pairsPerCarton);

      if (isPersistedRequisition(baseReq)) {
        const savedOk = await postWipStageUpdate(
          baseReq,
          'step5-cartons-gated',
          { pairsPerCarton, pairsToPack: pairsToBox, dimensionsCm, shippingMode, sealPrefix },
          'Unable to save Stage 5 carton packing.'
        );
        if (!savedOk) return;
        (state.packingWip as any).packedSizes = scaleSizeBreakdown(state.packingWip.sizes, state.packingWip.outputPairs);
        saveCurrentOrderWipState();
        logAuditEvent(
          'STAGE_5_CARTON_SEAL',
          baseReq,
          `Boxed +${pairsToBox} Prs (${newCartonsCount} Ctns, ${dimensionsCm} cm)`,
          `Manifest Total: ${state.packingWip.outputCartons} Cartons (${state.packingWip.outputPairs} Prs) · ${shippingMode}`,
          state.packingWip.parentOrderId
        );
        closeModal();
        showToast(`${newCartonsCount} Master Cartons (${pairsToBox} Prs · ${shippingMode === 'UNASSIGNED' ? 'Ready' : shippingMode}) logged into Shipping Manifest!`);
        renderApp();
        return;
      }

      const cbm = Number(((l * w * h) / 1000000).toFixed(4));
      const startIdx = state.cartons.length;
      let rem = pairsToBox;
      for (let i = 0; i < newCartonsCount; i++) {
        const ctnPairs = Math.min(rem, pairsPerCarton);
        const ctnNum = startIdx + i + 1;
        state.cartons.push({
          cartonNo: `CTN-${String(ctnNum).padStart(2, '0')}`,
          pairs: ctnPairs,
          netWt: '4.2 kg',
          grossWt: '4.8 kg',
          dims: `${l} × ${w} × ${h}`,
          cbm,
          shippingMode,
          dispatchedAt: shippingMode === 'UNASSIGNED' ? null : new Date().toISOString(),
          barcodeVerified: true,
          sealNo: `${sealPrefix}-${String(ctnNum).padStart(2, '0')}`,
          status: 'Approved (AQL 1.5)'
        });
        rem -= ctnPairs;
      }
      const totalBoxedPairs = state.cartons.reduce((s, c) => s + Number(c.pairs || 0), 0);
      state.packingWip.outputCartons = state.cartons.length;
      state.packingWip.outputPairs = totalBoxedPairs;
      state.packingWip.stage5Cartons = `${state.cartons.length} Cartons (${totalBoxedPairs} Prs)`;
      (state.packingWip as any).packedSizes = scaleSizeBreakdown(state.packingWip.sizes, totalBoxedPairs);

      logAuditEvent(
        'STAGE_5_CARTON_SEAL',
        state.packingWip.selectedBatch,
        `Stage 4 Ready: ${state.packingWip.stage4Passed} Prs`,
        `Sealed +${newCartonsCount} Cartons (${pairsToBox} Prs, ${dimensionsCm} cm, ${shippingMode})`,
        state.packingWip.parentOrderId
      );

      saveCurrentOrderWipState();
      closeModal();
      showToast(`${newCartonsCount} Master Cartons (${pairsToBox} Prs) sealed and logged into Shipping Manifest!`);
      renderApp();
    } finally {
      step5InFlight = false;
      if (submitBtn?.isConnected) submitBtn.disabled = false;
    }
  });
}

export function openAqlCalculatorModal(): void {
  openModal('ISO 2859-1 (Level II) AQL 1.5 Sampling Calculator', `
    <div style="font-size: 13px; color: var(--ink-800);">
      <p style="margin: 0 0 12px; color: var(--ink-600);">
        Automated ISO 2859-1 Normal Single Sampling Plan (AQL 1.5) decision matrix for glove export lots and carton quarantine enforcement.
      </p>

      <div class="modal-meta-grid-3" style="margin-bottom: 14px;">
        <div class="form-group">
          <label for="aql-lot-size">Lot Size (Total Pairs)</label>
          <input type="number" id="aql-lot-size" class="form-input" value="${state.packingWip.plannedQty || 840}" min="1" />
        </div>
        <div class="form-group">
          <label for="aql-target">AQL Standard</label>
          <select id="aql-target" class="form-select" disabled>
            <option value="1.5">AQL 1.5 (Level II Normal)</option>
          </select>
        </div>
        <div class="form-group">
          <label for="aql-found-defects">Found Defects (Sample)</label>
          <input type="number" id="aql-found-defects" class="form-input" value="0" min="0" />
        </div>
      </div>

      <div id="aql-result-box" style="background: var(--ink-50); border: 1px solid var(--border-strong); border-radius: 6px; padding: 14px; margin-bottom: 16px;">
        <!-- Dynamically calculated content -->
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center;">
        <span style="font-size: 11px; color: var(--ink-500);">Standard: ISO 2859-1 / ANSI/ASQ Z1.4</span>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn-outline" data-modal-cancel>Close</button>
          <button class="btn-primary" id="btn-apply-aql-audit">Apply Audit Result to Active Lot &rarr;</button>
        </div>
      </div>
    </div>
  `, false, { hideGlobalFooter: true });

  function updateAqlCalculation() {
    const lotSize = parseInt((document.getElementById('aql-lot-size') as HTMLInputElement)?.value || '840', 10);
    const defects = parseInt((document.getElementById('aql-found-defects') as HTMLInputElement)?.value || '0', 10);

    let code = 'A';
    let sampleSize = 2;
    let acceptLimit = 0;
    let rejectLimit = 1;

    if (lotSize <= 8) { code = 'A'; sampleSize = 2; acceptLimit = 0; rejectLimit = 1; }
    else if (lotSize <= 15) { code = 'B'; sampleSize = 3; acceptLimit = 0; rejectLimit = 1; }
    else if (lotSize <= 25) { code = 'C'; sampleSize = 5; acceptLimit = 0; rejectLimit = 1; }
    else if (lotSize <= 50) { code = 'D'; sampleSize = 8; acceptLimit = 0; rejectLimit = 1; }
    else if (lotSize <= 90) { code = 'E'; sampleSize = 13; acceptLimit = 0; rejectLimit = 1; }
    else if (lotSize <= 150) { code = 'F'; sampleSize = 20; acceptLimit = 1; rejectLimit = 2; }
    else if (lotSize <= 280) { code = 'G'; sampleSize = 32; acceptLimit = 1; rejectLimit = 2; }
    else if (lotSize <= 500) { code = 'H'; sampleSize = 50; acceptLimit = 2; rejectLimit = 3; }
    else if (lotSize <= 1200) { code = 'J'; sampleSize = 80; acceptLimit = 3; rejectLimit = 4; }
    else if (lotSize <= 3200) { code = 'K'; sampleSize = 125; acceptLimit = 5; rejectLimit = 6; }
    else if (lotSize <= 10000) { code = 'L'; sampleSize = 200; acceptLimit = 7; rejectLimit = 8; }
    else { code = 'M'; sampleSize = 315; acceptLimit = 10; rejectLimit = 11; }

    const isPassed = defects <= acceptLimit;

    const resultBox = document.getElementById('aql-result-box');
    if (resultBox) {
      resultBox.innerHTML = `
        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; text-align: center; margin-bottom: 12px;">
          <div style="background: var(--white); border: 1px solid var(--ink-200); padding: 8px; border-radius: 4px;">
            <div style="font-size: 11px; color: var(--ink-500);">Code Letter</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--ink-950);">${code}</div>
          </div>
          <div style="background: var(--white); border: 1px solid var(--ink-200); padding: 8px; border-radius: 4px;">
            <div style="font-size: 11px; color: var(--ink-500);">Sample Size</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--ink-950);">${sampleSize} Prs</div>
          </div>
          <div style="background: var(--white); border: 1px solid var(--ink-200); padding: 8px; border-radius: 4px;">
            <div style="font-size: 11px; color: var(--ink-500);">Accept (Ac)</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--ink-950);">&le; ${acceptLimit}</div>
          </div>
          <div style="background: var(--white); border: 1px solid var(--ink-200); padding: 8px; border-radius: 4px;">
            <div style="font-size: 11px; color: var(--ink-500);">Reject (Re)</div>
            <div style="font-size: 18px; font-weight: 800; color: var(--ink-950);">&ge; ${rejectLimit}</div>
          </div>
        </div>
        <div style="padding: 10px; border-radius: 4px; text-align: center; font-weight: 800; font-size: 13px; background: ${isPassed ? 'var(--ink-100)' : 'var(--ink-200)'}; border: 1px solid var(--ink-900); color: var(--ink-950);">
          ${isPassed ? `✓ AQL 1.5 PASSED &mdash; Found ${defects} defects &le; ${acceptLimit} allowed. Entire lot of ${lotSize.toLocaleString()} pairs approved for export.` : `✗ QUARANTINED &mdash; Found ${defects} defects &ge; ${rejectLimit} rejection limit. Lot quarantined for 100% rework.`}
        </div>
      `;
    }
  }

  document.getElementById('aql-lot-size')?.addEventListener('input', updateAqlCalculation);
  document.getElementById('aql-found-defects')?.addEventListener('input', updateAqlCalculation);
  updateAqlCalculation();

  document.getElementById('btn-apply-aql-audit')?.addEventListener('click', async () => {
    const defects = parseInt((document.getElementById('aql-found-defects') as HTMLInputElement)?.value || '0', 10);
    const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
    let passedAql = defects <= 3;

    try {
      const resp = await fetch(`/api/qc/${encodeURIComponent(baseReq)}/aql-audit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          foundDefects: defects,
          inspectorId: '4402',
          inspectorName: 'Tariq Mehmood'
        })
      });
      const data = await resp.json();
      if (!resp.ok || !data.success || !data.data) {
        showToast(data.error || `AQL audit failed for ${baseReq}.`);
        return;
      }
      passedAql = Boolean(data.data.isApproved);
    } catch (error) {
      console.error('AQL audit failed:', error);
      showToast(`Failed to submit AQL audit for ${baseReq}.`);
      return;
    }

    state.qcChecklist.forEach(c => (c.passed = passedAql));
    state.packingWip.finalQcApproved = passedAql;
    saveCurrentOrderWipState();
    logAuditEvent(
      passedAql ? 'FINAL_QC_APPROVE' : 'FINAL_QC_REJECT',
      baseReq,
      `Stage 4 Ready: ${state.packingWip.stage4Passed} Prs`,
      passedAql ? `AQL 1.5 Passed (${defects} defects)` : `AQL 1.5 Quarantined (${defects} defects)`,
      state.packingWip.parentOrderId
    );
    closeModal();
    renderApp();
    showToast(
      passedAql
        ? `AQL 1.5 Passed (${defects} defects). Stage 5 Master Carton Packing unlocked!`
        : `AQL 1.5 Rejected (${defects} defects). Lot remains locked at Stage 4.`
    );
  });
}

export async function dispatchBulkCartons(
  req: string,
  shippingMode: 'AIR' | 'SEA' | 'UNASSIGNED',
  cartonCount?: number
): Promise<void> {
  if (!req) return;
  if (req !== normalizeBaseReqNumber(state.packingWip.selectedBatch)) {
    switchActiveOrder(req);
  }
  state.adminQcDispatchSelectedReq = req;

  try {
    if (isPersistedRequisition(req)) {
      const payload: Record<string, unknown> = { shippingMode };
      if (cartonCount != null && cartonCount > 0) {
        payload.cartonCount = cartonCount;
      }
      const res = await fetch(`/api/wip/${encodeURIComponent(req)}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Unable to update bulk carton shipping mode.');
      }
      if (json.data) {
        applyServerRequisition(json.data, true);
      } else {
        await syncBackendData();
      }
    } else {
      const limit = cartonCount != null && cartonCount > 0 ? cartonCount : state.cartons.length;
      const targets = cartonCount != null
        ? state.cartons
            .filter(c => shippingMode === 'UNASSIGNED' ? c.shippingMode !== 'UNASSIGNED' : c.shippingMode === 'UNASSIGNED')
            .slice(0, limit)
        : state.cartons;
      if (cartonCount != null && targets.length === 0) {
        showToast(shippingMode === 'UNASSIGNED' ? `No assigned cartons to reset on ${req}.` : `No unassigned Ready cartons remain on ${req}.`);
        return;
      }
      const stamp = shippingMode === 'UNASSIGNED' ? null : new Date().toISOString();
      targets.forEach(c => {
        c.shippingMode = shippingMode;
        c.dispatchedAt = stamp;
      });
      saveCurrentOrderWipState();
    }

    const scopeLabel = cartonCount != null ? `${cartonCount} carton${cartonCount === 1 ? '' : 's'}` : 'All cartons';
    const modeLabel = shippingMode === 'UNASSIGNED' ? 'Ready (Unassigned)' : `Sent by ${shippingMode}`;
    showToast(`${scopeLabel} on ${req} marked ${modeLabel}.`);
    renderApp();
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Unable to update bulk carton shipping mode.');
  }
}

export async function dispatchAirSeaAllotment(req: string, airCartons: number, seaCartons: number): Promise<void> {
  if (!req) return;
  if (req !== normalizeBaseReqNumber(state.packingWip.selectedBatch)) {
    switchActiveOrder(req);
  }
  state.adminQcDispatchSelectedReq = req;

  try {
    if (isPersistedRequisition(req)) {
      const res = await fetch(`/api/wip/${encodeURIComponent(req)}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ airCartons, seaCartons })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Unable to save Air / Sea allotment.');
      }
      if (json.data) {
        applyServerRequisition(json.data, true);
      } else {
        await syncBackendData();
      }
    } else {
      const currentModes = state.cartons.map(c => String(c.shippingMode || 'UNASSIGNED').toUpperCase());
      const nextModes: Array<'AIR' | 'SEA' | 'UNASSIGNED' | null> = new Array(currentModes.length).fill(null);
      let keptAir = 0;
      let keptSea = 0;
      for (let i = 0; i < currentModes.length; i++) {
        if (currentModes[i] === 'AIR' && keptAir < airCartons) {
          nextModes[i] = 'AIR';
          keptAir += 1;
        } else if (currentModes[i] === 'SEA' && keptSea < seaCartons) {
          nextModes[i] = 'SEA';
          keptSea += 1;
        }
      }
      const pool: number[] = [];
      for (let i = 0; i < currentModes.length; i++) {
        if (nextModes[i] === null && currentModes[i] === 'UNASSIGNED') pool.push(i);
      }
      for (let i = 0; i < currentModes.length; i++) {
        if (nextModes[i] === null && currentModes[i] !== 'UNASSIGNED') pool.push(i);
      }
      let needAir = airCartons - keptAir;
      let needSea = seaCartons - keptSea;
      for (const idx of pool) {
        if (needAir > 0) {
          nextModes[idx] = 'AIR';
          needAir -= 1;
        } else if (needSea > 0) {
          nextModes[idx] = 'SEA';
          needSea -= 1;
        } else {
          nextModes[idx] = 'UNASSIGNED';
        }
      }
      const stamp = new Date().toISOString();
      state.cartons.forEach((c, idx) => {
        const nextMode = nextModes[idx] || 'UNASSIGNED';
        if (nextMode !== currentModes[idx]) {
          c.shippingMode = nextMode;
          c.dispatchedAt = nextMode === 'UNASSIGNED' ? null : stamp;
        }
      });
      saveCurrentOrderWipState();
    }
    showToast(`Saved Air/Sea allotment (${airCartons} Air, ${seaCartons} Sea cartons).`);
    renderApp();
  } catch (err) {
    showToast(err instanceof Error ? err.message : 'Unable to save Air / Sea allotment.');
  }
}

export function handleQcDispatchAction(action: string, req: string): void {
  if (action === 'clear-filter') {
    state.adminQcDispatchOrderFilter = '';
    renderApp();
    return;
  }
  if (!req) return;

  if (action === 'select') {
    state.adminQcDispatchSelectedReq = req;
    renderApp();
    return;
  }
  if (action === 'aql') {
    switchActiveOrder(req);
    state.adminQcDispatchSelectedReq = req;
    openAqlCalculatorModal();
    return;
  }
  if (action === 'box') {
    switchActiveOrder(req);
    state.adminQcDispatchSelectedReq = req;
    openStage5BoxingModal();
    return;
  }

  if (action === 'bulk-count-air' || action === 'bulk-count-sea') {
    const count = parseInt((document.getElementById('qcd-bulk-carton-count') as HTMLInputElement)?.value || '0', 10) || 0;
    if (count <= 0) {
      showToast('Enter at least 1 carton to assign.');
      return;
    }
    void dispatchBulkCartons(req, action === 'bulk-count-air' ? 'AIR' : 'SEA', count);
    return;
  }

  if (action === 'bulk-all-air' || action === 'bulk-all-sea' || action === 'bulk-reset-all') {
    const mode = action === 'bulk-all-air' ? 'AIR' : action === 'bulk-all-sea' ? 'SEA' : 'UNASSIGNED';
    void dispatchBulkCartons(req, mode);
    return;
  }

  const row = buildQcDispatchRows().find(r => r.reqNumber === req);
  if (!row) {
    showToast(`Requisition ${req} not found in QC & Dispatch queue.`);
    return;
  }

  if (action === 'save-air-sea-split') {
    const airVal = Math.max(0, parseInt((document.getElementById('qcd-air-cartons-input') as HTMLInputElement)?.value || '0', 10) || 0);
    const seaVal = Math.max(0, parseInt((document.getElementById('qcd-sea-cartons-input') as HTMLInputElement)?.value || '0', 10) || 0);
    if (airVal + seaVal > row.cartons.length) {
      showToast(`Air (${airVal}) + Sea (${seaVal}) cannot exceed ${row.cartons.length} boxed cartons.`);
      return;
    }
    void dispatchAirSeaAllotment(req, airVal, seaVal);
    return;
  }

  if (action === 'bulk-ready-air' || action === 'bulk-ready-sea') {
    const readyCount = row.cartons.filter(c => String(c.shippingMode || 'UNASSIGNED').toUpperCase() === 'UNASSIGNED').length;
    if (readyCount <= 0) {
      showToast(`No unassigned Ready cartons remain on ${req}.`);
      return;
    }
    void dispatchBulkCartons(req, action === 'bulk-ready-air' ? 'AIR' : 'SEA', readyCount);
    return;
  }

  if (action === 'print') {
    if (row.cartons.length === 0) {
      showToast(`No cartons boxed for ${req} yet.`);
      return;
    }
    printDocument(`Dispatch Manifest ${req}`, buildDispatchManifestPrintHtml(row, formatCurrentDateDDMMYYYY()));
    return;
  }

  if (action === 'release') {
    if (releaseInFlightReqs.has(req)) return;
    const metrics = computeQcDispatchMetrics(row);
    if (row.dispatched) {
      showToast(`${req} is already dispatched.`);
      return;
    }
    if (!row.finalQcApproved) {
      showToast(`Complete AQL 1.5 inspection for ${req} before releasing.`);
      return;
    }
    if (row.cartons.length === 0) {
      showToast(`Box at least one master carton for ${req} before releasing.`);
      return;
    }
    if (metrics.remaining > 0) {
      showToast(`Box all ${metrics.remaining} remaining Stage 4 pairs before releasing ${req}.`);
      return;
    }
    if (metrics.ready > 0) {
      showToast(`Assign Air or Sea mode to all ${metrics.ready} remaining ready pairs before releasing.`);
      return;
    }

    releaseInFlightReqs.add(req);
    const releaseBtn = document.getElementById('qcd-release-btn') as HTMLButtonElement | null;
    if (releaseBtn) releaseBtn.disabled = true;

    void (async () => {
      try {
        if (isPersistedRequisition(req)) {
          const res = await fetch(`/api/wip/${encodeURIComponent(req)}/dispatch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ release: true })
          });
          const json = await res.json().catch(() => ({}));
          if (!res.ok || !json.success) {
            throw new Error(json.error || `Unable to release ${req} for dispatch.`);
          }
          if (json.data) {
            applyServerRequisition(json.data, true);
          }
        } else {
          if (state.ordersWipMap[req]) (state.ordersWipMap[req] as any).reqStatus = 'DISPATCHED';
          if (normalizeBaseReqNumber(state.packingWip.selectedBatch) === req) {
            (state.packingWip as any).reqStatus = 'DISPATCHED';
          }
        }
        logAuditEvent(
          'DISPATCH_RELEASE',
          req,
          `Boxed ${metrics.boxed} Prs`,
          `Released: Air ${metrics.air} Prs / Sea ${metrics.sea} Prs`,
          row.orderId
        );
        const latestRow = buildQcDispatchRows().find(r => r.reqNumber === req) || { ...row, dispatched: true };
        const html = buildDispatchManifestPrintHtml(latestRow, formatCurrentDateDDMMYYYY());
        renderApp();
        openModal(`Dispatch release — ${req}`, html);
        printDocument(`Dispatch Manifest ${req}`, html);
        showToast(`${req} released for dispatch (Air ${metrics.air} prs, Sea ${metrics.sea} prs).`);
      } catch (err) {
        showToast(err instanceof Error ? err.message : `Unable to release ${req} for dispatch.`);
      } finally {
        releaseInFlightReqs.delete(req);
        if (releaseBtn?.isConnected && !buildQcDispatchRows().find(r => r.reqNumber === req)?.dispatched) {
          releaseBtn.disabled = false;
        }
      }
    })();
  }
}

export function attachQcDispatchTabHandlers(): void {
  document.querySelectorAll<HTMLElement>('[data-qcd-action]').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.dataset.qcdAction || '';
      const rawReq = el.dataset.reqNumber || '';
      const req = rawReq ? normalizeBaseReqNumber(rawReq) : '';
      handleQcDispatchAction(action, req);
    });
  });

  const bulkBar = document.getElementById('qcd-bulk-dispatch-bar');
  const airInput = document.getElementById('qcd-air-cartons-input') as HTMLInputElement | null;
  const seaInput = document.getElementById('qcd-sea-cartons-input') as HTMLInputElement | null;
  const totalSplitCartons = Number(bulkBar?.getAttribute('data-total-cartons') || 0);
  if (airInput && seaInput && totalSplitCartons > 0) {
    airInput.addEventListener('input', () => {
      const airVal = Math.max(0, Math.min(totalSplitCartons, parseInt(airInput.value || '0', 10) || 0));
      seaInput.value = String(Math.max(0, totalSplitCartons - airVal));
    });
    seaInput.addEventListener('input', () => {
      const seaVal = Math.max(0, Math.min(totalSplitCartons, parseInt(seaInput.value || '0', 10) || 0));
      airInput.value = String(Math.max(0, totalSplitCartons - seaVal));
    });
  }

  document.getElementById('qcd-order-select')?.addEventListener('change', (e) => {
    const orderFilter = (e.currentTarget as HTMLSelectElement).value || '';
    state.adminQcDispatchOrderFilter = orderFilter;
    const filtered = buildQcDispatchRows().filter(r => !orderFilter || r.orderId === orderFilter);
    state.adminQcDispatchSelectedReq = filtered[0]?.reqNumber || '';
    renderApp();
  });

  document.getElementById('qcd-req-select')?.addEventListener('change', (e) => {
    const req = (e.currentTarget as HTMLSelectElement).value || '';
    state.adminQcDispatchSelectedReq = req ? normalizeBaseReqNumber(req) : '';
    renderApp();
  });

  attachCartonDispatchHandlers();
}
