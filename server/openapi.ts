import { createHash, createHmac } from 'node:crypto';
import type { OpenApiCredentials } from './types.js';

export type SpeechAction = 'ListSpeakers' | 'ResourcePacksStatus';
export const speechOpenApiUrl = (action: SpeechAction) => `https://open.volcengineapi.com/?Action=${action}&Version=2025-05-20`;
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();
export function speechOpenApiHeaders(action: SpeechAction, body: string, credentials: OpenApiCredentials, now = new Date()) {
  // Canonicalization follows volcengine/volc-sdk-nodejs src/base/sign.ts.
  const date = now.toISOString().replace(/[:-]|\.\d{3}/g, ''), day = date.slice(0, 8);
  const scope = `${day}/cn-beijing/speech_saas_prod/request`, digest = hash(body);
  const signed = 'host;x-content-sha256;x-date';
  const canonical = ['POST', '/', `Action=${action}&Version=2025-05-20`, `host:open.volcengineapi.com\nx-content-sha256:${digest}\nx-date:${date}\n`, signed, digest].join('\n');
  const key = hmac(hmac(hmac(hmac(credentials.secretAccessKey, day), 'cn-beijing'), 'speech_saas_prod'), 'request');
  const signature = hmac(key, ['HMAC-SHA256', date, scope, hash(canonical)].join('\n')).toString('hex');
  return { 'Content-Type': 'application/json; charset=UTF-8', 'X-Date': date, 'X-Content-Sha256': digest,
    Authorization: `HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signed}, Signature=${signature}` };
}
