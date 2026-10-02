import { useEffect, useState } from 'react';
import { Activity, AudioLines, ChartNoAxesCombined, Coins, MessageSquare, RefreshCw, Users } from 'lucide-react';
import type { AnalyticsRange, AnalyticsReport } from '../server/analytics';
import { eventLabels, type EventType } from '../shared/events';
import './analytics.css';
import type { CloudQuotaStatus } from '../server/quota-sync';
import { cloudQuotaNote } from './CloudQuotaPanel';

const fmt = (n: number) => n.toLocaleString('zh-CN');
const percent = (n: number | null) => n === null ? '—' : `${(n * 100).toFixed(1)}%`;
const date = (at: string | number, options: Intl.DateTimeFormatOptions) => new Date(at).toLocaleString('zh-CN', { timeZone: 'Asia/Hong_Kong', hour12: false, ...options });
const ranges: [AnalyticsRange, string][] = [['today', '今天'], ['yesterday', '昨天'], ['7d', '近 7 天'], ['30d', '近 30 天']];
const outcomeLabels: Record<string, string> = { queued: '已排队', command: '指令已处理', 'command-error': '指令失败', disabled: '关闭播报', duplicate: '重复事件', invalid: '字段异常', cooldown: '冷却跳过', 'no-player': '播放器未开启', muted: '观众静音', paused: '播报暂停', 'queue-full': '队列已满', blocked: '命中屏蔽词', 'api-mode': '兼容 API 模式', deleted: 'SC 已删除', 'too-long': '超过字数限制' };
const sourceLabels: Record<string, string> = { bridge: '直播播报', simulation: '本地模拟', preview: '音色试听', api: '自定义 API' };
type Bin = AnalyticsReport['bins'][number];
type Metric = Exclude<keyof Bin, 'at'>;

function Trend({ bins, step, title, options, color }: { bins: Bin[]; step: number; title: string; options: [Metric, string, string][]; color: string }) {
  const [metric, setMetric] = useState(options[0][0]), [active, setActive] = useState<number | null>(null);
  const [, label, unit] = options.find(o => o[0] === metric)!;
  const values = bins.map(b => b[metric]), max = Math.max(1, ...values), total = values.reduce((a, b) => a + b, 0);
  const top = max <= 4 ? 4 : Math.ceil(max / 4) * 4;
  const x = (i: number) => bins.length === 1 ? 341 : 48 + i / (bins.length - 1) * 580;
  const y = (n: number) => 174 - n / top * 150;
  const path = bins.map((b, i) => `${i ? 'L' : 'M'} ${x(i)} ${y(b[metric])}`).join(' ');
  const index = active !== null && active < bins.length ? active : null;
  const shortTime = (at: number) => date(at, step < 86400000 ? { hour: '2-digit', minute: '2-digit' } : { month: '2-digit', day: '2-digit' });
  const fullTime = (at: number) => date(at, { month: 'long', day: 'numeric', ...(step < 86400000 ? { hour: '2-digit' } : {}) });
  const ticks = [...new Set(Array.from({ length: Math.min(6, bins.length) }, (_, i) => Math.round(i * (bins.length - 1) / Math.max(1, Math.min(6, bins.length) - 1))))];
  return <section className="card an-trend">
    <div className="an-section-head"><h2>{title}</h2><span>{step < 86400000 ? '按小时' : '按天'}</span></div>
    <div className="an-tabs" aria-label={`${title}指标`}>{options.map(([key, name]) => <button key={key} aria-pressed={metric === key} onClick={() => { setMetric(key); setActive(null); }}>{name}</button>)}</div>
    <div className="an-chart-readout" aria-live="polite">{index === null ? <><span>{total ? '最高时段' : '所选时段暂无记录'}</span><b>{total ? `${fmt(Math.max(...values))} ${unit}` : '—'}</b></> : <><span>{fullTime(bins[index].at)}</span><b>{fmt(bins[index][metric])} <small>{unit}</small></b></>}</div>
    <svg className="an-chart" viewBox="0 0 650 212" role="group" aria-label={`${title}，${label}，${step < 86400000 ? '每小时' : '每天'}趋势`} onMouseLeave={() => setActive(null)}>
      {[0, 1, 2, 3, 4].map(i => <g key={i}><line x1="48" x2="628" y1={y(i * top / 4)} y2={y(i * top / 4)} stroke="#eeeef5" strokeDasharray="4 5" /><text x="39" y={y(i * top / 4) + 4} textAnchor="end">{fmt(i * top / 4)}</text></g>)}
      <path d={`${path} L ${x(bins.length - 1)} 174 L ${x(0)} 174 Z`} fill={color} opacity=".08" />
      <path d={path} fill="none" stroke={color} strokeWidth="2.5" strokeLinejoin="round" />
      {index !== null && <line x1={x(index)} x2={x(index)} y1="20" y2="174" stroke={color} strokeDasharray="3 4" opacity=".5" />}
      {bins.map((b, i) => <g key={b.at}><circle cx={x(i)} cy={y(b[metric])} r={i === index ? 5 : bins.length === 1 ? 4 : 2.5} fill={color} />
        <rect x={x(i) - 10} y="18" width="20" height="160" fill="transparent" tabIndex={0} role="button" aria-label={`${fullTime(b.at)}，${label} ${fmt(b[metric])} ${unit}`} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)} onBlur={() => setActive(null)} onClick={() => setActive(i)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setActive(i); } }} />
      </g>)}
      {ticks.map(i => <text key={i} x={x(i)} y="201" textAnchor="middle">{shortTime(bins[i].at)}</text>)}
    </svg>
    <p className="an-caption">{metric === 'activeViewers' ? '每个时段独立按 UID 去重；各时段人数不可直接相加。' : title === '直播间活跃趋势' ? '仅统计本房间有效真实事件；弹幕包含普通、特效弹幕及互动指令。' : '含直播、试听、模拟与 API；字数按请求发起时间归档。'} 悬停或聚焦查看数值。</p>
  </section>;
}

function Distribution({ title, rows, empty = '所选时段暂无记录', color = '#8d79d9', foot }: { title: string; rows: { key: string; label: string; count: number }[]; empty?: string; color?: string; foot: string }) {
  const max = Math.max(1, ...rows.map(r => r.count));
  return <section className="card an-distribution"><div className="an-section-head"><h2>{title}</h2><span>次数</span></div>
    {rows.length ? <ol className="an-bars">{rows.map(r => <li key={r.key}><div><span title={r.label}>{r.label}</span><b>{fmt(r.count)}</b></div><div className="an-track"><i style={{ width: `${r.count / max * 100}%`, background: color }} /></div></li>)}</ol> : <div className="an-empty"><ChartNoAxesCombined size={25} /><p>{empty}</p></div>}
    <p className="an-caption">{foot}</p>
  </section>;
}

function Budget({ title, value }: { title: string; value: AnalyticsReport['budget']['standard'] }) {
  const ratio = value.limit ? Math.min(1, value.used / value.limit) : 0;
  return <div className="an-budget"><div><b>{title}</b><span>{value.limit === 0 ? '未开放额度' : `剩余 ${fmt(value.remaining)} 字`}</span></div><div className="an-track"><i style={{ width: `${ratio * 100}%`, background: ratio >= .9 ? '#cb7658' : '#8d79d9' }} /></div><p>累计已用 {fmt(value.used)} <span>/ 本地上限 {fmt(value.limit)} 字</span></p></div>;
}

export function AnalyticsDashboard({ api, room, quota, quotaPanel }: { api: <T>(path: string) => Promise<T>; room: string; quota?: CloudQuotaStatus; quotaPanel?: React.ReactNode }) {
  const [range, setRange] = useState<AnalyticsRange>('today'), [data, setData] = useState<AnalyticsReport | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false, pending = false;
    setData(null); setLoading(true); setError('');
    async function load() {
      if (pending) return; pending = true;
      try { const report = await api<AnalyticsReport>(`/analytics?range=${range}`); if (!disposed) { setData(report); setError(''); } }
      catch (e) { if (!disposed) setError(e instanceof Error ? e.message : '统计读取失败'); }
      finally { pending = false; if (!disposed) setLoading(false); }
    }
    void load(); const timer = setInterval(() => { if (!document.hidden) void load(); }, 15000);
    const visible = () => { if (!document.hidden) void load(); }; document.addEventListener('visibilitychange', visible);
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', visible); };
  }, [range, room, revision, api]);
  const s = data?.summary;
  return <div className="analytics">
    <div className="an-toolbar"><div className="an-ranges" aria-label="统计时间范围">{ranges.map(([key, label]) => <button key={key} aria-pressed={range === key} onClick={() => setRange(key)}>{label}</button>)}</div><div className="an-update"><span>{loading ? '正在读取统计…' : data ? `${date(data.generatedAt, { hour: '2-digit', minute: '2-digit', second: '2-digit' })} 更新 · 每 15 秒刷新` : '统计暂不可用'}</span><button className="button secondary" disabled={loading} onClick={() => setRevision(n => n + 1)} aria-label="刷新数据看板"><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button></div></div>
    {error && <div className="notice danger" role="alert">{error}{data && ' · 当前展示上次成功读取的数据。'}</div>}
    {!data || !s ? <div className="card an-loading" role="status">{loading ? '正在汇总直播数据…' : '读取失败，请点击刷新重试。'}</div> : <>
      <div className="an-scope"><span className="an-live-dot" /><span>房间 {data.room} · {date(data.start, { month: '2-digit', day: '2-digit' })} — {date(data.end, { month: '2-digit', day: '2-digit' })} · 北京时间</span><span>真实互动与本地模拟分开统计</span></div>
      {data.partialHistory && <p className="an-history">趋势从 {date(data.startedAt, { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 开始记录，之前没有历史数据；累计字数额度沿用原有记录。</p>}
      <div className="an-kpis">
        <MetricCard label="收到弹幕" value={s.messages} unit="条" detail={`正文 ${fmt(s.messageChars)} 字 · 其中指令 ${fmt(s.commands)} 条`} icon={MessageSquare} />
        <MetricCard label="发言观众" value={s.speakers} unit="人" detail={`按 UID 去重 · 全部互动观众 ${fmt(s.interactingViewers)} 人`} icon={Users} />
        <MetricCard label="时段 TTS 消耗" value={s.chars} unit="字" detail={`全部合成来源 · 缓存约节省 ${fmt(s.savedChars)} 字`} icon={AudioLines} />
        <MetricCard label="标准音色云端余量" value={quota?.standard?.remaining ?? '—'} unit="字" detail={cloudQuotaNote(quota)} icon={Coins} accent />
      </div>
      {quotaPanel}
      <div className="an-two"><Trend bins={data.bins} step={data.step} title="直播间活跃趋势" options={[[ 'messages', '弹幕量', '条' ], [ 'activeViewers', '发言人数', '人' ], [ 'events', '全部事件', '条' ]]} color="#8268cd" /><Trend bins={data.bins} step={data.step} title="语音合成趋势" options={[[ 'chars', '消耗字数', '字' ], [ 'success', '合成成功', '次' ], [ 'cached', '缓存复用', '次' ], [ 'failure', '合成失败', '次' ]]} color="#29988d" /></div>
      <section className="card an-quality"><div className="an-section-head"><h2><Activity size={17} />语音服务表现</h2><span>所选时段 · 全部来源</span></div><div className="an-quality-grid">
        <div><span>云端合成成功率</span><b>{percent(s.successRate)}</b><small>{fmt(s.successes)} 次成功 / {fmt(s.failures)} 次失败</small></div>
        <div><span>成功合成平均耗时</span><b>{s.latency === null ? '—' : `${(s.latency / 1000).toFixed(2)}`}<em>{s.latency !== null && ' 秒'}</em></b><small>不含排队与音频播放时间</small></div>
        <div><span>音频缓存复用率</span><b>{percent(s.cacheRate)}</b><small>{fmt(s.cached)} 次复用 · 不调用云端</small></div>
        <div><span>合成任务来源</span>{data.speechSources.length ? <ul>{data.speechSources.map(r => <li key={r.key}><span>{sourceLabels[r.key] || r.key}</span><b>{fmt(r.count)}</b></li>)}</ul> : <small className="an-no-speech">还没有语音合成记录</small>}</div>
      </div><p className="an-caption">成功率只计算已完成的云端请求；缓存复用率 = 复用 /（合成成功 + 复用）。合成成功不代表浏览器已播放完成。</p></section>
      <div className="an-three">
        <Distribution title="收到哪些互动" rows={data.eventTypes.map(r => ({ ...r, label: eventLabels[r.key as EventType] || r.key }))} foot={`共 ${fmt(s.validEvents)} 条有效事件，含关闭播报的互动；已排除重复及字段异常。`} />
        <Distribution title="事件处理结果" rows={data.outcomes.map(r => ({ ...r, label: outcomeLabels[r.key] || r.key }))} color="#6ca9a0" foot={`共接收 ${fmt(s.received)} 条；这里展示接收时的处理结果，排队后状态请看活动记录。`} />
        <Distribution title="观众常用指令" rows={data.commandTypes.map(r => ({ ...r, label: `#${r.key}` }))} color="#b290c0" foot={`${fmt(s.commands)} 次指令尝试，其中 ${fmt(s.commandErrors)} 次失败。模拟指令不计入。`} />
      </div>
      <div className="an-two">
        <section className="card an-viewers"><div className="an-section-head"><h2>活跃发言观众</h2><span>TOP 8 · 按弹幕数</span></div>{data.topViewers.length ? <div className="an-table-wrap"><table><thead><tr><th>观众</th><th>弹幕</th><th>正文字符</th></tr></thead><tbody>{data.topViewers.map((v, i) => <tr key={v.uid}><td><span className="an-rank">{i + 1}</span><span className="an-viewer-name" title={v.username}>{v.username}<small>UID {v.uid}</small></span></td><td>{fmt(v.messages)}</td><td>{fmt(v.chars)}</td></tr>)}</tbody></table></div> : <div className="an-empty"><Users size={25} /><p>还没有观众发言，等待第一条弹幕。</p></div>}<p className="an-caption">仅统计真实普通 / 特效弹幕，包含指令；同一 UID 改名后仍归为一人。</p></section>
        <Distribution title="热门播报音色" rows={data.topVoices.map(r => ({ ...r, label: r.name }))} empty="开始播报或试听后，会显示使用过的声音。" foot="TOP 6 · 按成功合成与缓存复用次数排序，包含试听和本地模拟。" />
      </div>
      <section className="card"><div className="an-section-head"><h2>本地累计播报保护</h2><span>累计 · 不受上方日期筛选影响</span></div><div className="an-two an-budgets"><Budget title="标准音色 · TTS 2.0" value={data.budget.standard} /><Budget title="专属音色 · 声音复刻" value={data.budget.custom} /></div><p className="an-caption">这是本地额度保护，不是火山账户实时余额。标准额度已包含手动填写的历史已用字数；请求失败或结果不明时保留预估消耗，成功后按返回字数校正。缓存节省为估算值。</p></section>
      <details className="an-definitions"><summary>统计口径与数据保留</summary><ul><li>仅统计当前房间、服务运行且 Bridge 已接入期间收到的事件。数据保留最近 {data.retentionDays} 个自然日，按小时汇总，独立于最多 3,000 条的活动日志；重启保留统计。</li><li>发言观众按可靠 UID 去重，不代表在线人数。进场、礼物等有可靠 UID 的观众计入「全部互动观众」，没有 UID 的事件只计事件数。</li><li>所选时段另收到 {fmt(s.simulatedEvents)} 条本地模拟事件，不计入真实弹幕、活跃观众和指令排行；模拟产生的语音仍消耗额度，所以计入 TTS 统计。</li><li>不会从旧日志推算历史人数或趋势；暂停播报、关闭事件开关不影响接收计数。离线期间未收到的数据不会补录，礼物和点赞统计的是事件条数。</li></ul></details>
    </>}
  </div>;
}

function MetricCard({ label, value, unit, detail, icon: Icon, accent = false }: { label: string; value: number | string; unit: string; detail: string; icon: typeof Activity; accent?: boolean }) {
  return <section className={`an-metric${accent ? ' an-metric-accent' : ''}`}><div><span>{label}</span><Icon size={18} /></div><p>{typeof value === 'number' ? fmt(value) : value}<small>{unit}</small></p><span>{detail}</span></section>;
}
