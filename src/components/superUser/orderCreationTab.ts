import {
  calculateSizeTotal,
  validateContractorAllocations,
  computeDeliveryCountdown,
  AuditTrailEntry,
  PHASED_ROLLOUT_RECORD,
  DEFAULT_MES_POLICY_CONFIG,
  escapeHtml,
  CatalogProductOption,
  filterProductsByBuyer,
  getScaleSizeCodes,
  formatSizeColumnLabel,
  PRESET_GLOVE_COLORS,
  parseProductColorOptions
} from '../../utils/requisitionLogic';
import type { SuperUserRenderContext } from './types';
import { renderDeliveryCountdownChip } from './shared';

function formatShortScaleBadge(sizeFormat: string): string {
  const fmt = String(sizeFormat || 'LEGACY_7_11').trim();
  if (fmt === 'ALPHA_2XS_5XL') return '2XS–5XL';
  if (fmt === 'LEGACY_7_11') return '7–11';
  if (fmt === 'NUMERIC_6_12') return '6–12';
  return fmt;
}

export function renderOrderCreationTab(ctx: SuperUserRenderContext): string {
  const ov = ctx.adminOverview;
  const counts = ov.dbHealth.tableCounts || {};
  const totalRows = Object.values(counts).reduce((sum: number, n: any) => sum + Number(n || 0), 0);
  const auditTrail: AuditTrailEntry[] = ctx.auditTrail || [];
  const draft = ctx.orderDraft || {
    customerId: '',
    buyer: '',
    maker: '',
    po: '',
    productId: '',
    article: '',
    color: '',
    sizeFormat: 'LEGACY_7_11',
    dueDate: '',
    sizes: { '7': 0, '8': 0, '9': 0, '10': 0, '11': 0 }
  };

  const allCustomers: any[] = ov.customers || [];
  const allProducts: CatalogProductOption[] = (ov.products || []).slice().sort((a, b) => {
    const aIsLegacy = String(a.size_format || 'LEGACY_7_11') === 'LEGACY_7_11' ? 0 : 1;
    const bIsLegacy = String(b.size_format || 'LEGACY_7_11') === 'LEGACY_7_11' ? 0 : 1;
    if (aIsLegacy !== bIsLegacy) return aIsLegacy - bIsLegacy;
    return String(a.name || '').localeCompare(String(b.name || ''));
  });
  const buyerMatchedCatalog = draft.buyer
    ? filterProductsByBuyer(allProducts, allCustomers, draft.customerId || draft.buyer)
    : allProducts;
  const buyerHasNoArticles = Boolean(draft.buyer) && buyerMatchedCatalog.length === 0;
  const filteredCatalog = draft.buyer ? buyerMatchedCatalog : allProducts;
  const selectedProduct =
    filteredCatalog.find(p => draft.productId && p.id === draft.productId) ||
    filteredCatalog.find(p => draft.article && p.name === draft.article) ||
    (!draft.buyer ? allProducts.find(p => draft.productId && p.id === draft.productId) : undefined);
  const selectedProductColorOptions = parseProductColorOptions(selectedProduct);

  const availableStandards = Array.isArray(ov.sizeStandards) ? ov.sizeStandards : [];
  const defaultScaleCode = availableStandards.some((s: any) => s.code === 'ALPHA_2XS_5XL')
    ? 'ALPHA_2XS_5XL'
    : (availableStandards.some((s: any) => s.code === 'LEGACY_7_11')
      ? 'LEGACY_7_11'
      : (availableStandards[0]?.code || 'ALPHA_2XS_5XL'));
  const rawActiveFmt = String(draft.sizeFormat && draft.sizeFormat !== 'LEGACY_7_11'
    ? draft.sizeFormat
    : (selectedProduct?.size_format || draft.sizeFormat || defaultScaleCode)).trim() || defaultScaleCode;
  const activeSizeFormat = availableStandards.length > 0 && !availableStandards.some((s: any) => s.code === rawActiveFmt)
    ? defaultScaleCode
    : rawActiveFmt;
  const activeSizeCodes = getScaleSizeCodes(ov.sizeStandards, activeSizeFormat);
  const draftTotal = calculateSizeTotal(draft.sizes);
  const splitRows = ctx.orderSplitRows || [];
  const splitActive = splitRows.length > 0;
  const splitTargetMode = ctx.orderSplitTargetMode || (draftTotal > 0 ? 'manual' : 'auto');
  const splitValidation = splitActive
    ? validateContractorAllocations(draft.sizes, splitRows, activeSizeCodes, { allowPartial: true })
    : null;
  const catalogColorSpec = selectedProductColorOptions[0] || (selectedProduct ? String(selectedProduct.color_spec || selectedProduct.raw_color || '').trim() : '');

  const articleLines = ctx.orderArticleLines || [];
  const multiMode = articleLines.length > 0;
  const pickerOpen = Boolean(ctx.multiArticlePickerOpen);
  const multiSearch = String(ctx.multiArticleSearch || '').trim().toLowerCase();
  const multiGrandTotal = articleLines.reduce((sum, line) => sum + calculateSizeTotal(line.sizes), 0);

  const hallsList = Array.isArray(ctx.dropdownOptions.halls) ? ctx.dropdownOptions.halls : [];
  const hallNameKeys = new Set(hallsList.map(h => h.name.trim().toLowerCase()));
  const externalMakersList: Array<{ id: number; name: string }> = Array.isArray(ctx.dropdownOptions.externalMakers)
    ? ctx.dropdownOptions.externalMakers
    : (ctx.dropdownOptions.makers || [])
        .filter(m => !hallNameKeys.has(String(m || '').trim().toLowerCase()))
        .map((name, i) => ({ id: -(i + 1), name }));

  const validRegistryKeys = new Set([
    'buyers',
    'articles',
    'carton_packing',
    'makers_pos',
    'audit_trail',
    'sqlite_wal',
    'phased_rollout'
  ]);
  const activeRegTab = validRegistryKeys.has(String(ctx.activeRegistryTab || ''))
    ? String(ctx.activeRegistryTab)
    : 'buyers';
  const expandedChipsMap = ctx.expandedOrderSizeChips || {};

  const renderMakerSelectOptions = (selectedMaker: string): string => {
    const sel = String(selectedMaker || '').trim();
    const hallNames = hallsList.map(h => h.name);
    const makerNames = externalMakersList.map(m => m.name);
    const knownKeys = new Set([...hallNames, ...makerNames].map(n => n.trim().toLowerCase()));
    const legacyExtras = (ctx.dropdownOptions.makers || []).filter(m => {
      const k = String(m || '').trim().toLowerCase();
      return Boolean(k) && !knownKeys.has(k);
    });
    const renderOpt = (m: string) => `<option value="${escapeHtml(m)}" ${sel === m ? 'selected' : ''}>${escapeHtml(m)}</option>`;

    if (hallNames.length > 0 && makerNames.length > 0) {
      const extraSel = sel && !knownKeys.has(sel.toLowerCase()) && !legacyExtras.includes(sel) ? [sel] : [];
      return [
        `<optgroup label="Internal Halls">${hallNames.map(renderOpt).join('')}</optgroup>`,
        `<optgroup label="External Contractors / Makers">${makerNames.map(renderOpt).join('')}</optgroup>`,
        ...legacyExtras.map(renderOpt),
        ...extraSel.map(renderOpt)
      ].join('');
    }
    const flatNames = [...hallNames, ...makerNames, ...legacyExtras];
    const combined = flatNames.length > 0 ? flatNames : (ctx.dropdownOptions.makers || []);
    const missingSel = sel && !combined.includes(sel) ? [sel] : [];
    return [...combined, ...missingSel].map(renderOpt).join('');
  };

  const renderOrderSizeInputsHtml = (
    codes: string[],
    sizeFormat: string,
    values: Record<string, number> | undefined,
    extraClass: string,
    extraAttrsFn: (sz: string) => string,
    ariaPrefix: string
  ): string => {
    const countClass = codes.length <= 5 ? 'is-compact-scale' : '';
    return `
      <div class="su-oc-size-grid ${countClass}">
        ${codes
          .map(sz => {
            const rawVal = Number(values?.[sz] || 0);
            const filledClass = rawVal > 0 ? ' is-filled' : '';
            return `
          <label class="su-oc-size-cell">
            <span class="su-oc-size-cell-label">${escapeHtml(formatSizeColumnLabel(sz, sizeFormat))}</span>
            <input
              type="number"
              aria-label="${escapeHtml(ariaPrefix)} ${escapeHtml(formatSizeColumnLabel(sz, sizeFormat))}"
              class="form-input su-oc-size-input ${extraClass}${filledClass}"
              data-size="${escapeHtml(sz)}"
              min="0"
              placeholder="0"
              value="${rawVal > 0 ? rawVal : ''}"
              ${extraAttrsFn(sz)}
            />
          </label>`;
          })
          .join('')}
      </div>
    `;
  };

  const totalPlannedOrders = Math.max(
    Number(ctx.rollupSummary.totalPlannedPairs || 0),
    ctx.pendingOrders.reduce((acc, o) => acc + Number(o.totalQty || calculateSizeTotal(o.sizes || {}) || 0), 0)
  );
  const totalReceivedOrders = Number(ctx.rollupSummary.totalReceivedGrnPairs || 0);
  const totalIssuedOrders = Number(ctx.rollupSummary.totalIssuedReqPairs || 0);
  const totalPackedOrders = Number(ctx.rollupSummary.stage5PackedPairs || 0);
  const packedBarPct = totalPlannedOrders > 0 ? Math.min(100, Math.round((totalPackedOrders / totalPlannedOrders) * 1000) / 10) : 0;
  const issuedBarPct = totalPlannedOrders > 0
    ? Math.max(0, Math.min(100 - packedBarPct, Math.round(((totalIssuedOrders - totalPackedOrders) / totalPlannedOrders) * 1000) / 10))
    : 0;

  return `
    <div class="su-oc-workspace" data-testid="su-order-creation-workspace">
      <!-- Card 1: Order Creation Form -->
      <section class="su-oc-card su-order-hub" data-testid="su-order-creation-card">
        <div class="su-oc-card-head">
          <div class="su-oc-card-title-row">
            <h2 class="su-oc-card-title">Order creation</h2>
            <span class="su-oc-count-pill">${ctx.pendingOrders.length} ${ctx.pendingOrders.length === 1 ? 'order' : 'orders'}</span>
          </div>
          <p class="su-oc-card-subtitle">One order can receive multiple GRNs and REQs.</p>
        </div>

        <div class="su-order-form-grid">
          <div class="form-group">
            <label for="admin-pending-order-id">Order reference</label>
            <input type="text" id="admin-pending-order-id" class="form-input" placeholder="Assigned on save" readonly aria-readonly="true" />
            <small>${
              articleLines.length >= 2
                ? `Creates ${articleLines.length} linked sub-orders (-1 .. -${articleLines.length}) on save.`
                : 'Set by the server. Can&rsquo;t be changed.'
            }</small>
          </div>

          <div class="form-group">
            <label for="admin-pending-order-buyer">Buyer</label>
            <select id="admin-pending-order-buyer" class="form-select">
              <option value="">Choose buyer (${allCustomers.length || ctx.dropdownOptions.customers.length})</option>
              ${(allCustomers.length
                ? allCustomers.map(
                    (c: any) => `<option value="${escapeHtml(c.name)}" data-customer-id="${escapeHtml(c.id)}" ${draft.buyer === c.name ? 'selected' : ''}>${escapeHtml(c.name)}${c.country ? ` (${escapeHtml(c.country)})` : ''}</option>`
                  )
                : ctx.dropdownOptions.customers.map(c => `<option value="${escapeHtml(c)}" ${draft.buyer === c ? 'selected' : ''}>${escapeHtml(c)}</option>`)
              ).join('')}
            </select>
          </div>

          <div class="form-group">
            <label for="admin-pending-order-maker">${multiMode ? 'Default contractor' : (splitActive ? 'Primary contractor' : 'Primary contractor')} <span class="su-required-mark" aria-hidden="true">*</span></label>
            <select id="admin-pending-order-maker" class="form-select${!multiMode && splitActive ? ' is-split-disabled' : ''}" required aria-required="true" ${!multiMode && splitActive ? 'disabled title="Contractors are assigned in the Split Allocation table below."' : ''}>
              <option value="">Choose contractor</option>
              ${renderMakerSelectOptions(draft.maker)}
            </select>
          </div>

          <div class="form-group">
            <label for="admin-pending-order-po">PO number</label>
            <input type="text" id="admin-pending-order-po" class="form-input" placeholder="e.g. 27351" list="admin-po-preset-list" value="${escapeHtml(draft.po)}" />
            <datalist id="admin-po-preset-list">
              ${ctx.dropdownOptions.poList.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('')}
            </datalist>
          </div>

          ${
            multiMode
              ? ''
              : `
          <div class="form-group">
            <label for="admin-pending-order-article">Article <span class="su-required-mark" aria-hidden="true">*</span></label>
            <select id="admin-pending-order-article" class="form-select" required aria-required="true" ${buyerHasNoArticles ? 'disabled aria-disabled="true"' : ''}>
              <option value="">${
                draft.buyer
                  ? (buyerHasNoArticles
                      ? `No articles for ${escapeHtml(draft.buyer)} yet`
                      : `Choose article (${filteredCatalog.length} for ${escapeHtml(draft.buyer)})`)
                  : 'Choose buyer first (or pick article)'
              }</option>
              ${allProducts.length
                ? filteredCatalog
                    .map(p => {
                      const codeBadge = p.article_code ? `${p.article_code} — ` : '';
                      const label = draft.buyer ? `${codeBadge}${p.name}` : `${codeBadge}${p.name} [${p.customer_name || p.customer_id}]`;
                      const isSel = selectedProduct ? selectedProduct.id === p.id : draft.article === p.name;
                      const prodColors = parseProductColorOptions(p);
                      const primaryClr = prodColors[0] || String(p.color_spec || p.raw_color || '').trim();
                      return `<option value="${escapeHtml(p.name)}" data-product-id="${escapeHtml(p.id)}" data-customer-id="${escapeHtml(p.customer_id)}" data-customer-name="${escapeHtml(p.customer_name || '')}" data-size-format="${escapeHtml(p.size_format || 'LEGACY_7_11')}" data-color-spec="${escapeHtml(primaryClr)}" data-color-options="${escapeHtml(JSON.stringify(prodColors))}" ${isSel ? 'selected' : ''}>${escapeHtml(label)}</option>`;
                    })
                    .join('')
                : (draft.buyer
                    ? ''
                    : ctx.dropdownOptions.articles.map(a => `<option value="${escapeHtml(a)}" ${draft.article === a ? 'selected' : ''}>${escapeHtml(a)}</option>`).join(''))}
            </select>
            ${buyerHasNoArticles ? `
              <div id="admin-no-buyer-articles-notice" class="su-no-buyer-articles-notice" data-testid="admin-no-buyer-articles-cta">
                <span>No articles created for <strong>${escapeHtml(draft.buyer)}</strong> yet.</span>
                <button type="button" class="su-inline-link-btn" data-su-action="create-article-for-buyer" data-buyer-id="${escapeHtml(draft.customerId || '')}" data-buyer-name="${escapeHtml(draft.buyer)}">Create article now &rarr;</button>
              </div>
            ` : ''}
          </div>

          <div class="form-group">
            <label for="admin-pending-order-color">Colour / shade</label>
            <input type="text" id="admin-pending-order-color" class="form-input" placeholder="${selectedProductColorOptions.length > 1 ? 'Pick a colourway below' : 'Auto-filled from article'}" value="${escapeHtml(draft.color)}" />
            ${selectedProductColorOptions.length > 1 ? `
              <div class="su-color-choice-bar" data-testid="admin-order-color-options" role="group" aria-label="Saved article colourways">
                ${selectedProductColorOptions.map(opt => `
                  <button type="button" class="su-color-choice-btn${draft.color.trim().toLowerCase() === opt.toLowerCase() ? ' is-active' : ''}" data-order-color-choice="${escapeHtml(opt)}">${escapeHtml(opt)}</button>
                `).join('')}
              </div>
            ` : (catalogColorSpec ? `<small>Catalog colorway: ${escapeHtml(catalogColorSpec)}</small>` : '')}
          </div>
          `
          }

          <div class="form-group">
            <label for="admin-pending-order-due-date">Delivery due</label>
            <input type="date" id="admin-pending-order-due-date" class="form-input${!multiMode && splitActive ? ' is-split-disabled' : ''}" value="${escapeHtml(draft.dueDate)}" ${!multiMode && splitActive ? 'disabled title="Due dates are set per contractor row below."' : ''} />
          </div>
        </div>

        <div class="su-multi-art-bar" data-testid="admin-multi-article-bar">
          <div class="su-multi-art-caption">
            <strong>Multi-article order${draft.buyer ? ` (${escapeHtml(draft.buyer)})` : ''}:</strong>
            select 2+ articles on one PO to generate linked sub-orders (<code>-1</code>, <code>-2</code>, <code>-3</code>).
          </div>
          <div class="su-oc-bar-actions">
            ${!multiMode && draft.article ? `
              <button type="button" class="btn-outline su-oc-btn-sm" id="btn-admin-add-another-colour">
                + Add another colour
              </button>
            ` : ''}
            <button type="button" class="btn-outline su-oc-btn-sm" id="btn-admin-toggle-multi-articles" ${buyerHasNoArticles ? 'disabled' : ''}>
              ${
                buyerHasNoArticles
                  ? `No articles for ${escapeHtml(draft.buyer)}`
                  : (pickerOpen
                      ? 'Hide article picker'
                      : (multiMode
                          ? `Add / change articles (${articleLines.length} selected)`
                          : `Select multiple articles (${filteredCatalog.length})`))
              }
            </button>
          </div>
        </div>

        ${
          pickerOpen
            ? `
          <div class="su-multi-art-picker" data-testid="admin-multi-article-picker">
            <div class="su-multi-art-toolbar">
              <label for="admin-multi-art-search" class="sr-only">Filter buyer articles</label>
              <input type="text" id="admin-multi-art-search" class="form-input su-multi-art-search" placeholder="Filter articles by code or name..." value="${escapeHtml(ctx.multiArticleSearch || '')}" />
              <span class="admin-meta-caption">${articleLines.length} selected &bull; ${filteredCatalog.length} in list</span>
            </div>
            ${buyerHasNoArticles ? `
              <div class="su-no-buyer-articles-notice" data-testid="admin-multi-no-buyer-articles-cta">
                <span>No articles created for <strong>${escapeHtml(draft.buyer)}</strong> yet.</span>
                <button type="button" class="su-inline-link-btn" data-su-action="create-article-for-buyer" data-buyer-id="${escapeHtml(draft.customerId || '')}" data-buyer-name="${escapeHtml(draft.buyer)}">Create article in Master Registry &rarr;</button>
              </div>
            ` : `
            <div class="su-multi-art-grid">
              ${filteredCatalog.map(p => {
                const isSelected = articleLines.some(l => (l.productId ? l.productId === p.id : l.article === p.name));
                const codeBadge = p.article_code ? `${p.article_code} — ` : '';
                const fmt = String(p.size_format || 'LEGACY_7_11').trim() || 'LEGACY_7_11';
                const clrOptions = parseProductColorOptions(p);
                const clr = clrOptions[0] || String(p.color_spec || p.raw_color || '').trim();
                const clrSummary = clrOptions.length > 1 ? `${clrOptions.length} colourways` : clr;
                const searchKey = `${p.article_code || ''} ${p.name} ${p.customer_name || ''} ${fmt} ${clrOptions.join(' ')}`.toLowerCase();
                const hiddenAttr = multiSearch && !searchKey.includes(multiSearch) ? ' hidden' : '';
                return `
                  <label class="su-multi-art-item${isSelected ? ' is-selected' : ''}" data-search="${escapeHtml(searchKey)}"${hiddenAttr}>
                    <input type="checkbox" class="admin-multi-art-check"
                      data-product-id="${escapeHtml(p.id || '')}"
                      data-article-name="${escapeHtml(p.name)}"
                      data-size-format="${escapeHtml(fmt)}"
                      data-color-spec="${escapeHtml(clr)}"
                      ${isSelected ? 'checked' : ''} />
                    <span class="su-multi-art-text">
                      <span class="su-multi-art-name">${escapeHtml(codeBadge + p.name)}</span>
                      <span class="su-multi-art-meta">${escapeHtml(fmt)}${clrSummary ? ` &middot; ${escapeHtml(clrSummary)}` : ''}${!draft.buyer && p.customer_name ? ` &middot; ${escapeHtml(p.customer_name)}` : ''}</span>
                    </span>
                  </label>`;
              }).join('')}
            </div>
            `}
          </div>`
            : ''
        }

        ${
          multiMode
            ? `
          <div class="su-suborder-list" data-testid="admin-suborder-list">
            ${articleLines.map((line, idx) => {
              const lineFmt = String(line.sizeFormat || 'LEGACY_7_11').trim() || 'LEGACY_7_11';
              const lineCodes = getScaleSizeCodes(ov.sizeStandards, lineFmt);
              const lineTotal = calculateSizeTotal(line.sizes);
              const lineSplitActive = line.splitRows.length > 0;
              const lineSplitCheck = lineSplitActive
                ? validateContractorAllocations(line.sizes, line.splitRows, lineCodes, { allowPartial: true })
                : null;
              const lineProd = allProducts.find(p => (line.productId ? p.id === line.productId : p.name === line.article));
              const lineColorOptions = parseProductColorOptions(lineProd);
              const lineSplitBarClass = !lineSplitCheck?.valid
                ? 'is-unbalanced'
                : (lineSplitCheck.totalUnassigned === 0 ? 'is-balanced' : 'is-partial');
              const lineSplitStatusText = !lineSplitCheck?.valid
                ? escapeHtml(lineSplitCheck?.error || 'Adjust contractor quantities')
                : (lineSplitCheck.totalUnassigned === 0
                    ? 'Split Matches Sub-order 100% ✓'
                    : `Partial Allocation Ready · ${lineSplitCheck.totalUnassigned.toLocaleString()} Prs Unassigned`);
              return `
              <div class="su-suborder-card" data-line-index="${idx}" data-testid="admin-suborder-card-${idx}">
                <div class="su-suborder-head">
                  <div class="su-suborder-title">
                    <span class="su-suborder-badge">${articleLines.length >= 2 ? `Sub-order -${idx + 1}` : 'Article 1'}</span>
                    <span class="su-suborder-name">${escapeHtml(line.article)}</span>
                    <span class="su-oc-count-pill">${escapeHtml(lineFmt)} &middot; ${lineCodes.length} sizes</span>
                  </div>
                  <div class="su-oc-bar-actions">
                    <button type="button" class="btn-outline su-oc-btn-sm" data-su-action="duplicate-article-colour" data-line-index="${idx}">
                      + Add colour
                    </button>
                    <button type="button" class="btn-outline su-oc-btn-sm admin-line-toggle-split" data-line-index="${idx}">
                      ${lineSplitActive ? 'Use single contractor' : 'Split across contractors'}
                    </button>
                    <button type="button" class="btn-outline su-oc-btn-sm" data-su-action="remove-article-line" data-line-index="${idx}">
                      Remove
                    </button>
                  </div>
                </div>

                <div class="su-suborder-meta">
                  <div class="form-group">
                    <label for="admin-line-maker-${idx}">Contractor / Maker <span class="su-required-mark" aria-hidden="true">*</span></label>
                    <select id="admin-line-maker-${idx}" class="form-select admin-line-maker${lineSplitActive ? ' is-split-disabled' : ''}" data-line-index="${idx}" ${lineSplitActive ? 'disabled title="Contractors assigned in split rows below"' : ''}>
                      <option value="">Choose contractor</option>
                      ${renderMakerSelectOptions(line.maker)}
                    </select>
                  </div>
                  <div class="form-group">
                    <label for="admin-line-color-${idx}">Colour / Shade</label>
                    <input type="text" id="admin-line-color-${idx}" class="form-input admin-line-color" data-line-index="${idx}" placeholder="Colorway" value="${escapeHtml(line.color)}" />
                    ${lineColorOptions.length > 1 ? `
                      <div class="su-color-choice-bar" role="group" aria-label="Article colourways">
                        ${lineColorOptions.map(opt => `
                          <button type="button" class="su-color-choice-btn admin-line-color-choice-btn${line.color.trim().toLowerCase() === opt.toLowerCase() ? ' is-active' : ''}" data-line-index="${idx}" data-line-color-choice="${escapeHtml(opt)}">${escapeHtml(opt)}</button>
                        `).join('')}
                      </div>
                    ` : ''}
                  </div>
                  <div class="form-group">
                    <label for="admin-line-due-date-${idx}">Delivery Due Date</label>
                    <input type="date" id="admin-line-due-date-${idx}" class="form-input admin-line-due-date${lineSplitActive ? ' is-split-disabled' : ''}" data-line-index="${idx}" value="${escapeHtml(line.dueDate)}" ${lineSplitActive ? 'disabled title="Due dates are set per contractor row below."' : ''} />
                  </div>
                  <div class="su-oc-total-readout">
                    <div class="su-oc-total-label">Total pairs</div>
                    <div class="su-oc-total-value" id="admin-line-total-${idx}">${lineTotal.toLocaleString()}</div>
                  </div>
                </div>

                ${renderOrderSizeInputsHtml(
                  lineCodes,
                  lineFmt,
                  line.sizes,
                  'admin-line-size-val',
                  () => `data-line-index="${idx}"`,
                  `Sub-order ${idx + 1} Size`
                )}

                ${
                  lineSplitActive
                    ? `
                  <div class="su-split-panel">
                    <div class="su-split-panel-head">
                      <span class="su-split-panel-title">
                        Contractor share split <span class="su-split-panel-hint">&middot; auto-sums upward from empty top row, or leaves unassigned balance</span>
                      </span>
                      <button type="button" class="btn-outline su-oc-btn-sm admin-line-add-split-row" data-line-index="${idx}">
                        + Add contractor row
                      </button>
                    </div>
                    <div class="table-responsive su-split-table-wrap">
                      <table class="su-split-table">
                        <thead>
                          <tr>
                            <th class="su-split-th-maker">Contractor</th>
                            ${lineCodes.map(sz => `<th>${escapeHtml(formatSizeColumnLabel(sz, lineFmt))}</th>`).join('')}
                            <th>Total</th>
                            <th>Due date</th>
                            <th></th>
                          </tr>
                        </thead>
                        <tbody>
                          ${line.splitRows.map((sRow, sIdx) => {
                            const sRowTotal = calculateSizeTotal(sRow.sizes);
                            return `
                            <tr>
                              <td class="su-split-td-maker">
                                <select class="form-select admin-line-split-maker" data-line-index="${idx}" data-split-index="${sIdx}">
                                  <option value="">Choose</option>
                                  ${renderMakerSelectOptions(sRow.maker)}
                                </select>
                              </td>
                              ${lineCodes
                                .map(sz => {
                                  const sv = Number(sRow.sizes?.[sz] || 0);
                                  return `<td><input type="number" class="form-input su-oc-split-input admin-line-split-size-val${sv > 0 ? ' is-filled' : ''}" data-line-index="${idx}" data-split-index="${sIdx}" data-size="${escapeHtml(sz)}" min="0" placeholder="0" value="${sv > 0 ? sv : ''}" /></td>`;
                                })
                                .join('')}
                              <td class="su-split-row-total" id="admin-line-split-total-${idx}-${sIdx}">${sRowTotal.toLocaleString()}</td>
                              <td><input type="date" class="form-input su-split-date-input admin-line-split-due-date" data-line-index="${idx}" data-split-index="${sIdx}" value="${escapeHtml(sRow.dueDate || '')}" /></td>
                              <td class="text-center">
                                ${line.splitRows.length > 1
                                  ? `<button type="button" class="su-split-rm-btn admin-line-remove-split-row" data-line-index="${idx}" data-split-index="${sIdx}" aria-label="Remove contractor row">&times;</button>`
                                  : '<span class="su-split-min-label">Min 1</span>'}
                              </td>
                            </tr>`;
                          }).join('')}
                        </tbody>
                      </table>
                    </div>
                    <div id="admin-line-split-balance-${idx}" class="su-split-balance-bar ${lineSplitBarClass}">
                      <span>
                        Unassigned Balance:
                        ${lineCodes.map(sz => `<strong>${escapeHtml(sz)}:${lineSplitCheck?.unassignedBySize[sz] ?? 0}</strong>`).join(' | ')}
                        (<strong>${lineSplitCheck?.totalUnassigned ?? 0}</strong> Prs remaining)
                      </span>
                      <strong>${lineSplitStatusText}</strong>
                    </div>
                  </div>`
                    : ''
                }
              </div>`;
            }).join('')}
          </div>`
            : `
        <div class="su-oc-size-box">
          <div class="su-oc-size-box-head su-order-matrix-header">
            <div class="su-oc-size-box-title-wrap">
              <h3 class="su-oc-size-box-title">
                Size breakdown <span class="su-oc-size-box-count">&middot; ${activeSizeCodes.length} sizes</span>
              </h3>
              ${splitActive ? `<p id="admin-split-mode-note" class="su-split-mode-note">${
                splitTargetMode === 'auto'
                  ? 'Auto-summed from split rows (or enter top PO sizes to leave an Unassigned pool)'
                  : ((splitValidation?.totalUnassigned || 0) > 0
                      ? `Buyer PO target &middot; ${(splitValidation?.totalUnassigned || 0).toLocaleString()} Prs Unassigned`
                      : 'Buyer PO target &middot; 100% assigned')
              }</p>` : '<p class="su-split-mode-note">Enter pairs per size.</p>'}
            </div>
            <div class="su-oc-size-box-controls">
              ${availableStandards.length > 0 ? `
                <label for="admin-order-size-format" class="sr-only">Size scale</label>
                <select id="admin-order-size-format" class="form-select su-oc-scale-select">
                  ${availableStandards.map((s: any) => `<option value="${escapeHtml(s.code)}" ${activeSizeFormat === s.code ? 'selected' : ''}>${escapeHtml(s.rawLabel || s.code)}</option>`).join('')}
                </select>
              ` : ''}
              <button type="button" class="btn-outline su-oc-btn-sm" id="btn-admin-toggle-split">
                ${splitActive ? 'Use single contractor' : 'Split across contractors'}
              </button>
              <div class="su-oc-total-readout">
                <div class="su-oc-total-label">Total pairs</div>
                <div id="admin-order-size-total" class="su-oc-total-value">${draftTotal.toLocaleString()}</div>
              </div>
            </div>
          </div>

          ${renderOrderSizeInputsHtml(
            activeSizeCodes,
            activeSizeFormat,
            draft.sizes,
            'admin-order-size-val',
            () => '',
            'Order Size'
          )}

          ${
            splitActive
              ? (() => {
                  const singleBarClass = !splitValidation?.valid
                    ? 'is-unbalanced'
                    : (splitValidation.totalUnassigned === 0 ? 'is-balanced' : 'is-partial');
                  const singleStatusText = !splitValidation?.valid
                    ? escapeHtml(splitValidation?.error || 'Adjust contractor quantities to match order totals')
                    : (splitValidation.totalUnassigned === 0
                        ? 'Split Matches Order 100% ✓'
                        : `Partial Allocation Ready · ${splitValidation.totalUnassigned.toLocaleString()} Prs Unassigned`);
                  return `
            <div class="su-split-panel" data-testid="admin-contractor-split-panel">
              <div class="su-split-panel-head">
                <span class="su-split-panel-title">
                  Contractor share split <span class="su-split-panel-hint">&middot; sums up from an empty top row, or leaves an unassigned balance</span>
                </span>
                <button type="button" class="btn-outline su-oc-btn-sm" id="btn-admin-add-split-row">
                  + Add contractor row
                </button>
              </div>
              <div class="table-responsive su-split-table-wrap">
                <table class="su-split-table">
                  <thead>
                    <tr>
                      <th class="su-split-th-maker">Contractor</th>
                      ${activeSizeCodes.map(sz => `<th>${escapeHtml(formatSizeColumnLabel(sz, activeSizeFormat))}</th>`).join('')}
                      <th>Total</th>
                      <th>Due date</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    ${splitRows.map((row, idx) => {
                      const rowTotal = calculateSizeTotal(row.sizes);
                      return `
                      <tr class="su-split-row" data-split-index="${idx}">
                        <td class="su-split-td-maker">
                          <select class="form-select admin-split-maker" data-split-index="${idx}" aria-label="Split Contractor ${idx + 1}">
                            <option value="">Choose</option>
                            ${renderMakerSelectOptions(row.maker)}
                          </select>
                        </td>
                        ${activeSizeCodes
                          .map(sz => {
                            const sv = Number(row.sizes?.[sz] || 0);
                            return `<td><input type="number" class="form-input su-oc-split-input admin-split-size-val${sv > 0 ? ' is-filled' : ''}" data-split-index="${idx}" data-size="${escapeHtml(sz)}" min="0" placeholder="0" aria-label="Contractor ${idx + 1} Size ${escapeHtml(sz)}" value="${sv > 0 ? sv : ''}" /></td>`;
                          })
                          .join('')}
                        <td class="su-split-row-total" id="admin-split-row-total-${idx}">${rowTotal.toLocaleString()}</td>
                        <td><input type="date" class="form-input su-split-date-input admin-split-due-date" data-split-index="${idx}" aria-label="Contractor ${idx + 1} Due Date" value="${escapeHtml(row.dueDate || '')}" /></td>
                        <td class="text-center">
                          ${splitRows.length > 1
                            ? `<button type="button" class="su-split-rm-btn" data-su-action="remove-split-row" data-split-index="${idx}" aria-label="Remove contractor row ${idx + 1}">&times;</button>`
                            : '<span class="su-split-min-label">Min 1</span>'}
                        </td>
                      </tr>`;
                    }).join('')}
                  </tbody>
                </table>
              </div>
              <div id="admin-split-balance-bar" class="su-split-balance-bar ${singleBarClass}">
                <span>
                  Unassigned Balance:
                  ${activeSizeCodes.map(sz => `<strong>${escapeHtml(sz)}:${splitValidation?.unassignedBySize[sz] ?? 0}</strong>`).join(' | ')}
                  (<strong>${splitValidation?.totalUnassigned ?? 0}</strong> Prs remaining)
                </span>
                <strong>${singleStatusText}</strong>
              </div>
            </div>
          `;
                })()
              : ''
          }
        </div>`
        }

        <div class="su-order-action-row">
          <span class="su-oc-required-note">
            <span class="su-required-mark" aria-hidden="true">*</span> Required. Saved orders appear in Inward Receiving and Packing Hall.
          </span>
          <div class="su-oc-bar-actions">
            ${multiMode ? `<span id="admin-multi-total-summary" class="su-multi-total-pill">${articleLines.length} ${articleLines.length === 1 ? 'Article' : 'Sub-orders'} &middot; ${multiGrandTotal.toLocaleString()} Pairs</span>` : ''}
            <button type="button" class="btn-outline" id="btn-admin-reset-pending-order">
              Reset form
            </button>
            <button type="button" class="btn-primary" id="btn-admin-add-pending-order">
              ${articleLines.length >= 2 ? `Save &amp; issue ${articleLines.length} sub-orders` : 'Save &amp; issue order'}
            </button>
          </div>
        </div>
      </section>

      <!-- Card 2: Full-Height Saved Orders Table Card -->
      <section class="su-oc-card su-oc-orders-card" data-testid="su-saved-orders-card">
        <div class="table-responsive">
          <table class="data-table su-oc-orders-table">
            <thead>
              <tr>
                <th>Order</th>
                <th>Buyer</th>
                <th>Maker</th>
                <th>PO</th>
                <th>Article</th>
                <th>Sizes</th>
                <th class="text-right">Planned</th>
                <th>Delivery</th>
                <th>GRN / REQ</th>
                <th class="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              ${
                ctx.pendingOrders.length === 0
                  ? `
                <tr><td colspan="10" class="table-empty-cell">No orders in database yet. Fill out the form above and click &ldquo;Save &amp; issue order&rdquo;.</td></tr>
              `
                  : ctx.pendingOrders
                      .map(o => {
                        const rollup = ctx.rollupSummary.orderRollups.find(
                          r => r.orderId === o.orderId
                        );
                        const rowCountdown = rollup?.deliveryCountdown || computeDeliveryCountdown({
                          dueDate: o.dueDate,
                          createdAt: o.createdAt,
                          isCompleted: o.shortClosed
                        });
                        const rowUnassigned = Math.max(0, Number(o.unassignedQty || 0));
                        const rowPlanned = Number(o.totalQty || calculateSizeTotal(o.sizes || {}) || 0);
                        const orderedKeys = o.sizeCodes && o.sizeCodes.length > 0 ? o.sizeCodes : Object.keys(o.sizes || {});
                        const nonZeroSizes = orderedKeys
                          .map(sz => ({ sz, qty: Number(o.sizes?.[sz] || 0) }))
                          .filter(item => item.qty > 0);
                        const chipsExpanded = Boolean(expandedChipsMap[o.orderId]);
                        const visibleSizes = chipsExpanded ? nonZeroSizes : nonZeroSizes.slice(0, 3);
                        const rcvdPairsForRow = Number(rollup?.receivedGrnQty || 0);
                        const grnPct = rowPlanned > 0 ? Math.min(100, Math.round((rcvdPairsForRow / rowPlanned) * 100)) : 0;
                        const grnCount = rollup ? rollup.grnBatches.length : 0;
                        const reqCount = rollup ? rollup.reqBatches.length : 0;
                        const scaleBadge = formatShortScaleBadge(o.sizeFormat || 'LEGACY_7_11');

                        return `
                  <tr>
                    <td class="su-oc-order-ref">${escapeHtml(o.orderId)}</td>
                    <td>${escapeHtml(o.buyer || '---')}</td>
                    <td>
                      <div>${escapeHtml(o.maker)}</div>
                      ${rowUnassigned > 0 ? `<div class="su-unassigned-chip">${rowUnassigned.toLocaleString()} unassigned</div>` : ''}
                    </td>
                    <td class="su-oc-po-cell">${escapeHtml(o.po || '---')}</td>
                    <td>
                      <div class="su-oc-art-name">${escapeHtml(o.article)}</div>
                      <div class="su-oc-art-color">${escapeHtml(o.color || 'Standard')}</div>
                    </td>
                    <td>
                      <div class="su-oc-size-chips-wrap">
                        <span class="su-oc-scale-badge">${escapeHtml(scaleBadge)}</span>
                        ${
                          visibleSizes.length === 0
                            ? '<span class="su-oc-empty-dash">0</span>'
                            : visibleSizes.map(item => `<span class="su-oc-size-chip">${escapeHtml(item.sz)} ${item.qty.toLocaleString()}</span>`).join('')
                        }
                        ${
                          nonZeroSizes.length > 3
                            ? `<button type="button" class="su-oc-size-more-btn" data-su-action="toggle-order-size-chips" data-order-id="${escapeHtml(o.orderId)}">${chipsExpanded ? 'Show less' : `+${nonZeroSizes.length - 3} more`}</button>`
                            : ''
                        }
                      </div>
                    </td>
                    <td class="text-right su-oc-planned-cell">${rowPlanned.toLocaleString()}</td>
                    <td>
                      <div class="su-oc-delivery-stack">
                        ${renderDeliveryCountdownChip(rowCountdown, false)}
                        ${o.dueDate ? `<div class="su-oc-delivery-date">${escapeHtml(o.dueDate)}</div>` : ''}
                      </div>
                    </td>
                    <td class="su-oc-progress-cell">
                      <div class="su-oc-mini-bar" aria-hidden="true">
                        <div class="su-oc-mini-bar-fill" style="width: ${grnPct}%;"></div>
                      </div>
                      <div class="su-oc-progress-meta">${grnCount} GRN &middot; ${reqCount} REQ</div>
                    </td>
                    <td class="text-right su-oc-actions-cell">
                      <div class="su-oc-row-actions">
                        ${rowUnassigned > 0 ? `<button type="button" class="table-btn su-oc-btn-sm" data-su-action="assign-remaining-order" data-order-id="${escapeHtml(o.orderId)}">Assign remaining</button>` : ''}
                        <button type="button" class="table-btn su-oc-btn-sm" data-su-action="inspect-order" data-order-id="${escapeHtml(o.orderId)}">Track</button>
                        <button type="button" class="su-oc-text-btn" data-su-action="edit-pending-order" data-order-id="${escapeHtml(o.orderId)}">Edit</button>
                        <button type="button" class="su-oc-icon-delete" title="Delete ${escapeHtml(o.orderId)}" aria-label="Delete ${escapeHtml(o.orderId)}" data-su-action="remove-pending-order" data-order-id="${escapeHtml(o.orderId)}">
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                `;
                      })
                      .join('')
              }
            </tbody>
          </table>
        </div>
      </section>

      <!-- Card 3: Horizontal Tabbed Master Registries -->
      <section class="su-oc-card su-reg-card" data-testid="su-master-registries-card">
        <div class="su-reg-card-head">
          <h2 class="su-oc-card-title">Master registries</h2>
        </div>

        <div class="su-reg-tabs" role="tablist" aria-label="Master registries">
          ${[
            { key: 'buyers', label: 'Buyers', count: ov.customers.length },
            { key: 'articles', label: 'Articles', count: ov.products.length },
            { key: 'carton_packing', label: 'Cartons', count: ov.products.length },
            { key: 'makers_pos', label: 'Makers & halls', count: externalMakersList.length + hallsList.length },
            { key: 'audit_trail', label: 'Audit trail', count: auditTrail.length },
            { key: 'sqlite_wal', label: 'Database', count: ov.dbHealth.totalTables },
            { key: 'phased_rollout', label: 'Rollout', count: PHASED_ROLLOUT_RECORD.length }
          ].map(t => {
            const isSel = activeRegTab === t.key;
            return `
              <button
                type="button"
                role="tab"
                class="su-reg-tab${isSel ? ' is-active' : ''}"
                data-registry-tab="${t.key}"
                aria-selected="${isSel ? 'true' : 'false'}"
              >
                <span>${t.label}</span>
                <span class="su-reg-tab-count">${t.count}</span>
              </button>`;
          }).join('')}
        </div>

        <div class="su-reg-panels">
          <!-- Tab 1: Customer & Buyer Master -->
          <div role="tabpanel" class="su-reg-panel" data-registry-id="buyers" ${activeRegTab !== 'buyers' ? 'hidden' : ''}>
            <p class="su-reg-panel-note">AQL inspection rules and destination country per buyer.</p>
            <div class="su-customer-form-grid">
              <div class="form-group">
                <label for="admin-cust-name">Customer Name</label>
                <input type="text" id="admin-cust-name" class="form-input" placeholder="e.g. Alpine Tactical" />
              </div>
              <div class="form-group">
                <label for="admin-cust-country">Destination Country</label>
                <input type="text" id="admin-cust-country" class="form-input" placeholder="e.g. Germany" value="United Kingdom" />
              </div>
              <div class="form-group">
                <label for="admin-cust-pref">QC Inspection Protocol</label>
                <select id="admin-cust-pref" class="form-select">
                  <option value="RANDOM">RANDOM (AQL 1.5)</option>
                  <option value="THOROUGH">THOROUGH (100%)</option>
                </select>
              </div>
              <button type="button" class="btn-primary" id="btn-admin-save-customer">Save Buyer</button>
            </div>
            <div class="table-responsive su-reg-table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>Customer ID</th><th>Customer Name</th><th>Country</th><th class="text-center">QC Protocol</th></tr>
                </thead>
                <tbody>
                  ${ov.customers
                    .map(
                      (c: any) => `
                    <tr>
                      <td class="font-bold">${escapeHtml(c.id)}</td>
                      <td>${escapeHtml(c.name)}</td>
                      <td>${escapeHtml(c.country || '---')}</td>
                      <td class="text-center"><span class="status-pill">${escapeHtml(c.inspection_preference)}</span></td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Tab 2: Glove Article & Colourway Master -->
          <div role="tabpanel" class="su-reg-panel" data-registry-id="articles" ${activeRegTab !== 'articles' ? 'hidden' : ''}>
            <p class="su-reg-panel-note">Buyer-linked articles, size scales, and multi-colour options.</p>
            ${(() => {
              const activeArticleBuyerId = String(ctx.articleDraftCustomerId || draft.customerId || '').trim();
              const colorDraftOptions = ctx.articleColorDraftOptions || [];
              const selectedPresets = ctx.articleColorSelectedPresets || [];
              return `
            <div class="su-article-form-grid">
              <div class="form-group">
                <label for="admin-prod-name">Article Name</label>
                <input type="text" id="admin-prod-name" class="form-input" placeholder="e.g. Stealth Pro V2" />
              </div>
              <div class="form-group">
                <label for="admin-prod-cust">Buyer</label>
                <select id="admin-prod-cust" class="form-select">
                  ${ov.customers
                    .map((c: any, idx: number) => {
                      const isSel = activeArticleBuyerId ? c.id === activeArticleBuyerId : idx === 0;
                      return `<option value="${escapeHtml(c.id)}" ${isSel ? 'selected' : ''}>${escapeHtml(c.name)}</option>`;
                    })
                    .join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="admin-prod-size-format">Size Scale</label>
                <select id="admin-prod-size-format" class="form-select">
                  ${availableStandards.length > 0
                    ? availableStandards.map((s: any) => `<option value="${escapeHtml(s.code)}" ${s.code === 'ALPHA_2XS_5XL' ? 'selected' : ''}>${escapeHtml(s.rawLabel || s.code)}</option>`).join('')
                    : '<option value="ALPHA_2XS_5XL">2XS - 5XL (Alpha)</option><option value="NUMERIC_6_12">6 - 12 (Numeric)</option>'}
                </select>
              </div>
              <button type="button" class="btn-primary" id="btn-admin-save-product">Save Article</button>
            </div>
            <div class="su-color-builder" data-testid="admin-prod-color-builder">
              <div class="su-color-builder-head">
                <strong>Colourways &amp; Multi-Colour Combinations</strong>
                <span class="admin-meta-caption">Tick colours to combine (e.g. Black / Brown / Tan) or type a custom shade, then click &ldquo;+ Add colourway&rdquo;.</span>
              </div>
              <div class="su-color-preset-list">
                ${PRESET_GLOVE_COLORS.map(clr => `
                  <label class="su-color-preset-pill">
                    <input type="checkbox" class="su-color-preset-check" value="${escapeHtml(clr)}" ${selectedPresets.some(p => p.toLowerCase() === clr.toLowerCase()) ? 'checked' : ''} />
                    <span>${escapeHtml(clr)}</span>
                  </label>
                `).join('')}
              </div>
              <div class="su-color-add-row">
                <label for="admin-prod-color-input" class="sr-only">Article Colourway</label>
                <input type="text" id="admin-prod-color-input" class="form-input" placeholder="e.g. Black / Brown / Tan — or tick colours above" value="${escapeHtml(selectedPresets.join(' / '))}" />
                <button type="button" class="btn-outline" id="btn-admin-add-prod-color">+ Add colourway</button>
              </div>
              <div id="admin-prod-color-chips" class="su-color-chip-list" data-testid="admin-prod-color-chips">
                ${colorDraftOptions.length === 0
                  ? '<span class="admin-meta-caption">No colourways added yet (add 1 fixed combination or multiple selectable options).</span>'
                  : colorDraftOptions.map((clr, idx) => `
                    <span class="su-color-chip">
                      <span>${escapeHtml(clr)}</span>
                      <button type="button" class="su-color-chip-remove" data-remove-prod-color="${idx}" aria-label="Remove colourway ${escapeHtml(clr)}">&times;</button>
                    </span>
                  `).join('')}
              </div>
            </div>`;
            })()}
            <div class="table-responsive su-reg-table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>Product ID</th><th>Article</th><th>Buyer</th><th>Colourways</th><th>Size Scale</th></tr>
                </thead>
                <tbody>
                  ${(() => {
                    const filteredProducts = draft.customerId || draft.buyer
                      ? filterProductsByBuyer(ov.products, allCustomers, draft.customerId || draft.buyer)
                      : ov.products;
                    const MAX_ARTICLE_ROWS = 80;
                    const visibleProducts = filteredProducts.slice(0, MAX_ARTICLE_ROWS);
                    if (visibleProducts.length === 0) {
                      return `<tr><td colspan="5" class="table-empty-cell">No articles${draft.buyer ? ` for ${escapeHtml(draft.buyer)}` : ''} yet.</td></tr>`;
                    }
                    const rowsHtml = visibleProducts
                      .map((p: any) => {
                        const prodColors = parseProductColorOptions(p);
                        return `
                    <tr>
                      <td class="font-bold">${escapeHtml(p.id)}</td>
                      <td class="font-bold">${escapeHtml(p.name)}</td>
                      <td>${escapeHtml(p.customer_name || p.customer_id)}</td>
                      <td>${prodColors.length ? prodColors.map(c => `<span class="status-pill">${escapeHtml(c)}</span>`).join(' ') : '<span class="su-oc-empty-dash">---</span>'}</td>
                      <td><span class="status-pill">${escapeHtml(p.size_format || 'ALPHA_2XS_5XL')}</span></td>
                    </tr>
                  `;
                      })
                      .join('');
                    const moreNotice = filteredProducts.length > MAX_ARTICLE_ROWS
                      ? `<tr><td colspan="5" class="text-center su-reg-more-note">Showing first ${MAX_ARTICLE_ROWS} of ${filteredProducts.length} catalog articles${draft.buyer ? ` for ${escapeHtml(draft.buyer)}` : ' — select a Buyer in Order creation to filter its full SKU list'}.</td></tr>`
                      : '';
                    return rowsHtml + moreNotice;
                  })()}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Tab 3: Carton & Packaging BOM -->
          <div role="tabpanel" class="su-reg-panel" data-registry-id="carton_packing" ${activeRegTab !== 'carton_packing' ? 'hidden' : ''}>
            <p class="su-reg-panel-note">Pairs per carton and per-pair accessories (box dimensions on hold).</p>
            ${(() => {
              const cartonCatalog = draft.buyer ? filteredCatalog : allProducts;
              const firstCartonProd = cartonCatalog[0];
              const MAX_CARTON_ROWS = 80;
              const visibleCartonRows = cartonCatalog.slice(0, MAX_CARTON_ROWS);
              return `
            <div class="su-carton-form-grid">
              <div class="form-group">
                <label for="admin-carton-product">Article</label>
                <select id="admin-carton-product" class="form-select">
                  ${cartonCatalog.length === 0
                    ? `<option value="">No articles ${draft.buyer ? `for ${escapeHtml(draft.buyer)} ` : ''}available</option>`
                    : cartonCatalog
                        .map((p: any) => `<option value="${escapeHtml(p.id)}" data-pairs-per-carton="${Number(p.pairs_per_carton || 50)}" data-stickers-per-pair="${Number(p.stickers_per_pair || 2)}">${escapeHtml(p.name)} (${escapeHtml(p.customer_name || p.customer_id)})</option>`)
                        .join('')}
                </select>
              </div>
              <div class="form-group">
                <label for="admin-carton-stickers">Stickers / Pr</label>
                <input type="number" id="admin-carton-stickers" class="form-input" min="1" value="${Number(firstCartonProd?.stickers_per_pair || 2)}" />
              </div>
              <div class="form-group">
                <label for="admin-carton-pairs">Pairs / Carton</label>
                <input type="number" id="admin-carton-pairs" class="form-input" min="1" value="${Number(firstCartonProd?.pairs_per_carton || 50)}" />
              </div>
              <button type="button" class="btn-primary" id="btn-admin-save-carton-spec" ${cartonCatalog.length === 0 ? 'disabled' : ''}>Update Packaging</button>
            </div>
            <div class="table-responsive su-reg-table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>Product ID</th><th>Article</th><th>Buyer</th><th>Size Scale</th><th class="text-right">Polybag</th><th class="text-right">Silica</th><th class="text-right">Stickers</th><th class="text-right">Pairs / Carton</th></tr>
                </thead>
                <tbody>
                  ${visibleCartonRows.length === 0
                    ? `<tr><td colspan="8" class="table-empty-cell">No articles${draft.buyer ? ` for ${escapeHtml(draft.buyer)}` : ''} yet.</td></tr>`
                    : visibleCartonRows
                        .map(
                          (p: any) => `
                    <tr>
                      <td class="font-bold">${escapeHtml(p.id)}</td>
                      <td class="font-bold">${escapeHtml(p.name)}</td>
                      <td>${escapeHtml(p.customer_name || p.customer_id)}</td>
                      <td><span class="status-pill">${escapeHtml(p.size_format || 'ALPHA_2XS_5XL')}</span></td>
                      <td class="text-right">${Number(p.polybag_per_pair ?? 1)}</td>
                      <td class="text-right">${Number(p.silica_gel_per_pair ?? 1)}</td>
                      <td class="text-right">${Number(p.stickers_per_pair ?? 2)}</td>
                      <td class="text-right font-bold" data-carton-pairs-for="${escapeHtml(p.id)}">${Number(p.pairs_per_carton || 50)}</td>
                    </tr>
                  `
                        )
                        .join('')}
                </tbody>
              </table>
            </div>`;
            })()}
          </div>

          <!-- Tab 4: External Contractors / Makers & Internal Halls -->
          <div role="tabpanel" class="su-reg-panel" data-registry-id="makers_pos" ${activeRegTab !== 'makers_pos' ? 'hidden' : ''}>
            <p class="su-reg-panel-note">Synchronized across Order Creation and Inward Dock receiving.</p>
            <div class="su-reg-makers-block">
              <div class="su-reg-subhead">External Contractors / Makers (${externalMakersList.length})</div>
              <div class="su-reg-inline-add">
                <input type="text" id="admin-add-maker-input" class="form-input" placeholder="Add External Contractor / Maker (e.g. Usman Stitching)" />
                <button type="button" class="btn-primary" id="btn-admin-add-maker">Add Maker</button>
              </div>
              <div class="su-reg-tags-wrap" data-testid="su-external-makers-tags">
                ${externalMakersList.length === 0
                  ? '<span class="admin-meta-caption">No external contractors registered yet. Add one above or assign to Internal Halls below.</span>'
                  : externalMakersList
                      .map(
                        m => `
                      <span class="admin-tag-item" data-maker-id="${m.id}" data-maker-name="${escapeHtml(m.name)}">
                        <span>${escapeHtml(m.name)}</span>
                        <button
                          type="button"
                          class="admin-tag-remove"
                          title="Remove ${escapeHtml(m.name)}"
                          aria-label="Remove contractor ${escapeHtml(m.name)}"
                          data-su-action="delete-maker"
                          data-maker-id="${m.id}"
                          data-maker-name="${escapeHtml(m.name)}"
                        >&times;</button>
                      </span>
                    `
                      )
                      .join('')}
              </div>
            </div>
            ${(() => {
              const halls = hallsList;
              return `
            <div class="su-halls-section" data-testid="su-halls-registry">
              <div class="su-halls-head">
                <span class="su-halls-title">Halls &amp; Assigned Stitchers (${halls.length})</span>
                <span class="su-halls-sub">Chain-linked to Inward Dock #1 receiving &amp; Alteration Bay tailors</span>
              </div>
              <div class="su-hall-add-row">
                <input type="text" id="admin-add-hall-input" class="form-input" placeholder="Add Hall name (e.g. Hall C (Export))" aria-label="Add Hall name" />
                <button type="button" class="btn-primary" id="btn-admin-add-hall">Add Hall</button>
              </div>
              <div class="su-hall-grid">
                ${
                  halls.length === 0
                    ? `<div class="su-hall-empty">No halls configured yet. Add a Hall above and assign its Stitchers.</div>`
                    : halls
                        .map(
                          h => `
                  <div class="su-hall-card" data-hall-id="${h.id}" data-hall-name="${escapeHtml(h.name)}">
                    <div class="su-hall-card-head">
                      <div class="su-hall-card-title">
                        <span class="su-hall-card-name">${escapeHtml(h.name)}</span>
                        <span class="su-hall-card-count">${h.stitchers.length} stitcher${h.stitchers.length === 1 ? '' : 's'}</span>
                      </div>
                      <button
                        type="button"
                        class="btn-outline btn-xs su-hall-delete-btn"
                        data-su-action="delete-hall"
                        data-hall-id="${h.id}"
                        data-hall-name="${escapeHtml(h.name)}"
                        data-stitcher-count="${h.stitchers.length}"
                        title="Remove ${escapeHtml(h.name)}"
                        aria-label="Remove hall ${escapeHtml(h.name)}"
                      >Remove</button>
                    </div>
                    <div class="su-hall-tags">
                      ${
                        h.stitchers.length === 0
                          ? `<span class="su-hall-empty">No stitchers assigned yet.</span>`
                          : h.stitchers
                              .map(
                                s => `
                        <span class="admin-tag-item" data-stitcher-id="${s.id}">
                          <span>${escapeHtml(s.name)}</span>
                          <button
                            type="button"
                            class="admin-tag-remove"
                            title="Remove ${escapeHtml(s.name)}"
                            aria-label="Remove stitcher ${escapeHtml(s.name)} from ${escapeHtml(h.name)}"
                            data-su-action="delete-stitcher"
                            data-stitcher-id="${s.id}"
                            data-stitcher-name="${escapeHtml(s.name)}"
                            data-hall-name="${escapeHtml(h.name)}"
                          >&times;</button>
                        </span>
                      `
                              )
                              .join('')
                      }
                    </div>
                    <div class="su-hall-stitcher-add">
                      <input
                        type="text"
                        class="form-input"
                        data-hall-stitcher-input="${h.id}"
                        placeholder="Add stitcher to ${escapeHtml(h.name)}"
                        aria-label="Add stitcher to ${escapeHtml(h.name)}"
                      />
                      <button
                        type="button"
                        class="btn-outline btn-xs"
                        data-su-action="add-stitcher"
                        data-hall-id="${h.id}"
                      >Add Stitcher</button>
                    </div>
                  </div>
                `
                        )
                        .join('')
                }
              </div>
            </div>`;
            })()}
          </div>

          <!-- Tab 5: Immutable Audit Trail -->
          <div role="tabpanel" class="su-reg-panel" data-registry-id="audit_trail" ${activeRegTab !== 'audit_trail' ? 'hidden' : ''}>
            <p class="su-reg-panel-note">Actor, timestamp, and before &rarr; after summary for every recorded event.</p>
            <div class="table-responsive su-reg-table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>Audit ID</th><th>Timestamp</th><th>Actor / Role</th><th>Action</th><th>Entity</th><th>Before &rarr; After</th></tr>
                </thead>
                <tbody>
                  ${
                    auditTrail.length === 0
                      ? `<tr><td colspan="6" class="text-center su-reg-empty-cell">Audit trail records every Order creation, GRN receipt, Dock issue, QC gate approval, and Void operation.</td></tr>`
                      : auditTrail
                          .slice()
                          .reverse()
                          .map(
                            a => `
                    <tr>
                      <td class="font-bold su-reg-mono">${escapeHtml(a.auditId)}</td>
                      <td class="su-reg-mono su-reg-small">${escapeHtml(a.timestamp)}</td>
                      <td><strong>${escapeHtml(a.actor)}</strong> <span class="su-reg-muted">(${escapeHtml(a.role)})</span></td>
                      <td><span class="su-badge su-badge-req">${escapeHtml(a.action)}</span></td>
                      <td class="font-bold">${escapeHtml(a.entityId)}</td>
                      <td class="su-reg-small">${escapeHtml(a.beforeSummary)} &rarr; <strong>${escapeHtml(a.afterSummary)}</strong></td>
                    </tr>
                  `
                          )
                          .join('')
                  }
                </tbody>
              </table>
            </div>
          </div>

          <!-- Tab 6: SQLite WAL Database & Snapshot Administration -->
          <div role="tabpanel" class="su-reg-panel" data-registry-id="sqlite_wal" ${activeRegTab !== 'sqlite_wal' ? 'hidden' : ''}>
            <p class="su-reg-panel-note">SQLite ${escapeHtml(String(ov.dbHealth.journalMode).toUpperCase())} &middot; ${ov.dbHealth.totalTables} tables &middot; ${totalRows.toLocaleString()} rows.</p>
            <div class="su-reg-db-actions">
              <button type="button" class="btn-primary su-oc-btn-sm" id="btn-admin-trigger-backup">
                Execute Online VACUUM Backup
              </button>
              <button type="button" class="btn-outline su-oc-btn-sm" id="btn-admin-reseed-db">
                Verify &amp; Re-Seed Master Data
              </button>
              <button type="button" class="btn-outline su-oc-btn-sm" id="btn-admin-export-json">
                Export State (JSON)
              </button>
            </div>
            ${
              ctx.lastBackupPath
                ? `
              <div class="su-reg-backup-banner">
                <strong>Latest Snapshot:</strong> <code>${escapeHtml(ctx.lastBackupPath)}</code>
              </div>
            `
                : ''
            }
            <div class="table-responsive su-reg-table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>SQLite Table</th><th class="text-right">Row Count</th><th class="text-center">Integrity</th></tr>
                </thead>
                <tbody>
                  ${Object.keys(counts)
                    .map(
                      tbl => `
                    <tr>
                      <td class="su-reg-mono su-reg-small font-bold">${escapeHtml(tbl)}</td>
                      <td class="text-right font-bold">${counts[tbl]}</td>
                      <td class="text-center"><span class="status-pill">OK</span></td>
                    </tr>
                  `
                    )
                    .join('')}
                </tbody>
              </table>
            </div>
          </div>

          <!-- Tab 7: Phased Rollout Record & Active MES Policy -->
          <div role="tabpanel" class="su-reg-panel" data-registry-id="phased_rollout" ${activeRegTab !== 'phased_rollout' ? 'hidden' : ''}>
            <p class="su-reg-panel-note">Phases A to C milestones and active MES policy defaults.</p>
            <div class="table-responsive su-reg-table-wrap">
              <table class="data-table">
                <thead>
                  <tr><th>Phase</th><th>Milestone Title</th><th>Scope &amp; Deliverables</th><th class="text-center">Status</th></tr>
                </thead>
                <tbody>
                  ${PHASED_ROLLOUT_RECORD.map(
                    p => `
                    <tr>
                      <td class="font-bold su-reg-mono">${p.phase}</td>
                      <td class="font-bold">${p.title}</td>
                      <td class="su-reg-small">${p.scope.join(' &bull; ')}</td>
                      <td class="text-center"><span class="su-badge su-badge-reconciled">${p.status} &#10003;</span></td>
                    </tr>
                  `
                  ).join('')}
                </tbody>
              </table>
            </div>
            <div class="su-reg-policy-footer">
              Active Policy Defaults: SizeSet=<strong>${DEFAULT_MES_POLICY_CONFIG.sizeScaleMode}</strong> &bull;
              OverReceiptTol=<strong>+${DEFAULT_MES_POLICY_CONFIG.overReceiptTolerancePct}%</strong> &bull;
              AQL=<strong>${DEFAULT_MES_POLICY_CONFIG.aqlInspectorRole} / ${DEFAULT_MES_POLICY_CONFIG.aqlInspectionGranularity} / ${DEFAULT_MES_POLICY_CONFIG.aqlFailurePath}</strong> &bull;
              AlterationMode=<strong>${DEFAULT_MES_POLICY_CONFIG.alterationWorkflowMode}</strong>
            </div>
          </div>
        </div>
      </section>

      <!-- Card 4: Non-Fixed Bottom Totals Summary Strip -->
      <section class="su-oc-card su-oc-totals-strip" data-testid="su-oc-totals-strip">
        <div class="su-oc-totals-metrics">
          <div><span class="su-oc-totals-label">Orders</span> <strong class="su-oc-totals-num">${ctx.pendingOrders.length.toLocaleString()}</strong></div>
          <div><span class="su-oc-totals-label">Planned</span> <strong class="su-oc-totals-num">${totalPlannedOrders.toLocaleString()}</strong></div>
          <div><span class="su-oc-totals-label">Received</span> <strong class="su-oc-totals-num is-received">${totalReceivedOrders.toLocaleString()}</strong></div>
          <div><span class="su-oc-totals-label">Issued</span> <strong class="su-oc-totals-num is-issued">${totalIssuedOrders.toLocaleString()}</strong></div>
          <div><span class="su-oc-totals-label">Packed</span> <strong class="su-oc-totals-num is-packed">${totalPackedOrders.toLocaleString()}</strong></div>
        </div>
        <div class="su-oc-totals-bar" aria-hidden="true">
          <div class="su-oc-totals-bar-packed" style="width: ${packedBarPct}%;"></div>
          <div class="su-oc-totals-bar-issued" style="width: ${issuedBarPct}%;"></div>
        </div>
      </section>
    </div>
  `;
}
