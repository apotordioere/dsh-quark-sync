// 首传脚本：用和插件完全相同的引擎与状态目录跑一次全量推送。
// 插件装好后会复用这里的哈希缓存与 manifest，不会重传。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCli } from '../lib/cli.js';
import { createEngine } from '../lib/engine.js';
import { DEFAULT_SCOPES, resolveScopes, deviceId } from '../lib/scope.js';

const home = os.homedir();
const CLI_DIR = process.env.QUARK_SKILL_DIR || path.join(home, '.dsh', 'skills', 'quarkclouddrive');
const stateRoot = path.join(home, '.dsh', 'dsh-quark-sync');
await fs.mkdir(stateRoot, { recursive: true });

// 设备 id 与插件共用 registry.json
const registryPath = path.join(stateRoot, 'registry.json');
let registry = {};
try {
  registry = JSON.parse(await fs.readFile(registryPath, 'utf8'));
} catch {}
if (!registry.deviceId) {
  registry.deviceId = deviceId();
  await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));
}

const t0 = Date.now();
const log = (m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${m}`);

const cli = createCli({ cliPath: path.join(CLI_DIR, 'scripts', 'quark-drive.cjs'), cwd: CLI_DIR, concurrency: 2 });
const engine = createEngine({
  cli,
  scopes: resolveScopes(DEFAULT_SCOPES.filter((s) => s.default)),
  statePath: path.join(stateRoot, 'state.json'),
  deviceId: registry.deviceId,
  dshVersion: '0.2.2-rc.3',
  log,
  config: { cloudRoot: 'DSH-Sync', allowAppOverwrite: false },
});

const result = await engine.push();
console.log('PUSH', JSON.stringify(result, null, 2));
console.log(`设备 ${registry.deviceId}`);
process.exit(result.failed ? 1 : 0);
