import {
  OrderWipState,
  PendingOrder,
  buildRequisitionAnalyticsSeries,
  determineOrderActiveStage,
  getAlterationReqNumber,
  isMaterialRequisitionIssuedForStage4,
  isPackingAwaitingFinalQc,
  isStage3ClearedForMaterialReq,
  isStage5ReadyForCartons,
  normalizeBaseReqNumber,
  renderRequisitionWipAnalyticsChart,
  formatCurrentDateDDMMYYYY
} from '../utils/requisitionLogic';

export type RollupSummaryParam = Parameters<typeof buildRequisitionAnalyticsSeries>[0];

export interface PackingHallDefectRow {
  id: string;
  origin: string;
  defectClass: string;
  qty: string;
  pairsCount?: number;
  status: string;
  route?: string;
  handoffStage?: string;
}

export interface PackingHallCartonRow {
  cartonNo: string;
  pairs: number;
  grossWt: string;
  dims?: string;
  cbm?: number;
  shippingMode?: 'UNASSIGNED' | 'AIR' | 'SEA';
  status: string;
  barcodeVerified: boolean;
  sealNo: string;
}

export interface PackingHallViewParams {
  wip: OrderWipState & {
    selectedBatch: string;
    mreqQty: string;
    stage5Pending?: string;
    lineEfficiency: string;
    outputPairs: number;
    outputCartons: number;
    inAlteration: number;
  };
  defaultReqNumber: string;
  ordersWipMap: Record<string, any>;
  persistedReqNumbers: string[];
  pendingOrders: PendingOrder[];
  defectList: PackingHallDefectRow[];
  cartons: PackingHallCartonRow[];
  rollupSummary: RollupSummaryParam;
  getOrderAvailableDockPairs: (orderId: string) => number;
  getOrderUnclaimedDockPairs?: (orderId: string) => number;
  remainingStagePairs: (input: number, passed: number, defects: number) => number;
  escapeHtml: (value: string) => string;
  isSuperUser?: boolean;
  isInitialSyncing?: boolean;
  isManualSync?: boolean;
  syncError?: string;
}

export function renderPackingHallScreen(params: PackingHallViewParams): string {
  const {
    wip,
    defaultReqNumber,
    ordersWipMap,
    persistedReqNumbers,
    pendingOrders,
    defectList,
    cartons,
    rollupSummary,
    getOrderAvailableDockPairs,
    getOrderUnclaimedDockPairs,
    remainingStagePairs,
    escapeHtml,
    isSuperUser = true,
    isInitialSyncing = false,
    isManualSync = false,
    syncError = ''
  } = params;

  const getUnclaimed = getOrderUnclaimedDockPairs || getOrderAvailableDockPairs;
  const dockReadyOrders = pendingOrders.filter(o => !o.shortClosed && getUnclaimed(o.orderId) > 0);

  const baseReq = normalizeBaseReqNumber(wip.selectedBatch);
  const aReq = getAlterationReqNumber(baseReq);
  const scopedDefects = defectList.filter(d => d.id === aReq || d.id === baseReq);
  const activeAlts = scopedDefects.filter(d => d.status === 'In Rework' || d.status === 'In Washing' || d.status === 'In Sorting');
  const awaitingFinalQc = isPackingAwaitingFinalQc(wip);
  const stage5Ready = isStage5ReadyForCartons(wip);
  const awaitingInwardIssue = wip.issueStatus !== 'Issued by Inward Register' && wip.stage1In <= 0;
  const stage3Cleared = isStage3ClearedForMaterialReq(wip);
  const mreqIssuedForStage4 = isMaterialRequisitionIssuedForStage4(wip);
  const parentRollup = wip.parentOrderId
    ? rollupSummary.orderRollups.find(o => o.orderId === wip.parentOrderId)
    : undefined;
  const countdown = parentRollup?.deliveryCountdown;

  return `
    <div class="sub-header-bar">
      <h1 class="sub-header-title">
        Packing Hall Floor &mdash; 5-Stage WIP Flow &amp; Requisition Slip Generator
      </h1>
      <div class="sub-header-right">
        <span class="system-date-label">Date: ${formatCurrentDateDDMMYYYY()}</span>
      </div>
    </div>

    <main id="main-content" class="main-viewport" tabindex="-1">
      ${syncError ? `
        <div class="packing-sync-banner is-error" role="alert" data-testid="packing-sync-error">
          <span>${escapeHtml(syncError)}</span>
          <button type="button" class="btn-outline" id="btn-wip-sync-retry">Retry Sync</button>
        </div>
      ` : (isInitialSyncing || isManualSync ? `
        <div class="packing-sync-banner" role="status" aria-live="polite" data-testid="packing-sync-loading">
          <span>Synchronizing Packing Hall data with MES server&hellip;</span>
        </div>
      ` : '')}

      <!-- Active Order Toolbar (Single Requisition with M- and A- Prefixes, No Buyer) -->
      <section class="form-card">
        <div class="packing-toolbar-grid">
          <div class="form-group" style="flex: 1.4; min-width: 190px;">
            <label for="wip-batch-select">Active Requisition / Order #</label>
            <select id="wip-batch-select" class="form-select" style="font-weight: 700;">
              ${(() => {
                const knownReqs = Array.from(new Set([
                  baseReq,
                  defaultReqNumber,
                  ...Object.keys(ordersWipMap)
                ]));
                return knownReqs.map(r => {
                  const item = ordersWipMap[r] || (r === baseReq ? wip : null);
                  const art = item?.article || (r === baseReq ? wip.article : '');
                  const stage = item ? determineOrderActiveStage(item) : 'STEP_1';
                  const isEmptyPlaceholder =
                    r === defaultReqNumber &&
                    !persistedReqNumbers.includes(r) &&
                    !item?.parentOrderId &&
                    Number(item?.plannedQty || 0) === 0;
                  const stageLabel = isPackingAwaitingFinalQc(item || {})
                    ? 'Awaiting Final QC'
                    : stage === 'STEP_1' ? 'Stage 1 (Checking)'
                    : stage === 'STEP_2' ? 'Stage 2 (Ironing)'
                    : stage === 'STEP_3' ? 'Stage 3 (Matching)'
                    : stage === 'STEP_4' ? 'Stage 4 (1st Pkg)'
                    : stage === 'STEP_5' ? 'Stage 5 (Cartons)'
                    : 'Completed';
                  const label = isEmptyPlaceholder
                    ? (dockReadyOrders.length > 0
                        ? 'No active requisition — choose ready dock stock below'
                        : 'No active requisition — awaiting Inward dock receiving')
                    : `${r}${art ? ` — ${art}` : ''} [${stageLabel}]`;
                  return `<option value="${escapeHtml(r)}" ${r === baseReq ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                }).join('') + (dockReadyOrders.length > 0
                  ? `<optgroup label="Dock Stock Ready — create requisition">${dockReadyOrders.map(order =>
                    `<option value="ORDER:${escapeHtml(order.orderId)}">Load ${escapeHtml(order.orderId)} — ${escapeHtml(order.article)} (${getUnclaimed(order.orderId).toLocaleString()} pairs available)</option>`
                  ).join('')}</optgroup>`
                  : '');
              })()}
            </select>
          </div>
          <div class="form-group" style="flex: 1; min-width: 110px;">
            <span class="field-label" style="font-size: 11px; font-weight: 700; color: var(--ink-500); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 4px; display: block;">Article</span>
            <div id="wip-disp-article" style="font-weight: 700; color: var(--ink-950); padding: 7px 0; font-size: 13px;">${wip.article || '---'}</div>
          </div>
          <div class="form-group" style="flex: 0.9; min-width: 100px;">
            <span class="field-label" style="font-size: 11px; font-weight: 700; color: var(--ink-500); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 4px; display: block;">Asking Qty</span>
            <div id="wip-disp-qty" style="font-weight: 700; color: var(--ink-950); padding: 7px 0; font-size: 13px;">${wip.plannedQty.toLocaleString()} Pairs</div>
          </div>
          <div class="form-group" style="flex: 1.1; min-width: 140px;">
            <span class="field-label" style="font-size: 11px; font-weight: 700; color: var(--ink-500); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 4px; display: block;">Inward Issue Status</span>
            <div style="padding: 5px 0;">
              <span class="status-pill ${wip.issueStatus === 'Issued by Inward Register' ? 'status-pill-green' : 'status-pill-amber'}" id="wip-disp-issue-status">${wip.issueStatus}</span>
            </div>
          </div>
          ${countdown?.hasDueDate ? `
          <div class="form-group" style="flex: 0.9; min-width: 120px;">
            <span class="field-label" style="font-size: 11px; font-weight: 700; color: var(--ink-500); text-transform: uppercase; letter-spacing: 0.03em; margin-bottom: 4px; display: block;">Delivery Timeline</span>
            <div style="padding: 5px 0;">
              <span class="status-pill" id="wip-disp-countdown" title="Due Date: ${escapeHtml(countdown.dueDate)}">${escapeHtml(countdown.badgeText)}</span>
            </div>
          </div>
          ` : ''}
          <div class="packing-toolbar-actions">
            <button type="button" class="btn-primary" id="btn-wip-new-req" ${dockReadyOrders.length === 0 ? 'disabled title="No unclaimed Inward Register stock available yet."' : ''}>+ Generate Requisition</button>
          </div>
        </div>
      </section>

      <!-- 5-Stage WIP Floor Process Pipeline -->
      <section>
        <div style="display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 8px; margin-bottom: 10px;">
          <h2 style="font-size: 13px; font-weight: 600; color: var(--ink-950); margin: 0;">
            WIP process pipeline
          </h2>
          <span style="font-size: 11.5px; color: var(--ink-500);">Active Requisition: <strong>${baseReq}</strong></span>
        </div>

        ${awaitingInwardIssue ? `
          <div style="margin-bottom: 10px; padding: 8px 12px; background: var(--ink-50); border: 1px solid var(--border-strong); border-radius: 4px; font-size: 12px; color: var(--ink-900);">
            <strong>Pending Inward Issue:</strong> <strong>${baseReq}</strong> (${wip.plannedQty.toLocaleString()} Prs requested) has <strong>0 pairs</strong> issued from Inward Goods Receiving yet${wip.parentOrderId ? ` (${wip.parentOrderId} Dock Available: ${getOrderAvailableDockPairs(wip.parentOrderId).toLocaleString()} Prs)` : ''}. Issue this requisition in Inward Goods Receiving before starting Stage 1.
          </div>
        ` : ''}

        ${awaitingFinalQc ? `
          <div class="packing-qc-notice" data-testid="wip-awaiting-qc-banner">
            <div>
              <strong>Stage 4 Complete &mdash; Awaiting Final QC (AQL 1.5 Inspection):</strong>
              All <strong>${wip.stage4Passed.toLocaleString()}</strong> pairs in <strong>${baseReq}</strong> are polybagged. Complete Final Inspection &amp; Master Carton Clearance in Super User QC &amp; Dispatch before sealing cartons in Stage 5.
            </div>
            ${isSuperUser
              ? `<button type="button" class="btn-primary" id="btn-wip-open-qc-banner">Open Super User QC &amp; Dispatch &rarr;</button>`
              : `<span class="status-pill">Queued for Super User QC &amp; Dispatch</span>`}
          </div>
        ` : ''}

        ${(() => {
          const activeStage = determineOrderActiveStage(wip);
          const stage1Rem = remainingStagePairs(wip.stage1In, wip.stage1Passed, wip.stage1Defects);
          const stage2Rem = remainingStagePairs(wip.stage2In, wip.stage2Passed, wip.stage2Defects);
          const stage3Rem = remainingStagePairs(wip.stage3In, wip.stage3Passed, wip.stage3Defects);
          return `
        <div class="wip-rail" data-testid="wip-rail">
          <!-- STAGE 1: Checking / Inspection -->
          <div class="wip-node ${activeStage === 'STEP_1' ? 'is-active' : ''} ${stage1Rem <= 0 && wip.stage1Passed > 0 ? 'is-complete' : ''}" data-testid="wip-node-1">
            <span class="wip-node-num">1</span>
            <div class="wip-node-body">
              <div class="wip-node-title">Checking</div>
              <div class="wip-node-metric"><span>In</span><strong id="wip-stg1-in">${stage1Rem.toLocaleString()}</strong></div>
              <div class="wip-node-metric"><span>Passed</span><strong id="wip-stg1-passed">${wip.stage1Passed.toLocaleString()}</strong></div>
              <div class="wip-node-metric"><span>Defects</span><strong id="wip-stg1-defects">${wip.stage1Defects.toLocaleString()}</strong></div>
              <button type="button" class="${activeStage === 'STEP_1' ? 'btn-primary' : 'btn-outline'} wip-node-action" id="btn-wip-step1" ${awaitingInwardIssue || stage1Rem <= 0 ? 'disabled' : ''}>
                ${stage1Rem <= 0 && wip.stage1Passed > 0 ? 'Checking complete' : 'Record checking'}
              </button>
            </div>
          </div>

          <!-- STAGE 2: Ironing & Brushing -->
          <div class="wip-node ${activeStage === 'STEP_2' ? 'is-active' : ''} ${stage2Rem <= 0 && wip.stage2Passed > 0 ? 'is-complete' : ''}" data-testid="wip-node-2">
            <span class="wip-node-num">2</span>
            <div class="wip-node-body">
              <div class="wip-node-title">Ironing</div>
              <div class="wip-node-metric"><span>In</span><strong id="wip-stg2-in">${stage2Rem.toLocaleString()}</strong></div>
              <div class="wip-node-metric"><span>Passed</span><strong id="wip-stg2-passed">${wip.stage2Passed.toLocaleString()}</strong></div>
              <div class="wip-node-metric"><span>Defects</span><strong id="wip-stg2-defects">${wip.stage2Defects.toLocaleString()}</strong></div>
              <button type="button" class="${activeStage === 'STEP_2' ? 'btn-primary' : 'btn-outline'} wip-node-action" id="btn-wip-step2" ${stage2Rem <= 0 ? 'disabled' : ''}>
                ${stage2Rem <= 0 && wip.stage2Passed > 0 ? 'Ironing complete' : 'Record ironing'}
              </button>
            </div>
          </div>

          <!-- STAGE 3: Pair Matching -->
          <div class="wip-node ${activeStage === 'STEP_3' ? 'is-active' : ''} ${stage3Rem <= 0 && wip.stage3Passed > 0 ? 'is-complete' : ''}" data-testid="wip-node-3">
            <span class="wip-node-num">3</span>
            <div class="wip-node-body">
              <div class="wip-node-title">Matching</div>
              <div class="wip-node-metric"><span>In</span><strong id="wip-stg3-in">${stage3Rem.toLocaleString()}</strong></div>
              <div class="wip-node-metric"><span>Matched</span><strong id="wip-stg3-passed">${wip.stage3Passed.toLocaleString()}</strong></div>
              <div class="wip-node-metric"><span>Defects</span><strong id="wip-stg3-defects">${wip.stage3Defects.toLocaleString()}</strong></div>
              <button type="button" class="${activeStage === 'STEP_3' ? 'btn-primary' : 'btn-outline'} wip-node-action" id="btn-wip-step3" ${stage3Rem <= 0 ? 'disabled' : ''}>
                ${stage3Rem <= 0 && wip.stage3Passed > 0 ? 'Matching complete' : 'Record matching'}
              </button>
            </div>
          </div>

          <!-- MATERIAL REQUISITION SLIP: a document, not a stage -->
          <div class="wip-mreq-slip ${stage3Cleared && !mreqIssuedForStage4 ? 'is-ready' : ''} ${mreqIssuedForStage4 ? 'is-issued' : ''}" data-testid="wip-mreq-gate">
            <div class="wip-slip-head">
              <span class="wip-slip-label">Material requisition</span>
              <span class="wip-slip-state">${!stage3Cleared ? 'Awaiting stage 3' : (mreqIssuedForStage4 ? 'Issued' : 'Ready')}</span>
            </div>
            <div class="wip-slip-metric"><span>Requisition</span><strong id="wip-mreq-no">${baseReq}</strong></div>
            <div class="wip-slip-metric wip-slip-qty"><span>Sets</span><strong id="wip-mreq-qty">${wip.stage3Passed.toLocaleString()} Sets</strong></div>
            <div class="wip-slip-metric"><span>On issued slips</span><strong id="wip-mreq-covered">${(wip.mreqIssuedPairs || 0).toLocaleString()} / ${wip.stage3Passed.toLocaleString()}</strong></div>
            <div class="wip-slip-metric"><span>Article</span><strong>${wip.article || '---'}</strong></div>
            <div class="wip-slip-actions">
              <button type="button" class="btn-outline wip-slip-btn" id="btn-wip-generate-mreq-slip" ${stage3Cleared ? '' : 'disabled title="Match at least one pair in Stage 3 first."'}>Generate slip</button>
              <button type="button" class="btn-primary wip-slip-btn" id="btn-wip-print-mreq-slip" ${stage3Cleared ? '' : 'disabled title="Match at least one pair in Stage 3 first."'}>Print slip</button>
            </div>
          </div>

          <!-- STAGE 4: 1st Packing -->
          <div class="wip-node ${activeStage === 'STEP_4' && mreqIssuedForStage4 ? 'is-active' : ''} ${wip.stage4Passed > 0 ? 'is-complete' : ''}" data-testid="wip-node-4">
            <span class="wip-node-num">4</span>
            <div class="wip-node-body">
              <div class="wip-node-title">1st packing</div>
              <div class="wip-node-metric"><span>In</span><strong id="wip-stg4-in">${wip.stage4In.toLocaleString()}</strong></div>
              <div class="wip-node-metric"><span>Packed</span><strong id="wip-stg4-passed">${wip.stage4Passed.toLocaleString()}</strong></div>
              <div class="wip-node-metric"><span>Pending</span><strong id="wip-stg4-pending">${wip.stage4Pending}</strong></div>
              <button type="button" class="${activeStage === 'STEP_4' && mreqIssuedForStage4 && !awaitingFinalQc ? 'btn-primary' : 'btn-outline'} wip-node-action" id="btn-wip-step4" ${!mreqIssuedForStage4 || awaitingFinalQc || wip.stage4Pending <= 0 ? 'disabled' : ''}>
                ${awaitingFinalQc || stage5Ready || (wip.stage4Passed > 0 && wip.stage4Pending === 0) ? '1st packing complete' : 'Record 1st packing'}
              </button>
            </div>
          </div>

          <!-- STAGE 5: 2nd Packing -->
          <div class="wip-node ${activeStage === 'STEP_5' ? 'is-active' : ''} ${(wip.outputCartons || 0) > 0 ? 'is-complete' : ''}" data-testid="wip-node-5">
            <span class="wip-node-num">5</span>
            <div class="wip-node-body">
              <div class="wip-node-title">Master cartons</div>
              <div class="wip-node-metric"><span>Spec</span><strong>30 prs / ctn</strong></div>
              <div class="wip-node-metric"><span>Packed</span><strong id="wip-stg5-cartons">${wip.stage5Cartons || '0 Cartons (0 Prs)'}</strong></div>
              <div class="wip-node-metric"><span>Pending</span><strong>${wip.stage5Pending || '0 Cartons'}</strong></div>
              <button type="button" class="${activeStage === 'STEP_5' ? 'btn-primary' : 'btn-outline'} wip-node-action" id="btn-wip-step5"${isSuperUser ? '' : ' disabled'}>
                ${isSuperUser ? 'Box &amp; seal cartons' : 'Super User only'}
              </button>
            </div>
          </div>

          <!-- REWORK LANE: pairs looping through Alteration -> Inward -> REQ -> Stage 1 -->
          ${(() => {
            const inRepair = scopedDefects
              .filter(d => {
                const st = String((d as any).handoffStage || '');
                if (st) return st === 'PENDING_TAILOR' || st === 'WITH_TAILOR';
                return d.status === 'Pending Tailor' || d.status === 'In Rework' || d.status === 'In Washing' || d.status === 'In Sorting';
              })
              .reduce((sum, d) => sum + Number(d.pairsCount || 0), 0);
            const atInward = scopedDefects
              .filter(d => (d as any).handoffStage === 'RECEIVED_AT_INWARD' || d.status === 'At Inward')
              .reduce((sum, d) => sum + Number(d.pairsCount || 0), 0);
            const reissueRequested = scopedDefects
              .filter(d => (d as any).handoffStage === 'REISSUE_REQUESTED' || d.status === 'Re-Issue Requested')
              .reduce((sum, d) => sum + Number(d.pairsCount || 0), 0);
            const returned = scopedDefects
              .filter(d => (d as any).handoffStage === 'REISSUED_TO_PACKING' || d.status === 'Completed')
              .reduce((sum, d) => sum + Number(d.pairsCount || 0), 0);
            const hasAnyRework = inRepair + atInward + reissueRequested + returned > 0;
            return `
          <div class="wip-rework-lane ${hasAnyRework ? 'has-rework' : ''}" data-testid="wip-rework-lane">
            <span class="wip-rework-arrow" aria-hidden="true">&larr;</span>
            <span class="wip-rework-label">Rework</span>
            ${!hasAnyRework
              ? '<span class="wip-rework-count">No rework for this lot</span>'
              : `<span class="wip-rework-count"><strong id="wip-rework-returned">${returned.toLocaleString()}</strong> returned to stage 1 &middot; <strong id="wip-rework-active">${inRepair.toLocaleString()}</strong> in repair${atInward > 0 ? ` &middot; <strong id="wip-rework-at-inward">${atInward.toLocaleString()}</strong> at Inward` : ''}${reissueRequested > 0 ? ` &middot; <strong id="wip-rework-requested">${reissueRequested.toLocaleString()}</strong> re-issue requested (awaiting Inward)` : ''}</span>`}
            ${atInward > 0 ? `<button type="button" class="btn-primary wip-rework-cta" id="btn-wip-request-rework-reissue" data-req-number="${escapeHtml(baseReq)}">Request re-issue (REQ)</button>` : ''}
          </div>`;
          })()}
        </div>
        `;
        })()}
      </section>

      <!-- Real-Time WIP Analytics Dashboard (Planned Demand vs. Actual Packed Pairs per Active Requisition) -->
      ${(() => {
        const series = buildRequisitionAnalyticsSeries(rollupSummary, baseReq);
        return renderRequisitionWipAnalyticsChart({
          series,
          activeWipSizes: wip.sizes,
          activeSizeFormat: (wip as any).sizeFormat,
          activeSizeCodes: (wip as any).sizeCodes,
          activeReqNumber: baseReq,
          activePlannedQty: wip.plannedQty,
          activeStage4Packed: wip.stage4Passed,
          activeStage5Packed: wip.outputPairs,
          mode: 'packing-hall'
        });
      })()}

      <!-- Split Enterprise Data Grids -->
      <section class="two-column-grid">
        <!-- LEFT: Active Alteration / Rework Loop -->
        <div class="panel-card">
          <div class="panel-card-header">
            <h2 class="panel-card-title" style="margin: 0;">Active Alteration / Repair Loop</h2>
            <span class="panel-counter-badge">${activeAlts.length} Active</span>
          </div>
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Requisition #</th>
                  <th scope="col">Source Stage</th>
                  <th scope="col">Defect Class</th>
                  <th scope="col" class="text-right">Qty</th>
                  <th scope="col">Status</th>
                  <th scope="col">Route</th>
                </tr>
              </thead>
              <tbody>
                ${scopedDefects.length === 0 ? `
                  <tr>
                    <td colspan="6" class="table-empty-cell">No active alterations in queue for ${baseReq}.</td>
                  </tr>
                ` : scopedDefects.slice(0, 5).map(d => `
                  <tr>
                    <td><strong>${d.id}</strong></td>
                    <td>${d.origin}</td>
                    <td>${d.defectClass}</td>
                    <td class="text-right font-bold">${d.qty}</td>
                    <td><span class="status-pill">${d.status}</span></td>
                    <td style="font-size: 11px; color: var(--ink-600);">${escapeHtml(d.route || 'Tailor -> Inward -> REQ -> Stage 1')}</td>
                  </tr>
                `).join('') + (scopedDefects.length > 5 ? `
                  <tr>
                    <td colspan="6" class="table-empty-cell" style="padding: 8px 12px; font-size: 11.5px;">
                      Showing 5 of ${scopedDefects.length} tickets for ${aReq} (+${scopedDefects.length - 5} more in Alteration Bay #2).
                    </td>
                  </tr>
                ` : '')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- RIGHT: Master Shipping Carton Manifest -->
        <div class="panel-card">
          <div class="panel-card-header">
            <h2 class="panel-card-title" style="margin: 0;">Master Shipping Carton Manifest</h2>
            <span class="panel-counter-badge" style="font-variant-numeric: tabular-nums;">
              ${cartons.length} Cartons &bull; ${cartons.reduce((s, c) => s + Number(c.cbm ?? 0.084), 0).toFixed(3)} CBM
            </span>
          </div>
          <div class="table-responsive">
            <table class="data-table">
              <thead>
                <tr>
                  <th scope="col">Carton #</th>
                  <th scope="col" class="text-right">Pairs</th>
                  <th scope="col">Size (cm)</th>
                  <th scope="col" class="text-right">CBM</th>
                  <th scope="col" class="text-center">Mode</th>
                  <th scope="col" class="text-center">Action</th>
                </tr>
              </thead>
              <tbody>
                ${cartons.length === 0 ? `
                  <tr>
                    <td colspan="6" class="table-empty-cell">No cartons logged in manifest.</td>
                  </tr>
                ` : cartons.slice(0, 5).map(c => {
                  const mode = String(c.shippingMode || 'UNASSIGNED').toUpperCase();
                  const modeLabel = mode === 'AIR' ? 'AIR' : mode === 'SEA' ? 'SEA' : 'Ready';
                  const modeClass = mode === 'AIR' || mode === 'SEA' ? 'status-pill status-pill-green' : 'status-pill';
                  return `
                  <tr>
                    <td><strong>${escapeHtml(c.cartonNo)}</strong></td>
                    <td class="text-right" style="font-variant-numeric: tabular-nums;">${c.pairs}</td>
                    <td style="font-variant-numeric: tabular-nums; font-size: 12px;">${escapeHtml(c.dims || '60 × 40 × 35')}</td>
                    <td class="text-right" style="font-variant-numeric: tabular-nums;">${Number(c.cbm ?? 0.084).toFixed(3)}</td>
                    <td class="text-center"><span class="${modeClass}">${modeLabel}</span></td>
                    <td class="text-center" style="white-space: nowrap;">
                      ${mode === 'UNASSIGNED' ? `
                        <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-carton-dispatch-mode="AIR" data-carton-no="${escapeHtml(c.cartonNo)}">Air</button>
                        <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-carton-dispatch-mode="SEA" data-carton-no="${escapeHtml(c.cartonNo)}">Sea</button>
                      ` : `
                        <button type="button" class="btn-outline" style="padding: 2px 8px; font-size: 11px;" data-carton-dispatch-mode="UNASSIGNED" data-carton-no="${escapeHtml(c.cartonNo)}">Reset</button>
                      `}
                    </td>
                  </tr>
                `;}).join('') + (cartons.length > 5 ? `
                  <tr>
                    <td colspan="6" class="table-empty-cell" style="padding: 8px 12px; font-size: 11.5px;">
                      Showing 5 of ${cartons.length} sealed cartons (+${cartons.length - 5} more in manifest).
                    </td>
                  </tr>
                ` : '')}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      <!-- Bottom Enterprise Status Bar -->
      <footer class="portal-footer">
        <div class="footer-stats-left">
          <span>Rolled Yield (RTY): <strong>${escapeHtml(wip.lineEfficiency)}</strong></span>
          <span class="stat-divider">&bull;</span>
          <span>Output: <strong>${wip.outputPairs} Pairs / ${wip.outputCartons} Cartons</strong></span>
          <span class="stat-divider">&bull;</span>
          <span>Volume: <strong style="font-variant-numeric: tabular-nums;">${cartons.reduce((s, c) => s + Number(c.cbm ?? 0.084), 0).toFixed(3)} CBM</strong></span>
          <span class="stat-divider">&bull;</span>
          <span>Split: <strong>Air ${cartons.filter(c => c.shippingMode === 'AIR').reduce((s, c) => s + Number(c.pairs || 0), 0)} / Sea ${cartons.filter(c => c.shippingMode === 'SEA').reduce((s, c) => s + Number(c.pairs || 0), 0)} prs</strong></span>
        </div>
        <div class="footer-actions-right">
          <button class="btn-outline" id="btn-wip-export-shift">Export Shift Log</button>
          <button class="btn-outline" id="btn-wip-print-labels">Print Carton Labels</button>
          ${isSuperUser ? `<button class="btn-primary" id="btn-wip-final-clearance">QC &amp; Dispatch (Super User)</button>` : ''}
        </div>
      </footer>
    </main>
  `;
}
