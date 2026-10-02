import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesService, stopService, type Listener, type StopDependencies } from '../scripts/stop-service.js';

const root = 'D:\\Project\\AI Coding\\261001-DMReader';
const listener: Listener = { pid: 12345, executable: 'C:\\Program Files\\nodejs\\node.exe', command: '"C:\\Program Files\\nodejs\\node.exe" --import tsx server/index.ts', startedAt: '2026-10-02T07:40:30.7174600Z' };
test('stop script recognizes direct Node and npm/tsx launches but rejects unrelated programs and projects', () => {
  assert.equal(matchesService(listener, root), true);
  assert.equal(matchesService({ ...listener, command: 'node --require "D:\\Project\\AI Coding\\261001-DMReader\\node_modules\\tsx\\dist\\preflight.cjs" --import file:///loader.mjs server/index.ts --open' }, root), true);
  assert.equal(matchesService({ ...listener, command: `node --import tsx "${root}\\server\\index.ts"` }, root), true);
  for (const different of [
    { ...listener, executable: 'C:\\some-app.exe' },
    { ...listener, command: 'node unrelated.js' },
    { ...listener, command: 'node server/index.ts.backup' },
    { ...listener, command: 'node --import tsx "D:\\Other project\\server\\index.ts"' },
  ]) assert.equal(matchesService(different, root), false);
});

test('stopping an already absent service is idempotent and never invokes health or termination', async () => {
  const deps: StopDependencies = { inspect: () => null, health: async () => { throw new Error('must not query'); }, terminate: () => { throw new Error('must not terminate'); } };
  assert.match(await stopService(23000, root, deps), /未运行/);
  assert.match(await stopService(23000, root, deps), /未运行/);
  await assert.rejects(stopService(0, root, deps), /端口必须/);
});

test('stop requires both matching process and healthy app, then confirms the exact process and port release', async () => {
  let stopped: Listener | null = null, healthCalls = 0;
  const deps: StopDependencies = { inspect: () => stopped ? null : listener, health: async () => { healthCalls++; return true; }, terminate: p => { stopped = p; } };
  assert.match(await stopService(23000, root, deps), /已关闭.*12345.*23000.*已释放/);
  assert.deepEqual(stopped, listener); assert.equal(healthCalls, 1);
  stopped = null;
  await assert.rejects(stopService(23000, root, { ...deps, health: async () => false }), /无法确认为 DM Reader/);
  await assert.rejects(stopService(23000, root, { ...deps, health: async () => { throw new Error('timeout'); } }), /无法确认为 DM Reader/);
  await assert.rejects(stopService(23000, root, { ...deps, inspect: () => ({ ...listener, command: 'node another.js' }) }), /无法确认为 DM Reader/);
  assert.equal(stopped, null);
});

test('PID reuse or command changes between checks do not terminate another process', async () => {
  for (const replacement of [{ ...listener, pid: 54321 }, { ...listener, startedAt: '2026-10-02T07:50:00Z' }, { ...listener, command: 'node unrelated.js' }]) {
    let inspections = 0;
    await assert.rejects(stopService(23000, root, { inspect: () => ++inspections === 1 ? listener : replacement, health: async () => true,
      terminate: () => { throw new Error('must not terminate replacement'); } }), /进程发生变化/);
  }
});

test('a replacement listener after stopping is reported and never killed', async () => {
  let stopped = 0;
  await assert.rejects(stopService(23000, root, { inspect: () => stopped ? { ...listener, pid: 54321 } : listener, health: async () => true,
    terminate: () => { stopped++; } }), /出现了新进程/);
  assert.equal(stopped, 1);
});
