import type { Voice } from './types.js';
import catalog from './voice-catalog.json';

// Both official TTS 2.0 tables, including foreign and official ICL_uranus presets.
// IDs are copied verbatim: their prefix does not determine the billing resource.
// Personal S_ voices are added separately by Engine from local approved designs.
export const voices: Voice[] = catalog.voices.map(entry => ({
  id: entry.id,
  name: entry.name,
  gender: entry.id.includes('_female_') ? '女声' : '男声',
  language: entry.language,
  scenes: entry.scenes,
  tag: entry.scenes.includes('外语音色') ? '外语音色' : entry.scenes[0],
  description: `豆包 2.0 · ${entry.language} · ${entry.capabilities || '官方预置音色；风格能力以实际效果为准'}`,
  resource: 'seed-tts-2.0',
}));
