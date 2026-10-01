import { randomUUID } from 'node:crypto';
import { AppError, type Credentials, type Voice } from './types.js';
export type Synthesis = { text: string; voice: Voice; style: string; speed: number };
export type AudioResult = { audio: Buffer; chars: number; estimated: boolean; logId: string };
export function authHeaders(c: Credentials, design = false): Record<string, string> {
  if (c.apiKey) return { 'X-Api-Key': c.apiKey };
  if (c.appId && c.accessKey) return { [design ? 'X-Api-App-Key' : 'X-Api-App-Id']: c.appId, 'X-Api-Access-Key': c.accessKey };
  throw new AppError('请先在「接入设置」填写豆包语音 API Key。', 503);
}
export function synthesisBody(input: Synthesis) {
  const additions: Record<string, unknown> = {};
  // Current HTTP documentation supports context_texts for standard TTS 2.0 voices.
  // Designed voices use their trained style, without undocumented expressive-model overrides.
  if (input.style && input.voice.resource === 'seed-tts-2.0') additions.context_texts = [input.style];
  return { req_params: { text: input.text, speaker: input.voice.id,
    audio_params: { format: 'mp3', sample_rate: 24000, speech_rate: input.speed },
    additions: JSON.stringify(additions) } };
}
export async function parseAudio(response: Response, fallbackChars: number): Promise<AudioResult> {
  const logId = response.headers.get('x-tt-logid') || '';
  if (!response.ok) throw new AppError(`豆包请求失败（HTTP ${response.status}）。请检查密钥、音色权限、额度。${logId ? ` 日志 ID：${logId}` : ''}`, 502);
  if (!response.body) throw new AppError('豆包未返回音频数据。', 502);
  const parts: Buffer[] = []; let text = '', bytes = 0, chars = fallbackChars, estimated = true;
  const decoder = new TextDecoder();
  const consume = (line: string) => {
    line = line.trim(); if (!line || line.startsWith('event:') || line.startsWith(':')) return;
    if (line.startsWith('data:')) line = line.slice(5).trim();
    if (line === '[DONE]') return;
    let frame: { code?: number; data?: string; usage?: { text_words?: number } };
    try { frame = JSON.parse(line); } catch { throw new AppError('豆包返回了无法解析的音频数据。', 502); }
    if (frame.code !== 0 && frame.code !== 20000000) throw new AppError(`豆包合成失败（错误码 ${frame.code ?? '未知'}）。请检查音色权限、额度和参数。${logId ? ` 日志 ID：${logId}` : ''}`, 502);
    if (frame.data) {
      if (typeof frame.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw new AppError('豆包音频编码无效。', 502);
      const b = Buffer.from(frame.data, 'base64'); bytes += b.length;
      if (bytes > 12 * 1024 * 1024) throw new AppError('合成音频超过大小上限。', 502);
      parts.push(b);
    }
    if (Number.isSafeInteger(frame.usage?.text_words) && frame.usage!.text_words! >= 0) { chars = frame.usage!.text_words!; estimated = false; }
  };
  for await (const chunk of response.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > 20 * 1024 * 1024) throw new AppError('上游响应过大。', 502);
    let i: number;
    while ((i = text.indexOf('\n')) >= 0) { consume(text.slice(0, i)); text = text.slice(i + 1); }
  }
  text += decoder.decode(); if (text.trim()) consume(text);
  // The current HTTP API documents code=0 success; older streams also send 20000000.
  // Await clean HTTP EOF; a broken network stream throws above, never returning partial audio.
  if (!bytes) throw new AppError('豆包未生成可播放音频。', 502);
  return { audio: Buffer.concat(parts), chars, estimated, logId };
}
export class DoubaoProvider {
  constructor(private credentials: () => Credentials, private request: typeof fetch = fetch) {}
  async synthesize(input: Synthesis): Promise<AudioResult> {
    const response = await this.request('https://openspeech.bytedance.com/api/v3/tts/unidirectional', {
      method: 'POST', signal: AbortSignal.timeout(45000),
      headers: { 'Content-Type': 'application/json', ...authHeaders(this.credentials()), 'X-Api-Resource-Id': input.voice.resource, 'X-Api-Request-Id': randomUUID(), 'X-Control-Require-Usage-Tokens-Return': '*' },
      body: JSON.stringify(synthesisBody(input)),
    });
    return parseAudio(response, Array.from(input.text).length);
  }
  async design(speaker: string, prompt: string) {
    const r = await this.request('https://openspeech.bytedance.com/api/v3/tts/voice_design', {
      method: 'POST', signal: AbortSignal.timeout(90000),
      headers: { 'Content-Type': 'application/json', ...authHeaders(this.credentials(), true), 'X-Api-Request-Id': randomUUID() },
      body: JSON.stringify({ speaker_id: speaker, prompt: { text_prompt: prompt }, text: '你好呀，这是属于我的声音。很高兴在直播间遇见你。', language: 0 }),
    });
    if (!r.ok) throw new AppError(`音色设计请求失败（HTTP ${r.status}）。请到火山控制台核对槽位状态和次数，不会自动重试。`, 502);
    const data = await r.json() as { status?: number; speaker_id?: string; available_training_times?: number };
    if (![2, 4].includes(data.status || 0) || data.speaker_id !== speaker) throw new AppError('音色尚未确认可用，请到火山控制台检查生成结果。', 502);
    return data;
  }
}
export function silentWav() {
  const b = Buffer.alloc(44 + 2400); b.write('RIFF'); b.writeUInt32LE(b.length - 8, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(24000, 24); b.writeUInt32LE(48000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(b.length - 44, 40); return b;
}
