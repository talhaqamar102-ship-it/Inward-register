import {
  SizeBreakdown,
  PendingOrder,
  scaleSizeBreakdown
} from './sizingAndCatalog';
import {
  OrderWipState,
  isReqAwaitingFinalQc,
  canExecuteStage5CartonPacking,
  OrderTraceabilityItem
} from './wipStageGates';
import { buildSuperUserOrderRollups } from './traceabilityEngine';
import { TransactionalOrderLedger } from './policyRbacAndDemo';

/**
 * 5.6 & 11.6 — Flagged & Removable 600-Pair Demo Scenario Builder ("1-Order -> 3-GRNs -> 3-REQs").
 * Supports three phases:
 *  - 'IN_PROGRESS': REQ-0901 at Stage 4 Complete (Awaiting Final QC), REQ-0902 in Alteration (Cycle 1/2), REQ-0903 at Stage 2, both gates RECONCILED ✓
 *  - 'COMPLETED': All 3 REQs (REQ-0901, REQ-0902, REQ-0903) pass Final QC (AQL 1.5) and seal Stage 5 Master Cartons (300 + 195 + 100 = 595 packed in 6 + 4 + 2 = 12 cartons @ 50 prs/ctn + 5 scrapped = 600), COMPLETED & DISPATCHED & RECONCILED ✓
 *  - 'DELIBERATE_VARIANCE': Injects a deliberate 12-pair Stage 1 floor bin corruption on REQ-0902 to verify VARIANCE Δ (-12 Prs • FLOOR_GATE)
 */
export function createDemo600PairScenario(
  phase: 'IN_PROGRESS' | 'COMPLETED' | 'DELIBERATE_VARIANCE' = 'COMPLETED'
): {
  order: PendingOrder;
  grns: Array<{
    sr: number;
    grnCode: string;
    date: string;
    pendingOrderId: string;
    maker: string;
    article: string;
    rcvdPairs: number;
    sizes: SizeBreakdown;
    status: string;
    isDemoScenario: boolean;
  }>;
  reqs: OrderWipState[];
  defects: Array<{
    id: string;
    article: string;
    po: string;
    stage: string;
    defect: string;
    qty: string;
    Action: string;
    cycles: number;
    status: string;
    isDemoScenario: boolean;
  }>;
} {
  const orderId = 'ORD-2026-600';
  const article = 'ARC-PRO-600 Kevlar Driver';
  const maker = 'Ravi Stitch Crafts (Unit-2)';
  const buyer = 'Nordic Safety Gear AB';
  const po = 'PO-NSG-600';

  const order: PendingOrder = {
    orderId,
    buyer,
    maker,
    po,
    article,
    color: 'Hi-Vis Yellow / Slate',
    sizes: { '7': 60, '8': 150, '9': 180, '10': 150, '11': 60 },
    totalQty: 600,
    notes: '11.6 Verification: 1-Order -> 3-GRNs -> 3-REQs (600 Pairs)',
    isDemoScenario: true
  };

  const grns = [
    {
      sr: 901,
      grnCode: 'GRN-0901',
      date: '04-11-2026 08:30',
      pendingOrderId: orderId,
      maker,
      article,
      rcvdPairs: 250,
      sizes: { '7': 25, '8': 60, '9': 75, '10': 65, '11': 25 },
      status: 'Received',
      isDemoScenario: true
    },
    {
      sr: 902,
      grnCode: 'GRN-0902',
      date: '04-11-2026 10:15',
      pendingOrderId: orderId,
      maker,
      article,
      rcvdPairs: 200,
      sizes: { '7': 20, '8': 50, '9': 60, '10': 50, '11': 20 },
      status: 'Received',
      isDemoScenario: true
    },
    {
      sr: 903,
      grnCode: 'GRN-0903',
      date: '04-11-2026 11:00',
      pendingOrderId: orderId,
      maker,
      article,
      rcvdPairs: 150,
      sizes: { '7': 15, '8': 40, '9': 45, '10': 35, '11': 15 },
      status: 'Received',
      isDemoScenario: true
    }
  ];

  const req1Sizes: SizeBreakdown = { '7': 30, '8': 75, '9': 90, '10': 75, '11': 30 };
  const req2Sizes: SizeBreakdown = { '7': 20, '8': 50, '9': 60, '10': 50, '11': 20 };
  const req3Sizes: SizeBreakdown = { '7': 10, '8': 25, '9': 30, '10': 25, '11': 10 };

  const req1: OrderWipState = {
    reqNumber: 'REQ-0901',
    parentOrderId: orderId,
    allocatedGrnRefs: [
      { grnCode: 'GRN-0901', pairs: 250 },
      { grnCode: 'GRN-0902', pairs: 50 }
    ],
    article,
    po,
    maker,
    buyer,
    plannedQty: 300,
    issueStatus: 'Issued by Inward Register',
    sizes: req1Sizes,
    packedSizes: req1Sizes,
    stage1In: 300,
    stage1Passed: 300,
    stage1Defects: 0,
    stage2In: 300,
    stage2Passed: 300,
    stage2Defects: 0,
    stage3In: 300,
    stage3Passed: 300,
    stage3Defects: 0,
    mreqNo: 'M-REQ-0901',
    altReqNo: 'A-REQ-0901',
    mreqQty: '300 Sets',
    mreqStatus: 'Issued',
    stage4In: 300,
    stage4Passed: 300,
    stage4Pending: 0,
    stage5Cartons: '6 Cartons',
    stage5Pending: '0 Cartons',
    lineEfficiency: '98.5%',
    outputPairs: 300,
    outputCartons: 6,
    inAlteration: 0,
    scrappedPairs: 0,
    finalQcApproved: true,
    alterationCycleCount: 0,
    isDemoScenario: true
  };

  const req2: OrderWipState =
    phase === 'IN_PROGRESS'
      ? {
          reqNumber: 'REQ-0902',
          parentOrderId: orderId,
          allocatedGrnRefs: [
            { grnCode: 'GRN-0902', pairs: 150 },
            { grnCode: 'GRN-0903', pairs: 50 }
          ],
          article,
          po,
          maker,
          buyer,
          plannedQty: 200,
          issueStatus: 'Issued by Inward Register',
          sizes: req2Sizes,
          packedSizes: scaleSizeBreakdown(req2Sizes, 0),
          stage1In: 200,
          stage1Passed: 190,
          stage1Defects: 10,
          stage2In: 190,
          stage2Passed: 190,
          stage2Defects: 0,
          stage3In: 190,
          stage3Passed: 190,
          stage3Defects: 0,
          mreqNo: 'M-REQ-0902',
          altReqNo: 'A-REQ-0902',
          mreqQty: '190 Sets',
          mreqStatus: 'Issued',
          stage4In: 190,
          stage4Passed: 190,
          stage4Pending: 0,
          stage5Cartons: '0 Cartons',
          stage5Pending: '4 Cartons',
          lineEfficiency: '95.0%',
          outputPairs: 0,
          outputCartons: 0,
          inAlteration: 10,
          scrappedPairs: 0,
          contractorDebitPairs: 0,
          finalQcApproved: false,
          alterationCycleCount: 1,
          isDemoScenario: true
        }
      : {
          reqNumber: 'REQ-0902',
          parentOrderId: orderId,
          allocatedGrnRefs: [
            { grnCode: 'GRN-0902', pairs: 150 },
            { grnCode: 'GRN-0903', pairs: 50 }
          ],
          article,
          po,
          maker,
          buyer,
          plannedQty: 200,
          issueStatus: 'Issued by Inward Register',
          sizes: req2Sizes,
          packedSizes: scaleSizeBreakdown(req2Sizes, phase === 'DELIBERATE_VARIANCE' ? 0 : 195),
          stage1In: 200,
          stage1Passed: phase === 'DELIBERATE_VARIANCE' ? 183 : 195,
          stage1Defects: 5,
          stage2In: phase === 'DELIBERATE_VARIANCE' ? 183 : 195,
          stage2Passed: phase === 'DELIBERATE_VARIANCE' ? 183 : 195,
          stage2Defects: 0,
          stage3In: phase === 'DELIBERATE_VARIANCE' ? 183 : 195,
          stage3Passed: phase === 'DELIBERATE_VARIANCE' ? 183 : 195,
          stage3Defects: 0,
          mreqNo: 'M-REQ-0902',
          altReqNo: 'A-REQ-0902',
          mreqQty: '195 Sets',
          mreqStatus: 'Issued',
          stage4In: phase === 'DELIBERATE_VARIANCE' ? 183 : 195,
          stage4Passed: phase === 'DELIBERATE_VARIANCE' ? 183 : 195,
          stage4Pending: 0,
          stage5Cartons: phase === 'DELIBERATE_VARIANCE' ? '0 Cartons' : '4 Cartons',
          stage5Pending: phase === 'DELIBERATE_VARIANCE' ? '4 Cartons' : '0 Cartons',
          lineEfficiency: '97.5%',
          outputPairs: phase === 'DELIBERATE_VARIANCE' ? 0 : 195,
          outputCartons: phase === 'DELIBERATE_VARIANCE' ? 0 : 4,
          inAlteration: 0,
          scrappedPairs: 5,
          contractorDebitPairs: 5,
          unaccountedVariancePairs: phase === 'DELIBERATE_VARIANCE' ? 12 : 0,
          finalQcApproved: phase !== 'DELIBERATE_VARIANCE',
          alterationCycleCount: 2,
          isDemoScenario: true
        };

  const req3: OrderWipState = {
    reqNumber: 'REQ-0903',
    parentOrderId: orderId,
    allocatedGrnRefs: [{ grnCode: 'GRN-0903', pairs: 100 }],
    article,
    po,
    maker,
    buyer,
    plannedQty: 100,
    issueStatus: 'Issued by Inward Register',
    sizes: req3Sizes,
    packedSizes: req3Sizes,
    stage1In: 100,
    stage1Passed: 100,
    stage1Defects: 0,
    stage2In: 100,
    stage2Passed: 100,
    stage2Defects: 0,
    stage3In: 100,
    stage3Passed: 100,
    stage3Defects: 0,
    mreqNo: 'M-REQ-0903',
    altReqNo: 'A-REQ-0903',
    mreqQty: '100 Sets',
    mreqStatus: 'Issued',
    stage4In: 100,
    stage4Passed: 100,
    stage4Pending: 0,
    stage5Cartons: '2 Cartons',
    stage5Pending: '0 Cartons',
    lineEfficiency: '99.0%',
    outputPairs: 100,
    outputCartons: 2,
    inAlteration: 0,
    scrappedPairs: 0,
    finalQcApproved: true,
    alterationCycleCount: 0,
    isDemoScenario: true
  };

  const defects =
    phase === 'IN_PROGRESS'
      ? [
          {
            id: 'A-REQ-0902',
            article,
            po,
            stage: 'Stage 1 Cuff QC',
            defect: 'Open Cuff Seam (10 Prs In Rework Cycle 1/2)',
            qty: '10 Prs',
            Action: 'Re-Stitching',
            cycles: 1,
            status: 'In Rework',
            isDemoScenario: true
          }
        ]
      : [
          {
            id: 'A-REQ-0902',
            article,
            po,
            stage: 'Stage 1 Cuff QC',
            defect: 'Condemned after Cycle 2/2 (5 Prs)',
            qty: '5 Prs',
            Action: 'Condemned to Scrap',
            cycles: 2,
            status: 'Scrapped',
            isDemoScenario: true
          }
        ];

  return {
    order,
    grns,
    reqs: [req1, req2, req3],
    defects
  };
}

/**
 * 11.6 — Chronological step-by-step replay of the 600-pair manual scenario.
 * Verifies:
 *  1) Attempting to issue REQ-0902 (200 prs) before GRN-0903 (150 prs) is received is BLOCKED (Issued <= Received).
 *  2) Receiving GRN-0903 (150 prs) brings Dock Available to 300 prs, allowing REQ-0902 (200) and REQ-0903 (100).
 *  3) Pushing REQ-0901, REQ-0902, REQ-0903 to Stage 4 locks Stage 5 until Final QC (AQL 1.5) approves each lot.
 *  4) Alteration (5 repaired) and Scrap (5 condemned on Cycle 2/2) reconcile at both Dock and Floor gates (RECONCILED ✓).
 *  5) Forcing a deliberate variance on either Floor Gate (-12 prs) or Dock Gate (-15 prs) flips status to VARIANCE Δ with exact delta.
 */
export async function replayDemo600PairScenarioStepByStep(): Promise<{
  preGrn3OverIssueAttempt: { accepted: boolean; remainingDockPoolPairs: number; reason: string };
  postGrn3Req2Issue: { accepted: boolean; remainingDockPoolPairs: number };
  postGrn3Req3Issue: { accepted: boolean; remainingDockPoolPairs: number };
  stage4HoldBeforeQcGate: { allowed: boolean; awaitingFinalQc: boolean; reason: string };
  allThreeReqsStage5GateChecked: Array<{ reqNumber: string; lockedBeforeQc: boolean; unlockedAfterQc: boolean }>;
  allThreeReqsFinalQcApproved: boolean;
  reconciledRollup: OrderTraceabilityItem;
  forcedFloorVarianceRollup: OrderTraceabilityItem;
  forcedDockVarianceRollup: OrderTraceabilityItem;
}> {
  // Step 1 & 2: Order ORD-2026-600 (600 prs); Receive GRN-0901 (250) + GRN-0902 (200) = 450 Received
  const ledger = new TransactionalOrderLedger(450, 0);

  // Step 3: Issue REQ-0901 (300 prs) -> 150 prs left in Dock Pool
  const req1Issue = await ledger.tryIssueFromDock('REQ-0901', 300);
  if (!req1Issue.accepted) {
    throw new Error('REQ-0901 should issue 300 pairs from 450 received');
  }

  // Step 4: Try to issue REQ-0902 (200 prs) BEFORE GRN-0903 (150 prs) is received -> MUST BE BLOCKED
  const preGrn3OverIssueAttempt = await ledger.tryIssueFromDock('REQ-0902', 200);

  // Step 5: Receive GRN-0903 (150 prs) -> Dock Pool increases from 150 to 300 (Total Received = 600, Issued = 300)
  const ledgerAfterGrn3 = new TransactionalOrderLedger(600, 300);
  const postGrn3Req2Issue = await ledgerAfterGrn3.tryIssueFromDock('REQ-0902', 200);
  const postGrn3Req3Issue = await ledgerAfterGrn3.tryIssueFromDock('REQ-0903', 100);

  // Step 6: Verify Stage 4 -> Final QC -> Stage 5 gate on ALL 3 REQs (REQ-0901, REQ-0902, REQ-0903) before QC approval
  const completedScenario = createDemo600PairScenario('COMPLETED');
  const allThreeReqsStage5GateChecked = completedScenario.reqs.map(r => {
    const beforeQcLot: OrderWipState = { ...r, outputPairs: 0, outputCartons: 0, finalQcApproved: false };
    const afterQcLot: OrderWipState = { ...r, outputPairs: 0, outputCartons: 0, finalQcApproved: true };
    return {
      reqNumber: r.reqNumber,
      lockedBeforeQc: canExecuteStage5CartonPacking(beforeQcLot).allowed === false && isReqAwaitingFinalQc(beforeQcLot),
      unlockedAfterQc: canExecuteStage5CartonPacking(afterQcLot).allowed === true
    };
  });

  const req1AtStage4Hold: OrderWipState = {
    ...completedScenario.reqs[0],
    outputPairs: 0,
    outputCartons: 0,
    finalQcApproved: false
  };
  const stage4HoldBeforeQcGate = {
    ...canExecuteStage5CartonPacking(req1AtStage4Hold),
    awaitingFinalQc: isReqAwaitingFinalQc(req1AtStage4Hold)
  };

  // Step 7: Approve Final QC on all 3 REQs (REQ-0901, REQ-0902, REQ-0903) and seal Stage 5 cartons
  const allThreeReqsFinalQcApproved = allThreeReqsStage5GateChecked.every(
    c => c.lockedBeforeQc && c.unlockedAfterQc
  );
  const reconciledSummary = buildSuperUserOrderRollups({
    pendingOrders: [completedScenario.order],
    grnList: completedScenario.grns,
    requisitions: completedScenario.reqs,
    defectList: completedScenario.defects
  });
  const reconciledRollup = reconciledSummary.orderRollups[0];

  // Step 8A: Force deliberate Floor Gate variance (-12 pairs on REQ-0902)
  const varianceScenario = createDemo600PairScenario('DELIBERATE_VARIANCE');
  const floorVarianceSummary = buildSuperUserOrderRollups({
    pendingOrders: [varianceScenario.order],
    grnList: varianceScenario.grns,
    requisitions: varianceScenario.reqs,
    defectList: varianceScenario.defects
  });
  const forcedFloorVarianceRollup = floorVarianceSummary.orderRollups[0];

  // Step 8B: Force deliberate Dock Gate variance (-15 pairs physical dock count discrepancy)
  const dockVarianceSummary = buildSuperUserOrderRollups({
    pendingOrders: [{ ...completedScenario.order, physicalDockCountPairs: 15 }],
    grnList: completedScenario.grns,
    requisitions: completedScenario.reqs,
    defectList: completedScenario.defects
  });
  const forcedDockVarianceRollup = dockVarianceSummary.orderRollups[0];

  return {
    preGrn3OverIssueAttempt,
    postGrn3Req2Issue,
    postGrn3Req3Issue,
    stage4HoldBeforeQcGate,
    allThreeReqsStage5GateChecked,
    allThreeReqsFinalQcApproved,
    reconciledRollup,
    forcedFloorVarianceRollup,
    forcedDockVarianceRollup
  };
}
