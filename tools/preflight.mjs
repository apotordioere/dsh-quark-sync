// 首传预检（只扫描+哈希，不上传）：
// 用来在真正开始 11.7 GB 首传之前，确认文件数、体积、打包数量、超长路径与读取失败。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCli } from '../lib/cli.js';
import { resolveAllScopes, deviceId } from '../lib/scope.js';
import { scanAll } from '../lib/scan.js';

const CLI_DIR = process.env.QUARK_SKILL_DIR || path.join(os.homedir(), '.dsh', 'skills', 'quarkclouddrive');
const workRoot = path.join(os.tmpdir(), 'qs-preflight');
await fs.mkdir(workRoot, { recursive: true });

const cli = createCli({ cliPath: path.join(CLI_DIR, 'scripts', 'quark-drive.cjs'), cwd: CLI_DIR, concurrency: 2 });
const scopes = resolveAllScopes();

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const items = await scanAll(scopes, log);
log(`扫描完成：${items.length} 文件`);

const byScope = new Map();
let bytes = 0;
let longest = { len: 0, p: '' };
for (const it of items) {
  const s = byScope.get(it.scopeId) || { files: 0, bytes: 0 };
  s.files++;
  s.bytes += it.size;
  byScope.set(it.scopeId, s);
  bytes += it.size;
  if (it.cloudPath.length > longest.len) longest = { len: it.cloudPath.length, p: it.cloudPath };
}

console.log('\n=== 按范围 ===');
for (const [id, s] of [...byScope].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`${id.padEnd(24)} ${String(s.files).padStart(7)} 文件  ${(s.bytes / 1048576).toFixed(1).padStart(9)} MB`);
}
console.log(`\n合计 ${items.length} 文件 / ${(bytes / 1048576).toFixed(1)} MB`);
console.log(`最长云端路径 ${longest.len} 字符: ${longest.p}`);
console.log(`当前设备 ${deviceId()}`);
process.exit(0);
