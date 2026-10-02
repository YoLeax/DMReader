import { useEffect, useState } from 'react';
import { Cloud, RefreshCw, Settings2 } from 'lucide-react';
import type { CloudQuotaStatus } from '../server/quota-sync';
import './cloud-quota.css';

const fmt = (value: number) => value.toLocaleString('zh-CN');
const stamp = (value: string) => new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false });
export function cloudQuotaNote(q?: CloudQuotaStatus) {
  return !q ? '重启服务后可查询云端额度' : q.syncedAt ? `${q.stale ? '上次结果' : '云端查询'} · ${stamp(q.syncedAt)}` : q.configured ? '等待云端查询 · 不以本地估算替代' : '请先配置 OpenAPI AK / SK';
}
export function CloudQuotaPanel({ status: q, api, onUpdate }: { status?: CloudQuotaStatus; api: <T>(path: string, body?: unknown, method?: string) => Promise<T>; onUpdate: () => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [edit, setEdit] = useState(false), [project, setProject] = useState(q?.project || 'default');
  useEffect(() => { setProject(q?.project || 'default'); }, [q?.project]);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : '额度查询失败'); }
    finally { await onUpdate().catch(() => {}); setBusy(false); }
  }
  return <section className="card cloud-quota" aria-label="火山云端资源包余额">
    <div className="card-head"><h2><Cloud size={18} />火山云端资源包余额</h2><button className="button secondary" disabled={!q?.configured || busy || q.syncing} onClick={() => void run(() => api('/cloud-quota', {}))}><RefreshCw size={15} className={busy || q?.syncing ? 'spin' : ''} />{busy || q?.syncing ? '查询中…' : '查询云端额度'}</button></div>
    <div className="cloud-quota-balances">{(['standard', 'custom'] as const).map(key => { const b = q?.[key]; return <div key={key}><span>{key === 'standard' ? '标准音色 · TTS 2.0' : '专属音色 · 声音复刻 2.0'}</span><b>{b ? fmt(b.remaining) : '—'}<small>字可用</small></b><p>{b ? `有效字数包 ${b.packCount} 个 · 已用 ${fmt(b.used)} / 总量 ${fmt(b.purchased)} 字` : q?.configured ? '尚未获取云端结果' : '尚未配置额度查询'}</p></div>; })}</div>
    <div className="cloud-quota-meta"><span className={q?.stale && q.syncedAt ? 'cloud-quota-stale' : ''}>{cloudQuotaNote(q)}{q && ` · 项目 ${q.project}`}</span><button className="text-button" onClick={() => setEdit(!edit)}><Settings2 size={14} />查询设置</button></div>
    {(error || q?.error) && <p role="alert" className="cloud-quota-error">{error || q?.error}{q?.syncedAt ? ' 当前保留的是上次成功查询值。' : ' 当前余额未知。'}</p>}
    {!q ? <p className="caption">当前后端尚未加载额度查询功能，请重启 DM Reader 服务后刷新。</p> : !q.configured ? <p className="caption">与官方音色同步共用 AK / SK。<a href="#voices">前往音色实验室配置凭据 →</a> 需要 ResourcePacksStatus 查询权限。</p> : null}
    {edit && q && <form className="cloud-quota-settings" onSubmit={e => { e.preventDefault(); void run(() => api('/cloud-quota', { project }, 'PATCH')); }}><label className="field"><span>火山项目名称</span><input value={project} onChange={e => setProject(e.target.value)} required maxLength={100} /><small>与合成 API Key 所属项目一致，默认是 default；切换项目后旧余额不再展示。</small></label><button className="button secondary" disabled={busy || q.syncing || !project.trim()}>保存项目</button><label className="checkbox"><input type="checkbox" checked={q.enabled} disabled={busy} onChange={e => void run(() => api('/cloud-quota', { enabled: e.target.checked }, 'PATCH'))} />每 5 分钟自动查询（需服务运行）</label></form>}
    {q?.packs.length ? <details className="cloud-quota-details"><summary>资源包明细 · {q.packs.length} 个</summary><div><table><thead><tr><th>资源</th><th>购入字数</th><th>已用字数</th><th>剩余字数</th><th>有效期</th><th>计入可用</th></tr></thead><tbody>{q.packs.map(p => <tr key={p.id}><td>{p.resource === 'standard' ? '标准 TTS 2.0' : '声音复刻 2.0'}</td><td>{fmt(p.purchased)}</td><td>{fmt(p.used)}</td><td>{fmt(p.remaining)}</td><td>{p.expires === '-' ? '未设到期日' : p.expires}</td><td>{p.available ? '是' : p.expiresAt !== null && p.expiresAt <= Date.now() ? '已到期' : `否（${p.state}）`}</td></tr>)}</tbody></table></div></details> : null}
    <p className="caption">来自火山 ResourcePacksStatus，含赠送字数包，只汇总有效且未过期的字数额度。云端用量可能有更新延迟；与看板日期筛选无关。此处不包含音色槽位、并发配额或后付费可用量。</p>
    <p className="caption">本地累计上限仍独立限制合成；云端查询不会自动提高本地上限。<a href="#settings">调整本地播报保护 →</a></p>
  </section>;
}
