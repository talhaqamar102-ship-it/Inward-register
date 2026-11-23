import { escapeHtml, getDefaultStationForRole } from '../../utils/requisitionLogic';
import { clearFieldValidationError } from '../../utils/domModalsAndPrint';
import { renderApp } from '../../appContext';
import { state } from '../../state/appState';

/** Attach Live Tracking search, filter pills, select filters, and mini-chart hover handlers. */
export function attachAdminTrackingHandlers(): void {
  const miniChart = document.getElementById('su-lt-mini-chart');
  const miniReadout = document.getElementById('su-lt-mini-readout');
  if (miniChart && miniReadout) {
    const defaultPct = miniReadout.getAttribute('data-default-pct') || '0';
    miniChart.querySelectorAll<HTMLElement>('.su-lt-mini-col').forEach(col => {
      const pct = col.getAttribute('data-mini-pct') || defaultPct;
      col.addEventListener('mouseenter', () => {
        miniChart.classList.add('is-hovering');
        miniReadout.innerHTML = `<span>${escapeHtml(pct)}</span><small>%</small>`;
      });
      col.addEventListener('focus', () => {
        miniChart.classList.add('is-hovering');
        miniReadout.innerHTML = `<span>${escapeHtml(pct)}</span><small>%</small>`;
      });
    });
    miniChart.addEventListener('mouseleave', () => {
      miniChart.classList.remove('is-hovering');
      miniReadout.innerHTML = `<span>${escapeHtml(defaultPct)}</span><small>%</small>`;
    });
  }

  document.querySelectorAll<HTMLElement>('[data-su-change]').forEach(el => {
    el.addEventListener('change', () => {
      const changeKey = el.dataset.suChange;
      const val = (el as HTMLSelectElement).value;
      if (changeKey === 'tracking-buyer-filter') {
        window.adminSetTrackingBuyerFilter(val);
      } else if (changeKey === 'tracking-maker-filter') {
        window.adminSetTrackingMakerFilter(val);
      }
    });
  });

  // Live Tracking Search & Status Filter
  const trackingSearchInput = document.getElementById('admin-tracking-search') as HTMLInputElement | null;
  trackingSearchInput?.addEventListener('input', () => {
    state.adminTrackingSearch = trackingSearchInput.value;
    renderApp();
  });

  document.querySelectorAll('.admin-tracking-filter-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const filter = (e.currentTarget as HTMLElement).getAttribute('data-tracking-filter') as any;
      if (filter) {
        state.adminTrackingStatusFilter = filter;
        renderApp();
      }
    });
  });

  document.querySelectorAll('.su-stage-bar-btn[data-tracking-filter]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const filter = (e.currentTarget as HTMLElement).getAttribute('data-tracking-filter') as any;
      if (filter) {
        state.adminTrackingStatusFilter = filter;
        state.adminTrackingPage = 1;
        state.adminActiveTab = 'tracking';
        renderApp();
      }
    });
  });
}

/** Attach Super User role/station default sync and user password/delete handlers. */
export function attachAdminUsersHandlers(): void {
  document.querySelectorAll<HTMLButtonElement>('[data-admin-reset-password]').forEach(button => {
    button.addEventListener('click', () => {
      const userId = button.dataset.adminResetPassword;
      if (userId) void window.adminResetSystemUserPassword(userId, button);
    });
  });

  document.querySelectorAll<HTMLButtonElement>('[data-admin-delete-user]').forEach(button => {
    button.addEventListener('click', () => {
      const userId = button.dataset.adminDeleteUser;
      if (userId) void window.adminDeleteSystemUser(userId, button);
    });
  });

  document.querySelectorAll<HTMLInputElement>('[data-admin-user-password]').forEach(input => {
    input.addEventListener('input', () => clearFieldValidationError(input));
  });

  const adminUserRoleSelect = document.getElementById('admin-user-role') as HTMLSelectElement | null;
  const adminUserStationSelect = document.getElementById('admin-user-station') as HTMLSelectElement | null;
  adminUserStationSelect?.addEventListener('change', () => {
    adminUserStationSelect.dataset.manualOverride = 'true';
  });
  adminUserRoleSelect?.addEventListener('change', () => {
    if (adminUserStationSelect && adminUserStationSelect.dataset.manualOverride !== 'true') {
      adminUserStationSelect.value = getDefaultStationForRole(adminUserRoleSelect.value);
    }
  });
}
