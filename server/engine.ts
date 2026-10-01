import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.js';
import { AppError, type Viewer, type Voice } from './types.js';
import { eventSchema, identity, supportedEvent, inspectEvent, eventKey, eventText, cleanText, boundedText, type ParsedEvent } from './events.js';
import { type EventType, type InteractionAction } from '../shared/events.js';
export { identity } from './events.js';
import { authHeaders, type AudioResult, type Synthesis, DoubaoProvider } from './provider.js';
import { voices } from './voices.js';

export interface Job { id: string; uid: string; username: string; text: string; created: number; eventType: EventType | 'command'; action?: InteractionAction; announceName: boolean; }
interface IngestResult { ignored?: boolean; duplicate?: boolean; queued?: boolean; skipped?: string; command?: string; }
interface EventSnapshot { receivedAt: string; source: string; fields: string[]; event: Record<string, unknown>; result?: IngestResult; }
export interface Design { id: number; uid: string; username: string; prompt: string; status: string; speaker: string | null; detail: string; createdAt: string; updatedAt: string; }
export const HELP = '#音色 名称 · #风格 描述 · #语速 1.2 · #定制 描述 · #查询 · #重置';
export function parseCommand(text: string) {
  const m = text.trim().match(/^[#＃!！](音色列表|我的音色|查询|音色|风格|语速|重置|定制|帮助)(?:\s+([\s\S]*))?$/u);
  return m ? { name: m[1], arg: (m[2] || '').trim() } : null;
}
export class Engine {
  queue: Job[] = [];
  bridgeConnections = 0;
  lastEventAt: string | null = null;
  private lease: { id: string; expires: number } | null = null;
  private playerBusy = false;
  private cache = new Map<string, { result: AudioResult; time: number }>();
  private cacheBytes = 0;
  private tail = Promise.resolve();
  private pending = 0;
  private rate: number[] = [];
  private cooldowns = new Map<string, number>();
  private latest = new Map<EventType, EventSnapshot>();
  private lastEvent: EventSnapshot | null = null;
  constructor(public store: Store, public provider: Pick<DoubaoProvider, 'synthesize' | 'design'>, private now = Date.now) {}
  recentEvent(type?: string) { return type && supportedEvent(type) ? this.latest.get(type) || null : this.lastEvent; }
  recentEvents() { return Object.fromEntries(this.latest); }
  voices(): Voice[] { return [...voices, ...(this.store.get<Voice[]>('customVoices') || [])]; }
  voice(id: string) { return this.voices().find(v => v.id === id || v.name.toLowerCase() === id.replace(/\s+2\.0$/, '').toLowerCase()); }
  playerActive() { return !!this.lease && this.lease.expires > Date.now(); }
  claimPlayer(id: string) {
    if (this.playerActive() && this.lease!.id !== id) throw new AppError('另一个页面正在播放。请先在那个页面停止播放，或等待 20 秒释放。', 409);
    if (!this.playerActive()) this.clearQueue();
    this.lease = { id, expires: Date.now() + 20000 };
  }
  releasePlayer(id: string) { if (this.lease?.id === id) { this.lease = null; this.clearQueue(); } }
  clearQueue() { const count = this.queue.length; this.queue = []; return count; }
  ingest(raw: unknown, source = 'bridge'): IngestResult {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ignored: true };
    const data = raw as Record<string, unknown>, s = this.store.settings();
    if (String(data.origin) !== s.roomId || !supportedEvent(data.type)) return { ignored: true };
    this.lastEventAt = new Date().toISOString();
    const snapshot: EventSnapshot = { receivedAt: this.lastEventAt, source, fields: Object.keys(data).slice(0, 150), event: inspectEvent(data) };
    this.latest.set(data.type, snapshot); this.lastEvent = snapshot;
    const finish = (result: IngestResult) => { snapshot.result = result; return result; };
    const log = (kind: string, detail: string, text = '') => this.store.log(kind, { eventType: String(data.type), uid: identity(data.uid) || '', username: typeof data.username === 'string' ? boundedText(cleanText(data.username), 100) : '', text, detail: `${source === 'simulation' ? '本地模拟 · ' : ''}${detail}` });
    const parsed = eventSchema.safeParse(data);
    if (!parsed.success) { const detail = `字段异常：${parsed.error.issues.map(i => i.path.join('.')).join('、')}`; log('invalid', detail); return finish({ skipped: detail }); }
    const event = parsed.data, key = eventKey(event);
    if (!key) { log('invalid', '缺少可靠事件 ID，无法去重'); return finish({ skipped: '缺少可靠事件 ID' }); }
    if (!this.store.remember(key)) { log('duplicate', '重复事件，未进入队列'); return finish({ duplicate: true }); }
    const uid = identity(event.uid), existing = uid ? this.store.viewer(uid) : undefined;
    const username = boundedText(cleanText(event.username || '') || cleanText(existing?.username || '') || '一位观众', 100);
    const isMessage = event.type === 'message' || event.type === 'effect-message';
    const rawText = isMessage ? cleanText(event.message) : '';
    if (!uid && (event.type === 'message' || isMessage && parseCommand(rawText))) {
      log('invalid', '缺少有效 UID，未按昵称关联偏好或执行指令', rawText); return finish({ ignored: true });
    }
    const viewer = uid ? this.store.touch(uid, username) : undefined;
    if (isMessage && parseCommand(rawText)) {
      try {
        const detail = this.command(viewer!, rawText);
        const response = this.commandSpeech(this.store.viewer(uid!)!, rawText);
        if (response) this.enqueue({ uid: uid!, username, text: boundedText(response, s.maxChars), eventType: 'command', announceName: false }, ['查询', '我的音色'].includes(parseCommand(rawText)!.name) ? [`query:${s.roomId}:${uid}`, Math.max(10, s.cooldownSeconds)] : undefined);
        return finish({ command: detail });
      } catch (e) { const detail = e instanceof Error ? e.message : '指令失败'; log('command-error', detail, rawText); return finish({ command: detail }); }
    }
    const text = eventText(event, boundedText(username, 40));
    if (!text) { log('invalid', '缺少可朗读的文字或礼物名称'); return finish({ skipped: '没有有效播报文案' }); }
    if (event.type === 'superchat' && event.deleted) { log('skipped', '醒目留言已删除', text); return finish({ skipped: '醒目留言已删除' }); }
    if (!uid) log('identity-fallback', '缺少可靠 UID，使用直播间默认声音；未按昵称关联档案', text);
    return finish(this.enqueue({ uid: uid || '', username, text, eventType: event.type, action: event.type === 'interaction' ? String(event.action) as InteractionAction : undefined, announceName: isMessage }, this.eventCooldown(event, uid)));
  }
  private eventCooldown(event: ParsedEvent, uid: string | null): [string, number] | undefined {
    const s = this.store.settings(), who = uid || 'anonymous';
    if (event.type === 'gift') return [JSON.stringify([s.roomId, 'gift', who, event.giftId ?? cleanText(event.giftName), identity(event.receiver?.uid) || 'room']), s.giftCooldownSeconds];
    if (event.type === 'like-click') return [`${s.roomId}:like:${who}`, s.likeCooldownSeconds];
    if (event.type === 'entry-effect' || event.type === 'interaction' && event.action === 1) return [`${s.roomId}:entry:${who}`, s.entryCooldownSeconds];
    if (event.type === 'interaction') return [`${s.roomId}:interaction:${event.action}:${who}`, 10];
  }
  private disabled(job: Pick<Job, 'eventType' | 'action'>) {
    const s = this.store.settings();
    return job.eventType === 'command' ? !s.commandFeedback : !s.eventSpeech[job.eventType] || job.eventType === 'interaction' && !s.interactionActions[job.action!];
  }
  private enqueue(input: Omit<Job, 'id' | 'created'>, cooldown?: [string, number]): IngestResult {
    const s = this.store.settings();
    if (this.disabled(input)) { this.store.log('disabled', { ...input, detail: '关闭播报；事件已接收，未调用合成' }); return { skipped: '关闭播报' }; }
    const reason = s.mode !== 'bridge' ? '当前为兼容 API 模式' : !s.enabled ? '播报已暂停' : this.store.viewer(input.uid)?.muted ? '该观众已静音' : !this.playerActive() ? '播放器未开启' : this.blocked(input.text) ? '命中屏蔽词' : Array.from(input.text).length > s.maxChars ? `超过 ${s.maxChars} 字限制` : this.queue.length >= s.maxQueue ? '队列已满' : null;
    if (reason) { this.store.log('skipped', { ...input, detail: reason }); return { skipped: reason }; }
    const now = this.now();
    if (cooldown && (this.cooldowns.get(cooldown[0]) || 0) > now) { this.store.log('cooldown', { ...input, detail: `冷却跳过 · 同一观众 / 匿名事件组 ${cooldown[1]} 秒内只播一次；未累计数量` }); return { skipped: '冷却跳过' }; }
    this.queue.push({ ...input, id: randomUUID(), created: Date.now() });
    if (cooldown) {
      this.cooldowns.set(cooldown[0], now + cooldown[1] * 1000);
      for (const [key, expires] of this.cooldowns) if (expires <= now) this.cooldowns.delete(key);
      while (this.cooldowns.size > 3000) this.cooldowns.delete(this.cooldowns.keys().next().value!);
    }
    this.store.log('queued', { ...input, detail: '已排队，等待本地播放器' });
    return { queued: true };
  }
  private commandSpeech(v: Viewer, text: string): string {
    const c = parseCommand(text)!, s = this.store.settings(), name = boundedText(cleanText(v.username), 40);
    if (c.name === '音色') return `${name}开始使用${this.voice(v.voice || s.defaultVoice)?.name || '默认'}音色。`;
    if (c.name === '风格') return c.arg === '清除' ? `${name}已清除个人语音风格，恢复直播间默认风格。` : `${name}改了语音风格：${cleanText(v.style)}`;
    if (c.name === '语速') return `${name}将语速改为${1 + (v.speed ?? s.speechRate) / 100}倍。`;
    if (c.name === '重置') return `${name}已恢复直播间默认音色、语速和风格。`;
    if (c.name === '定制') return `${name}提交了专属音色申请，等待主播审核。`;
    if (c.name === '查询' || c.name === '我的音色') { const style = cleanText(v.style || s.defaultStyle); return `${name}当前音色${this.voice(v.voice || s.defaultVoice)?.name || '默认音色'}，语速${1 + (v.speed ?? s.speechRate) / 100}倍${style ? `，风格为${style}` : ''}。`; }
    return '';
  }
  blocked(text: string) { return this.store.settings().blockedWords.split(/\n/).map(s => s.trim()).filter(Boolean).some(w => text.includes(w)); }
  command(v: Viewer, text: string) {
    const c = parseCommand(text)!; const s = this.store.settings();
    let detail = '';
    const readOnly = ['查询', '我的音色', '音色列表', '帮助'].includes(c.name);
    if (v.muted || v.locked && !readOnly) throw new AppError('该观众的互动设置已被主播锁定。');
    const last = this.store.get<number>(`cooldown:${v.uid}`) || 0;
    if (!readOnly && Date.now() - last < s.cooldownSeconds * 1000) throw new AppError(`修改太快啦，请等待 ${Math.ceil((s.cooldownSeconds * 1000 - Date.now() + last) / 1000)} 秒。`);
    if (c.name === '音色') {
      const voice = this.voice(c.arg);
      if (!voice || voice.resource !== 'seed-tts-2.0') throw new AppError('没有找到这个官方音色，请发送 #音色列表 查看可选名称。');
      this.store.updateViewer(v.uid, { voice: voice.id }); detail = `已记住音色：${voice.name}`;
    } else if (c.name === '风格') {
      if (!s.allowStyles) throw new AppError('主播暂时关闭了风格指令。');
      if (!c.arg || Array.from(c.arg).length > 200) throw new AppError('风格描述需要 1～200 字，例如 #风格 用开心、俏皮的语气说话；#风格 清除 可恢复默认。');
      this.store.updateViewer(v.uid, { style: c.arg === '清除' ? '' : c.arg }); detail = c.arg === '清除' ? '已清除个人风格' : '已记住个人风格';
    } else if (c.name === '语速') {
      const speed = Number(c.arg.replace(/[x×倍]$/u, ''));
      if (!c.arg || !Number.isFinite(speed) || speed < 0.5 || speed > 2) throw new AppError('语速范围是 0.5～2，例如 #语速 1.2');
      this.store.updateViewer(v.uid, { speed: Math.round((speed - 1) * 100) }); detail = `已记住语速：${speed} 倍`;
    } else if (c.name === '重置') {
      this.store.updateViewer(v.uid, { voice: '', style: '', speed: null }); detail = '已恢复直播间默认音色和风格';
    } else if (c.name === '定制') {
      if (!s.allowDesignRequests) throw new AppError('主播暂时关闭了专属音色申请。');
      if (!c.arg || Array.from(c.arg).length > 200) throw new AppError('请用 1～200 字描述新音色，例如 #定制 温柔、略带沙哑的成年女声');
      if (this.store.db.prepare("SELECT id FROM designs WHERE uid=? AND status IN ('pending','processing','uncertain')").get(v.uid)) throw new AppError('已有待处理的音色申请，请等待主播处理。');
      if (Number(this.store.db.prepare("SELECT COUNT(*) n FROM designs WHERE status='pending'").get()!.n) >= 100) throw new AppError('待审核申请已满，请稍后再申请。');
      const now = new Date().toISOString();
      this.store.db.prepare("INSERT INTO designs(uid,username,prompt,status,createdAt,updatedAt) VALUES (?,?,?,'pending',?,?)").run(v.uid, v.username, c.arg, now, now);
      detail = '专属音色申请已保存，等待主播选择槽位并生成';
    } else if (c.name === '我的音色' || c.name === '查询') detail = this.commandSpeech(v, text);
    else if (c.name === '音色列表') detail = this.voices().filter(x => x.resource === 'seed-tts-2.0').map(x => x.name).join('、');
    else detail = HELP;
    if (!readOnly) this.store.set(`cooldown:${v.uid}`, Date.now());
    this.store.log('command', { eventType: 'command', uid: v.uid, username: v.username, text, detail });
    return detail;
  }
  async next(id: string) {
    this.claimPlayer(id);
    if (this.playerBusy) throw new AppError('上一条仍在合成中。', 409);
    const s = this.store.settings();
    if (!s.enabled || s.mode !== 'bridge') return null;
    let job: Job | undefined;
    while ((job = this.queue.shift())) {
      if (Date.now() - job.created <= 90000 && !this.store.viewer(job.uid)?.muted && !this.disabled(job)) break;
      this.store.log(this.disabled(job) ? 'disabled' : 'skipped', { ...job, detail: '队列复核：事件已过期、该类型已关闭或观众已静音' }); job = undefined;
    }
    if (!job) return null;
    this.playerBusy = true;
    try { return { job, ...(await this.speak(job.text, { uid: job.uid, username: job.username, source: 'bridge', announceName: job.announceName, eventType: job.eventType, action: job.action })) }; }
    finally { this.playerBusy = false; }
  }
  async speak(text: string, options: { uid?: string; username?: string; voice?: string; style?: string; speed?: number; source: string; announceName?: boolean; eventType?: string; action?: InteractionAction }) {
    if (this.pending >= 20) throw new AppError('合成队列已满，请稍后再试。', 429);
    this.pending++;
    const previous = this.tail; let unlock!: () => void;
    this.tail = new Promise<void>(resolve => { unlock = resolve; });
    await previous;
    try {
      const s = this.store.settings(), viewer = options.uid ? this.store.viewer(options.uid) : undefined;
      if (!s.enabled) throw new AppError('播报已暂停。', 409);
      // A preview may hold the synthesis lock while this job waits. Recheck after acquiring it.
      if (options.source === 'bridge' && (options.eventType === 'command' || supportedEvent(options.eventType)) && this.disabled({ eventType: options.eventType, action: options.action })) {
        this.store.log('disabled', { ...options, text, detail: '等待合成期间关闭播报，未调用云端' });
        throw new AppError('该类型已关闭播报。', 409);
      }
      if (viewer?.muted) throw new AppError('该观众已静音。', 409);
      text = text.trim();
      if (!text || Array.from(text).length > s.maxChars) throw new AppError(`朗读内容需要 1～${s.maxChars} 字。`);
      if (this.blocked(text)) throw new AppError('命中屏蔽词，已跳过。');
      const voice = this.voice(viewer?.voice || options.voice || s.defaultVoice);
      if (!voice) throw new AppError('音色不存在，请选择音色库中的名称或 ID。');
      const style = (viewer?.style || options.style || s.defaultStyle).trim();
      if (Array.from(style).length > 200) throw new AppError('风格描述不能超过 200 字。');
      const speed = viewer?.speed ?? options.speed ?? s.speechRate;
      const spoken = s.announceUsername && options.announceName !== false && options.username ? `${options.username}说，${text}` : text;
      const input: Synthesis = { text: spoken, voice, style, speed };
      const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
      const cached = this.cache.get(hash); const start = Date.now();
      if (cached && Date.now() - cached.time < 3600000) {
        this.store.log('cached', { ...options, text, voice: voice.name, detail: '已复用本地音频 · 未调用云端' });
        return { audio: cached.result.audio, voice: voice.name, chars: 0, cached: true };
      }
      authHeaders(this.store.credentials());
      const count = Array.from(spoken).length;
      const limit = voice.resource === 'seed-icl-2.0' ? s.cloneBudget : s.budget;
      const prior = voice.resource === 'seed-icl-2.0' ? 0 : s.usedBefore;
      if (this.store.spent(voice.resource) + prior + count > limit) throw new AppError('已达到本地字数上限，请核对火山额度后在接入设置调整。', 429);
      this.rate = this.rate.filter(t => Date.now() - t < 60000);
      if (this.rate.length >= 60) throw new AppError('每分钟最多 60 次云端合成，请稍后再试。', 429);
      this.rate.push(Date.now());
      // Reserve before network dispatch. Unknown outcomes stay counted to avoid overspending.
      this.store.addUsage(voice.resource, count);
      try {
        const result = await this.provider.synthesize(input);
        this.store.addUsage(voice.resource, result.chars - count);
        if (cached) this.cacheBytes -= cached.result.audio.length;
        this.cache.set(hash, { result, time: Date.now() }); this.cacheBytes += result.audio.length;
        while (this.cache.size > 100 || this.cacheBytes > 20 * 1024 * 1024) { const first = this.cache.keys().next().value!; this.cacheBytes -= this.cache.get(first)!.result.audio.length; this.cache.delete(first); }
        this.store.log('speech', { ...options, text, voice: voice.name, chars: result.chars, latency: Date.now() - start, detail: `${options.source === 'preview' ? '试听' : '已合成'} · ${result.estimated ? '估算字数' : '云端计费字数'}${voice.resource === 'seed-icl-2.0' && style ? ' · 专属音色保留设计时风格' : ''}` });
        return { audio: result.audio, voice: voice.name, chars: result.chars, cached: false };
      } catch (e) {
        const detail = e instanceof AppError ? e.message : '请求超时或网络异常。已保留本次预估字数，请到火山控制台核对用量。';
        this.store.log('error', { ...options, text, voice: voice.name, detail });
        throw new AppError(detail, 502);
      }
    } finally { unlock(); this.pending--; }
  }
  designs(): Design[] { return this.store.db.prepare('SELECT * FROM designs ORDER BY id DESC LIMIT 200').all() as unknown as Design[]; }
  async approveDesign(id: number, speaker: string) {
    authHeaders(this.store.credentials(), true);
    const request = this.store.db.prepare("SELECT * FROM designs WHERE id=? AND status='pending'").get(id) as unknown as Design | undefined;
    if (!request) throw new AppError('申请不存在，或已被处理。', 409);
    if (this.voice(speaker) || this.store.db.prepare('SELECT id FROM designs WHERE speaker=?').get(speaker)) throw new AppError('该槽位已在本地绑定过，请使用空槽位，避免覆盖其他人的声音。', 409);
    this.store.db.prepare("UPDATE designs SET speaker=?,status='processing',updatedAt=? WHERE id=?").run(speaker, new Date().toISOString(), id);
    try {
      const result = await this.provider.design(speaker, request.prompt);
      const custom = this.store.get<Voice[]>('customVoices') || [];
      custom.push({ id: speaker, name: `${request.username}的专属音色`, gender: '专属', tag: '文字设计', description: request.prompt, resource: 'seed-icl-2.0' });
      this.store.set('customVoices', custom);
      this.store.updateViewer(request.uid, { voice: speaker });
      this.store.db.prepare("UPDATE designs SET status='ready',detail=?,updatedAt=? WHERE id=?").run(`已绑定；槽位剩余更新次数：${result.available_training_times ?? '请在控制台查看'}`, new Date().toISOString(), id);
      this.store.log('design', { uid: request.uid, username: request.username, detail: '专属音色生成成功并已绑定' });
    } catch (e) {
      const detail = e instanceof AppError ? e.message : '音色生成结果未知，请到火山控制台核对；不会自动重试。';
      this.store.db.prepare("UPDATE designs SET status='uncertain',detail=?,updatedAt=? WHERE id=?").run(detail, new Date().toISOString(), id);
      throw new AppError(detail, 502);
    }
  }
  status() {
    const s = this.store.settings();
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Hong_Kong' }).format(new Date());
    const start = new Date(`${today}T00:00:00+08:00`).toISOString();
    return { settings: s, bridgeConnections: this.bridgeConnections, playerActive: this.playerActive(), lastEventAt: this.lastEventAt,
      queue: this.queue, pending: this.pending,
      totalViewers: Number(this.store.db.prepare('SELECT COUNT(*) n FROM viewers').get()!.n),
      todaySpeech: Number(this.store.db.prepare("SELECT COUNT(*) n FROM logs WHERE time>=? AND kind IN ('speech','cached')").get(start)!.n),
      todayChars: Number(this.store.db.prepare('SELECT COALESCE(SUM(chars),0) n FROM logs WHERE time>=?').get(start)!.n),
      used: this.store.spent('seed-tts-2.0') + s.usedBefore, cloneUsed: this.store.spent('seed-icl-2.0'),
      pendingDesigns: Number(this.store.db.prepare("SELECT COUNT(*) n FROM designs WHERE status='pending'").get()!.n),
      configured: !!(this.store.credentials().apiKey || this.store.credentials().appId && this.store.credentials().accessKey) };
  }
}
