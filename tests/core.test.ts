import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { WebSocket } from 'ws';
import { Store } from '../server/store.js';
import { Engine, identity, parseCommand } from '../server/engine.js';
import { voices } from '../server/voices.js';
import { parseAudio, synthesisBody, authHeaders, DoubaoProvider, silentWav, type Synthesis } from '../server/provider.js';
import { createService } from '../server/app.js';

function temp() { return mkdtempSync(join(tmpdir(), 'dmreader-test-')); }
function cleanup(dir: string) { const full = resolve(dir); assert.ok(full.startsWith(resolve(tmpdir()) + sep) && basename(full).startsWith('dmreader-test-')); rmSync(full, { recursive: true, force: true }); }
function fixture() {
  const dir = temp(), store = new Store(dir), calls: Synthesis[] = [];
  store.saveCredentials({ apiKey: 'test-key-never-sent-to-cloud', appId: '', accessKey: '' });
  store.set('settings', { ...store.settings(), cooldownSeconds: 0 });
  const provider = { synthesize: async (input: Synthesis) => { calls.push(input); return { audio: Buffer.from('mock-audio'), chars: Array.from(input.text).length, estimated: false, logId: 'test' }; }, design: async (speaker: string) => ({ status: 2, speaker_id: speaker, available_training_times: 14 }) };
  const engine = new Engine(store, provider);
  return { dir, store, engine, provider, calls, close() { store.close(); cleanup(dir); } };
}
test('commands require an exact prefix and separate argument; UID rejects unstable numeric values', () => {
  assert.equal(parseCommand('今天#音色 小何'), null);
  assert.equal(parseCommand('#音色小何'), null);
  assert.deepEqual(parseCommand('＃风格 开心一点 '), { name: '风格', arg: '开心一点' });
  for (const uid of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1, '', '0', '00', '-1', null, 'a b']) assert.equal(identity(uid), null);
  assert.equal(identity('12345678901234567890'), '12345678901234567890');
  assert.equal(identity('open_id-abc'), 'open_id-abc');
});
test('catalog contains unique real TTS 2.0 IDs and chat-friendly aliases', () => {
  assert.equal(voices.length, 445); assert.equal(new Set(voices.map(v => v.id)).size, voices.length);
  assert.equal(new Set(voices.map(v => v.name.toLowerCase())).size, voices.length);
  assert.ok(voices.every(v => v.resource === 'seed-tts-2.0' && v.language && !v.id.startsWith('S_')));
  assert.equal(voices.find(v => v.name === 'Lily')?.id, 'ja_female_bv523_uranus_bigtts');
  assert.equal(voices.find(v => v.name === '小何')?.id, 'zh_female_xiaohe_uranus_bigtts');
  // The official foreign table contains nontrivial IDs; do not build them from a name.
  assert.equal(voices.find(v => v.name === 'Rowan')?.id, 'en_male_adam-imitation_uranus_bigtts');
});

test('foreign and official preset names resolve without changing resource or viewer isolation', async () => {
  const f = fixture();
  try {
    for (const [i, name] of ['lily', 'LILY 2.0', 'Lily', 'Rowan', 'Charlie'].entries()) {
      const viewer = f.store.touch(`foreign-${i}`, '音色测试');
      f.engine.command(viewer, `#音色 ${name}`);
      const voice = f.engine.voice(name)!;
      assert.equal(f.store.viewer(viewer.uid)?.voice, voice.id);
      await f.engine.speak(`声音测试${i}`, { uid: viewer.uid, source: 'preview' });
      assert.equal(f.calls.at(-1)?.voice.id, voice.id);
      assert.equal(f.calls.at(-1)?.voice.resource, 'seed-tts-2.0');
    }
    assert.equal(f.store.spent('seed-icl-2.0'), 0);
    assert.equal(f.store.viewer('foreign-0')?.voice, 'ja_female_bv523_uranus_bigtts');
  } finally { f.close(); }
});
test('same-name viewers are isolated; settings survive restart and rename', () => {
  const f = fixture();
  f.engine.command(f.store.touch('100', '同名'), '#音色 小何');
  f.engine.command(f.store.touch('101', '同名'), '#音色 云舟');
  f.engine.command(f.store.viewer('100')!, '#风格 开心俏皮');
  f.engine.command(f.store.viewer('100')!, '#语速 1.2');
  f.store.close(); const reopened = new Store(f.dir);
  assert.match(reopened.touch('100', '改名了').voice, /xiaohe/);
  assert.match(reopened.viewer('101')!.voice, /m191/);
  assert.equal(reopened.viewer('100')!.style, '开心俏皮');
  assert.equal(reopened.viewer('100')!.speed, 20);
  assert.equal(reopened.credentials().apiKey, 'test-key-never-sent-to-cloud');
  assert.ok(!reopened.get<string>('credentials')!.includes('test-key-never-sent-to-cloud'));
  reopened.close(); cleanup(f.dir);
});
test('cooldown, moderator lock, reset and disabled style rules', () => {
  const f = fixture(); try {
    f.store.set('settings', { ...f.store.settings(), cooldownSeconds: 60 }); const v = f.store.touch('1', '甲');
    f.engine.command(v, '#音色 小何');
    assert.throws(() => f.engine.command(f.store.viewer('1')!, '#语速 1.5'), /修改太快/);
    assert.match(f.engine.command(f.store.viewer('1')!, '#我的音色'), /小何/);
    f.store.updateViewer('1', { locked: true }); assert.throws(() => f.engine.command(f.store.viewer('1')!, '#重置'), /锁定/);
    f.store.set('settings', { ...f.store.settings(), cooldownSeconds: 0, allowStyles: false }); f.store.updateViewer('1', { locked: false });
    assert.throws(() => f.engine.command(f.store.viewer('1')!, '#风格 开心'), /关闭/);
    f.engine.command(f.store.viewer('1')!, '#重置'); assert.equal(f.store.viewer('1')!.voice, '');
  } finally { f.close(); }
});
test('room filter, persistent deduplication, missing UID and queue cap', async () => {
  const f = fixture(); try {
    f.store.set('settings', { ...f.store.settings(), maxQueue: 1 });
    const event = { type: 'message', origin: 659719, id: 'a', uid: 1, username: '甲', message: '第一条' };
    f.engine.claimPlayer('player');
    assert.deepEqual(f.engine.ingest({ ...event, origin: 2 }), { ignored: true });
    assert.deepEqual(f.engine.ingest(event), { queued: true });
    assert.deepEqual(f.engine.ingest(event), { duplicate: true });
    assert.deepEqual(f.engine.ingest({ ...event, id: 'b' }), { skipped: '队列已满' });
    assert.deepEqual(f.engine.ingest({ ...event, id: 'c', uid: 0 }), { ignored: true });
    const result = await f.engine.next('player'); assert.equal(result!.job.uid, '1'); assert.equal(f.calls.length, 1);
    f.engine.ingest({ ...event, id: 'd' }); f.engine.releasePlayer('player'); assert.equal(f.engine.queue.length, 0);
    assert.deepEqual(f.engine.ingest({ ...event, id: 'e' }), { skipped: '播放器未开启' });
    const sameDatabaseEngine = new Engine(f.store, f.provider); assert.deepEqual(sameDatabaseEngine.ingest(event), { duplicate: true });
  } finally { f.close(); }
});
test('one player owns the lease; muted/oversized/blocked danmaku never synthesize', async () => {
  const f = fixture(); try {
    f.engine.claimPlayer('a'); assert.throws(() => f.engine.claimPlayer('b'), /另一个页面/);
    f.store.set('settings', { ...f.store.settings(), blockedWords: '屏蔽词', maxChars: 5 });
    f.store.touch('1', '甲'); f.store.updateViewer('1', { muted: true });
    for (const [uid, message, reason] of [[1, '你好', '静音'], [2, '屏蔽词', '屏蔽'], [3, '一二三四五六', '限制']] as const) {
      const r = f.engine.ingest({ type: 'message', origin: 659719, id: randomUUID(), uid, message }); assert.match(r.skipped!, new RegExp(reason));
    }
    assert.equal(await f.engine.next('a'), null); assert.equal(f.calls.length, 0);
  } finally { f.close(); }
});
test('cache key includes voice and style, and concurrent reservations respect budget', async () => {
  const f = fixture(); try {
    f.store.set('settings', { ...f.store.settings(), budget: 4 });
    const results = await Promise.allSettled([f.engine.speak('甲乙丙', { source: 'test' }), f.engine.speak('丁戊己', { source: 'test' })]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected'); assert.equal(f.calls.length, 1);
    assert.equal((await f.engine.speak('甲乙丙', { source: 'test' })).cached, true); assert.equal(f.store.spent('seed-tts-2.0'), 3);
    f.store.set('settings', { ...f.store.settings(), budget: 100 });
    await f.engine.speak('甲乙丙', { source: 'test', style: '开心' });
    await f.engine.speak('甲乙丙', { source: 'test', voice: '小何' }); assert.equal(f.calls.length, 3);
  } finally { f.close(); }
});
test('network failure keeps budget reserved and no partial audio is cached', async () => {
  const f = fixture(); try {
    let calls = 0; f.provider.synthesize = async () => { calls++; throw new Error('timeout'); };
    await assert.rejects(f.engine.speak('你好', { source: 'test' }), /超时/);
    await assert.rejects(f.engine.speak('你好', { source: 'test' }), /超时/);
    assert.equal(calls, 2); assert.equal(f.store.spent('seed-tts-2.0'), 4);
  } finally { f.close(); }
});
test('design requests do not generate until approved; slots cannot be reused', async () => {
  const f = fixture(); try {
    let calls = 0; f.provider.design = async speaker => { calls++; return { speaker_id: speaker, status: 2, available_training_times: 14 }; };
    f.engine.command(f.store.touch('1', '甲'), '#定制 温柔的女声'); assert.equal(calls, 0);
    assert.throws(() => f.engine.command(f.store.viewer('1')!, '#定制 新声音'), /已有/);
    await f.engine.approveDesign(f.engine.designs()[0].id, 'S_testslot'); assert.equal(calls, 1);
    assert.equal(f.store.viewer('1')!.voice, 'S_testslot'); assert.equal(f.engine.voice('S_testslot')!.resource, 'seed-icl-2.0');
    f.engine.command(f.store.touch('2', '乙'), '#定制 沉稳的男声');
    await assert.rejects(f.engine.approveDesign(f.engine.designs()[0].id, 'S_testslot'), /绑定/); assert.equal(calls, 1);
  } finally { f.close(); }
});
test('uncertain design outcomes are never automatically retried', async () => {
  const f = fixture(); try {
    let calls = 0; f.provider.design = async () => { calls++; throw new Error('network'); };
    f.engine.command(f.store.touch('1', '甲'), '#定制 温柔的女声'); const id = f.engine.designs()[0].id;
    await assert.rejects(f.engine.approveDesign(id, 'S_unknown')); assert.equal(f.engine.designs()[0].status, 'uncertain');
    await assert.rejects(f.engine.approveDesign(id, 'S_unknown')); assert.equal(calls, 1);
  } finally { f.close(); }
});
test('provider headers and JSON-string additions follow current API contract', async () => {
  const input: Synthesis = { voice: voices[0], text: '你好', style: '高兴', speed: 20 };
  assert.deepEqual(JSON.parse(synthesisBody(input).req_params.additions), { context_texts: ['高兴'] });
  assert.deepEqual(JSON.parse(synthesisBody({ ...input, voice: { ...voices[0], resource: 'seed-icl-2.0' } }).req_params.additions), {});
  const c = { apiKey: '', appId: 'test-app', accessKey: 'test-access' };
  assert.equal(authHeaders(c)['X-Api-App-Id'], 'test-app'); assert.equal(authHeaders(c, true)['X-Api-App-Key'], 'test-app');
  let request: RequestInit | undefined;
  const provider = new DoubaoProvider(() => ({ ...c, apiKey: 'test-key' }), async (_url, init) => { request = init; return new Response('{"code":0,"data":"YWJj","usage":{"text_words":2}}\n'); });
  assert.equal((await provider.synthesize(input)).audio.toString(), 'abc');
  assert.equal((request!.headers as Record<string, string>)['X-Api-Resource-Id'], 'seed-tts-2.0');
  assert.equal((request!.headers as Record<string, string>)['X-Api-Key'], 'test-key');
});
test('audio parser accepts arbitrary UTF-8 chunk boundaries, NDJSON and SSE', async () => {
  for (const prefix of ['', 'data: ']) {
    const bytes = new TextEncoder().encode(`${prefix}{"code":0,"message":"成功","data":"YWJj"}\n${prefix}{"code":20000000,"usage":{"text_words":2}}`);
    const stream = new ReadableStream({ start(c) { for (const b of bytes) c.enqueue(new Uint8Array([b])); c.close(); } });
    const result = await parseAudio(new Response(stream), 10); assert.equal(result.audio.toString(), 'abc'); assert.equal(result.chars, 2); assert.equal(result.estimated, false);
  }
});
test('provider rejects an error after partial audio, malformed JSON, empty and broken streams', async () => {
  for (const body of ['{"code":0,"data":"YWJj"}\n{"code":45000000}', 'bad json', '{"code":0}', '{"code":0,"data":"???"}']) await assert.rejects(parseAudio(new Response(body), 2));
  const stream = new ReadableStream({ pull(c) { c.error(new Error('broken connection')); } });
  await assert.rejects(parseAudio(new Response(stream), 2), /broken/);
  const wav = silentWav(); assert.equal(wav.toString('ascii', 0, 4), 'RIFF'); assert.equal(wav.readUInt32LE(40), wav.length - 44);
});

test('HTTP and WebSocket integration: security, CORS, commands, profile backup, audio and real bridge protocol', async t => {
  const dir = temp(); let calls = 0;
  const service = createService({ dataDir: dir, provider: { synthesize: async i => { calls++; return { audio: Buffer.from('ID3-audio'), chars: i.text.length, estimated: false, logId: '' }; }, design: async speaker => ({ status: 2, speaker_id: speaker }) } });
  await new Promise<void>(r => service.server.listen(0, '127.0.0.1', r));
  const address = service.server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
  const boot = await (await fetch(`${base}/api/bootstrap`)).json();
  const headers = { 'Content-Type': 'application/json', 'X-DMReader-Admin': boot.adminToken };
  const post = (path: string, body: unknown, extra: Record<string, string> = {}, method = 'POST') => fetch(base + path, { method, headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  try {
    await t.test('management rejects untrusted origin, missing admin secret and rebinding Host', async () => {
      assert.equal((await fetch(base + '/api/connection')).status, 401);
      assert.equal((await fetch(base + '/api/bootstrap', { headers: { Origin: 'https://evil.example' } })).status, 403);
      const reboundStatus = await new Promise<number | undefined>((resolve, reject) => { const r = httpRequest(base + '/api/bootstrap', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }); r.on('error', reject); r.end(); });
      assert.equal(reboundStatus, 403);
      assert.equal((await post('/api/credentials', { apiKey: 'test-only' })).status, 200);
    });
    const token = (await (await fetch(base + '/api/connection', { headers })).json()).apiToken;
    await t.test('LAPLACE CORS and bridge-mode API silence prevent duplicate billing', async () => {
      const cors = await fetch(base + '/v1/tts', { method: 'OPTIONS', headers: { Origin: 'https://laplace.chat', 'Access-Control-Request-Method': 'POST' } });
      assert.equal(cors.status, 204); assert.equal(cors.headers.get('Access-Control-Allow-Origin'), 'https://laplace.chat');
      assert.equal((await post('/v1/tts', { token: 'wrong', text: '你好' })).status, 401);
      const audio = await post('/v1/tts', { token, text: '你好' }); assert.equal(audio.headers.get('content-type'), 'audio/wav'); assert.equal(calls, 0);
      assert.equal((await post('/v1/tts', { token, text: '你好' }, { Origin: 'https://evil.example' })).status, 403);
    });
    await t.test('WebSocket producer handshake persists UID command and rejects wrong password', async () => {
      const bad = new WebSocket(base.replace('http:', 'ws:'), ['laplace-event-bridge-role-server', 'bad']);
      await once(bad, 'error');
      const ws = new WebSocket(base.replace('http:', 'ws:'), ['laplace-event-bridge-role-server', token], { origin: 'https://laplace.chat' });
      const first = await once(ws, 'message'); assert.equal(JSON.parse(first[0].toString()).type, 'established');
      const ack = once(ws, 'message'); ws.send(JSON.stringify({ type: 'message', origin: 659719, uid: 123, username: '真实协议测试', id: 'message-1', message: '#音色 小何' }));
      assert.equal(JSON.parse((await ack)[0].toString()).type, 'broadcast-success'); assert.match(service.store.viewer('123')!.voice, /xiaohe/);
      ws.close(); await once(ws, 'close');
    });
    await t.test('backup can round-trip its own export and malformed import leaves database intact', async () => {
      const backup = await (await fetch(base + '/api/backup', { headers })).json();
      assert.equal((await post('/api/backup', backup)).status, 200);
      backup.viewers[0].voice = 'not-real'; assert.equal((await post('/api/backup', backup)).status, 400); assert.match(service.store.viewer('123')!.voice, /xiaohe/);
    });
    await t.test('API mode returns raw audio and never associates a name without UID', async () => {
      await post('/api/settings', { mode: 'api' }, {}, 'PATCH');
      const before = service.engine.status().totalViewers;
      const r = await post('/v1/tts', { token, text: '测试', voice: '小何', instructions: '轻松自然' });
      assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'audio/mpeg'); assert.equal(await r.text(), 'ID3-audio'); assert.equal(calls, 1);
      await post('/v1/tts', { token, text: '#音色 云舟' }); assert.equal(service.engine.status().totalViewers, before);
    });
  } finally { await service.close(); cleanup(dir); }
});
