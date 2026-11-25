import {
  escapeHtml,
  normalizeColorOptionList,
  validateCartonPackingInputs,
  validateCustomerMasterInputs,
  validateProductMasterInputs
} from '../../utils/requisitionLogic';
import { applyFieldValidationErrors, clearFieldValidationError, runAdminAction, showToast } from '../../utils/domModalsAndPrint';
import { renderApp } from '../../appContext';
import { state } from '../../state/appState';
import { syncBackendData } from '../../state/syncService';

/** Attach Master Registry tab switching and Buyer/Product/Maker/Hall/PO CRUD handlers. */
export function attachAdminMasterRegistryHandlers(): void {
  const registryTabs = Array.from(document.querySelectorAll<HTMLButtonElement>('.su-reg-tab[data-registry-tab]'));
  const registryPanels = Array.from(document.querySelectorAll<HTMLElement>('.su-reg-panel[data-registry-id]'));
  registryTabs.forEach(tabBtn => {
    tabBtn.addEventListener('click', () => {
      const regId = tabBtn.dataset.registryTab as typeof state.adminActiveRegistryTab | undefined;
      if (!regId) return;
      state.adminActiveRegistryTab = regId;
      registryTabs.forEach(btn => {
        const isActive = btn.dataset.registryTab === regId;
        btn.classList.toggle('is-active', isActive);
        btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      registryPanels.forEach(panel => {
        panel.hidden = panel.dataset.registryId !== regId;
      });
    });
  });

  document.getElementById('btn-admin-save-customer')?.addEventListener('click', (e) => {
    const nameEl = document.getElementById('admin-cust-name') as HTMLInputElement | null;
    const name = nameEl?.value?.trim() || '';
    const country = (document.getElementById('admin-cust-country') as HTMLInputElement)?.value?.trim();
    const inspectionPreference = (document.getElementById('admin-cust-pref') as HTMLSelectElement)?.value;

    const errors = validateCustomerMasterInputs({ name });
    if (applyFieldValidationErrors([[nameEl, errors.name]])) {
      showToast('Enter a customer / buyer name.');
      return;
    }

    void runAdminAction('admin:save-customer', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch('/api/admin/master/customer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, country, inspectionPreference })
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          applyFieldValidationErrors([[nameEl, json.error || 'Buyer could not be saved.']]);
          showToast(json.error || 'Buyer could not be saved.');
          return;
        }
        if (!state.dropdownOptions.customers.includes(name)) {
          state.dropdownOptions.customers.push(name);
        }
        if (Array.isArray(json.data)) {
          state.adminOverview.customers = json.data;
        }
        showToast(`Saved "${name}" to SQLite Master.`);
        await syncBackendData();
      } catch (err) {
        console.warn(err);
        showToast('Buyer could not be saved.');
      }
    });
  });

  const syncArticleColorChipsDom = () => {
    const chipsContainer = document.getElementById('admin-prod-color-chips');
    if (!chipsContainer) return;
    const list = state.adminArticleColorDraftOptions || [];
    if (list.length === 0) {
      chipsContainer.innerHTML = '<span class="admin-meta-caption">No colourways added yet (add 1 fixed combination or multiple selectable options).</span>';
      return;
    }
    chipsContainer.innerHTML = list
      .map((clr, idx) => `
        <span class="su-color-chip">
          <span>${escapeHtml(clr)}</span>
          <button type="button" class="su-color-chip-remove" data-remove-prod-color="${idx}" aria-label="Remove colourway ${escapeHtml(clr)}">&times;</button>
        </span>
      `)
      .join('');
    chipsContainer.querySelectorAll<HTMLButtonElement>('[data-remove-prod-color]').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.getAttribute('data-remove-prod-color'));
        if (Number.isInteger(idx) && idx >= 0 && idx < state.adminArticleColorDraftOptions.length) {
          state.adminArticleColorDraftOptions.splice(idx, 1);
          syncArticleColorChipsDom();
        }
      });
    });
  };

  syncArticleColorChipsDom();

  document.getElementById('admin-prod-cust')?.addEventListener('change', (ev) => {
    state.adminArticleDraftCustomerId = (ev.currentTarget as HTMLSelectElement).value || '';
  });

  document.querySelectorAll<HTMLInputElement>('.su-color-preset-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const checked = Array.from(document.querySelectorAll<HTMLInputElement>('.su-color-preset-check:checked')).map(
        el => el.value.trim()
      );
      state.adminArticleColorSelectedPresets = checked;
      const colorInp = document.getElementById('admin-prod-color-input') as HTMLInputElement | null;
      if (colorInp) {
        colorInp.value = checked.join(' / ');
      }
    });
  });

  document.getElementById('btn-admin-add-prod-color')?.addEventListener('click', () => {
    const colorInp = document.getElementById('admin-prod-color-input') as HTMLInputElement | null;
    const rawVal = colorInp?.value?.trim() || state.adminArticleColorSelectedPresets.join(' / ');
    if (!rawVal) {
      showToast('Enter a colourway or tick colours to combine first.');
      colorInp?.focus();
      return;
    }
    state.adminArticleColorDraftOptions = normalizeColorOptionList([...state.adminArticleColorDraftOptions, rawVal]);
    state.adminArticleColorSelectedPresets = [];
    document.querySelectorAll<HTMLInputElement>('.su-color-preset-check').forEach(cb => {
      cb.checked = false;
    });
    if (colorInp) {
      colorInp.value = '';
      colorInp.focus();
    }
    syncArticleColorChipsDom();
  });

  document.getElementById('btn-admin-save-product')?.addEventListener('click', (e) => {
    const nameEl = document.getElementById('admin-prod-name') as HTMLInputElement | null;
    const sizeFmtEl = document.getElementById('admin-prod-size-format') as HTMLSelectElement | null;
    const colorInpEl = document.getElementById('admin-prod-color-input') as HTMLInputElement | null;
    const name = nameEl?.value?.trim() || '';
    const customerId = (document.getElementById('admin-prod-cust') as HTMLSelectElement)?.value;
    const sizeFormat = sizeFmtEl?.value || 'ALPHA_2XS_5XL';
    const pendingColor = colorInpEl?.value?.trim() || state.adminArticleColorSelectedPresets.join(' / ');
    const colorOptions = normalizeColorOptionList([
      ...state.adminArticleColorDraftOptions,
      ...(pendingColor ? [pendingColor] : [])
    ]);

    const errors = validateProductMasterInputs({ name });
    if (applyFieldValidationErrors([[nameEl, errors.name]])) {
      showToast('Review highlighted Article Master fields.');
      return;
    }

    void runAdminAction('admin:save-product', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch('/api/admin/master/product', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            customerId: customerId || 'CUST-01',
            sizeFormat,
            colorSpec: colorOptions[0] || '',
            colorOptions
          })
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          applyFieldValidationErrors([[nameEl, json.error || 'Article could not be saved.']]);
          showToast(json.error || 'Article could not be saved.');
          return;
        }
        if (!state.dropdownOptions.articles.includes(name)) {
          state.dropdownOptions.articles.push(name);
        }
        if (Array.isArray(json.data)) {
          state.adminOverview.products = json.data;
        }
        state.adminArticleColorDraftOptions = [];
        state.adminArticleColorSelectedPresets = [];
        if (nameEl) nameEl.value = '';
        if (colorInpEl) colorInpEl.value = '';
        showToast(`Article "${name}" saved to SQLite Products Master & Dropdowns.`);
        await syncBackendData();
      } catch (err) {
        console.warn(err);
        showToast('Article could not be saved.');
      }
    });
  });

  document.getElementById('admin-carton-product')?.addEventListener('change', (ev) => {
    const sel = ev.currentTarget as HTMLSelectElement;
    const opt = sel.selectedOptions?.[0];
    const pairsAttr = opt?.getAttribute('data-pairs-per-carton');
    const stickersAttr = opt?.getAttribute('data-stickers-per-pair');
    const pairsEl = document.getElementById('admin-carton-pairs') as HTMLInputElement | null;
    const stickersEl = document.getElementById('admin-carton-stickers') as HTMLInputElement | null;
    if (pairsEl && pairsAttr) {
      pairsEl.value = pairsAttr;
      clearFieldValidationError(pairsEl);
    }
    if (stickersEl && stickersAttr) {
      stickersEl.value = stickersAttr;
      clearFieldValidationError(stickersEl);
    }
  });

  document.getElementById('btn-admin-save-carton-spec')?.addEventListener('click', (e) => {
    const prodEl = document.getElementById('admin-carton-product') as HTMLSelectElement | null;
    const stickersEl = document.getElementById('admin-carton-stickers') as HTMLInputElement | null;
    const pairsEl = document.getElementById('admin-carton-pairs') as HTMLInputElement | null;
    const productId = prodEl?.value?.trim() || '';
    const stickersPerPair = Number(stickersEl?.value || 0);
    const pairsPerCarton = Number(pairsEl?.value || 0);

    const errors = validateCartonPackingInputs({ productId, pairsPerCarton, stickersPerPair });
    if (applyFieldValidationErrors([
      [prodEl, errors.productId],
      [stickersEl, errors.stickersPerPair],
      [pairsEl, errors.pairsPerCarton]
    ])) {
      showToast('Review highlighted Carton & Packaging BOM fields.');
      return;
    }

    void runAdminAction('admin:save-carton-spec', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch(`/api/admin/master/product/${encodeURIComponent(productId)}/carton`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pairsPerCarton, stickersPerPair })
        });
        const json = await res.json();
        if (!res.ok || !json.success) {
          applyFieldValidationErrors([[pairsEl, json.error || 'Packaging spec could not be updated.']]);
          showToast(json.error || 'Packaging spec could not be updated.');
          return;
        }
        if (Array.isArray(json.data)) {
          state.adminOverview.products = json.data;
        }
        const artLabel = prodEl?.selectedOptions?.[0]?.textContent?.trim() || productId;
        showToast(`Updated ${artLabel}: ${stickersPerPair} stickers/pr, ${pairsPerCarton} pairs/carton.`);
        await syncBackendData();
      } catch (err) {
        console.warn(err);
        showToast('Packaging spec could not be updated.');
      }
    });
  });

  document.getElementById('admin-add-maker-input')?.addEventListener('input', (e) => {
    clearFieldValidationError(e.currentTarget as HTMLInputElement);
  });

  document.getElementById('btn-admin-add-maker')?.addEventListener('click', (e) => {
    const input = document.getElementById('admin-add-maker-input') as HTMLInputElement | null;
    const val = input?.value?.trim() || '';
    if (!val) {
      applyFieldValidationErrors([[input, 'Enter a Contractor / Maker name.']]);
      showToast('Enter a Contractor / Maker name to register.');
      return;
    }
    void runAdminAction('admin:add-maker', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch('/api/admin/makers', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: val })
        });
        const json = await res.json();
        if (!res.ok || !json.success || !json.data) {
          applyFieldValidationErrors([[input, json.error || 'Unable to add Contractor / Maker.']]);
          showToast(json.error || 'Unable to add Contractor / Maker.');
          return;
        }
        if (Array.isArray(json.data.externalMakers)) {
          state.dropdownOptions.externalMakers = json.data.externalMakers;
        }
        if (Array.isArray(json.data.makers)) {
          state.dropdownOptions.makers = json.data.makers;
        }
        if (input) input.value = '';
        showToast(`Added Contractor "${json.data.name || val}" to SQLite Makers Registry.`);
        renderApp();
        await syncBackendData();
      } catch (err) {
        console.warn('Add maker failed:', err);
        showToast('Failed to add Contractor / Maker.');
      }
    });
  });

  document.getElementById('admin-add-hall-input')?.addEventListener('input', (e) => {
    clearFieldValidationError(e.currentTarget as HTMLInputElement);
  });

  document.querySelectorAll<HTMLInputElement>('[data-hall-stitcher-input]').forEach(inp => {
    inp.addEventListener('input', () => clearFieldValidationError(inp));
  });

  document.getElementById('btn-admin-add-hall')?.addEventListener('click', (e) => {
    const input = document.getElementById('admin-add-hall-input') as HTMLInputElement | null;
    const val = input?.value?.trim() || '';
    if (!val) {
      applyFieldValidationErrors([[input, 'Enter a Hall name.']]);
      showToast('Enter a Hall name to register.');
      return;
    }
    void runAdminAction('admin:add-hall', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch('/api/admin/halls', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: val })
        });
        const json = await res.json();
        if (!res.ok || !json.success || !json.data) {
          showToast(json.error || 'Unable to add Hall.');
          return;
        }
        if (Array.isArray(json.data.halls)) {
          state.dropdownOptions.halls = json.data.halls;
        }
        if (!state.dropdownOptions.makers.some(m => m.trim().toLowerCase() === val.toLowerCase())) {
          state.dropdownOptions.makers.push(json.data.name || val);
        }
        if (input) input.value = '';
        showToast(`Added Hall "${json.data.name || val}" to SQLite Halls Registry.`);
        renderApp();
        await syncBackendData();
      } catch (err) {
        console.warn('Add hall failed:', err);
        showToast('Failed to add Hall.');
      }
    });
  });
}
