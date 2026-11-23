import {
  SizeBreakdown,
  calculateSizeTotal,
  createEmptySizes,
  escapeHtml,
  getScaleSizeCodes,
  validateContractorAllocations,
  validatePendingOrderInputs
} from '../../utils/requisitionLogic';
import type { AdminOrderArticleLine } from '../../components/superUserView';
import { openEditPendingOrderModal as renderEditPendingOrderModal } from '../../components/superUser/editOrderModal';
import {
  applyFieldValidationErrors,
  clearFieldValidationError,
  closeModal,
  openModal,
  runAdminAction,
  showToast
} from '../../utils/domModalsAndPrint';
import { renderApp } from '../../appContext';
import { getOrderSizeCodes, getOrderStockState, state } from '../../state/appState';
import { syncBackendData } from '../../state/syncService';

/** Open the Super User Edit Order modal and synchronize updates on save. */
export function openEditPendingOrderModal(orderId: string): void {
  const order = state.pendingOrders.find(o => o.orderId === orderId);
  if (!order) {
    showToast(`Order ${orderId} not found.`);
    return;
  }

  const sizeCodes = getOrderSizeCodes(order.orderId, order.sizeCodes, order.sizeFormat);
  const stock = getOrderStockState(order.orderId);
  const receivedPairs = Number(order.receivedPairs ?? stock.totalReceived ?? 0);
  const requestedPairs = Number(order.requestedPairs ?? stock.pendingReqPairs ?? 0);
  const makers = [
    ...(state.dropdownOptions.makers || []),
    ...((state.dropdownOptions.halls || []).map(h => h.name))
  ];

  renderEditPendingOrderModal({
    order,
    sizeCodes,
    receivedPairs,
    requestedPairs,
    makers,
    openModal,
    closeModal,
    showToast,
    onSaved: async (updatedOrders, grandTotal) => {
      if (Array.isArray(updatedOrders)) {
        state.pendingOrders = updatedOrders;
      }
      await syncBackendData();
      showToast(`Updated order ${order.orderId} (${Number(grandTotal || 0).toLocaleString()} pairs).`);
      renderApp();
    }
  });
}

function getActiveAdminOrderSizeCodes(): string[] {
  return getScaleSizeCodes(state.adminOverview.sizeStandards, state.adminOrderDraft.sizeFormat || 'LEGACY_7_11');
}

function syncAdminArticleLinesFromDom(): void {
  if (state.adminOrderArticleLines.length === 0) return;
  state.adminOrderArticleLines.forEach((line, idx) => {
    const makerEl = document.querySelector<HTMLSelectElement>(`.admin-line-maker[data-line-index="${idx}"]`);
    const colorEl = document.querySelector<HTMLInputElement>(`.admin-line-color[data-line-index="${idx}"]`);
    const dueEl = document.querySelector<HTMLInputElement>(`.admin-line-due-date[data-line-index="${idx}"]`);
    if (makerEl) line.maker = makerEl.value.trim();
    if (colorEl) line.color = colorEl.value.trim();
    if (dueEl) line.dueDate = dueEl.value.trim();
    const lineCodes = getScaleSizeCodes(state.adminOverview.sizeStandards, line.sizeFormat || 'LEGACY_7_11');
    const sizeInputs = document.querySelectorAll<HTMLInputElement>(`.admin-line-size-val[data-line-index="${idx}"]`);
    if (sizeInputs.length > 0) {
      const nextSizes = createEmptySizes(lineCodes);
      sizeInputs.forEach(inp => {
        const sz = inp.getAttribute('data-size') || '';
        if (sz && lineCodes.includes(sz)) {
          nextSizes[sz] = Math.max(0, parseInt(inp.value || '0', 10) || 0);
        }
      });
      line.sizes = nextSizes;
    }
    if (line.splitRows.length > 0) {
      line.splitRows.forEach((sRow, sIdx) => {
        const sMaker = document.querySelector<HTMLSelectElement>(
          `.admin-line-split-maker[data-line-index="${idx}"][data-split-index="${sIdx}"]`
        );
        const sDue = document.querySelector<HTMLInputElement>(
          `.admin-line-split-due-date[data-line-index="${idx}"][data-split-index="${sIdx}"]`
        );
        if (sMaker) sRow.maker = sMaker.value.trim();
        if (sDue) sRow.dueDate = sDue.value.trim();
        const sInputs = document.querySelectorAll<HTMLInputElement>(
          `.admin-line-split-size-val[data-line-index="${idx}"][data-split-index="${sIdx}"]`
        );
        if (sInputs.length > 0) {
          const nextSplitSizes = createEmptySizes(lineCodes);
          sInputs.forEach(inp => {
            const sz = inp.getAttribute('data-size') || '';
            if (sz && lineCodes.includes(sz)) {
              nextSplitSizes[sz] = Math.max(0, parseInt(inp.value || '0', 10) || 0);
            }
          });
          sRow.sizes = nextSplitSizes;
        }
      });
    }
  });
}

/** Flush DOM Order Creation inputs into `state.adminOrderDraft` and `state.adminOrderArticleLines`. */
export function syncAdminOrderDraftFromDom(): void {
  const buyerEl = document.getElementById('admin-pending-order-buyer') as HTMLSelectElement | null;
  const articleEl = document.getElementById('admin-pending-order-article') as HTMLSelectElement | null;
  const colorEl = document.getElementById('admin-pending-order-color') as HTMLInputElement | null;
  const buyerOpt = buyerEl?.selectedOptions?.[0];
  state.adminOrderDraft.buyer = buyerEl?.value?.trim() || '';
  state.adminOrderDraft.customerId = buyerOpt?.getAttribute('data-customer-id') || '';
  state.adminOrderDraft.maker = (document.getElementById('admin-pending-order-maker') as HTMLSelectElement)?.value?.trim() || '';
  state.adminOrderDraft.po = (document.getElementById('admin-pending-order-po') as HTMLInputElement)?.value?.trim() || '';
  state.adminOrderDraft.dueDate = (document.getElementById('admin-pending-order-due-date') as HTMLInputElement)?.value?.trim() || '';
  const sizeFmtEl = document.getElementById('admin-order-size-format') as HTMLSelectElement | null;
  if (articleEl) {
    const articleOpt = articleEl.selectedOptions?.[0];
    state.adminOrderDraft.productId = articleOpt?.getAttribute('data-product-id') || '';
    state.adminOrderDraft.article = articleEl.value?.trim() || '';
    state.adminOrderDraft.sizeFormat = sizeFmtEl?.value
      || (articleEl.value ? (articleOpt?.getAttribute('data-size-format') || 'ALPHA_2XS_5XL') : 'ALPHA_2XS_5XL');
  } else if (sizeFmtEl?.value) {
    state.adminOrderDraft.sizeFormat = sizeFmtEl.value;
  }
  if (colorEl) {
    state.adminOrderDraft.color = colorEl.value?.trim() || '';
  }
  const orderSizeInputs = document.querySelectorAll('.admin-order-size-val');
  if (orderSizeInputs.length > 0) {
    const activeCodes = getActiveAdminOrderSizeCodes();
    const sizes = createEmptySizes(activeCodes);
    orderSizeInputs.forEach(el => {
      const inp = el as HTMLInputElement;
      const k = inp.getAttribute('data-size');
      if (k && activeCodes.includes(k)) {
        sizes[k] = Math.max(0, parseInt(inp.value || '0', 10) || 0);
      }
    });
    state.adminOrderDraft.sizes = sizes;
  }
  syncAdminArticleLinesFromDom();
}

function updateAdminSplitBalanceDom(): void {
  if (state.adminOrderSplitRows.length === 0) return;
  state.adminOrderSplitRows.forEach((row, idx) => {
    const rowTotalCell = document.getElementById(`admin-split-row-total-${idx}`);
    if (rowTotalCell) rowTotalCell.textContent = calculateSizeTotal(row.sizes).toLocaleString();
  });
  const balanceBar = document.getElementById('admin-split-balance-bar');
  if (balanceBar) {
    const activeCodes = getActiveAdminOrderSizeCodes();
    const check = validateContractorAllocations(state.adminOrderDraft.sizes, state.adminOrderSplitRows, activeCodes);
    balanceBar.className = `su-split-balance-bar ${check.valid ? 'is-balanced' : 'is-unbalanced'}`;
    balanceBar.innerHTML = `
      <span>
        Unassigned Balance:
        ${activeCodes.map(sz => `<strong>${escapeHtml(sz)}:${check.unassignedBySize[sz] ?? 0}</strong>`).join(' | ')}
        (<strong>${check.totalUnassigned}</strong> Prs remaining)
      </span>
      <strong>${check.valid ? 'Split Matches Order 100% ✓' : escapeHtml(check.error || 'Adjust contractor quantities to match order totals')}</strong>
    `;
  }
}

function updateAdminLineSplitBalanceDom(lineIdx: number): void {
  const line = state.adminOrderArticleLines[lineIdx];
  if (!line || line.splitRows.length === 0) return;
  const lineCodes = getScaleSizeCodes(state.adminOverview.sizeStandards, line.sizeFormat || 'LEGACY_7_11');
  line.splitRows.forEach((sRow, sIdx) => {
    const rowTotalCell = document.getElementById(`admin-line-split-total-${lineIdx}-${sIdx}`);
    if (rowTotalCell) rowTotalCell.textContent = calculateSizeTotal(sRow.sizes).toLocaleString();
  });
  const balanceBar = document.getElementById(`admin-line-split-balance-${lineIdx}`);
  if (balanceBar) {
    const check = validateContractorAllocations(line.sizes, line.splitRows, lineCodes);
    balanceBar.className = `su-split-balance-bar ${check.valid ? 'is-balanced' : 'is-unbalanced'}`;
    balanceBar.innerHTML = `
      <span>
        Unassigned Balance:
        ${lineCodes.map(sz => `<strong>${escapeHtml(sz)}:${check.unassignedBySize[sz] ?? 0}</strong>`).join(' | ')}
        (<strong>${check.totalUnassigned}</strong> Prs remaining)
      </span>
      <strong>${check.valid ? 'Split Matches Sub-order 100% ✓' : escapeHtml(check.error || 'Adjust contractor quantities to match sub-order totals')}</strong>
    `;
  }
}

function updateAdminMultiTotalDom(lineIdx?: number): void {
  if (lineIdx !== undefined && state.adminOrderArticleLines[lineIdx]) {
    const lineTotalCell = document.getElementById(`admin-line-total-${lineIdx}`);
    if (lineTotalCell) {
      lineTotalCell.textContent = calculateSizeTotal(state.adminOrderArticleLines[lineIdx].sizes).toLocaleString();
    }
    updateAdminLineSplitBalanceDom(lineIdx);
  }
  const summaryEl = document.getElementById('admin-multi-total-summary');
  if (summaryEl) {
    const nLines = state.adminOrderArticleLines.length;
    const grand = state.adminOrderArticleLines.reduce((sum, l) => sum + calculateSizeTotal(l.sizes), 0);
    summaryEl.textContent = `${nLines} ${nLines === 1 ? 'Article' : 'Sub-orders'} · ${grand.toLocaleString()} Pairs`;
  }
}

// Recalculate planned order size total in Super User form
function recalcAdminOrderSizes(): void {
  syncAdminOrderDraftFromDom();
  const tot = calculateSizeTotal(state.adminOrderDraft.sizes);
  const cell = document.getElementById('admin-order-size-total');
  if (cell) cell.textContent = tot.toLocaleString();
  updateAdminSplitBalanceDom();
}

/** Attach Super User Order Creation, Multi-Article Picker, Contractor Split, Reset, and Submit handlers. */
export function attachAdminOrderCreationHandlers(): void {
  // --- Section: Buyer / Article / Maker Cascade ---
  document.querySelectorAll('.admin-order-size-val').forEach(inp => {
    inp.addEventListener('input', recalcAdminOrderSizes);
  });

  document.getElementById('admin-pending-order-buyer')?.addEventListener('change', () => {
    const prevFormat = state.adminOrderDraft.sizeFormat || 'LEGACY_7_11';
    syncAdminOrderDraftFromDom();
    const buyerEl = document.getElementById('admin-pending-order-buyer') as HTMLSelectElement | null;
    const buyerOpt = buyerEl?.selectedOptions?.[0];
    state.adminOrderDraft.buyer = buyerEl?.value?.trim() || '';
    state.adminOrderDraft.customerId = buyerOpt?.getAttribute('data-customer-id') || '';
    state.adminOrderDraft.productId = '';
    state.adminOrderDraft.article = '';
    state.adminOrderDraft.color = '';
    state.adminOrderDraft.sizeFormat = 'LEGACY_7_11';
    state.adminOrderArticleLines = [];
    state.adminMultiArticleSearch = '';
    if (prevFormat !== 'LEGACY_7_11') {
      const legacyCodes = getScaleSizeCodes(state.adminOverview.sizeStandards, 'LEGACY_7_11');
      state.adminOrderDraft.sizes = createEmptySizes(legacyCodes);
      state.adminOrderSplitRows = state.adminOrderSplitRows.map(r => ({
        ...r,
        sizes: createEmptySizes(legacyCodes)
      }));
    }
    renderApp();
    (document.getElementById('admin-pending-order-buyer') as HTMLSelectElement | null)?.focus();
  });

  document.getElementById('admin-pending-order-article')?.addEventListener('change', () => {
    const prevFormat = state.adminOrderDraft.sizeFormat || 'LEGACY_7_11';
    syncAdminOrderDraftFromDom();
    const articleEl = document.getElementById('admin-pending-order-article') as HTMLSelectElement | null;
    const opt = articleEl?.selectedOptions?.[0];
    const optProductId = opt?.getAttribute('data-product-id') || '';
    const optCustomerId = opt?.getAttribute('data-customer-id') || '';
    const optCustomerName = opt?.getAttribute('data-customer-name') || '';
    const nextFormat = articleEl?.value ? (opt?.getAttribute('data-size-format') || 'LEGACY_7_11') : 'LEGACY_7_11';
    const optColorSpec = opt?.getAttribute('data-color-spec') || '';

    state.adminOrderDraft.productId = optProductId;
    state.adminOrderDraft.article = articleEl?.value?.trim() || '';
    if (!state.adminOrderDraft.buyer && optCustomerName) {
      state.adminOrderDraft.buyer = optCustomerName;
      state.adminOrderDraft.customerId = optCustomerId;
    }
    state.adminOrderDraft.color = optColorSpec;
    state.adminOrderDraft.sizeFormat = nextFormat;
    if (nextFormat !== prevFormat) {
      const nextCodes = getScaleSizeCodes(state.adminOverview.sizeStandards, nextFormat);
      state.adminOrderDraft.sizes = createEmptySizes(nextCodes);
      state.adminOrderSplitRows = state.adminOrderSplitRows.map(r => ({
        ...r,
        sizes: createEmptySizes(nextCodes)
      }));
    }
    renderApp();
    (document.getElementById('admin-pending-order-article') as HTMLSelectElement | null)?.focus();
  });

  document.getElementById('admin-pending-order-maker')?.addEventListener('change', () => {
    const prevDefaultMaker = state.adminOrderLastDefaultMaker;
    syncAdminOrderDraftFromDom();
    const nextMaker = state.adminOrderDraft.maker;
    let changedLines = false;
    if (state.adminOrderArticleLines.length > 0) {
      for (const line of state.adminOrderArticleLines) {
        if (line.splitRows.length === 0 && (!line.maker || line.maker === prevDefaultMaker)) {
          line.maker = nextMaker;
          changedLines = true;
        }
      }
    }
    state.adminOrderLastDefaultMaker = nextMaker;
    if (changedLines) {
      renderApp();
      (document.getElementById('admin-pending-order-maker') as HTMLSelectElement | null)?.focus();
    }
  });

  document.getElementById('admin-pending-order-due-date')?.addEventListener('change', () => {
    const prevDue = state.adminOrderLastDefaultDueDate;
    syncAdminOrderDraftFromDom();
    const nextDue = state.adminOrderDraft.dueDate;
    let changedLines = false;
    if (state.adminOrderArticleLines.length > 0) {
      for (const line of state.adminOrderArticleLines) {
        if (!line.dueDate || line.dueDate === prevDue) {
          line.dueDate = nextDue;
          changedLines = true;
        }
      }
    }
    state.adminOrderLastDefaultDueDate = nextDue;
    if (changedLines) {
      renderApp();
      (document.getElementById('admin-pending-order-due-date') as HTMLInputElement | null)?.focus();
    }
  });

  for (const fieldId of [
    'admin-pending-order-po',
    'admin-pending-order-color'
  ]) {
    document.getElementById(fieldId)?.addEventListener('change', syncAdminOrderDraftFromDom);
  }

  // --- Section: Multi-Article Picker & Sub-Order Lines ---
  document.getElementById('btn-admin-toggle-multi-articles')?.addEventListener('click', () => {
    syncAdminOrderDraftFromDom();
    const opening = !state.adminMultiArticlePickerOpen;
    state.adminMultiArticlePickerOpen = opening;
    state.adminOrderLastDefaultMaker = state.adminOrderDraft.maker;
    state.adminOrderLastDefaultDueDate = state.adminOrderDraft.dueDate;
    if (opening && state.adminOrderArticleLines.length === 0 && state.adminOrderDraft.article) {
      const fmt = state.adminOrderDraft.sizeFormat || 'LEGACY_7_11';
      state.adminOrderArticleLines.push({
        lineId: state.adminOrderDraft.productId || state.adminOrderDraft.article,
        productId: state.adminOrderDraft.productId || '',
        article: state.adminOrderDraft.article,
        color: state.adminOrderDraft.color || '',
        sizeFormat: fmt,
        maker: state.adminOrderDraft.maker || '',
        dueDate: state.adminOrderDraft.dueDate || '',
        sizes: { ...state.adminOrderDraft.sizes },
        splitRows: state.adminOrderSplitRows.map(r => ({
          maker: r.maker,
          sizes: { ...r.sizes },
          dueDate: r.dueDate
        }))
      });
      state.adminOrderSplitRows = [];
    }
    renderApp();
  });

  document.getElementById('admin-multi-art-search')?.addEventListener('input', (ev) => {
    const query = (ev.currentTarget as HTMLInputElement).value;
    state.adminMultiArticleSearch = query;
    const needle = query.trim().toLowerCase();
    document.querySelectorAll<HTMLElement>('.su-multi-art-item').forEach(item => {
      const hay = item.getAttribute('data-search') || '';
      item.hidden = Boolean(needle && !hay.includes(needle));
    });
  });

  document.querySelectorAll<HTMLInputElement>('.admin-multi-art-check').forEach(cb => {
    cb.addEventListener('change', () => {
      syncAdminOrderDraftFromDom();
      const productId = cb.getAttribute('data-product-id') || '';
      const article = cb.getAttribute('data-article-name') || '';
      const sizeFormat = cb.getAttribute('data-size-format') || 'LEGACY_7_11';
      const colorSpec = cb.getAttribute('data-color-spec') || '';
      const matchFn = (l: AdminOrderArticleLine) => (productId ? l.productId === productId : l.article === article);

      if (cb.checked) {
        if (!state.adminOrderArticleLines.some(matchFn)) {
          const lineCodes = getScaleSizeCodes(state.adminOverview.sizeStandards, sizeFormat);
          state.adminOrderArticleLines.push({
            lineId: productId || article,
            productId,
            article,
            color: colorSpec,
            sizeFormat,
            maker: state.adminOrderDraft.maker || '',
            dueDate: state.adminOrderDraft.dueDate || '',
            sizes: createEmptySizes(lineCodes),
            splitRows: []
          });
        }
      } else {
        state.adminOrderArticleLines = state.adminOrderArticleLines.filter(l => !matchFn(l));
      }
      state.adminOrderLastDefaultMaker = state.adminOrderDraft.maker;
      state.adminOrderLastDefaultDueDate = state.adminOrderDraft.dueDate;
      renderApp();
      const escapedArt = article.replace(/"/g, '\\"');
      document.querySelector<HTMLInputElement>(`.admin-multi-art-check[data-article-name="${escapedArt}"]`)?.focus();
    });
  });

  document.querySelectorAll<HTMLSelectElement>('.admin-line-maker').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = Number(sel.getAttribute('data-line-index'));
      if (state.adminOrderArticleLines[idx]) {
        state.adminOrderArticleLines[idx].maker = sel.value.trim();
        clearFieldValidationError(sel);
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.admin-line-color').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.getAttribute('data-line-index'));
      if (state.adminOrderArticleLines[idx]) {
        state.adminOrderArticleLines[idx].color = inp.value.trim();
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.admin-line-due-date').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.getAttribute('data-line-index'));
      if (state.adminOrderArticleLines[idx]) {
        state.adminOrderArticleLines[idx].dueDate = inp.value.trim();
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.admin-line-size-val').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.getAttribute('data-line-index'));
      const sz = inp.getAttribute('data-size') || '';
      const line = state.adminOrderArticleLines[idx];
      if (line && sz) {
        line.sizes[sz] = Math.max(0, parseInt(inp.value || '0', 10) || 0);
        updateAdminMultiTotalDom(idx);
      }
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.admin-line-toggle-split').forEach(btn => {
    btn.addEventListener('click', () => {
      syncAdminOrderDraftFromDom();
      const idx = Number(btn.getAttribute('data-line-index'));
      const line = state.adminOrderArticleLines[idx];
      if (!line) return;
      const lineCodes = getScaleSizeCodes(state.adminOverview.sizeStandards, line.sizeFormat || 'LEGACY_7_11');
      if (line.splitRows.length > 0) {
        line.splitRows = [];
      } else {
        const firstMaker = line.maker || state.adminOrderDraft.maker || state.dropdownOptions.makers[0] || '';
        const secondMaker = state.dropdownOptions.makers.find(m => m !== firstMaker) || '';
        line.splitRows = [
          { maker: firstMaker, sizes: { ...line.sizes }, dueDate: line.dueDate || state.adminOrderDraft.dueDate },
          { maker: secondMaker, sizes: createEmptySizes(lineCodes), dueDate: line.dueDate || state.adminOrderDraft.dueDate }
        ];
      }
      renderApp();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.admin-line-add-split-row').forEach(btn => {
    btn.addEventListener('click', () => {
      syncAdminOrderDraftFromDom();
      const idx = Number(btn.getAttribute('data-line-index'));
      const line = state.adminOrderArticleLines[idx];
      if (!line) return;
      const lineCodes = getScaleSizeCodes(state.adminOverview.sizeStandards, line.sizeFormat || 'LEGACY_7_11');
      const used = new Set(line.splitRows.map(r => r.maker));
      const nextMaker = state.dropdownOptions.makers.find(m => !used.has(m)) || '';
      line.splitRows.push({
        maker: nextMaker,
        sizes: createEmptySizes(lineCodes),
        dueDate: line.dueDate || state.adminOrderDraft.dueDate
      });
      renderApp();
    });
  });

  document.querySelectorAll<HTMLButtonElement>('.admin-line-remove-split-row').forEach(btn => {
    btn.addEventListener('click', () => {
      syncAdminOrderDraftFromDom();
      const idx = Number(btn.getAttribute('data-line-index'));
      const sIdx = Number(btn.getAttribute('data-split-index'));
      const line = state.adminOrderArticleLines[idx];
      if (line && Number.isInteger(sIdx) && line.splitRows.length > 2) {
        line.splitRows.splice(sIdx, 1);
        renderApp();
      }
    });
  });

  document.querySelectorAll<HTMLSelectElement>('.admin-line-split-maker').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = Number(sel.getAttribute('data-line-index'));
      const sIdx = Number(sel.getAttribute('data-split-index'));
      const line = state.adminOrderArticleLines[idx];
      if (line?.splitRows[sIdx]) {
        line.splitRows[sIdx].maker = sel.value.trim();
        updateAdminLineSplitBalanceDom(idx);
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.admin-line-split-size-val').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.getAttribute('data-line-index'));
      const sIdx = Number(inp.getAttribute('data-split-index'));
      const sz = inp.getAttribute('data-size') || '';
      const line = state.adminOrderArticleLines[idx];
      if (line?.splitRows[sIdx] && sz) {
        line.splitRows[sIdx].sizes[sz] = Math.max(0, parseInt(inp.value || '0', 10) || 0);
        updateAdminLineSplitBalanceDom(idx);
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.admin-line-split-due-date').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.getAttribute('data-line-index'));
      const sIdx = Number(inp.getAttribute('data-split-index'));
      const line = state.adminOrderArticleLines[idx];
      if (line?.splitRows[sIdx]) {
        line.splitRows[sIdx].dueDate = inp.value.trim();
      }
    });
  });

  // --- Section: Single-Order Contractor Split ---
  document.getElementById('btn-admin-toggle-split')?.addEventListener('click', () => {
    syncAdminOrderDraftFromDom();
    const activeCodes = getActiveAdminOrderSizeCodes();
    if (state.adminOrderSplitRows.length > 0) {
      state.adminOrderSplitRows = [];
    } else {
      const firstMaker = state.adminOrderDraft.maker || state.dropdownOptions.makers[0] || '';
      const secondMaker = state.dropdownOptions.makers.find(m => m !== firstMaker) || '';
      state.adminOrderSplitRows = [
        { maker: firstMaker, sizes: { ...state.adminOrderDraft.sizes }, dueDate: state.adminOrderDraft.dueDate },
        { maker: secondMaker, sizes: createEmptySizes(activeCodes), dueDate: state.adminOrderDraft.dueDate }
      ];
    }
    renderApp();
  });

  document.getElementById('btn-admin-add-split-row')?.addEventListener('click', () => {
    syncAdminOrderDraftFromDom();
    const activeCodes = getActiveAdminOrderSizeCodes();
    const used = new Set(state.adminOrderSplitRows.map(r => r.maker));
    const nextMaker = state.dropdownOptions.makers.find(m => !used.has(m)) || '';
    state.adminOrderSplitRows.push({
      maker: nextMaker,
      sizes: createEmptySizes(activeCodes),
      dueDate: state.adminOrderDraft.dueDate
    });
    renderApp();
  });

  document.querySelectorAll<HTMLSelectElement>('.admin-split-maker').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = Number(sel.getAttribute('data-split-index'));
      if (state.adminOrderSplitRows[idx]) {
        state.adminOrderSplitRows[idx].maker = sel.value;
        updateAdminSplitBalanceDom();
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.admin-split-size-val').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.getAttribute('data-split-index'));
      const sz = inp.getAttribute('data-size');
      if (state.adminOrderSplitRows[idx] && sz) {
        state.adminOrderSplitRows[idx].sizes[sz] = Math.max(0, parseInt(inp.value || '0', 10) || 0);
        updateAdminSplitBalanceDom();
      }
    });
  });

  document.querySelectorAll<HTMLInputElement>('.admin-split-due-date').forEach(inp => {
    inp.addEventListener('change', () => {
      const idx = Number(inp.getAttribute('data-split-index'));
      if (state.adminOrderSplitRows[idx]) {
        state.adminOrderSplitRows[idx].dueDate = inp.value;
      }
    });
  });

  // --- Section: Reset & Submit Order ---
  document.getElementById('btn-admin-reset-pending-order')?.addEventListener('click', () => {
    const hadSplit = state.adminOrderSplitRows.length > 0;
    const hadMulti = state.adminOrderArticleLines.length > 0 || state.adminMultiArticlePickerOpen;
    const hadCatalogState =
      Boolean(state.adminOrderDraft.buyer) ||
      (state.adminOrderDraft.sizeFormat || 'LEGACY_7_11') !== 'LEGACY_7_11';
    state.adminOrderDraft = {
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
    };
    state.adminOrderSplitRows = [];
    state.adminOrderArticleLines = [];
    state.adminMultiArticlePickerOpen = false;
    state.adminMultiArticleSearch = '';
    state.adminOrderLastDefaultMaker = '';
    state.adminOrderLastDefaultDueDate = '';
    for (const id of [
      'admin-pending-order-buyer',
      'admin-pending-order-maker',
      'admin-pending-order-po',
      'admin-pending-order-article',
      'admin-pending-order-color',
      'admin-pending-order-due-date'
    ]) {
      const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
      if (el) {
        el.value = '';
        clearFieldValidationError(el);
      }
    }
    document.querySelectorAll('.admin-order-size-val').forEach(el => {
      (el as HTMLInputElement).value = '';
    });
    const cell = document.getElementById('admin-order-size-total');
    if (cell) cell.textContent = '0';
    if (hadSplit || hadMulti || hadCatalogState) renderApp();
  });

  document.getElementById('btn-admin-add-pending-order')?.addEventListener('click', (e) => {
    syncAdminOrderDraftFromDom();
    const makerEl = document.getElementById('admin-pending-order-maker') as HTMLSelectElement | null;
    const articleEl = document.getElementById('admin-pending-order-article') as HTMLSelectElement | null;
    const buyer = state.adminOrderDraft.buyer;
    const po = state.adminOrderDraft.po;
    const dueDate = state.adminOrderDraft.dueDate;

    if (state.adminOrderArticleLines.length > 0) {
      const lines = state.adminOrderArticleLines;
      for (let idx = 0; idx < lines.length; idx += 1) {
        const line = lines[idx];
        const lineCodes = getScaleSizeCodes(state.adminOverview.sizeStandards, line.sizeFormat || 'LEGACY_7_11');
        if (line.splitRows.length > 0) {
          const splitCheck = validateContractorAllocations(line.sizes, line.splitRows, lineCodes);
          if (!splitCheck.valid) {
            showToast(`Sub-order ${idx + 1} (${line.article}): ${splitCheck.error || 'Split must equal article size totals.'}`);
            return;
          }
        } else {
          const effectiveMaker = (line.maker || state.adminOrderDraft.maker || '').trim();
          const lineMakerEl = document.querySelector<HTMLSelectElement>(`.admin-line-maker[data-line-index="${idx}"]`);
          const errs = validatePendingOrderInputs({ maker: effectiveMaker, article: line.article });
          if (applyFieldValidationErrors([[lineMakerEl || makerEl, errs.maker]])) {
            showToast(`Select Contractor / Maker for Sub-order ${idx + 1} (${line.article}).`);
            return;
          }
        }
      }

      const items = lines.map(line => {
        const lineSplit = line.splitRows.length > 0;
        const effectiveMaker = lineSplit
          ? line.splitRows.map(r => r.maker.trim()).filter(Boolean).join(', ')
          : (line.maker || state.adminOrderDraft.maker || '').trim();
        const linePairs = calculateSizeTotal(line.sizes);
        return {
          productId: line.productId || undefined,
          article: line.article,
          color: line.color || 'Standard',
          sizeFormat: line.sizeFormat || 'LEGACY_7_11',
          dueDate: line.dueDate || dueDate || '',
          maker: effectiveMaker,
          sizes: { ...line.sizes },
          totalQty: linePairs,
          allocations: lineSplit
            ? line.splitRows.map(r => ({
                maker: r.maker.trim(),
                sizes: { ...r.sizes },
                dueDate: r.dueDate || line.dueDate || dueDate || ''
              }))
            : undefined,
          notes: `Created by Super User: Buyer=${buyer}, PO=${po}, Color=${line.color || 'Standard'}, Scale=${line.sizeFormat || 'LEGACY_7_11'}`
        };
      });

      const batchPayload = {
        customerId: state.adminOrderDraft.customerId || undefined,
        buyer: buyer || 'Standard Client',
        maker: state.adminOrderDraft.maker || undefined,
        po: po || '---',
        dueDate,
        items
      };

      void runAdminAction('admin:create-pending-order', e.currentTarget as HTMLElement, async () => {
        try {
          const res = await fetch('/api/admin/pending-orders', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(batchPayload)
          });
          const json = await res.json();
          if (!res.ok || !json.success || typeof json.data?.orderId !== 'string' || !Array.isArray(json.data.orders)) {
            showToast(json.error || 'Orders were not saved. Please try again.');
            return;
          }

          const createdIds: string[] = Array.isArray(json.data.orderIds) ? json.data.orderIds : [json.data.orderId];
          const baseOrderId: string = json.data.baseOrderId || json.data.orderId;
          state.pendingOrders = json.data.orders;
          for (const cid of createdIds) {
            state.adminExpandedOrders[cid] = true;
          }
          if (po && !state.dropdownOptions.poList.includes(po)) {
            state.dropdownOptions.poList.unshift(po);
          }
          for (const it of items) {
            if (!it.allocations && it.maker && !state.dropdownOptions.makers.includes(it.maker)) {
              state.dropdownOptions.makers.unshift(it.maker);
            }
          }
          const grandPairs = items.reduce((s, it) => s + Number(it.totalQty || 0), 0);
          state.adminOrderDraft = {
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
          };
          state.adminOrderSplitRows = [];
          state.adminOrderArticleLines = [];
          state.adminMultiArticlePickerOpen = false;
          state.adminMultiArticleSearch = '';
          state.adminOrderLastDefaultMaker = '';
          state.adminOrderLastDefaultDueDate = '';
          showToast(
            createdIds.length >= 2
              ? `Saved ${createdIds.length} linked sub-orders under ${baseOrderId} (${createdIds.join(', ')} · ${grandPairs.toLocaleString()} Pairs).`
              : `Saved Master Order ${createdIds[0]} (${buyer || 'Standard'} | ${items[0].article} | ${grandPairs.toLocaleString()} Pairs).`
          );
          renderApp();
        } catch (error) {
          console.error('Multi-article order creation failed:', error);
          showToast('Order could not be saved. No order was created.');
        }
      });
      return;
    }

    const splitActive = state.adminOrderSplitRows.length > 0;
    const maker = splitActive
      ? state.adminOrderSplitRows.map(r => r.maker.trim()).filter(Boolean).join(', ')
      : state.adminOrderDraft.maker;
    const article = state.adminOrderDraft.article;
    const color = state.adminOrderDraft.color;
    const sizes: SizeBreakdown = { ...state.adminOrderDraft.sizes };
    const totalPairs = calculateSizeTotal(sizes);

    if (splitActive) {
      const artErrors = validatePendingOrderInputs({ maker: 'split', article });
      if (applyFieldValidationErrors([[articleEl, artErrors.article]])) {
        showToast('Select the required Article.');
        return;
      }
      const splitCheck = validateContractorAllocations(sizes, state.adminOrderSplitRows, getActiveAdminOrderSizeCodes());
      if (!splitCheck.valid) {
        showToast(splitCheck.error || 'Contractor split quantities must equal the order size totals.');
        return;
      }
    } else {
      const errors = validatePendingOrderInputs({ maker, article });
      if (applyFieldValidationErrors([[makerEl, errors.maker], [articleEl, errors.article]])) {
        showToast('Select the required Contractor / Maker and Article.');
        return;
      }
    }

    const newOrder = {
      customerId: state.adminOrderDraft.customerId || undefined,
      buyer: buyer || 'Standard Client',
      maker,
      po: po || '---',
      productId: state.adminOrderDraft.productId || undefined,
      article,
      color: color || 'Standard',
      sizeFormat: state.adminOrderDraft.sizeFormat || 'LEGACY_7_11',
      dueDate,
      sizes,
      totalQty: totalPairs,
      allocations: splitActive
        ? state.adminOrderSplitRows.map(r => ({
            maker: r.maker.trim(),
            sizes: { ...r.sizes },
            dueDate: r.dueDate || dueDate || ''
          }))
        : undefined,
      notes: `Created by Super User: Buyer=${buyer}, PO=${po}, Color=${color}, Scale=${state.adminOrderDraft.sizeFormat || 'LEGACY_7_11'}`
    };

    void runAdminAction('admin:create-pending-order', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch('/api/admin/pending-orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(newOrder)
        });
        const json = await res.json();
        if (!res.ok || !json.success || typeof json.data?.orderId !== 'string' || !Array.isArray(json.data.orders)) {
          showToast(json.error || 'Order was not saved. Please try again.');
          return;
        }

        const { orderId, orders } = json.data;
        state.pendingOrders = orders;
        state.adminExpandedOrders[orderId] = true;
        state.adminOrderDraft = {
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
        };
        state.adminOrderSplitRows = [];
        if (po && !state.dropdownOptions.poList.includes(po)) {
          state.dropdownOptions.poList.unshift(po);
        }
        if (maker && !splitActive && !state.dropdownOptions.makers.includes(maker)) {
          state.dropdownOptions.makers.unshift(maker);
        }
        showToast(`Saved Master Order ${orderId} (${buyer || 'Standard'} | ${maker} | ${article} | ${totalPairs} Pairs).`);
        renderApp();
      } catch (error) {
        console.error('Order creation failed:', error);
        showToast('Order could not be saved. No order was created.');
      }
    });
  });

  document.getElementById('admin-order-size-format')?.addEventListener('change', (ev) => {
    syncAdminOrderDraftFromDom();
    const nextFmt = (ev.currentTarget as HTMLSelectElement)?.value || 'ALPHA_2XS_5XL';
    state.adminOrderDraft.sizeFormat = nextFmt;
    state.adminOrderDraft.sizes = createEmptySizes(getScaleSizeCodes(state.adminOverview.sizeStandards, nextFmt));
    renderApp();
  });
}
