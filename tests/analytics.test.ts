import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Analytics, analyticsWindow, DAY, HOUR } from '../server/analytics.js';
import { Store } from '../server/store.js';
import { Engine } from '../server/engine.js';
import { createService } from '../server/app.js';
import { eventTypes, type EventType } from '../shared/events.js';
import type { Synthesis } from '../server/provider.js';

const start = Date.parse('2030-10-02T00:30:00+08:00');
function cleanup(dir: string) { const full = resolve(dir); assert.ok(full.startsWith(resolve(tmpdir()) + sep) && basename(full).startsWith('dmreader-test-')); rmSync(full, { recursive: true, force: true }); }
function fixture(synthesize?: (input: Synthesis) => Promise<{ audio: Buffer; chars: number; estimated: boolean; logId: string }>) {
  const dir = mkdtempSync(join(tmpdir(), 'dmreader-test-')), store = new Store(dir);
  let now = start, calls = 0;
  store.analytics = new Analytics(store.db, () => now);
  store.db.prepare("UPDATE analytics_meta SET value=? WHERE key='startedAt'").run(new Date(now).toISOString());
  store.set('settings', { ...store.settings(), cooldownSeconds: 0 });
  store.saveCredentials({ apiKey: 'mock-local-only', appId: '', accessKey: '' });
  const provider = { synthesize: async (input: Synthesis) => { calls++; return synthesize ? synthesize(input) : { audio: Buffer.from('mock'), chars: 7, estimated: false, logId: 'mock' }; }, design: async (speaker: string) => ({ status: 2, speaker_id: speaker }) };
  const engine = new Engine(store, provider, () => now); engine.claimPlayer('test');
  return { dir, store, engine, tick(ms: number) { now += ms; }, setTime(at: number) { now = at; }, calls: () => calls,
    report(range: 'today' | 'yesterday' | '7d' | '30d' = 'today') { return store.analytics.report(range, store.settings(), store.spent('seed-tts-2.0') + store.settings().usedBefore, store.spent('seed-icl-2.0')); },
    close() { store.close(); cleanup(dir); } };
}
function event(type: EventType, extra: object = {}) {
  const fields = { message: { message: '<b>你好🙂</b>' }, 'effect-message': { message: '晚上' }, gift: { giftName: '小心心', giftAmount: 3 }, superchat: { message: '支持主播', deleted: false }, toast: { toastType: 3, toastName: '舰长', toastAmount: 1, toastAmountUnit: '月' }, interaction: { action: 1 }, 'entry-effect': { message: '进场' }, 'like-click': { message: '点赞' } };
  return { type, id: randomUUID(), origin: 659719, uid: 10, username: '观众', ...fields[type], ...extra };
}

test('analytics counts valid real events once, all eight types, commands, invalid data and duplicates independently of speech switches', () => {
  const f = fixture(); try {
    f.store.set('settings', { ...f.store.settings(), commandFeedback: false, eventSpeech: Object.fromEntries(eventTypes.map(t => [t, false])) });
    const first = event('message'); f.engine.ingest(first); f.engine.ingest(first);
    f.engine.ingest(event('effect-message', { uid: 20 })); f.engine.ingest(event('gift', { uid: undefined }));
    f.engine.ingest(event('superchat', { uid: 30 })); f.engine.ingest(event('toast', { uid: 30 }));
    f.engine.ingest(event('interaction', { uid: 40 })); f.engine.ingest(event('entry-effect', { uid: 40 })); f.engine.ingest(event('like-click', { uid: 50 }));
    f.engine.ingest(event('message', { message: '#语速 9' }));
    f.engine.ingest(event('message', { uid: 0 }));
    f.engine.ingest(event('message', { origin: 123 })); f.engine.ingest({ type: 'not-supported', origin: 659719 });
    f.engine.ingest(event('message', { uid: 60 }), 'simulation');
    const report = f.report(), s = report.summary;
    assert.equal(s.received, 11); assert.equal(s.validEvents, 9); assert.equal(s.messages, 3); assert.equal(s.messageChars, 10);
    assert.equal(s.speakers, 2); assert.equal(s.interactingViewers, 5); assert.equal(s.commands, 1); assert.equal(s.commandErrors, 1);
    assert.equal(s.duplicates, 1); assert.equal(s.invalid, 1); assert.equal(s.simulatedEvents, 1);
    assert.equal(report.eventTypes.length, 8); assert.equal(report.outcomes.find(r => r.key === 'disabled')!.count, 8);
    assert.equal(f.calls(), 0); assert.equal(s.chars, 0); assert.equal(s.successRate, null); assert.equal(s.latency, null);
  } finally { f.close(); }
});

test('speech aggregates preserve simulation source through the player and include real previews, cache savings and conservative failure reservations', async () => {
  const f = fixture(async input => { if (input.text.includes('失败')) throw new Error('mock timeout'); return { audio: Buffer.from('mock'), chars: 7, estimated: false, logId: 'mock' }; });
  try {
    f.engine.ingest(event('message', { message: '本地模拟' }), 'simulation'); await f.engine.next('test');
    await f.engine.speak('测试正常', { source: 'preview' });
    await f.engine.speak('测试正常', { source: 'preview' });
    await assert.rejects(f.engine.speak('失败', { source: 'api' }));
    const r = f.report();
    assert.equal(r.summary.messages, 0); assert.equal(r.summary.simulatedEvents, 1);
    assert.equal(r.summary.successes, 2); assert.equal(r.summary.cached, 1); assert.equal(r.summary.failures, 1);
    assert.equal(r.summary.chars, 16); assert.equal(r.summary.savedChars, 7); assert.equal(r.summary.successRate, 2 / 3); assert.equal(r.summary.cacheRate, 1 / 3);
    assert.deepEqual(Object.fromEntries(r.speechSources.map(s => [s.key, s.count])), { preview: 2, api: 1, simulation: 1 });
    assert.equal(r.topVoices[0].count, 3); assert.equal(f.store.spent('seed-tts-2.0'), 16); assert.equal(f.calls(), 3);
  } finally { f.close(); }
});

test('UID deduplication spans hours and changed usernames, with separate room scope and exact local-midnight boundaries', () => {
  const f = fixture(); try {
    f.setTime(start - HOUR); f.engine.ingest(event('message', { username: '昨天的名字' }));
    f.setTime(start); f.engine.ingest(event('message', { username: '早上' }));
    f.tick(HOUR); f.engine.ingest(event('message', { username: '新名字' })); f.engine.ingest(event('message', { uid: 20 }));
    assert.equal(f.report().summary.messages, 3); assert.equal(f.report().summary.speakers, 2);
    assert.deepEqual(f.report().bins.map(b => b.activeViewers), [1, 2]);
    assert.equal(f.report().topViewers[0].username, '新名字'); assert.equal(f.report('yesterday').summary.messages, 1);
    assert.equal(f.report('7d').summary.messages, 4); assert.equal(f.report('7d').summary.speakers, 2);
    assert.equal(f.report('7d').bins.at(-1)!.activeViewers, 2);
    f.store.set('settings', { ...f.store.settings(), roomId: '123' }); f.engine.ingest(event('message', { origin: 123 }));
    assert.equal(f.report().summary.messages, 1); assert.equal(f.report().summary.speakers, 1);
    assert.equal(analyticsWindow('today', Date.parse('2030-10-02T00:00:00+08:00')).start, Date.parse('2030-10-01T16:00:00Z'));
    assert.equal(f.report('yesterday').bins.length, 24); assert.equal(f.report('30d').bins.length, 30);
  } finally { f.close(); }
});

test('success adjustment remains in dispatch hour and room even if request completes after midnight or room changes', async () => {
  let f: ReturnType<typeof fixture>;
  f = fixture(async () => { f.tick(HOUR); f.store.set('settings', { ...f.store.settings(), roomId: '123' }); return { audio: Buffer.from('mock'), chars: 3, estimated: false, logId: 'mock' }; });
  try {
    f.setTime(Date.parse('2030-10-02T23:30:00+08:00'));
    await f.engine.speak('测试扣费调整', { source: 'preview' });
    assert.equal(f.report().summary.chars, 0);
    f.store.set('settings', { ...f.store.settings(), roomId: '659719' });
    assert.equal(f.report().summary.chars, 0); assert.equal(f.report('yesterday').summary.chars, 3);
    assert.equal(f.report('yesterday').summary.successes, 1); assert.equal(f.report('yesterday').bins[23].chars, 3);
    assert.equal(f.store.spent('seed-tts-2.0'), 3);
  } finally { f.close(); }
});

test('historical usage remains in lifetime budgets while reporting only newly recorded period usage and separating resources', async () => {
  const f = fixture(); try {
    f.store.addUsage('seed-tts-2.0', 100);
    f.store.set('settings', { ...f.store.settings(), budget: 500, usedBefore: 20, cloneBudget: 50 });
    f.store.set('customVoices', [{ id: 'S_test', name: '测试专属', resource: 'seed-icl-2.0', gender: '专属', tag: '测试', description: '' }]);
    await f.engine.speak('标准音色', { source: 'preview' }); await f.engine.speak('专属音色', { source: 'preview', voice: 'S_test' });
    const r = f.report();
    assert.equal(r.summary.chars, 14); assert.equal(r.budget.standard.used, 127); assert.equal(r.budget.standard.remaining, 373);
    assert.equal(r.budget.custom.used, 7); assert.equal(r.budget.custom.remaining, 43);
    assert.equal(f.report('yesterday').summary.chars, 0); assert.deepEqual(f.report('yesterday').budget, r.budget);
    assert.equal(r.partialHistory, true); assert.equal(f.report('30d').partialHistory, true);
    await assert.rejects(f.engine.speak('应当拦截', { source: 'preview', voice: 'does-not-exist' }));
    assert.equal(f.report().summary.failures, 0);
  } finally { f.close(); }
});

test('aggregates survive log pruning and database reopen; 90-day retention prunes all hourly tables without changing lifetime usage', async () => {
  const f = fixture(); try {
    f.engine.ingest(event('message')); await f.engine.next('test');
    for (let i = 0; i < 3005; i++) f.store.log('test');
    assert.equal(f.store.logs(4000).length, 3000); assert.equal(f.report().summary.messages, 1);
    const reopened = new Store(f.dir);
    try { reopened.analytics = new Analytics(reopened.db, () => start); assert.equal(reopened.analytics.report('today', reopened.settings(), 7, 0).summary.messages, 1); }
    finally { reopened.close(); }
    f.tick(89 * DAY); f.report();
    assert.equal(f.store.db.prepare('SELECT SUM(count) n FROM analytics_events').get()!.n, 1);
    f.tick(DAY); f.report();
    for (const table of ['analytics_events', 'analytics_viewers', 'analytics_usage', 'analytics_speech']) assert.equal(f.store.db.prepare(`SELECT COUNT(*) n FROM ${table}`).get()!.n, 0);
    assert.equal(f.store.spent('seed-tts-2.0'), 7);
  } finally { f.close(); }
});

test('usage and analytics adjustment are atomic when either write fails', () => {
  const f = fixture(); try {
    f.store.db.exec("CREATE TRIGGER reject_analytics_usage BEFORE INSERT ON analytics_usage BEGIN SELECT RAISE(ABORT, 'mock full disk'); END");
    assert.throws(() => f.store.addUsage('seed-tts-2.0', 5, { at: start, room: '659719', source: 'preview' }));
    assert.equal(f.store.spent('seed-tts-2.0'), 0); assert.equal(f.report().summary.chars, 0);
  } finally { f.close(); }
});

test('analytics API requires admin authentication, validates period, and returns empty data without cloud requests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dmreader-test-')), service = createService({ dataDir: dir });
  service.server.listen(0, '127.0.0.1'); await once(service.server, 'listening');
  const address = service.server.address(); assert.ok(address && typeof address !== 'string'); const url = `http://127.0.0.1:${address.port}`;
  try {
    assert.equal((await fetch(`${url}/api/analytics`)).status, 401);
    const { adminToken } = await (await fetch(`${url}/api/bootstrap`)).json(); const headers = { 'X-DMReader-Admin': adminToken };
    assert.equal((await fetch(`${url}/api/analytics?range=all`, { headers })).status, 400);
    assert.equal((await fetch(`${url}/api/analytics?range=today&range=7d`, { headers })).status, 400);
    for (const range of ['today', 'yesterday', '7d', '30d']) {
      const response = await fetch(`${url}/api/analytics?range=${range}`, { headers }); assert.equal(response.status, 200);
      const body = await response.json(); assert.equal(body.range, range); assert.equal(body.summary.messages, 0); assert.equal(body.summary.chars, 0); assert.equal(body.summary.speakers, 0);
      assert.ok(body.bins.every((b: { messages: number; chars: number }) => b.messages === 0 && b.chars === 0));
      assert.ok(!JSON.stringify(body).includes(adminToken)); assert.equal(body.retentionDays, 90);
    }
  } finally { await service.close(); cleanup(dir); }
});
