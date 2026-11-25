import {
  SizeBreakdown,
  PendingOrder,
  HallWithStitchers,
  STANDARD_GLOVE_SIZES,
  AuditTrailEntry,
  createAuditTrailEntry,
  createEmptySizes,
  getMaterialReqNumber,
  getAlterationReqNumber,
  calculateSizeTotal,
  OrderWipState,
  normalizeBaseReqNumber,
  buildSuperUserOrderRollups,
  getScaleSizeCodes,
  SizeStandardOption
} from '../utils/requisitionLogic';
import type {
  SuperUserTab,
  SuperUserReportType,
  SystemUserRecord,
  AdminOrderArticleLine
} from '../components/superUserView';
import type {
  GRNRecord,
  DefectRecord,
  CartonRecord,
  GrnRemainingCaps
} from '../types';

export const DEFAULT_REQ_NUMBER = 'REQ-0001';
export const SAVED_TAILORS_STORAGE_KEY = 'hammad-industries-saved-tailors';

/** Build a blank REQ-0001 Packing Hall WIP state without stale order/article/size fields. */
export function createEmptyPackingWipState() {
  return {
    selectedBatch: DEFAULT_REQ_NUMBER,
    parentOrderId: '',
    po: '',
    article: '',
    plannedQty: 0,
    issueStatus: 'Pending Inward Issue' as 'Pending Inward Issue' | 'Issued by Inward Register',
    sizeFormat: 'LEGACY_7_11',
    sizeCodes: [...STANDARD_GLOVE_SIZES] as string[],
    sizes: createEmptySizes(),
    wipBatch: DEFAULT_REQ_NUMBER,
    stage1In: 0,
    stage1Passed: 0,
    stage1Defects: 0,
    stage2In: 0,
    stage2Passed: 0,
    stage2Defects: 0,
    stage3In: 0,
    stage3Passed: 0,
    stage3Defects: 0,
    mreqNo: getMaterialReqNumber(DEFAULT_REQ_NUMBER),
    altReqNo: getAlterationReqNumber(DEFAULT_REQ_NUMBER),
    mreqQty: '0 Sets',
    mreqStatus: 'Pending Stage 3',
    mreqCoveredPairs: 0,
    mreqIssuedPairs: 0,
    stage4In: 0,
    stage4Passed: 0,
    stage4Pending: 0,
    stage5Cartons: '0 Cartons (0 Prs)',
    stage5Pending: '0 Cartons',
    lineEfficiency: '0.0%',
    outputPairs: 0,
    outputCartons: 0,
    inAlteration: 0,
    scrappedPairs: 0,
    finalQcApproved: false
  };
}

export function loadSavedTailors(): string[] {
  try {
    const stored = window.localStorage.getItem(SAVED_TAILORS_STORAGE_KEY);
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    if (!Array.isArray(parsed)) {
      console.warn('Saved tailor list is not an array; ignoring stored value.');
      return [];
    }
    return Array.from(new Set(parsed
      .filter((name): name is string => typeof name === 'string')
      .map(name => name.trim())
      .filter(Boolean)));
  } catch (error) {
    console.warn('Unable to load saved tailor names:', error);
    return [];
  }
}

// Clean Initial State (All mockup records removed; ready for real data entry)
export const state = {
  activeScreen: 'screen-grn',
  authMode: 'checking' as 'checking' | 'setup' | 'login' | 'ready' | 'error',
  authError: '',
  currentUser: null as SystemUserRecord | null,
  hasCompletedInitialSync: false,
  isInitialSyncing: false,
  isManualSync: false,
  syncError: '',

  // Clean Data Stores
  grnList: [] as GRNRecord[],
  defectList: [] as DefectRecord[],
  cartons: [] as CartonRecord[],
  issuedPairsTotal: 0,
  inwardShowIssuedQueue: false,

  // Pending Orders created by Super User & stored in SQLite database (selectable on Inward Slip to auto-fill Maker & Article)
  pendingOrders: [] as PendingOrder[],

  // QC Checklist with clean default unverified states
  qcChecklist: [
    { id: 'chk-1', title: 'Visual Appearance & Cleanliness', details: 'Check 80 samples for visual defects', passed: false },
    { id: 'chk-2', title: 'Dimension & Sizing Tolerances', details: 'Tolerance check according to spec sheet', passed: false },
    { id: 'chk-3', title: 'Barcode EAN-13 Scannability Test', details: 'Direct scan confirmation of 80 master cartons', passed: false },
    { id: 'chk-4', title: 'Polybag Sealing & Silica Sachet', details: 'Verification of moisture barrier packaging', passed: false },
    { id: 'chk-5', title: 'Master Carton 5-Drop Impact Test', details: 'ISTA drop standard compliance verification', passed: false }
  ],

  // Form input clean states (Front person only enters received pairs + Received From + selects Pending Order)
  grnForm: {
    pendingOrderId: '',
    maker: '',
    hallName: '',
    stitcherName: '',
    article: '',
    color: '',
    receivedFrom: '',
    rcvdPairs: '',
    sizeFormat: 'LEGACY_7_11',
    sizeCodes: undefined as string[] | undefined,
    sizes: createEmptySizes(),
    splitRows: [] as Array<{
      maker: string;
      hallName?: string;
      stitcherName?: string;
      receivedFrom: string;
      sizes: SizeBreakdown;
    }>
  },

  repairForm: {
    batchId: getAlterationReqNumber(DEFAULT_REQ_NUMBER),
    article: '',
    po: '',
    defectType: '',
    tailor: '',
    qty: ''
  },
  savedTailors: loadSavedTailors(),

  qcOrder: {
    po: '',
    article: '',
    orderTotal: '',
    lotCartons: '0',
    lotPairs: '0',
    netWt: '0.0',
    grossWt: '0.0',
    inspectorName: 'Unassigned',
    qcId: '---',
    container: '---'
  },

  // Multi-order WIP registry: each order/requisition independently stores its stage progress
  ordersWipMap: {} as Record<string, any>,
  persistedReqNumbers: [] as string[],

  // 5-Stage WIP Packing Hall State (Single Requisition with M and A prefixes, zero mockup values)
  packingWip: createEmptyPackingWipState(),

  // Dynamic dropdown options populated from backend SQLite database
  dropdownOptions: {
    makers: [] as string[],
    externalMakers: [] as Array<{ id: number; name: string }>,
    customers: [] as string[],
    articles: [] as string[],
    poList: [] as string[],
    defectBatchIds: [] as string[],
    halls: [] as HallWithStitchers[]
  },

  adminNavCollapsed: false,
  adminActiveTab: 'dashboard' as SuperUserTab,
  adminQcDispatchSelectedReq: '' as string,
  adminQcDispatchOrderFilter: '' as string,
  adminActiveReport: 'order_grn_balance' as SuperUserReportType,
  adminTrackingSearch: '',
  adminTrackingStatusFilter: 'ALL',
  adminTrackingBuyerFilter: 'ALL',
  adminTrackingMakerFilter: 'ALL',
  adminTrackingPage: 1,
  adminTrackingPageSize: 10,
  adminHighlightedRefCode: '',
  adminExpandedOrders: {} as Record<string, boolean>,
  adminOpenRegistries: {
    buyers: true,
    articles: true,
    carton_packing: false,
    makers_pos: false,
    audit_trail: false,
    sqlite_wal: false,
    phased_rollout: false
  } as Record<string, boolean>,
  adminActiveRegistryTab: 'buyers' as 'buyers' | 'articles' | 'carton_packing' | 'makers_pos' | 'audit_trail' | 'sqlite_wal' | 'phased_rollout',
  adminExpandedOrderSizeChips: {} as Record<string, boolean>,
  adminArticleDraftCustomerId: '',
  adminArticleColorDraftOptions: [] as string[],
  adminArticleColorSelectedPresets: [] as string[],
  adminOrderDraft: {
    customerId: '',
    buyer: '',
    maker: '',
    po: '',
    productId: '',
    article: '',
    color: '',
    sizeFormat: 'LEGACY_7_11',
    dueDate: '',
    sizes: createEmptySizes()
  },
  adminOrderSplitRows: [] as Array<{ maker: string; sizes: SizeBreakdown; dueDate: string }>,
  adminOrderSplitTargetMode: 'auto' as 'auto' | 'manual',
  adminOrderArticleLines: [] as AdminOrderArticleLine[],
  adminMultiArticlePickerOpen: false,
  adminMultiArticleSearch: '',
  adminOrderLastDefaultMaker: '',
  adminOrderLastDefaultDueDate: '',
  systemUsers: [] as SystemUserRecord[],
  auditTrail: [] as AuditTrailEntry[],
  lastBackupPath: '',
  adminOverview: {
    dbHealth: {
      journalMode: 'wal',
      integrity: 'ok',
      tableCounts: {} as Record<string, number>,
      totalTables: 17
    },
    customers: [] as any[],
    products: [] as any[],
    sizeStandards: [] as SizeStandardOption[],
    receivings: [] as any[],
    alterations: [] as any[],
    scrapLedger: [] as any[]
  }
};

export type AppState = typeof state;

export function getOrderSizeCodes(orderId?: string, explicitCodes?: readonly string[], explicitFormat?: string): string[] {
  if (Array.isArray(explicitCodes) && explicitCodes.length > 0) return [...explicitCodes];
  const matched = orderId ? state.pendingOrders.find(candidate => candidate.orderId === orderId) : undefined;
  if (matched?.sizeCodes && matched.sizeCodes.length > 0) return [...matched.sizeCodes];
  const fmt = explicitFormat || matched?.sizeFormat || 'LEGACY_7_11';
  return getScaleSizeCodes(state.adminOverview.sizeStandards, fmt);
}

export function getGrnRemainingCaps(orderId: string, maker?: string): GrnRemainingCaps | null {
  const order = state.pendingOrders.find(candidate => candidate.orderId === orderId);
  if (!order?.sizes) return null;
  const activeSizes = getOrderSizeCodes(orderId, order.sizeCodes, order.sizeFormat);
  const orderPlannedTotal = activeSizes.reduce((sum, size) => sum + Number(order.sizes?.[size] || 0), 0);
  if (orderPlannedTotal <= 0) return null;

  const allocs = order.contractorAllocations || [];
  const trimmedMaker = String(maker || '').trim().toLowerCase();
  const matchedAlloc = allocs.length > 0
    ? (trimmedMaker
        ? allocs.find(a => a.maker.trim().toLowerCase() === trimmedMaker)
        : (allocs.length === 1 ? allocs[0] : undefined))
    : undefined;

  const targetSizes = matchedAlloc?.sizes || order.sizes;
  const targetPlannedTotal = matchedAlloc
    ? activeSizes.reduce((sum, size) => sum + Number(matchedAlloc.sizes?.[size] || 0), 0)
    : orderPlannedTotal;

  const receivedBySize = createEmptySizes(activeSizes);
  let receivedTotal = 0;
  for (const grn of state.grnList) {
    if (grn.pendingOrderId !== orderId || grn.isVoided || grn.status.toUpperCase() === 'VOIDED') continue;
    if (matchedAlloc && String(grn.maker || '').trim().toLowerCase() !== matchedAlloc.maker.trim().toLowerCase()) {
      continue;
    }
    receivedTotal += Math.max(0, Number(grn.rcvdPairs) || 0);
    for (const size of activeSizes) {
      receivedBySize[size] += Math.max(0, Number(grn.sizes?.[size]) || 0);
    }
  }

  const sizePlanned: Record<string, number> = {};
  const sizeRemaining: Record<string, number> = {};
  for (const size of activeSizes) {
    const planned = Math.max(0, Number(targetSizes[size] || 0));
    sizePlanned[size] = planned;
    sizeRemaining[size] = Math.max(0, planned - receivedBySize[size]);
  }

  return {
    sizePlanned,
    sizeRemaining,
    totalRemaining: Math.max(0, targetPlannedTotal - receivedTotal),
    sizeFormat: order.sizeFormat || 'LEGACY_7_11',
    sizeCodes: activeSizes
  };
}

export function formatGrnRemainingCaps(caps: GrnRemainingCaps, enteredSizes: SizeBreakdown): string {
  const activeSizes = caps.sizeCodes.length > 0 ? caps.sizeCodes : [...STANDARD_GLOVE_SIZES];
  const remainingBySize = activeSizes
    .map(size => `${size}: ${Math.max(0, (caps.sizeRemaining[size] || 0) - Number(enteredSizes[size] || 0)).toLocaleString()}`)
    .join(' | ');
  const remainingTotal = Math.max(0, caps.totalRemaining - calculateSizeTotal(enteredSizes));
  return `Remaining after current entry: ${remainingBySize} | Total: ${remainingTotal.toLocaleString()} pairs`;
}

export function findHallByName(name?: string): HallWithStitchers | undefined {
  const needle = String(name || '').trim().toLowerCase();
  if (!needle) return undefined;
  return (state.dropdownOptions.halls || []).find(
    h => String(h.name || '').trim().toLowerCase() === needle
  );
}

export function getTotalIssuedPairs(): number {
  const wipItems = Object.values(state.ordersWipMap);
  if (wipItems.length > 0) {
    return wipItems.reduce((sum: number, item: any) => {
      if (!item || item.isVoided || item.issueStatus !== 'Issued by Inward Register') return sum;
      return sum + Number(item.stage1In || item.plannedQty || 0);
    }, 0);
  }
  return state.issuedPairsTotal;
}

export function logAuditEvent(
  action: AuditTrailEntry['action'],
  entityId: string,
  beforeSummary: string,
  afterSummary: string,
  orderId?: string
): void {
  state.auditTrail.push(
    createAuditTrailEntry({
      seq: state.auditTrail.length + 1,
      actor: 'M. Tariq',
      role: 'SUPER_USER',
      action,
      entityId,
      orderId,
      beforeSummary,
      afterSummary
    })
  );
}

export function getOrderStockState(orderId: string): {
  totalReceived: number;
  totalIssued: number;
  availablePairs: number;
  pendingReqPairs: number;
  unclaimedPairs: number;
  remainingOrderSizes: SizeBreakdown;
  remainingOrderTotal: number;
  receivedSizes: SizeBreakdown;
  unclaimedDockSizes: SizeBreakdown;
  hasServerCounts: boolean;
} {
  const order = state.pendingOrders.find(candidate => candidate.orderId === orderId);
  const activeSizes = getOrderSizeCodes(orderId, order?.sizeCodes, order?.sizeFormat);
  if (order && order.availableDockPairs !== undefined) {
    const remainingOrderSizes = { ...createEmptySizes(activeSizes), ...(order.remainingOrderSizes || order.sizes || {}) };
    const receivedSizes = { ...createEmptySizes(activeSizes), ...(order.receivedSizes || {}) };
    const requestedSizes = { ...createEmptySizes(activeSizes), ...(order.requestedSizes || {}) };
    const unclaimedDockSizes = {
      ...createEmptySizes(activeSizes),
      ...(order.unclaimedDockSizes ||
        Object.fromEntries(activeSizes.map(sz => [sz, Math.max(0, Number(receivedSizes[sz] || 0) - Number(requestedSizes[sz] || 0))])))
    };
    return {
      totalReceived: Number(order.receivedPairs || 0),
      totalIssued: Number(order.issuedPairs || 0),
      availablePairs: Math.max(0, Number(order.availableDockPairs || 0)),
      pendingReqPairs: Math.max(0, Number(order.pendingReqPairs || 0)),
      unclaimedPairs: Math.max(0, Number(order.unclaimedDockPairs ?? order.availableDockPairs ?? 0)),
      remainingOrderSizes,
      remainingOrderTotal: calculateSizeTotal(remainingOrderSizes),
      receivedSizes,
      unclaimedDockSizes,
      hasServerCounts: true
    };
  }

  let totalReceived = 0;
  const receivedSizes = createEmptySizes(activeSizes);
  for (const grn of state.grnList) {
    if (grn.isVoided || grn.status.toUpperCase() === 'VOIDED') continue;
    if (orderId && grn.pendingOrderId !== orderId) continue;
    totalReceived += Math.max(0, Number(grn.rcvdPairs) || 0);
    for (const size of activeSizes) {
      receivedSizes[size] += Math.max(0, Number(grn.sizes?.[size]) || 0);
    }
  }

  let totalIssued = 0;
  let pendingReqPairs = 0;
  const requestedSizes = createEmptySizes(activeSizes);
  const wipItems = Object.values(state.ordersWipMap);
  for (const item of wipItems) {
    if (!item || (item as any).isVoided) continue;
    if (orderId && item.parentOrderId !== orderId) continue;
    const qty = Number(item.plannedQty || calculateSizeTotal(item.sizes) || 0);
    for (const size of activeSizes) {
      requestedSizes[size] += Number(item.sizes?.[size] || 0);
    }
    if (item.issueStatus === 'Issued by Inward Register') {
      totalIssued += Number(item.stage1In || qty);
    } else {
      pendingReqPairs += qty;
    }
  }
  if (!orderId && wipItems.length === 0) {
    totalIssued = state.issuedPairsTotal;
  }

  const remainingOrderSizes = createEmptySizes(activeSizes);
  const unclaimedDockSizes = createEmptySizes(activeSizes);
  for (const size of activeSizes) {
    remainingOrderSizes[size] = Math.max(0, Number(order?.sizes?.[size] || 0) - requestedSizes[size]);
    unclaimedDockSizes[size] = Math.max(0, receivedSizes[size] - requestedSizes[size]);
  }
  const availablePairs = Math.max(0, totalReceived - totalIssued);
  const unclaimedPairs = Math.max(0, availablePairs - pendingReqPairs);

  return {
    totalReceived,
    totalIssued,
    availablePairs,
    pendingReqPairs,
    unclaimedPairs,
    remainingOrderSizes,
    remainingOrderTotal: calculateSizeTotal(remainingOrderSizes),
    receivedSizes,
    unclaimedDockSizes,
    hasServerCounts: false
  };
}

export function saveTailorName(name: string): void {
  const trimmed = name.trim();
  if (!trimmed || state.savedTailors.some(tailor => tailor.toLocaleLowerCase() === trimmed.toLocaleLowerCase())) return;
  state.savedTailors.push(trimmed);
  try {
    window.localStorage.setItem(SAVED_TAILORS_STORAGE_KEY, JSON.stringify(state.savedTailors));
  } catch (error) {
    console.warn('Unable to persist saved tailor name:', error);
  }
}

/** Build live order-level rollups across pending orders, GRNs, active/saved WIP, and defects. */
export function getCurrentRollupSummary() {
  const reqList: OrderWipState[] = [];
  const seen = new Set<string>();
  const activeKey = normalizeBaseReqNumber(state.packingWip.selectedBatch);

  reqList.push({
    ...state.packingWip,
    reqNumber: activeKey
  });
  seen.add(activeKey);

  for (const [k, v] of Object.entries(state.ordersWipMap)) {
    const norm = normalizeBaseReqNumber(k);
    if (!seen.has(norm) && v) {
      reqList.push({
        ...v,
        reqNumber: norm
      });
      seen.add(norm);
    }
  }

  return buildSuperUserOrderRollups({
    pendingOrders: state.pendingOrders,
    grnList: state.grnList,
    requisitions: reqList,
    defectList: state.defectList
  });
}
