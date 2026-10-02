import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Store } from './store.js';
import { AppError, type OpenApiCredentials } from './types.js';
import { speechOpenApiHeaders, speechOpenApiUrl } from './openapi.js';

export const QUOTA_URL = speechOpenApiUrl('ResourcePacksStatus');
// Billing IDs confirmed against the console's ResourcePacksStatus requests.
// They differ from synthesis IDs seed-tts-2.0 / seed-icl-2.0.
export const QUOTA_RESOURCES = { standard: 'volc.seedtts.default', custom: 'volc.seedicl.default' } as const;
export const QUOTA_INTERVAL = 5 * 60 * 1000;
const str = z.string().max(400), amount = z.number().finite().nonnegative().max(Number.MAX_SAFE_INTEGER);
const packSchema = z.object({ ResourceID: str, PackType: str, RawType: str, State: str, Expires: str,
  InstanceNumber: str.optional(), TrainID: str.optional(),
  Harvest: z.object({ ResourceID: str, CropType: str, Unit: str, PurchasedAmount: amount, CurrentUsage: amount }).nullable().optional() });
const pageSchema = z.object({ Result: z.object({ Packs: z.array(packSchema).max(100), TotalCount: z.number().int().min(0).max(10000), PageNumber: z.number().int().positive().optional() }) });
export interface QuotaPack { id: string; resource: keyof typeof QUOTA_RESOURCES; state: string; expires: string; expiresAt: number | null; purchased: number; used: number; }
interface Snapshot { scope: string; syncedAt: string; packs: QuotaPack[]; }
interface Attempt { scope: string; at: string; error: string; }
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function expiration(raw: string) {
  if (raw === '-') return null;
  // Unzoned times in the Chinese console are Beijing time.
  const normalized = raw.replace(' ', 'T');
  const value = /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? `${normalized}T00:00:00+08:00` : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(normalized) ? `${normalized}+08:00` : normalized;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new AppError('资源包有效期字段无法识别，已保留上次云端结果。', 502);
  return Date.parse(value);
}
export async function fetchCloudQuota(credentials: OpenApiCredentials, project: string, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<QuotaPack[]> {
  if (!credentials.accessKeyId || !credentials.secretAccessKey) throw new AppError('请先在音色实验室配置 OpenAPI AK / SK；额度查询与音色同步共用凭据。');
  const packs: QuotaPack[] = [], ids = new Set<string>(); let total: number | undefined, received = 0;
  const timeout = signal ? AbortSignal.any([signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
  for (let page = 1; page <= 100; page++) {
    const body = JSON.stringify({ ProjectName: project, ResourceIDs: Object.values(QUOTA_RESOURCES), Types: ['prepaid'], PageNumber: page, PageSize: 100 });
    const response = await fetcher(QUOTA_URL, { method: 'POST', body, headers: speechOpenApiHeaders('ResourcePacksStatus', body, credentials), signal: timeout, redirect: 'error' });
    const raw = await response.json().catch(() => null), code = raw?.ResponseMetadata?.Error?.Code;
    if (!response.ok || code) {
      const safeCode = typeof code === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(code) ? ` · ${code}` : '';
      throw new AppError(`云端额度查询失败（HTTP ${response.status}${safeCode}），请检查项目名称、OpenAPI 凭据及 ResourcePacksStatus 查询权限。`, 502);
    }
    const parsed = pageSchema.safeParse(raw);
    if (!parsed.success) throw new AppError('云端额度接口返回字段异常，已保留上次结果。', 502);
    const result = parsed.data.Result;
    if (result.PageNumber !== undefined && result.PageNumber !== page || total !== undefined && total !== result.TotalCount) throw new AppError('资源包分页结果发生变化，请稍后重试。', 502);
    total = result.TotalCount; received += result.Packs.length;
    for (const p of result.Packs) {
      const resource = (Object.keys(QUOTA_RESOURCES) as (keyof typeof QUOTA_RESOURCES)[]).find(key => QUOTA_RESOURCES[key] === p.ResourceID);
      // Never turn concurrency, voice slots or a different service into characters.
      if (!resource || p.PackType !== 'prepaid' || p.RawType !== 'text_words') continue;
      const h = p.Harvest, identity = p.InstanceNumber || p.TrainID;
      if (!identity || !h || h.ResourceID !== p.ResourceID || h.CropType !== 'text_words' || h.Unit !== '字数') throw new AppError('字数资源包标识或计量单位异常，已保留上次结果。', 502);
      const id = digest(`${p.ResourceID}:${identity}`);
      if (ids.has(id)) throw new AppError('资源包分页出现重复记录，已保留上次结果。', 502);
      ids.add(id); packs.push({ id, resource, state: p.State, expires: p.Expires, expiresAt: expiration(p.Expires), purchased: h.PurchasedAmount, used: h.CurrentUsage });
    }
    if (received === total) return packs;
    if (!result.Packs.length || received > total) break;
  }
  throw new AppError('资源包分页结果不完整，已保留上次结果。', 502);
}

export class CloudQuotaSync {
  private running: Promise<void> | null = null;
  private controller = new AbortController();
  constructor(private store: Store, private fetcher: typeof fetch = fetch, private now = Date.now) {}
  private context() {
    const credentials = this.store.openApiCredentials(), project = this.store.get<string>('quotaProject') || 'default';
    return { credentials, project, scope: digest(JSON.stringify([credentials, project])) };
  }
  status() {
    const { credentials, project, scope } = this.context(), stored = this.store.get<Snapshot>('cloudQuotaSnapshot'), tried = this.store.get<Attempt>('cloudQuotaAttempt');
    const snapshot = stored?.scope === scope ? stored : undefined, attempt = tried?.scope === scope ? tried : undefined, now = this.now();
    const packs = snapshot?.packs.map(p => ({ ...p, remaining: Math.max(0, p.purchased - p.used), available: p.state === 'active' && (p.expiresAt === null || p.expiresAt > now) })) || [];
    const balance = (resource: QuotaPack['resource']) => {
      if (!snapshot) return null;
      const eligible = packs.filter(p => p.resource === resource && p.available);
      return { purchased: eligible.reduce((n, p) => n + p.purchased, 0), used: eligible.reduce((n, p) => n + p.used, 0), remaining: eligible.reduce((n, p) => n + p.remaining, 0), packCount: eligible.length };
    };
    return { configured: !!(credentials.accessKeyId && credentials.secretAccessKey), project, enabled: this.store.get<boolean>('quotaAutoSync') ?? true, syncing: !!this.running,
      syncedAt: snapshot?.syncedAt || null, lastAttemptAt: attempt?.at || null, error: attempt?.error || '',
      stale: !snapshot || !!attempt?.error || now - Date.parse(snapshot.syncedAt) >= QUOTA_INTERVAL, intervalSeconds: QUOTA_INTERVAL / 1000,
      standard: balance('standard'), custom: balance('custom'), packs };
  }
  async refreshIfDue() {
    const s = this.status(), now = this.now();
    if (!s.configured || !s.enabled || s.syncing || s.lastAttemptAt && now - Date.parse(s.lastAttemptAt) < (s.error ? 60000 : QUOTA_INTERVAL)) return;
    await this.sync();
  }
  sync(): Promise<void> {
    if (this.running) return this.running;
    if (this.controller.signal.aborted) return Promise.reject(new AppError('服务正在关闭。', 503));
    const s = this.status();
    if (s.lastAttemptAt && this.now() - Date.parse(s.lastAttemptAt) < 10000) return Promise.reject(new AppError('刚刚查询过云端额度，请等待 10 秒后重试。', 429));
    this.running = this.perform().finally(() => { this.running = null; }); return this.running;
  }
  private async perform() {
    const { credentials, project, scope } = this.context();
    try {
      const packs = await fetchCloudQuota(credentials, project, this.fetcher, this.controller.signal);
      const at = new Date(this.now()).toISOString();
      this.store.set('cloudQuotaSnapshot', { scope, syncedAt: at, packs } satisfies Snapshot);
      this.store.set('cloudQuotaAttempt', { scope, at, error: '' } satisfies Attempt);
    } catch (e) {
      if (this.controller.signal.aborted) return;
      const error = e instanceof AppError ? e.message : '云端额度查询超时或网络异常，已保留上次查询结果。';
      this.store.set('cloudQuotaAttempt', { scope, at: new Date(this.now()).toISOString(), error } satisfies Attempt);
      throw new AppError(error, 502);
    }
  }
  async close() { this.controller.abort(); await this.running?.catch(() => {}); }
}
export type CloudQuotaStatus = ReturnType<CloudQuotaSync['status']>;
