/**
 * Hammad Industries - Factory ERP & QA Management Portal
 * Tech Stack: Pure Vanilla HTML5 / CSS / JavaScript (Zero External Libraries)
 * Clean Real Data Entry Mode: All mockup details removed; unified Requisition with M/A prefixes.
 */

import {
  createEmptySizes,
  getAlterationReqNumber,
  escapeHtml
} from './utils/requisitionLogic';
import { renderSuperUserScreen } from './components/superUserView';
import { renderPackingHallScreen } from './components/packingHallView';
import {
  showToast,
  closeModal,
  printDocument,
  captureRenderFocusTarget,
  restoreRenderFocusTarget,
  RenderAppOptions,
  captureDirtyFormDrafts,
  restoreDirtyFormDrafts
} from './utils/domModalsAndPrint';
import {
  screenForRole,
  stationName,
  renderAuthScreen as renderAuthViewHtml,
  renderModuleSwitcher as renderModuleSwitcherHtml,
  renderModalContainer
} from './components/authView';
import { renderInwardRegisterScreen } from './components/inwardRegisterView';
import { renderRepairScreen, renderQcScreen } from './components/repairAndQcViews';
import { setRenderer } from './appContext';
import {
  DEFAULT_REQ_NUMBER,
  createEmptyPackingWipState,
  state,
  getOrderSizeCodes,
  getGrnRemainingCaps,
  formatGrnRemainingCaps,
  getTotalIssuedPairs,
  getOrderStockState,
  getCurrentRollupSummary
} from './state/appState';
import {
  startSilentHandoffPolling,
  stopSilentHandoffPolling,
  syncBackendData
} from './state/syncService';
import {
  buildQcDispatchRows,
  attachQCHandlers,
  openAqlCalculatorModal
} from './handlers/qcDispatchHandlers';
import { attachGRNHandlers } from './handlers/inwardHandlers';
import { attachRepairHandlers } from './handlers/repairHandlers';
import { attachPackingHandlers } from './handlers/packingHandlers';
import { openNewRequisitionModal } from './handlers/modals/newRequisitionModal';
import { openDocumentCenterModal } from './handlers/modals/documentCenterModal';
import { remainingStagePairs } from './utils/stageInputs';
import { attachAdminHandlers } from './handlers/adminHandlers';
import { registerWindowActions } from './handlers/windowActions';

function renderAuthScreen(): string { return renderAuthViewHtml(state); }
function renderModuleSwitcher(): string { return renderModuleSwitcherHtml(state); }

function renderScreenGRN(): string {
  return renderInwardRegisterScreen({
    state,
    getOrderSizeCodes,
    getGrnRemainingCaps,
    formatGrnRemainingCaps,
    getOrderStockState,
    getTotalIssuedPairs,
    rollupSummary: getCurrentRollupSummary()
  });
}

// ==========================================
// SCREEN: Packing Hall Portal & 5-Stage WIP Flow
// ==========================================
function renderScreenPacking(): string {
  return renderPackingHallScreen({
    wip: state.packingWip as any,
    defaultReqNumber: DEFAULT_REQ_NUMBER,
    ordersWipMap: state.ordersWipMap,
    persistedReqNumbers: state.persistedReqNumbers,
    pendingOrders: state.pendingOrders,
    defectList: state.defectList,
    cartons: state.cartons,
    rollupSummary: getCurrentRollupSummary(),
    getOrderAvailableDockPairs: (orderId: string) => getOrderStockState(orderId).availablePairs,
    getOrderUnclaimedDockPairs: (orderId: string) => getOrderStockState(orderId).unclaimedPairs,
    remainingStagePairs,
    escapeHtml,
    isSuperUser: !state.currentUser || state.currentUser.role === 'SUPER_USER',
    isInitialSyncing: state.isInitialSyncing,
    isManualSync: state.isManualSync,
    syncError: state.syncError
  });
}

function renderScreenRepair(): string { return renderRepairScreen(state); }
function renderScreenQC(): string { return renderQcScreen(state); }

// ==========================================
// SCREEN 6: Super User Control Center (Dashboard, Live Tracking, QC & Dispatch, Order Creation, User Management, Reports)
// ==========================================
function renderScreenAdmin(): string {
  const rollupSummary = getCurrentRollupSummary();

  return renderSuperUserScreen({
    activeTab: state.adminActiveTab,
    adminNavCollapsed: state.adminNavCollapsed,
    locationSearch: typeof window !== 'undefined' ? window.location.search : '',
    activeReport: state.adminActiveReport,
    trackingSearch: state.adminTrackingSearch,
    trackingStatusFilter: state.adminTrackingStatusFilter,
    trackingBuyerFilter: state.adminTrackingBuyerFilter,
    trackingMakerFilter: state.adminTrackingMakerFilter,
    trackingPage: state.adminTrackingPage,
    trackingPageSize: state.adminTrackingPageSize,
    highlightedRefCode: state.adminHighlightedRefCode,
    expandedOrderIds: state.adminExpandedOrders,
    pendingOrders: state.pendingOrders,
    dropdownOptions: {
      makers: state.dropdownOptions.makers,
      externalMakers: state.dropdownOptions.externalMakers,
      customers: state.dropdownOptions.customers,
      articles: state.dropdownOptions.articles,
      poList: state.dropdownOptions.poList,
      halls: state.dropdownOptions.halls
    },
    systemUsers: state.systemUsers,
    currentUserId: state.currentUser?.userId,
    auditTrail: state.auditTrail,
    adminOverview: state.adminOverview,
    lastBackupPath: state.lastBackupPath,
    rollupSummary,
    orderDraft: state.adminOrderDraft,
    orderSplitRows: state.adminOrderSplitRows,
    orderSplitTargetMode: state.adminOrderSplitTargetMode,
    orderArticleLines: state.adminOrderArticleLines,
    multiArticlePickerOpen: state.adminMultiArticlePickerOpen,
    multiArticleSearch: state.adminMultiArticleSearch,
    openRegistryIds: state.adminOpenRegistries,
    activeRegistryTab: state.adminActiveRegistryTab,
    expandedOrderSizeChips: state.adminExpandedOrderSizeChips,
    articleDraftCustomerId: state.adminArticleDraftCustomerId,
    articleColorDraftOptions: state.adminArticleColorDraftOptions,
    articleColorSelectedPresets: state.adminArticleColorSelectedPresets,
    qcDispatchRows: buildQcDispatchRows(),
    qcDispatchSelectedReq: state.adminQcDispatchSelectedReq,
    qcDispatchOrderFilter: state.adminQcDispatchOrderFilter
  });
}

// Global modal container template

// Main rendering engine
function renderApp(options: RenderAppOptions = {}): void {
  const root = document.getElementById('root');
  if (!root) return;
  const focusSnapshot = captureRenderFocusTarget(root);
  const draftSnapshots = options.preserveInitialSyncDrafts ? captureDirtyFormDrafts(root) : [];
  root.dataset.syncReady = state.authMode === 'ready' && state.hasCompletedInitialSync && !state.isInitialSyncing ? 'true' : 'false';

  if (state.authMode !== 'ready' || !state.currentUser) {
    root.innerHTML = renderAuthScreen();
    attachEventHandlers();
    restoreRenderFocusTarget(root, focusSnapshot);
    return;
  }

  if (state.currentUser.role === 'INWARD_CLERK') {
    if (!['screen-grn', 'screen-repair'].includes(state.activeScreen)) {
      state.activeScreen = 'screen-grn';
    }
  } else if (state.currentUser.role !== 'SUPER_USER') {
    state.activeScreen = screenForRole(state.currentUser.role);
  } else if (!['screen-grn', 'screen-packing', 'screen-repair', 'screen-qc', 'screen-admin'].includes(state.activeScreen)) {
    state.activeScreen = 'screen-admin';
  }

  let screenHTML = '';
  if (state.activeScreen === 'screen-grn') {
    screenHTML = renderScreenGRN();
  } else if (state.activeScreen === 'screen-packing') {
    screenHTML = renderScreenPacking();
  } else if (state.activeScreen === 'screen-repair') {
    screenHTML = renderScreenRepair();
  } else if (state.activeScreen === 'screen-qc') {
    screenHTML = renderScreenQC();
  } else if (state.activeScreen === 'screen-admin') {
    screenHTML = renderScreenAdmin();
  }

  root.innerHTML = `
    ${renderModuleSwitcher()}
    ${screenHTML}
    ${renderModalContainer()}
  `;

  attachEventHandlers();
  if (draftSnapshots.length > 0) {
    restoreDirtyFormDrafts(root, draftSnapshots);
  }
  restoreRenderFocusTarget(root, focusSnapshot);
}

async function initializeAuth(): Promise<void> {
  state.authMode = 'checking';
  renderApp();
  try {
    const response = await fetch('/api/auth/status');
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to check sign-in status.');
    }

    if (result.data.user) {
      state.currentUser = result.data.user;
      state.authMode = 'ready';
      state.activeScreen = screenForRole(state.currentUser!.role);
    } else {
      state.authMode = result.data.initialized ? 'login' : 'setup';
    }
    state.authError = '';
    renderApp();
    if (state.currentUser) {
      await syncBackendData();
      startSilentHandoffPolling();
    }
  } catch (error) {
    state.authMode = 'error';
    state.authError = error instanceof Error ? error.message : 'Unable to connect to the MES server.';
    renderApp();
  }
}

async function submitAuthForm(form: HTMLFormElement): Promise<void> {
  const isSetup = state.authMode === 'setup';
  const name = (document.getElementById('auth-name') as HTMLInputElement | null)?.value.trim() || '';
  const username = (document.getElementById('auth-username') as HTMLInputElement | null)?.value.trim() || '';
  const password = (document.getElementById('auth-password') as HTMLInputElement | null)?.value || '';
  const passwordConfirm = (document.getElementById('auth-password-confirm') as HTMLInputElement | null)?.value || '';

  if (isSetup && password !== passwordConfirm) {
    state.authError = 'Passwords do not match.';
    renderApp();
    return;
  }

  const submitButton = form.querySelector<HTMLButtonElement>('button[type="submit"]');
  if (submitButton) submitButton.disabled = true;
  try {
    const response = await fetch(isSetup ? '/api/auth/bootstrap' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, username, password })
    });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Sign in failed.');
    }
    state.currentUser = result.data.user;
    state.authMode = 'ready';
    state.authError = '';
    state.activeScreen = screenForRole(state.currentUser!.role);
    renderApp();
    if (isSetup) showToast('Initial Super User account created.');
    await syncBackendData();
    startSilentHandoffPolling();
  } catch (error) {
    state.authError = error instanceof Error ? error.message : 'Sign in failed.';
    renderApp();
  }
}

async function lockCurrentSession(): Promise<void> {
  try {
    const response = await fetch('/api/auth/logout', { method: 'POST' });
    const result = await response.json();
    if (!response.ok || !result.success) {
      throw new Error(result.error || 'Unable to lock the session.');
    }
    state.currentUser = null;
    state.authMode = 'login';
    state.authError = '';
    stopSilentHandoffPolling();
    state.hasCompletedInitialSync = false;
    state.isInitialSyncing = false;
    state.isManualSync = false;
    state.syncError = '';
    state.activeScreen = 'screen-grn';
    renderApp();
    showToast('Session locked.');
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'Unable to lock the session.');
  }
}

// Attach interactive event handlers
function attachEventHandlers(): void {
  if (state.authMode !== 'ready' || !state.currentUser) {
    document.getElementById('auth-form')?.addEventListener('submit', event => {
      event.preventDefault();
      void submitAuthForm(event.currentTarget as HTMLFormElement);
    });
    document.getElementById('btn-auth-retry')?.addEventListener('click', () => void initializeAuth());
    return;
  }

  // Global toolbar actions: AQL calculator & Document center
  document.getElementById('btn-open-aql-calculator')?.addEventListener('click', openAqlCalculatorModal);
  document.getElementById('btn-open-doc-center')?.addEventListener('click', () => openDocumentCenterModal('grn'));
  document.getElementById('btn-session-lock')?.addEventListener('click', () => void lockCurrentSession());
  document.getElementById('btn-return-admin')?.addEventListener('click', () => {
    state.activeScreen = 'screen-admin';
    renderApp();
  });
  document.getElementById('btn-inward-nav-grn')?.addEventListener('click', () => {
    state.activeScreen = 'screen-grn';
    renderApp();
  });
  document.getElementById('btn-inward-nav-repair')?.addEventListener('click', () => {
    state.activeScreen = 'screen-repair';
    renderApp();
  });

  document.getElementById('btn-clear-all-data')?.addEventListener('click', () => {
    state.grnList = [];
    state.defectList = [];
    state.cartons = [];
    state.issuedPairsTotal = 0;
    state.grnForm = {
      pendingOrderId: '',
      maker: '',
      hallName: '',
      stitcherName: '',
      article: '',
      color: '',
      receivedFrom: '',
      rcvdPairs: '',
      sizeFormat: 'LEGACY_7_11',
      sizeCodes: undefined,
      sizes: createEmptySizes(),
      splitRows: []
    };
    state.packingWip = createEmptyPackingWipState();
    state.repairForm = {
      batchId: getAlterationReqNumber(DEFAULT_REQ_NUMBER),
      article: '',
      po: '',
      defectType: '',
      tailor: '',
      qty: ''
    };
    state.qcChecklist.forEach(c => c.passed = false);
    state.qcOrder = {
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
    };
    showToast('All details cleared to blank state.');
    renderApp();
  });

  // Modal handlers
  document.getElementById('modal-close-x')?.addEventListener('click', closeModal);
  document.getElementById('modal-btn-close')?.addEventListener('click', closeModal);
  document.getElementById('modal-btn-print')?.addEventListener('click', () => {
    const title = document.getElementById('modal-title')?.textContent || 'Hammad Industries Document';
    const preview = document.getElementById('doc-preview-container');
    const content = preview ? preview.innerHTML : (document.getElementById('modal-body')?.innerHTML || '');
    printDocument(title, content);
  });

  const modal = document.getElementById('global-modal');
  const modalBox = modal?.querySelector<HTMLElement>('.modal-box');
  modal?.addEventListener('keydown', (event) => {
    if (!modal.classList.contains('open')) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      closeModal();
      return;
    }
    if (event.key !== 'Tab' || !modalBox) return;

    const focusable = Array.from(modalBox.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(element =>
      element.getAttribute('aria-hidden') !== 'true' && element.getClientRects().length > 0
    );
    if (!focusable.length) {
      event.preventDefault();
      modalBox.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !modalBox.contains(active))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (active === last || !modalBox.contains(active))) {
      event.preventDefault();
      first.focus();
    }
  });
  modal?.addEventListener('click', (e) => {
    const cancelTrigger = (e.target as HTMLElement | null)?.closest('[data-modal-cancel]');
    if (cancelTrigger || e.target === modal) closeModal();
    else if (!modal.classList.contains('open')) closeModal();
  });

  if (state.activeScreen === 'screen-grn') {
    attachGRNHandlers();
  } else if (state.activeScreen === 'screen-packing') {
    attachPackingHandlers();
  } else if (state.activeScreen === 'screen-repair') {
    attachRepairHandlers();
  } else if (state.activeScreen === 'screen-qc') {
    attachQCHandlers();
  } else if (state.activeScreen === 'screen-admin') {
    attachAdminHandlers();
  }
}

// Initial Boot
setRenderer(renderApp);
registerWindowActions({ lockCurrentSession });
void initializeAuth();
