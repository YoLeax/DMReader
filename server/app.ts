import express, { type Request, type Response, type NextFunction } from 'express';
import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { z, ZodError } from 'zod';
import { Store } from './store.js';
import { Engine, identity, parseCommand } from './engine.js';
import { DoubaoProvider, silentWav } from './provider.js';
import { AppError, type Voice } from './types.js';
import { eventTypes, type EventType, type InteractionAction } from '../shared/events.js';

const localHost = /^(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i;
const localOrigin = (value: string) => /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(value);
function matches(a: unknown, b: string) { return typeof a === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b)); }
const text = (max: number) => z.string().max(max);
const speed = z.number().int().min(-50).max(100);
const viewerPatch = z.object({ username: text(100).min(1).optional(), voice: text(150).optional(), style: text(400).optional(), speed: speed.nullable().optional(), muted: z.boolean().optional(), locked: z.boolean().optional() }).strict();
const settingsPatch = z.object({
  enabled: z.boolean(), mode: z.enum(['bridge', 'api']), roomId: z.string().regex(/^\d{1,20}$/), defaultVoice: text(150).min(1),
  defaultStyle: text(400), speechRate: speed, maxChars: z.number().int().min(5).max(500), maxQueue: z.number().int().min(1).max(50),
  cooldownSeconds: z.number().int().min(0).max(300), allowStyles: z.boolean(), allowDesignRequests: z.boolean(), announceUsername: z.boolean(),
  budget: z.number().int().min(0).max(100000000), usedBefore: z.number().int().min(0).max(100000000), cloneBudget: z.number().int().min(0).max(100000000),
  blockedWords: text(5000), allowedOrigins: z.array(z.string().url().refine(v => new URL(v).origin === v && new URL(v).protocol === 'https:', '请填写不带路径的 HTTPS 来源')).max(10),
  eventSpeech: z.object(Object.fromEntries(eventTypes.map(type => [type, z.boolean()])) as Record<EventType, z.ZodBoolean>).partial().strict(),
  interactionActions: z.object(Object.fromEntries(['1', '2', '3', '4', '5'].map(action => [action, z.boolean()])) as Record<InteractionAction, z.ZodBoolean>).partial().strict(),
  commandFeedback: z.boolean(), giftCooldownSeconds: z.number().int().min(1).max(300), likeCooldownSeconds: z.number().int().min(1).max(300), entryCooldownSeconds: z.number().int().min(10).max(600),
}).partial().strict();
const sessionSchema = z.object({ session: z.string().uuid() });

export function createService(options: { dataDir: string; distDir?: string; provider?: Pick<DoubaoProvider, 'synthesize' | 'design'> }) {
  const store = new Store(options.dataDir);
  const engine = new Engine(store, options.provider || new DoubaoProvider(() => store.credentials()));
  const app = express();
  const server = createServer(app);
  const adminToken = randomBytes(32).toString('hex');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    if (!localHost.test(req.headers.host || '')) return res.status(403).json({ error: '仅允许通过 localhost 或 127.0.0.1 访问。' });
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'Cross-Origin-Resource-Policy': 'same-origin' });
    next();
  });
  app.use('/v1', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin && !localOrigin(origin) && !store.settings().allowedOrigins.includes(origin)) return res.status(403).json({ error: '该网页来源未在允许列表中。' });
    if (origin) res.set({ 'Access-Control-Allow-Origin': origin, Vary: 'Origin' });
    res.set({ 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Private-Network': 'true', 'Cross-Origin-Resource-Policy': 'cross-origin' });
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '1mb', strict: true }));
  app.get('/health', (_req, res) => res.json({ app: 'dmreader', version: '0.1.0' }));
  app.use('/api', (req, res, next) => {
    if (req.headers.origin && !localOrigin(req.headers.origin) || req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({ error: '管理接口只允许本机后台访问。' });
    if (req.path === '/bootstrap' && req.method === 'GET') return next();
    if (!matches(req.headers['x-dmreader-admin'], adminToken)) return res.status(401).json({ error: '后台会话已失效，请刷新页面。' });
    next();
  });
  app.get('/api/bootstrap', (_req, res) => res.json({ adminToken, status: engine.status() }));
  app.get('/api/status', (_req, res) => res.json(engine.status()));
  app.get('/api/voices', (_req, res) => res.json(engine.voices()));
  app.get('/api/logs', (_req, res) => res.json(store.logs(200)));
  app.get('/api/event', (req, res) => res.json(engine.recentEvent(typeof req.query.type === 'string' ? req.query.type : undefined)));
  app.get('/api/events', (_req, res) => res.json(engine.recentEvents()));
  app.get('/api/viewers', (req, res) => res.json(store.viewers(String(req.query.search || '').slice(0, 100))));
  app.patch('/api/viewers/:uid', (req, res) => {
    if (!store.viewer(req.params.uid)) throw new AppError('观众不存在。', 404);
    const patch = viewerPatch.parse(req.body);
    if (patch.voice && !engine.voice(patch.voice)) throw new AppError('音色不存在。');
    store.updateViewer(req.params.uid, patch); res.json(store.viewer(req.params.uid));
  });
  app.patch('/api/settings', (req, res) => {
    const patch = settingsPatch.parse(req.body);
    if (patch.defaultVoice && !engine.voice(patch.defaultVoice)) throw new AppError('默认音色不存在。');
    const current = store.settings();
    store.set('settings', { ...current, ...patch, eventSpeech: { ...current.eventSpeech, ...patch.eventSpeech }, interactionActions: { ...current.interactionActions, ...patch.interactionActions } });
    if (patch.enabled === false || patch.mode || patch.roomId) engine.clearQueue();
    res.json(store.settings());
  });
  app.get('/api/connection', (_req, res) => res.json({ apiToken: store.get('apiToken'), configured: engine.status().configured, credentialSource: process.env.DOUBAO_API_KEY || process.env.DOUBAO_ACCESS_KEY ? 'environment' : 'local' }));
  app.post('/api/credentials', (req, res) => {
    const c = z.object({ apiKey: text(2000).default(''), appId: text(200).default(''), accessKey: text(2000).default('') }).strict().parse(req.body);
    if (!c.apiKey.trim() && !(c.appId.trim() && c.accessKey.trim())) throw new AppError('请填写 API Key，或完整的 App ID 与 Access Token。');
    store.saveCredentials({ apiKey: c.apiKey.trim(), appId: c.appId.trim(), accessKey: c.accessKey.trim() });
    res.json({ ok: true });
  });
  app.post('/api/preview', async (req, res) => {
    const input = z.object({ text: text(1000).min(1), voice: text(150).optional(), style: text(400).optional(), speed: speed.optional() }).parse(req.body);
    const result = await engine.speak(input.text, { ...input, source: 'preview' });
    res.type('audio/mpeg').send(result.audio);
  });
  app.post('/api/simulate', (req, res) => {
    const input = z.object({ uid: text(100), username: text(100), text: text(5000) }).parse(req.body);
    if (!identity(input.uid)) throw new AppError('请填写有效 UID。');
    res.json(engine.ingest({ type: 'message', origin: store.settings().roomId, id: randomUUID(), uid: input.uid, username: input.username, message: input.text }, 'simulation'));
  });
  app.post('/api/simulate-event', (req, res) => res.json(engine.ingest(req.body, 'simulation')));
  for (const action of ['claim', 'heartbeat', 'release']) app.post(`/api/player/${action}`, (req, res) => {
    const { session } = sessionSchema.parse(req.body);
    if (action === 'release') engine.releasePlayer(session); else engine.claimPlayer(session);
    res.json({ ok: true });
  });
  app.post('/api/player/next', async (req, res) => {
    const { session } = sessionSchema.parse(req.body), result = await engine.next(session);
    if (!result) return res.sendStatus(204);
    res.set('X-DMReader-Job', encodeURIComponent(JSON.stringify({ ...result.job, voice: result.voice })));
    res.type('audio/mpeg').send(result.audio);
  });
  app.post('/api/queue/clear', (_req, res) => res.json({ cleared: engine.clearQueue() }));
  app.get('/api/designs', (_req, res) => res.json(engine.designs()));
  app.post('/api/designs/:id/approve', async (req, res) => {
    const input = z.object({ speaker: z.string().regex(/^S_[a-zA-Z0-9_-]{3,100}$/), confirmEmptySlot: z.literal(true) }).parse(req.body);
    await engine.approveDesign(Number(req.params.id), input.speaker); res.json({ ok: true });
  });
  app.post('/api/designs/:id/reject', (req, res) => {
    const changed = store.db.prepare("UPDATE designs SET status='rejected',detail='主播已拒绝申请',updatedAt=? WHERE id=? AND status='pending'").run(new Date().toISOString(), Number(req.params.id));
    if (!changed.changes) throw new AppError('只可拒绝待审核申请。', 409);
    res.json({ ok: true });
  });
  // Manual recovery never triggers cloud generation. The host checks the uncertain slot in the console first.
  app.post('/api/designs/:id/resolve', (req, res) => {
    const { ready } = z.object({ ready: z.boolean() }).parse(req.body);
    const request = engine.designs().find(d => d.id === Number(req.params.id));
    if (!request || request.status !== 'uncertain' || !request.speaker) throw new AppError('没有待核对的槽位。');
    if (ready) {
      if (!engine.voice(request.speaker)) store.set('customVoices', [...(store.get<Voice[]>('customVoices') || []), { id: request.speaker, name: `${request.username}的专属音色`, gender: '专属', tag: '文字设计', description: request.prompt, resource: 'seed-icl-2.0' }]);
      store.updateViewer(request.uid, { voice: request.speaker });
    }
    store.db.prepare('UPDATE designs SET status=?,detail=?,updatedAt=? WHERE id=?').run(ready ? 'ready' : 'rejected', ready ? '主播已在云端核对并手动绑定' : '主播确认失败；槽位记录保留，避免再次覆盖', new Date().toISOString(), request.id);
    res.json({ ok: true });
  });
  app.get('/api/backup', (_req, res) => {
    const viewers = store.db.prepare('SELECT * FROM viewers').all().map(v => ({ ...v, muted: !!v.muted, locked: !!v.locked }));
    res.set('Content-Disposition', 'attachment; filename="dmreader-profiles.json"').json({ version: 1, exportedAt: new Date().toISOString(), viewers, customVoices: store.get('customVoices') || [] });
  });
  app.post('/api/backup', (req, res) => {
    const input = z.object({ version: z.literal(1), viewers: z.array(viewerPatch.extend({ uid: text(100).refine(v => !!identity(v)) }).strip()).max(10000), customVoices: z.array(z.object({ id: z.string().regex(/^S_[a-zA-Z0-9_-]{3,100}$/), name: text(150), gender: text(20), tag: text(30), description: text(400), resource: z.literal('seed-icl-2.0') })).max(1000).default([]) }).parse(req.body);
    const known = new Map(engine.voices().map(v => [v.id, v]));
    for (const v of input.customVoices) if (!known.has(v.id)) known.set(v.id, v);
    if (input.viewers.some(v => v.voice && !known.has(v.voice))) throw new AppError('备份中包含未知音色，未导入。');
    store.db.exec('BEGIN');
    try {
      store.set('customVoices', [...known.values()].filter(v => v.resource === 'seed-icl-2.0'));
      for (const v of input.viewers) { store.touch(v.uid, v.username || v.uid); store.updateViewer(v.uid, v); }
      store.db.exec('COMMIT');
    } catch (e) { store.db.exec('ROLLBACK'); throw e; }
    res.json({ imported: input.viewers.length });
  });
  app.post('/v1/tts', async (req, res) => {
    const input = z.object({ token: text(200), text: text(5000), voice: text(150).optional(), instructions: text(400).optional(), uid: z.union([z.string(), z.number()]).optional(), username: text(100).optional() }).parse(req.body);
    if (!matches(input.token, store.get<string>('apiToken')!)) throw new AppError('API 密钥不正确。', 401);
    // LAPLACE has no UID in this API. Bridge mode must own playback to prevent duplicates.
    if (store.settings().mode === 'bridge') return res.type('audio/wav').send(silentWav());
    const uid = identity(input.uid) || undefined;
    if (uid) store.touch(uid, input.username || uid);
    if (parseCommand(input.text)) {
      if (uid) engine.command(store.viewer(uid)!, input.text);
      return res.type('audio/wav').send(silentWav());
    }
    const result = await engine.speak(input.text, { uid, username: input.username, voice: input.voice, style: input.instructions, source: 'api' });
    res.type('audio/mpeg').send(result.audio);
  });
  const distDir = resolve(options.distDir || 'dist');
  app.use(express.static(distDir));
  app.get(['/', '/player'], (_req, res) => {
    if (!existsSync(resolve(distDir, 'index.html'))) return res.status(503).send('请先运行 npm run build，或通过开发服务 http://127.0.0.1:5173 访问。');
    res.sendFile(resolve(distDir, 'index.html'));
  });
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = err instanceof AppError ? err.status : err instanceof ZodError || err instanceof SyntaxError ? 400 : 500;
    res.status(status).json({ error: err instanceof AppError ? err.message : err instanceof ZodError ? `输入格式不正确：${err.issues.map(i => `${i.path.join('.')} ${i.message}`).join('；').slice(0, 600)}` : status === 400 ? '请求 JSON 格式不正确。' : '服务处理失败，请检查本地数据目录及服务日志。' });
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024, handleProtocols: protocols => protocols.has('laplace-event-bridge-role-server') ? 'laplace-event-bridge-role-server' : false });
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const protocols = (req.headers['sec-websocket-protocol'] || '').split(',').map(s => s.trim());
    const origin = req.headers.origin;
    const validOrigin = !origin || localOrigin(origin) || store.settings().allowedOrigins.includes(origin);
    if (!localHost.test(req.headers.host || '') || !validOrigin || !['/', '/bridge'].includes(url.pathname) || !protocols.includes('laplace-event-bridge-role-server') || !matches(protocols[1] || url.searchParams.get('token'), store.get<string>('apiToken')!)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', ws => {
    engine.bridgeConnections++;
    ws.send(JSON.stringify({ type: 'established', clientId: `server-${randomUUID()}`, isServer: true, message: 'DM Reader connected' }));
    let alive = true, events = 0, windowStart = Date.now();
    ws.on('pong', () => { alive = true; });
    const heartbeat = setInterval(() => { if (!alive) return ws.terminate(); alive = false; ws.ping(); }, 30000);
    ws.on('message', raw => {
      try {
        if (Date.now() - windowStart >= 1000) { events = 0; windowStart = Date.now(); }
        if (++events > 200) return;
        const data = JSON.parse(raw.toString());
        if (data.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
        engine.ingest(data);
        ws.send(JSON.stringify({ type: 'broadcast-success', clientCount: 1, timestamp: new Date().toISOString() }));
      } catch { store.log('bridge-error', { detail: '收到无法解析的事件，已忽略；请检查 LAPLACE 事件格式。' }); }
    });
    ws.on('error', () => {});
    ws.on('close', () => { clearInterval(heartbeat); engine.bridgeConnections--; });
  });
  async function close() {
    for (const client of wss.clients) if (client.readyState !== WebSocket.CLOSED) client.terminate();
    await new Promise<void>(r => wss.close(() => r()));
    if (server.listening) await new Promise<void>(r => server.close(() => r()));
    store.close();
  }
  return { app, server, store, engine, close };
}
