function setStatus(error, statusCode) {
  error.statusCode = statusCode;
  return error;
}

export function backfillOrderSequence(database) {
  const rows = database.prepare(`SELECT order_id FROM pending_orders`).all();
  const maxByYear = new Map();
  for (const row of rows) {
    const match = /^ORD-(\d{4})-(\d+)(?:-\d+)?$/.exec(String(row.order_id || ''));
    if (!match) continue;
    const year = Number(match[1]);
    const sequence = Number(match[2]);
    if (!Number.isSafeInteger(sequence)) continue;
    maxByYear.set(year, Math.max(maxByYear.get(year) || 0, sequence));
  }

  const insertSequence = database.prepare(`
    INSERT OR IGNORE INTO order_seq (year, last_n) VALUES (?, ?)
  `);
  const advanceSequence = database.prepare(`
    UPDATE order_seq SET last_n = MAX(last_n, ?) WHERE year = ?
  `);
  for (const [year, lastN] of maxByYear) {
    insertSequence.run(year, lastN);
    advanceSequence.run(lastN, year);
  }
}

function getOrderSchemaSupport(database) {
  const orderCols = database.prepare(`PRAGMA table_info(pending_orders)`).all().map(c => c.name);
  const allocTable = database.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='order_contractor_allocations'`
  ).get();
  const allocCols = allocTable
    ? database.prepare(`PRAGMA table_info(order_contractor_allocations)`).all().map(c => c.name)
    : [];
  const sizeStdTable = database.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='size_standards'`
  ).get();
  const prodTable = database.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='products'`
  ).get();
  return {
    hasDueDateCol: orderCols.includes('due_date'),
    hasSizeFormatCol: orderCols.includes('size_format') && orderCols.includes('sizes_json'),
    hasIdsCol: orderCols.includes('customer_id') && orderCols.includes('product_id'),
    hasAllocTable: Boolean(allocTable),
    hasAllocSizeFormatCol: allocCols.includes('size_format') && allocCols.includes('sizes_json'),
    hasSizeStandardsTable: Boolean(sizeStdTable),
    hasProductsTable: Boolean(prodTable)
  };
}

function resolveScaleCodes(database, schema, { requestedFormat, productId }) {
  let effectiveFormat = String(requestedFormat || '').trim();
  if (!effectiveFormat && productId && schema.hasProductsTable) {
    const prod = database.prepare(`SELECT size_format FROM products WHERE id = ?`).get(productId);
    if (prod?.size_format) effectiveFormat = String(prod.size_format).trim();
  }
  if (!effectiveFormat) effectiveFormat = 'LEGACY_7_11';

  if (effectiveFormat !== 'LEGACY_7_11' && !schema.hasSizeFormatCol) {
    throw new Error(`Database schema does not support dynamic size_format "${effectiveFormat}".`);
  }

  if (schema.hasSizeStandardsTable) {
    const std = database.prepare(`SELECT code, sizes_json FROM size_standards WHERE code = ?`).get(effectiveFormat);
    if (std) {
      return { sizeFormat: std.code, scaleCodes: JSON.parse(std.sizes_json) };
    }
    if (effectiveFormat === 'LEGACY_7_11') {
      return { sizeFormat: 'LEGACY_7_11', scaleCodes: ['7', '8', '9', '10', '11'] };
    }
    throw new Error(`Unsupported size format "${effectiveFormat}".`);
  }

  if (effectiveFormat === 'LEGACY_7_11') {
    return { sizeFormat: 'LEGACY_7_11', scaleCodes: ['7', '8', '9', '10', '11'] };
  }
  throw new Error(`Unsupported size format "${effectiveFormat}".`);
}

function parseScaleSizes(rawSizes, scaleCodes, labelPrefix = 'Order') {
  const normalized = {};
  let sum = 0;
  for (const code of scaleCodes) {
    const num = Number(rawSizes?.[code] ?? 0);
    if (!Number.isSafeInteger(num) || num < 0) {
      throw new Error(`${labelPrefix} size ${code} quantity must be a whole number >= 0.`);
    }
    normalized[code] = num;
    sum += num;
  }
  return { normalized, sum };
}

function normalizePendingOrderPayload(database, schema, payload) {
  const customerId = String(payload.customerId || payload.customer_id || '').trim();
  const productId = String(payload.productId || payload.product_id || '').trim();
  const buyer = String(payload.buyer || '').trim();
  const po = String(payload.po || '').trim();
  const article = String(payload.article || '').trim();
  const color = String(payload.color || 'Standard').trim();
  const { sizeFormat, scaleCodes } = resolveScaleCodes(database, schema, {
    requestedFormat: payload.sizeFormat || payload.size_format,
    productId
  });
  const isLegacy = sizeFormat === 'LEGACY_7_11';

  const sizes = payload.sizes || {};
  const parsedOrder = parseScaleSizes(sizes, scaleCodes, 'Order');
  const size7 = isLegacy ? Number(parsedOrder.normalized['7'] || 0) : 0;
  const size8 = isLegacy ? Number(parsedOrder.normalized['8'] || 0) : 0;
  const size9 = isLegacy ? Number(parsedOrder.normalized['9'] || 0) : 0;
  const size10 = isLegacy ? Number(parsedOrder.normalized['10'] || 0) : 0;
  const size11 = isLegacy ? Number(parsedOrder.normalized['11'] || 0) : 0;
  const totalQty = isLegacy
    ? Math.max(0, Number(payload.totalQty ?? parsedOrder.sum))
    : parsedOrder.sum;
  const orderSizesJson = isLegacy ? '{}' : JSON.stringify(parsedOrder.normalized);
  const rawDueDate = String(payload.dueDate || payload.due_date || '').trim();

  const allowPartial = Boolean(payload.allowPartialAllocation);
  let normalizedAllocations = [];
  if (Array.isArray(payload.allocations) && payload.allocations.length > 0) {
    const rawAllocList = allowPartial
      ? payload.allocations.filter(rawAlloc => {
          const m = String(rawAlloc?.maker || rawAlloc?.makerContractor || '').trim();
          const hasAnyPairs = scaleCodes.some(code => Number(rawAlloc?.sizes?.[code] || 0) > 0);
          return Boolean(m) || hasAnyPairs;
        })
      : payload.allocations;

    const seenMakers = new Set();
    const sumSizes = Object.fromEntries(scaleCodes.map(c => [c, 0]));
    let allocatedTotal = 0;
    for (const rawAlloc of rawAllocList) {
      const allocMaker = String(rawAlloc?.maker || rawAlloc?.makerContractor || '').trim();
      if (!allocMaker) {
        throw setStatus(new Error('Every contractor split row must have a Contractor / Maker selected.'), 400);
      }
      const makerKey = allocMaker.toLowerCase();
      if (seenMakers.has(makerKey)) {
        throw setStatus(new Error(`Duplicate contractor "${allocMaker}" in order split allocations.`), 400);
      }
      seenMakers.add(makerKey);
      const parsedAlloc = parseScaleSizes(rawAlloc?.sizes || {}, scaleCodes, `Contractor "${allocMaker}"`);
      if (totalQty > 0 && parsedAlloc.sum <= 0) {
        throw setStatus(new Error(`Contractor "${allocMaker}" must be assigned at least 1 pair.`), 400);
      }
      for (const code of scaleCodes) {
        sumSizes[code] += parsedAlloc.normalized[code];
      }
      allocatedTotal += parsedAlloc.sum;
      normalizedAllocations.push({
        maker: allocMaker,
        sizesMap: parsedAlloc.normalized,
        sizesJson: isLegacy ? '{}' : JSON.stringify(parsedAlloc.normalized),
        s7: isLegacy ? Number(parsedAlloc.normalized['7'] || 0) : 0,
        s8: isLegacy ? Number(parsedAlloc.normalized['8'] || 0) : 0,
        s9: isLegacy ? Number(parsedAlloc.normalized['9'] || 0) : 0,
        s10: isLegacy ? Number(parsedAlloc.normalized['10'] || 0) : 0,
        s11: isLegacy ? Number(parsedAlloc.normalized['11'] || 0) : 0,
        total: parsedAlloc.sum,
        dueDate: String(rawAlloc?.dueDate || rawAlloc?.due_date || rawDueDate || '').trim()
      });
    }
    if (allowPartial && totalQty > 0 && (normalizedAllocations.length === 0 || allocatedTotal <= 0)) {
      throw setStatus(new Error('Assign at least 1 pair to a contractor, or clear split mode.'), 400);
    }
    if (scaleCodes.some(code => sumSizes[code] > parsedOrder.normalized[code])) {
      throw setStatus(new Error('Contractor size splits cannot exceed the order size breakdown.'), 400);
    }
    if (!allowPartial && scaleCodes.some(code => sumSizes[code] !== parsedOrder.normalized[code])) {
      throw new Error('Contractor size splits must add up exactly to the order size breakdown.');
    }
  }

  const maker = normalizedAllocations.length > 0
    ? normalizedAllocations.map(a => a.maker).join(', ')
    : String(payload.maker || '').trim();
  const latestAllocDue = normalizedAllocations
    .map(a => a.dueDate)
    .filter(Boolean)
    .sort()
    .pop() || '';
  const dueDate = rawDueDate || latestAllocDue;

  if (normalizedAllocations.length === 0) {
    normalizedAllocations = [{
      maker,
      sizesMap: parsedOrder.normalized,
      sizesJson: orderSizesJson,
      s7: size7,
      s8: size8,
      s9: size9,
      s10: size10,
      s11: size11,
      total: totalQty,
      dueDate
    }];
  }

  if (!maker || !article) {
    throw new Error('maker and article are required');
  }
  if (!Number.isSafeInteger(totalQty)) {
    throw new Error('A valid total quantity is required');
  }

  return {
    customerId,
    productId,
    buyer,
    maker,
    po,
    article,
    color,
    sizeFormat,
    orderSizesJson,
    size7,
    size8,
    size9,
    size10,
    size11,
    totalQty,
    dueDate,
    notes: String(payload.notes || ''),
    normalizedAllocations
  };
}

function insertNormalizedOrderRow(database, schema, orderId, norm, { actor, role, recordAuditLog, parentOrderId = '' }) {
  if (schema.hasSizeFormatCol && schema.hasIdsCol && schema.hasDueDateCol) {
    database.prepare(`
      INSERT INTO pending_orders (
        order_id, customer_id, buyer_name, maker_contractor, po_number, product_id,
        article_name, color_shade, size_format, sizes_json,
        size_7, size_8, size_9, size_10, size_11, total_qty, due_date, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      norm.customerId,
      norm.buyer,
      norm.maker,
      norm.po,
      norm.productId,
      norm.article,
      norm.color,
      norm.sizeFormat,
      norm.orderSizesJson,
      norm.size7,
      norm.size8,
      norm.size9,
      norm.size10,
      norm.size11,
      norm.totalQty,
      norm.dueDate,
      norm.notes
    );
  } else if (schema.hasDueDateCol) {
    database.prepare(`
      INSERT INTO pending_orders (
        order_id, buyer_name, maker_contractor, po_number, article_name, color_shade,
        size_7, size_8, size_9, size_10, size_11, total_qty, due_date, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      norm.buyer,
      norm.maker,
      norm.po,
      norm.article,
      norm.color,
      norm.size7,
      norm.size8,
      norm.size9,
      norm.size10,
      norm.size11,
      norm.totalQty,
      norm.dueDate,
      norm.notes
    );
  } else {
    database.prepare(`
      INSERT INTO pending_orders (
        order_id, buyer_name, maker_contractor, po_number, article_name, color_shade,
        size_7, size_8, size_9, size_10, size_11, total_qty, notes
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      orderId,
      norm.buyer,
      norm.maker,
      norm.po,
      norm.article,
      norm.color,
      norm.size7,
      norm.size8,
      norm.size9,
      norm.size10,
      norm.size11,
      norm.totalQty,
      norm.notes
    );
  }

  if (schema.hasAllocTable) {
    if (schema.hasAllocSizeFormatCol) {
      const insertAlloc = database.prepare(`
        INSERT INTO order_contractor_allocations (
          order_id, maker_contractor, size_format, sizes_json,
          size_7, size_8, size_9, size_10, size_11, total_qty, due_date
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of norm.normalizedAllocations) {
        insertAlloc.run(
          orderId,
          a.maker,
          norm.sizeFormat,
          a.sizesJson,
          a.s7,
          a.s8,
          a.s9,
          a.s10,
          a.s11,
          a.total,
          a.dueDate
        );
      }
    } else {
      const insertAlloc = database.prepare(`
        INSERT INTO order_contractor_allocations (
          order_id, maker_contractor, size_7, size_8, size_9, size_10, size_11, total_qty, due_date
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of norm.normalizedAllocations) {
        insertAlloc.run(orderId, a.maker, a.s7, a.s8, a.s9, a.s10, a.s11, a.total, a.dueDate);
      }
    }
  }

  recordAuditLog({
    actor,
    role,
    action: 'ORDER_CREATE',
    entityId: orderId,
    orderId,
    beforeSummary: 'Order did not exist',
    afterSummary: `Created ${norm.totalQty} Prs for ${norm.maker} / ${norm.article}${parentOrderId ? ` (Parent ${parentOrderId})` : ''}`
  });
}

export function createPendingOrder(database, payload, {
  year = new Date().getFullYear(),
  actor = 'System Operator',
  role = 'SUPER_USER',
  recordAuditLog
} = {}) {
  const schema = getOrderSchemaSupport(database);
  const norm = normalizePendingOrderPayload(database, schema, payload || {});
  if (!Number.isInteger(year) || year < 1) {
    throw new Error('A valid order year is required');
  }
  if (typeof recordAuditLog !== 'function') {
    throw new Error('Order creation requires an audit logger');
  }

  database.exec('BEGIN IMMEDIATE');
  try {
    const sequence = database.prepare(`SELECT last_n FROM order_seq WHERE year = ?`).get(year);
    const nextNumber = Number(sequence?.last_n || 0) + 1;
    const orderId = `ORD-${year}-${String(nextNumber).padStart(3, '0')}`;
    if (sequence) {
      database.prepare(`UPDATE order_seq SET last_n = ? WHERE year = ?`).run(nextNumber, year);
    } else {
      database.prepare(`INSERT INTO order_seq (year, last_n) VALUES (?, ?)`).run(year, nextNumber);
    }

    insertNormalizedOrderRow(database, schema, orderId, norm, { actor, role, recordAuditLog });

    database.exec('COMMIT');
    return { orderId };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    if (error?.errcode === 1555 || error?.errcode === 2067) {
      throw setStatus(new Error('Generated Order Reference already exists; retry the save.'), 409);
    }
    throw error;
  }
}

export function createPendingOrderBatch(database, payload, {
  year = new Date().getFullYear(),
  actor = 'System Operator',
  role = 'SUPER_USER',
  recordAuditLog
} = {}) {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length === 0) {
    throw setStatus(new Error('Select at least one article to create an order.'), 400);
  }

  const mergeSharedDefaults = (item) => ({
    ...item,
    customerId: item?.customerId ?? item?.customer_id ?? payload?.customerId ?? payload?.customer_id,
    buyer: item?.buyer ?? payload?.buyer,
    po: item?.po ?? payload?.po,
    dueDate: item?.dueDate || item?.due_date || payload?.dueDate || payload?.due_date || '',
    maker: (Array.isArray(item?.allocations) && item.allocations.length > 0)
      ? item.maker
      : (String(item?.maker || '').trim() || String(payload?.maker || '').trim())
  });

  if (items.length === 1) {
    const { orderId } = createPendingOrder(database, mergeSharedDefaults(items[0]), { year, actor, role, recordAuditLog });
    return { baseOrderId: orderId, orderId, orderIds: [orderId] };
  }

  if (!Number.isInteger(year) || year < 1) {
    throw new Error('A valid order year is required');
  }
  if (typeof recordAuditLog !== 'function') {
    throw new Error('Order creation requires an audit logger');
  }

  const schema = getOrderSchemaSupport(database);
  const normalizedItems = items.map((rawItem, idx) => {
    try {
      return normalizePendingOrderPayload(database, schema, mergeSharedDefaults(rawItem));
    } catch (err) {
      const prefix = rawItem?.article ? `Sub-order ${idx + 1} (${rawItem.article})` : `Sub-order ${idx + 1}`;
      throw setStatus(new Error(`${prefix}: ${err.message}`), err.statusCode || 400);
    }
  });

  database.exec('BEGIN IMMEDIATE');
  try {
    const sequence = database.prepare(`SELECT last_n FROM order_seq WHERE year = ?`).get(year);
    const nextNumber = Number(sequence?.last_n || 0) + 1;
    const baseOrderId = `ORD-${year}-${String(nextNumber).padStart(3, '0')}`;
    if (sequence) {
      database.prepare(`UPDATE order_seq SET last_n = ? WHERE year = ?`).run(nextNumber, year);
    } else {
      database.prepare(`INSERT INTO order_seq (year, last_n) VALUES (?, ?)`).run(year, nextNumber);
    }

    const orderIds = [];
    for (let i = 0; i < normalizedItems.length; i += 1) {
      const subOrderId = `${baseOrderId}-${i + 1}`;
      insertNormalizedOrderRow(database, schema, subOrderId, normalizedItems[i], {
        actor,
        role,
        recordAuditLog,
        parentOrderId: baseOrderId
      });
      orderIds.push(subOrderId);
    }

    database.exec('COMMIT');
    return { baseOrderId, orderId: orderIds[0], orderIds };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    if (error?.errcode === 1555 || error?.errcode === 2067) {
      throw setStatus(new Error('Generated Order Reference already exists; retry the save.'), 409);
    }
    throw error;
  }
}

export function updatePendingOrder(database, orderId, payload, {
  actor = 'System Operator',
  role = 'SUPER_USER',
  recordAuditLog
} = {}) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) throw setStatus(new Error('orderId is required'), 400);
  if (typeof recordAuditLog !== 'function') {
    throw new Error('Order update requires an audit logger');
  }

  const schema = getOrderSchemaSupport(database);
  const hasDeletedAt = database.prepare(`PRAGMA table_info(pending_orders)`).all().some(c => c.name === 'deleted_at');
  const existingTables = new Set(
    database.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(r => r.name)
  );

  database.exec('BEGIN IMMEDIATE');
  try {
    const existing = database.prepare(
      `SELECT * FROM pending_orders WHERE order_id = ?${hasDeletedAt ? ' AND deleted_at IS NULL' : ''}`
    ).get(normalizedOrderId);
    if (!existing) {
      throw setStatus(new Error(`Pending Order ${normalizedOrderId} not found`), 404);
    }

    const mergedPayload = {
      ...(payload || {}),
      customerId: schema.hasIdsCol ? (existing.customer_id || '') : (payload?.customerId || ''),
      productId: schema.hasIdsCol ? (existing.product_id || '') : (payload?.productId || ''),
      buyer: existing.buyer_name || '',
      article: existing.article_name || '',
      sizeFormat: schema.hasSizeFormatCol ? (existing.size_format || 'LEGACY_7_11') : 'LEGACY_7_11',
      po: payload?.po !== undefined ? payload.po : (existing.po_number || ''),
      color: payload?.color !== undefined ? payload.color : (existing.color_shade || 'Standard'),
      dueDate: payload?.dueDate !== undefined ? payload.dueDate : (payload?.due_date !== undefined ? payload.due_date : (existing.due_date || '')),
      notes: payload?.notes !== undefined ? payload.notes : (existing.notes || ''),
      maker: payload?.maker !== undefined ? payload.maker : (existing.maker_contractor || '')
    };

    const norm = normalizePendingOrderPayload(database, schema, mergedPayload);
    if (norm.totalQty <= 0) {
      throw setStatus(new Error('Order total quantity must be greater than 0.'), 400);
    }

    // Guardrail 1: Total received & requested floors
    if (existingTables.has('store_receivings')) {
      const totalRcvd = Number(
        database.prepare(`
          SELECT COALESCE(SUM(rcvd_pairs), 0) AS total_rcvd
          FROM store_receivings
          WHERE order_id = ? AND COALESCE(is_voided, 0) = 0
        `).get(normalizedOrderId)?.total_rcvd || 0
      );
      if (norm.totalQty < totalRcvd) {
        throw setStatus(
          new Error(`Cannot reduce order total to ${norm.totalQty} pairs; ${totalRcvd} pairs have already been received.`),
          400
        );
      }
    }

    if (existingTables.has('glove_requisitions')) {
      const totalReq = Number(
        database.prepare(`
          SELECT COALESCE(SUM(requested_pairs), 0) AS total_req
          FROM glove_requisitions
          WHERE order_id = ? AND COALESCE(is_voided, 0) = 0
        `).get(normalizedOrderId)?.total_req || 0
      );
      if (norm.totalQty < totalReq) {
        throw setStatus(
          new Error(`Cannot reduce order total to ${norm.totalQty} pairs; ${totalReq} pairs have already been requested by Packing Hall.`),
          400
        );
      }
    }

    // Guardrail 2: Per-size received floor
    if (existingTables.has('receiving_size_breakdowns') && existingTables.has('store_receivings')) {
      const rcvdBySize = database.prepare(`
        SELECT rsb.size_code, COALESCE(SUM(rsb.rcvd_pairs), 0) AS rcvd
        FROM receiving_size_breakdowns rsb
        JOIN store_receivings sr ON sr.rcv_number = rsb.rcv_number
        WHERE sr.order_id = ? AND COALESCE(sr.is_voided, 0) = 0
        GROUP BY rsb.size_code
      `).all(normalizedOrderId);

      const newSizesMap = norm.sizeFormat === 'LEGACY_7_11'
        ? { '7': norm.size7, '8': norm.size8, '9': norm.size9, '10': norm.size10, '11': norm.size11 }
        : JSON.parse(norm.orderSizesJson || '{}');

      for (const row of rcvdBySize) {
        const rcvd = Number(row.rcvd || 0);
        if (rcvd <= 0) continue;
        const nextSz = Number(newSizesMap[row.size_code] || 0);
        if (nextSz < rcvd) {
          throw setStatus(
            new Error(`Cannot reduce size ${row.size_code} to ${nextSz}; ${rcvd} pairs have already been received.`),
            400
          );
        }
      }
    }

    // Guardrail 3: Per-contractor received floor
    if (schema.hasAllocTable && existingTables.has('store_receivings')) {
      const rcvdByMaker = database.prepare(`
        SELECT maker_contractor, COALESCE(SUM(rcvd_pairs), 0) AS rcvd
        FROM store_receivings
        WHERE order_id = ? AND COALESCE(is_voided, 0) = 0
        GROUP BY LOWER(TRIM(maker_contractor))
      `).all(normalizedOrderId);

      for (const row of rcvdByMaker) {
        const rcvd = Number(row.rcvd || 0);
        if (rcvd <= 0) continue;
        const makerKey = String(row.maker_contractor || '').trim().toLowerCase();
        const matched = norm.normalizedAllocations.find(
          a => String(a.maker || '').trim().toLowerCase() === makerKey
        );
        if (!matched) {
          throw setStatus(
            new Error(`Cannot remove contractor "${row.maker_contractor}" because ${rcvd} pairs have already been received from them.`),
            400
          );
        }
        if (matched.total < rcvd) {
          throw setStatus(
            new Error(`Cannot reduce allocation for "${row.maker_contractor}" to ${matched.total}; ${rcvd} pairs have already been received from them.`),
            400
          );
        }
      }

      // Guardrail 4: Per-contractor per-size received floor
      if (existingTables.has('receiving_size_breakdowns')) {
        const rcvdByMakerSize = database.prepare(`
          SELECT sr.maker_contractor, rsb.size_code, COALESCE(SUM(rsb.rcvd_pairs), 0) AS rcvd
          FROM receiving_size_breakdowns rsb
          JOIN store_receivings sr ON sr.rcv_number = rsb.rcv_number
          WHERE sr.order_id = ? AND COALESCE(sr.is_voided, 0) = 0
          GROUP BY LOWER(TRIM(sr.maker_contractor)), rsb.size_code
        `).all(normalizedOrderId);

        for (const row of rcvdByMakerSize) {
          const rcvd = Number(row.rcvd || 0);
          if (rcvd <= 0) continue;
          const makerKey = String(row.maker_contractor || '').trim().toLowerCase();
          const matched = norm.normalizedAllocations.find(
            a => String(a.maker || '').trim().toLowerCase() === makerKey
          );
          if (!matched) continue; // Already caught by Guardrail 3 above
          const allocSizesMap = matched.sizesMap
            || (norm.sizeFormat === 'LEGACY_7_11'
              ? { '7': matched.s7, '8': matched.s8, '9': matched.s9, '10': matched.s10, '11': matched.s11 }
              : JSON.parse(matched.sizesJson || '{}'));
          const nextSz = Number(allocSizesMap[row.size_code] || 0);
          if (nextSz < rcvd) {
            throw setStatus(
              new Error(`Cannot reduce size ${row.size_code} for "${row.maker_contractor}" to ${nextSz}; ${rcvd} pairs have already been received from them.`),
              400
            );
          }
        }
      }
    }

    // Persist updated order row
    if (schema.hasSizeFormatCol && schema.hasDueDateCol) {
      database.prepare(`
        UPDATE pending_orders
        SET maker_contractor = ?, po_number = ?, color_shade = ?,
            sizes_json = ?, size_7 = ?, size_8 = ?, size_9 = ?, size_10 = ?, size_11 = ?,
            total_qty = ?, due_date = ?, notes = ?
        WHERE order_id = ?
      `).run(
        norm.maker,
        norm.po,
        norm.color,
        norm.orderSizesJson,
        norm.size7,
        norm.size8,
        norm.size9,
        norm.size10,
        norm.size11,
        norm.totalQty,
        norm.dueDate,
        norm.notes,
        normalizedOrderId
      );
    } else if (schema.hasDueDateCol) {
      database.prepare(`
        UPDATE pending_orders
        SET maker_contractor = ?, po_number = ?, color_shade = ?,
            size_7 = ?, size_8 = ?, size_9 = ?, size_10 = ?, size_11 = ?,
            total_qty = ?, due_date = ?, notes = ?
        WHERE order_id = ?
      `).run(
        norm.maker,
        norm.po,
        norm.color,
        norm.size7,
        norm.size8,
        norm.size9,
        norm.size10,
        norm.size11,
        norm.totalQty,
        norm.dueDate,
        norm.notes,
        normalizedOrderId
      );
    } else {
      database.prepare(`
        UPDATE pending_orders
        SET maker_contractor = ?, po_number = ?, color_shade = ?,
            size_7 = ?, size_8 = ?, size_9 = ?, size_10 = ?, size_11 = ?,
            total_qty = ?, notes = ?
        WHERE order_id = ?
      `).run(
        norm.maker,
        norm.po,
        norm.color,
        norm.size7,
        norm.size8,
        norm.size9,
        norm.size10,
        norm.size11,
        norm.totalQty,
        norm.notes,
        normalizedOrderId
      );
    }

    // Replace contractor allocations
    if (schema.hasAllocTable) {
      database.prepare(`DELETE FROM order_contractor_allocations WHERE order_id = ?`).run(normalizedOrderId);
      if (schema.hasAllocSizeFormatCol) {
        const insertAlloc = database.prepare(`
          INSERT INTO order_contractor_allocations (
            order_id, maker_contractor, size_format, sizes_json,
            size_7, size_8, size_9, size_10, size_11, total_qty, due_date
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const a of norm.normalizedAllocations) {
          insertAlloc.run(
            normalizedOrderId,
            a.maker,
            norm.sizeFormat,
            a.sizesJson,
            a.s7,
            a.s8,
            a.s9,
            a.s10,
            a.s11,
            a.total,
            a.dueDate
          );
        }
      } else {
        const insertAlloc = database.prepare(`
          INSERT INTO order_contractor_allocations (
            order_id, maker_contractor, size_7, size_8, size_9, size_10, size_11, total_qty, due_date
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const a of norm.normalizedAllocations) {
          insertAlloc.run(normalizedOrderId, a.maker, a.s7, a.s8, a.s9, a.s10, a.s11, a.total, a.dueDate);
        }
      }
    }

    // Recalculate cumulative GRN balance_qty and status
    if (existingTables.has('store_receivings')) {
      const rcvRows = database.prepare(`
        SELECT id, rcvd_pairs
        FROM store_receivings
        WHERE order_id = ? AND COALESCE(is_voided, 0) = 0
        ORDER BY id ASC
      `).all(normalizedOrderId);
      let cum = 0;
      const updateGrnBal = database.prepare(
        `UPDATE store_receivings SET order_qty = ?, balance_qty = ?, status = ? WHERE id = ?`
      );
      for (const r of rcvRows) {
        cum += Number(r.rcvd_pairs || 0);
        const bal = Math.max(0, norm.totalQty - cum);
        const st = bal === 0 ? 'COMPLETE' : 'PARTIAL';
        updateGrnBal.run(norm.totalQty, bal, st, r.id);
      }
    }

    recordAuditLog({
      actor,
      role,
      action: 'ORDER_ADJUST',
      entityId: normalizedOrderId,
      orderId: normalizedOrderId,
      beforeSummary: `${existing.total_qty} Prs · ${existing.maker_contractor} · Due ${existing.due_date || 'none'}`,
      afterSummary: `${norm.totalQty} Prs · ${norm.maker} · Due ${norm.dueDate || 'none'}`,
      reason: String(payload?.reason || '').trim()
    });

    database.exec('COMMIT');
    return { orderId: normalizedOrderId };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}

export function deletePendingOrder(database, orderId, {
  actor = 'System Operator',
  role = 'SUPER_USER',
  recordAuditLog
} = {}) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) throw new Error('orderId is required');
  if (typeof recordAuditLog !== 'function') {
    throw new Error('Order deletion requires an audit logger');
  }

  const schema = getOrderSchemaSupport(database);

  database.exec('BEGIN IMMEDIATE');
  try {
    const hasDeletedAt = database.prepare(`PRAGMA table_info(pending_orders)`).all().some(c => c.name === 'deleted_at');
    const order = database.prepare(
      `SELECT * FROM pending_orders WHERE order_id = ?${hasDeletedAt ? ' AND deleted_at IS NULL' : ''}`
    ).get(normalizedOrderId);
    if (!order) throw setStatus(new Error(`Pending Order ${normalizedOrderId} not found`), 404);

    const linkedReceiving = database.prepare(`
      SELECT 1 FROM store_receivings WHERE order_id = ? LIMIT 1
    `).get(normalizedOrderId);
    const linkedAllocation = database.prepare(`
      SELECT 1 FROM grn_req_allocations WHERE order_id = ? LIMIT 1
    `).get(normalizedOrderId);
    const linkedRequisition = database.prepare(`
      SELECT 1 FROM glove_requisitions WHERE order_id = ? LIMIT 1
    `).get(normalizedOrderId);
    if (linkedReceiving || linkedAllocation || linkedRequisition) {
      throw new Error(`Cannot delete Order ${normalizedOrderId}: linked production records exist.`);
    }

    if (schema.hasAllocTable) {
      database.prepare(`DELETE FROM order_contractor_allocations WHERE order_id = ?`).run(normalizedOrderId);
    }
    database.prepare(`DELETE FROM pending_orders WHERE order_id = ?`).run(normalizedOrderId);
    recordAuditLog({
      actor,
      role,
      action: 'ORDER_DELETE',
      entityId: normalizedOrderId,
      orderId: normalizedOrderId,
      beforeSummary: `Order ${normalizedOrderId} (${order.total_qty} Prs)`,
      afterSummary: 'Deleted before production activity'
    });

    database.exec('COMMIT');
    return { deleted: true, orderId: normalizedOrderId };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}

export function assignRemainingOrderAllocations(database, orderId, payload, {
  actor = 'System Operator',
  role = 'SUPER_USER',
  recordAuditLog
} = {}) {
  const normalizedOrderId = String(orderId || '').trim();
  if (!normalizedOrderId) throw setStatus(new Error('orderId is required'), 400);
  if (typeof recordAuditLog !== 'function') {
    throw new Error('Order allocation update requires an audit logger');
  }

  const schema = getOrderSchemaSupport(database);
  const hasDeletedAt = database.prepare(`PRAGMA table_info(pending_orders)`).all().some(c => c.name === 'deleted_at');

  database.exec('BEGIN IMMEDIATE');
  try {
    const order = database.prepare(
      `SELECT * FROM pending_orders WHERE order_id = ?${hasDeletedAt ? ' AND deleted_at IS NULL' : ''}`
    ).get(normalizedOrderId);
    if (!order) throw setStatus(new Error(`Pending Order ${normalizedOrderId} not found`), 404);
    if (!schema.hasAllocTable) {
      throw setStatus(new Error('Contractor allocations table is unavailable.'), 500);
    }

    const { sizeFormat, scaleCodes } = resolveScaleCodes(database, schema, {
      requestedFormat: schema.hasSizeFormatCol ? order.size_format : 'LEGACY_7_11',
      productId: schema.hasIdsCol ? order.product_id : ''
    });
    const isLegacy = sizeFormat === 'LEGACY_7_11';
    const parsedOrderJson = isLegacy ? {} : JSON.parse(order.sizes_json || '{}');
    const plannedSizes = isLegacy
      ? {
          '7': Number(order.size_7 || 0),
          '8': Number(order.size_8 || 0),
          '9': Number(order.size_9 || 0),
          '10': Number(order.size_10 || 0),
          '11': Number(order.size_11 || 0)
        }
      : Object.fromEntries(scaleCodes.map(c => [c, Number(parsedOrderJson[c] || 0)]));

    const existingRows = database.prepare(
      `SELECT * FROM order_contractor_allocations WHERE order_id = ? ORDER BY id ASC`
    ).all(normalizedOrderId);

    const existingBySize = Object.fromEntries(scaleCodes.map(c => [c, 0]));
    let existingAssignedTotal = 0;
    const rowByMakerKey = new Map();

    if (existingRows.length === 0) {
      for (const c of scaleCodes) {
        const v = Number(plannedSizes[c] || 0);
        existingBySize[c] = v;
        existingAssignedTotal += v;
      }
    } else {
      for (const r of existingRows) {
        const rFmt = String(r.size_format || sizeFormat || 'LEGACY_7_11').trim();
        const rJson = rFmt === 'LEGACY_7_11' ? {} : JSON.parse(r.sizes_json || '{}');
        const rSizes = rFmt === 'LEGACY_7_11'
          ? {
              '7': Number(r.size_7 || 0),
              '8': Number(r.size_8 || 0),
              '9': Number(r.size_9 || 0),
              '10': Number(r.size_10 || 0),
              '11': Number(r.size_11 || 0)
            }
          : Object.fromEntries(scaleCodes.map(c => [c, Number(rJson[c] || 0)]));
        for (const c of scaleCodes) {
          existingBySize[c] += Number(rSizes[c] || 0);
        }
        existingAssignedTotal += Number(r.total_qty || 0);
        const mk = String(r.maker_contractor || '').trim().toLowerCase();
        if (mk) rowByMakerKey.set(mk, { row: r, sizes: rSizes });
      }
    }

    const unassignedBySize = Object.fromEntries(
      scaleCodes.map(c => [c, Math.max(0, Number(plannedSizes[c] || 0) - Number(existingBySize[c] || 0))])
    );
    const totalUnassigned = scaleCodes.reduce((s, c) => s + unassignedBySize[c], 0);
    if (totalUnassigned <= 0) {
      throw setStatus(new Error(`Order ${normalizedOrderId} has no unassigned pairs remaining.`), 400);
    }

    const rawAllocs = Array.isArray(payload?.allocations) ? payload.allocations : [];
    const candidateRows = rawAllocs.filter(a => {
      const m = String(a?.maker || a?.makerContractor || '').trim();
      const anyPairs = scaleCodes.some(c => Number(a?.sizes?.[c] || 0) > 0);
      return Boolean(m) || anyPairs;
    });
    if (candidateRows.length === 0) {
      throw setStatus(new Error('Add at least one contractor allocation row.'), 400);
    }

    const seenBatchMakers = new Set();
    const incomingSumBySize = Object.fromEntries(scaleCodes.map(c => [c, 0]));
    const parsedBatch = [];
    let newlyAssignedPairs = 0;

    for (const raw of candidateRows) {
      const makerName = String(raw?.maker || raw?.makerContractor || '').trim();
      if (!makerName) {
        throw setStatus(new Error('Select a Contractor / Maker on every row.'), 400);
      }
      const mk = makerName.toLowerCase();
      if (seenBatchMakers.has(mk)) {
        throw setStatus(new Error(`Duplicate contractor "${makerName}" in assignment rows.`), 400);
      }
      seenBatchMakers.add(mk);

      const parsedRow = parseScaleSizes(raw?.sizes || {}, scaleCodes, `Contractor "${makerName}"`);
      if (parsedRow.sum <= 0) {
        throw setStatus(new Error(`Contractor "${makerName}" must be assigned at least 1 pair.`), 400);
      }
      for (const c of scaleCodes) {
        incomingSumBySize[c] += parsedRow.normalized[c];
      }
      newlyAssignedPairs += parsedRow.sum;
      parsedBatch.push({
        maker: makerName,
        makerKey: mk,
        sizes: parsedRow.normalized,
        sum: parsedRow.sum,
        dueDate: String(raw?.dueDate || raw?.due_date || order.due_date || '').trim()
      });
    }

    for (const c of scaleCodes) {
      if (incomingSumBySize[c] > unassignedBySize[c]) {
        throw setStatus(
          new Error(`Size ${c} assignment (${incomingSumBySize[c]}) exceeds unassigned balance (${unassignedBySize[c]} pairs).`),
          400
        );
      }
    }

    for (const item of parsedBatch) {
      const existingEntry = rowByMakerKey.get(item.makerKey);
      if (existingEntry) {
        const mergedSizes = {};
        let mergedTotal = 0;
        for (const c of scaleCodes) {
          mergedSizes[c] = Number(existingEntry.sizes[c] || 0) + Number(item.sizes[c] || 0);
          mergedTotal += mergedSizes[c];
        }
        const mergedJson = isLegacy ? '{}' : JSON.stringify(mergedSizes);
        const nextDue = item.dueDate || existingEntry.row.due_date || order.due_date || '';
        if (schema.hasAllocSizeFormatCol) {
          database.prepare(`
            UPDATE order_contractor_allocations
            SET size_format = ?, sizes_json = ?, size_7 = ?, size_8 = ?, size_9 = ?, size_10 = ?, size_11 = ?, total_qty = ?, due_date = ?
            WHERE id = ?
          `).run(
            sizeFormat,
            mergedJson,
            isLegacy ? Number(mergedSizes['7'] || 0) : 0,
            isLegacy ? Number(mergedSizes['8'] || 0) : 0,
            isLegacy ? Number(mergedSizes['9'] || 0) : 0,
            isLegacy ? Number(mergedSizes['10'] || 0) : 0,
            isLegacy ? Number(mergedSizes['11'] || 0) : 0,
            mergedTotal,
            nextDue,
            existingEntry.row.id
          );
        } else {
          database.prepare(`
            UPDATE order_contractor_allocations
            SET size_7 = ?, size_8 = ?, size_9 = ?, size_10 = ?, size_11 = ?, total_qty = ?, due_date = ?
            WHERE id = ?
          `).run(
            Number(mergedSizes['7'] || 0),
            Number(mergedSizes['8'] || 0),
            Number(mergedSizes['9'] || 0),
            Number(mergedSizes['10'] || 0),
            Number(mergedSizes['11'] || 0),
            mergedTotal,
            nextDue,
            existingEntry.row.id
          );
        }
      } else {
        const allocJson = isLegacy ? '{}' : JSON.stringify(item.sizes);
        if (schema.hasAllocSizeFormatCol) {
          database.prepare(`
            INSERT INTO order_contractor_allocations (
              order_id, maker_contractor, size_format, sizes_json, size_7, size_8, size_9, size_10, size_11, total_qty, due_date
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            normalizedOrderId,
            item.maker,
            sizeFormat,
            allocJson,
            isLegacy ? Number(item.sizes['7'] || 0) : 0,
            isLegacy ? Number(item.sizes['8'] || 0) : 0,
            isLegacy ? Number(item.sizes['9'] || 0) : 0,
            isLegacy ? Number(item.sizes['10'] || 0) : 0,
            isLegacy ? Number(item.sizes['11'] || 0) : 0,
            item.sum,
            item.dueDate
          );
        } else {
          database.prepare(`
            INSERT INTO order_contractor_allocations (
              order_id, maker_contractor, size_7, size_8, size_9, size_10, size_11, total_qty, due_date
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            normalizedOrderId,
            item.maker,
            Number(item.sizes['7'] || 0),
            Number(item.sizes['8'] || 0),
            Number(item.sizes['9'] || 0),
            Number(item.sizes['10'] || 0),
            Number(item.sizes['11'] || 0),
            item.sum,
            item.dueDate
          );
        }
      }
    }

    const updatedAllocs = database.prepare(
      `SELECT maker_contractor, due_date FROM order_contractor_allocations WHERE order_id = ? ORDER BY id ASC`
    ).all(normalizedOrderId);
    const updatedMakers = updatedAllocs.map(r => String(r.maker_contractor || '').trim()).filter(Boolean).join(', ');
    const latestAllocDue = updatedAllocs.map(r => String(r.due_date || '').trim()).filter(Boolean).sort().pop() || '';
    const nextOrderDue = String(order.due_date || '').trim() || latestAllocDue;

    if (schema.hasDueDateCol) {
      database.prepare(`UPDATE pending_orders SET maker_contractor = ?, due_date = ? WHERE order_id = ?`).run(
        updatedMakers || order.maker_contractor,
        nextOrderDue,
        normalizedOrderId
      );
    } else {
      database.prepare(`UPDATE pending_orders SET maker_contractor = ? WHERE order_id = ?`).run(
        updatedMakers || order.maker_contractor,
        normalizedOrderId
      );
    }

    const remainingUnassignedPairs = Math.max(0, totalUnassigned - newlyAssignedPairs);
    const batchSummary = parsedBatch.map(b => `${b.maker} (${b.sum})`).join(', ');
    recordAuditLog({
      actor,
      role,
      action: 'ORDER_ASSIGN_REMAINING',
      entityId: normalizedOrderId,
      orderId: normalizedOrderId,
      beforeSummary: `${existingAssignedTotal} Prs assigned (${totalUnassigned} unassigned)`,
      afterSummary: `+${newlyAssignedPairs} Prs [${batchSummary}] · ${remainingUnassignedPairs} unassigned`,
      reason: String(payload?.reason || '').trim()
    });

    database.exec('COMMIT');
    return { orderId: normalizedOrderId, newlyAssignedPairs, remainingUnassignedPairs };
  } catch (error) {
    try {
      database.exec('ROLLBACK');
    } catch {
      // Preserve the original transaction error.
    }
    throw error;
  }
}
