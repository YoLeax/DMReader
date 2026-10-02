import type { DatabaseSync } from 'node:sqlite';
import type { Settings, Voice } from './types.js';

export type AnalyticsRange = 'today' | 'yesterday' | '7d' | '30d';
export type AnalyticsSource = 'bridge' | 'simulation' | 'preview' | 'api';
export interface UsageContext { room: string; source: AnalyticsSource; at: number; }
interface Reception extends UsageContext { type: string; outcome: string; accepted: boolean; uid: string; username: string; chars: number; command: string; }
export const HOUR = 3600000, DAY = 24 * HOUR, RETENTION_DAYS = 90;
const OFFSET = 8 * HOUR;
export const analyticsSource = (s: string): AnalyticsSource => s === 'bridge' || s === 'preview' || s === 'api' ? s : 'simulation';
export function analyticsWindow(range: AnalyticsRange, now: number) {
  const today = Math.floor((now + OFFSET) / DAY) * DAY - OFFSET;
  const start = range === 'yesterday' ? today - DAY : range === '7d' ? today - 6 * DAY : range === '30d' ? today - 29 * DAY : today;
  return { start, end: range === 'yesterday' ? today : now + 1, step: range === 'today' || range === 'yesterday' ? HOUR : DAY };
}
export function receptionOutcome(result: { duplicate?: boolean; command?: string; queued?: boolean; skipped?: string }) {
  if (result.duplicate) return 'duplicate';
  if (result.command) return 'command';
  if (result.queued) return 'queued';
  const why = result.skipped || '';
  if (why === '关闭播报') return 'disabled';
  if (why === '冷却跳过') return 'cooldown';
  if (why === '播放器未开启') return 'no-player';
  if (why === '该观众已静音') return 'muted';
  if (why === '播报已暂停') return 'paused';
  if (why === '队列已满') return 'queue-full';
  if (why === '命中屏蔽词') return 'blocked';
  if (why === '当前为兼容 API 模式') return 'api-mode';
  if (why === '醒目留言已删除') return 'deleted';
  if (/^超过 \d+ 字限制$/.test(why)) return 'too-long';
  return 'invalid';
}

export class Analytics {
  private lastPrunedDay = -1;
  constructor(private db: DatabaseSync, private now = Date.now) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS analytics_events (
        bucket INTEGER, room TEXT, source TEXT, type TEXT, outcome TEXT, command TEXT,
        count INTEGER NOT NULL, accepted INTEGER NOT NULL, chars INTEGER NOT NULL,
        PRIMARY KEY(room,bucket,source,type,outcome,command));
      CREATE TABLE IF NOT EXISTS analytics_viewers (
        bucket INTEGER, room TEXT, source TEXT, uid TEXT, username TEXT,
        messages INTEGER NOT NULL, chars INTEGER NOT NULL, events INTEGER NOT NULL,
        PRIMARY KEY(room,bucket,source,uid));
      CREATE TABLE IF NOT EXISTS analytics_speech (
        bucket INTEGER, room TEXT, source TEXT, resource TEXT, voice TEXT, name TEXT, outcome TEXT,
        count INTEGER NOT NULL, saved INTEGER NOT NULL, latency INTEGER NOT NULL,
        PRIMARY KEY(room,bucket,source,resource,voice,outcome));
      CREATE TABLE IF NOT EXISTS analytics_usage (
        bucket INTEGER, room TEXT, source TEXT, resource TEXT, chars INTEGER NOT NULL,
        PRIMARY KEY(room,bucket,source,resource));
    `);
    db.prepare('INSERT OR IGNORE INTO analytics_meta VALUES (?,?)').run('startedAt', new Date(now()).toISOString());
    this.prune();
  }
  prune() {
    const day = Math.floor((this.now() + OFFSET) / DAY);
    if (day === this.lastPrunedDay) return;
    const before = Math.floor((this.now() + OFFSET) / DAY) * DAY - OFFSET - (RETENTION_DAYS - 1) * DAY;
    for (const table of ['analytics_events', 'analytics_viewers', 'analytics_speech', 'analytics_usage']) this.db.prepare(`DELETE FROM ${table} WHERE bucket<?`).run(before);
    this.lastPrunedDay = day;
  }
  reception(e: Reception) {
    this.prune();
    const bucket = Math.floor(e.at / HOUR) * HOUR;
    const isMessage = e.type === 'message' || e.type === 'effect-message';
    this.db.exec('SAVEPOINT record_reception');
    try {
      this.db.prepare(`INSERT INTO analytics_events VALUES (?,?,?,?,?,?,1,?,?)
        ON CONFLICT(room,bucket,source,type,outcome,command) DO UPDATE SET count=count+1,accepted=accepted+excluded.accepted,chars=chars+excluded.chars`)
        .run(bucket, e.room, e.source, e.type, e.outcome, e.command, Number(e.accepted), e.accepted ? e.chars : 0);
      if (e.accepted && e.uid) this.db.prepare(`INSERT INTO analytics_viewers VALUES (?,?,?,?,?,?,?,1)
        ON CONFLICT(room,bucket,source,uid) DO UPDATE SET username=excluded.username,messages=messages+excluded.messages,chars=chars+excluded.chars,events=events+1`)
        .run(bucket, e.room, e.source, e.uid, e.username, Number(isMessage), isMessage ? e.chars : 0);
      this.db.exec('RELEASE record_reception');
    } catch (error) { this.db.exec('ROLLBACK TO record_reception; RELEASE record_reception'); throw error; }
  }
  usage(context: UsageContext, resource: string, chars: number) {
    this.prune();
    this.db.prepare(`INSERT INTO analytics_usage VALUES (?,?,?,?,?) ON CONFLICT(room,bucket,source,resource) DO UPDATE SET chars=chars+excluded.chars`)
      .run(Math.floor(context.at / HOUR) * HOUR, context.room, context.source, resource, chars);
  }
  speech(context: UsageContext, voice: Voice, outcome: 'success' | 'failure' | 'cached', latency: number, saved = 0) {
    this.prune();
    this.db.prepare(`INSERT INTO analytics_speech VALUES (?,?,?,?,?,?,?,1,?,?)
      ON CONFLICT(room,bucket,source,resource,voice,outcome) DO UPDATE SET name=excluded.name,count=count+1,saved=saved+excluded.saved,latency=latency+excluded.latency`)
      .run(Math.floor(context.at / HOUR) * HOUR, context.room, context.source, voice.resource, voice.id, voice.name, outcome, saved, latency);
  }
  report(range: AnalyticsRange, settings: Settings, used: number, cloneUsed: number) {
    this.prune();
    const now = this.now(), { start, end, step } = analyticsWindow(range, now), room = settings.roomId;
    const query = <T>(sql: string) => this.db.prepare(sql).all(room, start, end) as unknown as T[];
    const events = query<{ bucket: number; source: string; type: string; outcome: string; command: string; count: number; accepted: number; chars: number }>('SELECT * FROM analytics_events WHERE room=? AND bucket>=? AND bucket<?');
    const speech = query<{ bucket: number; source: string; voice: string; name: string; outcome: string; count: number; saved: number; latency: number }>('SELECT * FROM analytics_speech WHERE room=? AND bucket>=? AND bucket<?');
    const usage = query<{ bucket: number; source: string; chars: number }>('SELECT bucket,source,chars FROM analytics_usage WHERE room=? AND bucket>=? AND bucket<?');
    const live = events.filter(e => e.source === 'bridge');
    const message = (e: { type: string }) => e.type === 'message' || e.type === 'effect-message';
    const sum = <T>(rows: T[], value: (r: T) => number) => rows.reduce((total, row) => total + value(row), 0);
    const liveViewers = query<{ uid: string; username: string; messages: number; chars: number; events: number }>(`SELECT a.uid,
      (SELECT username FROM analytics_viewers b WHERE b.room=a.room AND b.source='bridge' AND b.uid=a.uid AND b.bucket>=${start} AND b.bucket<${end} ORDER BY b.bucket DESC LIMIT 1) AS username,
      SUM(a.messages) AS messages,SUM(a.chars) AS chars,SUM(a.events) AS events FROM analytics_viewers a
      WHERE a.room=? AND a.bucket>=? AND a.bucket<? AND a.source='bridge' GROUP BY a.uid ORDER BY messages DESC,events DESC,a.uid`);
    const active = new Map<number, number>();
    const viewerBuckets = query<{ bucket: number; active: number }>(`SELECT ${start}+CAST((bucket-${start})/${step} AS INTEGER)*${step} AS bucket,COUNT(DISTINCT uid) AS active
      FROM analytics_viewers WHERE room=? AND bucket>=? AND bucket<? AND source='bridge' AND messages>0 GROUP BY 1`);
    for (const row of viewerBuckets) active.set(row.bucket, row.active);
    const bins = Array.from({ length: Math.ceil((end - start) / step) }, (_, i) => ({ at: start + i * step, messages: 0, activeViewers: active.get(start + i * step) || 0, events: 0, chars: 0, success: 0, failure: 0, cached: 0 }));
    const bin = (bucket: number) => bins[Math.floor((bucket - start) / step)];
    for (const row of live) { bin(row.bucket).events += row.accepted; if (message(row)) bin(row.bucket).messages += row.accepted; }
    for (const row of usage) bin(row.bucket).chars += row.chars;
    for (const row of speech) if (row.outcome === 'success' || row.outcome === 'failure' || row.outcome === 'cached') bin(row.bucket)[row.outcome] += row.count;
    const aggregate = <T>(rows: T[], key: (r: T) => string, value: (r: T) => number) => {
      const grouped = new Map<string, number>(); for (const row of rows) grouped.set(key(row), (grouped.get(key(row)) || 0) + value(row));
      return [...grouped].map(([key, count]) => ({ key, count })).filter(r => r.count > 0).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
    };
    const successes = sum(speech.filter(s => s.outcome === 'success'), s => s.count), failures = sum(speech.filter(s => s.outcome === 'failure'), s => s.count), cached = sum(speech.filter(s => s.outcome === 'cached'), s => s.count);
    const topVoices = aggregate(speech.filter(s => s.outcome !== 'failure'), s => s.voice, s => s.count).slice(0, 6).map(v => ({ ...v, name: speech.filter(s => s.voice === v.key).sort((a, b) => b.bucket - a.bucket)[0].name }));
    const startedAt = this.db.prepare("SELECT value FROM analytics_meta WHERE key='startedAt'").get()!.value as string;
    return {
      range, room, start: new Date(start).toISOString(), end: new Date(end - 1).toISOString(), generatedAt: new Date(now).toISOString(), timezone: 'Asia/Hong_Kong', startedAt,
      retentionDays: RETENTION_DAYS, partialHistory: Date.parse(startedAt) > start, step,
      summary: { received: sum(live, e => e.count), validEvents: sum(live, e => e.accepted), messages: sum(live.filter(message), e => e.accepted), messageChars: sum(live.filter(message), e => e.chars),
        speakers: liveViewers.filter(v => v.messages > 0).length, interactingViewers: liveViewers.length, commands: sum(live.filter(e => !!e.command), e => e.accepted),
        commandErrors: sum(live.filter(e => e.outcome === 'command-error'), e => e.count), duplicates: sum(live.filter(e => e.outcome === 'duplicate'), e => e.count), invalid: sum(live.filter(e => e.outcome === 'invalid'), e => e.count),
        simulatedEvents: sum(events.filter(e => e.source !== 'bridge'), e => e.count), successes, failures, cached, chars: sum(usage, u => u.chars),
        savedChars: sum(speech, s => s.saved), successRate: successes + failures ? successes / (successes + failures) : null,
        cacheRate: successes + cached ? cached / (successes + cached) : null, latency: successes ? sum(speech.filter(s => s.outcome === 'success'), s => s.latency) / successes : null },
      bins, eventTypes: aggregate(live, e => e.type, e => e.accepted), outcomes: aggregate(live, e => e.outcome, e => e.count), commandTypes: aggregate(live, e => e.command, e => e.command ? e.accepted : 0),
      speechSources: aggregate(speech, s => s.source, s => s.count), topViewers: liveViewers.filter(v => v.messages > 0).slice(0, 8), topVoices,
      budget: { standard: { limit: settings.budget, used, remaining: Math.max(0, settings.budget - used) }, custom: { limit: settings.cloneBudget, used: cloneUsed, remaining: Math.max(0, settings.cloneBudget - cloneUsed) } },
    };
  }
}
export type AnalyticsReport = ReturnType<Analytics['report']>;
