import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join, sep, basename } from 'node:path';
import { once } from 'node:events';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { createService } from '../server/app.js';
import { fetchOfficialVoices, listSpeakersHeaders, VoiceCatalogSync, mergedVoices, LIST_SPEAKERS_URL, type CatalogFetch } from '../server/voice-sync.js';

const keys = { accessKeyId: 'mock-ak', secretAccessKey: 'mock-sk' };
const speaker = (id = 'test_female_voice', name = '测试音色') => ({ VoiceType: id, Name: name, ResourceID: 'seed-tts-2.0', Gender: '女', Categories: [{ Categories: ['外语音色', '角色扮演'] }], Languages: [{ Language: 'ja' }], Description: '仅供模拟' });
const response = (Speakers: unknown[], Total = Speakers.length) => Response.json({ Result: { Speakers, Total } });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'dmreader-catalog-')), store = new Store(dir);
  store.saveOpenApiCredentials(keys);
  return { dir, store, cleanup() {
    store.close(); const full = resolve(dir);
    assert.ok(full.startsWith(resolve(tmpdir()) + sep) && basename(full).startsWith('dmreader-catalog-'));
    rmSync(full, { recursive: true, force: true });
  } };
}

test('OpenAPI signing scopes the body, date, service and AK separately from TTS auth', () => {
  const now = new Date('2026-10-01T01:02:03.000Z'), body = '{"ResourceIDs":["seed-tts-2.0"],"Page":1,"Limit":30}';
  const headers = listSpeakersHeaders(body, keys, now);
  assert.equal(headers['X-Date'], '20261001T010203Z');
  // Golden signature checked against the official @volcengine/openapi 1.36.2 Signer.
  assert.ok(headers.Authorization.endsWith('Signature=ca931b8130998e9d672cd1198a1c9215d0241c6cb3f76306ec324373cdfea5d2'));
  assert.match(headers.Authorization, /^HMAC-SHA256 Credential=mock-ak\/20261001\/cn-beijing\/speech_saas_prod\/request, SignedHeaders=host;x-content-sha256;x-date, Signature=[a-f0-9]{64}$/);
  assert.notEqual(headers.Authorization, listSpeakersHeaders(body.replace('"Page":1', '"Page":2'), keys, now).Authorization);
  assert.notEqual(headers.Authorization, listSpeakersHeaders(body, { ...keys, secretAccessKey: 'other-sk' }, now).Authorization);
  assert.ok(!JSON.stringify(headers).includes('mock-sk'));
});

test('ListSpeakers paginates using official fields and rejects malformed or inconsistent results', async () => {
  let calls = 0;
  const fetcher: CatalogFetch = async (url, init) => {
    assert.equal(url, LIST_SPEAKERS_URL); assert.equal(init?.method, 'POST'); assert.equal(init?.redirect, 'error');
    const body = JSON.parse(String(init?.body)); calls++;
    assert.deepEqual(body, { ResourceIDs: ['seed-tts-2.0'], Page: calls, Limit: 30 });
    assert.ok((init?.headers as Record<string, string>).Authorization.startsWith('HMAC-SHA256'));
    return calls === 1 ? response([speaker('new_a', '测试甲')], 2) : response([speaker('new_b', '测试乙')], 2);
  };
  const voices = await fetchOfficialVoices(keys, fetcher);
  assert.equal(calls, 2); assert.equal(voices.length, 2);
  assert.equal(voices[0].language, '日语'); assert.deepEqual(voices[0].scenes, ['外语音色', '角色扮演']);
  assert.equal(voices[0].gender, '女声'); assert.equal(voices[0].resource, 'seed-tts-2.0');
  for (const bad of [{ ...speaker(), VoiceType: undefined }, { ...speaker(), ResourceID: 'seed-icl-2.0' }, { ...speaker(), Name: '' }, { ...speaker(), VoiceType: 'S_personal' }]) {
    await assert.rejects(fetchOfficialVoices(keys, async () => response([bad])), /字段异常/);
  }
  await assert.rejects(fetchOfficialVoices(keys, async () => response([], 1)), /不完整/);
  await assert.rejects(fetchOfficialVoices(keys, async () => response([speaker()], 2)), /重复/);
  calls = 0;
  await assert.rejects(fetchOfficialVoices(keys, async () => response([speaker(`v${++calls}`)], calls === 1 ? 2 : 3)), /总数发生变化/);
  await assert.rejects(fetchOfficialVoices({ ...keys, secretAccessKey: '' }, async () => { throw new Error('must not request'); }), /先配置/);
});

test('sync is atomic, persistent, deduplicated and preserves aliases, viewer settings and TTS budget', async () => {
  const f = fixture(); let fail = false, calls = 0;
  const sync = new VoiceCatalogSync(f.store, async () => { calls++; if (fail) throw new Error('secret upstream details mock-sk'); return response([speaker('ja_female_bv523_uranus_bigtts', 'Lily 新名称'), speaker('new_voice')]); });
  try {
    f.store.set('settings', { ...f.store.settings(), cooldownSeconds: 0 });
    const synth: string[] = [];
    const engine = new Engine(f.store, { synthesize: async input => { synth.push(input.voice.id); return { audio: Buffer.from('test'), chars: 2, estimated: true, logId: '' }; }, design: async () => ({}) });
    const viewer = f.store.touch('123', '测试观众'); engine.command(viewer, '#音色 Lily');
    await Promise.all([sync.sync(), sync.sync()]); assert.equal(calls, 1);
    assert.equal(sync.status().remoteCount, 2); assert.equal(mergedVoices(f.store).length, 446);
    assert.equal(engine.voice('lily')?.id, 'ja_female_bv523_uranus_bigtts');
    assert.equal(engine.voice('Lily 新名称')?.id, engine.voice('Lily')?.id);
    assert.equal(engine.voice('小何')?.id, 'zh_female_xiaohe_uranus_bigtts');
    assert.equal(f.store.viewer('123')?.voice, 'ja_female_bv523_uranus_bigtts');
    assert.equal(f.store.spent('seed-tts-2.0'), 0); assert.equal(synth.length, 0);
    fail = true; const before = f.store.get('officialVoiceCatalog');
    await assert.rejects(sync.sync(), /网络异常/); assert.deepEqual(f.store.get('officialVoiceCatalog'), before);
    assert.ok(!JSON.stringify(sync.status()).includes('mock-sk'));
    const reopened = new Store(f.dir);
    assert.equal(mergedVoices(reopened).length, 446); assert.equal(reopened.viewer('123')?.voice, engine.voice('Lily')?.id);
    assert.deepEqual(reopened.openApiCredentials(), keys); reopened.close();
  } finally { await sync.close(); f.cleanup(); }
});

test('automatic sync requires credentials and enabled state, refreshes daily and backs off after failure', async () => {
  const f = fixture(); let now = 1_800_000_000_000, calls = 0, fail = false;
  const sync = new VoiceCatalogSync(f.store, async () => { calls++; if (fail) return Response.json({ ResponseMetadata: { Error: { Code: 'AccessDenied', Message: 'mock-sk' } } }, { status: 403 }); return response([speaker()]); }, () => now);
  try {
    f.store.set('voiceAutoSync', false); await sync.refreshIfDue(); assert.equal(calls, 0);
    f.store.set('voiceAutoSync', true); await sync.refreshIfDue(); assert.equal(calls, 1);
    now += 86399000; await sync.refreshIfDue(); assert.equal(calls, 1);
    now += 1000; fail = true; await assert.rejects(sync.refreshIfDue(), /AccessDenied/); assert.equal(calls, 2);
    assert.ok(!sync.status().error.includes('mock-sk'));
    now += 3599000; await sync.refreshIfDue(); assert.equal(calls, 2);
    now += 1000; fail = false; await sync.refreshIfDue(); assert.equal(calls, 3);
    f.store.saveOpenApiCredentials({ accessKeyId: '', secretAccessKey: '' }); now += 86400000;
    await sync.refreshIfDue(); assert.equal(calls, 3);
  } finally { await sync.close(); f.cleanup(); }
});

test('catalog admin endpoints protect credentials and hot-load a synced voice for commands', async () => {
  const f = fixture(); let fetches = 0;
  // Prevent startup synchronization; the HTTP request below explicitly triggers it.
  f.store.set('voiceAutoSync', false);
  const service = createService({ dataDir: f.dir, quotaFetch: async () => Response.json({ Result: { Packs: [], TotalCount: 0 } }), catalogFetch: async () => { fetches++; return response([speaker()]); } });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const base = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
  try {
    assert.equal((await fetch(`${base}/api/voice-sync`)).status, 401);
    const { adminToken } = await (await fetch(`${base}/api/bootstrap`)).json();
    const headers = { 'X-DMReader-Admin': adminToken, 'Content-Type': 'application/json' };
    const read = () => fetch(`${base}/api/voice-sync`, { headers }).then(r => r.json());
    assert.equal((await read()).enabled, false);
    const saved = await fetch(`${base}/api/voice-sync/credentials`, { method: 'POST', headers, body: JSON.stringify(keys) });
    assert.equal(saved.status, 200); assert.ok(!(await saved.text()).includes('mock-sk'));
    assert.equal((await fetch(`${base}/api/voice-sync`, { method: 'POST', headers, body: '{}' })).status, 200);
    assert.equal(fetches, 1); assert.equal((await read()).remoteCount, 1);
    service.store.set('settings', { ...service.store.settings(), cooldownSeconds: 0 });
    service.engine.command(service.store.touch('321', '测试观众'), '#音色 测试音色');
    assert.equal(service.store.viewer('321')?.voice, 'test_female_voice');
    assert.equal(service.store.spent('seed-tts-2.0'), 0);
    assert.ok(!service.store.get<string>('openApiCredentials')!.includes('mock-sk'));
    assert.ok(!readFileSync(join(f.dir, 'dmreader.sqlite')).includes(Buffer.from('mock-sk')));
    await fetch(`${base}/api/credentials`, { method: 'POST', headers, body: JSON.stringify({ apiKey: 'separate-tts-key' }) });
    assert.deepEqual(service.store.openApiCredentials(), keys);
    assert.equal(service.store.credentials().apiKey, 'separate-tts-key');
  } finally { await service.close(); f.cleanup(); }
});
