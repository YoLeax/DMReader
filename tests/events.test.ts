import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { Engine } from '../server/engine.js';
import { Store } from '../server/store.js';
import { createService } from '../server/app.js';
import { cleanText } from '../server/events.js';
import type { Synthesis } from '../server/provider.js';
import { eventTypes, defaultEventSpeech, type EventType, type InteractionAction } from '../shared/events.js';

const allOn = Object.fromEntries(eventTypes.map(t => [t, true])) as Record<EventType, boolean>;
const actionsOn = { '1': true, '2': true, '3': true, '4': true, '5': true } as const;
function cleanup(dir: string) { const full = resolve(dir); assert.ok(full.startsWith(resolve(tmpdir()) + sep) && basename(full).startsWith('dmreader-test-')); rmSync(full, { recursive: true, force: true }); }
function mocks() {
  const calls: Synthesis[] = [];
  return { calls, synthesize: async (input: Synthesis) => { calls.push(input); return { audio: Buffer.from('mock-audio'), chars: Array.from(input.text).length, estimated: false, logId: 'mock' }; }, design: async (speaker: string) => ({ status: 2, speaker_id: speaker }) };
}
function fixture(enabled = true) {
  const dir = mkdtempSync(join(tmpdir(), 'dmreader-test-')), store = new Store(dir), provider = mocks();
  store.saveCredentials({ apiKey: 'mock-no-network', appId: '', accessKey: '' });
  store.set('settings', { ...store.settings(), cooldownSeconds: 0, ...(enabled ? { eventSpeech: allOn, interactionActions: actionsOn } : {}) });
  let now = Date.now();
  const engine = new Engine(store, provider, () => now);
  engine.claimPlayer('player');
  return { dir, store, engine, provider, tick(ms: number) { now += ms; }, close() { store.close(); cleanup(dir); } };
}
function event(type: EventType, extra: Record<string, unknown> = {}) {
  const fields: Record<EventType, object> = {
    message: { message: '大家好' }, 'effect-message': { message: '<b>新年快乐</b>', messageRaw: { action: 'effect-code', img: 'never-read', text: 'raw-not-read' } },
    gift: { giftName: '小心心', giftAmount: 3, giftId: 30607 }, superchat: { message: '<b>直播很精彩</b>', deleted: false, token: 'must-not-be-exposed' },
    toast: { toastType: 3, toastName: '舰长', toastAmount: 1, toastAmountUnit: '月', message: '<%小明%>续费了舰长' },
    interaction: { action: 1 }, 'entry-effect': { message: '<img src="effect-code">特效代码', effectId: 100 }, 'like-click': { message: '为主播点赞了' },
  };
  return { type, id: randomUUID(), origin: 659719, uid: 42, username: '小明', timestampNormalized: Date.now(), ...fields[type], ...extra };
}

test('all eight types use switches, bounded records, personal voices and the existing audio pipeline', async t => {
  const expected: Record<EventType, string> = { message: '大家好', 'effect-message': '新年快乐', gift: '感谢小明送出的 3 个小心心。', superchat: '小明的醒目留言：直播很精彩', toast: '感谢小明续费舰长，1个月。', interaction: '欢迎小明进入直播间。', 'entry-effect': '欢迎小明进入直播间。', 'like-click': '感谢小明点赞。' };
  for (const type of eventTypes) await t.test(type, async () => {
    const f = fixture(); try {
      f.store.touch('42', '小明'); f.store.updateViewer('42', { voice: f.engine.voice('小何')!.id, style: '开心俏皮', speed: 20 });
      f.store.set('settings', { ...f.store.settings(), announceUsername: true, eventSpeech: { ...allOn, [type]: false } });
      assert.equal(f.engine.ingest(event(type)).skipped, '关闭播报');
      assert.equal(f.engine.recentEvent(type)!.event.type, type);
      assert.equal(f.store.logs(1)[0].kind, 'disabled');
      assert.equal(await f.engine.next('player'), null); assert.equal(f.provider.calls.length, 0); assert.equal(f.store.spent('seed-tts-2.0'), 0);
      f.store.set('settings', { ...f.store.settings(), eventSpeech: allOn });
      assert.equal(f.engine.ingest(event(type)).queued, true);
      await f.engine.next('player'); const call = f.provider.calls[0];
      assert.equal(call.text, ['message', 'effect-message'].includes(type) ? `小明说，${expected[type]}` : expected[type]);
      assert.match(call.voice.id, /xiaohe/); assert.equal(call.style, '开心俏皮'); assert.equal(call.speed, 20);
      assert.ok(!call.text.includes('<') && !call.text.includes('effect-code'));
      assert.equal(f.store.logs(1)[0].eventType, type);
    } finally { f.close(); }
  });
});

test('interaction actions 1–5 require both switches; unknown actions are recorded as invalid', async () => {
  const f = fixture(); try {
    for (let action = 1; action <= 5; action++) {
      const key = String(action) as InteractionAction;
      f.store.set('settings', { ...f.store.settings(), interactionActions: { ...actionsOn, [key]: false } });
      assert.equal(f.engine.ingest(event('interaction', { action })).skipped, '关闭播报');
      f.store.set('settings', { ...f.store.settings(), interactionActions: actionsOn });
      assert.equal(f.engine.ingest(event('interaction', { action })).queued, true);
      await f.engine.next('player');
    }
    assert.deepEqual(f.provider.calls.map(c => c.text), ['欢迎小明进入直播间。', '感谢小明关注直播间。', '感谢小明分享直播间。', '感谢小明特别关注主播。', '小明与主播互相关注啦。']);
    assert.match(f.engine.ingest(event('interaction', { action: 6 })).skipped!, /字段异常/);
    assert.equal(f.store.logs(1)[0].kind, 'invalid');
  } finally { f.close(); }
});

test('command confirmations and query speak the saved effective settings even with message disabled', async () => {
  const f = fixture(); try {
    f.store.set('settings', { ...f.store.settings(), eventSpeech: { ...allOn, message: false }, announceUsername: true });
    const commands = ['#音色 小何', '#风格 开心俏皮', '#语速 1.2', '#查询'];
    for (const message of commands) { assert.ok(f.engine.ingest(event('message', { message })).command); await f.engine.next('player'); }
    assert.deepEqual(f.provider.calls.map(c => c.text), ['小明开始使用小何音色。', '小明改了语音风格：开心俏皮', '小明将语速改为1.2倍。', '小明当前音色小何，语速1.2倍，风格为开心俏皮。']);
    assert.ok(f.provider.calls.every(c => c.voice.id.includes('xiaohe') && !c.text.includes('#') && !c.text.includes('小明说')));
    assert.equal(f.provider.calls.at(-1)!.speed, 20); assert.equal(f.provider.calls.at(-1)!.style, '开心俏皮');
    f.engine.ingest(event('message', { message: '#查询' })); assert.equal(await f.engine.next('player'), null);
    f.tick(11000); f.engine.ingest(event('message', { message: '#我的音色' })); assert.equal((await f.engine.next('player'))!.cached, true);
    f.engine.ingest(event('message', { message: '#语速 8' })); assert.equal(await f.engine.next('player'), null);
    f.engine.ingest(event('message', { message: '#风格 清除' })); await f.engine.next('player'); assert.match(f.provider.calls.at(-1)!.text, /恢复直播间默认风格/);
    f.engine.ingest(event('message', { message: '#重置' })); await f.engine.next('player'); assert.match(f.provider.calls.at(-1)!.text, /恢复直播间默认音色/);
    f.tick(11000); f.engine.ingest(event('message', { message: '#查询' })); await f.engine.next('player'); assert.ok(!f.provider.calls.at(-1)!.text.includes('风格为'));
    f.store.set('settings', { ...f.store.settings(), commandFeedback: false });
    f.engine.ingest(event('message', { message: '#语速 1.5' })); assert.equal(f.store.viewer('42')!.speed, 50); assert.equal(await f.engine.next('player'), null);
    f.store.updateViewer('42', { muted: true }); const before = f.store.viewer('42')!.voice;
    f.engine.ingest(event('message', { message: '#音色 小何' })); assert.equal(f.store.viewer('42')!.voice, before);
  } finally { f.close(); }
});

test('UID fallback never links a same-name viewer; blank upstream names preserve the saved name; muted viewers never synthesize', async () => {
  const f = fixture(); try {
    f.store.touch('42', '小明'); f.store.updateViewer('42', { voice: f.engine.voice('小何')!.id, muted: true });
    for (const type of eventTypes) assert.ok(f.engine.ingest(event(type)).skipped);
    assert.equal(await f.engine.next('player'), null); assert.equal(f.provider.calls.length, 0);
    assert.deepEqual(f.engine.ingest(event('message', { uid: 0 })), { ignored: true });
    for (const type of eventTypes.filter(t => t !== 'message')) {
      assert.equal(f.engine.ingest(event(type, { uid: Number.MAX_SAFE_INTEGER + 1 })).queued, true);
      await f.engine.next('player'); f.tick(61000);
    }
    assert.ok(f.provider.calls.every(c => c.voice.id === f.store.settings().defaultVoice));
    assert.equal(f.store.viewers().length, 1);
    f.store.updateViewer('42', { muted: false });
    f.engine.ingest(event('like-click', { username: '' })); await f.engine.next('player');
    assert.equal(f.store.viewer('42')!.username, '小明'); assert.match(f.provider.calls.at(-1)!.voice.id, /xiaohe/);
  } finally { f.close(); }
});

test('gift and SC ids, toast stableKey and action discriminator deduplicate without collapsing distinct events', () => {
  const f = fixture(); try {
    for (const type of eventTypes) {
      const e = event(type, { id: `unique-${type}`, stableKey: type === 'toast' ? 'stable-1' : undefined });
      f.engine.ingest(e); assert.equal(f.engine.ingest(e).duplicate, true);
      assert.equal(f.store.logs(1)[0].kind, 'duplicate');
    }
    assert.equal(f.engine.ingest(event('toast', { id: 'changed-id', stableKey: 'stable-1' })).duplicate, true);
    assert.equal(f.engine.ingest(event('toast', { id: 'unique-toast', stableKey: 'bonus-days', toastAmountUnit: '*8天' })).queued, true);
    assert.equal(f.engine.ingest(event('toast', { id: 'fallback', toastAmountUnit: '月' })).queued, true);
    assert.equal(f.engine.ingest(event('toast', { id: 'fallback', toastAmountUnit: '*8天' })).queued, true);
    assert.ok(!f.engine.ingest(event('interaction', { id: 'same-time-uid', uid: 50, action: 2 })).duplicate);
    assert.ok(!f.engine.ingest(event('interaction', { id: 'same-time-uid', uid: 50, action: 3 })).duplicate);
    const newEngine = new Engine(f.store, f.provider);
    assert.equal(newEngine.ingest(event('superchat', { id: 'unique-superchat' })).duplicate, true);
  } finally { f.close(); }
});

test('gift bursts use cooldown without summing cumulative or incremental notifications; entry sources share cooldown', async () => {
  const f = fixture(); try {
    for (const [id, giftAmount] of [['combo:1', 1], ['combo:2', 2], ['combo:3', 3]] as const) f.engine.ingest(event('gift', { id, giftAmount }));
    assert.equal(f.engine.queue.length, 1); assert.match(f.engine.queue[0].text, / 1 个/);
    await f.engine.next('player'); f.tick(11000);
    f.engine.ingest(event('gift', { giftAmount: 2 })); await f.engine.next('player'); assert.match(f.provider.calls.at(-1)!.text, / 2 个/);
    assert.equal(f.engine.ingest(event('interaction')).queued, true);
    assert.equal(f.engine.ingest(event('entry-effect')).skipped, '冷却跳过');
    await f.engine.next('player'); f.tick(61000);
    assert.equal(f.engine.ingest(event('entry-effect')).queued, true);
    assert.equal(f.engine.ingest(event('interaction')).skipped, '冷却跳过');
    assert.equal(f.engine.ingest(event('like-click')).queued, true);
    assert.equal(f.engine.ingest(event('like-click')).skipped, '冷却跳过');
    f.tick(31000); assert.equal(f.engine.ingest(event('like-click')).queued, true);
    f.store.set('settings', { ...f.store.settings(), eventSpeech: { ...allOn, interaction: false } });
    assert.equal(f.engine.ingest(event('interaction', { uid: 88 })).skipped, '关闭播报');
    assert.equal(f.engine.ingest(event('entry-effect', { uid: 88 })).queued, true);
  } finally { f.close(); }
});

test('invalid fields and effect markup never reach synthesis; toast levels, renewals and bonus days use actual fields', async () => {
  const f = fixture(); try {
    for (const bad of [event('gift', { giftAmount: -1 }), event('gift', { giftName: '' }), event('message', { message: null }), event('like-click', { id: '' }), event('interaction', { action: '2' }), event('toast', { toastType: 9 }), event('superchat', { message: '{"effect":"raw"}' }), event('effect-message', { message: '<img src="code">' })]) assert.ok(!f.engine.ingest(bad).queued);
    assert.equal(await f.engine.next('player'), null); assert.equal(f.provider.calls.length, 0);
    assert.equal(cleanText('&lt;b&gt;你好&lt;/b&gt;<script>bad()</script><%甲%>'), '你好 甲');
    for (const toastType of [1, 2, 3]) { f.engine.ingest(event('toast', { toastType, message: '<%小明%>开通了' + ({ 1: '总督', 2: '提督', 3: '舰长' }[toastType]), toastAmountUnit: '*8天' })); await f.engine.next('player'); }
    assert.deepEqual(f.provider.calls.map(c => c.text), ['感谢小明开通总督，8天。', '感谢小明开通提督，8天。', '感谢小明开通舰长，8天。']);
    f.engine.ingest(event('toast', { message: '舰长', toastAmount: undefined, toastAmountUnit: undefined })); await f.engine.next('player'); assert.equal(f.provider.calls.at(-1)!.text, '感谢小明支持舰长。');
    assert.equal(f.engine.ingest(event('superchat', { deleted: true })).skipped, '醒目留言已删除');
    assert.ok(!JSON.stringify(f.engine.recentEvent('superchat')).includes('must-not-be-exposed'));
  } finally { f.close(); }
});

test('switch migration and persistence, queue recheck, room isolation, and the 3000-log cap', async () => {
  const f = fixture(false); try {
    assert.deepEqual(f.store.settings().eventSpeech, defaultEventSpeech);
    assert.equal(f.store.settings().commandFeedback, true);
    assert.ok(Object.values(f.store.settings().interactionActions).every(v => !v));
    f.store.set('settings', { eventSpeech: { gift: true }, interactionActions: { '2': true }, likeCooldownSeconds: 45 });
    assert.equal(f.store.settings().eventSpeech.message, true); assert.equal(f.store.settings().eventSpeech.toast, false);
    assert.equal(f.engine.ingest(event('gift')).queued, true);
    const before = JSON.stringify(f.engine.recentEvents());
    assert.deepEqual(f.engine.ingest(event('gift', { origin: 123 })), { ignored: true }); assert.equal(JSON.stringify(f.engine.recentEvents()), before);
    f.store.set('settings', { ...f.store.settings(), eventSpeech: defaultEventSpeech });
    assert.equal(await f.engine.next('player'), null); assert.equal(f.provider.calls.length, 0);
    for (let i = 0; i < 3010; i++) f.store.log('disabled', { eventType: 'gift', detail: 'bounded' });
    assert.equal(f.store.db.prepare('SELECT COUNT(*) n FROM logs').get()!.n, 3000);
    const reopened = new Store(f.dir);
    assert.equal(reopened.settings().interactionActions['2'], true); assert.equal(reopened.settings().likeCooldownSeconds, 45); reopened.close();
  } finally { f.close(); }
});

test('turning a type off while a job waits for the synthesis lock never dispatches it upstream', async () => {
  const f = fixture(); try {
    let release!: () => void, started!: () => void;
    const ready = new Promise<void>(r => { started = r; });
    const gate = new Promise<void>(r => { release = r; });
    const original = f.provider.synthesize;
    f.provider.synthesize = async input => { started(); await gate; return original(input); };
    const preview = f.engine.speak('试听正在进行', { source: 'preview' }); await ready;
    f.engine.ingest(event('gift')); const queued = f.engine.next('player');
    const rejected = assert.rejects(queued, /关闭播报/);
    f.store.set('settings', { ...f.store.settings(), eventSpeech: { ...allOn, gift: false } });
    release(); await preview; await rejected;
    assert.equal(f.provider.calls.length, 1); assert.equal(f.provider.calls[0].text, '试听正在进行');
  } finally { f.close(); }
});

test('WebSocket receives all types while disabled; HTTP settings merge and event inspector match bridge input', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmreader-test-')), provider = mocks(), service = createService({ dataDir: dir, provider });
  await new Promise<void>(r => service.server.listen(0, '127.0.0.1', r));
  const address = service.server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
  let ws: WebSocket | undefined;
  try {
    const boot = await (await fetch(base + '/api/bootstrap')).json() as { adminToken: string };
    const headers = { 'X-DMReader-Admin': boot.adminToken, 'Content-Type': 'application/json' };
    async function patch(body: unknown) { return fetch(base + '/api/settings', { method: 'PATCH', headers, body: JSON.stringify(body) }); }
    const r = await patch({ eventSpeech: { message: false, gift: true }, interactionActions: { '2': true } }); assert.equal(r.status, 200);
    const settings = await r.json() as { eventSpeech: Record<EventType, boolean> }; assert.equal(settings.eventSpeech.gift, true); assert.equal(settings.eventSpeech.toast, false);
    assert.equal((await patch({ eventSpeech: { unknown: true } })).status, 400);
    await patch({ eventSpeech: { gift: false } });
    ws = new WebSocket(base.replace('http:', 'ws:'), ['laplace-event-bridge-role-server', service.store.get<string>('apiToken')!], { origin: 'https://laplace.chat' });
    const greeting = once(ws, 'message'); await once(ws, 'open'); await greeting;
    for (const type of eventTypes) { const ack = once(ws, 'message'); ws.send(JSON.stringify(event(type))); await ack; }
    assert.equal(provider.calls.length, 0); assert.equal(service.engine.queue.length, 0);
    const snapshots = await (await fetch(base + '/api/events', { headers })).json() as Record<string, { source: string; result: { skipped: string } }>;
    assert.equal(Object.keys(snapshots).length, 8); assert.ok(Object.values(snapshots).every(e => e.source === 'bridge' && e.result.skipped === '关闭播报'));
    const ack = once(ws, 'message'); ws.send(JSON.stringify(event('gift', { giftAmount: 'bad' }))); await ack;
    const latest = await (await fetch(base + '/api/event', { headers })).json() as { event: { type: string }; result: { skipped: string } };
    assert.equal(latest.event.type, 'gift'); assert.match(latest.result.skipped, /字段异常/);
  } finally { ws?.terminate(); await service.close(); cleanup(dir); }
});
