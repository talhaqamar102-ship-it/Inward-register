import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { initDatabase, db } from '../src/db.js';
import { PackingService } from '../src/services/packingService.js';

describe('Gloves Packing Execution System - End-to-End Test Suite', () => {
  before(() => {
    initDatabase();
    db.prepare(`UPDATE store_gloves_inventory SET available_pairs = 5000 WHERE product_id = 'GLV-A16'`).run();
    db.prepare(`UPDATE store_materials_inventory SET available_qty = 50000`).run();
  });

  let reqNumber = null;
  let matReqNumber = null;
  let altId = null;

  test('1. Setup & Inventory Lookups', () => {
    const gloves = PackingService.getGloveInventory();
    assert.ok(gloves.length > 0, 'Gloves inventory should be pre-seeded');

    const materials = PackingService.getMaterialInventory();
    assert.ok(materials.length >= 3, 'Materials inventory should have polybags, silica, stickers');

    const customers = PackingService.getCustomers();
    assert.ok(customers.length >= 3, 'Customers list should include Northwind, Umbrella, Stark');
  });

  test('2. Packing Hall creates Glove Requisition (REQ auto-numbering)', () => {
    const req = PackingService.createGloveRequisition(
      'CUST-001',
      'GLV-A16',
      200,
      'Rush export batch for European market'
    );

    assert.ok(req.req_number.startsWith('REQ-'), 'Requisition number should start with REQ-');
    assert.equal(req.customer_id, 'CUST-001');
    assert.equal(req.product_id, 'GLV-A16');
    assert.equal(req.requested_pairs, 200);
    assert.equal(req.status, 'PENDING');
    reqNumber = req.req_number;
  });

  test('3. Store Keeper views REQ and issues raw gloves', () => {
    const initialStock = db.prepare(
      `SELECT available_pairs FROM store_gloves_inventory WHERE product_id = 'GLV-A16'`
    ).get().available_pairs;

    const issuedReq = PackingService.issueGloveRequisition(reqNumber);
    assert.equal(issuedReq.status, 'ISSUED');
    assert.equal(issuedReq.issued_pairs, 200);

    const postStock = db.prepare(
      `SELECT available_pairs FROM store_gloves_inventory WHERE product_id = 'GLV-A16'`
    ).get().available_pairs;

    assert.equal(postStock, initialStock - 200, 'Glove store stock should be deducted');
    assert.equal(issuedReq.wip.step1_checking_in, 200, '200 pairs arrive at Step 1 Checking');
  });

  test('4. Step 1: Checking / Inspection (Good pairs advance, Defects to Alteration)', () => {
    // 190 good pairs, 10 defective pairs (e.g. stitching slip)
    const result = PackingService.executeStep1Checking(reqNumber, 190, 10, 'Loose thumb seam stitching');
    assert.equal(result.wip.step1_checking_good, 190);
    assert.equal(result.wip.step1_checking_defects, 10);
    assert.equal(result.wip.step2_ironing_in, 190, '190 good pairs moved to Step 2');

    const alts = PackingService.getAlterations(reqNumber);
    assert.equal(alts.length, 1);
    assert.equal(alts[0].source_stage, 'STEP_1_CHECKING');
    assert.equal(alts[0].pairs_count, 10);
    assert.equal(alts[0].status, 'SENT_FOR_ALTERATION');
    altId = alts[0].id;
  });

  test('5. Step 2: Ironing & Brushing (Good pairs advance, Defects to Alteration)', () => {
    // 185 good pairs, 5 defective pairs (e.g. iron scorch or dirt mark)
    const result = PackingService.executeStep2Ironing(reqNumber, 185, 5, 'Fabric scorch during heat press');
    assert.equal(result.wip.step2_ironing_good, 185);
    assert.equal(result.wip.step2_ironing_defects, 5);
    assert.equal(result.wip.step3_matching_in, 185, '185 good pairs moved to Step 3');
  });

  test('6. Step 3: Pair Matching (Good pairs advance, Defects to Alteration)', () => {
    // 180 good pairs, 5 defective pairs (e.g. shade mismatch)
    const result = PackingService.executeStep3Matching(reqNumber, 180, 5, 'Left-Right shade variance');
    assert.equal(result.wip.step3_matching_good, 180);
    assert.equal(result.wip.step3_matching_defects, 5);
  });

  test('7. Closed Alteration Loop: Repaired pairs ALWAYS return to Step 1 Checking', () => {
    const priorCheckingIn = db.prepare(`SELECT step1_checking_in FROM packing_wip WHERE req_number = ?`).get(reqNumber).step1_checking_in;
    
    // Return alteration record
    const returnedAlt = PackingService.returnAlteration(altId);
    assert.equal(returnedAlt.status, 'RETURNED_TO_CHECKING');

    const postCheckingIn = db.prepare(`SELECT step1_checking_in FROM packing_wip WHERE req_number = ?`).get(reqNumber).step1_checking_in;
    assert.equal(postCheckingIn, priorCheckingIn + 10, 'Returned 10 pairs must strictly return into Step 1 Checking');
  });

  test('8. Create Material Requisition for 1st Packing accessories (Post Step 3)', () => {
    // 180 good pairs * (1 polybag, 1 silica gel, 2 stickers)
    const matReq = PackingService.createMaterialRequisition(reqNumber);
    assert.ok(matReq.mat_req_number.startsWith('MREQ-'));
    assert.equal(matReq.pairs_count, 180);
    assert.equal(matReq.polybags_requested, 180);
    assert.equal(matReq.silica_gel_requested, 180);
    assert.equal(matReq.stickers_requested, 360);
    assert.equal(matReq.status, 'PENDING');
    matReqNumber = matReq.mat_req_number;
  });

  test('9. Packing Materials Store issues accessories against MREQ', () => {
    const issuedMat = PackingService.issueMaterialRequisition(matReqNumber);
    assert.equal(issuedMat.status, 'ISSUED');

    const req = PackingService.getRequisition(reqNumber);
    assert.equal(req.wip.step4_materials_issued, 1);
    assert.equal(req.wip.current_step, 'STEP_4');
  });

  test('10. Step 4: 1st Packing (Individual pair packaging)', () => {
    const result = PackingService.executeStep4FirstPacking(reqNumber, 180);
    assert.equal(result.wip.step4_packing_good, 180);
    assert.equal(result.wip.current_step, 'STEP_5');
  });

  test('11. Step 5: 2nd Packing (Cartons packing)', () => {
    // 180 pairs @ 50 per carton -> 4 cartons (50, 50, 50, 30)
    const result = PackingService.executeStep5SecondPacking(reqNumber, 50);
    assert.equal(result.wip.step5_cartons_packed, 4);
    assert.equal(result.cartons.length, 4);
    assert.equal(result.cartons[0].pairs_count, 50);
    assert.equal(result.cartons[3].pairs_count, 30);
  });

  test('12. Final Inspection (Random Sampling vs Thorough, Repair Loop on Defect)', () => {
    // Northwind customer has 'RANDOM' preference
    // Case A: Defect found during inspection -> Must route to Repair and return to Step 1!
    const failResult = PackingService.executeFinalInspection(reqNumber, 2, 2, 'Torn polybag inside carton #2');
    assert.equal(failResult.wip.final_qc_status, 'REPAIR_REQUIRED');
    
    // Verify alteration logged for repair
    const latestAlt = failResult.alterations[0];
    assert.equal(latestAlt.source_stage, 'FINAL_INSPECTION');
    assert.equal(latestAlt.pairs_count, 2);

    // Case B: Clean inspection passed -> Approved for Dispatch!
    const passResult = PackingService.executeFinalInspection(reqNumber, 2, 0, 'Sampling passed AQL standard');
    assert.equal(passResult.wip.final_qc_status, 'APPROVED_DISPATCH');
    assert.equal(passResult.wip.current_step, 'DISPATCH_APPROVED');
    assert.equal(passResult.status, 'DISPATCHED');
  });

  test('13. Step 5 Partial Split Boxing (AIR vs SEA, Custom Dimensions & Real CBM)', () => {
    // Re-pack fresh using partial boxing: 100 pairs in 45x35x30 (50/ctn -> 2 cartons) via AIR
    db.prepare(`DELETE FROM cartons WHERE req_number = ?`).run(reqNumber);
    db.prepare(`UPDATE packing_wip SET step5_cartons_packed = 0, step5_pairs_packed = 0 WHERE req_number = ?`).run(reqNumber);
    db.prepare(`UPDATE glove_requisitions SET status = 'IN_PROGRESS' WHERE req_number = ?`).run(reqNumber);

    const airBatch = PackingService.executeStep5SecondPacking(reqNumber, 50, {
      enforcePreStage5AqlGate: true,
      pairsToPack: 100,
      dimensionsCm: '45x35x30',
      shippingMode: 'AIR',
      sealPrefix: 'AIR-SEAL'
    });
    assert.equal(airBatch.wip.step5_cartons_packed, 2);
    assert.equal(airBatch.wip.step5_pairs_packed, 100);
    assert.equal(airBatch.cartons.length, 2);
    assert.equal(airBatch.cartons[0].dimensions_cm, '45x35x30');
    assert.equal(airBatch.cartons[0].shipping_mode, 'AIR');
    assert.ok(Math.abs(airBatch.cartons[0].cbm - 0.0473) < 0.0005);

    // Box remaining 80 pairs in 60x40x35 (40/ctn -> 2 cartons) as UNASSIGNED
    const seaBatch = PackingService.executeStep5SecondPacking(reqNumber, 40, {
      enforcePreStage5AqlGate: true,
      pairsToPack: 80,
      dimensionsCm: '60x40x35',
      shippingMode: 'UNASSIGNED',
      sealPrefix: 'SEA-SEAL'
    });
    assert.equal(seaBatch.wip.step5_cartons_packed, 4);
    assert.equal(seaBatch.wip.step5_pairs_packed, 180);

    // Reject over-boxing beyond step4_packing_good
    assert.throws(() => {
      PackingService.executeStep5SecondPacking(reqNumber, 10, {
        enforcePreStage5AqlGate: true,
        pairsToPack: 10
      });
    }, /Cannot box 10 pairs; only 0 pairs remain unboxed/);

    // Dispatch remaining 2 UNASSIGNED cartons via SEA
    const remainingBarcodes = seaBatch.cartons
      .filter(c => c.shipping_mode === 'UNASSIGNED')
      .map(c => c.carton_barcode);
    PackingService.dispatchCartons(reqNumber, {
      shippingMode: 'SEA',
      cartonBarcodes: remainingBarcodes
    });

    const manifest = PackingService.getMasterCartonManifest(reqNumber);
    assert.equal(manifest.totalCartons, 4);
    assert.equal(manifest.totalPairs, 180);
    assert.equal(manifest.airCartons, 2);
    assert.equal(manifest.airPairs, 100);
    assert.equal(manifest.seaCartons, 2);
    assert.equal(manifest.seaPairs, 80);
    assert.equal(manifest.unshippedCartons, 0);
    // 2 * 0.0473 + 2 * 0.084 = 0.2626 -> '0.263'
    assert.equal(manifest.totalCBM, '0.263');
  });
});

describe('Parallel Stage 3-4 flow: rework does not block matched pairs', () => {
  test('matched pairs proceed while rework is pending, and catch-up pairs get a follow-up M-REQ', () => {
    const req = PackingService.createGloveRequisition('CUST-001', 'GLV-A16', 250, 'Parallel flow rework batch');
    const reqNo = req.req_number;

    PackingService.issueGloveRequisition(reqNo);
    PackingService.executeStep1Checking(reqNo, 200, 50, 'Rework batch held for alteration');
    PackingService.executeStep2Ironing(reqNo, 200, 0, '');
    PackingService.executeStep3Matching(reqNo, 200, 0, '');

    const firstMatReq = PackingService.createMaterialRequisition(reqNo);
    assert.equal(firstMatReq.pairs_count, 200);
    PackingService.issueMaterialRequisition(firstMatReq.mat_req_number);

    // 200 matched pairs enter Stage 4 while 50 rework pairs are still pending
    const packed = PackingService.executeStep4FirstPacking(reqNo, 200);
    assert.equal(packed.wip.step4_packing_good, 200);

    // Rework returns to Stage 1 and catches up through Stages 1-3
    const alt = PackingService.getAlterations(reqNo)[0];
    PackingService.returnAlteration(alt.id);
    PackingService.executeStep1Checking(reqNo, 50, 0, '');
    PackingService.executeStep2Ironing(reqNo, 50, 0, '');
    PackingService.executeStep3Matching(reqNo, 50, 0, '');

    // Catch-up pairs are covered by a second M-REQ, not silently ignored
    const catchUpMatReq = PackingService.createMaterialRequisition(reqNo);
    assert.notEqual(catchUpMatReq.mat_req_number, firstMatReq.mat_req_number);
    assert.equal(catchUpMatReq.pairs_count, 50);
    assert.equal(catchUpMatReq.polybags_requested, 50);
    assert.equal(catchUpMatReq.stickers_requested, 100);
    assert.equal(catchUpMatReq.status, 'PENDING');

    // The issued slip stays visible so Stage 4 does not re-lock
    const refreshed = PackingService.getRequisition(reqNo);
    assert.equal(refreshed.materialReq.status, 'ISSUED');
    assert.equal(refreshed.materialReq.mat_req_number, firstMatReq.mat_req_number);
  });
});
