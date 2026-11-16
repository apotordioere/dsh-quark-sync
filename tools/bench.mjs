// 上传吞吐基准：并发 N 路、每路 M 个文件，测每组耗时
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCli } from '../lib/cli.js';

const CLI_DIR = process.env.QUARK_SKILL_DIR || path.join(os.homedir(), '.dsh', 'skills', 'quarkclouddrive');
const cliPath = path.join(CLI_DIR, 'scripts', 'quark-drive.cjs');
const cli = createCli({ cliPath, cwd: CLI_DIR, concurrency: 8 });

const SRC = process.argv[2] || 'C:\\Users\\APOTO\\.dsh\\profiles\\desktop\\node_modules\\@deepseek-ai\\dsh-base';
const LANES = Number(process.argv[3] || 4);
const PER = Number(process.argv[4] || 30);

const taskDir = path.join(os.tmpdir(), 'qs-bench');
await fs.mkdir(taskDir, { recursive: true });

// 1. 找到云端 DSH-Sync 下的 bench 目录
const root = await cli.browse(undefined, { taskDir });
const sync = root.items.find((i) => i.filename === 'DSH-Sync' && String(i.file_type) === '0');
if (!sync) throw new Error('DSH-Sync not found');
let kids = (await cli.browse(sync.fid, { taskDir })).items;
let bench = kids.find((i) => i.filename === 'bench' && String(i.file_type) === '0');
if (!bench) {
  await cli.createFolder('bench', sync.fid);
  kids = (await cli.browse(sync.fid, { taskDir })).items;
  bench = kids.find((i) => i.filename === 'bench' && String(i.file_type) === '0');
}
console.log('bench fid', bench.fid);

// 2. 收集文件
async function walk(dir, acc = []) {
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, acc);
    else if (e.isFile()) acc.push(p);
  }
  return acc;
}
const all = await walk(SRC);
const want = LANES * PER;
const pick = [];
while (pick.length < want && all.length) pick.push(...all.slice(0, want - pick.length));
console.log(`共 ${all.length} 个候选，取 ${pick.length}（可重复），${LANES} 路 × ${PER} 个`);

// 3. 并发上传
const chunks = [];
for (let i = 0; i < LANES; i++) chunks.push(pick.slice(i * PER, (i + 1) * PER));
const t0 = Date.now();
const results = await Promise.all(
  chunks.map(async (chunk, i) => {
    const s = Date.now();
    try {
      const r = await cli.upload(chunk, bench.fid);
      return { lane: i, ms: Date.now() - s, ok: r.successCount ?? r.fileCount, size: r.totalSize };
    } catch (e) {
      return { lane: i, ms: Date.now() - s, error: e.message.slice(0, 300) };
    }
  }),
);
const total = Date.now() - t0;
console.log(JSON.stringify(results, null, 2));
console.log(`总耗时 ${(total / 1000).toFixed(1)}s，${(pick.length / (total / 1000)).toFixed(2)} 文件/秒`);
