import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCli } from './lib/cli.js';
import { createEngine } from './lib/engine.js';
import { DEFAULT_SCOPES, deviceId as makeDeviceId, resolveAllScopes } from './lib/scope.js';

const DEFAULT_CONFIG = {
  autoSync: false,
  autoPull: false,
  intervalSeconds: 43200,
  pullOnStart: false,
  cloudRoot: 'DSH-Sync',
  cliPath: '%USERPROFILE%\\.dsh\\skills\\quarkclouddrive\\scripts\\quark-drive.cjs',
  enabledScopes: [],
  allowAppOverwrite: false,
  concurrency: 2,
};

/** Host 注入的工具服务。 */
export const inject = ['tools'];

/**
 * 插件配置的 Standard Schema 最小实现。
 * 故意不 import @deepseek-ai/schemastery：从工作区 link: 安装的插件按真实路径解析
 * 裸包名，profile 的 node_modules 不在查找链上，实测会 ERR_MODULE_NOT_FOUND。
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-quark-sync',
    validate(value) {
      if (value !== undefined && (typeof value !== 'object' || value === null || Array.isArray(value))) {
        return { issues: [{ message: 'quark-sync 配置必须是对象', path: [] }] };
      }
      const merged = { ...DEFAULT_CONFIG, ...(value || {}) };
      if (!Array.isArray(merged.enabledScopes)) merged.enabledScopes = [];
      if (!Number.isFinite(Number(merged.intervalSeconds))) merged.intervalSeconds = DEFAULT_CONFIG.intervalSeconds;
      if (!Number.isFinite(Number(merged.concurrency))) merged.concurrency = DEFAULT_CONFIG.concurrency;
      return { value: merged };
    },
  },
};

/** 展开 Windows 的 %VAR% 和跨平台的 ${VAR}。 */
export function expandEnv(value) {
  if (typeof value !== 'string') return value;
  const home = os.homedir();
  const fallback = {
    USERPROFILE: home,
    HOME: home,
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    TEMP: os.tmpdir(),
    TMP: os.tmpdir(),
  };
  return path.normalize(value
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] || fallback[name] || '')
    .replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] || fallback[name] || ''));
}

/** 读取宿主版本；开发环境或非标准打包路径失败时返回 unknown。 */
function readDshVersion() {
  try {
    const packagePath = path.join(process.resourcesPath, 'app.asar', 'package.json');
    const pkg = JSON.parse(readFileSync(packagePath, 'utf8'));
    return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

/** 注册表保存稳定设备 ID，损坏时重新生成并覆盖。 */
function loadOrCreateDeviceId(registryPath, stateDir, log) {
  const current = makeDeviceId();
  try {
    mkdirSync(stateDir, { recursive: true });
    const saved = JSON.parse(readFileSync(registryPath, 'utf8'));
    if (saved && typeof saved.deviceId === 'string' && saved.deviceId) return saved.deviceId;
  } catch {
    // 文件不存在或损坏都按首次启动处理。
  }
  try {
    writeFileSync(registryPath, JSON.stringify({ deviceId: current }, null, 2), 'utf8');
  } catch (error) {
    log.warn(`无法持久化设备注册表 ${registryPath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return current;
}

/** 把任意错误转成工具可展示的短文本，避免把异常抛给 Agent。 */
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 生成工具返回的 JSON 文本卡片。 */
const jsonOutput = {
  schema: {
    type: 'object',
    additionalProperties: true,
    properties: {
      ok: { type: 'boolean' },
      error: { type: 'string' },
    },
  },
  render: (_args, value) => [{
    type: 'text',
    text: JSON.stringify(value, null, 2),
  }],
};

export function apply(ctx, config = {}) {
  const resolvedConfig = { ...DEFAULT_CONFIG, ...(config || {}) };
  const logger = ctx.logger('quark-sync');
  const log = (message) => logger.info(message);
  const stateDir = expandEnv('%USERPROFILE%\\.dsh\\dsh-quark-sync');
  const statePath = path.join(stateDir, 'state.json');
  const registryPath = path.join(stateDir, 'registry.json');
  const stableDeviceId = loadOrCreateDeviceId(registryPath, stateDir, logger);
  const dshVersion = readDshVersion();
  const cliPath = expandEnv(resolvedConfig.cliPath);
  const cliInstalled = Boolean(cliPath && existsSync(cliPath));
  let engine;

  if (!cliInstalled) {
    logger.warn(`未安装夸克 CLI：找不到 ${cliPath || '(空路径)'}。请先安装 quarkclouddrive Skill，或在插件配置中填写 cliPath；工具仍会注册并返回可操作提示。`);
  } else {
    // 必须走 resolveScopes：DEFAULT_SCOPES 里存的是 %USERPROFILE% 这类占位符，
    // 直接传给引擎会把所有 C 盘范围内的根目录写成字面量（实测全部 ENOENT，等于漏同步一半数据）。
    const pickedScopes = resolveAllScopes(resolvedConfig.enabledScopes, log);
    const cli = createCli({
      cliPath,
      // cwd 必须指向 skill 根目录（quark-drive.cjs 的上一级 scripts 的上一级）：
      // 从 DSH 主进程里 spawn 时默认 cwd 是应用目录，CLI 会以 -104「无法识别当前 Agent 环境」拒绝执行。
      cwd: path.dirname(path.dirname(cliPath)),
      concurrency: resolvedConfig.concurrency,
      sessionInput: 'DSH 夸克云同步',
    });
    engine = createEngine({
      cli,
      scopes: pickedScopes,
      refreshScopes: () => resolveAllScopes(resolvedConfig.enabledScopes, log),
      statePath,
      deviceId: stableDeviceId,
      dshVersion,
      log,
      config: {
        cloudRoot: resolvedConfig.cloudRoot,
        allowAppOverwrite: resolvedConfig.allowAppOverwrite,
      },
    });
  }

  const tool = {
    name: 'quark_sync',
    description: '同步 DSH 会话、记忆、插件和工作区文件到夸克网盘；可查看状态、推送或拉取。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'push', 'pull'],
          description: '要执行的操作：status 查看状态，push 推送本机文件，pull 从云端拉取。',
        },
      },
      required: ['action'],
    },
    output: jsonOutput,
    async execute(args) {
      if (!engine) {
        return {
          ok: false,
          error: `未安装夸克 CLI：找不到 ${cliPath || '(空路径)'}。请安装 quarkclouddrive Skill，或修改插件配置中的 cliPath 后重试。`,
        };
      }
      try {
        if (args.action === 'status') return await engine.status();
        if (args.action === 'push') return await engine.runExclusive('push', () => engine.push());
        if (args.action === 'pull') return await engine.runExclusive('pull', () => engine.pull());
        return { ok: false, error: `不支持的 action：${String(args.action)}` };
      } catch (error) {
        return { ok: false, error: errorText(error) };
      }
    },
  };
  ctx.effect(() => ctx.tools.register(tool), 'quark-sync: tool quark_sync');

  if (engine && resolvedConfig.autoSync) {
    ctx.effect(() => {
      const seconds = Number.isFinite(Number(resolvedConfig.intervalSeconds))
        ? Math.max(1, Number(resolvedConfig.intervalSeconds))
        : DEFAULT_CONFIG.intervalSeconds;
      const timer = setInterval(() => {
        if (engine.busy()) return;
        void Promise.resolve()
          .then(() => engine.runExclusive('push', () => engine.push()))
          .then(() => {
            if (!resolvedConfig.autoPull || engine.busy()) return undefined;
            return engine.runExclusive('pull', () => engine.pull());
          })
          .catch((error) => {
            logger.warn(`自动同步失败：${errorText(error)}`);
          });
      }, seconds * 1000);
      return () => clearInterval(timer);
    }, 'quark-sync: auto push');
  }

  if (engine && resolvedConfig.pullOnStart) {
    ctx.effect(() => {
      const timer = setTimeout(() => {
        void Promise.resolve()
          .then(() => engine.runExclusive('pull', () => engine.pull()))
          .catch((error) => {
            logger.warn(`启动拉取失败：${errorText(error)}`);
          });
      }, 20_000);
      return () => clearTimeout(timer);
    }, 'quark-sync: pull on start');
  }
}
