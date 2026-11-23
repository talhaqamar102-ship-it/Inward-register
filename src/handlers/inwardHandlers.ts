import {
  GrnSlipParams,
  PendingOrder,
  SizeBreakdown,
  applyPendingOrderSelection,
  buildGrnReceiveConfirmationHtml,
  buildPackingRequisitionSlipHtml,
  calculateSizeTotal,
  createEmptySizes,
  escapeHtml,
  evaluateRequisitionIssuance,
  formatBatchSequence,
  formatCurrentDateDDMMYYYY,
  formatSplitAllocationSummary,
  normalizeBaseReqNumber,
  resolveScaleKeysForBreakdown
} from '../utils/requisitionLogic';
import {
  applyFieldValidationErrors,
  exportTableToCSV,
  openModal,
  printDocument,
  showToast
} from '../utils/domModalsAndPrint';
import { renderApp } from '../appContext';
import {
  findHallByName,
  formatGrnRemainingCaps,
  getGrnRemainingCaps,
  getOrderSizeCodes,
  getOrderStockState,
  getTotalIssuedPairs,
  state
} from '../state/appState';
import {
  applyServerRequisition,
  isPersistedRequisition,
  saveCurrentOrderWipState,
  switchActiveOrder
} from '../state/syncService';

export function attachGRNHandlers(): void {
  const pendingOrderSelect = document.getElementById('grn-pending-order') as HTMLSelectElement;
  const makerSelect = document.getElementById('grn-maker') as HTMLSelectElement;
  const hallSelect = document.getElementById('grn-hall') as HTMLSelectElement | null;
  const stitcherSelect = document.getElementById('grn-stitcher') as HTMLSelectElement | null;
  const articleInput = document.getElementById('grn-article') as HTMLInputElement;
  const colorInput = document.getElementById('grn-color') as HTMLInputElement;
  const receivedFromInput = document.getElementById('grn-received-from') as HTMLInputElement;
  const rcvdPairsInput = document.getElementById('grn-rcvd-pairs') as HTMLInputElement;
  const totalDisplay = document.getElementById('grn-size-total-display');
  const capsDisplay = document.getElementById('grn-size-caps');

  // --- Section: Size Matrix & Split Sync ---
  function syncSizesAndReceived(changedInput?: HTMLInputElement) {
    const activeMaker = makerSelect?.value || state.grnForm.maker;
    const activeOrder = state.pendingOrders.find(o => o.orderId === state.grnForm.pendingOrderId);
    const activeAllocs = activeOrder?.contractorAllocations || [];
    const activeCodes = getOrderSizeCodes(
      state.grnForm.pendingOrderId,
      activeOrder?.sizeCodes || state.grnForm.sizeCodes,
      activeOrder?.sizeFormat || state.grnForm.sizeFormat
    );

    if (activeAllocs.length > 1 && !activeMaker) {
      const nextRows = activeAllocs.map((alloc, idx) => {
        const caps = getGrnRemainingCaps(state.grnForm.pendingOrderId, alloc.maker);
        const existingRow = state.grnForm.splitRows[idx];
        const rfInp = document.querySelector<HTMLInputElement>(`.grn-split-received-from[data-split-idx="${idx}"]`);
        const stitcherSel = document.querySelector<HTMLSelectElement>(`.grn-split-stitcher[data-split-idx="${idx}"]`);
        const receivedFrom = rfInp ? rfInp.value : (existingRow?.receivedFrom || '');
        const hallName = stitcherSel && stitcherSel.value
          ? (stitcherSel.getAttribute('data-hall-name') || existingRow?.hallName || '')
          : (existingRow?.hallName || '');
        const stitcherName = stitcherSel ? stitcherSel.value : (existingRow?.stitcherName || '');
        const sizes = createEmptySizes(activeCodes);
        const rowInputs = Array.from(document.querySelectorAll<HTMLInputElement>(`.grn-split-size-val[data-split-idx="${idx}"]`));
        rowInputs.forEach(inp => {
          const key = inp.getAttribute('data-size') || '';
          if (key && activeCodes.includes(key)) {
            const entered = Math.max(0, parseInt(inp.value || '0', 10) || 0);
            const cap = caps ? (caps.sizeRemaining[key] ?? 0) : Number.POSITIVE_INFINITY;
            sizes[key] = Math.min(entered, cap);
          }
        });
        if (caps && calculateSizeTotal(sizes) > caps.totalRemaining) {
          if (changedInput && Number(changedInput.getAttribute('data-split-idx')) === idx) {
            const changedSize = changedInput.getAttribute('data-size') || '';
            const otherTotal = activeCodes.reduce((s, sz) => s + (sz === changedSize ? 0 : Number(sizes[sz] || 0)), 0);
            if (changedSize) {
              sizes[changedSize] = Math.max(0, Math.min(Number(sizes[changedSize] || 0), caps.totalRemaining - otherTotal));
            }
          } else {
            let excess = calculateSizeTotal(sizes) - caps.totalRemaining;
            for (const sz of [...activeCodes].reverse()) {
              const red = Math.min(Number(sizes[sz] || 0), excess);
              sizes[sz] = Math.max(0, Number(sizes[sz] || 0) - red);
              excess -= red;
              if (excess <= 0) break;
            }
          }
        }
        rowInputs.forEach(inp => {
          const key = inp.getAttribute('data-size') || '';
          if (!key || !activeCodes.includes(key)) return;
          const otherTotal = activeCodes.reduce((s, sz) => s + (sz === key ? 0 : Number(sizes[sz] || 0)), 0);
          if (caps) {
            inp.max = String(Math.max(0, Math.min(caps.sizeRemaining[key] ?? 0, caps.totalRemaining - otherTotal)));
          } else {
            inp.removeAttribute('max');
          }
          inp.value = sizes[key] ? String(sizes[key]) : '';
        });
        const rowSum = calculateSizeTotal(sizes);
        const rowCell = document.getElementById(`grn-split-row-total-${idx}`);
        if (rowCell) rowCell.textContent = rowSum.toLocaleString();
        return { maker: alloc.maker, hallName, stitcherName, receivedFrom, sizes };
      });
      state.grnForm.splitRows = nextRows;
      const grandTotal = nextRows.reduce((s, r) => s + calculateSizeTotal(r.sizes), 0);
      if (totalDisplay) totalDisplay.textContent = grandTotal.toLocaleString();
      if (rcvdPairsInput) {
        rcvdPairsInput.value = grandTotal > 0 ? String(grandTotal) : '';
        state.grnForm.rcvdPairs = grandTotal > 0 ? String(grandTotal) : '';
      }
      return;
    }

    const caps = getGrnRemainingCaps(state.grnForm.pendingOrderId, activeMaker);
    const sizeInputs = Array.from(document.querySelectorAll<HTMLInputElement>('.grn-size-val'));
    const sizes: SizeBreakdown = createEmptySizes(activeCodes);
    sizeInputs.forEach(inp => {
      const key = inp.getAttribute('data-size') || '';
      if (key && activeCodes.includes(key)) {
        const entered = Math.max(0, parseInt(inp.value || '0', 10) || 0);
        const cap = caps ? (caps.sizeRemaining[key] ?? 0) : Number.POSITIVE_INFINITY;
        sizes[key] = Math.min(entered, cap);
      }
    });

    if (caps && calculateSizeTotal(sizes) > caps.totalRemaining) {
      if (changedInput) {
        const changedSize = changedInput.getAttribute('data-size') || '';
        const otherTotal = activeCodes.reduce(
          (sum, size) => sum + (size === changedSize ? 0 : Number(sizes[size] || 0)),
          0
        );
        if (changedSize) {
          sizes[changedSize] = Math.max(0, Math.min(
            Number(sizes[changedSize] || 0),
            caps.totalRemaining - otherTotal
          ));
        }
      } else {
        let excess = calculateSizeTotal(sizes) - caps.totalRemaining;
        for (const size of [...activeCodes].reverse()) {
          const reduction = Math.min(Number(sizes[size] || 0), excess);
          sizes[size] = Math.max(0, Number(sizes[size] || 0) - reduction);
          excess -= reduction;
          if (excess <= 0) break;
        }
      }
    }

    sizeInputs.forEach(inp => {
      const key = inp.getAttribute('data-size') || '';
      if (!key || !activeCodes.includes(key)) return;
      const otherTotal = activeCodes.reduce(
        (sum, size) => sum + (size === key ? 0 : Number(sizes[size] || 0)),
        0
      );
      if (caps) {
        inp.max = String(Math.max(0, Math.min(caps.sizeRemaining[key] ?? 0, caps.totalRemaining - otherTotal)));
      } else {
        inp.removeAttribute('max');
      }
      inp.value = sizes[key] ? String(sizes[key]) : '';
    });

    state.grnForm.sizes = sizes;
    const sizeSum = calculateSizeTotal(sizes);

    if (totalDisplay) {
      totalDisplay.textContent = sizeSum.toLocaleString();
    }
    document.querySelectorAll<HTMLElement>('[data-bal-size]').forEach(el => {
      const sz = el.getAttribute('data-bal-size') || '';
      const rem = caps ? Math.max(0, (caps.sizeRemaining[sz] ?? 0) - Number(sizes[sz] || 0)) : null;
      el.textContent = rem !== null ? rem.toLocaleString() : '—';
      el.classList.toggle('is-zero', rem === 0);
    });
    const balanceTotalEl = document.getElementById('grn-balance-total');
    if (balanceTotalEl) {
      balanceTotalEl.textContent = caps
        ? Math.max(0, caps.totalRemaining - sizeSum).toLocaleString()
        : '—';
    }
    if (capsDisplay) {
      capsDisplay.textContent = caps
        ? formatGrnRemainingCaps(caps, sizes)
        : 'No matching pending-order size cap available; received quantities are unrestricted.';
    }
    if (rcvdPairsInput) {
      rcvdPairsInput.value = sizeSum > 0 ? String(sizeSum) : '';
      state.grnForm.rcvdPairs = sizeSum > 0 ? String(sizeSum) : '';
    }
  }

  pendingOrderSelect?.addEventListener('change', () => {
    const val = pendingOrderSelect.value;
    state.grnForm.pendingOrderId = val;
    if (!val) {
      state.grnForm.maker = '';
      state.grnForm.hallName = '';
      state.grnForm.stitcherName = '';
      state.grnForm.article = '';
      state.grnForm.color = '';
      state.grnForm.receivedFrom = '';
      state.grnForm.rcvdPairs = '';
      state.grnForm.sizeFormat = 'LEGACY_7_11';
      state.grnForm.sizeCodes = undefined;
      state.grnForm.sizes = createEmptySizes();
      state.grnForm.splitRows = [];
      renderApp();
      return;
    }
    const filled = applyPendingOrderSelection(state.pendingOrders, val);
    if (!filled) {
      syncSizesAndReceived();
      return;
    }

    const activeCodes = getOrderSizeCodes(val, filled.sizeCodes, filled.sizeFormat);
    const hasSplit = Boolean(filled.contractorAllocations && filled.contractorAllocations.length > 1);
    state.grnForm.pendingOrderId = filled.pendingOrderId;
    state.grnForm.maker = hasSplit ? '' : filled.maker;
    state.grnForm.article = filled.article;
    state.grnForm.color = filled.color || 'Standard';
    state.grnForm.sizeFormat = filled.sizeFormat || 'LEGACY_7_11';
    state.grnForm.sizeCodes = activeCodes;
    state.grnForm.sizes = createEmptySizes(activeCodes);
    state.grnForm.rcvdPairs = '';
    if (hasSplit && filled.contractorAllocations) {
      state.grnForm.hallName = '';
      state.grnForm.stitcherName = '';
      state.grnForm.receivedFrom = '';
      state.grnForm.splitRows = filled.contractorAllocations.map(a => {
        const matchedHall = findHallByName(a.maker);
        return {
          maker: a.maker,
          hallName: matchedHall && matchedHall.stitchers.length > 0 ? matchedHall.name : '',
          stitcherName: '',
          receivedFrom: '',
          sizes: createEmptySizes(activeCodes)
        };
      });
    } else {
      state.grnForm.splitRows = [];
      const matchedHall = findHallByName(filled.maker);
      const hasHallStitchers = Boolean(matchedHall && matchedHall.stitchers.length > 0);
      state.grnForm.hallName = hasHallStitchers ? matchedHall!.name : '';
      state.grnForm.stitcherName = '';
      if (hasHallStitchers) {
        if (state.grnForm.receivedFrom.endsWith(' Representative')) {
          state.grnForm.receivedFrom = '';
        }
      } else if (!state.grnForm.receivedFrom?.trim() || state.grnForm.receivedFrom.endsWith(' Representative')) {
        state.grnForm.receivedFrom = filled.maker ? `${filled.maker} Representative` : '';
      }
    }

    renderApp();
    showToast(
      hasSplit
        ? `Order ${filled.pendingOrderId} split among ${filled.contractorAllocations!.map(a => a.maker).join(', ')} — enter Received From & quantities per contractor.`
        : `Order ${filled.pendingOrderId} selected: Locked Article (${filled.article}) & Colour (${state.grnForm.color}).`
    );
  });

  makerSelect?.addEventListener('change', () => {
    const activeOrder = state.pendingOrders.find(o => o.orderId === state.grnForm.pendingOrderId);
    const hasSplit = (activeOrder?.contractorAllocations?.length || 0) > 1;
    const prevHall = state.grnForm.hallName;
    state.grnForm.maker = makerSelect.value;
    const matchedHall = findHallByName(state.grnForm.maker);
    const hasHallStitchers = Boolean(matchedHall && matchedHall.stitchers.length > 0);
    state.grnForm.hallName = hasHallStitchers ? matchedHall!.name : '';
    state.grnForm.stitcherName = '';
    if (hasHallStitchers) {
      if (state.grnForm.receivedFrom.endsWith(' Representative')) {
        state.grnForm.receivedFrom = '';
      }
    } else if (!state.grnForm.receivedFrom?.trim() || state.grnForm.receivedFrom.endsWith(' Representative')) {
      state.grnForm.receivedFrom = state.grnForm.maker ? `${state.grnForm.maker} Representative` : '';
      if (receivedFromInput) receivedFromInput.value = state.grnForm.receivedFrom;
    }
    syncSizesAndReceived();
    if (hasSplit || prevHall !== state.grnForm.hallName || hasHallStitchers) {
      renderApp();
    }
  });

  hallSelect?.addEventListener('change', () => {
    syncSizesAndReceived();
    const selectedHall = findHallByName(hallSelect.value);
    state.grnForm.hallName = selectedHall ? selectedHall.name : '';
    state.grnForm.stitcherName = '';
    if (selectedHall && selectedHall.stitchers.length > 0) {
      if (state.grnForm.receivedFrom.endsWith(' Representative')) {
        state.grnForm.receivedFrom = '';
      }
      if (!state.grnForm.pendingOrderId && (!state.grnForm.maker || findHallByName(state.grnForm.maker))) {
        state.grnForm.maker = selectedHall.name;
      }
    } else if (!selectedHall && state.grnForm.maker && findHallByName(state.grnForm.maker) && !state.grnForm.pendingOrderId) {
      state.grnForm.maker = '';
    }
    renderApp();
  });

  stitcherSelect?.addEventListener('change', () => {
    state.grnForm.stitcherName = stitcherSelect.value;
    applyFieldValidationErrors([
      [stitcherSelect, ''],
      [receivedFromInput, '']
    ]);
    const noteHintEl = document.getElementById('grn-note-hint');
    const curHall = findHallByName(state.grnForm.hallName);
    if (noteHintEl && curHall && curHall.stitchers.length > 0) {
      const whoLabel = state.grnForm.stitcherName || 'Stitcher';
      noteHintEl.innerHTML = `Optional: defaults to <strong>${escapeHtml(`${whoLabel} (${curHall.name})`)}</strong> if left blank.`;
    }
  });

  receivedFromInput?.addEventListener('input', () => {
    state.grnForm.receivedFrom = receivedFromInput.value;
    const curHall = findHallByName(state.grnForm.hallName);
    const isOptional = Boolean(curHall && curHall.stitchers.length > 0);
    applyFieldValidationErrors([
      [receivedFromInput, isOptional || receivedFromInput.value.trim() ? '' : 'Enter who goods were received from.']
    ]);
  });

  // --- Section: Form Inputs & Split Controls ---
  document.querySelectorAll('.grn-size-val').forEach(inp => {
    inp.addEventListener('input', () => syncSizesAndReceived(inp as HTMLInputElement));
  });
  document.querySelectorAll('.grn-split-size-val').forEach(inp => {
    inp.addEventListener('input', () => syncSizesAndReceived(inp as HTMLInputElement));
  });
  document.querySelectorAll<HTMLSelectElement>('.grn-split-stitcher').forEach(sel => {
    sel.addEventListener('change', () => {
      const idx = Number(sel.getAttribute('data-split-idx'));
      const hName = sel.getAttribute('data-hall-name') || '';
      if (state.grnForm.splitRows[idx]) {
        state.grnForm.splitRows[idx].hallName = sel.value ? hName : '';
        state.grnForm.splitRows[idx].stitcherName = sel.value;
      }
      applyFieldValidationErrors([[sel, '']]);
    });
  });
  document.querySelectorAll<HTMLInputElement>('.grn-split-received-from').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.getAttribute('data-split-idx'));
      if (state.grnForm.splitRows[idx]) {
        state.grnForm.splitRows[idx].receivedFrom = inp.value;
      }
      applyFieldValidationErrors([[inp, '']]);
    });
  });
  syncSizesAndReceived();

  document.getElementById('btn-clear-grn')?.addEventListener('click', () => {
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
    renderApp();
    showToast('Inward form and size breakdown cleared.');
  });

  // --- Section: GRN Persistence & Receive Button ---
  async function persistAndRecordGrnBatch(params: {
    entryPendingOrder: string;
    selectedOrder?: PendingOrder;
    entryMaker: string;
    entryHallName?: string;
    entryStitcherName?: string;
    entryReceivingNote?: string;
    entryArticle: string;
    entryColor: string;
    entryReceivedFrom: string;
    entrySizes: SizeBreakdown;
    rcvdPairs: number;
    activeCodes: string[];
    activeFormat: string;
    rcvDate: string;
    splitSummary?: string;
  }): Promise<GrnSlipParams | null> {
    const newSr = state.grnList.length + 1;
    const newGrnCode = formatBatchSequence('GRN', newSr);
    let savedReceiving: any = null;
    try {
      const response = await fetch('/api/store/receivings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: params.entryPendingOrder,
          pendingOrderId: params.entryPendingOrder,
          customerName: params.selectedOrder?.buyer || 'Standard',
          makerContractor: params.entryMaker,
          hallName: params.entryHallName || '',
          stitcherName: params.entryStitcherName || '',
          receivingNote: params.entryReceivingNote || '',
          articleName: params.entryArticle,
          colorShade: params.entryColor,
          receivedFrom: params.entryReceivedFrom,
          strictInwardEntry: true,
          orderQty: params.selectedOrder
            ? params.activeCodes.reduce((sum, sizeCode) => sum + Number(params.selectedOrder!.sizes?.[sizeCode] || 0), 0)
            : params.rcvdPairs,
          rcvdPairs: params.rcvdPairs,
          rcvDate: params.rcvDate,
          sizes: params.activeCodes.map(sizeCode => ({
            sizeCode,
            orderPairs: Number(params.selectedOrder?.sizes?.[sizeCode] || 0),
            rcvdPairs: Number(params.entrySizes[sizeCode] || 0)
          }))
        })
      });
      const result = await response.json();
      if (!response.ok || !result.success || !result.data) {
        showToast(result.error || 'Unable to save receiving record to database.');
        return null;
      }
      savedReceiving = result.data;
    } catch (err) {
      console.error('GRN save failed:', err);
      showToast('Failed to save receiving record to backend.');
      return null;
    }

    const persistedCode = savedReceiving?.rcv_number || newGrnCode;
    const persistedDate = savedReceiving?.rcv_date || params.rcvDate;
    const persistedOrderId = savedReceiving?.order_id || params.entryPendingOrder;
    const addedPairs = Number(savedReceiving?.rcvd_pairs || params.rcvdPairs);
    const savedMaker = savedReceiving?.maker_contractor || params.entryMaker;
    const savedHallName = savedReceiving?.hall_name || params.entryHallName || '';
    const savedStitcherName = savedReceiving?.stitcher_name || params.entryStitcherName || '';
    const savedReceivingNote = savedReceiving?.receiving_note || params.entryReceivingNote || '';
    const savedArticle = savedReceiving?.article_name || params.entryArticle;
    const savedColor = savedReceiving?.color_shade || params.entryColor;
    const savedFrom = savedReceiving?.received_from || params.entryReceivedFrom;

    state.grnList.unshift({
      sr: savedReceiving?.id || newSr,
      grnCode: persistedCode,
      date: persistedDate,
      pendingOrderId: persistedOrderId,
      maker: savedMaker,
      hallName: savedHallName,
      stitcherName: savedStitcherName,
      receivingNote: savedReceivingNote,
      article: savedArticle,
      color: savedColor,
      receivedFrom: savedFrom,
      rcvdPairs: addedPairs,
      sizeFormat: params.activeFormat,
      sizeCodes: params.activeCodes,
      sizes: { ...params.entrySizes },
      status: 'Received'
    });

    if (params.selectedOrder && params.selectedOrder.availableDockPairs !== undefined) {
      params.selectedOrder.receivedPairs = Number(params.selectedOrder.receivedPairs || 0) + addedPairs;
      params.selectedOrder.availableDockPairs = Number(params.selectedOrder.availableDockPairs || 0) + addedPairs;
      params.selectedOrder.unclaimedDockPairs = Math.max(
        0,
        params.selectedOrder.availableDockPairs - Number(params.selectedOrder.pendingReqPairs || 0)
      );
      if (params.selectedOrder.receivedSizes) {
        for (const size of params.activeCodes) {
          params.selectedOrder.receivedSizes[size] =
            Number(params.selectedOrder.receivedSizes[size] || 0) + Number(params.entrySizes[size] || 0);
        }
      }
      params.selectedOrder.unclaimedDockSizes = params.selectedOrder.unclaimedDockSizes || createEmptySizes(params.activeCodes);
      for (const size of params.activeCodes) {
        params.selectedOrder.unclaimedDockSizes[size] =
          Number(params.selectedOrder.unclaimedDockSizes[size] || 0) + Number(params.entrySizes[size] || 0);
      }
      if (params.selectedOrder.contractorAllocations?.length) {
        const alloc = params.selectedOrder.contractorAllocations.find(
          a => a.maker.trim().toLowerCase() === params.entryMaker.trim().toLowerCase()
        );
        if (alloc) {
          alloc.receivedPairs = Number(alloc.receivedPairs || 0) + addedPairs;
          alloc.remainingPairs = Math.max(0, alloc.totalQty - alloc.receivedPairs);
          alloc.receivedSizes = alloc.receivedSizes || createEmptySizes(params.activeCodes);
          alloc.remainingSizes = alloc.remainingSizes || { ...alloc.sizes };
          for (const size of params.activeCodes) {
            alloc.receivedSizes[size] = Number(alloc.receivedSizes[size] || 0) + Number(params.entrySizes[size] || 0);
            alloc.remainingSizes[size] = Math.max(0, Number(alloc.sizes[size] || 0) - Number(alloc.receivedSizes[size] || 0));
          }
        }
      }
    }

    if (!state.packingWip.article && savedArticle) {
      state.packingWip.article = savedArticle;
    }
    if (!state.packingWip.parentOrderId && persistedOrderId) {
      state.packingWip.parentOrderId = persistedOrderId;
    }

    return {
      grnRef: persistedCode,
      date: persistedDate,
      pendingOrderId: persistedOrderId,
      maker: savedMaker,
      hallName: savedHallName || undefined,
      stitcherName: savedStitcherName || undefined,
      receivingNote: savedReceivingNote || undefined,
      article: savedArticle,
      color: savedColor,
      receivedFrom: savedFrom,
      splitSummary: params.splitSummary || undefined,
      rcvdPairs: addedPairs,
      sizes: { ...params.entrySizes },
      sizeFormat: params.activeFormat,
      sizeCodes: params.activeCodes
    };
  }

  // Receive button: saves GRN(s) with today's date and opens confirmation popup (Print button ready at bottom, no auto-print)
  document.getElementById('btn-print-grn-slip')?.addEventListener('click', async () => {
    syncSizesAndReceived();
    const formPendingOrder = pendingOrderSelect?.value || state.grnForm.pendingOrderId;
    const formMaker = makerSelect?.value || state.grnForm.maker;
    const formArt = articleInput?.value || state.grnForm.article;
    const formColor = colorInput?.value || state.grnForm.color || 'Standard';
    const activeOrder = formPendingOrder ? state.pendingOrders.find(order => order.orderId === formPendingOrder) : undefined;
    if (!formPendingOrder || !activeOrder) {
      applyFieldValidationErrors([[pendingOrderSelect, 'Select a pending order created by Super User.']]);
      showToast('Select a pending order created by Super User. Only Super User can create or edit orders.');
      return;
    }
    const activeCodes = getOrderSizeCodes(
      formPendingOrder,
      activeOrder?.sizeCodes || state.grnForm.sizeCodes,
      activeOrder?.sizeFormat || state.grnForm.sizeFormat
    );
    const activeFormat = activeOrder?.sizeFormat || state.grnForm.sizeFormat || 'LEGACY_7_11';
    const splitSummary = formatSplitAllocationSummary(activeOrder?.contractorAllocations);
    const todayDate = formatCurrentDateDDMMYYYY();

    const isMultiSplitMode = Boolean(activeOrder && (activeOrder.contractorAllocations?.length || 0) > 1 && !formMaker);
    if (isMultiSplitMode && activeOrder) {
      const activeRows = state.grnForm.splitRows
        .map((row, idx) => ({ row, idx, total: calculateSizeTotal(row.sizes) }))
        .filter(item => item.total > 0);
      if (activeRows.length === 0) {
        showToast('Enter received quantities for at least one split contractor.');
        return;
      }
      const missingSenderFields: Array<[HTMLElement | null, string]> = [];
      for (const item of activeRows) {
        const rfInp = document.querySelector<HTMLElement>(`.grn-split-received-from[data-split-idx="${item.idx}"]`);
        const stitcherSel = document.querySelector<HTMLElement>(`.grn-split-stitcher[data-split-idx="${item.idx}"]`);
        const rowHall = findHallByName(item.row.maker);
        const hasHallStitchers = Boolean(rowHall && rowHall.stitchers.length > 0);
        if (hasHallStitchers) {
          if (!item.row.stitcherName?.trim()) {
            missingSenderFields.push([stitcherSel, `Select a stitcher from ${rowHall!.name}.`]);
          } else {
            applyFieldValidationErrors([[stitcherSel, ''], [rfInp, '']]);
          }
        } else if (!item.row.receivedFrom.trim()) {
          missingSenderFields.push([rfInp, `Enter who delivered goods for ${item.row.maker}.`]);
        } else {
          applyFieldValidationErrors([[rfInp, '']]);
        }
        const rowCaps = getGrnRemainingCaps(formPendingOrder, item.row.maker);
        if (rowCaps && (
          item.total > rowCaps.totalRemaining ||
          activeCodes.some(sz => Number(item.row.sizes[sz] || 0) > (rowCaps.sizeRemaining[sz] ?? 0))
        )) {
          showToast(`Received quantities exceed remaining allocation cap for ${item.row.maker}.`);
          return;
        }
      }
      if (missingSenderFields.length > 0) {
        applyFieldValidationErrors(missingSenderFields);
        showToast('Complete stitcher / received-from attribution for each contractor delivering goods.');
        return;
      }

      const savedBatches: GrnSlipParams[] = [];
      for (const item of activeRows) {
        const rowHall = findHallByName(item.row.maker);
        const hasHallStitchers = Boolean(rowHall && rowHall.stitchers.length > 0);
        const noteVal = item.row.receivedFrom.trim();
        const effectiveFrom = hasHallStitchers
          ? (noteVal || `${item.row.stitcherName} (${rowHall!.name})`)
          : noteVal;
        const saved = await persistAndRecordGrnBatch({
          entryPendingOrder: formPendingOrder,
          selectedOrder: activeOrder,
          entryMaker: item.row.maker,
          entryHallName: hasHallStitchers ? rowHall!.name : (item.row.hallName || ''),
          entryStitcherName: hasHallStitchers ? (item.row.stitcherName || '') : '',
          entryReceivingNote: hasHallStitchers ? noteVal : '',
          entryArticle: activeOrder.article || formArt || '---',
          entryColor: activeOrder.color || formColor || 'Standard',
          entryReceivedFrom: effectiveFrom,
          entrySizes: { ...item.row.sizes },
          rcvdPairs: item.total,
          activeCodes,
          activeFormat,
          rcvDate: todayDate,
          splitSummary
        });
        if (!saved) {
          if (savedBatches.length > 0) renderApp();
          return;
        }
        savedBatches.push(saved);
      }

      state.grnForm.splitRows = (activeOrder.contractorAllocations || []).map(a => {
        const matchedHall = findHallByName(a.maker);
        return {
          maker: a.maker,
          hallName: matchedHall && matchedHall.stitchers.length > 0 ? matchedHall.name : '',
          stitcherName: '',
          receivedFrom: '',
          sizes: createEmptySizes(activeCodes)
        };
      });
      state.grnForm.rcvdPairs = '';
      const confirmHtml = buildGrnReceiveConfirmationHtml({
        pendingOrderId: formPendingOrder,
        date: savedBatches[0].date,
        splitSummary,
        batches: savedBatches
      });
      renderApp();
      openModal(`Receiving Confirmed — ${savedBatches.map(b => b.grnRef).join(', ')} (${formPendingOrder})`, confirmHtml, true);
      return;
    }

    const formHall = (hallSelect?.value ?? state.grnForm.hallName ?? '').trim();
    const formStitcher = (stitcherSelect?.value ?? state.grnForm.stitcherName ?? '').trim();
    const formReceivedFrom = (receivedFromInput?.value ?? state.grnForm.receivedFrom ?? '').trim();
    const selectedHallObj = findHallByName(formHall);
    const sizeTotal = calculateSizeTotal(state.grnForm.sizes);
    const rcvdPairs = Math.max(0, parseInt(rcvdPairsInput?.value || '0', 10) || sizeTotal);
    const caps = getGrnRemainingCaps(formPendingOrder, formMaker);
    if (caps && (
      rcvdPairs > caps.totalRemaining ||
      activeCodes.some(size => Number(state.grnForm.sizes[size] || 0) > (caps.sizeRemaining[size] ?? 0))
    )) {
      showToast('Received quantities exceed the selected contractor allocation remaining size or total cap.');
      return;
    }

    if (formPendingOrder || formMaker || formHall || formArt || rcvdPairs > 0) {
      if (formPendingOrder && !formMaker) {
        applyFieldValidationErrors([[makerSelect, 'Choose the delivering contractor for this order.']]);
        showToast('Choose which allocated contractor delivered these goods.');
        return;
      }
      if (formHall) {
        if (!selectedHallObj || selectedHallObj.stitchers.length === 0) {
          applyFieldValidationErrors([[hallSelect, 'Add stitchers to this Hall in Registry 04 before receiving from it, or clear Hall.']]);
          showToast(`No stitchers are assigned to ${formHall} in Registry 04 yet.`);
          return;
        }
        if (!formStitcher) {
          applyFieldValidationErrors([[stitcherSelect, `Select which stitcher in ${selectedHallObj.name} delivered these goods.`]]);
          showToast(`Select a Stitcher from ${selectedHallObj.name}.`);
          return;
        }
      } else if (!formReceivedFrom) {
        applyFieldValidationErrors([[receivedFromInput, 'Enter the person name goods were received from.']]);
        showToast('Enter the person name in Received From.');
        return;
      }

      const effectiveReceivedFrom = selectedHallObj && formStitcher
        ? (formReceivedFrom || `${formStitcher} (${selectedHallObj.name})`)
        : formReceivedFrom;
      const effectiveReceivingNote = selectedHallObj && formStitcher ? formReceivedFrom : '';

      const saved = await persistAndRecordGrnBatch({
        entryPendingOrder: formPendingOrder || 'ORD-INWARD',
        selectedOrder: activeOrder,
        entryMaker: formMaker || selectedHallObj?.name || '---',
        entryHallName: selectedHallObj?.name || '',
        entryStitcherName: selectedHallObj ? formStitcher : '',
        entryReceivingNote: effectiveReceivingNote,
        entryArticle: activeOrder?.article || formArt || '---',
        entryColor: activeOrder?.color || formColor || 'Standard',
        entryReceivedFrom: effectiveReceivedFrom,
        entrySizes: { ...state.grnForm.sizes },
        rcvdPairs,
        activeCodes,
        activeFormat,
        rcvDate: todayDate,
        splitSummary
      });
      if (!saved) return;

      state.grnForm.sizes = createEmptySizes(activeCodes);
      state.grnForm.rcvdPairs = '';
      if (selectedHallObj) {
        state.grnForm.stitcherName = '';
        state.grnForm.receivedFrom = '';
      }
      const confirmHtml = buildGrnReceiveConfirmationHtml({
        pendingOrderId: saved.pendingOrderId || 'ORD-INWARD',
        date: saved.date,
        splitSummary,
        batches: [saved]
      });
      renderApp();
      openModal(`Receiving Confirmed — ${saved.grnRef} (${saved.pendingOrderId})`, confirmHtml, true);
      return;
    }

    const latest = state.grnList[0];
    const pendingOrderId = formPendingOrder || latest?.pendingOrderId || '---';
    const maker = formMaker || latest?.maker || '---';
    const article = latest?.article || formArt || '---';
    const color = latest?.color || formColor || 'Standard';
    const receivedFrom = formReceivedFrom || latest?.receivedFrom || maker || '---';
    const sizes = calculateSizeTotal(state.grnForm.sizes) > 0
      ? state.grnForm.sizes
      : (latest?.sizes || createEmptySizes(activeCodes));
    const finalRcvd = rcvdPairs || latest?.rcvdPairs || calculateSizeTotal(sizes);
    const grnCode = latest?.grnCode || formatBatchSequence('GRN', state.grnList.length || 1);
    const fallbackHtml = buildGrnReceiveConfirmationHtml({
      pendingOrderId,
      date: latest?.date || todayDate,
      splitSummary,
      batches: [{
        grnRef: grnCode,
        date: latest?.date || todayDate,
        pendingOrderId,
        maker,
        hallName: latest?.hallName || undefined,
        stitcherName: latest?.stitcherName || undefined,
        receivingNote: latest?.receivingNote || undefined,
        article,
        color,
        receivedFrom,
        splitSummary: splitSummary || undefined,
        rcvdPairs: finalRcvd,
        sizes,
        sizeFormat: latest?.sizeFormat || activeFormat,
        sizeCodes: latest?.sizeCodes || activeCodes
      }]
    });
    openModal(`Receiving Confirmed — ${grnCode} (${pendingOrderId})`, fallbackHtml, true);
  });

  // --- Section: Requisition Issuance Queue ---
  document.getElementById('grn-queue-req-select')?.addEventListener('change', (e) => {
    const select = e.target as HTMLSelectElement;
    if (!select.value) return;
    switchActiveOrder(select.value);
    renderApp();
  });

  // Inward Register Person issues the Packing Hall's Requisition Asking (given available received stock)
  document.getElementById('btn-issue-req-to-packing')?.addEventListener('click', async () => {
    const wip = state.packingWip;
    const baseReq = normalizeBaseReqNumber(wip.selectedBatch);
    const askingPairs = wip.plannedQty || calculateSizeTotal(wip.sizes);

    if (askingPairs <= 0) {
      showToast('Packing Hall has not generated an asking quantity yet. Generate Requisition in Packing Hall first.');
      return;
    }

    const targetOrderId = wip.parentOrderId || state.grnList[0]?.pendingOrderId || '';
    const orderStock = getOrderStockState(targetOrderId);
    const evalIssue = evaluateRequisitionIssuance({
      askingPairs,
      askingSizes: wip.sizes,
      totalReceivedPairs: orderStock.totalReceived,
      alreadyIssuedPairs: orderStock.totalIssued
    });

    if (!evalIssue.canIssue) {
      showToast(`Insufficient received stock in Inward Register${targetOrderId ? ` for ${targetOrderId}` : ''}! Asking: ${evalIssue.askingPairs} Pairs, Available: ${evalIssue.availablePairs} Pairs (Shortfall: ${evalIssue.shortfallPairs} Pairs).`);
      return;
    }

    const isPersisted = isPersistedRequisition(baseReq);

    if (targetOrderId || isPersisted) {
      const endpoint = targetOrderId
        ? `/api/orders/${encodeURIComponent(targetOrderId)}/issue-req`
        : `/api/requisitions/${encodeURIComponent(baseReq)}/issue`;
      const bodyPayload = targetOrderId
        ? { reqNumber: baseReq, requestedPairs: evalIssue.askingPairs }
        : {};
      try {
        const response = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(bodyPayload)
        });
        const result = await response.json();
        if (!response.ok || !result.success) {
          showToast(result.error || `Unable to issue Requisition ${baseReq}.`);
          return;
        }

        const serverReq = result.data?.requisition || (result.data?.req_number ? result.data : null);
        if (serverReq) {
          applyServerRequisition(serverReq, true);
          state.persistedReqNumbers = Array.from(new Set([...state.persistedReqNumbers, baseReq]));
        } else {
          state.packingWip.issueStatus = 'Issued by Inward Register';
          state.packingWip.stage1In = evalIssue.askingPairs;
          state.packingWip.mreqQty = '0 Sets';
          if (!state.packingWip.parentOrderId && targetOrderId) {
            state.packingWip.parentOrderId = targetOrderId;
          }
          saveCurrentOrderWipState();
        }

        const matchedOrder = state.pendingOrders.find(o => o.orderId === targetOrderId);
        if (matchedOrder && matchedOrder.availableDockPairs !== undefined) {
          matchedOrder.issuedPairs = Number(matchedOrder.issuedPairs || 0) + evalIssue.askingPairs;
          const nextAvailableDock = typeof result.data?.remainingDockPoolPairs === 'number'
            ? result.data.remainingDockPoolPairs
            : Math.max(0, Number(matchedOrder.availableDockPairs || 0) - evalIssue.askingPairs);
          const nextPendingReq = Math.max(0, Number(matchedOrder.pendingReqPairs || 0) - evalIssue.askingPairs);
          matchedOrder.availableDockPairs = nextAvailableDock;
          matchedOrder.pendingReqPairs = nextPendingReq;
          matchedOrder.unclaimedDockPairs = Math.max(0, nextAvailableDock - nextPendingReq);
        }
        state.issuedPairsTotal = getTotalIssuedPairs();
      } catch (error) {
        console.error('Requisition issuance failed:', error);
        showToast(`Failed to issue Requisition ${baseReq} to backend.`);
        return;
      }
    } else {
      state.issuedPairsTotal += evalIssue.askingPairs;
      state.packingWip.issueStatus = 'Issued by Inward Register';
      state.packingWip.stage1In = evalIssue.askingPairs;
      state.packingWip.mreqQty = '0 Sets';
      saveCurrentOrderWipState();
    }

    const slipHtml = buildPackingRequisitionSlipHtml({
      reqNo: baseReq,
      date: formatCurrentDateDDMMYYYY(),
      article: state.packingWip.article || '---',
      sizes: state.packingWip.sizes,
      totalPairs: evalIssue.askingPairs,
      issueStatus: 'Issued by Inward Register',
      sizeFormat: (state.packingWip as any).sizeFormat,
      sizeCodes: (state.packingWip as any).sizeCodes
    });

    renderApp();
    openModal(`Issued Requisition Slip — ${baseReq}`, slipHtml, true);
    printDocument(`Issued Requisition Slip — ${baseReq}`, slipHtml);
    showToast(`Issued ${evalIssue.askingPairs} Pairs for Requisition ${baseReq} from Inward Register to Packing Hall Stage 1!`);
  });

  // --- Section: GRN Export & Summary Print ---
  document.getElementById('btn-export-grn-excel')?.addEventListener('click', () => {
    exportTableToCSV('Store_Register_Inward_Goods.csv', state.grnList);
    showToast('Store Register exported as CSV/Excel.');
  });

  document.getElementById('btn-print-grn-summary')?.addEventListener('click', () => {
    const tableRows = state.grnList.map((g, i) => `
      <tr>
        <td style="border: 1px solid var(--border-strong); padding: 5px; text-align: center;">${i + 1}</td>
        <td style="border: 1px solid var(--border-strong); padding: 5px;"><strong>${g.pendingOrderId || '---'}</strong></td>
        <td style="border: 1px solid var(--border-strong); padding: 5px;"><strong>${g.maker}</strong></td>
        <td style="border: 1px solid var(--border-strong); padding: 5px;"><strong>${g.article}</strong></td>
        <td style="border: 1px solid var(--border-strong); padding: 5px; text-align: center;">
          ${resolveScaleKeysForBreakdown(g.sizes, g.sizeCodes).map(sz => `${escapeHtml(sz)}:${g.sizes?.[sz] ?? 0}`).join(' | ')}
        </td>
        <td style="border: 1px solid var(--border-strong); padding: 5px; text-align: right; font-weight: bold;">${g.rcvdPairs.toLocaleString()}</td>
      </tr>
    `).join('');

    const totRcvd = state.grnList.reduce((acc, x) => acc + (x.rcvdPairs || 0), 0);

    const docHtml = `
      <div class="printable-slip-box">
        <div class="printable-slip-header">
          <h2 style="margin: 0; font-size: 16px; font-weight: 800; color: var(--ink-950);">HAMMAD INDUSTRIES &bull; DAILY INWARD GOODS REGISTER SUMMARY</h2>
          <p style="margin: 3px 0 0; font-size: 11px; text-transform: uppercase; color: var(--ink-600);">
            Dock #1 Store Receiving Master Sheet &bull; Date: ${formatCurrentDateDDMMYYYY()}
          </p>
        </div>
        <table style="width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 11px;">
          <thead>
            <tr style="background: var(--ink-100); color: var(--ink-950);">
              <th style="border: 1px solid var(--border-strong); padding: 6px; text-align: center;">#</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px;">Pending Order #</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px;">Maker / Contractor</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px;">Article</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px; text-align: center;">Received Size Breakdown</th>
              <th style="border: 1px solid var(--border-strong); padding: 6px; text-align: right;">Received Pairs</th>
            </tr>
          </thead>
          <tbody>
            ${tableRows || `<tr><td colspan="6" style="border: 1px solid var(--border-strong); padding: 12px; text-align: center;">No receiving entries recorded.</td></tr>`}
            <tr style="background: var(--ink-50); font-weight: bold;">
              <td colspan="5" style="border: 1px solid var(--border-strong); padding: 6px; text-align: right;">Total Daily Received Pairs:</td>
              <td style="border: 1px solid var(--border-strong); padding: 6px; text-align: right;">${totRcvd.toLocaleString()}</td>
            </tr>
          </tbody>
        </table>
        <div style="display: flex; justify-content: space-between; font-size: 11px; margin-top: 25px; border-top: 1px dashed var(--ink-500); padding-top: 8px;">
          <span>Shift Supervisor: ___________________</span>
          <span>Store Manager: ___________________</span>
          <span>Approved By: ___________________</span>
        </div>
      </div>
    `;

    openModal('Daily Inward Goods Register Summary', docHtml);
    printDocument('Daily Inward Goods Register Summary', docHtml);
  });
}
