import { escapeHtml } from '../../utils/requisitionLogic';
import type { QcDispatchReqRow, SuperUserRenderContext } from './types';

export type QcDispatchStatus =
  | 'Awaiting AQL'
  | 'Ready to box'
  | 'Assign air / sea'
  | 'Ready to release'
  | 'Dispatched';

export interface QcDispatchMetrics {
  boxed: number;
  remaining: number;
  air: number;
  sea: number;
  ready: number;
  cbm: number;
  status: QcDispatchStatus;
}

export function computeQcDispatchMetrics(row: QcDispatchReqRow): QcDispatchMetrics {
  const cartons = Array.isArray(row.cartons) ? row.cartons : [];
  let boxed = 0;
  let air = 0;
  let sea = 0;
  let ready = 0;
  let cbm = 0;

  for (const c of cartons) {
    const pairs = Number(c.pairs || 0);
    boxed += pairs;
    cbm += Number(c.cbm ?? 0.084);
    const mode = String(c.shippingMode || 'UNASSIGNED').toUpperCase();
    if (mode === 'AIR') air += pairs;
    else if (mode === 'SEA') sea += pairs;
    else ready += pairs;
  }

  const remaining = Math.max(0, Number(row.stage4Passed || 0) - boxed);
  let status: QcDispatchStatus = 'Ready to release';
  if (row.dispatched) {
    status = 'Dispatched';
  } else if (!row.finalQcApproved) {
    status = 'Awaiting AQL';
  } else if (remaining > 0) {
    status = 'Ready to box';
  } else if (ready > 0) {
    status = 'Assign air / sea';
  }

  return { boxed, remaining, air, sea, ready, cbm, status };
}

export function renderQcDispatchTab(ctx: SuperUserRenderContext): string {
  const allRows = ctx.qcDispatchRows || [];
  const distinctOrders = Array.from(
    new Map(allRows.map(r => [r.orderId, { orderId: r.orderId, article: r.article, po: r.po }])).values()
  );
  const orderFilter = (ctx.qcDispatchOrderFilter || '').trim();
  const rows = orderFilter ? allRows.filter(r => r.orderId === orderFilter) : allRows;

  let awaitingAqlCount = 0;
  let readyToBoxCount = 0;
  let readyToReleaseCount = 0;
  const rowsWithMetrics = rows.map(row => {
    const metrics = computeQcDispatchMetrics(row);
    if (metrics.status === 'Awaiting AQL') awaitingAqlCount += 1;
    else if (metrics.status === 'Ready to box') readyToBoxCount += 1;
    else if (metrics.status === 'Ready to release') readyToReleaseCount += 1;
    return { row, metrics };
  });

  const selectedReq = (ctx.qcDispatchSelectedReq || '').trim();
  const selectedEntry =
    (selectedReq ? rowsWithMetrics.find(item => item.row.reqNumber === selectedReq) : undefined) ||
    rowsWithMetrics.find(item => item.row.cartons.length > 0) ||
    rowsWithMetrics[0];

  const queueHtml = `
    <section class="panel-card" id="qcd-queue" style="margin-bottom: 16px;">
      <div class="panel-card-header" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;">
        <div>
          <h2 class="panel-card-title" style="margin: 0; font-weight: 500;">QC &amp; dispatch</h2>
          <div style="font-size: 12px; color: var(--ink-500); margin-top: 2px;">
            Inspect AQL 1.5, box master cartons with dimensions, assign Air or Sea, and release lots from one queue.
          </div>
        </div>
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-variant-numeric: tabular-nums; font-size: 12.5px;">
          <select id="qcd-order-select" class="form-select" aria-label="Filter QC &amp; dispatch by order" style="width: auto; min-width: 185px; padding: 4px 8px; font-size: 12px;">
            <option value="">All orders (${distinctOrders.length})</option>
            ${distinctOrders.map(o => `
              <option value="${escapeHtml(o.orderId)}"${orderFilter === o.orderId ? ' selected' : ''}>${escapeHtml(o.orderId)}${o.article ? ` — ${escapeHtml(o.article)}` : ''}${o.po ? ` (${escapeHtml(o.po)})` : ''}</option>
            `).join('')}
          </select>
          <select id="qcd-req-select" class="form-select" aria-label="Select requisition manifest" style="width: auto; min-width: 195px; padding: 4px 8px; font-size: 12px;"${rowsWithMetrics.length === 0 ? ' disabled' : ''}>
            ${rowsWithMetrics.length === 0 ? '<option value="">No Stage 4 requisitions</option>' : rowsWithMetrics.map(({ row, metrics }) => `
              <option value="${escapeHtml(row.reqNumber)}"${selectedEntry?.row.reqNumber === row.reqNumber ? ' selected' : ''}>${escapeHtml(row.reqNumber)} (${escapeHtml(row.orderId)} &bull; ${metrics.boxed}/${row.stage4Passed})</option>
            `).join('')}
          </select>
          ${orderFilter ? `
            <button type="button" class="btn-outline" style="padding: 4px 10px; font-size: 12px;" data-qcd-action="clear-filter">Show all</button>
          ` : ''}
          <span>Awaiting AQL <strong style="font-weight: 500;">${awaitingAqlCount}</strong></span>
          <span>Ready to box <strong style="font-weight: 500;">${readyToBoxCount}</strong></span>
          <span>Ready to release <strong style="font-weight: 500;">${readyToReleaseCount}</strong></span>
        </div>
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Requisition</th>
              <th scope="col">Order</th>
              <th scope="col">Article</th>
              <th scope="col" class="text-right">Stage 4 packed</th>
              <th scope="col" class="text-center">AQL</th>
              <th scope="col" class="text-right">Boxed</th>
              <th scope="col" class="text-right">Air / Sea</th>
              <th scope="col" class="text-center">Status</th>
              <th scope="col" class="text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            ${rowsWithMetrics.length === 0 ? `
              <tr>
                <td colspan="9" class="table-empty-cell" style="padding: 28px 16px; color: var(--ink-500);">
                  No requisitions have finished Stage 4 yet. Lots appear here once the floor completes 1st packing.
                </td>
              </tr>
            ` : rowsWithMetrics.map(({ row, metrics }) => {
              const isSelected = selectedEntry?.row.reqNumber === row.reqNumber;
              return `
                <tr data-qcd-row="${escapeHtml(row.reqNumber)}"${isSelected ? ' style="background: var(--ink-50);"' : ''}>
                  <td style="font-weight: 500;">${escapeHtml(row.reqNumber)}</td>
                  <td style="font-variant-numeric: tabular-nums;">${escapeHtml(row.orderId)}</td>
                  <td>${escapeHtml(row.article || '---')}${row.po ? ` <span style="color: var(--ink-500); font-size: 11.5px;">(${escapeHtml(row.po)})</span>` : ''}</td>
                  <td class="text-right" style="font-variant-numeric: tabular-nums;">${row.stage4Passed}</td>
                  <td class="text-center">
                    <span class="status-pill ${row.finalQcApproved ? 'status-pill-green' : ''}">${row.finalQcApproved ? 'Passed' : 'Pending'}</span>
                  </td>
                  <td class="text-right" style="font-variant-numeric: tabular-nums;">${metrics.boxed} / ${row.stage4Passed}</td>
                  <td class="text-right" style="font-variant-numeric: tabular-nums;">${metrics.air} / ${metrics.sea}</td>
                  <td class="text-center">
                    <span class="status-pill ${metrics.status === 'Ready to release' || metrics.status === 'Dispatched' ? 'status-pill-green' : ''}">${metrics.status}</span>
                  </td>
                  <td class="text-center" style="white-space: nowrap;">
                    ${!row.finalQcApproved ? `
                      <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-qcd-action="aql" data-req-number="${escapeHtml(row.reqNumber)}">Inspect AQL</button>
                    ` : ''}
                    ${row.finalQcApproved && metrics.remaining > 0 ? `
                      <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-qcd-action="box" data-req-number="${escapeHtml(row.reqNumber)}">Box cartons</button>
                    ` : ''}
                    <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-qcd-action="select" data-req-number="${escapeHtml(row.reqNumber)}">View manifest</button>
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
    </section>
  `;

  if (!selectedEntry) {
    return `
      ${queueHtml}
      <section class="panel-card" id="qcd-manifest" data-req-number="">
        <div style="padding: 24px 16px; text-align: center; color: var(--ink-500); font-size: 13px;">
          Select a requisition to view its carton manifest.
        </div>
      </section>
    `;
  }

  const { row: sel, metrics: selMetrics } = selectedEntry;
  const canRelease = Boolean(!sel.dispatched && sel.finalQcApproved && sel.cartons.length > 0 && selMetrics.ready === 0 && selMetrics.remaining === 0);
  let airCartonsCount = 0;
  let seaCartonsCount = 0;
  let airCbm = 0;
  let seaCbm = 0;
  for (const c of sel.cartons) {
    const m = String(c.shippingMode || 'UNASSIGNED').toUpperCase();
    const v = Number(c.cbm ?? 0.084);
    if (m === 'AIR') {
      airCartonsCount += 1;
      airCbm += v;
    } else if (m === 'SEA') {
      seaCartonsCount += 1;
      seaCbm += v;
    }
  }

  const manifestHtml = `
    <section class="panel-card" id="qcd-manifest" data-req-number="${escapeHtml(sel.reqNumber)}">
      <div class="panel-card-header" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px;">
        <h3 class="panel-card-title" style="margin: 0; font-weight: 500;">Master carton manifest &mdash; ${escapeHtml(sel.reqNumber)}</h3>
        <div style="display: flex; align-items: center; gap: 8px;">
          ${sel.finalQcApproved && selMetrics.remaining > 0 ? `
            <button type="button" class="btn-outline" style="padding: 4px 10px; font-size: 12px;" data-qcd-action="box" data-req-number="${escapeHtml(sel.reqNumber)}">Box remaining (${selMetrics.remaining} prs)</button>
          ` : ''}
          <span class="panel-counter-badge" style="font-variant-numeric: tabular-nums;">${sel.cartons.length} cartons</span>
        </div>
      </div>
      ${sel.cartons.length > 0 ? `
        <div id="qcd-bulk-dispatch-bar" data-total-cartons="${sel.cartons.length}" style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 16px; border-bottom: 1px solid var(--border); background: var(--ink-50); font-size: 12px;">
          <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px;">
            <label for="qcd-air-cartons-input" style="font-weight: 500; color: var(--ink-700);">Air cartons</label>
            <input type="number" id="qcd-air-cartons-input" class="form-input" min="0" max="${sel.cartons.length}" value="${airCartonsCount}" style="width: 76px; padding: 4px 8px; font-size: 12px; font-variant-numeric: tabular-nums;" />
            <label for="qcd-sea-cartons-input" style="font-weight: 500; color: var(--ink-700);">Sea cartons</label>
            <input type="number" id="qcd-sea-cartons-input" class="form-input" min="0" max="${sel.cartons.length}" value="${seaCartonsCount}" style="width: 76px; padding: 4px 8px; font-size: 12px; font-variant-numeric: tabular-nums;" />
            <button type="button" class="btn-primary" style="padding: 4px 12px; font-size: 12px;" data-qcd-action="save-air-sea-split" data-req-number="${escapeHtml(sel.reqNumber)}">Save Air / Sea allotment</button>
          </div>
          <div style="font-variant-numeric: tabular-nums; color: var(--ink-700);">
            Air: <strong>${airCartonsCount}</strong> ctns (${selMetrics.air} prs, ${airCbm.toFixed(3)} CBM) &middot; Sea: <strong>${seaCartonsCount}</strong> ctns (${selMetrics.sea} prs, ${seaCbm.toFixed(3)} CBM)
          </div>
        </div>
      ` : ''}
      <div class="table-responsive" style="max-height: 360px; overflow-y: auto;">
        <table class="data-table">
          <thead>
            <tr>
              <th scope="col">Carton</th>
              <th scope="col" class="text-right">Pairs</th>
              <th scope="col">Size (cm)</th>
              <th scope="col" class="text-right">CBM</th>
              <th scope="col">QC seal</th>
              <th scope="col" class="text-center">Mode</th>
              <th scope="col" class="text-center">Action</th>
            </tr>
          </thead>
          <tbody>
            ${sel.cartons.length === 0 ? `
              <tr>
                <td colspan="7" class="table-empty-cell" style="padding: 24px 16px; color: var(--ink-500);">
                  No cartons boxed yet. Use Box cartons after AQL passes.
                </td>
              </tr>
            ` : sel.cartons.map(c => {
              const mode = String(c.shippingMode || 'UNASSIGNED').toUpperCase();
              const modeLabel = mode === 'AIR' ? 'AIR' : mode === 'SEA' ? 'SEA' : 'Ready';
              const modeClass = mode === 'AIR' || mode === 'SEA' ? 'status-pill status-pill-green' : 'status-pill';
              return `
                <tr>
                  <td style="font-weight: 500;">${escapeHtml(c.cartonNo)}</td>
                  <td class="text-right" style="font-variant-numeric: tabular-nums;">${c.pairs}</td>
                  <td style="font-variant-numeric: tabular-nums;">${escapeHtml(c.dims || '60 × 40 × 35')}</td>
                  <td class="text-right" style="font-variant-numeric: tabular-nums;">${Number(c.cbm ?? 0.084).toFixed(3)}</td>
                  <td style="font-family: monospace; font-size: 11.5px;">${escapeHtml(c.sealNo)}</td>
                  <td class="text-center"><span class="${modeClass}">${modeLabel}</span></td>
                  <td class="text-center" style="white-space: nowrap;">
                    ${mode === 'UNASSIGNED' ? `
                      <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-carton-dispatch-mode="AIR" data-carton-no="${escapeHtml(c.cartonNo)}" data-req-number="${escapeHtml(sel.reqNumber)}">Air</button>
                      <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-carton-dispatch-mode="SEA" data-carton-no="${escapeHtml(c.cartonNo)}" data-req-number="${escapeHtml(sel.reqNumber)}">Sea</button>
                    ` : `
                      <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-carton-dispatch-mode="UNASSIGNED" data-carton-no="${escapeHtml(c.cartonNo)}" data-req-number="${escapeHtml(sel.reqNumber)}">Reset</button>
                    `}
                  </td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div style="display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 16px; border-top: 1px solid var(--border); font-size: 12.5px;">
        <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 10px; font-variant-numeric: tabular-nums;">
          <span>Total volume: <strong id="qcd-total-cbm" style="font-weight: 500;">${selMetrics.cbm.toFixed(3)} CBM</strong></span>
          <span class="stat-divider">|</span>
          <span id="qcd-split-summary">Air ${selMetrics.air} prs &bull; Sea ${selMetrics.sea} prs &bull; Ready ${selMetrics.ready} prs &bull; Unboxed ${selMetrics.remaining} prs</span>
        </div>
        <div style="display: flex; align-items: center; gap: 8px;">
          <button type="button" class="btn-outline" id="qcd-print-btn" data-qcd-action="print" data-req-number="${escapeHtml(sel.reqNumber)}"${sel.cartons.length === 0 ? ' disabled' : ''}>Print manifest</button>
          <button type="button" class="btn-primary" id="qcd-release-btn" data-qcd-action="release" data-req-number="${escapeHtml(sel.reqNumber)}"${canRelease ? '' : ' disabled'}>${sel.dispatched ? 'Dispatched &#10003;' : 'Release &amp; dispatch'}</button>
        </div>
      </div>
    </section>
  `;

  return `${queueHtml}${manifestHtml}`;
}

export function buildDispatchManifestPrintHtml(row: QcDispatchReqRow, dateStr: string): string {
  const m = computeQcDispatchMetrics(row);
  return `
    <div style="border: 2px solid var(--ink-950); padding: 18px; background: var(--white); color: var(--ink-950); font-family: monospace;">
      <div style="text-align: center; border-bottom: 2px solid var(--ink-950); padding-bottom: 10px; margin-bottom: 14px;">
        <div style="font-size: 18px; font-weight: 700; color: var(--ink-950); letter-spacing: 0.04em;">HAMMAD INDUSTRIES &bull; DISPATCH MANIFEST</div>
        <div style="font-size: 11px; color: var(--ink-600);">MASTER CARTON SHIPPING SUMMARY</div>
      </div>
      <div class="printable-meta-grid" style="font-size: 12px; margin-bottom: 14px; color: var(--ink-950);">
        <div><span>Requisition #:</span> <strong>${escapeHtml(row.reqNumber)}</strong></div>
        <div><span>Order #:</span> <strong>${escapeHtml(row.orderId || '---')}</strong></div>
        <div><span>Article:</span> <strong>${escapeHtml(row.article || '---')}</strong></div>
        <div><span>PO Number:</span> <strong>${escapeHtml(row.po || '---')}</strong></div>
        <div><span>Date:</span> <strong>${escapeHtml(dateStr)}</strong></div>
        <div><span>AQL 1.5 Status:</span> <strong>${row.finalQcApproved ? 'PASSED' : 'PENDING'}</strong></div>
      </div>
      <table style="width: 100%; border-collapse: collapse; font-size: 12px; margin-bottom: 14px; color: var(--ink-950);">
        <thead>
          <tr>
            <th style="border: 1px solid var(--ink-950); padding: 6px 8px; text-align: left;">Carton</th>
            <th style="border: 1px solid var(--ink-950); padding: 6px 8px; text-align: right;">Pairs</th>
            <th style="border: 1px solid var(--ink-950); padding: 6px 8px; text-align: left;">Size (cm)</th>
            <th style="border: 1px solid var(--ink-950); padding: 6px 8px; text-align: right;">CBM</th>
            <th style="border: 1px solid var(--ink-950); padding: 6px 8px; text-align: center;">Mode</th>
            <th style="border: 1px solid var(--ink-950); padding: 6px 8px; text-align: left;">Seal</th>
          </tr>
        </thead>
        <tbody>
          ${row.cartons.map(c => {
            const mode = String(c.shippingMode || 'UNASSIGNED').toUpperCase();
            return `
              <tr>
                <td style="border: 1px solid var(--ink-950); padding: 5px 8px;">${escapeHtml(c.cartonNo)}</td>
                <td style="border: 1px solid var(--ink-950); padding: 5px 8px; text-align: right; font-variant-numeric: tabular-nums;">${c.pairs}</td>
                <td style="border: 1px solid var(--ink-950); padding: 5px 8px; font-variant-numeric: tabular-nums;">${escapeHtml(c.dims)}</td>
                <td style="border: 1px solid var(--ink-950); padding: 5px 8px; text-align: right; font-variant-numeric: tabular-nums;">${Number(c.cbm ?? 0.084).toFixed(3)}</td>
                <td style="border: 1px solid var(--ink-950); padding: 5px 8px; text-align: center;">${escapeHtml(mode)}</td>
                <td style="border: 1px solid var(--ink-950); padding: 5px 8px;">${escapeHtml(c.sealNo)}</td>
              </tr>
            `;
          }).join('')}
        </tbody>
      </table>
      <div style="display: flex; flex-wrap: wrap; gap: 14px; font-size: 12px; border-top: 1px solid var(--ink-950); padding-top: 10px; margin-bottom: 14px; font-variant-numeric: tabular-nums;">
        <span>Total cartons: <strong>${row.cartons.length}</strong></span>
        <span>Total pairs: <strong>${m.boxed}</strong></span>
        <span>Total volume: <strong>${m.cbm.toFixed(3)} CBM</strong></span>
        <span>Air: <strong>${m.air} prs</strong></span>
        <span>Sea: <strong>${m.sea} prs</strong></span>
      </div>
      <div style="font-size: 12px; border-top: 1px dashed var(--ink-950); padding-top: 10px;">
        Released by: ______________________
      </div>
    </div>
  `;
}
