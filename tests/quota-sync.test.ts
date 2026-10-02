import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep, basename } from 'node:path';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { createService } from '../server/app.js';
import { CloudQuotaSync, fetchCloudQuota, QUOTA_URL, QUOTA_INTERVAL, QUOTA_RESOURCES } from '../server/quota-sync.js';
import { speechOpenApiHeaders } from '../server/openapi.js';

const keys = { accessKeyId: 'quota-mock-ak', secretAccessKey: 'quota-mock-sk' };
const pack = (id = 'gift-package', resource = QUOTA_RESOURCES.standard as string, purchased = 20000, used = 4229) => ({
  TrainID: id, InstanceNumber: '', ResourceID: resource, PackType: 'prepaid', RawType: 'text_words', State: 'active', Expires: '-',
  PurchasedAmount: '显示文案不参与计算', CurrentUsage: '显示文案不参与计算',
  Harvest: { ResourceID: resource, CropType: 'text_words', Unit: '字数', PurchasedAmount: purchased, CurrentUsage: used },
});
const page = (Packs: unknown[], TotalCount = Packs.length, PageNumber?: number) => Response.json({ Result: { Packs, TotalCount, PageNumber,
  // A summary is repeated on every page; only individual package harvests count.
  TotalHarvests: [{ PurchasedAmount: 99999999, CurrentUsage: 0, Unit: '字数' }] } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dmreader-quota-')), store = new Store(dir);
  store.saveOpenApiCredentials(keys);
  return { dir, store, cleanup() {
    store.close(); const full = resolve(dir);
    assert.ok(full.startsWith(resolve(tmpdir()) + sep) && basename(full).startsWith('dmreader-quota-'));
    rmSync(full, { recursive: true, force: true });
  } };
}

test('quota query signs the official read action and paginates billing resource IDs, not synthesis IDs', async () => {
  let calls = 0;
  const result = await fetchCloudQuota(keys, 'default', async (url, init) => {
    assert.equal(url, 'https://open.volcengineapi.com/?Action=ResourcePacksStatus&Version=2025-05-20');
    assert.equal(url, QUOTA_URL); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)); calls++;
    assert.deepEqual(body, { ProjectName: 'default', ResourceIDs: ['volc.seedtts.default', 'volc.seedicl.default'], Types: ['prepaid'], PageNumber: calls, PageSize: 100 });
    const headers = init?.headers as Record<string, string>;
    assert.match(headers.Authorization, /cn-beijing\/speech_saas_prod\/request/);
    assert.ok(!JSON.stringify(headers).includes(keys.secretAccessKey));
    return calls === 1 ? page([pack()], 2, 1) : page([pack('clone', QUOTA_RESOURCES.custom, 20000, 0)], 2, 2);
  });
  assert.equal(calls, 2); assert.equal(result.length, 2);
  assert.deepEqual(result.map(p => [p.resource, p.purchased, p.used]), [['standard', 20000, 4229], ['custom', 20000, 0]]);
  assert.ok(!JSON.stringify(result).includes('gift-package'));
  const body = '{}', now = new Date('2026-10-01T01:02:03Z');
  assert.notEqual(speechOpenApiHeaders('ResourcePacksStatus', body, keys, now).Authorization, speechOpenApiHeaders('ListSpeakers', body, keys, now).Authorization);
});

test('only active, unexpired character packages count; unknown and verified empty balances differ', async () => {
  const f = fixture(); let now = Date.parse('2026-10-02T00:00:00Z');
  const sync = new CloudQuotaSync(f.store, async () => page([
    pack(), pack('clone', QUOTA_RESOURCES.custom, 20000, 0), pack('overrun', QUOTA_RESOURCES.standard, 10, 20),
    { ...pack('expired'), Expires: '2026-10-02 07:59:59' },
    { ...pack('expires-soon', QUOTA_RESOURCES.standard, 100, 20), Expires: '2026-10-02 08:00:01' },
    { ...pack('suspended'), State: 'suspended' },
    { ...pack('concurrency'), RawType: 'concurrency', Harvest: null },
    { ...pack('postpaid'), PackType: 'postpaid' }, pack('other-service', 'unrelated.resource'),
  ]), () => now);
  try {
    assert.equal(sync.status().standard, null);
    const settings = f.store.settings();
    await sync.sync();
    assert.deepEqual(sync.status().standard, { purchased: 20110, used: 4269, remaining: 15851, packCount: 3 });
    assert.equal(sync.status().custom?.remaining, 20000); assert.equal(sync.status().packs.length, 6);
    now += 1000; assert.equal(sync.status().standard?.remaining, 15771); // Expiry reevaluated without another request.
    assert.equal(sync.status().packs.find(p => p.expires !== '-' && p.purchased === 100)?.available, false);
    assert.deepEqual(f.store.settings(), settings); assert.equal(f.store.spent('seed-tts-2.0'), 0);
    const reopened = new Store(f.dir), persisted = new CloudQuotaSync(reopened, undefined, () => now);
    assert.equal(persisted.status().standard?.remaining, 15771); await persisted.close(); reopened.close();
    f.store.set('quotaProject', 'empty-project'); assert.equal(sync.status().standard, null);
    const empty = new CloudQuotaSync(f.store, async () => page([]), () => now);
    await empty.sync(); assert.deepEqual(empty.status().standard, { purchased: 0, used: 0, remaining: 0, packCount: 0 }); await empty.close();
  } finally { await sync.close(); f.cleanup(); }
});

test('quota query rejects malformed units, values, identity, expiration and inconsistent pagination', async () => {
  const valid = pack();
  for (const bad of [
    { ...valid, Harvest: undefined }, { ...valid, Harvest: { ...valid.Harvest, Unit: '次数' } },
    { ...valid, Harvest: { ...valid.Harvest, CurrentUsage: '4229' } }, { ...valid, Harvest: { ...valid.Harvest, CurrentUsage: -1 } },
    { ...valid, Harvest: { ...valid.Harvest, ResourceID: QUOTA_RESOURCES.custom } },
    { ...valid, TrainID: '', InstanceNumber: '' }, { ...valid, Expires: 'unknown date' },
  ]) await assert.rejects(fetchCloudQuota(keys, 'default', async () => page([bad])), /字段异常|单位异常|有效期字段/);
  await assert.rejects(fetchCloudQuota(keys, 'default', async () => page([], 1)), /不完整/);
  await assert.rejects(fetchCloudQuota(keys, 'default', async () => page([valid], 2)), /重复记录/);
  await assert.rejects(fetchCloudQuota(keys, 'default', async () => page([valid], 1, 2)), /分页结果发生变化/);
  let count = 0;
  await assert.rejects(fetchCloudQuota(keys, 'default', async () => page([pack(String(++count))], count === 1 ? 2 : 3)), /分页结果发生变化/);
});

test('automatic quota refresh respects five minute interval, failure backoff, settings and credential scope', async () => {
  const f = fixture(); let now = Date.parse('2026-10-02T00:00:00Z'), calls = 0, fail = false;
  const sync = new CloudQuotaSync(f.store, async () => {
    calls++;
    return fail ? Response.json({ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: keys.secretAccessKey } } }, { status: 403 }) : page([pack()]);
  }, () => now);
  try {
    f.store.set('quotaAutoSync', false); await sync.refreshIfDue(); assert.equal(calls, 0);
    f.store.set('quotaAutoSync', true); await sync.refreshIfDue(); assert.equal(calls, 1);
    assert.equal(sync.status().stale, false); await assert.rejects(sync.sync(), /等待 10 秒/);
    now += QUOTA_INTERVAL - 1; await sync.refreshIfDue(); assert.equal(calls, 1);
    now++; fail = true; await assert.rejects(sync.refreshIfDue(), /AccessDenied/); assert.equal(calls, 2);
    assert.equal(sync.status().standard?.remaining, 15771); assert.equal(sync.status().stale, true);
    assert.ok(!JSON.stringify(sync.status()).includes(keys.secretAccessKey));
    now += 59999; await sync.refreshIfDue(); assert.equal(calls, 2);
    now++; fail = false; await sync.refreshIfDue(); assert.equal(calls, 3); assert.equal(sync.status().error, '');
    f.store.saveOpenApiCredentials({ ...keys, secretAccessKey: 'another-account-key' });
    assert.equal(sync.status().standard, null); await sync.refreshIfDue(); assert.equal(calls, 4);
    f.store.saveOpenApiCredentials({ accessKeyId: '', secretAccessKey: '' }); now += QUOTA_INTERVAL;
    await sync.refreshIfDue(); assert.equal(calls, 4); assert.equal(sync.status().configured, false); assert.equal(sync.status().standard, null);
  } finally { await sync.close(); f.cleanup(); }
});

test('simultaneous manual requests coalesce and failed refresh keeps persistent snapshot without leaking network details', async () => {
  const f = fixture(); let now = Date.parse('2026-10-02T00:00:00Z'), calls = 0, fail = false;
  const sync = new CloudQuotaSync(f.store, async () => { calls++; if (fail) throw new Error(`network details ${keys.secretAccessKey}`); return page([pack()]); }, () => now);
  try {
    await Promise.all([sync.sync(), sync.sync(), sync.sync()]); assert.equal(calls, 1);
    const before = f.store.get('cloudQuotaSnapshot'); now += 10000; fail = true;
    await assert.rejects(sync.sync(), /超时或网络异常/);
    assert.deepEqual(f.store.get('cloudQuotaSnapshot'), before);
    const reopened = new Store(f.dir), persisted = new CloudQuotaSync(reopened, undefined, () => now);
    assert.equal(persisted.status().standard?.remaining, 15771); assert.equal(persisted.status().stale, true);
    assert.ok(!JSON.stringify(persisted.status()).includes(keys.secretAccessKey));
    await persisted.close(); reopened.close();
  } finally { await sync.close(); f.cleanup(); }
});

test('quota requests require separate OpenAPI credentials and are aborted on service close', async () => {
  let called = false;
  await assert.rejects(fetchCloudQuota({ ...keys, secretAccessKey: '' }, 'default', async () => { called = true; throw new Error(); }), /先在音色实验室配置/);
  assert.equal(called, false);
  const f = fixture();
  const sync = new CloudQuotaSync(f.store, async (_url, init) => new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }));
  try {
    const pending = sync.sync(); await sync.close(); await pending;
    assert.equal(f.store.get('cloudQuotaSnapshot'), undefined); await assert.rejects(sync.sync(), /服务正在关闭/);
  } finally { await sync.close(); f.cleanup(); }
});

test('quota admin API persists project settings, protects access and never calls synthesis for a balance query', async () => {
  const f = fixture(); let fetches = 0, syntheses = 0;
  f.store.set('voiceAutoSync', false); f.store.set('quotaAutoSync', false);
  const service = createService({ dataDir: f.dir, quotaFetch: async (_url, init) => { fetches++; assert.equal(JSON.parse(String(init?.body)).ProjectName, 'production'); return page([pack()]); },
    provider: { synthesize: async () => { syntheses++; throw new Error('must not synthesize'); }, design: async () => { throw new Error('must not design'); } } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  try {
    for (const method of ['GET', 'POST', 'PATCH']) assert.equal((await fetch(`${base}/api/cloud-quota`, { method })).status, 401);
    const { adminToken } = await (await fetch(`${base}/api/bootstrap`)).json();
    const headers = { 'X-DMReader-Admin': adminToken, 'Content-Type': 'application/json' };
    const req = (method = 'GET', body?: object) => fetch(`${base}/api/cloud-quota`, { method, headers, body: body && JSON.stringify(body) });
    assert.equal((await (await req()).json()).standard, null); assert.equal(fetches, 0);
    assert.equal((await req('PATCH', { project: '' })).status, 400);
    assert.equal((await req('PATCH', { project: 'production', enabled: false })).status, 200);
    assert.equal((await req('POST', {})).status, 200); assert.equal(fetches, 1);
    const status = await (await req()).json(); assert.equal(status.standard.remaining, 15771);
    assert.ok(!JSON.stringify(status).includes(keys.accessKeyId)); assert.ok(!JSON.stringify(status).includes(keys.secretAccessKey));
    assert.equal((await req('POST', {})).status, 429); assert.equal(fetches, 1); assert.equal(syntheses, 0);
    assert.equal(service.store.spent('seed-tts-2.0'), 0);
    const reopened = new Store(f.dir); assert.equal(reopened.get('quotaProject'), 'production'); assert.equal(reopened.get('quotaAutoSync'), false); reopened.close();
    assert.equal((await req('PATCH', { project: 'another-project' })).status, 200);
    assert.equal((await (await req()).json()).standard, null); assert.equal(fetches, 1);
  } finally { await service.close(); f.cleanup(); }
});
