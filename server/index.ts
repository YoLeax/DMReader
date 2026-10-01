import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { createService } from './app.js';
const port = Number(process.env.PORT || 23000);
const service = createService({ dataDir: resolve(process.env.DMREADER_DATA_DIR || 'data') });
service.server.on('error', error => { console.error('服务无法启动：', error.message); process.exitCode = 1; });
service.server.listen(port, '127.0.0.1', () => {
  console.log(`DM Reader 已启动：http://127.0.0.1:${port}\n数据保存在本机 data 目录。按 Ctrl+C 退出。`);
  if (process.argv.includes('--open') && process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '', `http://127.0.0.1:${port}`], { windowsHide: true, stdio: 'ignore' }).unref();
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { void service.close().then(() => process.exit(0)); });
