// Quark 官方 CLI 封装：node scripts/quark-drive.cjs <cmd> [args]
// 输出是 NDJSON（每行一个 JSON），以 type=result 行作为结束信号。
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const RESULT = 'result';

export class QuarkCliError extends Error {
  constructor(message, payload) {
    super(message);
    this.name = 'QuarkCliError';
    this.payload = payload;
  }
}

function newSessionId() {
  const ts = Math.floor(Date.now() / 1000);
  let r = '';
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 6; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return `${ts}-${r}`;
}

/**
 * 串行队列 + 并发上限。CLI 每次调用都要读本地授权态，
 * 并发过高容易互相踩会话文件，默认 2。
 */
class Limiter {
  constructor(max = 2) {
    this.max = max;
    this.running = 0;
    this.queue = [];
  }

  run(fn) {
    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
      this.drain();
    });
  }

  drain() {
    while (this.running < this.max && this.queue.length) {
      const job = this.queue.shift();
      this.running++;
      Promise.resolve()
        .then(job.fn)
        .then(job.resolve, job.reject)
        .finally(() => {
          this.running--;
          this.drain();
        });
    }
  }
}

/**
 * 找真正的 node 可执行文件。
 * 在 DSH 桌面版主进程里 process.execPath 是 Electron 本体，直接用它会带着 Electron 的
 * 身份去跑 CLI（实测 CLI 以 -104「无法识别当前 Agent 环境」拒绝）。
 * 优先 DSH_NODE_EXECUTABLE，其次在 PATH 里找 node.exe。
 */
function isNodeBinary(p) {
  return /^node(\.exe)?$/i.test(path.basename(String(p || '')));
}

function resolveNodeExe() {
  const dirs = String(process.env.PATH || '').split(path.delimiter);
  for (const dir of dirs) {
    if (!dir) continue;
    for (const name of ['node.exe', 'node']) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), name);
      if (existsSync(candidate)) return candidate;
    }
  }
  // DSH_NODE_EXECUTABLE 在桌面版里指向 Electron 本体（D:\deepseek\DeepSeek Harness.exe），
  // 只有名字真是 node 时才用。
  const fromEnv = process.env.DSH_NODE_EXECUTABLE;
  if (fromEnv && isNodeBinary(fromEnv) && existsSync(fromEnv)) return fromEnv;
  return process.execPath;
}

/** CLI 只给它自己需要的那几个环境变量，避免把 Agent/Electron 的身份带进去。 */
function cliEnv(nodeExe) {
  const keys = [
    'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'COMSPEC',
    'USERPROFILE', 'USERNAME', 'APPDATA', 'LOCALAPPDATA', 'HOMEDRIVE', 'HOMEPATH',
    'TEMP', 'TMP', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS', 'LANG',
  ];
  const env = {};
  for (const key of keys) if (process.env[key]) env[key] = process.env[key];
  if (!env.USERPROFILE) env.USERPROFILE = os.homedir();
  if (!env.APPDATA) env.APPDATA = path.join(os.homedir(), 'AppData', 'Roaming');
  env.NODE_NO_WARNINGS = '1';
  // 夸克 CLI 靠 DSH_HOME（或 DSH_SESSION_ID）识别「当前 Agent 环境」，缺了就报
  // -104「无法识别当前 Agent 环境，禁止继续使用」。宿主进程里没有这个变量，必须自己补。
  env.DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  if (process.env.DSH_SESSION_ID) env.DSH_SESSION_ID = process.env.DSH_SESSION_ID;
  // 兜底：实在找不到 node.exe 时用 Electron 本体跑，必须让它以纯 Node 身份运行。
  if (!isNodeBinary(nodeExe)) env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

export function createCli(options) {
  const cliPath = options.cliPath;
  const cwd = options.cwd || path.dirname(path.dirname(cliPath));
  const nodeExe = options.nodeExe || resolveNodeExe();
  const sessionInput = options.sessionInput || 'DSH quark sync';
  const defaultTimeoutMs = options.timeoutMs || 30 * 60 * 1000;
  const limiter = new Limiter(options.concurrency || 2);

  function raw(args, opts = {}) {
    return new Promise((resolve, reject) => {
      const sessionId = opts.sessionId || newSessionId();
      const finalArgs = [
        cliPath,
        ...args,
        '--session-input',
        sessionInput,
        '--session-id',
        sessionId,
      ];
      const child = spawn(nodeExe, finalArgs, {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: cliEnv(nodeExe),
      });

      const lines = [];
      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try {
          child.kill('SIGKILL');
        } catch {}
        reject(new QuarkCliError(`CLI 超时 ${Math.round((opts.timeoutMs || defaultTimeoutMs) / 1000)}s: ${args[0]}`, { args }));
      }, opts.timeoutMs || defaultTimeoutMs);

      const finish = (err, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve(value);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        stdoutBuf += chunk;
        let idx;
        while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
          const line = stdoutBuf.slice(0, idx).trim();
          stdoutBuf = stdoutBuf.slice(idx + 1);
          if (!line) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
          lines.push(obj);
          if (obj.type === RESULT && opts.onResult) {
            try {
              opts.onResult(obj);
            } catch {}
          }
          if (obj.type === 'progress' && opts.onProgress) {
            try {
              opts.onProgress(obj);
            } catch {}
          }
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (c) => {
        stderrBuf += c;
      });
      child.on('error', (e) => finish(new QuarkCliError(`CLI 启动失败: ${e.message}`, { args })));
      child.on('close', (code) => {
        const result = lines.filter((l) => l.type === RESULT).pop();
        if (stderrBuf && opts.onStderr) {
          try {
            opts.onStderr(stderrBuf);
          } catch {}
        }
        if (result) {
          if (result.code !== 0) {
            return finish(new QuarkCliError(`CLI 返回失败(${result.code}): ${result.msg || ''}`, result));
          }
          return finish(null, result);
        }
        if (code !== 0) {
          return finish(
            new QuarkCliError(
              `CLI 退出码 ${code}，无 result 行: ${(stderrBuf || stdoutBuf).slice(-800)}`,
              { args, code },
            ),
          );
        }
        finish(new QuarkCliError(`CLI 无 result 行: ${(stderrBuf || stdoutBuf).slice(-800)}`, { args }));
      });
    });
  }

  function run(args, opts = {}) {
    return limiter.run(() => raw(args, opts));
  }

  return {
    cwd,
    cliPath,
    limiter,
    run,

    async userInfo() {
      const r = await run(['get-user-info']);
      return r.data || {};
    },

    async login(token) {
      const r = await run(token ? ['login', '--token', token] : ['login']);
      return r.data || {};
    },

    async isAuthorized() {
      try {
        const info = await this.userInfo();
        return Boolean(info && info.userInfo);
      } catch {
        return false;
      }
    },

    /** 建目录（注意：返回的 data.fid 不是可用 fid，必须再 browse 按 filename 解析） */
    async createFolder(dirPath, parentFid) {
      const args = ['create-folder', '--dir-path', dirPath];
      if (parentFid) args.push('--parent-fid', parentFid);
      return run(args);
    },

    /**
     * 列目录。CLI 把条目写进 <taskDir>/browse/browse-*.jsonl，
     * result 行给 {file_path, parent_fid, count, hasMore}。
     */
    async browse(parentFid, opts = {}) {
      const taskDir = opts.taskDir;
      const args = ['browse'];
      if (parentFid) args.push('--parent-fid', parentFid);
      args.push('--task-dir', taskDir);
      if (opts.all !== false) args.push('--all');
      if (opts.pageSize) args.push('--page-size', String(opts.pageSize));
      const r = await run(args, { timeoutMs: opts.timeoutMs });
      const data = r.data || {};
      let items = [];
      if (data.file_path) {
        try {
          const text = await fs.readFile(data.file_path, 'utf8');
          items = text
            .split('\n')
            .filter(Boolean)
            .map((l) => {
              try {
                return JSON.parse(l);
              } catch {
                return null;
              }
            })
            .filter(Boolean);
        } catch (e) {
          throw new QuarkCliError(`browse 结果文件读取失败: ${e.message}`, data);
        }
      }
      return { ...data, items };
    },

    /**
     * 上传。批量：传一个暂存目录（内含 sha256 命名的文件）。
     * 返回 {fileCount, successCount, totalSize, fids, ...}
     */
    async upload(pathsArg, parentFid, opts = {}) {
      const args = ['upload', ...(Array.isArray(pathsArg) ? pathsArg : [pathsArg])];
      if (parentFid) args.push('--parent-fid', parentFid);
      const r = await run(args, { timeoutMs: opts.timeoutMs, onProgress: opts.onProgress });
      return r.data || {};
    },

    /** 下载单个文件；--overwrite 才允许覆盖本地已存在文件 */
    async download(fid, outputDir, opts = {}) {
      const args = ['download', '--fid', fid, '--output-dir', outputDir];
      if (opts.overwrite !== false) args.push('--overwrite');
      const r = await run(args, { timeoutMs: opts.timeoutMs, onProgress: opts.onProgress });
      return r.data || {};
    },

    async search(query, opts = {}) {
      const args = ['search', query];
      if (opts.parentFid) args.push('--parent-fid', opts.parentFid);
      const r = await run(args, { timeoutMs: opts.timeoutMs });
      return r.data || {};
    },
  };
}
