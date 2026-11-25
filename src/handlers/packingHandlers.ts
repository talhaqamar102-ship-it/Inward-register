import {
  buildMaterialRequisitionSlipHtml,
  computeWipRolledYieldPct,
  determineOrderActiveStage,
  formatCurrentDateDDMMYYYY,
  getAlterationReqNumber,
  getMaterialReqNumber,
  isMaterialRequisitionIssuedForStage4,
  isPackingAwaitingFinalQc,
  isStage3ClearedForMaterialReq,
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
import { state } from '../state/appState';
import {
  isPersistedRequisition,
  postWipStageUpdate,
  saveCurrentOrderWipState,
  switchActiveOrder,
  syncBackendData
} from '../state/syncService';
import {
  bindComplementaryStageInputs,
  readComplementaryStageInputs,
  remainingStagePairs
} from '../utils/stageInputs';
import { openNewRequisitionModal } from './modals/newRequisitionModal';
import { openDocumentCenterModal } from './modals/documentCenterModal';
import { attachCartonDispatchHandlers, openStage5BoxingModal } from './qcDispatchHandlers';

function recordStageDefects(origin: string, quantity: number, defectClass: string): void {
  if (quantity <= 0) return;
  const alterationReq = getAlterationReqNumber(state.packingWip.selectedBatch);
  if (!state.dropdownOptions.defectBatchIds.includes(alterationReq)) {
    state.dropdownOptions.defectBatchIds.unshift(alterationReq);
  }
  state.defectList.unshift({
    id: alterationReq,
    date: formatCurrentDateDDMMYYYY(),
    origin,
    article: state.packingWip.article || '---',
    po: state.packingWip.po || '---',
    defectClass,
    qty: `${quantity} Prs`,
    tailor: 'Supervisor A',
    status: 'In Rework',
    route: 'Auto-Return to Stage 1 Checking',
    actionText: 'Update'
  });
}

function buildCurrentMaterialRequisitionSlip(): string {
  const wip = state.packingWip;
  const reqNumber = normalizeBaseReqNumber(wip.selectedBatch);
  const pairs = Math.max(0, Number(wip.stage3Passed || 0));
  const linkedOrder = state.pendingOrders.find(o => o.orderId === wip.parentOrderId);
  return buildMaterialRequisitionSlipHtml({
    mreqNo: getMaterialReqNumber(reqNumber),
    reqNo: reqNumber,
    orderId: wip.parentOrderId || '---',
    po: wip.po || linkedOrder?.po || '---',
    article: wip.article || '---',
    pairs,
    status: wip.mreqStatus || 'Ready for issue',
    date: formatCurrentDateDDMMYYYY()
  });
}

// Handlers for Packing Hall 5-Stage WIP Flow (Single Requisition with M and A prefixes, No Buyer, Approved By footer)
export function attachPackingHandlers(): void {
  // --- Section: Batch Switcher & Sync Banner ---
  (window as any).selectWipBatchFromChart = (reqNo: string) => {
    const val = normalizeBaseReqNumber(reqNo);
    switchActiveOrder(val);
    renderApp();
  };

  document.querySelectorAll<HTMLElement>('[data-packing-action="select-wip-batch"]').forEach(el => {
    el.addEventListener('click', () => {
      const reqNumber = el.dataset.reqNumber;
      if (reqNumber) (window as any).selectWipBatchFromChart(reqNumber);
    });
  });

  document.getElementById('btn-wip-sync-retry')?.addEventListener('click', () => {
    void syncBackendData({ manual: true });
  });

  document.getElementById('btn-wip-open-qc-banner')?.addEventListener('click', () => {
    if (!state.currentUser || state.currentUser.role === 'SUPER_USER') {
      state.activeScreen = 'screen-admin';
      state.adminActiveTab = 'qc-dispatch';
      state.adminQcDispatchSelectedReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
      state.adminQcDispatchOrderFilter = '';
      renderApp();
      return;
    }
    showToast('Master carton creation and QC are managed by Super User.');
  });

  // Single Requisition select change
  document.getElementById('wip-batch-select')?.addEventListener('change', (e) => {
    const select = e.target as HTMLSelectElement;
    if (!select.value) return;

    const val = normalizeBaseReqNumber(select.value);
    switchActiveOrder(val);
    renderApp();
  });

  // --- Section: Stage 1-3 Modals ---
  // Stage 1 Modal
  document.getElementById('btn-wip-step1')?.addEventListener('click', () => {
    const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
    const altReq = getAlterationReqNumber(state.packingWip.selectedBatch);
    const available = remainingStagePairs(
      state.packingWip.stage1In,
      state.packingWip.stage1Passed,
      state.packingWip.stage1Defects
    );
    if (available <= 0) {
      if (state.packingWip.issueStatus !== 'Issued by Inward Register' && state.packingWip.stage1In <= 0) {
        showToast(`Stage 1 locked: ${baseReq} is still Pending Inward Issue. Issue pairs in Inward Goods Receiving first.`);
      } else {
        showToast(`No pairs remaining to process in Stage 1 for ${baseReq}.`);
      }
      return;
    }
    openModal('Process Stage 1: Checking & Inspection', `
      <div style="font-size: 13px;">
        <p style="margin-bottom: 12px; color: var(--ink-600);">
          Process all ${available.toLocaleString()} available pairs. Passed and defect quantities must total the available amount; defects are routed to Alteration Bay #2 under <strong>${altReq}</strong>.
        </p>
        <div class="form-group" style="margin-bottom: 12px;">
          <label for="step1-good-input">Good / Passed Pairs (Advance to Stage 2):</label>
          <input type="number" id="step1-good-input" class="form-input" value="${available}" />
        </div>
        <div class="form-group" style="margin-bottom: 12px;">
          <label for="step1-defect-input">Defect Pairs (Route to Alteration Bay ${altReq}):</label>
          <input type="number" id="step1-defect-input" class="form-input" value="0" />
        </div>
        <div class="form-group" style="margin-bottom: 16px;">
          <label for="step1-defect-reason">Defect Classification:</label>
          <select id="step1-defect-reason" class="form-select">
            <option value="Stitching Skip / Broken Seam">Stitching Skip / Broken Seam</option>
            <option value="Oil / Grease Stain">Oil / Grease Stain</option>
            <option value="Shade Mismatch">Shade Mismatch</option>
            <option value="Seam Cut (Unsalvageable)">Seam Cut (Unsalvageable)</option>
            <option value="Sizing Error / Fit Asymmetry">Sizing Error / Fit Asymmetry</option>
            <option value="Bad Edge Trimming">Bad Edge Trimming</option>
            <option value="Thermal Crease Defect">Thermal Crease Defect</option>
          </select>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn-outline" data-modal-cancel>Cancel</button>
          <button type="button" class="btn-primary" id="btn-submit-step1-action">Confirm &amp; Advance Pairs &rarr;</button>
        </div>
      </div>
    `, false, { hideGlobalFooter: true });
    bindComplementaryStageInputs('step1-good-input', 'step1-defect-input', available);

    let step1InFlight = false;
    document.getElementById('btn-submit-step1-action')?.addEventListener('click', async (event) => {
      if (step1InFlight) return;
      const split = readComplementaryStageInputs('step1-good-input', 'step1-defect-input', available);
      if (!split) return;
      const submitBtn = event.currentTarget as HTMLButtonElement | null;
      step1InFlight = true;
      if (submitBtn) submitBtn.disabled = true;

      try {
        const { good, defects } = split;
        const reason = (document.getElementById('step1-defect-reason') as HTMLSelectElement)?.value || 'Stitching Skip';
        const activeReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);

        if (isPersistedRequisition(activeReq)) {
          const savedOk = await postWipStageUpdate(
            activeReq,
            'step1-checking',
            { goodPairs: good, defectPairs: defects, defectReason: reason },
            'Unable to save Stage 1 checking progress.'
          );
          if (!savedOk) return;
          recordStageDefects('Stage 1 (Checking)', defects, reason);
        } else {
          state.packingWip.stage1Passed += good;
          state.packingWip.stage1Defects += defects;
          state.packingWip.stage2In += good;
          state.packingWip.inAlteration += defects;
          state.packingWip.lineEfficiency = computeWipRolledYieldPct(state.packingWip);
          recordStageDefects('Stage 1 (Checking)', defects, reason);
          saveCurrentOrderWipState();
        }
        closeModal();
        showToast(`${good} pairs advanced to Stage 2. Active stage highlight moved to Stage 2.`);
        renderApp();
      } finally {
        step1InFlight = false;
        if (submitBtn?.isConnected) submitBtn.disabled = false;
      }
    });
  });

  // Stage 2 Modal
  document.getElementById('btn-wip-step2')?.addEventListener('click', () => {
    const available = remainingStagePairs(
      state.packingWip.stage2In,
      state.packingWip.stage2Passed,
      state.packingWip.stage2Defects
    );
    if (available <= 0) {
      showToast('No pairs available in Stage 2 yet. Advance pairs from Stage 1 Checking first.');
      return;
    }
    openModal('Process Stage 2: Ironing & Brushing', `
      <div style="font-size: 13px;">
        <p style="margin-bottom: 12px; color: var(--ink-600);">
          Process all ${available.toLocaleString()} available pairs. Passed and defect quantities must total the available amount.
        </p>
        <div class="form-group" style="margin-bottom: 12px;">
          <label for="step2-good-input">Ironed &amp; Finished Pairs (Advance to Stage 3):</label>
          <input type="number" id="step2-good-input" class="form-input" value="${available}" />
        </div>
        <div class="form-group" style="margin-bottom: 16px;">
          <label for="step2-defect-input">Crease / Soil Rejects:</label>
          <input type="number" id="step2-defect-input" class="form-input" value="0" />
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn-outline" data-modal-cancel>Cancel</button>
          <button type="button" class="btn-primary" id="btn-submit-step2-action">Advance to Pair Matching &rarr;</button>
        </div>
      </div>
    `, false, { hideGlobalFooter: true });
    bindComplementaryStageInputs('step2-good-input', 'step2-defect-input', available);

    let step2InFlight = false;
    document.getElementById('btn-submit-step2-action')?.addEventListener('click', async (event) => {
      if (step2InFlight) return;
      const split = readComplementaryStageInputs('step2-good-input', 'step2-defect-input', available);
      if (!split) return;
      const submitBtn = event.currentTarget as HTMLButtonElement | null;
      step2InFlight = true;
      if (submitBtn) submitBtn.disabled = true;

      try {
        const { good, defects } = split;
        const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);

        if (isPersistedRequisition(baseReq)) {
          const savedOk = await postWipStageUpdate(
            baseReq,
            'step2-ironing',
            { goodPairs: good, defectPairs: defects, defectReason: 'Crease / Soil Rejects' },
            'Unable to save Stage 2 ironing progress.'
          );
          if (!savedOk) return;
          recordStageDefects('Stage 2 (Ironing)', defects, 'Crease / Soil Rejects');
        } else {
          state.packingWip.stage2Passed += good;
          state.packingWip.stage2Defects += defects;
          state.packingWip.stage3In += good;
          state.packingWip.inAlteration += defects;
          state.packingWip.lineEfficiency = computeWipRolledYieldPct(state.packingWip);
          recordStageDefects('Stage 2 (Ironing)', defects, 'Crease / Soil Rejects');
          saveCurrentOrderWipState();
        }
        closeModal();
        showToast(`${good} pairs advanced to Stage 3; ${defects} defects routed to Alteration.`);
        renderApp();
      } finally {
        step2InFlight = false;
        if (submitBtn?.isConnected) submitBtn.disabled = false;
      }
    });
  });

  // Stage 3 Modal
  document.getElementById('btn-wip-step3')?.addEventListener('click', () => {
    const available = remainingStagePairs(
      state.packingWip.stage3In,
      state.packingWip.stage3Passed,
      state.packingWip.stage3Defects
    );
    if (available <= 0) {
      showToast('No pairs available in Stage 3 yet. Advance pairs from Stage 2 Ironing first.');
      return;
    }
    openModal('Process Stage 3: Pair Matching & BOM Calculation', `
      <div style="font-size: 13px;">
        <p style="margin-bottom: 12px; color: var(--ink-600);">
          Match all ${available.toLocaleString()} available pairs. Passed and defect quantities must total the available amount. Auto-computes the BOM under <strong>${getMaterialReqNumber(state.packingWip.selectedBatch)}</strong>.
        </p>
        <div class="form-group" style="margin-bottom: 12px;">
          <label for="step3-good-input">Matched Good Pairs:</label>
          <input type="number" id="step3-good-input" class="form-input" value="${available}" />
        </div>
        <div class="form-group" style="margin-bottom: 16px;">
          <label for="step3-defect-input">Mismatch / Unpaired Gloves:</label>
          <input type="number" id="step3-defect-input" class="form-input" value="0" />
        </div>
        <div style="background: var(--ink-100); border: 1px solid var(--border-strong); border-radius: 4px; padding: 10px; margin-bottom: 14px;">
          <div style="font-weight: 700; color: var(--ink-950); margin-bottom: 4px;">Dynamic Packaging BOM (${getMaterialReqNumber(state.packingWip.selectedBatch)}):</div>
          <div style="font-size: 12px; color: var(--ink-600);">
            Polybags: <strong>${state.packingWip.stage3Passed} Pcs</strong> &bull; Hangtags: <strong>${state.packingWip.stage3Passed} Pcs</strong> &bull; Silica: <strong>${state.packingWip.stage3Passed} Sachets</strong> &bull; Barcodes: <strong>${state.packingWip.stage3Passed * 2} Pcs</strong> &bull; Master Cartons: <strong>${Math.ceil(state.packingWip.stage3Passed / 30)} Pcs</strong>
          </div>
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn-outline" data-modal-cancel>Cancel</button>
          <button type="button" class="btn-primary" id="btn-submit-step3-action">Confirm &amp; Route to 1st Packing &rarr;</button>
        </div>
      </div>
    `, false, { hideGlobalFooter: true });
    bindComplementaryStageInputs('step3-good-input', 'step3-defect-input', available);

    let step3InFlight = false;
    document.getElementById('btn-submit-step3-action')?.addEventListener('click', async (event) => {
      if (step3InFlight) return;
      const split = readComplementaryStageInputs('step3-good-input', 'step3-defect-input', available);
      if (!split) return;
      const submitBtn = event.currentTarget as HTMLButtonElement | null;
      step3InFlight = true;
      if (submitBtn) submitBtn.disabled = true;

      try {
        const { good, defects } = split;
        const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);

        if (isPersistedRequisition(baseReq)) {
          const savedOk = await postWipStageUpdate(
            baseReq,
            'step3-matching',
            { goodPairs: good, defectPairs: defects, defectReason: 'Mismatch / Unpaired Gloves' },
            'Unable to save Stage 3 matching progress.'
          );
          if (!savedOk) return;
          recordStageDefects('Stage 3 (Matching)', defects, 'Mismatch / Unpaired Gloves');
        } else {
          state.packingWip.stage3Passed += good;
          state.packingWip.stage3Defects += defects;
          state.packingWip.stage4In += good;
          state.packingWip.inAlteration += defects;
          state.packingWip.lineEfficiency = computeWipRolledYieldPct(state.packingWip);
          recordStageDefects('Stage 3 (Matching)', defects, 'Mismatch / Unpaired Gloves');
          state.packingWip.mreqNo = getMaterialReqNumber(state.packingWip.selectedBatch);
          state.packingWip.altReqNo = getAlterationReqNumber(state.packingWip.selectedBatch);
          state.packingWip.mreqQty = `${state.packingWip.stage3Passed} Sets`;
          if (state.packingWip.mreqStatus !== 'ISSUED') {
            state.packingWip.mreqStatus = 'Ready';
          }
          saveCurrentOrderWipState();
        }
        closeModal();
        showToast(`${good} pairs matched in Stage 3. Material Requisition is now unlocked.`);
        renderApp();
      } finally {
        step3InFlight = false;
        if (submitBtn?.isConnected) submitBtn.disabled = false;
      }
    });
  });

  // --- Section: Material Requisition & Stage 4-5 ---
  let mreqInFlight = false;
  document.getElementById('btn-wip-generate-mreq-slip')?.addEventListener('click', async (event) => {
    if (!isStage3ClearedForMaterialReq(state.packingWip)) {
      showToast('Material Requisition is locked until Stage 3 (Pair Matching) produces matched pairs.');
      return;
    }
    if (mreqInFlight) return;
    const btn = event.currentTarget as HTMLButtonElement | null;
    mreqInFlight = true;
    if (btn) btn.disabled = true;

    try {
      const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
      const mreqId = getMaterialReqNumber(baseReq);

      if (isPersistedRequisition(baseReq)) {
        try {
          const createResp = await fetch(`/api/wip/${encodeURIComponent(baseReq)}/material-requisition`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({})
          });
          const createData = await createResp.json();
          if (!createResp.ok || !createData.success || !createData.data) {
            showToast(createData.error || 'Unable to generate Material Requisition.');
            return;
          }

          let matReq = createData.data;
          let issuedNow = false;
          if (matReq.mat_req_number && matReq.status === 'PENDING') {
            const issueResp = await fetch(`/api/material-requisitions/${encodeURIComponent(matReq.mat_req_number)}/issue`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({})
            });
            const issueData = await issueResp.json();
            if (!issueResp.ok || !issueData.success || !issueData.data) {
              state.packingWip.mreqStatus = matReq.status;
              (state.packingWip as any).matReqNumber = matReq.mat_req_number;
              saveCurrentOrderWipState();
              renderApp();
              showToast(issueData.error || `Material Requisition ${matReq.mat_req_number} created, but issue failed.`);
              return;
            }
            matReq = issueData.data;
            issuedNow = true;
          }

          state.packingWip.mreqStatus = matReq.status || 'ISSUED';
          (state.packingWip as any).matReqNumber = matReq.mat_req_number || '';
          if (issuedNow) {
            const issuedPairs = Math.min(
              state.packingWip.stage3Passed,
              Number(state.packingWip.mreqIssuedPairs || 0) + Number(matReq.pairs_count || 0)
            );
            state.packingWip.mreqIssuedPairs = issuedPairs;
            state.packingWip.mreqCoveredPairs = issuedPairs;
          }
          saveCurrentOrderWipState();
          renderApp();
        } catch (error) {
          console.error('Material Requisition persistence failed:', error);
          showToast('Failed to save or issue Material Requisition.');
          return;
        }
      } else {
        state.packingWip.mreqStatus = 'ISSUED';
        state.packingWip.mreqIssuedPairs = state.packingWip.stage3Passed;
        state.packingWip.mreqCoveredPairs = state.packingWip.stage3Passed;
        saveCurrentOrderWipState();
        renderApp();
      }

      openModal(`Material Requisition Slip — ${mreqId}`, buildCurrentMaterialRequisitionSlip(), true);
    } finally {
      mreqInFlight = false;
      if (btn?.isConnected) btn.disabled = false;
    }
  });

  document.getElementById('btn-wip-print-mreq-slip')?.addEventListener('click', () => {
    if (!isStage3ClearedForMaterialReq(state.packingWip)) {
      showToast('Material Requisition can only be printed after Stage 3 (Pair Matching) produces matched pairs.');
      return;
    }
    if (!isMaterialRequisitionIssuedForStage4(state.packingWip)) {
      showToast('Generate the Material Requisition slip first before printing.');
      return;
    }
    const mreqId = getMaterialReqNumber(state.packingWip.selectedBatch);
    printDocument(`Material Requisition Slip — ${mreqId}`, buildCurrentMaterialRequisitionSlip());
  });

  // Stage 4 Modal
  document.getElementById('btn-wip-step4')?.addEventListener('click', () => {
    if (!isMaterialRequisitionIssuedForStage4(state.packingWip)) {
      showToast('Stage 4 locked: Generate the Material Requisition slip first.');
      return;
    }
    const available = Math.max(0, state.packingWip.stage4In - state.packingWip.stage4Passed);
    if (available <= 0) {
      if (isPackingAwaitingFinalQc(state.packingWip)) {
        showToast('Stage 4 1st Packing is 100% complete — awaiting Final QC clearance (AQL 1.5) before Stage 5 cartons.');
      } else {
        showToast('No pairs available in Stage 4 yet. Match pairs in Stage 3 first.');
      }
      return;
    }
    openModal('Process Stage 4: 1st Packing (Unit Polybag)', `
      <div style="font-size: 13px;">
        <p style="margin-bottom: 12px; color: var(--ink-600);">
          Insert silica gel sachet, attach rider hangtag, seal airtight polybag, and affix scannable barcode label. Available to pack: <strong>${available.toLocaleString()} pairs</strong> (Cumulative packed so far: ${state.packingWip.stage4Passed.toLocaleString()} pairs).
        </p>
        <div class="form-group" style="margin-bottom: 12px;">
          <label for="step4-packed-input">Pairs to Polybag &amp; Seal (Incremental):</label>
          <input type="number" id="step4-packed-input" class="form-input" min="0" max="${available}" value="${available}" />
        </div>
        <div class="form-group" style="margin-bottom: 16px;">
          <label for="step4-pending-input">Remaining in Progress:</label>
          <input type="number" id="step4-pending-input" class="form-input" value="0" readonly />
        </div>
        <div style="display: flex; justify-content: flex-end; gap: 8px;">
          <button type="button" class="btn-outline" data-modal-cancel>Cancel</button>
          <button type="button" class="btn-primary" id="btn-submit-step4-action">Complete 1st Packing &rarr;</button>
        </div>
      </div>
    `, false, { hideGlobalFooter: true });

    const step4Input = document.getElementById('step4-packed-input') as HTMLInputElement | null;
    const step4PendingInput = document.getElementById('step4-pending-input') as HTMLInputElement | null;
    step4Input?.addEventListener('input', () => {
      const val = parseInt(step4Input.value || '0', 10) || 0;
      if (step4PendingInput) {
        step4PendingInput.value = String(Math.max(0, available - val));
      }
    });

    let step4InFlight = false;
    document.getElementById('btn-submit-step4-action')?.addEventListener('click', async (event) => {
      if (step4InFlight) return;
      const packed = parseInt((document.getElementById('step4-packed-input') as HTMLInputElement)?.value || '0', 10) || 0;
      if (packed <= 0 || packed > available) {
        showToast(`Enter between 1 and ${available.toLocaleString()} pairs available for Stage 4 packing.`);
        return;
      }
      const submitBtn = event.currentTarget as HTMLButtonElement | null;
      step4InFlight = true;
      if (submitBtn) submitBtn.disabled = true;

      try {
        const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
        if (isPersistedRequisition(baseReq)) {
          const savedOk = await postWipStageUpdate(
            baseReq,
            'step4-packing',
            { packedPairs: packed },
            'Unable to save Stage 4 packing progress.'
          );
          if (!savedOk) return;
        } else {
          state.packingWip.stage4Passed += packed;
          state.packingWip.stage4Pending = Math.max(0, state.packingWip.stage4In - state.packingWip.stage4Passed);
          saveCurrentOrderWipState();
        }
        closeModal();
        showToast(`${packed} unit polybags sealed with barcode verification.`);
        renderApp();
      } finally {
        step4InFlight = false;
        if (submitBtn?.isConnected) submitBtn.disabled = false;
      }
    });
  });

  // Stage 5 Modal (4.2: Enforces Stage 4 -> Final QC -> Stage 5 Lock Gate + Partial Split Shipping)
  document.getElementById('btn-wip-step5')?.addEventListener('click', () => openStage5BoxingModal());

  // Rework Re-Issue Request (Packing Hall requests repaired pairs waiting at Inward Register under original REQ)
  let reworkReissueInFlight = false;
  const triggerReworkReissue = async (btn: HTMLButtonElement | null) => {
    if (reworkReissueInFlight) return;
    const reqNo = normalizeBaseReqNumber(btn?.dataset.reqNumber || state.packingWip.selectedBatch);
    if (!reqNo) return;
    if (reqNo !== normalizeBaseReqNumber(state.packingWip.selectedBatch)) {
      switchActiveOrder(reqNo);
    }
    reworkReissueInFlight = true;
    if (btn) btn.disabled = true;
    try {
      const res = await fetch(`/api/requisitions/${encodeURIComponent(reqNo)}/request-rework-reissue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' }
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        throw new Error(json.error || `Unable to request rework re-issue for ${reqNo}.`);
      }
      await syncBackendData();
      showToast(json.data?.message || `Requested Inward Register re-issue for ${reqNo}.`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Unable to request rework re-issue for ${reqNo}.`);
    } finally {
      reworkReissueInFlight = false;
      if (btn?.isConnected) btn.disabled = false;
    }
  };

  document.getElementById('btn-wip-request-rework-reissue')?.addEventListener('click', async (event) => {
    await triggerReworkReissue(event.currentTarget as HTMLButtonElement | null);
  });

  document.querySelectorAll<HTMLButtonElement>('[data-packing-action="request-rework-reissue"]').forEach(el => {
    el.addEventListener('click', async () => {
      await triggerReworkReissue(el);
    });
  });

  // --- Section: New Req, Shift Export & Labels ---
  // Packing Hall Generates Requisition Asking (Inward Register Person Issues Given Available Stock)
  document.getElementById('btn-wip-new-req')?.addEventListener('click', () => {
    openNewRequisitionModal();
  });

  // Shift log export
  document.getElementById('btn-wip-export-shift')?.addEventListener('click', () => {
    exportTableToCSV('Packing_Hall_Shift_Execution_Log.csv', [
      {
        Requisition: state.packingWip.selectedBatch,
        MaterialReq: state.packingWip.mreqNo,
        AlterationReq: state.packingWip.altReqNo,
        Article: state.packingWip.article,
        AskingQty: state.packingWip.plannedQty,
        IssueStatus: state.packingWip.issueStatus,
        Stage1Passed: state.packingWip.stage1Passed,
        Stage1Defects: state.packingWip.stage1Defects,
        Stage2Passed: state.packingWip.stage2Passed,
        Stage3Matched: state.packingWip.stage3Passed,
        Stage4Polybagged: state.packingWip.stage4Passed,
        Stage5CartonsPacked: state.packingWip.outputCartons,
        Efficiency: state.packingWip.lineEfficiency
      }
    ]);
    showToast('Packing Hall Shift Execution Log downloaded.');
  });

  document.getElementById('btn-wip-print-labels')?.addEventListener('click', () => {
    const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
    const reqCartons = Array.isArray((state.ordersWipMap[baseReq] as any)?.cartons)
      ? (state.ordersWipMap[baseReq] as any).cartons
      : [];
    if (reqCartons.length === 0) {
      showToast(`No master cartons sealed for ${baseReq} yet. Complete Final QC and seal cartons in Stage 5 before printing labels.`);
      return;
    }
    openDocumentCenterModal('carton');
    const preview = document.getElementById('doc-preview-container');
    if (preview) printDocument('Hammad-Doc-carton', preview.innerHTML);
  });

  document.getElementById('btn-wip-final-clearance')?.addEventListener('click', () => {
    if (!state.currentUser || state.currentUser.role === 'SUPER_USER') {
      state.activeScreen = 'screen-admin';
      state.adminActiveTab = 'qc-dispatch';
      state.adminQcDispatchSelectedReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
      state.adminQcDispatchOrderFilter = '';
      renderApp();
      return;
    }
    showToast('Master carton creation and QC are managed by Super User.');
  });

  attachCartonDispatchHandlers();
}
