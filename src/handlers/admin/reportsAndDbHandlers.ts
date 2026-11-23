import { buildSuperUserReportHtml, SuperUserReportType } from '../../components/superUserView';
import { exportTableToCSV, openModal, printDocument, runAdminAction, showToast } from '../../utils/domModalsAndPrint';
import { renderApp } from '../../appContext';
import { getCurrentRollupSummary, state } from '../../state/appState';
import { syncBackendData } from '../../state/syncService';

function buildCurrentAdminReport() {
  const rollupSummary = getCurrentRollupSummary();
  return buildSuperUserReportHtml({
    activeTab: state.adminActiveTab,
    activeReport: state.adminActiveReport,
    trackingSearch: state.adminTrackingSearch,
    trackingStatusFilter: state.adminTrackingStatusFilter,
    expandedOrderIds: state.adminExpandedOrders,
    pendingOrders: state.pendingOrders,
    dropdownOptions: {
      makers: state.dropdownOptions.makers,
      customers: state.dropdownOptions.customers,
      articles: state.dropdownOptions.articles,
      poList: state.dropdownOptions.poList
    },
    adminOverview: state.adminOverview,
    lastBackupPath: state.lastBackupPath,
    rollupSummary
  });
}

/** Attach Super User Reports selection/print/CSV export and SQLite sync/backup/dump actions. */
export function attachAdminReportsAndDbHandlers(): void {
  // Reports Selector, Print & CSV Export
  document.querySelectorAll('.admin-report-select-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const el = e.currentTarget as HTMLElement;
      const rep = (el.getAttribute('data-report-type') || el.getAttribute('data-report-id')) as SuperUserReportType;
      if (rep) {
        state.adminActiveReport = rep;
        renderApp();
        showToast(`Switched report view to: ${el.textContent?.trim() || rep}`);
      }
    });
  });

  document.getElementById('btn-admin-print-report')?.addEventListener('click', () => {
    const built = buildCurrentAdminReport();
    openModal(built.title, built.html, true);
    printDocument(built.title, built.html);
  });

  document.getElementById('btn-admin-export-report-csv')?.addEventListener('click', () => {
    const built = buildCurrentAdminReport();
    exportTableToCSV(built.csvFilename, built.csvRows);
    showToast(`Exported ${built.csvFilename} (${built.csvRows.length} rows).`);
  });

  document.getElementById('btn-admin-refresh')?.addEventListener('click', (e) => {
    void runAdminAction('admin:sync-db', e.currentTarget as HTMLElement, async () => {
      await syncBackendData({ manual: true, forceCatalog: true });
      showToast('Synchronized SQLite tables with Admin Control Center.');
    });
  });

  document.getElementById('btn-admin-trigger-backup')?.addEventListener('click', (e) => {
    void runAdminAction('admin:backup-db', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch('/api/admin/db/backup', { method: 'POST' });
        const json = await res.json();
        if (res.ok && json.success && json.data) {
          state.lastBackupPath = json.data.backupPath;
          showToast(`Online VACUUM Backup created successfully!`);
          renderApp();
        } else {
          showToast(json.error || 'Backup could not be completed.');
        }
      } catch (err) {
        console.warn(err);
        showToast('Backup could not be completed.');
      }
    });
  });

  document.getElementById('btn-admin-reseed-db')?.addEventListener('click', (e) => {
    void runAdminAction('admin:reseed-db', e.currentTarget as HTMLElement, async () => {
      try {
        const res = await fetch('/api/admin/db/reset-seed', { method: 'POST' });
        const json = await res.json();
        if (res.ok && json.success) {
          showToast('SQLite Database verified.');
          await syncBackendData({ forceCatalog: true });
        } else {
          showToast(json.error || 'Database verification failed.');
        }
      } catch (err) {
        console.warn(err);
        showToast('Database verification failed.');
      }
    });
  });

  document.getElementById('btn-admin-export-json')?.addEventListener('click', () => {
    const dump = JSON.stringify(state.adminOverview, null, 2);
    const blob = new Blob([dump], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `hammad_industries_full_erp_dump_${Date.now()}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showToast('Exported complete ERP SQLite snapshot to JSON.');
  });
}
