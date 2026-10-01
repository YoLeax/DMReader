import { z } from 'zod';
import { eventTypes, type EventType } from '../shared/events.js';

// Selected fields from @laplace.live/event-types 2.0.21, checked 2026-10-01.
// Missing UID is intentionally tolerated here; message has stricter identity rules in Engine.
const common = {
  id: z.string().max(300).optional(), origin: z.union([z.number().int().positive().safe(), z.string().regex(/^\d{1,20}$/)]),
  uid: z.unknown().optional(), username: z.string().max(200).optional(),
  timestamp: z.number().finite().optional(), timestampNormalized: z.number().finite().optional(),
};
const content = z.string().max(5000);
const amount = z.number().int().min(1).max(1_000_000_000);
export const eventSchema = z.discriminatedUnion('type', [
  z.object({ ...common, type: z.literal('message'), message: content }),
  z.object({ ...common, type: z.literal('effect-message'), message: content }),
  z.object({ ...common, type: z.literal('gift'), giftName: z.string().max(300), giftAmount: amount, giftId: z.number().int().nonnegative().optional(), receiver: z.object({ uid: z.union([z.number(), z.string()]).optional() }).optional() }),
  z.object({ ...common, type: z.literal('superchat'), message: content, deleted: z.boolean().optional() }),
  z.object({ ...common, type: z.literal('toast'), stableKey: z.string().max(300).optional(), message: content.optional(), toastType: z.number().int().min(1).max(3), toastAmount: amount.optional(), toastAmountUnit: z.string().max(30).optional() }),
  z.object({ ...common, type: z.literal('interaction'), action: z.number().int().min(1).max(5) }),
  z.object({ ...common, type: z.literal('entry-effect') }),
  z.object({ ...common, type: z.literal('like-click') }),
]);
export type ParsedEvent = z.infer<typeof eventSchema>;
export function supportedEvent(value: unknown): value is EventType { return typeof value === 'string' && eventTypes.includes(value as EventType); }
export function identity(value: unknown): string | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? String(value) : null;
  if (typeof value !== 'string' || !value.trim() || /^-?0+$/.test(value) || /^-\d+$/.test(value) || value.length > 100) return null;
  return /^[a-zA-Z0-9_:-]+$/.test(value) ? value : null;
}
export function cleanText(value: string): string {
  const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  let text = value;
  for (let i = 0; i < 2; i++) text = text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity: string) => {
    if (!entity.startsWith('#')) return entities[entity.toLowerCase()] || ' ';
    const n = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : ' ';
  });
  return text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<%([\s\S]*?)%>/g, '$1').replace(/<[^>]*>/g, ' ')
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
}
export function boundedText(value: string, max: number) { const chars = Array.from(value); return chars.length > max ? chars.slice(0, Math.max(0, max - 1)).join('') + '…' : value; }
export function eventKey(event: ParsedEvent): string | null {
  // The SC id already incorporates Bilibili's unique message id. scId is NOT that id.
  // Never strip the gift id's combo suffix, nor use timestamps alone.
  const id = event.type === 'toast' ? event.stableKey?.trim() || (event.id?.trim() ? JSON.stringify([event.id, event.toastType, event.toastAmount, event.toastAmountUnit]) : '') : event.id?.trim();
  if (!id) return null;
  return JSON.stringify([String(event.origin), event.type, id, event.type === 'interaction' ? event.action : null]);
}
export function eventText(event: ParsedEvent, name: string): string {
  if (event.type === 'message' || event.type === 'effect-message' || event.type === 'superchat') {
    const text = cleanText(event.message);
    if (!text || /^[\[{]/.test(text) && (() => { try { return typeof JSON.parse(text) === 'object'; } catch { return false; } })()) return '';
    return event.type === 'superchat' ? `${name}的醒目留言：${text}` : text;
  }
  if (event.type === 'gift') {
    const gift = cleanText(event.giftName);
    return gift ? `感谢${name}送出的 ${event.giftAmount} 个${gift}。` : '';
  }
  if (event.type === 'toast') {
    const rank = { 1: '总督', 2: '提督', 3: '舰长' }[event.toastType]!;
    // Toast has no action enum. Inspect only the action preceding a rank; do not read effect HTML.
    const copy = cleanText((event.message || '').replace(/<%[\s\S]*?%>/g, ''));
    const verb = copy.match(/(开通|续费)了?\s*(?:舰长|提督|总督)/)?.[1] || '支持';
    let duration = '';
    if (event.toastAmount && event.toastAmountUnit) {
      const unit = event.toastAmountUnit;
      if (/^(月|年|天)$/.test(unit)) duration = `，${event.toastAmount}${unit === '月' ? '个' : ''}${unit}`;
      const days = unit.match(/^\*(\d{1,3})天$/);
      if (days && Number(days[1]) > 0) duration = `，${event.toastAmount * Number(days[1])}天`;
    }
    return `感谢${name}${verb}${rank}${duration}。`;
  }
  if (event.type === 'entry-effect' || event.type === 'interaction' && event.action === 1) return `欢迎${name}进入直播间。`;
  if (event.type === 'interaction') return ({ 2: `感谢${name}关注直播间。`, 3: `感谢${name}分享直播间。`, 4: `感谢${name}特别关注主播。`, 5: `${name}与主播互相关注啦。` } as Record<number, string>)[event.action];
  return `感谢${name}点赞。`;
}
// Inspect only event fields, never the SC report token or unrelated upstream data.
const inspectFields = ['type', 'id', 'stableKey', 'origin', 'originIdx', 'uid', 'username', 'message', 'timestamp', 'timestampNormalized', 'giftId', 'giftName', 'giftAmount', 'toastType', 'toastName', 'toastAmount', 'toastAmountUnit', 'action', 'deleted', 'scId'];
export function inspectEvent(raw: Record<string, unknown>) {
  return Object.fromEntries(inspectFields.filter(k => k in raw).map(k => [k, typeof raw[k] === 'string' ? boundedText(raw[k], 1500) : typeof raw[k] === 'number' || typeof raw[k] === 'boolean' || raw[k] == null ? raw[k] : '[字段类型异常]']));
}
