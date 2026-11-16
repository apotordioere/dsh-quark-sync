// 引擎联调脚本（不依赖 DSH 宿主）：用小范围真实数据跑一遍 push -> pull
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCli } from '../lib/cli.js';
import { createEngine } from '../lib/engine.js';
import { deviceId } from '../lib/scope.js';

const CLI_DIR = process.env.QUARK_SKILL_DIR || path.join(os.homedir(), '.dsh', 'skills', 'quarkclouddrive');
const cliPath = path.join(CLI_DIR, 'scripts', 'quark-drive.cjs');

const cmd = process.argv[2] || 'push';
const workRoot = path.join(process.env.TEMP || os.tmpdir(), 'qs-engine-test');
const statePath = path.join(workRoot, 'state.json');
const srcRoot = 'D:\\Mnemon';
const dstRoot = path.join(workRoot, 'pulled');

const cli = createCli({ cliPath, cwd: CLI_DIR, concurrency: 2 });
const log = (m) => console.log(`[log] ${m}`);

function makeScopes(root) {
  return [{ id: 'probe', kind: 'dir', root, cloud: 'probe/mnemon', exclude: [], default: true }];
}

await fs.mkdir(workRoot, { recursive: true });

if (cmd === 'push') {
  const engine = createEngine({ cli, scopes: makeScopes(srcRoot), statePath, deviceId: 'probe-device', dshVersion: 'test', log });
  const r = await engine.push();
  console.log('PUSH', JSON.stringify(r, null, 2));
} else if (cmd === 'pull') {
  const engine = createEngine({ cli, scopes: makeScopes(dstRoot), statePath: statePath.replace('.json', '-pull.json'), deviceId: 'probe-puller', dshVersion: 'test', log });
  const r = await engine.pull();
  console.log('PULL', JSON.stringify(r, null, 2));
  const files = await fs.readdir(dstRoot, { recursive: true });
  console.log('pulled files:', files.length);
} else if (cmd === 'status') {
  const engine = createEngine({ cli, scopes: makeScopes(srcRoot), statePath, deviceId: 'probe-device', dshVersion: 'test', log });
  const r = await engine.status();
  console.log('STATUS', JSON.stringify(r, null, 2));
} else if (cmd === 'cleanup') {
  const engine = createEngine({ cli, scopes: makeScopes(srcRoot), statePath, deviceId: 'probe-device', dshVersion: 'test', log });
  const c = await engine.ensureCloud();
  console.log('cloud', JSON.stringify(c, null, 2));
}
