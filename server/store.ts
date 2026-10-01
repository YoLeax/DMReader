import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { defaults, type Settings, type Viewer, type Credentials } from './types.js';

export class Store {
  db: DatabaseSync;
  private key: Buffer;
  constructor(public dir: string) {
    mkdirSync(dir, { recursive: true });
    const keyPath = join(dir, 'local.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600 });
    this.key = readFileSync(keyPath);
    this.db = new DatabaseSync(join(dir, 'dmreader.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS viewers (uid TEXT PRIMARY KEY, username TEXT NOT NULL, voice TEXT NOT NULL DEFAULT '', style TEXT NOT NULL DEFAULT '', speed INTEGER, muted INTEGER NOT NULL DEFAULT 0, locked INTEGER NOT NULL DEFAULT 0, updatedAt TEXT NOT NULL, lastSeen TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, kind TEXT NOT NULL, uid TEXT NOT NULL DEFAULT '', username TEXT NOT NULL DEFAULT '', text TEXT NOT NULL DEFAULT '', voice TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', chars INTEGER NOT NULL DEFAULT 0, latency INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS usage (resource TEXT PRIMARY KEY, chars INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, time INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS designs (id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, username TEXT NOT NULL, prompt TEXT NOT NULL, status TEXT NOT NULL, speaker TEXT UNIQUE, detail TEXT NOT NULL DEFAULT '', createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS logs_time ON logs(time);
    `);
    if (!this.db.prepare('PRAGMA table_info(logs)').all().some(c => c.name === 'eventType')) this.db.exec("ALTER TABLE logs ADD COLUMN eventType TEXT NOT NULL DEFAULT ''");
    if (!this.get('apiToken')) this.set('apiToken', randomBytes(24).toString('hex'));
    this.db.prepare("UPDATE designs SET status='uncertain',detail='服务在生成过程中重启，请先到火山控制台核对槽位；不会自动重试。' WHERE status='processing'").run();
    this.prune();
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM kv WHERE key=?').get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  set(key: string, value: unknown) { this.db.prepare('INSERT INTO kv VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, JSON.stringify(value)); }
  settings(): Settings {
    const saved = this.get<Partial<Settings>>('settings');
    return { ...defaults, ...saved, eventSpeech: { ...defaults.eventSpeech, ...saved?.eventSpeech }, interactionActions: { ...defaults.interactionActions, ...saved?.interactionActions } };
  }
  credentials(): Credentials {
    const encoded = this.get<string>('credentials');
    let saved: Partial<Credentials> = {};
    if (encoded) {
      const b = Buffer.from(encoded, 'base64');
      const c = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12)); c.setAuthTag(b.subarray(12, 28));
      saved = JSON.parse(Buffer.concat([c.update(b.subarray(28)), c.final()]).toString());
    }
    return { apiKey: process.env.DOUBAO_API_KEY || saved.apiKey || '', appId: process.env.DOUBAO_APP_ID || saved.appId || '', accessKey: process.env.DOUBAO_ACCESS_KEY || saved.accessKey || '' };
  }
  saveCredentials(value: Credentials) {
    const iv = randomBytes(12), c = createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    this.set('credentials', Buffer.concat([iv, c.getAuthTag(), encrypted]).toString('base64'));
  }
  viewer(uid: string): Viewer | undefined {
    const row = this.db.prepare('SELECT * FROM viewers WHERE uid=?').get(uid) as unknown as Viewer | undefined;
    return row ? { ...row, muted: !!row.muted, locked: !!row.locked } : undefined;
  }
  touch(uid: string, username: string): Viewer {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO viewers(uid,username,updatedAt,lastSeen) VALUES (?,?,?,?) ON CONFLICT(uid) DO UPDATE SET username=excluded.username,lastSeen=excluded.lastSeen').run(uid, username, now, now);
    return this.viewer(uid)!;
  }
  updateViewer(uid: string, patch: Partial<Viewer>) {
    const old = this.viewer(uid); if (!old) return;
    const v = { ...old, ...patch, uid, updatedAt: new Date().toISOString() };
    this.db.prepare('UPDATE viewers SET username=?,voice=?,style=?,speed=?,muted=?,locked=?,updatedAt=? WHERE uid=?').run(v.username, v.voice, v.style, v.speed, Number(v.muted), Number(v.locked), v.updatedAt, uid);
  }
  viewers(search = ''): Viewer[] {
    return (this.db.prepare('SELECT * FROM viewers WHERE username LIKE ? OR uid LIKE ? ORDER BY lastSeen DESC LIMIT 500').all(`%${search}%`, `%${search}%`) as unknown as Viewer[]).map(v => ({ ...v, muted: !!v.muted, locked: !!v.locked }));
  }
  log(kind: string, values: Partial<{ eventType: string; uid: string; username: string; text: string; voice: string; detail: string; chars: number; latency: number }> = {}) {
    const inserted = this.db.prepare('INSERT INTO logs(time,kind,eventType,uid,username,text,voice,detail,chars,latency) VALUES (?,?,?,?,?,?,?,?,?,?)').run(new Date().toISOString(), kind, values.eventType || '', values.uid || '', values.username || '', values.text || '', values.voice || '', values.detail || '', values.chars || 0, values.latency || 0);
    this.db.prepare('DELETE FROM logs WHERE id<=?').run(Number(inserted.lastInsertRowid) - 3000);
  }
  logs(limit = 100) { return this.db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit); }
  spent(resource: string): number { return (this.db.prepare('SELECT chars FROM usage WHERE resource=?').get(resource)?.chars as number) || 0; }
  addUsage(resource: string, chars: number) { this.db.prepare('INSERT INTO usage VALUES (?,?) ON CONFLICT(resource) DO UPDATE SET chars=chars+excluded.chars').run(resource, chars); }
  remember(id: string): boolean {
    const now = Date.now();
    const changed = this.db.prepare('INSERT INTO seen VALUES (?,?) ON CONFLICT(id) DO UPDATE SET time=excluded.time WHERE seen.time<?').run(id, now, now - 7 * 86400000).changes > 0;
    if (Math.random() < 0.01) this.prune();
    return changed;
  }
  prune() { this.db.prepare('DELETE FROM seen WHERE time<?').run(Date.now() - 7 * 86400000); this.db.exec('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT 3000)'); }
  close() { this.db.close(); }
}
