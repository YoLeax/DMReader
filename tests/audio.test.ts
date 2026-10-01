import test from 'node:test';
import assert from 'node:assert/strict';
import { resumeAudio } from '../src/audio.js';

test('already running audio can start without a user gesture', async () => {
  assert.equal(await resumeAudio({ state: 'running', resume: () => { throw new Error('not needed'); } }), true);
});

test('successful automatic resume enables playback', async () => {
  const context = { state: 'suspended' as AudioContextState, async resume() { this.state = 'running'; } };
  assert.equal(await resumeAudio(context), true);
});

test('blocked resume settles without claiming playable audio; later gesture can unlock it', async () => {
  let allow: (() => void) | undefined;
  const context = { state: 'suspended' as AudioContextState, resume: () => new Promise<void>(resolve => { allow = () => { context.state = 'running'; resolve(); }; }) };
  assert.equal(await resumeAudio(context, 5), false);
  const gestureAttempt = resumeAudio(context, 100);
  allow!();
  assert.equal(await gestureAttempt, true);
});

test('a fulfilled resume without running audio is still blocked', async () => {
  assert.equal(await resumeAudio({ state: 'suspended', resume: async () => {} }), false);
});

test('explicit browser denial is blocked; device errors remain actionable errors', async () => {
  assert.equal(await resumeAudio({ state: 'suspended', resume: async () => { throw new DOMException('blocked', 'NotAllowedError'); } }), false);
  await assert.rejects(resumeAudio({ state: 'closed', resume: async () => { throw new DOMException('closed', 'InvalidStateError'); } }), { name: 'InvalidStateError' });
});
