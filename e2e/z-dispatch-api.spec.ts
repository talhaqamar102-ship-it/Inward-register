import { test, expect, request as playwrightRequest, APIRequestContext } from '@playwright/test';

const TEST_ADMIN = {
  name: 'E2E Super User',
  username: 'e2e.admin',
  password: 'Mes-E2E-Password-2026!'
};

async function authAsAdmin(api: APIRequestContext): Promise<void> {
  const statusRes = await api.get('/api/auth/status');
  expect(statusRes.ok()).toBe(true);
  const statusJson = await statusRes.json();
  if (statusJson.data?.user?.role === 'SUPER_USER') return;

  const endpoint = statusJson.data?.initialized ? '/api/auth/login' : '/api/auth/bootstrap';
  const authRes = await api.post(endpoint, { data: TEST_ADMIN });
  expect(authRes.ok()).toBe(true);
}

async function seedBoxedReq(
  api: APIRequestContext,
  tag: string,
  pairsToBox: number,
  pairsPerCarton = 30
): Promise<{ orderId: string; reqNo: string; cartons: number }> {
  const postOk = async (url: string, data: Record<string, unknown>) => {
    const res = await api.post(url, { data });
    const json = await res.json();
    expect(res.ok(), `${url} failed (${res.status()}): ${json.error || ''}`).toBe(true);
    return json.data;
  };

  const sizes = { '7': 20, '8': 20, '9': 20, '10': 20, '11': 20 };
  const order = await postOk('/api/admin/pending-orders', {
    buyer: `API Dispatch Buyer ${tag}`,
    maker: 'Raja',
    poNumber: `PO-API-${tag}`,
    article: `API-ART-${tag}`,
    color: 'Black',
    sizeFormat: 'LEGACY_7_11',
    sizes
  });
  const orderId = order.order_id || order.orderId;

  await postOk('/api/store/receivings', {
    orderId,
    makerContractor: 'Raja',
    receivedFrom: 'Raja',
    customerName: `API Dispatch Buyer ${tag}`,
    poNumber: `PO-API-${tag}`,
    articleName: `API-ART-${tag}`,
    colorShade: 'Black',
    rcvdPairs: 100,
    sizes,
    remarks: `API seed ${tag}`
  });

  const req = await postOk(`/api/orders/${encodeURIComponent(orderId)}/requisitions`, { sizes });
  const reqNo = req.req_number;

  await postOk(`/api/orders/${encodeURIComponent(orderId)}/issue-req`, { reqNumber: reqNo, requestedPairs: 100 });
  await postOk(`/api/wip/${encodeURIComponent(reqNo)}/step1-checking`, { goodPairs: 100, defectPairs: 0 });
  await postOk(`/api/wip/${encodeURIComponent(reqNo)}/step2-ironing`, { goodPairs: 100, defectPairs: 0 });
  await postOk(`/api/wip/${encodeURIComponent(reqNo)}/step3-matching`, { goodPairs: 100, defectPairs: 0 });
  const matReq = await postOk(`/api/wip/${encodeURIComponent(reqNo)}/material-requisition`, {});
  await postOk(`/api/material-requisitions/${encodeURIComponent(matReq.mat_req_number)}/issue`, {});
  await postOk(`/api/wip/${encodeURIComponent(reqNo)}/step4-packing`, { packedPairs: 100 });
  await postOk(`/api/qc/${encodeURIComponent(reqNo)}/aql-audit`, {
    foundDefects: 0,
    inspectorId: '4402',
    inspectorName: 'Tariq Mehmood'
  });

  const boxed = await postOk(`/api/wip/${encodeURIComponent(reqNo)}/step5-cartons-gated`, {
    pairsPerCarton,
    pairsToPack: pairsToBox,
    dimensionsCm: '60x40x35',
    shippingMode: 'AIR',
    sealPrefix: `API-${tag}`
  });

  return { orderId, reqNo, cartons: boxed.cartons.length };
}

test.describe('Dispatch API server enforcement', () => {
  test('Release with unboxed pairs returns 409', async ({ request }) => {
    await authAsAdmin(request);
    const { reqNo } = await seedBoxedReq(request, 'PART409', 60, 30);

    const res = await request.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
      data: { release: true }
    });
    expect(res.status()).toBe(409);
  });

  test('airCartons: "abc" returns 400', async ({ request }) => {
    await authAsAdmin(request);
    const { reqNo } = await seedBoxedReq(request, 'NAN400', 100, 50);

    const res = await request.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
      data: { airCartons: 'abc', seaCartons: 0 }
    });
    expect(res.status()).toBe(400);
  });

  test('Release as PACKING_SUPERVISOR returns 403', async ({ request }, testInfo) => {
    await authAsAdmin(request);
    const { reqNo } = await seedBoxedReq(request, 'RBAC403', 100, 50);

    const supUser = {
      name: 'API Packing Supervisor',
      username: `pack.sup.${Date.now()}`,
      password: 'Sup-Password-2026!',
      role: 'PACKING_SUPERVISOR',
      station: 'Packing Hall #1'
    };
    const createRes = await request.post('/api/admin/users', { data: supUser });
    expect(createRes.ok()).toBe(true);

    const supContext = await playwrightRequest.newContext({ baseURL: testInfo.project.use.baseURL });
    try {
      const loginRes = await supContext.post('/api/auth/login', {
        data: { username: supUser.username, password: supUser.password }
      });
      expect(loginRes.ok()).toBe(true);

      const relRes = await supContext.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
        data: { release: true }
      });
      expect(relRes.status()).toBe(403);
    } finally {
      await supContext.dispose();
    }
  });

  test('Stale manifest returns 409 and a second release returns 409', async ({ request }) => {
    await authAsAdmin(request);
    const { reqNo, cartons } = await seedBoxedReq(request, 'REL409', 100, 50);

    const staleRes = await request.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
      data: { release: true, expectedCartons: cartons + 1, expectedPairs: 100 }
    });
    expect(staleRes.status()).toBe(409);

    const firstRes = await request.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
      data: { release: true, expectedCartons: cartons, expectedPairs: 100 }
    });
    expect(firstRes.status()).toBe(200);

    const auditRes = await request.get('/api/admin/audit-trail?limit=25');
    expect(auditRes.ok()).toBe(true);
    const auditJson = await auditRes.json();
    const releaseAudit = (auditJson.data || []).filter(
      (entry: any) => entry.action === 'DISPATCH_RELEASE' && entry.entity_id === reqNo
    );
    expect(releaseAudit).toHaveLength(1);

    const secondRes = await request.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
      data: { release: true }
    });
    expect(secondRes.status()).toBe(409);
  });

  test('Reassigning cartons after dispatch returns 409', async ({ request }) => {
    await authAsAdmin(request);
    const { reqNo, cartons } = await seedBoxedReq(request, 'LOCK409', 100, 50);

    const relRes = await request.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
      data: { release: true, expectedCartons: cartons, expectedPairs: 100 }
    });
    expect(relRes.status()).toBe(200);

    const allotRes = await request.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
      data: { airCartons: 1, seaCartons: 1 }
    });
    expect(allotRes.status()).toBe(409);

    const bulkRes = await request.post(`/api/wip/${encodeURIComponent(reqNo)}/dispatch`, {
      data: { shippingMode: 'SEA' }
    });
    expect(bulkRes.status()).toBe(409);
  });
});
