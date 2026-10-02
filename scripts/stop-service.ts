import { execFileSync } from 'node:child_process';
import { basename, dirname, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export interface Listener { pid: number; executable: string; command: string; startedAt: string; }
export interface StopDependencies {
  inspect: (port: number) => Listener | null;
  health: (port: number) => Promise<boolean>;
  terminate: (listener: Listener) => void;
}
const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function powershell(script: string) {
  return execFileSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; ${script}`],
  { windowsHide: true, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}
function inspect(port: number): Listener | null {
  const result = powershell(`
    $listeners = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue);
    if ($listeners.Count -eq 0) { 'null'; exit 0 }
    if ($listeners.Count -ne 1) { throw 'Ambiguous listening processes' }
    $serviceProcess = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $listeners[0].OwningProcess);
    if (-not $serviceProcess) { 'null'; exit 0 }
    [pscustomobject]@{ pid = [int]$serviceProcess.ProcessId; executable = $serviceProcess.ExecutablePath;
      command = $serviceProcess.CommandLine; startedAt = $serviceProcess.CreationDate.ToUniversalTime().ToString('o') } | ConvertTo-Json -Compress
  `);
  return JSON.parse(result);
}
export function matchesService(listener: Listener, root: string) {
  if (win32.basename(listener.executable || '').toLowerCase() !== 'node.exe') return false;
  const match = /(?:^|\s)(?:"([^"\r\n]*server[\\/]index\.ts)"|([^\s"]*server[\\/]index\.ts))(?=\s|$)/i.exec(listener.command || '');
  if (!match) return false;
  const entry = win32.normalize(match[1] || match[2]);
  // npm/tsx and the previous hidden launch both use server/index.ts relative to the project.
  return entry.toLowerCase() === 'server\\index.ts' || win32.isAbsolute(entry) && entry.toLowerCase() === win32.join(root, 'server', 'index.ts').toLowerCase();
}
const windows: StopDependencies = {
  inspect,
  health: async port => {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(2500), redirect: 'error' });
    return response.ok && (await response.json()).app === 'dmreader';
  },
  terminate: listener => {
    // Recheck creation time at termination to avoid acting on a reused PID.
    if (!Number.isInteger(listener.pid) || listener.pid <= 0 || !/^[0-9T:.Z+-]+$/.test(listener.startedAt)) throw new Error('进程标识异常，未停止任何进程。');
    powershell(`$serviceProcess = Get-CimInstance Win32_Process -Filter 'ProcessId = ${listener.pid}';
      if (-not $serviceProcess) { exit 0 }
      if ($serviceProcess.CreationDate.ToUniversalTime().ToString('o') -ne '${listener.startedAt}') { throw 'Process identity changed' }
      Stop-Process -Id ${listener.pid} -ErrorAction Stop`);
  },
};
export async function stopService(port: number, root = projectDir, deps: StopDependencies = windows) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须是 1～65535 的整数。');
  const first = deps.inspect(port);
  if (!first) return `DM Reader 未运行：127.0.0.1:${port} 没有监听进程，无需关闭。`;
  if (!matchesService(first, root) || !await deps.health(port).catch(() => false)) throw new Error(`端口 ${port} 上的进程无法确认为 DM Reader，未停止任何进程。`);
  const current = deps.inspect(port);
  if (!current) return 'DM Reader 已经退出。';
  if (current.pid !== first.pid || current.startedAt !== first.startedAt || current.command !== first.command || current.executable !== first.executable) throw new Error('核对期间服务进程发生变化，未执行关闭，请重新运行脚本。');
  deps.terminate(current);
  for (let attempt = 0; attempt < 5; attempt++) {
    const remaining = deps.inspect(port);
    if (!remaining) return `DM Reader 已关闭（PID ${current.pid}），端口 ${port} 已释放。设置、密钥和观众数据已保留。`;
    if (remaining.pid !== current.pid || remaining.startedAt !== current.startedAt) throw new Error(`原服务已关闭，但端口 ${port} 出现了新进程；请检查是否有开发模式自动重启服务。`);
    await delay(200);
  }
  throw new Error(`关闭后端口 ${port} 仍未释放，请检查运行中的启动窗口。`);
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length && (args.length !== 2 || args[0] !== '--port')) throw new Error(`用法：node ${basename(fileURLToPath(import.meta.url))} [--port 23000]`);
    if (process.platform !== 'win32') throw new Error('此关闭脚本用于 Windows；其他系统请在服务终端按 Ctrl+C。');
    console.log(await stopService(Number(args[1] || process.env.PORT || 23000)));
  } catch (error) {
    console.error(error instanceof Error && !('status' in error) ? error.message : '无法核对或关闭服务，请检查当前账号是否有访问该进程的权限。');
    process.exitCode = 1;
  }
}
