import {
  PendingOrder,
  SizeBreakdown,
  calculateSizeTotal,
  createEmptySizes,
  escapeHtml,
  validateContractorAllocations
} from '../../utils/requisitionLogic';

export interface AssignRemainingModalDeps {
  order: PendingOrder;
  sizeCodes: string[];
  makers: string[];
  halls?: Array<{ id: number; name: string }>;
  externalMakers?: Array<{ id: number; name: string }>;
  openModal: (
    title: string,
    htmlContent: string,
    isPrintable?: boolean,
    options?: { hideGlobalFooter?: boolean; returnFocusTarget?: HTMLElement | null }
  ) => void;
  closeModal: () => void;
  showToast: (message: string) => void;
  onSaved?: (updatedOrders: PendingOrder[], message: string) => Promise<void> | void;
}

interface AssignRowDraft {
  maker: string;
  dueDate: string;
  sizes: SizeBreakdown;
}

export function openAssignRemainingOrderModal({
  order,
  sizeCodes,
  makers,
  halls = [],
  externalMakers = [],
  openModal,
  closeModal,
  showToast,
  onSaved
}: AssignRemainingModalDeps): void {
  const orderId = order.orderId;
  const unassignedSizes: SizeBreakdown = createEmptySizes(sizeCodes);
  for (const sz of sizeCodes) {
    if (order.unassignedSizes && order.unassignedSizes[sz] !== undefined) {
      unassignedSizes[sz] = Math.max(0, Number(order.unassignedSizes[sz] || 0));
    } else {
      const planned = Math.max(0, Number(order.sizes?.[sz] || 0));
      const alreadyAssigned = (order.contractorAllocations || []).reduce(
        (sum, alloc) => sum + Math.max(0, Number(alloc.sizes?.[sz] || 0)),
        0
      );
      unassignedSizes[sz] = Math.max(0, planned - alreadyAssigned);
    }
  }
  const totalUnassigned = calculateSizeTotal(unassignedSizes);
  if (totalUnassigned <= 0) {
    showToast(`Order ${orderId} has no unassigned pairs left.`);
    return;
  }

  const hallNames = halls.map(h => h.name);
  const extNames = externalMakers.map(m => m.name);
  const knownKeys = new Set([...hallNames, ...extNames].map(n => n.trim().toLowerCase()));
  const extraNames = makers.filter(m => {
    const k = String(m || '').trim().toLowerCase();
    return Boolean(k) && !knownKeys.has(k);
  });

  const renderMakerOptions = (selectedMaker: string) => {
    const sel = String(selectedMaker || '').trim();
    const renderOpt = (m: string) => `<option value="${escapeHtml(m)}"${sel === m ? ' selected' : ''}>${escapeHtml(m)}</option>`;
    if (hallNames.length > 0 && extNames.length > 0) {
      return [
        `<optgroup label="Internal Halls">${hallNames.map(renderOpt).join('')}</optgroup>`,
        `<optgroup label="External Contractors / Makers">${extNames.map(renderOpt).join('')}</optgroup>`,
        ...extraNames.map(renderOpt)
      ].join('');
    }
    return [...hallNames, ...extNames, ...extraNames].map(renderOpt).join('');
  };

  const defaultMaker = hallNames[0] || extNames[0] || makers[0] || '';
  const rows: AssignRowDraft[] = [
    {
      maker: defaultMaker,
      dueDate: order.dueDate || '',
      sizes: createEmptySizes(sizeCodes)
    }
  ];

  const renderRowsHtml = () => rows.map((row, idx) => {
    const rowTotal = calculateSizeTotal(row.sizes);
    return `
      <tr data-assign-row="${idx}">
        <td class="su-edit-order-maker-cell">
          <select class="form-select assign-rem-row-maker su-edit-order-row-maker" data-row-idx="${idx}" aria-label="Contractor row ${idx + 1}">
            <option value="">-- Choose Contractor --</option>
            ${renderMakerOptions(row.maker)}
          </select>
        </td>
        ${sizeCodes.map(code => {
          const cap = unassignedSizes[code] || 0;
          const isZeroCap = cap <= 0;
          return `
          <td class="su-edit-order-cell">
            <input
              type="number"
              class="form-input assign-rem-size-val su-edit-order-size-val${isZeroCap ? ' is-size-disabled' : ''}"
              data-row-idx="${idx}"
              data-size="${escapeHtml(code)}"
              min="0"
              max="${cap}"
              ${isZeroCap ? 'disabled tabindex="-1"' : ''}
              value="${Number(row.sizes[code] || 0) || ''}"
              placeholder="0"
            />
          </td>`;
        }).join('')}
        <td class="su-edit-order-cell">
          <input type="date" class="form-input assign-rem-row-due su-edit-order-row-due" data-row-idx="${idx}" value="${escapeHtml(row.dueDate || '')}" />
        </td>
        <td class="text-right su-edit-order-row-total" id="assign-rem-row-total-${idx}">${rowTotal.toLocaleString()}</td>
        <td class="text-center su-edit-order-cell" style="white-space: nowrap;">
          ${idx === 0 ? `<button type="button" class="btn-outline" id="btn-assign-rem-fill-all" style="padding: 2px 7px; font-size: 11px;">Fill all</button> ` : ''}
          ${rows.length > 1
            ? `<button type="button" class="btn-outline assign-rem-remove-row su-edit-order-remove-row" data-row-idx="${idx}">Remove</button>`
            : (idx === 0 ? '' : 'Min 1')}
        </td>
      </tr>
    `;
  }).join('');

  const modalHtml = `
    <div id="assign-remaining-order-modal" class="su-edit-order-shell">
      <div class="su-edit-order-meta">
        <span><strong>Order:</strong> ${escapeHtml(orderId)}</span>
        <span><strong>Buyer:</strong> ${escapeHtml(order.buyer || '---')}</span>
        <span><strong>Article:</strong> ${escapeHtml(order.article)} (${escapeHtml(order.color || 'Standard')})</span>
        <span><strong>PO:</strong> ${escapeHtml(order.po || '---')}</span>
        <span><strong>Unassigned pool:</strong> <strong id="assign-rem-pool-total">${totalUnassigned.toLocaleString()} Prs</strong></span>
      </div>

      <div class="table-responsive su-edit-order-table-wrap">
        <table class="size-matrix-table su-edit-order-table">
          <thead>
            <tr>
              <th>Contractor / Hall</th>
              ${sizeCodes.map(c => `<th>${escapeHtml(c)}<div style="font-size:10px; font-weight:400; color:var(--ink-500);">Rem ${unassignedSizes[c] || 0}</div></th>`).join('')}
              <th>Due Date</th>
              <th class="text-right">Assigned</th>
              <th class="text-center">Action</th>
            </tr>
          </thead>
          <tbody id="assign-rem-rows-body">
            ${renderRowsHtml()}
          </tbody>
        </table>
      </div>

      <div class="su-edit-order-toolbar">
        <button type="button" class="btn-outline su-edit-order-add-btn" id="btn-assign-rem-add-row">+ Split across another contractor</button>
        <div id="assign-rem-balance-summary" class="su-split-balance-bar is-partial" style="margin-top: 0; flex: 1;">
          <span>Assign 1+ contractor rows (up to ${totalUnassigned.toLocaleString()} Prs remaining).</span>
          <strong>0 Prs assigning now &middot; ${totalUnassigned.toLocaleString()} left unassigned</strong>
        </div>
      </div>

      <div class="form-group">
        <label for="assign-rem-reason" class="su-edit-order-label">Assignment note (optional)</label>
        <input type="text" id="assign-rem-reason" class="form-input su-edit-order-reason" placeholder="e.g. Second phase allocation to Hall B & Maker A" />
      </div>

      <div id="assign-rem-error" class="su-edit-order-error" role="alert"></div>

      <div class="su-edit-order-actions">
        <button type="button" class="btn-outline" id="btn-assign-rem-cancel" data-modal-cancel>Cancel</button>
        <button type="button" class="btn-primary" id="btn-assign-rem-submit">Save contractor assignment</button>
      </div>
    </div>
  `;

  openModal(`Assign Remaining Pairs — ${orderId}`, modalHtml, false, { hideGlobalFooter: true });

  const syncSummary = () => {
    rows.forEach((r, idx) => {
      const cell = document.getElementById(`assign-rem-row-total-${idx}`);
      if (cell) cell.textContent = calculateSizeTotal(r.sizes).toLocaleString();
    });
    const check = validateContractorAllocations(unassignedSizes, rows, sizeCodes, { allowPartial: true });
    const assigningNow = Math.max(0, totalUnassigned - check.totalUnassigned);
    const bar = document.getElementById('assign-rem-balance-summary');
    if (bar) {
      bar.className = `su-split-balance-bar ${
        !check.valid
          ? 'is-unbalanced'
          : (check.totalUnassigned === 0 ? 'is-balanced' : 'is-partial')
      }`;
      bar.style.marginTop = '0';
      bar.style.flex = '1';
      bar.innerHTML = `
        <span>
          Remaining Unassigned:
          ${sizeCodes.map(sz => `<strong>${escapeHtml(sz)}:${check.unassignedBySize[sz] ?? 0}</strong>`).join(' | ')}
        </span>
        <strong>${
          !check.valid
            ? escapeHtml(check.error || 'Adjust quantities')
            : `${assigningNow.toLocaleString()} Prs assigning &middot; ${check.totalUnassigned.toLocaleString()} left unassigned`
        }</strong>
      `;
    }
  };

  const bindRowListeners = () => {
    document.querySelectorAll<HTMLSelectElement>('.assign-rem-row-maker').forEach(sel => {
      sel.addEventListener('change', () => {
        const idx = Number(sel.getAttribute('data-row-idx'));
        if (rows[idx]) rows[idx].maker = sel.value.trim();
      });
    });
    document.querySelectorAll<HTMLInputElement>('.assign-rem-size-val').forEach(inp => {
      inp.addEventListener('input', () => {
        const idx = Number(inp.getAttribute('data-row-idx'));
        const sz = inp.getAttribute('data-size') || '';
        if (rows[idx] && sz) {
          rows[idx].sizes[sz] = Math.max(0, parseInt(inp.value || '0', 10) || 0);
          syncSummary();
        }
      });
    });
    document.querySelectorAll<HTMLInputElement>('.assign-rem-row-due').forEach(inp => {
      inp.addEventListener('change', () => {
        const idx = Number(inp.getAttribute('data-row-idx'));
        if (rows[idx]) rows[idx].dueDate = inp.value;
      });
    });
    document.querySelectorAll<HTMLButtonElement>('.assign-rem-remove-row').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-row-idx'));
        if (rows.length > 1 && Number.isInteger(idx)) {
          rows.splice(idx, 1);
          const tbody = document.getElementById('assign-rem-rows-body');
          if (tbody) {
            tbody.innerHTML = renderRowsHtml();
            bindRowListeners();
            syncSummary();
          }
        }
      });
    });
    document.getElementById('btn-assign-rem-fill-all')?.addEventListener('click', () => {
      if (!rows[0]) return;
      for (const sz of sizeCodes) {
        const usedByOthers = rows.slice(1).reduce((sum, r) => sum + Number(r.sizes[sz] || 0), 0);
        rows[0].sizes[sz] = Math.max(0, (unassignedSizes[sz] || 0) - usedByOthers);
      }
      const tbody = document.getElementById('assign-rem-rows-body');
      if (tbody) {
        tbody.innerHTML = renderRowsHtml();
        bindRowListeners();
        syncSummary();
      }
    });
  };

  bindRowListeners();
  syncSummary();

  document.getElementById('btn-assign-rem-add-row')?.addEventListener('click', () => {
    const used = new Set(rows.map(r => r.maker));
    const candidate = [...hallNames, ...extNames, ...extraNames].find(m => !used.has(m)) || '';
    rows.push({ maker: candidate, dueDate: order.dueDate || '', sizes: createEmptySizes(sizeCodes) });
    const tbody = document.getElementById('assign-rem-rows-body');
    if (tbody) {
      tbody.innerHTML = renderRowsHtml();
      bindRowListeners();
      syncSummary();
    }
  });

  document.getElementById('btn-assign-rem-submit')?.addEventListener('click', async () => {
    const errEl = document.getElementById('assign-rem-error');
    const setErr = (msg: string) => {
      if (errEl) {
        errEl.textContent = msg;
        errEl.style.display = msg ? 'block' : 'none';
      }
    };
    setErr('');

    const check = validateContractorAllocations(unassignedSizes, rows, sizeCodes, { allowPartial: true });
    if (!check.valid) {
      setErr(check.error || 'Adjust contractor quantities.');
      return;
    }

    const allocations = rows
      .filter(r => r.maker.trim() && calculateSizeTotal(r.sizes) > 0)
      .map(r => ({ maker: r.maker.trim(), dueDate: r.dueDate, sizes: { ...r.sizes } }));

    if (allocations.length === 0) {
      setErr('Assign at least 1 pair to a contractor.');
      return;
    }

    const reason = (document.getElementById('assign-rem-reason') as HTMLInputElement | null)?.value?.trim() || '';
    const submitBtn = document.getElementById('btn-assign-rem-submit') as HTMLButtonElement | null;
    if (submitBtn) submitBtn.disabled = true;

    try {
      const res = await fetch(`/api/admin/pending-orders/${encodeURIComponent(orderId)}/assign-remaining`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allocations, reason })
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setErr(json.error || 'Could not assign remaining pairs.');
        return;
      }
      const msg = `Assigned +${Number(json.data?.newlyAssignedPairs || 0).toLocaleString()} pairs on ${orderId} (${Number(json.data?.remainingUnassignedPairs || 0).toLocaleString()} left unassigned).`;
      closeModal();
      showToast(msg);
      if (onSaved && Array.isArray(json.data?.orders)) {
        await onSaved(json.data.orders, msg);
      }
    } catch (err: any) {
      setErr(err?.message || 'Network error while assigning remaining pairs.');
    } finally {
      if (submitBtn) submitBtn.disabled = false;
    }
  });
}
