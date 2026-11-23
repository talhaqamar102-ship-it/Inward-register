import {
  buildGrnReceivingSlipHtml,
  buildPackingRequisitionSlipHtml,
  calculateSizeTotal,
  formatBatchSequence,
  formatCurrentDateDDMMYYYY,
  formatSplitAllocationSummary,
  getAlterationReqNumber,
  normalizeBaseReqNumber
} from '../../utils/requisitionLogic';
import { openModal, printDocument } from '../../utils/domModalsAndPrint';
import { state } from '../../state/appState';

// Function to open Printable Documents & Voucher Center (No Buyer, reflects Sizes, Article, M/A Prefixes, and Approved By)
export function openDocumentCenterModal(defaultDoc: string = 'grn'): void {
  const baseReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
  const altReq = getAlterationReqNumber(baseReq);
  const latestGrn = state.grnList[0];

  function getDocHTML(type: string): string {
    if (type === 'grn') {
      const sizes = calculateSizeTotal(state.grnForm.sizes) > 0
        ? state.grnForm.sizes
        : (latestGrn?.sizes || state.packingWip.sizes);
      const rcvd = latestGrn?.rcvdPairs || calculateSizeTotal(sizes);
      const pendingOrderId = state.grnForm.pendingOrderId || latestGrn?.pendingOrderId || '---';
      const article = state.grnForm.article || latestGrn?.article || state.packingWip.article || '---';
      const maker = state.grnForm.maker || latestGrn?.maker || '---';
      const matchedOrd = state.pendingOrders.find(o => o.orderId === pendingOrderId);
      const docSplitSummary = formatSplitAllocationSummary(matchedOrd?.contractorAllocations);

      return buildGrnReceivingSlipHtml({
        grnRef: latestGrn?.grnCode || formatBatchSequence('GRN', state.grnList.length || 1),
        date: latestGrn?.date || formatCurrentDateDDMMYYYY(),
        pendingOrderId,
        maker,
        article,
        color: latestGrn?.color || matchedOrd?.color || state.grnForm.color,
        receivedFrom: latestGrn?.receivedFrom || state.grnForm.receivedFrom || maker,
        splitSummary: docSplitSummary || undefined,
        rcvdPairs: rcvd,
        sizes,
        sizeFormat: latestGrn?.sizeFormat || matchedOrd?.sizeFormat || state.grnForm.sizeFormat,
        sizeCodes: latestGrn?.sizeCodes || matchedOrd?.sizeCodes || state.grnForm.sizeCodes
      });
    } else if (type === 'route') {
      const latestDefect = state.defectList[0];
      return `
        <div style="border: 2px dashed var(--ink-900); padding: 16px; background: var(--white); font-family: sans-serif; color: var(--ink-950);">
          <div style="text-align: center; border-bottom: 2px solid var(--ink-900); padding-bottom: 8px; margin-bottom: 12px;">
            <div style="font-size: 16px; font-weight: 800; color: var(--ink-950); letter-spacing: 0.04em;">MANDATORY REWORK ROUTE TAG</div>
            <div style="font-size: 12px; font-weight: bold; color: var(--ink-600);">الٹریشن اور مرمت کا سرکاری روٹ کارڈ</div>
          </div>
          <div class="printable-meta-grid" style="color: var(--ink-950);">
            <div><span>Alteration Requisition #:</span> <strong>${latestDefect?.id || altReq}</strong></div>
            <div><span>Parent Requisition #:</span> <strong>${baseReq}</strong></div>
            <div><span>Article Name:</span> <strong>${latestDefect?.article || state.packingWip.article || '---'}</strong></div>
            <div><span>Defect Classification:</span> <strong>${latestDefect?.defectClass || 'Stitching Skip / Broken Seam'}</strong></div>
            <div><span>Batch Quantity:</span> <strong>${latestDefect?.qty || '0 Prs'}</strong></div>
            <div><span>Assigned Master Tailor:</span> <strong>${latestDefect?.tailor || '---'}</strong></div>
            <div><span>Max Allowed Reworks:</span> <strong>2 Cycles (Strict Scrap Rule)</strong></div>
          </div>
          <div style="background: var(--ink-100); border: 1px solid var(--ink-900); padding: 10px; border-radius: 4px; text-align: center; font-weight: 800; font-size: 12px; margin-top: 12px;">
            FACTORY MANDATORY RULE: EVERY REPAIRED PAIR MUST AUTO-RETURN TO STAGE 1 (CHECKING). SKIPPING STAGES IS STRICTLY SYSTEM-LOCKED.
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 20px; border-top: 1px dashed var(--ink-500); padding-top: 8px;">
            <span>Tailor Sign (درزی دستخط): _______________</span>
            <span>Bay #2 Lead: _______________</span>
            <span>Approved By: _______________</span>
          </div>
        </div>
      `;
    } else if (type === 'mreq') {
      const sizes = calculateSizeTotal(state.packingWip.sizes) > 0
        ? state.packingWip.sizes
        : state.grnForm.sizes;
      const totalPairs = state.packingWip.stage3Passed || state.packingWip.plannedQty || calculateSizeTotal(sizes);
      return buildPackingRequisitionSlipHtml({
        reqNo: baseReq,
        date: formatCurrentDateDDMMYYYY(),
        article: state.packingWip.article || state.grnForm.article || '---',
        sizes,
        totalPairs,
        issueStatus: state.packingWip.issueStatus,
        sizeFormat: (state.packingWip as any).sizeFormat || state.grnForm.sizeFormat,
        sizeCodes: (state.packingWip as any).sizeCodes || state.grnForm.sizeCodes
      });
    } else if (type === 'carton') {
      const article = state.qcOrder.article || state.packingWip.article || '---';
      return `
        <div style="border: 2px solid var(--ink-950); padding: 18px; font-family: monospace; background: var(--white);">
          <div style="text-align: center; border-bottom: 2px solid var(--ink-950); padding-bottom: 8px; margin-bottom: 12px;">
            <div style="font-size: 18px; font-weight: 800; color: var(--ink-950);">HAMMAD INDUSTRIES &bull; EXPORT MASTER CARTON</div>
            <div style="font-size: 11px; color: var(--ink-600);">INTERNATIONAL EXPORT SHIPPING LABEL &bull; THERMAL DIRECT / A4</div>
          </div>
          <div class="printable-meta-grid">
            <div><span>REQUISITION #:</span> <strong>${baseReq}</strong></div>
            <div><span>CARTON NUMBER:</span> <strong>CTN-01 OF ${Math.max(1, state.cartons.length)}</strong></div>
            <div><span>ARTICLE:</span> <strong>${article}</strong></div>
            <div><span>QUANTITY:</span> <strong>30 PAIRS</strong></div>
            <div><span>NET WEIGHT:</span> <strong>${state.qcOrder.netWt} KG</strong></div>
            <div><span>GROSS WEIGHT:</span> <strong>${state.qcOrder.grossWt} KG</strong></div>
            <div><span>DIMENSIONS:</span> <strong>29 x 23 x 28 CM</strong></div>
            <div><span>QC TAMPER SEAL:</span> <strong>FSKD-4401</strong></div>
            <div><span>AQL 1.5 AUDIT:</span> <strong>PASSED &bull; CLEARED</strong></div>
          </div>
          <div style="border: 1px solid var(--ink-950); padding: 10px; text-align: center; background: var(--ink-50); font-weight: 800; font-size: 14px; letter-spacing: 0.1em; margin-bottom: 12px;">
            ||||| ||||||| |||| |||||||| ||||| |||||| ||||||||<br/>
            *EAN13-5060129283741-CTN01*
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; border-top: 1px dashed var(--ink-950); padding-top: 8px;">
            <span>Tamper Seal Status: VERIFIED &bull; INTACT</span>
            <span>Approved By: ___________________</span>
          </div>
        </div>
      `;
    } else if (type === 'packing') {
      return `
        <div class="printable-slip-box">
          <div class="printable-slip-header">
            <h2 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--ink-950);">COMMERCIAL EXPORT PACKING LIST MANIFEST</h2>
            <p style="margin: 2px 0 0; font-size: 11px; text-transform: uppercase; color: var(--ink-600);">Hammad Industries &bull; Customs Clearance &amp; Container Gate Release</p>
          </div>
          <div class="printable-meta-grid">
            <div><span>Shipper:</span> <strong>Hammad Industries (Pvt) Ltd</strong></div>
            <div><span>Requisition #:</span> <strong>${baseReq}</strong></div>
            <div><span>Article:</span> <strong>${state.packingWip.article || '---'}</strong></div>
            <div><span>Total Cartons:</span> <strong>${state.cartons.length} Cartons</strong></div>
            <div><span>Total Pairs:</span> <strong>${state.cartons.reduce((a, c) => a + c.pairs, 0)} Pairs</strong></div>
            <div><span>Total Net Weight:</span> <strong>${state.qcOrder.netWt} kg</strong></div>
            <div><span>Total Gross Weight:</span> <strong>${state.qcOrder.grossWt} kg</strong></div>
            <div><span>Container #:</span> <strong>${state.qcOrder.container}</strong></div>
            <div><span>Inspection Standard:</span> <strong>AQL 1.5 Normal Single Sampling</strong></div>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 18px; border-top: 1px dashed var(--border-strong); padding-top: 8px;">
            <span>Packing Hall Supervisor: ___________________</span>
            <span>Issued By: ___________________</span>
            <span>Approved By: ___________________</span>
          </div>
        </div>
      `;
    } else {
      return '';
    }
  }

  function renderModalInner(activeTab: string) {
    return `
      <div>
        <div style="display: flex; gap: 6px; margin-bottom: 12px; overflow-x: auto; border-bottom: 1px solid var(--ink-200); padding-bottom: 8px;">
          <button class="btn-outline doc-tab-btn ${activeTab === 'grn' ? 'btn-primary' : ''}" data-doc="grn" style="font-size: 11px; padding: 4px 8px;">1. Inward GRN Slip</button>
          <button class="btn-outline doc-tab-btn ${activeTab === 'route' ? 'btn-primary' : ''}" data-doc="route" style="font-size: 11px; padding: 4px 8px;">2. Defect Route Tag</button>
          <button class="btn-outline doc-tab-btn ${activeTab === 'mreq' ? 'btn-primary' : ''}" data-doc="mreq" style="font-size: 11px; padding: 4px 8px;">3. Packing Requisition</button>
          <button class="btn-outline doc-tab-btn ${activeTab === 'carton' ? 'btn-primary' : ''}" data-doc="carton" style="font-size: 11px; padding: 4px 8px;">4. Shipping Label</button>
          <button class="btn-outline doc-tab-btn ${activeTab === 'packing' ? 'btn-primary' : ''}" data-doc="packing" style="font-size: 11px; padding: 4px 8px;">5. Export Packing List</button>
        </div>

        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; background: var(--ink-50); padding: 6px 10px; border-radius: 4px; border: 1px solid var(--ink-200);">
          <span style="font-size: 11.5px; color: var(--ink-600); font-weight: 600;">Document Output Preview (Print Ready)</span>
          <div style="display: flex; gap: 6px;">
            <button class="btn-primary" id="btn-quick-print-doc" style="font-size: 11.5px; padding: 4px 10px; display: inline-flex; align-items: center; gap: 4px;">
              Print Current Tab
            </button>
          </div>
        </div>

        <div id="doc-preview-container">
          ${getDocHTML(activeTab)}
        </div>
      </div>
    `;
  }

  openModal('Factory Document & Printable Voucher Center', renderModalInner(defaultDoc), true);

  document.querySelectorAll('.doc-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const docType = (e.currentTarget as HTMLElement).getAttribute('data-doc') || 'grn';
      openDocumentCenterModal(docType);
    });
  });

  document.getElementById('btn-quick-print-doc')?.addEventListener('click', () => {
    const docContainer = document.getElementById('doc-preview-container');
    const content = docContainer ? docContainer.innerHTML : '';
    printDocument(`Hammad-Doc-${defaultDoc}`, content);
  });
}
