import { useEffect, useRef, useState } from 'react';
import { RefreshCw, KeyRound } from 'lucide-react';
import type { VoiceCatalogSync } from '../server/voice-sync';

type SyncStatus = ReturnType<VoiceCatalogSync['status']>;
export function VoiceSyncPanel({ api, reload }: {
  api: <T>(path: string, body?: unknown, method?: string) => Promise<T>;
  reload: () => Promise<void>;
}) {
  const [status, setStatus] = useState<SyncStatus | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState(''), [edit, setEdit] = useState(false);
  const [keys, setKeys] = useState({ accessKeyId: '', secretAccessKey: '' });
  const seen = useRef<string | null | undefined>(undefined);
  async function load() {
    const next = await api<SyncStatus>('/voice-sync'); setStatus(next);
    if (next.syncedAt && seen.current !== next.syncedAt) await reload();
    seen.current = next.syncedAt;
  }
  useEffect(() => {
    void load().catch(e => setError(e.message));
    const timer = setInterval(() => void load().catch(e => setError(e.message)), 10000);
    return () => clearInterval(timer);
  }, []);
  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); await load(); } catch (e) { setError(e instanceof Error ? e.message : '同步失败'); await load().catch(() => {}); }
    finally { setBusy(false); }
  }
  return <section className="card voice-sync-panel" aria-label="官方音色同步">
    <div className="card-head"><h2><RefreshCw size={17} />官方音色同步</h2><button className="button secondary" disabled={!status?.configured || busy || status.syncing} onClick={() => void run(async () => { await api('/voice-sync', {}); await reload(); })}><RefreshCw size={15} className={busy || status?.syncing ? 'spin' : ''} />{busy || status?.syncing ? '正在处理…' : '立即同步'}</button></div>
    <p>{status?.syncedAt ? `上次同步：${new Date(status.syncedAt).toLocaleString('zh-CN')} · 接口返回 ${status.remoteCount} 个音色` : `当前使用本地目录${status ? ` · ${status.bundledCount} 个 · 核对于 ${status.bundledAt}` : ''}`}</p>
    <p className="caption">通过官方 ListSpeakers 获取最新音色，不调用语音合成。离线或同步失败时继续使用本地目录；保留已有音色 ID 和旧名称，观众设置继续有效。实际合成权限以火山服务返回为准。</p>
    <div className="sync-controls"><label className="checkbox"><input type="checkbox" checked={status?.enabled ?? true} disabled={!status || busy} onChange={e => void run(() => api('/voice-sync', { enabled: e.target.checked }, 'PATCH'))} />每日自动同步（需服务运行且已配置 AK / SK）</label><button className="text-button" onClick={() => setEdit(!edit)}><KeyRound size={15} />{status?.configured ? '更新同步凭据' : '配置同步凭据'}</button></div>
    {!status?.configured && <p className="caption">同步使用火山 OpenAPI AK / SK，与语音合成 API Key 分开；尚未配置时仍可使用本地音色。</p>}
    {(error || status?.error) && <p role="alert" className="sync-error">{error || status?.error}</p>}
    {edit && <form className="sync-credentials" onSubmit={e => { e.preventDefault(); void run(async () => { await api('/voice-sync/credentials', keys); setKeys({ accessKeyId: '', secretAccessKey: '' }); setEdit(false); await api('/voice-sync', {}); await reload(); }); }}>
      <p className="caption">填写有 ListSpeakers 查询权限的 OpenAPI 凭据。只在本机加密保存，不回显，不改动已有合成凭据。<a href="https://console.volcengine.com/iam/keymanage/" target="_blank" rel="noreferrer">获取 AK / SK ↗</a></p>
      <label className="field"><span>OpenAPI Access Key ID（AK）</span><input type="password" autoComplete="new-password" value={keys.accessKeyId} required onChange={e => setKeys({ ...keys, accessKeyId: e.target.value })} /></label>
      <label className="field"><span>OpenAPI Secret Access Key（SK）</span><input type="password" autoComplete="new-password" value={keys.secretAccessKey} required onChange={e => setKeys({ ...keys, secretAccessKey: e.target.value })} /></label>
      <button className="button primary" disabled={busy || !keys.accessKeyId.trim() || !keys.secretAccessKey.trim()}>保存并同步</button>
    </form>}
    <a className="caption" href="https://api.volcengine.com/api-docs/view?action=ListSpeakers&serviceCode=speech_saas_prod&version=2025-05-20" target="_blank" rel="noreferrer">官方列表 API 文档 ↗</a>
  </section>;
}
