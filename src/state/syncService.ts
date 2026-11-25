import {
  calculateSizeTotal,
  computeWipRolledYieldPct,
  createEmptySizes,
  formatBatchSequence,
  formatCurrentDateDDMMYYYY,
  getAlterationReqNumber,
  getMaterialReqNumber,
  getPackingFloorActiveReqNumbers,
  getStartupRequisitionNumber,
  normalizeBaseReqNumber,
  OrderWipState,
  STANDARD_GLOVE_SIZES
} from '../utils/requisitionLogic';
import { renderApp } from '../appContext';
import { showToast } from '../utils/domModalsAndPrint';
import type { CartonRecord } from '../types';
import {
  DEFAULT_REQ_NUMBER,
  getOrderSizeCodes,
  getTotalIssuedPairs,
  state
} from './appState';

export function isPersistedRequisition(reqNo: string): boolean {
  return state.persistedReqNumbers.includes(normalizeBaseReqNumber(reqNo));
}

export function computeCartonCbm(dimsStr: string): { normalized: string; cbm: number } {
  const m = String(dimsStr || '60x40x35').match(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/i);
  if (!m) return { normalized: '60 × 40 × 35', cbm: 0.084 };
  const l = Number(m[1]);
  const w = Number(m[2]);
  const h = Number(m[3]);
  if (!Number.isFinite(l) || !Number.isFinite(w) || !Number.isFinite(h) || l <= 0 || w <= 0 || h <= 0) {
    return { normalized: '60 × 40 × 35', cbm: 0.084 };
  }
  return {
    normalized: `${l} × ${w} × ${h}`,
    cbm: Number(((l * w * h) / 1000000).toFixed(4))
  };
}

export function mapServerCartons(serverCartons: any[]): CartonRecord[] {
  if (!Array.isArray(serverCartons)) return [];
  return serverCartons.map((carton: any) => {
    const parsed = computeCartonCbm(carton.dimensions_cm || '60x40x35');
    const rawMode = String(carton.shipping_mode || 'UNASSIGNED').toUpperCase();
    const shippingMode: 'UNASSIGNED' | 'AIR' | 'SEA' =
      rawMode === 'AIR' || rawMode === 'SEA' ? rawMode : 'UNASSIGNED';
    const cbm = carton.cbm != null && Number.isFinite(Number(carton.cbm)) ? Number(carton.cbm) : parsed.cbm;
    return {
      cartonNo: carton.carton_barcode || `CTN-${String(carton.carton_number || 1).padStart(2, '0')}`,
      pairs: Number(carton.pairs_count || 0),
      netWt: `${Number(carton.net_weight_kg || 4.2).toFixed(1)} kg`,
      grossWt: `${Number(carton.gross_weight_kg || 4.8).toFixed(1)} kg`,
      dims: parsed.normalized,
      cbm: Number(cbm.toFixed(4)),
      shippingMode,
      dispatchedAt: carton.dispatched_at || null,
      barcodeVerified: true,
      sealNo: carton.qc_seal_no || carton.carton_barcode || `SEAL-${String(carton.carton_number || 1).padStart(2, '0')}`,
      status: carton.aql_status === 'PASSED'
        ? 'Approved (AQL 1.5)'
        : carton.aql_status === 'REJECTED'
          ? 'Quarantined (AQL 1.5)'
          : (carton.status || 'PACKED')
    };
  });
}

export function applyServerRequisition(
  requisition: any,
  forceActive = false
): typeof state.packingWip & OrderWipState {
  const mapped = mapServerRequisitionToWip(requisition);
  const reqNumber = normalizeBaseReqNumber(mapped.reqNumber);
  state.ordersWipMap[reqNumber] = mapped;
  if (
    forceActive ||
    normalizeBaseReqNumber(state.packingWip.selectedBatch) === reqNumber ||
    state.packingWip.selectedBatch === DEFAULT_REQ_NUMBER
  ) {
    state.packingWip = JSON.parse(JSON.stringify(mapped));
    state.cartons = Array.isArray((mapped as any).cartons)
      ? JSON.parse(JSON.stringify((mapped as any).cartons))
      : [];
    state.qcChecklist.forEach(c => (c.passed = Boolean(state.packingWip.finalQcApproved)));
  }
  return mapped;
}

export async function postWipStageUpdate(
  reqNo: string,
  stagePath: string,
  payload: Record<string, unknown>,
  failureMessage: string
): Promise<boolean> {
  try {
    const response = await fetch(`/api/wip/${encodeURIComponent(reqNo)}/${stagePath}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok || !result.success || !result.data) {
      showToast(result.error || failureMessage);
      return false;
    }
    applyServerRequisition(result.data, true);
    return true;
  } catch (error) {
    console.error(`WIP stage ${stagePath} save failed:`, error);
    showToast(failureMessage);
    return false;
  }
}

// Helper to persist current WIP state into ordersWipMap
export function saveCurrentOrderWipState(): void {
  const req = normalizeBaseReqNumber(state.packingWip.selectedBatch);
  (state.packingWip as any).cartons = JSON.parse(JSON.stringify(state.cartons));
  state.ordersWipMap[req] = JSON.parse(JSON.stringify(state.packingWip));
}

export function mapServerRequisitionToWip(requisition: any): typeof state.packingWip & OrderWipState {
  const reqNumber = normalizeBaseReqNumber(requisition.req_number || requisition.reqNumber);
  const order = state.pendingOrders.find(item => item.orderId === requisition.order_id);
  const wip = requisition.wip || {};
  const resolvedFormat = requisition.sizeFormat || requisition.effective_size_format || order?.sizeFormat || 'LEGACY_7_11';
  const resolvedCodes = Array.isArray(requisition.sizeCodes) && requisition.sizeCodes.length > 0
    ? requisition.sizeCodes
    : getOrderSizeCodes(requisition.order_id, order?.sizeCodes, resolvedFormat);
  const sizes = { ...createEmptySizes(resolvedCodes), ...(requisition.sizes || {}) };
  const plannedQty = Number(requisition.requested_pairs || 0);
  const stage1In = Number(wip.step1_checking_in || 0);
  const stage1Passed = Number(wip.step1_checking_good || 0);
  const stage1Defects = Number(wip.step1_checking_defects || 0);
  const stage2In = Number(wip.step2_ironing_in || 0);
  const stage2Passed = Number(wip.step2_ironing_good || 0);
  const stage2Defects = Number(wip.step2_ironing_defects || 0);
  const stage3In = Number(wip.step3_matching_in || 0);
  const stage3Passed = Number(wip.step3_matching_good || 0);
  const stage3Defects = Number(wip.step3_matching_defects || 0);
  const stage4In = stage3Passed;
  const stage4Passed = Number(wip.step4_packing_good || 0);
  const stage5Cartons = Number(wip.step5_cartons_packed || 0);
  const stage5Pairs = Number(wip.step5_pairs_packed || 0);
  const issued = ['ISSUED', 'IN_PROGRESS', 'COMPLETED', 'DISPATCHED'].includes(requisition.status);
  const alterations = Array.isArray(requisition.alterations) ? requisition.alterations : [];
  const inAlteration = alterations.reduce(
    (sum: number, alt: any) => (alt.status === 'SENT_FOR_ALTERATION' && !alt.is_scrapped ? sum + Number(alt.pairs_count || 0) : sum),
    0
  );
  const reworkAtInwardPairs = alterations.reduce(
    (sum: number, alt: any) =>
      alt.status === 'SENT_FOR_ALTERATION' && !alt.is_scrapped && alt.handoff_stage === 'RECEIVED_AT_INWARD'
        ? sum + Number(alt.pairs_count || 0)
        : sum,
    0
  );
  const reworkReissueRequestedPairs = alterations.reduce(
    (sum: number, alt: any) =>
      alt.status === 'SENT_FOR_ALTERATION' && !alt.is_scrapped && alt.handoff_stage === 'REISSUE_REQUESTED'
        ? sum + Number(alt.pairs_count || 0)
        : sum,
    0
  );
  const scrappedPairs = alterations.reduce(
    (sum: number, alt: any) => (alt.is_scrapped ? sum + Number(alt.pairs_count || 0) : sum),
    0
  );
  const mappedCartons = mapServerCartons(requisition.cartons);

  return {
    reqNumber,
    selectedBatch: reqNumber,
    wipBatch: reqNumber,
    parentOrderId: requisition.order_id || '',
    grnRef: '',
    article: requisition.product_name || order?.article || '',
    po: order?.po || '',
    maker: order?.maker || '',
    buyer: order?.buyer || '',
    plannedQty,
    issueStatus: issued ? 'Issued by Inward Register' : 'Pending Inward Issue',
    sizeFormat: resolvedFormat,
    sizeCodes: resolvedCodes,
    sizes,
    stage1In,
    stage1Passed,
    stage1Defects,
    stage2In,
    stage2Passed,
    stage2Defects,
    stage3In,
    stage3Passed,
    stage3Defects,
    mreqNo: getMaterialReqNumber(reqNumber),
    matReqNumber: requisition.materialReq?.mat_req_number || '',
    altReqNo: getAlterationReqNumber(reqNumber),
    mreqQty: `${stage3Passed} Sets`,
    mreqCoveredPairs: Number(requisition.materialReqCoveredPairs || 0),
    mreqIssuedPairs: Number(requisition.materialReqIssuedPairs || 0),
    mreqStatus: Number(wip.step4_materials_issued || 0) === 1
      ? 'ISSUED'
      : (requisition.materialReq?.status || (stage3Passed > 0 ? 'Ready' : 'Pending Stage 3')),
    stage4In,
    stage4Passed,
    stage4Pending: Math.max(0, stage4In - stage4Passed),
    stage5Cartons: `${stage5Cartons} Cartons (${stage5Pairs} Prs)`,
    stage5Pending: `${Math.max(0, Math.ceil(stage4Passed / 30) - stage5Cartons)} Cartons`,
    lineEfficiency: computeWipRolledYieldPct({
      stage1Passed,
      stage1Defects,
      stage2Passed,
      stage2Defects,
      stage3Passed,
      stage3Defects
    }),
    outputPairs: stage5Pairs,
    outputCartons: stage5Cartons,
    inAlteration,
    reworkAtInwardPairs,
    reworkReissueRequestedPairs,
    scrappedPairs,
    finalQcApproved: wip.final_qc_status === 'APPROVED_DISPATCH',
    reqStatus: requisition.status || 'ISSUED',
    cartons: mappedCartons
  } as any;
}

// Helper to switch active order and restore its exact stage progress
export function switchActiveOrder(targetReq: string): void {
  const norm = normalizeBaseReqNumber(targetReq);
  saveCurrentOrderWipState();

  if (state.ordersWipMap[norm]) {
    state.packingWip = JSON.parse(JSON.stringify(state.ordersWipMap[norm]));
    state.cartons = Array.isArray((state.ordersWipMap[norm] as any).cartons)
      ? JSON.parse(JSON.stringify((state.ordersWipMap[norm] as any).cartons))
      : [];
  } else {
    state.packingWip.selectedBatch = norm;
    state.packingWip.wipBatch = norm;
    state.packingWip.mreqNo = getMaterialReqNumber(norm);
    state.packingWip.altReqNo = getAlterationReqNumber(norm);
    state.cartons = [];
  }
  state.qcChecklist.forEach(c => (c.passed = Boolean(state.packingWip.finalQcApproved)));
  state.repairForm.batchId = getAlterationReqNumber(norm);
}

export function applyDropdownsPayload(data: any): void {
  if (!data) return;
  if (Array.isArray(data.makers)) state.dropdownOptions.makers = data.makers;
  if (Array.isArray(data.externalMakers)) state.dropdownOptions.externalMakers = data.externalMakers;
  if (Array.isArray(data.customers)) state.dropdownOptions.customers = data.customers;
  if (Array.isArray(data.articles)) state.dropdownOptions.articles = data.articles;
  if (Array.isArray(data.poList)) state.dropdownOptions.poList = data.poList;
  if (Array.isArray(data.halls)) state.dropdownOptions.halls = data.halls;
  if (Array.isArray(data.sizeStandards) && data.sizeStandards.length > 0) {
    state.adminOverview.sizeStandards = data.sizeStandards;
  }
}

export function applyReceivingsPayload(rows: any[]): void {
  if (!Array.isArray(rows) || rows.length === 0) return;
  state.grnList = rows.map((r: any, idx: number) => {
    const rawSizeRows = Array.isArray(r.sizes) ? r.sizes : [];
    const derivedCodes = rawSizeRows
      .map((sr: any) => String(sr.size_code || '').trim())
      .filter(Boolean);
    const activeCodes = derivedCodes.length > 0 ? derivedCodes : [...STANDARD_GLOVE_SIZES];
    const sizes = createEmptySizes(activeCodes);
    for (const sizeRow of rawSizeRows) {
      const sizeCode = String(sizeRow.size_code || '').trim();
      if (sizeCode) {
        sizes[sizeCode] = Number(sizeRow.rcvd_pairs) || 0;
      }
    }
    const isVoided = Boolean(r.is_voided);
    return {
      sr: r.id || (idx + 1),
      grnCode: r.rcv_number || formatBatchSequence('GRN', r.id || (idx + 1)),
      date: r.rcv_date || formatCurrentDateDDMMYYYY(),
      pendingOrderId: r.order_id || r.po_number || 'ORD-INWARD',
      maker: r.maker_contractor,
      hallName: r.hall_name || '',
      stitcherName: r.stitcher_name || '',
      receivingNote: r.receiving_note || '',
      article: r.article_name,
      color: r.color_shade || 'Standard',
      receivedFrom: r.received_from || r.maker_contractor || '',
      rcvdPairs: Number(r.rcvd_pairs) || 0,
      sizeFormat: activeCodes.every((c: string) => ['7', '8', '9', '10', '11'].includes(c)) ? 'LEGACY_7_11' : 'CATALOG',
      sizeCodes: activeCodes,
      sizes,
      status: isVoided ? 'VOIDED' : 'Received',
      isVoided,
      voidReason: r.void_reason || undefined
    };
  });
}

export function applyAlterationsPayload(rows: any[]): void {
  if (!Array.isArray(rows)) return;
  state.dropdownOptions.defectBatchIds = Array.from(new Set(rows.map((alt: any) =>
    getAlterationReqNumber(alt.req_number || state.packingWip.selectedBatch)
  )));
  state.defectList = rows.map((alt: any) => {
    const rawTailor = String(alt.tailor_name || '').trim();
    const isScrapped = Boolean(alt.is_scrapped) || alt.handoff_stage === 'SCRAPPED';
    const handoffStage = String(
      alt.handoff_stage ||
      (isScrapped
        ? 'SCRAPPED'
        : alt.status === 'RETURNED_TO_CHECKING'
          ? 'REISSUED_TO_PACKING'
          : (alt.tailor_assigned || (rawTailor && rawTailor !== 'Supervisor A'))
            ? 'WITH_TAILOR'
            : 'PENDING_TAILOR')
    );
    const tailorAssigned = Boolean(alt.tailor_assigned) || handoffStage !== 'PENDING_TAILOR';
    const tailor = tailorAssigned ? rawTailor : '';
    const status =
      handoffStage === 'SCRAPPED' ? 'Scrapped'
      : handoffStage === 'REISSUED_TO_PACKING' ? 'Completed'
      : handoffStage === 'RECEIVED_AT_INWARD' ? 'At Inward'
      : handoffStage === 'REISSUE_REQUESTED' ? 'Re-Issue Requested'
      : handoffStage === 'WITH_TAILOR' ? 'In Rework'
      : 'Pending Tailor';
    const route =
      handoffStage === 'SCRAPPED' ? 'Scrap Ledger'
      : handoffStage === 'REISSUED_TO_PACKING' ? 'Re-issued to Stage 1 Checking'
      : handoffStage === 'REISSUE_REQUESTED' ? 'Inward Register REQ Queue -> Stage 1'
      : handoffStage === 'RECEIVED_AT_INWARD' ? 'At Inward Register -> Packing Hall REQ'
      : handoffStage === 'WITH_TAILOR' ? 'With Tailor -> Inward Register'
      : 'Assign Tailor -> Inward Register';

    return {
      altId: Number(alt.id) || undefined,
      id: getAlterationReqNumber(alt.req_number || state.packingWip.selectedBatch),
      reqNumber: alt.req_number || undefined,
      orderId: alt.order_id || undefined,
      pairsCount: Number(alt.pairs_count || 0),
      rawStatus: alt.status || undefined,
      handoffStage,
      tailorAssigned,
      date: alt.sent_at ? alt.sent_at.split(' ')[0] : formatCurrentDateDDMMYYYY(),
      origin: (alt.source_stage || 'Step 1').replace(/_/g, ' '),
      article: alt.product_name || '---',
      po: alt.req_number || '---',
      defectClass: alt.defect_reason || 'Workmanship Defect',
      qty: `${alt.pairs_count} Prs`,
      tailor,
      status,
      route,
      actionText: handoffStage === 'REISSUED_TO_PACKING' ? 'Verified' : 'Update'
    };
  });
}

// Dynamic backend SQLite synchronization (parallel fetch + catalog caching)
export async function syncBackendData(options: { manual?: boolean; forceCatalog?: boolean } = {}): Promise<void> {
  const isInitial = !state.hasCompletedInitialSync;
  const isManual = Boolean(options.manual);
  const role = state.currentUser?.role || '';
  const syncFailures: string[] = [];

  if (isInitial) state.isInitialSyncing = true;
  if (isManual) state.isManualSync = true;
  if (isInitial || isManual) {
    state.syncError = '';
    renderApp({ preserveInitialSyncDrafts: isInitial });
  }

  try {
    const needCatalog = Boolean(options.forceCatalog)
      || state.adminOverview.products.length === 0
      || state.adminOverview.customers.length === 0;
    const prevCatalog = {
      customers: state.adminOverview.customers,
      products: state.adminOverview.products,
      sizeStandards: state.adminOverview.sizeStandards
    };

    const syncTasks: Array<Promise<void>> = [];

    if (role !== 'SUPER_USER' && role !== 'INWARD_CLERK' && state.adminOverview.sizeStandards.length === 0) {
      syncTasks.push((async () => {
        try {
          const ssRes = await fetch('/api/size-standards');
          if (ssRes.ok) {
            const ssJson = await ssRes.json();
            if (ssJson.success && Array.isArray(ssJson.data)) {
              state.adminOverview.sizeStandards = ssJson.data;
            }
          }
        } catch (e) {
          console.debug('Size standards sync offline:', e);
        }
      })());
    }

    if (role === 'INWARD_CLERK' || role === 'ALTERATION_LEAD') {
      syncTasks.push((async () => {
        try {
          const res = await fetch('/api/store/dropdowns');
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.data) applyDropdownsPayload(json.data);
          } else if (res.status !== 403) {
            syncFailures.push('dropdowns');
          }
        } catch (e) {
          console.debug('Dropdown sync offline:', e);
          syncFailures.push('dropdowns');
        }
      })());
    }

    if (role === 'INWARD_CLERK') {
      syncTasks.push((async () => {
        try {
          const res = await fetch('/api/store/receivings');
          if (res.ok) {
            const json = await res.json();
            if (json.success && Array.isArray(json.data)) applyReceivingsPayload(json.data);
          } else if (res.status !== 403) {
            syncFailures.push('receivings');
          }
        } catch (e) {
          console.debug('Receivings sync offline:', e);
          syncFailures.push('receivings');
        }
      })());
    }

    if (role === 'ALTERATION_LEAD' || role === 'INWARD_CLERK' || role === 'PACKING_SUPERVISOR') {
      syncTasks.push((async () => {
        try {
          const res = await fetch('/api/alterations');
          if (res.ok) {
            const json = await res.json();
            if (json.success && Array.isArray(json.data)) applyAlterationsPayload(json.data);
          } else if (res.status !== 403) {
            syncFailures.push('alterations');
          }
        } catch (e) {
          console.debug('Alterations sync offline:', e);
          syncFailures.push('alterations');
        }
      })());
    }

    if (role === 'SUPER_USER') {
      syncTasks.push((async () => {
        try {
          const usersResponse = await fetch('/api/admin/users');
          const usersResult = await usersResponse.json();
          if (!usersResponse.ok || !usersResult.success || !Array.isArray(usersResult.data)) {
            throw new Error(usersResult.error || 'Unable to load system users.');
          }
          state.systemUsers = usersResult.data;
        } catch (e) {
          console.warn('MES user list sync failed:', e);
          syncFailures.push('orders');
        }
      })());

      syncTasks.push((async () => {
        try {
          const overviewUrl = needCatalog ? '/api/admin/overview' : '/api/admin/overview?includeCatalog=0';
          const res = await fetch(overviewUrl);
          if (res.ok) {
            const json = await res.json();
            if (json.success && json.data) {
              const overview = json.data;
              state.adminOverview = {
                ...overview,
                customers: Array.isArray(overview.customers) ? overview.customers : prevCatalog.customers,
                products: Array.isArray(overview.products) ? overview.products : prevCatalog.products,
                sizeStandards: Array.isArray(overview.sizeStandards) ? overview.sizeStandards : prevCatalog.sizeStandards
              };
              if (Array.isArray(overview.pendingOrders)) {
                state.pendingOrders = overview.pendingOrders;
              }
              if (overview.dropdowns) applyDropdownsPayload(overview.dropdowns);
              if (Array.isArray(overview.receivings)) applyReceivingsPayload(overview.receivings);
              if (Array.isArray(overview.alterations)) applyAlterationsPayload(overview.alterations);
            }
          } else {
            syncFailures.push('admin overview');
          }
        } catch (e) {
          console.warn('MES overview sync failed:', e);
          syncFailures.push('orders');
        }
      })());
    } else if (role === 'INWARD_CLERK' || role === 'PACKING_SUPERVISOR') {
      syncTasks.push((async () => {
        try {
          const pendingResponse = await fetch('/api/admin/pending-orders');
          const pendingResult = await pendingResponse.json();
          if (!pendingResponse.ok || !pendingResult.success || !Array.isArray(pendingResult.data)) {
            throw new Error(pendingResult.error || 'Unable to load pending orders.');
          }
          state.pendingOrders = pendingResult.data;
        } catch (e) {
          console.warn('MES pending orders sync failed:', e);
          syncFailures.push('orders');
        }
      })());
    }

    if (['SUPER_USER', 'INWARD_CLERK', 'PACKING_SUPERVISOR'].includes(role)) {
      syncTasks.push((async () => {
        try {
          const response = await fetch('/api/requisitions');
          const result = await response.json();
          if (!response.ok || !result.success || !Array.isArray(result.data)) {
            throw new Error(result.error || 'Unable to load requisitions.');
          }

          const linkedRequisitions = result.data.filter((requisition: any) =>
            requisition.order_id && Number(requisition.is_voided || 0) === 0
          );
          state.persistedReqNumbers = linkedRequisitions.map((requisition: any) =>
            normalizeBaseReqNumber(requisition.req_number)
          );
          for (const requisition of linkedRequisitions) {
            const reqNumber = normalizeBaseReqNumber(requisition.req_number);
            state.ordersWipMap[reqNumber] = mapServerRequisitionToWip(requisition);
          }
          state.issuedPairsTotal = getTotalIssuedPairs();

          const selectedReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
          const hasExplicitSelection = Boolean(
            state.packingWip.parentOrderId || Number(state.packingWip.plannedQty || 0) > 0
          );
          const activeFloorReqNumbers = getPackingFloorActiveReqNumbers(state.ordersWipMap);
          const startupReqNumber = getStartupRequisitionNumber(
            selectedReq,
            state.packingWip,
            activeFloorReqNumbers
          );
          const refreshReq = hasExplicitSelection
            ? (selectedReq && state.ordersWipMap[selectedReq] ? selectedReq : '')
            : (startupReqNumber || '');
          if (refreshReq && state.ordersWipMap[refreshReq]) {
            state.packingWip = JSON.parse(JSON.stringify(state.ordersWipMap[refreshReq]));
            state.cartons = Array.isArray((state.ordersWipMap[refreshReq] as any).cartons)
              ? JSON.parse(JSON.stringify((state.ordersWipMap[refreshReq] as any).cartons))
              : [];
            state.qcChecklist.forEach(c => (c.passed = Boolean(state.packingWip.finalQcApproved)));
          }
        } catch (error) {
          console.warn('Requisition sync failed:', error);
          syncFailures.push('requisitions');
        }
      })());
    }

    syncTasks.push((async () => {
      try {
        const stampRes = await fetch('/api/sync/stamp');
        if (stampRes.ok) {
          const stampJson = await stampRes.json();
          if (stampJson?.success && typeof stampJson.data?.stamp === 'string') {
            lastSyncStamp = stampJson.data.stamp;
          }
        }
      } catch {
        // Ignore offline stamp fetch
      }
    })());

    await Promise.all(syncTasks);

    if (state.grnList.length > 0 && state.pendingOrders.length > 0) {
      state.grnList = state.grnList.map(grn => {
        const linked = state.pendingOrders.find(o => o.orderId === grn.pendingOrderId);
        if (!linked) return grn;
        const sizeFormat = linked.sizeFormat || grn.sizeFormat || 'LEGACY_7_11';
        const sizeCodes = linked.sizeCodes?.length ? linked.sizeCodes : grn.sizeCodes;
        return {
          ...grn,
          sizeFormat,
          sizeCodes
        };
      });
    }

    state.syncError = syncFailures.length > 0
      ? `Unable to synchronize server data (${Array.from(new Set(syncFailures)).join(', ')}). Check your connection and retry.`
      : '';
  } finally {
    state.hasCompletedInitialSync = true;
    state.isInitialSyncing = false;
    state.isManualSync = false;
    renderApp({ preserveInitialSyncDrafts: isInitial });
  }
}

let lastSyncStamp = '';
let silentPollTimer: number | null = null;
let silentPollInFlight = false;
let visibilityListenerAttached = false;

function getPendingRequisitionSet(): Set<string> {
  const result = new Set<string>();
  for (const [reqKey, item] of Object.entries(state.ordersWipMap || {})) {
    if (!item || (item as any).isVoided) continue;
    const planned = Number((item as any).plannedQty || calculateSizeTotal((item as any).sizes) || 0);
    if (planned > 0 && (item as any).issueStatus !== 'Issued by Inward Register') {
      result.add(normalizeBaseReqNumber(reqKey));
    }
  }
  return result;
}

function getIssuedRequisitionSet(): Set<string> {
  const result = new Set<string>();
  for (const [reqKey, item] of Object.entries(state.ordersWipMap || {})) {
    if (!item || (item as any).isVoided) continue;
    if ((item as any).issueStatus === 'Issued by Inward Register') {
      result.add(normalizeBaseReqNumber(reqKey));
    }
  }
  return result;
}

/**
 * Poll `/api/sync/stamp` first and run lightweight delta fetches ONLY when handoff state
 * actually changed on the server, leaving forms, focus, and modals undisturbed when idle.
 */
export async function silentRefreshHandoffs(options: { force?: boolean } = {}): Promise<boolean> {
  if (typeof document === 'undefined' || typeof window === 'undefined') return false;
  if (document.hidden) return false;
  if (state.authMode !== 'ready' || !state.currentUser || !state.hasCompletedInitialSync) return false;
  if (state.isInitialSyncing || state.isManualSync || silentPollInFlight) return false;
  if (state.activeScreen !== 'screen-grn' && state.activeScreen !== 'screen-packing') return false;
  if (document.querySelector('#global-modal.open')) return false;

  const role = state.currentUser.role;
  const activeScreen = state.activeScreen;
  silentPollInFlight = true;
  try {
    const stampRes = await fetch('/api/sync/stamp');
    if (!stampRes.ok) return false;
    const stampJson = await stampRes.json();
    const nextStamp = stampJson?.success && typeof stampJson.data?.stamp === 'string'
      ? stampJson.data.stamp
      : '';
    if (!nextStamp) return false;
    if (!options.force && lastSyncStamp && nextStamp === lastSyncStamp) return false;
    if (!lastSyncStamp && !options.force) {
      lastSyncStamp = nextStamp;
      return false;
    }

    const prevPendingReqs = getPendingRequisitionSet();
    const prevIssuedReqs = getIssuedReqsSnapshot();
    const prevUnclaimedDockTotal = (state.pendingOrders || []).reduce(
      (sum, o) => sum + Number((o as any).unclaimedDockPairs || 0),
      0
    );
    const prevReworkRequestedCount = (state.defectList || []).filter(
      (d: any) => d.handoffStage === 'REISSUE_REQUESTED' || d.status === 'Re-Issue Requested'
    ).length;

    const deltaTasks: Array<Promise<void>> = [];

    if (['SUPER_USER', 'INWARD_CLERK', 'PACKING_SUPERVISOR'].includes(role)) {
      deltaTasks.push((async () => {
        try {
          const ordersRes = await fetch('/api/admin/pending-orders');
          if (ordersRes.ok) {
            const ordersJson = await ordersRes.json();
            if (ordersJson?.success && Array.isArray(ordersJson.data)) {
              state.pendingOrders = ordersJson.data;
            }
          }
        } catch {
          // Keep existing pendingOrders on transient error
        }
      })());

      deltaTasks.push((async () => {
        try {
          const reqRes = await fetch('/api/requisitions');
          if (reqRes.ok) {
            const reqJson = await reqRes.json();
            if (reqJson?.success && Array.isArray(reqJson.data)) {
              const linked = reqJson.data.filter(
                (r: any) => r.order_id && Number(r.is_voided || 0) === 0
              );
              state.persistedReqNumbers = linked.map((r: any) => normalizeBaseReqNumber(r.req_number));
              const nextMap: Record<string, any> = {};
              for (const reqItem of linked) {
                const reqNo = normalizeBaseReqNumber(reqItem.req_number);
                nextMap[reqNo] = mapServerRequisitionToWip(reqItem);
              }
              state.ordersWipMap = nextMap;
              state.issuedPairsTotal = getTotalIssuedPairs();

              const selectedReq = normalizeBaseReqNumber(state.packingWip.selectedBatch);
              const curWip = nextMap[selectedReq];
              if (curWip) {
                state.packingWip = JSON.parse(JSON.stringify(curWip));
                state.cartons = Array.isArray((curWip as any).cartons)
                  ? JSON.parse(JSON.stringify((curWip as any).cartons))
                  : [];
                state.qcChecklist.forEach(c => (c.passed = Boolean(state.packingWip.finalQcApproved)));
              }
            }
          }
        } catch {
          // Keep existing requisitions on transient error
        }
      })());
    }

    if (['SUPER_USER', 'INWARD_CLERK', 'PACKING_SUPERVISOR', 'ALTERATION_LEAD'].includes(role)) {
      deltaTasks.push((async () => {
        try {
          const altRes = await fetch('/api/alterations');
          if (altRes.ok) {
            const altJson = await altRes.json();
            if (altJson?.success && Array.isArray(altJson.data)) {
              applyAlterationsPayload(altJson.data);
            }
          }
        } catch {
          // Ignore transient failure
        }
      })());
    }

    if (activeScreen === 'screen-grn' && (role === 'INWARD_CLERK' || role === 'SUPER_USER')) {
      deltaTasks.push((async () => {
        try {
          const rcvRes = await fetch('/api/store/receivings');
          if (rcvRes.ok) {
            const rcvJson = await rcvRes.json();
            if (rcvJson?.success && Array.isArray(rcvJson.data)) {
              applyReceivingsPayload(rcvJson.data);
            }
          }
        } catch {
          // Ignore transient failure
        }
      })());
    }

    await Promise.all(deltaTasks);

    if (state.grnList.length > 0 && state.pendingOrders.length > 0) {
      state.grnList = state.grnList.map(grn => {
        const linked = state.pendingOrders.find(o => o.orderId === grn.pendingOrderId);
        if (!linked) return grn;
        return {
          ...grn,
          sizeFormat: linked.sizeFormat || grn.sizeFormat || 'LEGACY_7_11',
          sizeCodes: linked.sizeCodes?.length ? linked.sizeCodes : grn.sizeCodes
        };
      });
    }

    const nextPendingReqs = getPendingRequisitionSet();
    const newPending = Array.from(nextPendingReqs).filter(r => !prevPendingReqs.has(r));
    if (activeScreen === 'screen-grn' && newPending.length > 0) {
      const curSelected = normalizeBaseReqNumber(state.packingWip.selectedBatch);
      const curItem = state.ordersWipMap[curSelected];
      const curIsPending = Boolean(
        curItem &&
        !(curItem as any).isVoided &&
        (curItem as any).issueStatus !== 'Issued by Inward Register' &&
        Number((curItem as any).plannedQty || calculateSizeTotal((curItem as any).sizes) || 0) > 0
      );
      if (!curIsPending && state.ordersWipMap[newPending[0]]) {
        state.packingWip = JSON.parse(JSON.stringify(state.ordersWipMap[newPending[0]]));
      }
    }

    const nextIssuedReqs = getIssuedRequisitionSet();
    const newlyIssued = Array.from(nextIssuedReqs).filter(r => !prevIssuedReqs.has(r));
    const nextUnclaimedDockTotal = (state.pendingOrders || []).reduce(
      (sum, o) => sum + Number((o as any).unclaimedDockPairs || 0),
      0
    );
    const nextReworkRequestedCount = (state.defectList || []).filter(
      (d: any) => d.handoffStage === 'REISSUE_REQUESTED' || d.status === 'Re-Issue Requested'
    ).length;

    lastSyncStamp = nextStamp;
    if (document.querySelector('#global-modal.open')) return false;

    renderApp({ preserveInitialSyncDrafts: true });

    if (activeScreen === 'screen-grn') {
      if (newPending.length > 0) {
        showToast(`New Packing Hall requisition: ${newPending.join(', ')}`);
      } else if (nextReworkRequestedCount > prevReworkRequestedCount) {
        showToast('Packing Hall requested rework re-issue.');
      }
    } else if (activeScreen === 'screen-packing') {
      if (newlyIssued.length > 0) {
        showToast(`Inward Register issued ${newlyIssued.join(', ')} — ready for Stage 1.`);
      } else if (nextUnclaimedDockTotal > prevUnclaimedDockTotal) {
        showToast('New stock received at Inward Dock.');
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    silentPollInFlight = false;
  }

  function getIssuedReqsSnapshot(): Set<string> {
    return getIssuedRequisitionSet();
  }
}

export function startSilentHandoffPolling(): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (silentPollTimer !== null) {
    window.clearInterval(silentPollTimer);
    silentPollTimer = null;
  }
  const configuredMs = Number((window as any).__MES_SILENT_POLL_MS);
  const intervalMs = Number.isFinite(configuredMs) && configuredMs > 0
    ? Math.max(250, configuredMs)
    : 15000;
  silentPollTimer = window.setInterval(() => {
    void silentRefreshHandoffs();
  }, intervalMs);

  if (!visibilityListenerAttached) {
    visibilityListenerAttached = true;
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        void silentRefreshHandoffs();
      }
    });
  }
}

export function stopSilentHandoffPolling(): void {
  if (typeof window !== 'undefined' && silentPollTimer !== null) {
    window.clearInterval(silentPollTimer);
  }
  silentPollTimer = null;
  silentPollInFlight = false;
  lastSyncStamp = '';
}
