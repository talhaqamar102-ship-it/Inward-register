import {
  PendingOrder,
  SizeBreakdown,
  calculateSizeTotal,
  createEmptySizes,
  escapeHtml
} from '../../utils/requisitionLogic';

export interface EditOrderModalDeps {
  order: PendingOrder;
  sizeCodes: string[];
  receivedPairs: number;
  requestedPairs: number;
  makers: string[];
  openModal: (
    title: string,
    htmlContent: string,
    isPrintable?: boolean,
    options?: { hideGlobalFooter?: boolean; returnFocusTarget?: HTMLElement | null }
  ) => void;
  closeModal: () => void;
  showToast: (message: string) => void;
  onSaved?: (updatedOrders?: PendingOrder[], grandTotal?: number) => Promise<void> | void;
}

interface AllocationRowDraft {
  maker: string;
  dueDate: string;
  sizes: SizeBreakdown;
}

export function openEditPendingOrderModal({
  order,
  sizeCodes,
  receivedPairs,
  requestedPairs,
  makers,
  openModal,
  closeModal,
  showToast,
  onSaved
}: EditOrderModalDeps): void {
  const orderId = order.orderId;
  const buildZeroSizes = (): SizeBreakdown => createEmptySizes(sizeCodes);

  const rows: AllocationRowDraft[] =
    Array.isArray(order.contractorAllocations) && order.contractorAllocations.length > 0
      ? order.contractorAllocations.map(a => {
          const sz = buildZeroSizes();
          for (const c of sizeCodes) {
            sz[c] = Number(a.sizes?.[c] || 0);
          }
          return {
            maker: a.maker || order.maker,
            dueDate: a.dueDate || order.dueDate || '',
            sizes: sz
          };
        })
      : (() => {
          const sz = buildZeroSizes();
          for (const c of sizeCodes) {
            sz[c] = Number(order.sizes?.[c] || 0);
          }
          return [{ maker: order.maker, dueDate: order.dueDate || '', sizes: sz }];
        })();

  const allMakers = Array.from(
    new Set([
      ...makers,
      ...rows.map(r => r.maker).filter(Boolean)
    ])
  ).sort((a, b) => a.localeCompare(b));

  const renderRowsHtml = () => rows.map((row, idx) => {
    const rowTotal = calculateSizeTotal(row.sizes);
    return `
      <tr data-edit-row="${idx}">
        <td class="su-edit-order-maker-cell">
          <select class="form-select edit-order-row-maker su-edit-order-row-maker" data-row-idx="${idx}">
            <option value="">-- Maker / Hall --</option>
            ${allMakers.map(m => `<option value="${escapeHtml(m)}"${row.maker === m ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('')}
          </select>
        </td>
        ${sizeCodes.map(code => `
          <td class="su-edit-order-cell">
            <input type="number" class="form-input edit-order-size-val su-edit-order-size-val" data-row-idx="${idx}" data-size="${escapeHtml(code)}" min="0" value="${Number(row.sizes[code] || 0)}" />
          </td>
        `).join('')}
        <td class="su-edit-order-cell">
          <input type="date" class="form-input edit-order-row-due su-edit-order-row-due" data-row-idx="${idx}" value="${escapeHtml(row.dueDate || '')}" />
        </td>
        <td class="text-right su-edit-order-row-total" id="edit-order-row-total-${idx}">${rowTotal.toLocaleString()}</td>
        <td class="text-center su-edit-order-cell">
          ${rows.length > 1
            ? `<button type="button" class="btn-outline edit-order-remove-row su-edit-order-remove-row" data-row-idx="${idx}">Remove</button>`
            : '—'}
        </td>
      </tr>
    `;
  }).join('');

  const modalHtml = `
    <div id="edit-order-modal-body" class="su-edit-order-body">
      <div class="su-edit-order-summary">
        <div><div class="su-edit-order-summary-label">Order #</div><strong>${escapeHtml(order.orderId)}</strong></div>
        <div><div class="su-edit-order-summary-label">Buyer</div><strong>${escapeHtml(order.buyer || '---')}</strong></div>
        <div><div class="su-edit-order-summary-label">Article</div><strong>${escapeHtml(order.article || '---')}</strong></div>
        <div><div class="su-edit-order-summary-label">Already Received</div><strong>${receivedPairs.toLocaleString()} prs</strong></div>
        <div><div class="su-edit-order-summary-label">Already Requested</div><strong>${requestedPairs.toLocaleString()} prs</strong></div>
      </div>

      <div class="su-edit-order-meta-grid">
        <div class="form-group">
          <label for="edit-order-po">PO Number</label>
          <input type="text" id="edit-order-po" class="form-input" value="${escapeHtml(order.po || '')}" />
        </div>
        <div class="form-group">
          <label for="edit-order-color">Colour / Shade</label>
          <input type="text" id="edit-order-color" class="form-input" value="${escapeHtml(order.color || 'Standard')}" />
        </div>
        <div class="form-group">
          <label for="edit-order-due-date">Delivery Due Date</label>
          <input type="date" id="edit-order-due-date" class="form-input" value="${escapeHtml(order.dueDate || '')}" />
        </div>
      </div>

      <div class="table-responsive su-edit-order-table-wrap">
        <table class="data-table" id="edit-order-alloc-table">
          <thead>
            <tr>
              <th>Contractor / Hall</th>
              ${sizeCodes.map(c => `<th class="text-right">${escapeHtml(c)}</th>`).join('')}
              <th>Row Due Date</th>
              <th class="text-right">Total</th>
              <th class="text-center">Action</th>
            </tr>
          </thead>
          <tbody id="edit-order-alloc-tbody">
            ${renderRowsHtml()}
          </tbody>
        </table>
      </div>

      <div class="su-edit-order-split-bar">
        <button type="button" class="btn-outline su-edit-order-add-btn" id="btn-edit-order-add-row">+ Add contractor split</button>
        <div class="su-edit-order-grand-wrap">
          New Planned Total: <strong id="edit-order-grand-total">0</strong> pairs
        </div>
      </div>

      <div class="form-group su-edit-order-reason-group">
        <label for="edit-order-reason">Reason for order adjustment (recorded in Audit Trail)</label>
        <input type="text" id="edit-order-reason" class="form-input" placeholder="e.g. Buyer revised size curve and extended due date" />
      </div>

      <div class="form-group su-edit-order-pwd-group">
        <label for="edit-order-admin-password">Admin password (required to authorize order edit)</label>
        <input type="password" id="edit-order-admin-password" class="form-input" autocomplete="current-password" placeholder="Enter your Super User password" />
      </div>

      <div class="su-edit-order-footer">
        <button type="button" class="btn-outline" data-modal-cancel>Cancel</button>
        <button type="button" class="btn-primary" id="btn-submit-edit-order">Save order changes</button>
      </div>
    </div>
  `;

  openModal(`Edit Order — ${order.orderId} (${order.article || '---'})`, modalHtml, false, { hideGlobalFooter: true });

  const syncFromDom = (): number => {
    rows.forEach((row, idx) => {
      const mSel = document.querySelector<HTMLSelectElement>(`.edit-order-row-maker[data-row-idx="${idx}"]`);
      const dInp = document.querySelector<HTMLInputElement>(`.edit-order-row-due[data-row-idx="${idx}"]`);
      if (mSel) row.maker = mSel.value.trim();
      if (dInp) row.dueDate = dInp.value.trim();
      sizeCodes.forEach(c => {
        const sInp = document.querySelector<HTMLInputElement>(`.edit-order-size-val[data-row-idx="${idx}"][data-size="${c}"]`);
        if (sInp) row.sizes[c] = Math.max(0, parseInt(sInp.value || '0', 10) || 0);
      });
      const rowTotalCell = document.getElementById(`edit-order-row-total-${idx}`);
      if (rowTotalCell) rowTotalCell.textContent = calculateSizeTotal(row.sizes).toLocaleString();
    });
    const grand = rows.reduce((sum, r) => sum + calculateSizeTotal(r.sizes), 0);
    const grandEl = document.getElementById('edit-order-grand-total');
    if (grandEl) grandEl.textContent = grand.toLocaleString();
    return grand;
  };

  const rebindRowEvents = (): void => {
    document.querySelectorAll('.edit-order-size-val, .edit-order-row-maker, .edit-order-row-due').forEach(el => {
      el.addEventListener('input', syncFromDom);
      el.addEventListener('change', syncFromDom);
    });
    document.querySelectorAll<HTMLButtonElement>('.edit-order-remove-row').forEach(btn => {
      btn.addEventListener('click', () => {
        if (rows.length <= 1) return;
        syncFromDom();
        const idx = Number(btn.getAttribute('data-row-idx'));
        if (Number.isInteger(idx) && rows[idx]) {
          rows.splice(idx, 1);
          const tbody = document.getElementById('edit-order-alloc-tbody');
          if (tbody) tbody.innerHTML = renderRowsHtml();
          rebindRowEvents();
          syncFromDom();
        }
      });
    });
  };

  rebindRowEvents();
  syncFromDom();

  document.getElementById('btn-edit-order-add-row')?.addEventListener('click', () => {
    syncFromDom();
    const topDue = (document.getElementById('edit-order-due-date') as HTMLInputElement | null)?.value?.trim() || order.dueDate || '';
    rows.push({ maker: '', dueDate: topDue, sizes: buildZeroSizes() });
    const tbody = document.getElementById('edit-order-alloc-tbody');
    if (tbody) tbody.innerHTML = renderRowsHtml();
    rebindRowEvents();
    syncFromDom();
  });

  let saveInFlight = false;
  document.getElementById('btn-submit-edit-order')?.addEventListener('click', async () => {
    if (saveInFlight) return;
    const grandTotal = syncFromDom();
    const seen = new Set<string>();
    for (const r of rows) {
      if (!r.maker.trim()) {
        showToast('Select a Contractor / Hall for every split row.');
        return;
      }
      const key = r.maker.trim().toLowerCase();
      if (seen.has(key)) {
        showToast(`Duplicate contractor "${r.maker}" in order split.`);
        return;
      }
      seen.add(key);
      if (calculateSizeTotal(r.sizes) <= 0) {
        showToast(`Contractor "${r.maker}" must have at least 1 pair.`);
        return;
      }
    }
    if (grandTotal <= 0) {
      showToast('Order planned quantity must be greater than 0.');
      return;
    }

    const poVal = (document.getElementById('edit-order-po') as HTMLInputElement | null)?.value?.trim() || '';
    const colorVal = (document.getElementById('edit-order-color') as HTMLInputElement | null)?.value?.trim() || 'Standard';
    const topDueDate = (document.getElementById('edit-order-due-date') as HTMLInputElement | null)?.value?.trim() || '';
    const reasonVal = (document.getElementById('edit-order-reason') as HTMLInputElement | null)?.value?.trim() || '';
    const pwdInput = document.getElementById('edit-order-admin-password') as HTMLInputElement | null;
    const adminPassword = pwdInput?.value || '';
    if (!adminPassword) {
      showToast('Enter your Admin password to confirm order changes.');
      pwdInput?.focus();
      return;
    }

    const aggSizes = buildZeroSizes();
    for (const r of rows) {
      for (const c of sizeCodes) {
        aggSizes[c] = Number(aggSizes[c] || 0) + Number(r.sizes[c] || 0);
      }
    }

    const btn = document.getElementById('btn-submit-edit-order') as HTMLButtonElement | null;
    saveInFlight = true;
    if (btn) btn.disabled = true;

    try {
      const res = await fetch(`/api/admin/pending-orders/${encodeURIComponent(orderId)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          po: poVal,
          color: colorVal,
          dueDate: topDueDate,
          reason: reasonVal,
          adminPassword,
          maker: rows.length === 1 ? rows[0].maker : rows.map(r => r.maker).join(', '),
          sizes: aggSizes,
          totalQty: grandTotal,
          allocations: rows.map(r => ({
            maker: r.maker,
            dueDate: r.dueDate || topDueDate,
            sizes: r.sizes
          }))
        })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.success) {
        if (res.status === 401 && pwdInput) {
          pwdInput.value = '';
          pwdInput.focus();
        }
        showToast(json.error || `Unable to update order ${orderId}.`);
        return;
      }
      closeModal();
      await onSaved?.(Array.isArray(json.data?.orders) ? json.data.orders : undefined, grandTotal);
    } catch (err) {
      showToast(err instanceof Error ? err.message : `Unable to update order ${orderId}.`);
    } finally {
      saveInFlight = false;
      if (btn?.isConnected) btn.disabled = false;
    }
  });
}
