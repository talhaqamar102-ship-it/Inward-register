import {
  buildAlterationRouteSlipHtml,
  buildConfirmDialogHtml,
  buildGrnReceivingSlipHtml,
  buildMaterialRequisitionSlipHtml,
  buildPackingRequisitionSlipHtml,
  calculateSizeTotal,
  createEmptySizes,
  formatBatchSequence,
  formatCurrentDateDDMMYYYY,
  formatSplitAllocationSummary,
  getAlterationReqNumber,
  getDefaultStationForRole,
  getMaterialReqNumber,
  normalizeBaseReqNumber,
  validatePasswordResetInput,
  validateSystemUserInputs
} from '../utils/requisitionLogic';
import type { SystemUserRecord } from '../components/superUserView';
import {
  applyFieldValidationErrors,
  clearFieldValidationError,
  closeModal,
  confirmAndRunAdminAction,
  openModal,
  resolvePendingConfirmDialog,
  runAdminAction,
  showToast
} from '../utils/domModalsAndPrint';
import { renderApp } from '../appContext';
import {
  createEmptyPackingWipState,
  findHallByName,
  getCurrentRollupSummary,
  getOrderSizeCodes,
  logAuditEvent,
  state
} from '../state/appState';
import {
  saveCurrentOrderWipState,
  switchActiveOrder,
  syncBackendData
} from '../state/syncService';
import { openNewRequisitionModal } from './modals/newRequisitionModal';

export interface WindowActionDeps {
  lockCurrentSession: () => Promise<void>;
}

// Global window functions for table row actions
declare global {
  interface Window {
    viewGrnRecord: (sr: number) => void;
    editGrnRecord: (sr: number) => void;
    handleDefectAction: (id: string, actionText: string) => void;
    toggleQcCheck: (id: string) => void;
    adminDeleteRecord: (table: string, id: string) => void;
    adminRemoveDropdownItem: (listKey: 'makers' | 'poList', val: string, triggerEl?: HTMLElement | null) => void;
    adminRemovePendingOrder: (orderId: string, triggerEl?: HTMLElement | null) => void;
    adminForceRepair: (altId: number, isScrap: boolean) => void;
    adminToggleOrderExpand: (orderId: string) => void;
    adminSetAllOrdersExpanded: (expanded: boolean) => void;
    adminInspectOrderInTracking: (orderId: string, highlightRef?: string) => void;
    adminOpenDocumentSlip: (slipType: 'GRN' | 'REQ' | 'M-REQ' | 'A-REQ', refCode: string, orderId?: string) => void;
    adminSetTrackingBuyerFilter: (buyer: string) => void;
    adminSetTrackingMakerFilter: (maker: string) => void;
    adminSetTrackingPage: (page: number) => void;
    adminLoadDemo600Scenario: (phase?: 'IN_PROGRESS' | 'COMPLETED' | 'DELIBERATE_VARIANCE') => Promise<void>;
    adminLoadDemo600PairScenario: (phase?: 'IN_PROGRESS' | 'COMPLETED' | 'DELIBERATE_VARIANCE') => Promise<void>;
    adminRemoveDemo600Scenario: () => void;
    adminVoidGrnBatch: (sr: number, grnCode: string, triggerEl?: HTMLElement | null) => void;
    adminVoidReqBatch: (reqNumber: string, triggerEl?: HTMLElement | null) => void;
    adminCloseOrderShort: (orderId: string, triggerEl?: HTMLElement | null) => void;
    adminAddSystemUser: (triggerEl?: HTMLElement | null) => void;
    adminResetSystemUserPassword: (userId: string, triggerEl?: HTMLElement | null) => void;
    adminDeleteSystemUser: (userId: string, triggerEl?: HTMLElement | null) => Promise<void>;
    adminQuickReceiveGrnForOrder: (orderId: string) => void;
    adminQuickCreateReqForOrder: (orderId: string) => void;
    adminOpenReqInScreen: (reqNumber: string, targetScreen: string) => void;
  }
}

export function registerWindowActions({ lockCurrentSession }: WindowActionDeps): void {
  // --- Section: Tracking & Slip Viewers ---
  window.adminToggleOrderExpand = function(orderId: string) {
    const current = state.adminExpandedOrders[orderId] !== false;
    state.adminExpandedOrders[orderId] = !current;
    renderApp();
  };

  window.adminSetAllOrdersExpanded = function(expanded: boolean) {
    const rollupSummary = getCurrentRollupSummary();
    for (const ord of rollupSummary.orderRollups) {
      state.adminExpandedOrders[ord.orderId] = expanded;
    }
    renderApp();
  };

  window.adminInspectOrderInTracking = function(orderId: string, highlightRef?: string) {
    state.adminActiveTab = 'tracking';
    state.adminTrackingStatusFilter = 'ALL';
    state.adminTrackingBuyerFilter = 'ALL';
    state.adminTrackingMakerFilter = 'ALL';
    state.adminTrackingSearch = highlightRef || orderId;
    state.adminHighlightedRefCode = highlightRef || '';
    state.adminExpandedOrders[orderId] = true;
    for (const ord of state.pendingOrders) {
      if (ord.orderId.startsWith(`${orderId}-`)) {
        state.adminExpandedOrders[ord.orderId] = true;
      }
    }
    renderApp();

    setTimeout(() => {
      const targetEl =
        (highlightRef ? document.getElementById(`tracking-chip-row-${highlightRef}`) : null) ||
        document.getElementById(`tracking-order-card-${orderId}`) ||
        document.querySelector(`[id^="tracking-order-card-${orderId}-"]`);
      if (targetEl && typeof targetEl.scrollIntoView === 'function') {
        targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }, 40);
  };

  window.adminOpenDocumentSlip = function(
    slipType: 'GRN' | 'REQ' | 'M-REQ' | 'A-REQ',
    refCode: string,
    orderId?: string
  ) {
    const summary = getCurrentRollupSummary();
    const matchedOrder =
      summary.orderRollups.find(o => o.orderId === orderId) ||
      summary.orderRollups.find(
        o =>
          o.grnBatches.some(g => g.grnCode === refCode) ||
          o.reqBatches.some(
            r => r.reqNumber === refCode || r.mreqNo === refCode || r.altReqNo === refCode
          )
      );

    if (slipType === 'GRN') {
      const grn =
        matchedOrder?.grnBatches.find(g => g.grnCode === refCode) ||
        state.grnList.find(g => (g.grnCode || formatBatchSequence('GRN', g.sr)) === refCode);
      const linkedPending = state.pendingOrders.find(o => o.orderId === (grn?.pendingOrderId || orderId));
      const slipHtml = buildGrnReceivingSlipHtml({
        grnRef: refCode,
        date: grn?.date || formatCurrentDateDDMMYYYY(),
        pendingOrderId: grn?.pendingOrderId || orderId || '---',
        maker: grn?.maker || matchedOrder?.maker || '---',
        hallName: grn?.hallName || undefined,
        stitcherName: grn?.stitcherName || undefined,
        receivingNote: grn?.receivingNote || undefined,
        article: grn?.article || matchedOrder?.article || '---',
        receivedFrom: grn?.receivedFrom || undefined,
        splitSummary: formatSplitAllocationSummary(linkedPending?.contractorAllocations || matchedOrder?.contractorAllocations) || undefined,
        rcvdPairs: grn?.rcvdPairs || 0,
        sizes: grn?.sizes || createEmptySizes(matchedOrder?.sizeCodes),
        sizeFormat: (grn as any)?.sizeFormat || matchedOrder?.sizeFormat,
        sizeCodes: (grn as any)?.sizeCodes || matchedOrder?.sizeCodes
      });
      openModal(`Inward GRN Receiving Slip — ${refCode}`, slipHtml, true);
      return;
    }

    const baseReq = normalizeBaseReqNumber(refCode);
    const reqBatch = matchedOrder?.reqBatches.find(r => r.reqNumber === baseReq);

    if (slipType === 'M-REQ') {
      const linkedPending = state.pendingOrders.find(o => o.orderId === (matchedOrder?.orderId || orderId));
      const slipHtml = buildMaterialRequisitionSlipHtml({
        mreqNo: getMaterialReqNumber(baseReq),
        reqNo: baseReq,
        orderId: matchedOrder?.orderId || orderId || '---',
        po: (reqBatch as any)?.po || matchedOrder?.po || linkedPending?.po || '---',
        article: reqBatch?.article || matchedOrder?.article || '---',
        pairs: reqBatch?.issuedPairs || reqBatch?.askingPairs || 0,
        status: reqBatch?.mreqStatus || 'Issued'
      });
      openModal(`Material Requisition Slip — ${getMaterialReqNumber(baseReq)}`, slipHtml, true);
      return;
    }

    if (slipType === 'A-REQ') {
      const slipHtml = buildAlterationRouteSlipHtml({
        altReqNo: getAlterationReqNumber(baseReq),
        reqNo: baseReq,
        orderId: matchedOrder?.orderId || orderId || '---',
        article: reqBatch?.article || matchedOrder?.article || '---',
        maker: reqBatch?.maker || matchedOrder?.maker || '---',
        inAlterationPairs: reqBatch?.inAlterationPairs || 0,
        scrappedPairs: reqBatch?.scrappedPairs || 0,
        cycleCount: reqBatch?.alterationCycleCount || 1
      });
      openModal(`Alteration Route Slip — ${getAlterationReqNumber(baseReq)}`, slipHtml, true);
      return;
    }

    const slipHtml = buildPackingRequisitionSlipHtml({
      reqNo: baseReq,
      date: formatCurrentDateDDMMYYYY(),
      article: reqBatch?.article || matchedOrder?.article || '---',
      sizes: reqBatch?.sizes || matchedOrder?.sizes || createEmptySizes(matchedOrder?.sizeCodes),
      totalPairs: reqBatch?.issuedPairs || reqBatch?.askingPairs || 0,
      issueStatus: reqBatch?.issueStatus || 'Issued by Inward Register',
      sizeFormat: matchedOrder?.sizeFormat,
      sizeCodes: matchedOrder?.sizeCodes
    });
    openModal(`Packing Hall Requisition Slip — ${baseReq}`, slipHtml, true);
  };

  window.adminSetTrackingBuyerFilter = function(buyer: string) {
    state.adminTrackingBuyerFilter = buyer || 'ALL';
    state.adminTrackingPage = 1;
    renderApp();
  };

  window.adminSetTrackingMakerFilter = function(maker: string) {
    state.adminTrackingMakerFilter = maker || 'ALL';
    state.adminTrackingPage = 1;
    renderApp();
  };

  window.adminSetTrackingPage = function(page: number) {
    state.adminTrackingPage = Math.max(1, page);
    renderApp();
  };

  // --- Section: Demo Scenario ---
  window.adminLoadDemo600Scenario = async function(
    phase: 'IN_PROGRESS' | 'COMPLETED' | 'DELIBERATE_VARIANCE' = 'COMPLETED'
  ) {
    if (!state.currentUser || state.currentUser.role !== 'SUPER_USER') {
      showToast('Only Super User can load demo scenarios.');
      return;
    }
    const { createDemo600PairScenario } = await import('../utils/requisition/demoScenarios');
    const demo = createDemo600PairScenario(phase);
    state.pendingOrders = [
      demo.order,
      ...state.pendingOrders.filter(o => o.orderId !== demo.order.orderId)
    ];
    state.grnList = [
      ...demo.grns,
      ...state.grnList.filter(g => g.pendingOrderId !== demo.order.orderId)
    ];
    for (const r of demo.reqs) {
      state.ordersWipMap[r.reqNumber] = JSON.parse(JSON.stringify(r));
    }
    state.packingWip = JSON.parse(JSON.stringify(demo.reqs[1])) as any;
    state.packingWip.selectedBatch = demo.reqs[1].reqNumber;
    state.defectList = [
      ...demo.defects.map(d => ({
        id: d.id,
        date: '04-11-2026',
        origin: d.stage,
        article: d.article,
        po: d.po,
        defectClass: d.defect,
        qty: d.qty,
        tailor: 'Master Tailor B',
        status: d.status as any,
        route: d.Action,
        actionText: 'Verified',
        cycles: d.cycles,
        isDemoScenario: true
      })),
      ...state.defectList.filter(d => !(d as any).isDemoScenario && d.id !== 'A-REQ-0902')
    ];
    state.adminExpandedOrders[demo.order.orderId] = true;
    logAuditEvent(
      'ORDER_CREATE',
      demo.order.orderId,
      '0 Prs',
      `Loaded 600-Pair Demo (${phase}): 3 GRNs (600 Prs) -> 3 REQs`,
      demo.order.orderId
    );
    const label =
      phase === 'DELIBERATE_VARIANCE'
        ? 'VARIANCE Δ (-12 Prs • FLOOR_GATE)'
        : phase === 'COMPLETED'
          ? '595 Packed + 5 Scrap = 600 Reconciled ✓'
          : 'Stage 4 Hold + A-REQ Cycle 1/2 Reconciled ✓';
    showToast(`Loaded 1-Order -> 3-GRNs -> 3-REQs (600-Pair) Demo Scenario [${label}].`);
    renderApp();
  };
  window.adminLoadDemo600PairScenario = window.adminLoadDemo600Scenario;

  window.adminRemoveDemo600Scenario = function() {
    state.pendingOrders = state.pendingOrders.filter(
      o => !o.isDemoScenario && o.orderId !== 'ORD-2026-600'
    );
    state.grnList = state.grnList.filter(
      g => !g.isDemoScenario && g.pendingOrderId !== 'ORD-2026-600'
    );
    delete state.ordersWipMap['REQ-0901'];
    delete state.ordersWipMap['REQ-0902'];
    delete state.ordersWipMap['REQ-0903'];
    for (const [k, v] of Object.entries(state.ordersWipMap)) {
      if ((v as any)?.isDemoScenario || v?.parentOrderId === 'ORD-2026-600') {
        delete state.ordersWipMap[k];
      }
    }
    delete state.adminExpandedOrders['ORD-2026-600'];
    const activeWip = state.packingWip as any;
    if (
      activeWip.parentOrderId === 'ORD-2026-600' ||
      activeWip.isDemoScenario ||
      ['REQ-0901', 'REQ-0902', 'REQ-0903'].includes(activeWip.selectedBatch)
    ) {
      state.packingWip = createEmptyPackingWipState();
    }
    state.defectList = state.defectList.filter(
      d => !(d as any).isDemoScenario && d.id !== 'A-REQ-0902'
    );
    showToast('Removed 600-Pair Demo Scenario data.');
    renderApp();
  };

  // --- Section: Voids & Short-Close ---
  window.adminVoidGrnBatch = function(sr: number, grnCode: string, triggerEl?: HTMLElement | null) {
    const item = state.grnList.find(g => g.sr === sr || g.grnCode === grnCode);
    if (!item) return;
    void confirmAndRunAdminAction(
      `admin:void-grn:${grnCode}`,
      triggerEl,
      {
        title: 'Confirm Void GRN Batch',
        message: `Void GRN batch ${grnCode} (${item.rcvdPairs} Prs)?`,
        detail: `Removes ${grnCode} from available Dock stock for Order ${item.pendingOrderId} and records the void in the audit trail.`,
        confirmLabel: 'Void GRN Batch',
        cancelLabel: 'Keep Batch',
        tone: 'danger'
      },
      async () => {
        item.isVoided = true;
        item.status = 'VOIDED';
        logAuditEvent(
          'GRN_VOID',
          grnCode,
          `Received ${item.rcvdPairs} Prs`,
          'VOIDED (0 Prs)',
          item.pendingOrderId
        );
        showToast(`Voided GRN Batch ${grnCode} (${item.rcvdPairs} Prs) and recorded in Audit Trail.`);
        renderApp();
      }
    );
  };

  window.adminVoidReqBatch = function(reqNumber: string, triggerEl?: HTMLElement | null) {
    const norm = normalizeBaseReqNumber(reqNumber);
    void confirmAndRunAdminAction(
      `admin:void-req:${norm}`,
      triggerEl,
      {
        title: 'Confirm Void Requisition',
        message: `Void Requisition ${norm}?`,
        detail: 'Marks this Requisition VOIDED before Stage 1 inspection and records the change in the audit trail.',
        confirmLabel: 'Void Requisition',
        cancelLabel: 'Keep Requisition',
        tone: 'danger'
      },
      async () => {
        if (state.ordersWipMap[norm]) {
          state.ordersWipMap[norm].isVoided = true;
        }
        if (normalizeBaseReqNumber(state.packingWip.selectedBatch) === norm) {
          (state.packingWip as any).isVoided = true;
        }
        logAuditEvent('REQ_VOID', norm, 'Active Requisition', 'VOIDED before Stage 1');
        showToast(`Voided Requisition ${norm} and recorded in Audit Trail.`);
        renderApp();
      }
    );
  };

  window.adminCloseOrderShort = function(orderId: string, triggerEl?: HTMLElement | null) {
    const ord = state.pendingOrders.find(o => o.orderId === orderId);
    if (!ord) return;
    const beforeQty = ord.totalQty || 0;
    void confirmAndRunAdminAction(
      `admin:short-close:${orderId}`,
      triggerEl,
      {
        title: 'Confirm Short-Close Order',
        message: `Short-close Master Order ${orderId}?`,
        detail: `Closes open contractor balance on ${orderId} at received GRN quantity (Planned: ${beforeQty} Prs) and records closure in the audit trail.`,
        confirmLabel: 'Short-Close Order',
        cancelLabel: 'Keep Open',
        tone: 'danger'
      },
      async () => {
        ord.shortClosed = true;
        ord.shortCloseReason = 'Approved Short-Shipment Closure by Super User';
        logAuditEvent(
          'ORDER_SHORT_CLOSE',
          orderId,
          `Planned ${beforeQty} Prs`,
          'Short-Closed at Received GRN Quantity',
          orderId
        );
        showToast(`Order ${orderId} short-closed at received quantity.`);
        renderApp();
      }
    );
  };

  // --- Section: System User Management ---
  window.adminAddSystemUser = async function(triggerEl?: HTMLElement | null) {
    const nameEl = document.getElementById('admin-user-name') as HTMLInputElement | null;
    const usernameEl = document.getElementById('admin-user-username') as HTMLInputElement | null;
    const passwordEl = document.getElementById('admin-user-password') as HTMLInputElement | null;
    const name = nameEl?.value?.trim() || '';
    const username = usernameEl?.value?.trim() || '';
    const password = passwordEl?.value || '';
    const role = ((document.getElementById('admin-user-role') as HTMLSelectElement)?.value ||
      'PACKING_SUPERVISOR') as SystemUserRecord['role'];
    const station =
      (document.getElementById('admin-user-station') as HTMLInputElement)?.value?.trim() ||
      getDefaultStationForRole(role);
    const errors = validateSystemUserInputs({ name, username, password });
    if (applyFieldValidationErrors([
      [nameEl, errors.name],
      [usernameEl, errors.username],
      [passwordEl, errors.password]
    ])) {
      showToast('Review highlighted operator account fields.');
      return;
    }
    await runAdminAction('admin:add-system-user', triggerEl, async () => {
      try {
        const response = await fetch('/api/admin/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, username, password, role, station })
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          throw new Error(result.error || 'Unable to create the account.');
        }

        const usersResponse = await fetch('/api/admin/users');
        const usersResult = await usersResponse.json();
        if (!usersResponse.ok || !usersResult.success || !Array.isArray(usersResult.data)) {
          throw new Error(usersResult.error || 'Account was created, but the account list could not be refreshed.');
        }
        state.systemUsers = usersResult.data;
        showToast(`Created ${role} account for ${name}.`);
        renderApp();
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unable to create the account.';
        applyFieldValidationErrors([[usernameEl, msg]]);
        showToast(msg);
      }
    });
  };

  window.adminResetSystemUserPassword = async function(userId: string, triggerEl?: HTMLElement | null) {
    const passwordInput = Array.from(
      document.querySelectorAll<HTMLInputElement>('[data-admin-user-password]')
    ).find(input => input.dataset.adminUserPassword === userId) || null;
    const password = passwordInput?.value || '';
    const pwError = validatePasswordResetInput(password);
    if (applyFieldValidationErrors([[passwordInput, pwError || undefined]])) {
      showToast(pwError || 'Password must be at least 8 characters.');
      return;
    }
    const targetUser = state.systemUsers.find(u => u.userId === userId);
    const accountLabel = targetUser ? `${targetUser.name} (@${targetUser.username})` : userId;
    await confirmAndRunAdminAction(
      `admin:reset-password:${userId}`,
      triggerEl,
      {
        title: 'Confirm Password Reset',
        message: `Update sign-in password for ${accountLabel}?`,
        detail: 'Changing a password signs this account out immediately on all devices.',
        confirmLabel: 'Update Password',
        cancelLabel: 'Cancel',
        tone: 'danger'
      },
      async () => {
        try {
          const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/password`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password })
          });
          const result = await response.json();
          if (!response.ok || !result.success) {
            throw new Error(result.error || 'Unable to update the account password.');
          }
          if (state.currentUser?.userId === userId) {
            await lockCurrentSession();
            showToast('Password updated. Sign in again with the new password.');
            return;
          }
          showToast('Password updated. The account has been signed out on all devices.');
          renderApp();
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unable to update the account password.';
          applyFieldValidationErrors([[passwordInput, msg]]);
          showToast(msg);
        }
      }
    );
  };

  window.adminDeleteSystemUser = async function(userId: string, triggerEl?: HTMLElement | null) {
    const targetUser = state.systemUsers.find(u => u.userId === userId);
    if (state.currentUser?.userId === userId) {
      showToast('You cannot delete your own active Super User account.');
      return;
    }

    resolvePendingConfirmDialog(false);
    const accountLabel = targetUser
      ? `${targetUser.name} (@${targetUser.username} • ${targetUser.role})`
      : userId;
    const html = buildConfirmDialogHtml({
      message: `Delete user account ${accountLabel}?`,
      detail: 'This permanently deletes the account and revokes all of its active sessions. Enter your Admin password to authorize deletion.',
      confirmLabel: 'Delete User',
      cancelLabel: 'Cancel',
      tone: 'danger',
      passwordField: {
        id: 'confirm-admin-password',
        label: 'Admin Password',
        placeholder: 'Enter your Super User password',
        hint: 'Required to authorize permanent account deletion.'
      }
    });
    openModal('Confirm Delete User Account', html, false, {
      hideGlobalFooter: true,
      returnFocusTarget: triggerEl instanceof HTMLElement ? triggerEl : undefined
    });

    const pwInput = document.getElementById('confirm-admin-password') as HTMLInputElement | null;
    const confirmBtn = document.getElementById('confirm-dialog-confirm') as HTMLButtonElement | null;
    pwInput?.addEventListener('input', () => clearFieldValidationError(pwInput));
    pwInput?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        confirmBtn?.click();
      }
    });

    confirmBtn?.addEventListener('click', () => {
      const adminPassword = pwInput?.value || '';
      if (!adminPassword) {
        applyFieldValidationErrors([[pwInput, 'Enter your Admin password to confirm user deletion.']]);
        showToast('Enter your Admin password to confirm user deletion.');
        return;
      }

      void runAdminAction(`admin:delete-user:${userId}`, confirmBtn, async () => {
        try {
          const response = await fetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adminPassword })
          });
          const result = await response.json();
          if (!response.ok || !result.success) {
            throw new Error(result.error || 'Incorrect Admin password. User was not deleted.');
          }
          state.systemUsers = Array.isArray(result.data?.users)
            ? result.data.users
            : state.systemUsers.filter(u => u.userId !== userId);
          logAuditEvent(
            'USER_DELETE',
            targetUser?.username || userId,
            targetUser?.role || 'USER',
            'Deleted by Super User'
          );
          closeModal();
          showToast(`Deleted user account ${targetUser ? targetUser.name : userId}.`);
          renderApp();
        } catch (error) {
          const msg = error instanceof Error ? error.message : 'Unable to delete user account.';
          applyFieldValidationErrors([[pwInput, msg]]);
          showToast(msg);
        }
      });
    });
  };

  // --- Section: Quick Order Navigation & Deletion ---
  window.adminQuickReceiveGrnForOrder = function(orderId: string) {
    const order = state.pendingOrders.find(o => o.orderId === orderId);
    if (order) {
      const allocs = order.contractorAllocations || [];
      const scaleCodes = getOrderSizeCodes(order.orderId, order.sizeCodes, order.sizeFormat);
      const hasSplit = allocs.length > 1;
      if (hasSplit) {
        state.grnForm = {
          pendingOrderId: order.orderId,
          maker: '',
          hallName: '',
          stitcherName: '',
          article: order.article,
          color: order.color || 'Standard',
          receivedFrom: '',
          rcvdPairs: '',
          sizeFormat: order.sizeFormat || 'LEGACY_7_11',
          sizeCodes: scaleCodes,
          sizes: createEmptySizes(scaleCodes),
          splitRows: allocs.map(a => {
            const matchedHall = findHallByName(a.maker);
            return {
              maker: a.maker,
              hallName: matchedHall && matchedHall.stitchers.length > 0 ? matchedHall.name : '',
              stitcherName: '',
              receivedFrom: '',
              sizes: createEmptySizes(scaleCodes)
            };
          })
        };
      } else {
        const activeAlloc = allocs.length === 1 ? allocs[0] : null;
        const defaultMaker = activeAlloc ? activeAlloc.maker : order.maker;
        const defaultSizes = activeAlloc ? (activeAlloc.remainingSizes || activeAlloc.sizes) : (order.sizes || createEmptySizes(scaleCodes));
        const matchedHall = findHallByName(defaultMaker);
        const hasHallStitchers = Boolean(matchedHall && matchedHall.stitchers.length > 0);
        state.grnForm = {
          pendingOrderId: order.orderId,
          maker: defaultMaker,
          hallName: hasHallStitchers ? matchedHall!.name : '',
          stitcherName: '',
          article: order.article,
          color: order.color || 'Standard',
          receivedFrom: hasHallStitchers ? '' : (defaultMaker ? `${defaultMaker} Representative` : ''),
          rcvdPairs: String(calculateSizeTotal(defaultSizes) || order.totalQty || ''),
          sizeFormat: order.sizeFormat || 'LEGACY_7_11',
          sizeCodes: scaleCodes,
          sizes: { ...defaultSizes },
          splitRows: []
        };
      }
    } else {
      state.grnForm.pendingOrderId = orderId;
    }
    state.activeScreen = 'screen-grn';
    renderApp();
    showToast(`Loaded Order ${orderId} into Inward Dock to receive next GRN-000X batch.`);
  };

  window.adminQuickCreateReqForOrder = function(orderId: string) {
    state.activeScreen = 'screen-packing';
    renderApp();
    openNewRequisitionModal(orderId);
  };

  window.adminOpenReqInScreen = function(reqNumber: string, targetScreen: string) {
    switchActiveOrder(reqNumber);
    if (targetScreen === 'screen-qc' && (!state.currentUser || state.currentUser.role === 'SUPER_USER')) {
      state.adminQcDispatchSelectedReq = normalizeBaseReqNumber(reqNumber);
      state.adminQcDispatchOrderFilter = '';
      state.activeScreen = 'screen-admin';
      state.adminActiveTab = 'qc-dispatch';
      renderApp();
      showToast(`Opened Requisition ${normalizeBaseReqNumber(reqNumber)} in QC & Dispatch.`);
      return;
    }
    state.activeScreen = targetScreen;
    renderApp();
    showToast(`Opened Requisition ${normalizeBaseReqNumber(reqNumber)} in ${targetScreen.replace('screen-', '').toUpperCase()}.`);
  };

  window.adminRemovePendingOrder = async function(orderId: string, triggerEl?: HTMLElement | null) {
    await confirmAndRunAdminAction(
      `admin:remove-order:${orderId}`,
      triggerEl,
      {
        title: 'Confirm Delete Master Order',
        message: `Delete Master Order ${orderId}?`,
        detail: 'Removes this Master Order permanently from the SQLite database.',
        confirmLabel: 'Delete Order',
        cancelLabel: 'Keep Order',
        tone: 'danger'
      },
      async () => {
        try {
          const res = await fetch(`/api/admin/pending-orders/${encodeURIComponent(orderId)}`, {
            method: 'DELETE'
          });
          const json = await res.json();
          if (!res.ok || !json.success || !Array.isArray(json.data)) {
            showToast(json.error || `Order ${orderId} could not be deleted.`);
            return;
          }
          state.pendingOrders = json.data;
          showToast(`Removed Order ${orderId} from SQLite Database.`);
          renderApp();
        } catch (error) {
          console.error('Order deletion failed:', error);
          showToast(`Order ${orderId} could not be deleted. No local data was removed.`);
        }
      }
    );
  };

  window.adminDeleteRecord = async function(table: string, id: string) {
    try {
      const res = await fetch(`/api/admin/record/${table}/${encodeURIComponent(id)}`, {
        method: 'DELETE'
      });
      const json = await res.json();
      if (json.success) {
        showToast(`Deleted record [${id}] from ${table}.`);
        await syncBackendData();
      } else {
        showToast(`Delete error: ${json.error}`);
      }
    } catch (e) {
      console.warn(e);
    }
  };

  window.adminRemoveDropdownItem = async function(
    listKey: 'makers' | 'poList',
    val: string,
    triggerEl?: HTMLElement | null
  ) {
    const listLabel = listKey === 'makers' ? 'Contractors / Makers' : 'Purchase Order #';
    await confirmAndRunAdminAction(
      `admin:remove-dropdown:${listKey}:${val}`,
      triggerEl,
      {
        title: 'Confirm Remove Registry Item',
        message: `Remove "${val}" from ${listLabel}?`,
        detail: 'Future forms will no longer suggest this entry in global dropdowns.',
        confirmLabel: 'Remove Entry',
        cancelLabel: 'Keep Entry',
        tone: 'danger'
      },
      async () => {
        state.dropdownOptions[listKey] = state.dropdownOptions[listKey].filter(item => item !== val);
        showToast(`Removed "${val}" from dropdown options.`);
        renderApp();
      }
    );
  };

  window.adminForceRepair = async function(altId: number, isScrap: boolean) {
    try {
      const res = await fetch(`/api/alterations/${altId}/repair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tailorName: 'Supervisor A',
          isScrap,
          deductionRate: 150
        })
      });
      const json = await res.json();
      if (json.success) {
        showToast(isScrap ? `Alteration #${altId} condemned to Scrap Ledger.` : `Alteration #${altId} returned to Stage 1 Checking.`);
        await syncBackendData();
      }
    } catch (e) {
      console.warn(e);
    }
  };

  // --- Section: Legacy Table Row Actions ---
  window.viewGrnRecord = function(sr: number) {
    const item = state.grnList.find(r => r.sr === sr);
    if (item) {
      const grnCode = item.grnCode || formatBatchSequence('GRN', item.sr);
      const linkedOrder = state.pendingOrders.find(o => o.orderId === item.pendingOrderId);
      const slipHtml = buildGrnReceivingSlipHtml({
        grnRef: grnCode,
        date: item.date,
        pendingOrderId: item.pendingOrderId,
        maker: item.maker,
        hallName: item.hallName || undefined,
        stitcherName: item.stitcherName || undefined,
        receivingNote: item.receivingNote || undefined,
        article: item.article,
        color: item.color,
        receivedFrom: item.receivedFrom,
        splitSummary: formatSplitAllocationSummary(linkedOrder?.contractorAllocations) || undefined,
        rcvdPairs: item.rcvdPairs,
        sizes: item.sizes,
        sizeFormat: item.sizeFormat || linkedOrder?.sizeFormat,
        sizeCodes: item.sizeCodes || linkedOrder?.sizeCodes
      });
      openModal(`GRN Record ${grnCode}`, slipHtml, true);
    }
  };

  window.editGrnRecord = function(sr: number) {
    const item = state.grnList.find(r => r.sr === sr);
    if (item) {
      state.grnForm = {
        pendingOrderId: item.pendingOrderId,
        maker: item.maker,
        hallName: item.hallName || '',
        stitcherName: item.stitcherName || '',
        article: item.article,
        color: item.color || 'Standard',
        receivedFrom: item.receivingNote || item.receivedFrom || item.maker || '',
        rcvdPairs: String(item.rcvdPairs),
        sizeFormat: item.sizeFormat || 'LEGACY_7_11',
        sizeCodes: item.sizeCodes,
        sizes: { ...item.sizes },
        splitRows: []
      };
      renderApp();
      showToast(`Loaded Record #${sr} into editor form.`);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  window.handleDefectAction = function(id: string, actionText: string) {
    showToast(`Action "${actionText}" executed for Alteration Record ${id}.`);
  };

  window.toggleQcCheck = function(id: string) {
    const item = state.qcChecklist.find(c => c.id === id);
    if (item) {
      item.passed = !item.passed;
      const allPassed = state.qcChecklist.every(c => c.passed);
      state.packingWip.finalQcApproved = allPassed;
      saveCurrentOrderWipState();
      renderApp();
    }
  };
}
