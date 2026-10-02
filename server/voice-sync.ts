import { z } from 'zod';
import { AppError, type OpenApiCredentials, type Voice } from './types.js';
import { Store } from './store.js';
import { voices as bundledVoices } from './voices.js';
import catalog from './voice-catalog.json';
import { speechOpenApiHeaders, speechOpenApiUrl } from './openapi.js';

// Official ListSpeakers, version 2025-05-20. This is the OpenAPI control plane,
// authenticated by AK/SK, not the X-Api-Key used by openspeech synthesis.
export const LIST_SPEAKERS_URL = speechOpenApiUrl('ListSpeakers');
export function listSpeakersHeaders(body: string, credentials: OpenApiCredentials, now = new Date()) {
  return speechOpenApiHeaders('ListSpeakers', body, credentials, now);
}

const short = z.string().trim().max(400);
const speakerSchema = z.object({
  VoiceType: z.string().regex(/^[a-zA-Z0-9_.-]{1,150}$/).refine(s => !s.startsWith('S_')),
  Name: short.min(1).max(150), ResourceID: z.literal('seed-tts-2.0'),
  Gender: short.optional(), Description: z.string().max(4000).optional(),
  Categories: z.array(z.object({ Categories: z.array(short).max(100) })).max(100).optional(),
  Languages: z.array(z.object({ Language: short })).max(100).optional(),
});
const pageSchema = z.object({ Result: z.object({ Total: z.number().int().min(1).max(10000), Speakers: z.array(speakerSchema).max(10000) }) });
const languageNames = new Intl.DisplayNames(['zh-CN'], { type: 'language' });
function languageName(code: string) { try { return languageNames.of(code) || code; } catch { return code; } }
function toVoice(s: z.infer<typeof speakerSchema>): Voice {
  const scenes = [...new Set(s.Categories?.flatMap(c => c.Categories) || [])];
  return { id: s.VoiceType, name: s.Name.replace(/\s+2\.0$/, ''), resource: s.ResourceID,
    gender: s.Gender === '女' || s.Gender === '女声' ? '女声' : s.Gender === '男' || s.Gender === '男声' ? '男声' : s.Gender || '未标注',
    scenes, language: s.Languages?.map(l => languageName(l.Language)).join('、') || '',
    tag: scenes[0] || '官方音色', description: s.Description?.slice(0, 400) || '豆包语音合成 2.0 官方音色' };
}
export type CatalogFetch = typeof fetch;
export async function fetchOfficialVoices(credentials: OpenApiCredentials, fetcher: CatalogFetch = fetch, signal?: AbortSignal): Promise<Voice[]> {
  if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new AppError('请先配置音色同步专用的 OpenAPI AK / SK。');
  const voices: Voice[] = [], ids = new Set<string>();
  let total: number | undefined;
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  for (let page = 1; page <= 334; page++) {
    const body = JSON.stringify({ ResourceIDs: ['seed-tts-2.0'], Page: page, Limit: 30 });
    const response = await fetcher(LIST_SPEAKERS_URL, { method: 'POST', body, headers: listSpeakersHeaders(body, credentials), signal: timeout, redirect: 'error' });
    // Do not expose upstream error messages: a proxy may echo credentials or headers.
    const raw = await response.json().catch(() => null);
    const code = raw?.ResponseMetadata?.Error?.Code;
    if (!response.ok || code) {
      const safeCode = typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? ` · ${code}` : '';
      throw new AppError(`官方音色接口请求失败（HTTP ${response.status}${safeCode}），请检查 OpenAPI 凭据及 ListSpeakers 权限。`, 502);
    }
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('官方音色接口返回字段异常，已保留本地目录。', 502);
    const result = parsed.data.Result;
    if (total !== undefined && total !== result.Total) throw new AppError('分页过程中音色总数发生变化，请稍后重试；本地目录未修改。', 502);
    total = result.Total;
    if (!result.Speakers.length) throw new AppError('官方音色分页结果不完整，已保留本地目录。', 502);
    for (const speaker of result.Speakers) {
      if (ids.has(speaker.VoiceType)) throw new AppError('官方音色分页出现重复 ID，已保留本地目录。', 502);
      ids.add(speaker.VoiceType); voices.push(toVoice(speaker));
    }
    if (voices.length === total) return voices;
    if (voices.length > total) break;
  }
  throw new AppError('官方音色分页结果不完整，已保留本地目录。', 502);
}

interface CatalogSnapshot { voices: Voice[]; syncedAt: string; remoteCount: number; }
interface SyncAttempt { at: string; error: string; }
export function mergedVoices(store: Store): Voice[] {
  const known = new Map(bundledVoices.map(v => [v.id, v]));
  for (const v of store.get<CatalogSnapshot>('officialVoiceCatalog')?.voices || []) {
    const old = known.get(v.id);
    known.set(v.id, { ...old, ...v, language: v.language || old?.language,
      aliases: [...new Set([...(old?.aliases || []), ...(v.aliases || []), ...(old && old.name !== v.name ? [old.name] : [])])],
      scenes: v.scenes?.length ? v.scenes : old?.scenes });
  }
  return [...known.values()];
}
export class VoiceCatalogSync {
  private running: Promise<void> | null = null;
  private controller = new AbortController();
  constructor(private store: Store, private fetcher: CatalogFetch = fetch, private now = Date.now) {}
  status() {
    const c = this.store.openApiCredentials(), saved = this.store.get<CatalogSnapshot>('officialVoiceCatalog'), attempt = this.store.get<SyncAttempt>('voiceSyncAttempt');
    return { configured: !!(c.accessKeyId && c.secretAccessKey), enabled: this.store.get<boolean>('voiceAutoSync') ?? true,
      syncing: !!this.running, syncedAt: saved?.syncedAt || null, lastAttemptAt: attempt?.at || null, error: attempt?.error || '',
      remoteCount: saved?.remoteCount ?? 0, count: mergedVoices(this.store).length, bundledCount: bundledVoices.length, bundledAt: catalog.verifiedAt };
  }
  async refreshIfDue() {
    const s = this.status(), now = this.now();
    if (!s.configured || !s.enabled || s.syncing || s.syncedAt && now - Date.parse(s.syncedAt) < 86400000 || s.lastAttemptAt && now - Date.parse(s.lastAttemptAt) < 3600000) return;
    await this.sync();
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    if (this.controller.signal.aborted) return Promise.reject(new AppError('服务正在关闭。', 503));
    this.running = this.perform().finally(() => { this.running = null; });
    return this.running;
  }
  private async perform() {
    const at = new Date(this.now()).toISOString();
    try {
      const fetched = await fetchOfficialVoices(this.store.openApiCredentials(), this.fetcher, this.controller.signal);
      // Retain prior IDs/aliases so an upstream rename/removal cannot silently break saved preferences.
      const merged = new Map(mergedVoices(this.store).map(v => [v.id, v]));
      for (const voice of fetched) {
        const old = merged.get(voice.id);
        merged.set(voice.id, { ...voice, language: voice.language || old?.language, scenes: voice.scenes?.length ? voice.scenes : old?.scenes,
          aliases: [...new Set([...(old?.aliases || []), ...(old && old.name !== voice.name ? [old.name] : [])])].slice(-30) });
      }
      this.store.set('officialVoiceCatalog', { voices: [...merged.values()], syncedAt: at, remoteCount: fetched.length } satisfies CatalogSnapshot);
      this.store.set('voiceSyncAttempt', { at, error: '' });
    } catch (e) {
      if (this.controller.signal.aborted) return;
      const error = e instanceof AppError ? e.message : '音色同步超时或网络异常，已保留本地目录。';
      this.store.set('voiceSyncAttempt', { at, error });
      throw new AppError(error, 502);
    }
  }
  async close() { this.controller.abort(); await this.running?.catch(() => {}); }
}
