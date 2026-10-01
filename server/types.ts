import { defaultEventSpeech, defaultInteractionActions, type EventType, type InteractionAction } from '../shared/events.js';
export interface Voice { id: string; name: string; gender: string; tag: string; description: string; language?: string; scenes?: string[]; aliases?: string[]; resource: 'seed-tts-2.0' | 'seed-icl-2.0'; }
export interface OpenApiCredentials { accessKeyId: string; secretAccessKey: string; }
export interface Settings {
  enabled: boolean; mode: 'bridge' | 'api'; roomId: string; defaultVoice: string;
  defaultStyle: string; speechRate: number; maxChars: number; maxQueue: number;
  cooldownSeconds: number; allowStyles: boolean; allowDesignRequests: boolean;
  announceUsername: boolean; budget: number; usedBefore: number; cloneBudget: number;
  blockedWords: string; allowedOrigins: string[];
  eventSpeech: Record<EventType, boolean>; interactionActions: Record<InteractionAction, boolean>;
  commandFeedback: boolean; giftCooldownSeconds: number; likeCooldownSeconds: number; entryCooldownSeconds: number;
}
export interface Viewer {
  uid: string; username: string; voice: string; style: string; speed: number | null;
  muted: boolean; locked: boolean; updatedAt: string; lastSeen: string;
}
export interface Credentials { apiKey: string; appId: string; accessKey: string; }
export interface ChatEvent { type: string; id: string; origin: number | string; uid?: number | string; username?: string; message?: string; timestamp?: number; }
export interface LogEntry { id: number; time: string; kind: string; eventType: string; uid: string; username: string; text: string; voice: string; detail: string; chars: number; latency: number; }
export class AppError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const defaults: Settings = {
  enabled: true, mode: 'bridge', roomId: '659719', defaultVoice: 'zh_female_vv_uranus_bigtts',
  defaultStyle: '', speechRate: 0, maxChars: 120, maxQueue: 15,
  cooldownSeconds: 10, allowStyles: true, allowDesignRequests: true,
  announceUsername: false, budget: 19000, usedBefore: 0, cloneBudget: 0,
  blockedWords: '', allowedOrigins: ['https://laplace.chat', 'https://chat.laplace.live', 'https://laplace.live'],
  eventSpeech: defaultEventSpeech, interactionActions: defaultInteractionActions,
  commandFeedback: true, giftCooldownSeconds: 10, likeCooldownSeconds: 30, entryCooldownSeconds: 60,
};
