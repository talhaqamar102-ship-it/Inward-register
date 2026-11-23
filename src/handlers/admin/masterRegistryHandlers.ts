import { validateCustomerMasterInputs, validateProductMasterInputs } from '../../utils/requisitionLogic';
import { applyFieldValidationErrors, clearFieldValidationError, runAdminAction, showToast } from '../../utils/domModalsAndPrint';
import { renderApp } from '../../appContext';
import { state } from '../../state/appState';
import { syncBackendData } from '../../state/syncService';

/** Attach Master Registry collapse state and Buyer/Product/Maker/Hall/PO CRUD handlers. */
export function attachAdminMasterRegistryHandlers(): void {
  document.querySelectorAll<HTMLDetailsElement>('details.su-collapsible-registry[data-registry-id]').forEach(detailsEl => {
    detailsEl.addEventListener('toggle', () => {
      const regId = detailsEl.dataset.registryId;
      if (regId) {
        state.adminOpenRegistries[regId] = detailsEl.open;
      }
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

  document.getElementById('btn-admin-save-product')?.addEventListener('click', (e) => {
    const nameEl = document.getElementById('admin-prod-name') as HTMLInputElement | null;
    const stickersEl = document.getElementById('admin-prod-stickers') as HTMLInputElement | null;
    const cartonEl = document.getElementById('admin-prod-carton') as HTMLInputElement | null;
    const sizeFmtEl = document.getElementById('admin-prod-size-format') as HTMLSelectElement | null;
    const name = nameEl?.value?.trim() || '';
    const customerId = (document.getElementById('admin-prod-cust') as HTMLSelectElement)?.value;
    const sizeFormat = sizeFmtEl?.value || 'ALPHA_2XS_5XL';
    const stickersPerPair = Number(stickersEl?.value || 2);
    const pairsPerCarton = Number(cartonEl?.value || 50);

    const errors = validateProductMasterInputs({ name, stickersPerPair, pairsPerCarton });
    if (applyFieldValidationErrors([
      [nameEl, errors.name],
      [stickersEl, errors.stickersPerPair],
      [cartonEl, errors.pairsPerCarton]
    ])) {
      showToast('Review highlighted Article & BOM Master fields.');
      return;
    }

    void runAdminAction('admin:save-product', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch('/api/admin/master/product', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, customerId: customerId || 'CUST-01', sizeFormat, stickersPerPair, pairsPerCarton })
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
        showToast(`Article "${name}" saved to SQLite Products Master & Dropdowns.`);
        await syncBackendData();
      } catch (err) {
        console.warn(err);
        showToast('Article could not be saved.');
      }
    });
  });

  document.getElementById('btn-admin-add-maker')?.addEventListener('click', () => {
    const val = (document.getElementById('admin-add-maker-input') as HTMLInputElement)?.value?.trim();
    if (!val) return;
    if (!state.dropdownOptions.makers.includes(val)) {
      state.dropdownOptions.makers.push(val);
      showToast(`Added Maker "${val}" to global dropdowns.`);
      renderApp();
    }
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

  document.getElementById('btn-admin-add-po')?.addEventListener('click', () => {
    const val = (document.getElementById('admin-add-po-input') as HTMLInputElement)?.value?.trim();
    if (!val) return;
    if (!state.dropdownOptions.poList.includes(val)) {
      state.dropdownOptions.poList.push(val);
      showToast(`Added PO #${val} to global dropdowns.`);
      renderApp();
    }
  });
}
