import {
  SizeBreakdown,
  ContractorOrderAllocation,
  PendingOrder
} from './sizingAndCatalog';
import {
  OrderWipState,
  GrnToReqAllocation,
  SuperUserGrnBatchItem
} from './wipStageGates';

/**
 * R1, 3.8, 4.6, 4.7 — Configurable Policies for the 4 Open DECISION items.
 * All 4 DECISION items are explicitly represented here with safe industrial defaults
 * while awaiting user sign-off.
 */
export interface MesPolicyConfig {
  /** R1: Factory size set ('PLAN1_7_TO_11' for 7/S..11/XXL vs 'PLAN2_6_TO_12' for 6..12) */
  sizeScaleMode: 'PLAN1_7_TO_11' | 'PLAN2_6_TO_12';
  /** 3.8: Over-receipt & under-delivery tolerance percentage (default 5%, hard block over 5% unless Super User override) */
  overReceiptTolerancePct: number;
  underDeliveryTolerancePct: number;
  allowShortShipmentCloseWithApproval: boolean;
  /** 4.6: AQL 1.5 gate details — who records the result, per REQ or per lot, and the failure path */
  aqlInspectorRole: 'QC_INSPECTOR' | 'SUPER_USER';
  aqlInspectionGranularity: 'PER_REQ' | 'PER_MASTER_LOT';
  aqlFailurePath: 'RE_INSPECT' | 'THOROUGH_100_PCT_CHECK' | 'BACK_TO_ALTERATION';
  stage5RejectionPolicy: 'ROUTE_TO_AREQ_ALTERATION' | 'UNSEAL_TO_STAGE_4';
  /** 4.7: Full A-REQ 2-cycle/scrap workflow vs lighter flag-and-count approach */
  alterationWorkflowMode: 'FULL_AREQ_CYCLE_AND_SCRAP' | 'LIGHT_FLAG_AND_COUNT';
  scrapReplenishmentPolicy: 'INCREASE_CONTRACTOR_BALANCE' | 'SHORT_SHIP_AGAINST_PLANNED';
}

export const DEFAULT_MES_POLICY_CONFIG: MesPolicyConfig = {
  sizeScaleMode: 'PLAN1_7_TO_11',
  overReceiptTolerancePct: 5,
  underDeliveryTolerancePct: 2,
  allowShortShipmentCloseWithApproval: true,
  aqlInspectorRole: 'QC_INSPECTOR',
  aqlInspectionGranularity: 'PER_REQ',
  aqlFailurePath: 'BACK_TO_ALTERATION',
  stage5RejectionPolicy: 'ROUTE_TO_AREQ_ALTERATION',
  alterationWorkflowMode: 'FULL_AREQ_CYCLE_AND_SCRAP',
  scrapReplenishmentPolicy: 'SHORT_SHIP_AGAINST_PLANNED'
};

export function evaluateGrnOverReceiptPolicy(params: {
  plannedQty: number;
  alreadyReceivedQty: number;
  incomingGrnQty: number;
  policy?: MesPolicyConfig;
  superUserOverride?: boolean;
}): {
  allowed: boolean;
  overReceiptPairs: number;
  overReceiptPct: number;
  requiresSuperUserApproval: boolean;
  message: string;
} {
  const policy = params.policy || DEFAULT_MES_POLICY_CONFIG;
  const totalAfter = params.alreadyReceivedQty + params.incomingGrnQty;
  const overReceiptPairs = Math.max(0, totalAfter - params.plannedQty);
  const overReceiptPct =
    params.plannedQty > 0 ? Math.round((overReceiptPairs / params.plannedQty) * 1000) / 10 : 0;

  if (overReceiptPairs === 0) {
    return {
      allowed: true,
      overReceiptPairs: 0,
      overReceiptPct: 0,
      requiresSuperUserApproval: false,
      message: 'Within planned order quantity.'
    };
  }

  if (overReceiptPct <= policy.overReceiptTolerancePct || params.superUserOverride) {
    return {
      allowed: true,
      overReceiptPairs,
      overReceiptPct,
      requiresSuperUserApproval: overReceiptPct > 0,
      message: `Over-receipt of +${overReceiptPairs} pairs (+${overReceiptPct}%) accepted within tolerance/override.`
    };
  }

  return {
    allowed: false,
    overReceiptPairs,
    overReceiptPct,
    requiresSuperUserApproval: true,
    message: `Over-receipt of +${overReceiptPairs} pairs (+${overReceiptPct}%) exceeds ${policy.overReceiptTolerancePct}% tolerance. Requires Super User override.`
  };
}

/**
 * 5.4 — Chip overflow helper: sorts chips with variances/holds first, then most recent,
 * showing up to maxVisible (default 3) + "+N more" count.
 */
export function prioritizeAndSliceChips<T extends { priorityScore?: number; seq?: number }>(
  items: T[],
  maxVisible = 3
): {
  visible: T[];
  hidden: T[];
  overflowCount: number;
} {
  const sorted = [...items].sort((a, b) => {
    const pa = Number(a.priorityScore || 0);
    const pb = Number(b.priorityScore || 0);
    if (pb !== pa) return pb - pa;
    return Number(b.seq || 0) - Number(a.seq || 0);
  });
  const visible = sorted.slice(0, maxVisible);
  const hidden = sorted.slice(maxVisible);
  return {
    visible,
    hidden,
    overflowCount: hidden.length
  };
}

/**
 * 10.1 & 11.5 — Serialized Transactional Order Ledger preventing concurrent double-draws from Dock Pool.
 */
export class TransactionalOrderLedger {
  private lockPromise: Promise<void> = Promise.resolve();
  private dockPoolPairs: number;
  private issuedPairs: number;

  constructor(initialReceivedPairs: number, initialIssuedPairs = 0) {
    this.dockPoolPairs = Math.max(0, initialReceivedPairs - initialIssuedPairs);
    this.issuedPairs = Math.max(0, initialIssuedPairs);
  }

  private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const prev = this.lockPromise;
    let release!: () => void;
    this.lockPromise = new Promise<void>(resolve => {
      release = resolve;
    });
    await prev;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public async tryIssueFromDock(reqNumber: string, askingPairs: number): Promise<{
    accepted: boolean;
    reqNumber: string;
    issuedPairs: number;
    remainingDockPoolPairs: number;
    reason: string;
  }> {
    return this.withLock(async () => {
      await Promise.resolve();
      if (askingPairs <= 0) {
        return {
          accepted: false,
          reqNumber,
          issuedPairs: 0,
          remainingDockPoolPairs: this.dockPoolPairs,
          reason: 'Asking quantity must be greater than zero.'
        };
      }
      if (askingPairs > this.dockPoolPairs) {
        return {
          accepted: false,
          reqNumber,
          issuedPairs: 0,
          remainingDockPoolPairs: this.dockPoolPairs,
          reason: `Insufficient Dock Pool balance (${this.dockPoolPairs} Prs available, ${askingPairs} Prs requested).`
        };
      }
      this.dockPoolPairs -= askingPairs;
      this.issuedPairs += askingPairs;
      return {
        accepted: true,
        reqNumber,
        issuedPairs: askingPairs,
        remainingDockPoolPairs: this.dockPoolPairs,
        reason: `Issued ${askingPairs} pairs to ${reqNumber}.`
      };
    });
  }

  public getSnapshot(): { dockPoolPairs: number; issuedPairs: number } {
    return {
      dockPoolPairs: this.dockPoolPairs,
      issuedPairs: this.issuedPairs
    };
  }
}

/**
 * 10.2 — Voids and Adjustments rules:
 * - Void a GRN only if none of its pairs have been issued to a REQ.
 * - Void a REQ only before Stage 1 begins (stage1Passed === 0 && outputPairs === 0).
 */
export function canVoidGrnBatch(grn: SuperUserGrnBatchItem): { allowed: boolean; reason: string } {
  if (grn.isVoided) {
    return { allowed: false, reason: `${grn.grnCode} is already voided.` };
  }
  if (grn.allocatedPairs > 0) {
    return {
      allowed: false,
      reason: `Cannot void ${grn.grnCode}: ${grn.allocatedPairs} pairs have already been allocated/issued to Packing Hall REQs (${grn.allocatedToReqs.map(a => a.reqNumber).join(', ')}).`
    };
  }
  return { allowed: true, reason: `${grn.grnCode} has 0 issued pairs and can be safely voided.` };
}

export function canVoidRequisitionLot(wip: Partial<OrderWipState>): { allowed: boolean; reason: string } {
  if (wip.isVoided) {
    return { allowed: false, reason: `${wip.reqNumber} is already voided.` };
  }
  if (
    Number(wip.stage1Passed || 0) > 0 ||
    Number(wip.stage2In || 0) > 0 ||
    Number(wip.outputPairs || 0) > 0
  ) {
    return {
      allowed: false,
      reason: `Cannot void ${wip.reqNumber}: Stage 1 inspection has already begun (${wip.stage1Passed || 0} pairs passed).`
    };
  }
  return {
    allowed: true,
    reason: `${wip.reqNumber} has not started Stage 1 processing and can be voided.`
  };
}

/**
 * 10.3 & 10.4 — Immutable Audit Trail & RBAC Role Permissions Matrix.
 */
export type MesUserRole =
  | 'SUPER_USER'
  | 'INWARD_CLERK'
  | 'PACKING_SUPERVISOR'
  | 'QC_INSPECTOR'
  | 'ALTERATION_LEAD';

export type MesActionType =
  | 'ORDER_CREATE'
  | 'ORDER_ADJUST'
  | 'ORDER_DELETE'
  | 'ORDER_SHORT_CLOSE'
  | 'GRN_RECEIVE'
  | 'GRN_VOID'
  | 'REQ_CREATE'
  | 'REQ_ISSUE'
  | 'REQ_VOID'
  | 'WIP_STAGE_ADVANCE'
  | 'FINAL_QC_APPROVE'
  | 'FINAL_QC_REJECT'
  | 'STAGE_5_CARTON_SEAL'
  | 'DISPATCH_RELEASE'
  | 'ALTERATION_CYCLE_UPDATE'
  | 'SCRAP_CONDEMN'
  | 'USER_DELETE';

export const ROLE_PERMISSIONS: Record<MesUserRole, MesActionType[]> = {
  SUPER_USER: [
    'ORDER_CREATE',
    'ORDER_ADJUST',
    'ORDER_DELETE',
    'ORDER_SHORT_CLOSE',
    'GRN_RECEIVE',
    'GRN_VOID',
    'REQ_CREATE',
    'REQ_ISSUE',
    'REQ_VOID',
    'WIP_STAGE_ADVANCE',
    'FINAL_QC_APPROVE',
    'FINAL_QC_REJECT',
    'STAGE_5_CARTON_SEAL',
    'DISPATCH_RELEASE',
    'ALTERATION_CYCLE_UPDATE',
    'SCRAP_CONDEMN',
    'USER_DELETE'
  ],
  INWARD_CLERK: ['GRN_RECEIVE', 'REQ_ISSUE', 'ALTERATION_CYCLE_UPDATE', 'SCRAP_CONDEMN'],
  PACKING_SUPERVISOR: ['REQ_CREATE', 'WIP_STAGE_ADVANCE'],
  QC_INSPECTOR: ['FINAL_QC_APPROVE', 'FINAL_QC_REJECT', 'WIP_STAGE_ADVANCE'],
  ALTERATION_LEAD: ['ALTERATION_CYCLE_UPDATE', 'SCRAP_CONDEMN']
};

export function canRolePerformAction(role: MesUserRole, action: MesActionType): boolean {
  return (ROLE_PERMISSIONS[role] || []).includes(action);
}

export interface AuditTrailEntry {
  auditId: string;
  timestamp: string;
  actor: string;
  role: MesUserRole;
  action: MesActionType;
  entityId: string;
  orderId?: string;
  beforeSummary: string;
  afterSummary: string;
  reason?: string;
}

export function createAuditTrailEntry(params: {
  seq: number;
  actor: string;
  role: MesUserRole;
  action: MesActionType;
  entityId: string;
  orderId?: string;
  beforeSummary: string;
  afterSummary: string;
  reason?: string;
  timestamp?: string;
}): AuditTrailEntry {
  return {
    auditId: `AUD-${String(params.seq).padStart(4, '0')}`,
    timestamp: params.timestamp || new Date().toISOString().replace('T', ' ').slice(0, 19),
    actor: params.actor,
    role: params.role,
    action: params.action,
    entityId: params.entityId,
    orderId: params.orderId,
    beforeSummary: params.beforeSummary,
    afterSummary: params.afterSummary,
    reason: params.reason
  };
}

/**
 * 12.2 — Phased Rollout Record (Phase A, Phase B, Phase C).
 */
export interface PhasedRolloutMilestone {
  phase: 'Phase A' | 'Phase B' | 'Phase C';
  title: string;
  scope: string[];
  status: 'COMPLETED';
  verificationSuites: string[];
}

export const PHASED_ROLLOUT_RECORD: PhasedRolloutMilestone[] = [
  {
    phase: 'Phase A',
    title: 'Relational Order → GRN → REQ Hierarchy, FIFO Allocations, Dashboard & Reconciliation Engine',
    scope: [
      'Order (1) → GRN (N) → REQ (M) relational hierarchy & GrnToReqAllocation join table (2.1–2.10)',
      'Non-tautological Dock Gate & Floor Gate conservation equations (3.1–3.7)',
      'Super User View 1 Executive Dashboard with 4 Pulse Cards, Exceptions Strip & Chip Overflow (5.1–5.6)'
    ],
    status: 'COMPLETED',
    verificationSuites: ['src/utils/requisitionLogic.test.ts (Tests 1–4, 7–9)', 'test/db-reliability.test.js']
  },
  {
    phase: 'Phase B',
    title: 'Live Tracking (Tier 1 & Tier 2), Lifecycle State Machine & Stage 4 → AQL 1.5 → Stage 5 Gate',
    scope: [
      'Order & REQ status transition state machines and atomic stage transitions (4.1, 3.6)',
      'Stage 4 Complete (Awaiting Final QC) hard lock before Stage 5 Master Carton sealing (4.2, 4.3, 4.4)',
      'Super User View 2 Live Tracking with <150ms expansion, filters, pagination & per-REQ reconciliation (6.1–6.7)'
    ],
    status: 'COMPLETED',
    verificationSuites: ['src/utils/requisitionLogic.test.ts (Tests 5, 10, 12, 16)', 'test/mes-server-integrity.test.js']
  },
  {
    phase: 'Phase C',
    title: '2-Cycle Alteration Loop (A-REQ), Scrap Condemnation, View 4 Official Reports & Monochrome Print',
    scope: [
      '2-cycle rework loop returning to Stage 1 Checking and auto-condemning to Scrap on Cycle 2/2 failure (4.5)',
      'View 4 Reconciliation, Traceability, Contractor Scrap & AQL Dispatch Reports with CSV & A4 Print (8.1–8.6)',
      'Scoped .superuser-command-center tokens, 100% monochrome shop-floor/slips, SQLite RBAC & immutable audit trail (9.1–10.5)'
    ],
    status: 'COMPLETED',
    verificationSuites: ['src/utils/requisitionLogic.test.ts (Tests 11, 13–17)', 'test/enterprise-gaps.test.js', 'test/mes-server-integrity.test.js']
  }
];

export function applyPendingOrderSelection(
  orders: PendingOrder[],
  selectedOrderId: string
): {
  pendingOrderId: string;
  buyer?: string;
  maker: string;
  po?: string;
  article: string;
  color?: string;
  sizeFormat?: string;
  sizeCodes?: string[];
  dueDate?: string;
  sizes?: SizeBreakdown;
  totalQty?: number;
  contractorAllocations?: ContractorOrderAllocation[];
} | null {
  const found = orders.find(o => o.orderId === selectedOrderId);
  if (!found) return null;
  const allocs = found.contractorAllocations || [];
  const defaultMaker = allocs.length === 1 ? allocs[0].maker : (allocs.length > 1 ? '' : found.maker);
  const result: {
    pendingOrderId: string;
    buyer?: string;
    maker: string;
    po?: string;
    article: string;
    color?: string;
    sizeFormat?: string;
    sizeCodes?: string[];
    dueDate?: string;
    sizes?: SizeBreakdown;
    totalQty?: number;
    contractorAllocations?: ContractorOrderAllocation[];
  } = {
    pendingOrderId: found.orderId,
    maker: defaultMaker,
    article: found.article
  };
  if (found.buyer !== undefined) result.buyer = found.buyer;
  if (found.po !== undefined) result.po = found.po;
  if (found.color !== undefined) result.color = found.color;
  if (found.sizeFormat !== undefined) result.sizeFormat = found.sizeFormat;
  if (found.sizeCodes !== undefined) result.sizeCodes = found.sizeCodes;
  if (found.dueDate !== undefined) result.dueDate = found.dueDate;
  if (found.sizes !== undefined) result.sizes = found.sizes;
  if (found.totalQty !== undefined) result.totalQty = found.totalQty;
  if (found.contractorAllocations !== undefined) result.contractorAllocations = found.contractorAllocations;
  return result;
}

export function evaluateRequisitionIssuance(params: {
  askingPairs: number;
  askingSizes?: Partial<SizeBreakdown>;
  totalReceivedPairs: number;
  alreadyIssuedPairs: number;
}): {
  availablePairs: number;
  askingPairs: number;
  shortfallPairs: number;
  canIssue: boolean;
} {
  const availablePairs = Math.max(
    0,
    Number(params.totalReceivedPairs || 0) - Number(params.alreadyIssuedPairs || 0)
  );
  const askingPairs = Math.max(0, Number(params.askingPairs || 0));
  const shortfallPairs = Math.max(0, askingPairs - availablePairs);
  const canIssue = askingPairs > 0 && availablePairs >= askingPairs;
  return {
    availablePairs,
    askingPairs,
    shortfallPairs,
    canIssue
  };
}
