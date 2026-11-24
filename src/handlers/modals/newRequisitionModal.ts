import {
  SizeBreakdown,
  calculateSizeTotal,
  createEmptySizes,
  escapeHtml,
  formatSizeColumnLabel,
  normalizeBaseReqNumber
} from '../../utils/requisitionLogic';
import { closeModal, openModal, showToast } from '../../utils/domModalsAndPrint';
import { renderApp } from '../../appContext';
import { getOrderSizeCodes, getOrderStockState, state } from '../../state/appState';
import { applyServerRequisition } from '../../state/syncService';

// Open Packing Hall Requisition Generator Modal (Links REQ-000X -> M-REQ-000X & A-REQ-000X back to Parent Order)
export function openNewRequisitionModal(preselectOrderId?: string): void {
  function getOrderReqEntryCaps(orderId: string) {
    const matched = state.pendingOrders.find(o => o.orderId === orderId);
    const stock = getOrderStockState(orderId);
    const sizeFormat = matched?.sizeFormat || 'LEGACY_7_11';
    const sizeCodes = getOrderSizeCodes(orderId, matched?.sizeCodes, sizeFormat);
    const maxTotalAllowed = Math.max(0, Math.min(stock.remainingOrderTotal, stock.unclaimedPairs));
    const hasSizeGrnBreakdown = calculateSizeTotal(stock.receivedSizes) > 0;
    const perSizeMax = createEmptySizes(sizeCodes);
    for (const size of sizeCodes) {
      const remOrder = Number(stock.remainingOrderSizes[size] || 0);
      const dockSizeAvail = Math.max(0, Number(stock.unclaimedDockSizes[size] || 0));
      perSizeMax[size] = hasSizeGrnBreakdown
        ? Math.min(remOrder, dockSizeAvail)
        : Math.min(remOrder, maxTotalAllowed);
    }
    const defaultSizes = createEmptySizes(sizeCodes);
    let remainingBudget = Math.min(calculateSizeTotal(perSizeMax), maxTotalAllowed);
    for (const size of sizeCodes) {
      if (remainingBudget <= 0) break;
      const take = Math.min(perSizeMax[size], remainingBudget);
      defaultSizes[size] = take;
      remainingBudget -= take;
    }
    return { matched, stock, sizeFormat, sizeCodes, maxTotalAllowed, perSizeMax, defaultSizes };
  }

  function renderReqSizeMatrixHtml(
    sizeFormat: string,
    sizeCodes: string[],
    perSizeMax: SizeBreakdown,
    currentSizes: SizeBreakdown,
    totalVal: number,
    maxTotalAllowed: number
  ): string {
    return `
      <div style="font-weight: 700; color: var(--ink-950); margin-bottom: 6px; font-size: 11.5px; text-transform: uppercase;">
        Asking Size Breakdown Allocation (Pairs &bull; Scale: ${escapeHtml(sizeFormat)}, ${sizeCodes.length} Sizes)
      </div>
      <div class="table-responsive">
        <table class="size-matrix-table" style="margin: 0;">
          <thead>
            <tr>
              <th scope="col" aria-label="Row" style="min-width: 76px; text-align: left;"></th>
              ${sizeCodes.map(sz => `<th scope="col">${escapeHtml(formatSizeColumnLabel(sz, sizeFormat))}</th>`).join('')}
              <th scope="col" style="background: var(--ink-200); color: var(--ink-950);">Total Asking</th>
            </tr>
          </thead>
          <tbody>
            <tr data-testid="new-req-avail-row">
              <td style="text-align: left; font-size: 11.5px; color: var(--ink-600); font-weight: 600;">Available</td>
              ${sizeCodes
                .map(sz => `<td style="font-size: 12px; color: var(--ink-600); font-variant-numeric: tabular-nums;">${Number(perSizeMax[sz] || 0).toLocaleString()}</td>`)
                .join('')}
              <td style="font-size: 12px; font-weight: 700; color: var(--ink-700); font-variant-numeric: tabular-nums;">${maxTotalAllowed.toLocaleString()}</td>
            </tr>
            <tr>
              <td style="text-align: left; font-size: 11.5px; color: var(--ink-950); font-weight: 700;">Asking</td>
              ${sizeCodes
                .map(sz => {
                  const maxAllowed = Number(perSizeMax[sz] || 0);
                  const isDisabled = maxAllowed <= 0;
                  return `<td class="${isDisabled ? 'is-size-disabled-cell' : ''}"><input type="number" class="size-matrix-input req-size-val${isDisabled ? ' is-size-disabled' : ''}" data-size="${escapeHtml(sz)}" aria-label="Asking pairs for Size ${escapeHtml(formatSizeColumnLabel(sz, sizeFormat))}" min="0" max="${maxAllowed}" value="${isDisabled ? '' : (currentSizes[sz] || '')}" placeholder="0" ${isDisabled ? 'disabled tabindex="-1"' : ''} /></td>`;
                })
                .join('')}
              <td style="font-weight: 800; font-size: 14px; color: var(--ink-950);" id="new-req-size-total">${totalVal}</td>
            </tr>
          </tbody>
        </table>
      </div>
    `;
  }

  const dockReadyOrders = state.pendingOrders.filter(
    o => !o.shortClosed && getOrderStockState(o.orderId).unclaimedPairs > 0
  );
  const defaultOrderId =
    preselectOrderId && dockReadyOrders.some(o => o.orderId === preselectOrderId)
      ? preselectOrderId
      : state.packingWip.parentOrderId && dockReadyOrders.some(o => o.orderId === state.packingWip.parentOrderId)
        ? state.packingWip.parentOrderId
        : dockReadyOrders[0]?.orderId || '';
  const initialCaps = getOrderReqEntryCaps(defaultOrderId);
  const defaultArticle = initialCaps.matched?.article || (defaultOrderId ? state.packingWip.article : '') || '';
  const currentSizes = initialCaps.defaultSizes;
  const currentTotal = calculateSizeTotal(currentSizes);

  openModal('Create Packing Hall Requisition', `
    <div style="font-size: 13px;">
      <p style="margin-bottom: 12px; color: var(--ink-600);">
        Choose an order with received Inward Register stock and enter the pairs to draw.
      </p>
      <div class="modal-meta-grid-3">
        <div class="form-group">
          <label for="new-req-parent-order">Received Order #</label>
          <select id="new-req-parent-order" class="form-select">
            ${
              dockReadyOrders.length === 0
                ? '<option value="">-- No received dock stock available --</option>'
                : `<option value="">-- Select Order With Dock Stock --</option>${dockReadyOrders
                    .map(o => {
                      const avail = getOrderStockState(o.orderId).unclaimedPairs;
                      return `<option value="${escapeHtml(o.orderId)}" ${defaultOrderId === o.orderId ? 'selected' : ''}>${escapeHtml(o.orderId)} (${escapeHtml(o.article)} &bull; ${avail.toLocaleString()} Prs available)</option>`;
                    })
                    .join('')}`
            }
          </select>
        </div>
        <div class="form-group">
          <label for="new-req-number-preview">Requisition #</label>
          <input type="text" id="new-req-number-preview" class="form-input" value="Assigned when saved" readonly aria-readonly="true" />
        </div>
        <div class="form-group">
          <label for="new-req-article">Article</label>
          <input type="text" id="new-req-article" class="form-input" value="${escapeHtml(defaultArticle)}" readonly aria-readonly="true" />
        </div>
      </div>

      <div id="new-req-cap-summary" style="display: flex; justify-content: space-between; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; font-size: 12px; background: var(--ink-50); border: 1px solid var(--border-strong); padding: 8px 12px; border-radius: 4px;">
      </div>

      <div id="new-req-size-matrix-container" style="background: var(--ink-50); border: 1px solid var(--border-strong); border-radius: 4px; padding: 10px; margin-bottom: 14px;">
        ${renderReqSizeMatrixHtml(initialCaps.sizeFormat, initialCaps.sizeCodes, initialCaps.perSizeMax, currentSizes, currentTotal, initialCaps.maxTotalAllowed)}
      </div>

      <div class="form-group" style="margin-bottom: 10px;">
        <label for="new-req-pairs">Total Asking / Requested Pairs</label>
        <input type="number" id="new-req-pairs" class="form-input" value="${currentTotal}" readonly aria-readonly="true" />
      </div>
      <div id="new-req-cap-warning" role="alert" aria-live="polite" style="display: none; margin-bottom: 12px; padding: 8px 10px; background: var(--ink-100); border: 1px solid var(--border-strong); border-radius: 4px; font-size: 12px; color: var(--ink-950); font-weight: 600;"></div>

      <div style="display: flex; justify-content: flex-end; gap: 8px;">
        <button type="button" class="btn-outline" data-modal-cancel>Cancel</button>
        <button type="button" class="btn-primary" id="btn-confirm-lot-draw">Save Requisition</button>
      </div>
    </div>
  `, false, { hideGlobalFooter: true });

  const parentOrderSelect = document.getElementById('new-req-parent-order') as HTMLSelectElement;
  const articleInput = document.getElementById('new-req-article') as HTMLInputElement;
  const matrixContainer = document.getElementById('new-req-size-matrix-container');
  const totalPairsInput = document.getElementById('new-req-pairs') as HTMLInputElement;
  const capSummaryEl = document.getElementById('new-req-cap-summary');
  const capWarningEl = document.getElementById('new-req-cap-warning');
  const saveReqButton = document.getElementById('btn-confirm-lot-draw') as HTMLButtonElement | null;

  let activeCaps = initialCaps;

  function renderCapSummaryAndValidation(enteredTotal: number): void {
    const { maxTotalAllowed } = activeCaps;
    if (capSummaryEl) {
      capSummaryEl.innerHTML = `
        <span>Available at Dock: <strong>${maxTotalAllowed.toLocaleString()} Prs</strong></span>
      `;
    }
    const exceeds = enteredTotal > maxTotalAllowed;
    if (capWarningEl) {
      if (maxTotalAllowed <= 0) {
        capWarningEl.style.display = 'block';
        capWarningEl.textContent = 'No unclaimed Inward Register stock available. Receive stock in Inward Goods Receiving first.';
      } else if (exceeds) {
        capWarningEl.style.display = 'block';
        capWarningEl.textContent = `Asking ${enteredTotal.toLocaleString()} pairs exceeds Available at Dock (${maxTotalAllowed.toLocaleString()} Prs).`;
      } else {
        capWarningEl.style.display = 'none';
        capWarningEl.textContent = '';
      }
    }
    if (saveReqButton) {
      saveReqButton.disabled = maxTotalAllowed <= 0 || exceeds || enteredTotal <= 0;
    }
  }

  function recalcReqModalSizes() {
    const sizes = createEmptySizes(activeCaps.sizeCodes);
    document.querySelectorAll('.req-size-val').forEach(el => {
      const input = el as HTMLInputElement;
      const size = input.getAttribute('data-size') || '';
      if (size && activeCaps.sizeCodes.includes(size)) {
        const sizeCap = Number(activeCaps.perSizeMax[size] || 0);
        const raw = Math.max(0, parseInt(input.value || '0', 10) || 0);
        const clamped = Math.min(raw, sizeCap);
        if (raw > sizeCap) {
          input.value = String(clamped);
        }
        sizes[size] = clamped;
      }
    });
    const total = calculateSizeTotal(sizes);
    const sizeTotalCell = document.getElementById('new-req-size-total');
    if (sizeTotalCell) sizeTotalCell.textContent = total.toLocaleString();
    if (totalPairsInput) totalPairsInput.value = String(total);
    renderCapSummaryAndValidation(total);
  }

  function readRequestSizes(): SizeBreakdown {
    const sizes = createEmptySizes(activeCaps.sizeCodes);
    document.querySelectorAll('.req-size-val').forEach(el => {
      const input = el as HTMLInputElement;
      const size = input.getAttribute('data-size') || '';
      if (size && activeCaps.sizeCodes.includes(size)) {
        sizes[size] = Math.max(0, parseInt(input.value || '0', 10) || 0);
      }
    });
    return sizes;
  }

  function bindReqSizeMatrixInputs(): void {
    document.querySelectorAll('.req-size-val').forEach(input => {
      input.addEventListener('input', recalcReqModalSizes);
    });
  }

  parentOrderSelect?.addEventListener('change', () => {
    activeCaps = getOrderReqEntryCaps(parentOrderSelect.value);
    if (articleInput) articleInput.value = activeCaps.matched?.article || '';
    const nextTotal = calculateSizeTotal(activeCaps.defaultSizes);
    if (matrixContainer) {
      matrixContainer.innerHTML = renderReqSizeMatrixHtml(
        activeCaps.sizeFormat,
        activeCaps.sizeCodes,
        activeCaps.perSizeMax,
        activeCaps.defaultSizes,
        nextTotal,
        activeCaps.maxTotalAllowed
      );
      bindReqSizeMatrixInputs();
    }
    recalcReqModalSizes();
  });

  bindReqSizeMatrixInputs();
  renderCapSummaryAndValidation(currentTotal);

  let createReqInFlight = false;
  document.getElementById('btn-confirm-lot-draw')?.addEventListener('click', async (event) => {
    if (createReqInFlight) return;
    const saveButton = event.currentTarget as HTMLButtonElement;
    const parentOrderId = parentOrderSelect?.value || '';
    const parentOrder = state.pendingOrders.find(order => order.orderId === parentOrderId);
    if (!parentOrder) {
      showToast('Select a received order with dock stock first.');
      return;
    }

    const sizes = readRequestSizes();
    const pairs = calculateSizeTotal(sizes);
    if (pairs <= 0) {
      showToast('Enter a quantity for at least one size.');
      return;
    }
    if (pairs > activeCaps.maxTotalAllowed) {
      showToast(`Requested ${pairs.toLocaleString()} pairs exceeds available Inward stock (${activeCaps.maxTotalAllowed.toLocaleString()} pairs).`);
      return;
    }

    createReqInFlight = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Saving...';
    try {
      const response = await fetch(`/api/orders/${encodeURIComponent(parentOrderId)}/requisitions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sizes })
      });
      const result = await response.json();
      if (!response.ok || !result.success || !result.data?.reqNumber) {
        showToast(result.error || 'Requisition was not saved. Please try again.');
        return;
      }

      const saved = result.data;
      const reqNumber = normalizeBaseReqNumber(saved.reqNumber);
      const wip = applyServerRequisition(saved, true);
      state.persistedReqNumbers = Array.from(new Set([...state.persistedReqNumbers, reqNumber]));
      if (parentOrder.availableDockPairs !== undefined) {
        parentOrder.requestedPairs = Number(parentOrder.requestedPairs || 0) + pairs;
        parentOrder.pendingReqPairs = Number(parentOrder.pendingReqPairs || 0) + pairs;
        parentOrder.unclaimedDockPairs = Math.max(0, Number(parentOrder.availableDockPairs || 0) - parentOrder.pendingReqPairs);
        for (const size of activeCaps.sizeCodes) {
          const reqSz = Number(sizes[size] || 0);
          if (parentOrder.remainingOrderSizes) {
            parentOrder.remainingOrderSizes[size] = Math.max(0, Number(parentOrder.remainingOrderSizes[size] || 0) - reqSz);
          }
          if (parentOrder.requestedSizes) {
            parentOrder.requestedSizes[size] = Number(parentOrder.requestedSizes[size] || 0) + reqSz;
          }
          if (parentOrder.unclaimedDockSizes) {
            parentOrder.unclaimedDockSizes[size] = Math.max(0, Number(parentOrder.unclaimedDockSizes[size] || 0) - reqSz);
          }
        }
      }
      state.repairForm.batchId = wip.altReqNo;
      if (!state.dropdownOptions.defectBatchIds.includes(wip.altReqNo)) {
        state.dropdownOptions.defectBatchIds.unshift(wip.altReqNo);
      }

      closeModal();
      renderApp();
      showToast(`Requisition ${reqNumber} saved for Order ${parentOrderId} (${pairs.toLocaleString()} pairs). Use Print Requisition when ready.`);
    } catch (error) {
      console.error('Requisition save failed:', error);
      showToast('Requisition could not be saved. No requisition was created.');
    } finally {
      createReqInFlight = false;
      if (saveButton.isConnected) {
        saveButton.disabled = false;
        saveButton.textContent = 'Save Requisition';
      }
    }
  });
}
