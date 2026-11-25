import { normalizeBaseReqNumber, parseProductColorOptions, sumContractorAllocationSizes } from '../utils/requisitionLogic';
import {
  applyFieldValidationErrors,
  clearFieldValidationError,
  confirmAndRunAdminAction,
  openModal,
  closeModal,
  runAdminAction,
  showToast
} from '../utils/domModalsAndPrint';
import { renderApp } from '../appContext';
import { state, getOrderSizeCodes } from '../state/appState';
import { syncBackendData } from '../state/syncService';
import { openAssignRemainingOrderModal } from '../components/superUser/assignRemainingModal';
import { attachQcDispatchTabHandlers } from './qcDispatchHandlers';
import { attachAdminTrackingHandlers, attachAdminUsersHandlers } from './admin/trackingAndUsersHandlers';
import { attachAdminReportsAndDbHandlers } from './admin/reportsAndDbHandlers';
import { attachAdminMasterRegistryHandlers } from './admin/masterRegistryHandlers';
import {
  attachAdminOrderCreationHandlers,
  openEditPendingOrderModal,
  syncAdminOrderDraftFromDom
} from './admin/orderCreationHandlers';

/** Attach all Super User Admin tab navigation, action delegation, and tab-specific event handlers. */
export function attachAdminHandlers(): void {
  document.querySelectorAll('.admin-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = (e.currentTarget as HTMLElement).getAttribute('data-admin-tab') as any;
      if (tab) {
        if (tab === 'qc-dispatch') {
          state.adminQcDispatchOrderFilter = '';
        }
        state.adminActiveTab = tab;
        renderApp();
        if (tab === 'qc-dispatch') {
          void syncBackendData();
        }
      }
    });
  });

  attachQcDispatchTabHandlers();

  document.getElementById('btn-admin-nav-toggle')?.addEventListener('click', () => {
    state.adminNavCollapsed = !state.adminNavCollapsed;
    renderApp();
  });

  document.querySelectorAll('[data-admin-tab-jump]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const tab = (e.currentTarget as HTMLElement).getAttribute('data-admin-tab-jump') as any;
      if (tab) {
        state.adminActiveTab = tab;
        renderApp();
      }
    });
  });

  for (const fieldId of [
    'admin-pending-order-maker',
    'admin-pending-order-article',
    'admin-cust-name',
    'admin-prod-name',
    'admin-carton-stickers',
    'admin-carton-pairs',
    'admin-user-name',
    'admin-user-username',
    'admin-user-password'
  ]) {
    const field = document.getElementById(fieldId);
    const eventType = field instanceof HTMLSelectElement ? 'change' : 'input';
    field?.addEventListener(eventType, () => clearFieldValidationError(field));
  }

  document.querySelectorAll<HTMLElement>('[data-su-action]').forEach(el => {
    el.addEventListener('click', (e) => {
      if ((e.target as Element | null)?.closest('[data-su-action]') !== el) return;
      if (el.closest('summary')) {
        e.preventDefault();
        e.stopPropagation();
      }
      const action = el.dataset.suAction;
      switch (action) {
        case 'inspect-order': {
          const orderId = el.dataset.orderId;
          if (orderId) window.adminInspectOrderInTracking(orderId, el.dataset.refCode || undefined);
          break;
        }
        case 'open-slip': {
          const slipType = el.dataset.slipType as 'GRN' | 'REQ' | 'M-REQ' | 'A-REQ' | undefined;
          const refCode = el.dataset.refCode;
          if (slipType && refCode) void window.adminOpenDocumentSlip(slipType, refCode, el.dataset.orderId || undefined);
          break;
        }
        case 'open-req-screen': {
          const reqNumber = el.dataset.reqNumber;
          const targetScreen = el.dataset.targetScreen as 'screen-qc' | 'screen-repair' | 'screen-packing' | 'screen-grn' | undefined;
          if (reqNumber && targetScreen) window.adminOpenReqInScreen(reqNumber, targetScreen);
          break;
        }
        case 'open-qc-dispatch': {
          state.adminActiveTab = 'qc-dispatch';
          if (el.dataset.reqNumber) {
            state.adminQcDispatchSelectedReq = normalizeBaseReqNumber(el.dataset.reqNumber);
            state.adminQcDispatchOrderFilter = '';
          } else {
            state.adminQcDispatchOrderFilter = el.dataset.orderId || '';
          }
          renderApp();
          break;
        }
        case 'load-demo': {
          const demoPhase = el.dataset.demoPhase as 'IN_PROGRESS' | 'COMPLETED' | 'DELIBERATE_VARIANCE' | undefined;
          if (demoPhase) void window.adminLoadDemo600Scenario(demoPhase);
          break;
        }
        case 'remove-demo':
          void window.adminRemoveDemo600Scenario();
          break;
        case 'expand-all':
          window.adminSetAllOrdersExpanded(el.dataset.expanded === 'true');
          break;
        case 'toggle-order-size-chips': {
          const orderId = el.dataset.orderId;
          if (orderId) {
            state.adminExpandedOrderSizeChips[orderId] = !state.adminExpandedOrderSizeChips[orderId];
            renderApp();
          }
          break;
        }
        case 'create-article-for-buyer': {
          const buyerId = (el.dataset.buyerId || '').trim();
          const buyerName = (el.dataset.buyerName || '').trim().toLowerCase();
          const matchedCust = (state.adminOverview.customers || []).find(
            (c: any) => (buyerId && c.id === buyerId) || (buyerName && String(c.name || '').trim().toLowerCase() === buyerName)
          );
          const resolvedCustomerId = matchedCust?.id || buyerId || state.adminOrderDraft.customerId || '';
          state.adminActiveRegistryTab = 'articles';
          if (resolvedCustomerId) {
            state.adminArticleDraftCustomerId = resolvedCustomerId;
          }
          renderApp();
          const articlePanel = document.querySelector<HTMLElement>('.su-reg-panel[data-registry-id="articles"]');
          if (articlePanel) {
            articlePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          const custSelect = document.getElementById('admin-prod-cust') as HTMLSelectElement | null;
          if (custSelect && resolvedCustomerId) {
            custSelect.value = resolvedCustomerId;
          }
          (document.getElementById('admin-prod-name') as HTMLInputElement | null)?.focus();
          break;
        }
        case 'tracking-page': {
          const page = Number(el.dataset.page);
          if (Number.isFinite(page)) window.adminSetTrackingPage(page);
          break;
        }
        case 'toggle-order-expand': {
          const orderId = el.dataset.orderId;
          if (orderId) window.adminToggleOrderExpand(orderId);
          break;
        }
        case 'quick-receive-grn': {
          const orderId = el.dataset.orderId;
          if (orderId) window.adminQuickReceiveGrnForOrder(orderId);
          break;
        }
        case 'quick-create-req': {
          const orderId = el.dataset.orderId;
          if (orderId) window.adminQuickCreateReqForOrder(orderId);
          break;
        }
        case 'short-close-order': {
          const orderId = el.dataset.orderId;
          if (orderId) void window.adminCloseOrderShort(orderId, el);
          break;
        }
        case 'void-grn': {
          const sr = Number(el.dataset.grnSr);
          const grnCode = el.dataset.grnCode;
          if (Number.isFinite(sr) && grnCode) void window.adminVoidGrnBatch(sr, grnCode, el);
          break;
        }
        case 'void-req': {
          const reqNumber = el.dataset.reqNumber;
          if (reqNumber) void window.adminVoidReqBatch(reqNumber, el);
          break;
        }
        case 'remove-pending-order': {
          const orderId = el.dataset.orderId;
          if (orderId) void window.adminRemovePendingOrder(orderId, el);
          break;
        }
        case 'edit-pending-order': {
          const orderId = el.dataset.orderId;
          if (orderId) openEditPendingOrderModal(orderId);
          break;
        }
        case 'assign-remaining-order': {
          const orderId = el.dataset.orderId;
          const order = orderId ? state.pendingOrders.find(o => o.orderId === orderId) : undefined;
          if (!order) break;
          const sizeCodes = getOrderSizeCodes(order.orderId, order.sizeCodes, order.sizeFormat);
          openAssignRemainingOrderModal({
            order,
            sizeCodes,
            makers: state.dropdownOptions.makers,
            halls: state.dropdownOptions.halls,
            externalMakers: state.dropdownOptions.externalMakers,
            openModal,
            closeModal,
            showToast,
            onSaved: async (updatedOrders) => {
              state.pendingOrders = updatedOrders;
              renderApp();
              await syncBackendData();
            }
          });
          break;
        }
        case 'duplicate-article-colour': {
          const lineIdx = Number(el.dataset.lineIndex);
          const baseLine = Number.isInteger(lineIdx) ? state.adminOrderArticleLines[lineIdx] : undefined;
          if (!baseLine) break;
          syncAdminOrderDraftFromDom();
          const refreshedBase = state.adminOrderArticleLines[lineIdx];
          if (!refreshedBase) break;
          const prod = (state.adminOverview.products || []).find((p: any) =>
            refreshedBase.productId ? p.id === refreshedBase.productId : p.name === refreshedBase.article
          );
          const colorOptions = parseProductColorOptions(prod);
          const usedColors = new Set(
            state.adminOrderArticleLines
              .filter(l => (refreshedBase.productId ? l.productId === refreshedBase.productId : l.article === refreshedBase.article))
              .map(l => String(l.color || '').trim().toLowerCase())
          );
          const nextColor = colorOptions.find(c => !usedColors.has(c.trim().toLowerCase())) || '';
          const nextSizes: Record<string, number> = {};
          for (const k of Object.keys(refreshedBase.sizes || {})) nextSizes[k] = 0;
          state.adminOrderArticleLines.splice(lineIdx + 1, 0, {
            lineId: `${refreshedBase.productId || refreshedBase.article}-c${Date.now().toString(36)}`,
            productId: refreshedBase.productId,
            article: refreshedBase.article,
            color: nextColor,
            sizeFormat: refreshedBase.sizeFormat,
            maker: state.adminOrderDraft.maker || refreshedBase.maker || '',
            dueDate: state.adminOrderDraft.dueDate || refreshedBase.dueDate || '',
            splitTargetMode: 'auto',
            sizes: nextSizes,
            splitRows: []
          });
          renderApp();
          break;
        }
        case 'delete-maker': {
          const makerId = Number(el.dataset.makerId);
          const makerName = el.dataset.makerName || 'Contractor';
          if (!Number.isInteger(makerId) || makerId <= 0) break;
          void confirmAndRunAdminAction(
            `admin:delete-maker:${makerId}`,
            el,
            {
              title: 'Confirm Remove Contractor / Maker',
              message: `Remove Contractor "${makerName}"?`,
              detail: `Removes "${makerName}" permanently from the Contractors / Makers registry and future Order dropdowns. Past orders and GRNs keep their recorded labels.`,
              confirmLabel: 'Remove Contractor',
              cancelLabel: 'Keep Contractor',
              tone: 'danger'
            },
            async () => {
              const res = await fetch(`/api/admin/makers/${encodeURIComponent(String(makerId))}`, { method: 'DELETE' });
              const json = await res.json();
              if (!res.ok || !json.success) {
                showToast(json.error || `Unable to remove Contractor "${makerName}".`);
                return;
              }
              if (Array.isArray(json.data?.externalMakers)) {
                state.dropdownOptions.externalMakers = json.data.externalMakers;
              }
              if (Array.isArray(json.data?.makers)) {
                state.dropdownOptions.makers = json.data.makers;
              }
              showToast(`Removed Contractor "${makerName}".`);
              renderApp();
              await syncBackendData();
            }
          );
          break;
        }
        case 'remove-split-row': {
          const splitIdx = Number(el.dataset.splitIndex);
          if (Number.isInteger(splitIdx) && state.adminOrderSplitRows.length > 1) {
            syncAdminOrderDraftFromDom();
            state.adminOrderSplitRows.splice(splitIdx, 1);
            if (state.adminOrderSplitTargetMode === 'auto') {
              const activeCodes = getOrderSizeCodes(
                undefined,
                undefined,
                state.adminOrderDraft.sizeFormat || 'LEGACY_7_11'
              );
              state.adminOrderDraft.sizes = sumContractorAllocationSizes(state.adminOrderSplitRows, activeCodes);
            }
            renderApp();
          }
          break;
        }
        case 'remove-article-line': {
          const lineIdx = Number(el.dataset.lineIndex);
          if (Number.isInteger(lineIdx) && state.adminOrderArticleLines[lineIdx]) {
            syncAdminOrderDraftFromDom();
            state.adminOrderArticleLines.splice(lineIdx, 1);
            renderApp();
          }
          break;
        }
        case 'add-system-user':
          void window.adminAddSystemUser(el);
          break;
        case 'add-stitcher': {
          const hallId = Number(el.dataset.hallId);
          const input = document.querySelector<HTMLInputElement>(`[data-hall-stitcher-input="${hallId}"]`);
          const stitcherName = input?.value?.trim() || '';
          if (!Number.isInteger(hallId) || hallId <= 0 || !stitcherName) {
            applyFieldValidationErrors([[input || null, stitcherName ? '' : 'Enter stitcher name.']]);
            showToast('Enter a stitcher name to add to this Hall.');
            break;
          }
          void runAdminAction(`admin:add-stitcher:${hallId}`, el, async () => {
            try {
              const res = await fetch(`/api/admin/halls/${encodeURIComponent(String(hallId))}/stitchers`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: stitcherName })
              });
              const json = await res.json();
              if (!res.ok || !json.success || !json.data) {
                showToast(json.error || 'Unable to add stitcher.');
                return;
              }
              if (Array.isArray(json.data.halls)) {
                state.dropdownOptions.halls = json.data.halls;
              }
              if (input) input.value = '';
              showToast(`Added Stitcher "${stitcherName}" to ${json.data.hallName || 'Hall'}.`);
              renderApp();
              await syncBackendData();
            } catch (err) {
              console.warn('Add stitcher failed:', err);
              showToast('Failed to add stitcher.');
            }
          });
          break;
        }
        case 'delete-hall': {
          const hallId = Number(el.dataset.hallId);
          const hallName = el.dataset.hallName || 'Hall';
          const stitcherCount = Number(el.dataset.stitcherCount || 0);
          if (!Number.isInteger(hallId) || hallId <= 0) break;
          void confirmAndRunAdminAction(
            `admin:delete-hall:${hallId}`,
            el,
            {
              title: 'Confirm Remove Hall',
              message: `Remove Hall "${hallName}"?`,
              detail: stitcherCount > 0
                ? `Removes ${hallName} and its ${stitcherCount} assigned stitcher${stitcherCount === 1 ? '' : 's'} from the Hall -> Stitcher registry. Past GRN history rows keep their recorded labels.`
                : `Removes ${hallName} from the Hall registry.`,
              confirmLabel: 'Remove Hall',
              cancelLabel: 'Keep Hall',
              tone: 'danger'
            },
            async () => {
              const res = await fetch(`/api/admin/halls/${encodeURIComponent(String(hallId))}`, { method: 'DELETE' });
              const json = await res.json();
              if (!res.ok || !json.success) {
                showToast(json.error || `Unable to remove Hall "${hallName}".`);
                return;
              }
              if (Array.isArray(json.data?.halls)) {
                state.dropdownOptions.halls = json.data.halls;
              }
              state.dropdownOptions.makers = state.dropdownOptions.makers.filter(
                m => m.trim().toLowerCase() !== hallName.trim().toLowerCase()
              );
              showToast(`Removed Hall "${hallName}".`);
              renderApp();
              await syncBackendData();
            }
          );
          break;
        }
        case 'delete-stitcher': {
          const stitcherId = Number(el.dataset.stitcherId);
          const stitcherName = el.dataset.stitcherName || 'Stitcher';
          const hallName = el.dataset.hallName || 'Hall';
          if (!Number.isInteger(stitcherId) || stitcherId <= 0) break;
          void confirmAndRunAdminAction(
            `admin:delete-stitcher:${stitcherId}`,
            el,
            {
              title: 'Confirm Remove Stitcher',
              message: `Remove "${stitcherName}" from ${hallName}?`,
              detail: 'Existing GRN history rows keep this stitcher name, and future receipts will no longer list them.',
              confirmLabel: 'Remove Stitcher',
              cancelLabel: 'Keep Stitcher',
              tone: 'danger'
            },
            async () => {
              const res = await fetch(`/api/admin/stitchers/${encodeURIComponent(String(stitcherId))}`, { method: 'DELETE' });
              const json = await res.json();
              if (!res.ok || !json.success) {
                showToast(json.error || `Unable to remove Stitcher "${stitcherName}".`);
                return;
              }
              if (Array.isArray(json.data?.halls)) {
                state.dropdownOptions.halls = json.data.halls;
              }
              showToast(`Removed Stitcher "${stitcherName}" from ${hallName}.`);
              renderApp();
              await syncBackendData();
            }
          );
          break;
        }
      }
    });
  });

  attachAdminTrackingHandlers();
  attachAdminUsersHandlers();
  attachAdminReportsAndDbHandlers();
  attachAdminMasterRegistryHandlers();
  attachAdminOrderCreationHandlers();
}
