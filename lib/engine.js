// 同步引擎：内容寻址（CAS）+ 打包（tar）+ 每设备 manifest
//
// 云端布局：
//   DSH-Sync/blobs/<key>                    打包后的内容块（gzip）
//   DSH-Sync/manifests/<device>/<ts>.json   本设备某一时刻的完整清单
//
// 为什么这样：夸克官方 CLI 既不能覆盖同名文件（同名会变成 name(1)），也没有删除命令。
//   · 内容寻址：块名 = 内容指纹，内容变则名字变，永不覆盖；
//   · 打包：2 万个小文件逐个传会慢到不可用（实测约 3.4 s/文件），打成 16 MB 的包后
//     上传/下载都变成几百次调用；
//   · 大文件（>32 MB）单独成块，避免整块重建。
import { createHash, randomUUID } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { scanAll } from './scan.js';
import { isExcluded } from './scope.js';
import { loadState, saveState } from './state.js';
import { packTar, unpackTar } from './tar.js';

const HASH_CONCURRENCY = 4;
const BUNDLE_MAX_BYTES = 16 * 1024 * 1024;
const BUNDLE_MAX_FILES = 400;
const RAW_THRESHOLD = 32 * 1024 * 1024;
const BUNDLES_PER_UPLOAD = 3;
const UPLOAD_LANES = 3;
const DOWNLOAD_LANES = 6;
const RECENT_WRITE_MS = 30 * 1000;

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 夸克的上传偶尔会 60 s 分片超时（1007），重试一次多半就过，没必要让整轮 push 失败。
async function uploadWithRetry(cli, file, folder, attempts = 3) {
  let lastErr;
  for (let n = 0; n < attempts; n++) {
    try {
      await cli.upload(file, folder);
      return;
    } catch (e) {
      lastErr = e;
      if (n < attempts - 1) await sleep(5000 * (n + 1));
    }
  }
  throw lastErr;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    for (;;) {
      const idx = i++;
      if (idx >= items.length) return;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

function tsName(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
}

/**
 * 分组键：取云端路径前 3 段。
 * 按完整目录分组会把 node_modules 拆成几千个超小包（实测 37163 文件 → 3478 包，上传调用太多），
 * 按 3 段分组后同一片区被打成 16 MB 的大包，调用数降一个量级，单包改动的影响面也只在片区内部。
 */
function groupKey(cloudPath) {
  const parts = cloudPath.split('/');
  if (parts.length > 3) return parts.slice(0, 3).join('/');
  const idx = cloudPath.lastIndexOf('/');
  return idx > 0 ? cloudPath.slice(0, idx) : '';
}

/** 把文件分组成包：按片区归并，单包不超过 BUNDLE_MAX_BYTES / BUNDLE_MAX_FILES */
function planBundles(items) {
  const byGroup = new Map();
  for (const it of items) {
    if (it.size > RAW_THRESHOLD) continue;
    const key = groupKey(it.cloudPath);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(it);
  }

  const bundles = [];
  for (const group of [...byGroup.keys()].sort()) {
    const list = byGroup.get(group).sort((a, b) => (a.cloudPath < b.cloudPath ? -1 : 1));
    let cur = [];
    let bytes = 0;
    const flush = () => {
      if (!cur.length) return;
      const key = bundleKey(cur);
      bundles.push({ key, members: cur, raw: false });
      cur = [];
      bytes = 0;
    };
    for (const it of list) {
      if (cur.length && (bytes + it.size > BUNDLE_MAX_BYTES || cur.length >= BUNDLE_MAX_FILES)) flush();
      cur.push(it);
      bytes += it.size;
    }
    flush();
  }
  return bundles;
}

function bundleKey(members) {
  const hash = createHash('sha256');
  for (const m of members) hash.update(`${m.cloudPath}\0${m.sha}\n`);
  return hash.digest('hex');
}

export function createEngine(opts) {
  const cli = opts.cli;
  const scopes = [...(opts.scopes || [])];
  const refreshScopes = opts.refreshScopes;
  const statePath = opts.statePath;
  const deviceId = opts.deviceId;
  const dshVersion = opts.dshVersion || 'unknown';
  const log = opts.log || (() => {});
  const config = opts.config || {};
  const cloudRootName = config.cloudRoot || 'DSH-Sync';

  let state = null;
  const memory = { blobIndex: { at: 0, map: new Map() }, remoteCache: null, remoteCacheAt: 0, busy: null };

  async function load() {
    if (!state) state = await loadState(statePath);
    if (!state.deviceId) state.deviceId = deviceId;
    return state;
  }
  async function persist() {
    await saveState(statePath, state);
  }
  const tmpRoot = () => path.join(os.tmpdir(), 'dsh-quark-sync');
  async function freshDir(p) {
    await fs.rm(p, { recursive: true, force: true });
    await fs.mkdir(p, { recursive: true });
    return p;
  }

  // ---------- 云端目录 ----------

  async function ensureCloud(force = false) {
    await load();
    const c = state.cloud || (state.cloud = {});
    if (!force && c.rootFid && c.blobsFid && c.manifestsFid) return c;

    const taskDir = await freshDir(path.join(tmpRoot(), 'browse'));
    const rootListing = await cli.browse(undefined, { taskDir });
    const findDir = (items, name) => items.find((it) => it.filename === name && String(it.file_type) === '0');

    let syncDir = findDir(rootListing.items, cloudRootName);
    if (!syncDir) {
      log(`创建云端根目录 ${cloudRootName}`);
      await cli.createFolder(cloudRootName);
      syncDir = findDir((await cli.browse(undefined, { taskDir })).items, cloudRootName);
      if (!syncDir) throw new Error(`云端目录 ${cloudRootName} 创建后仍找不到`);
    }
    c.rootFid = syncDir.fid;

    let listing = await cli.browse(c.rootFid, { taskDir });
    for (const name of ['blobs', 'manifests']) {
      let dir = findDir(listing.items, name);
      if (!dir) {
        log(`创建云端目录 ${cloudRootName}/${name}`);
        await cli.createFolder(name, c.rootFid);
        listing = await cli.browse(c.rootFid, { taskDir });
        dir = findDir(listing.items, name);
        if (!dir) throw new Error(`云端目录 ${name} 创建后仍找不到`);
      }
      if (name === 'blobs') c.blobsFid = dir.fid;
      else c.manifestsFid = dir.fid;
    }
    c.updatedAt = Date.now();
    await persist();
    return c;
  }

  async function listChildren(fid) {
    const taskDir = await freshDir(path.join(tmpRoot(), 'browse'));
    return (await cli.browse(fid, { taskDir })).items;
  }

  async function ensureDeviceDir() {
    const c = await ensureCloud();
    const children = await listChildren(c.manifestsFid);
    const found = children.find((it) => it.filename === deviceId && String(it.file_type) === '0');
    if (found) return found.fid;
    await cli.createFolder(deviceId, c.manifestsFid);
    const again = await listChildren(c.manifestsFid);
    const made = again.find((it) => it.filename === deviceId && String(it.file_type) === '0');
    if (!made) throw new Error(`设备目录 ${deviceId} 创建失败`);
    return made.fid;
  }

  // ---------- 远端清单 / 块索引 ----------

  async function fetchRemoteManifests(ttlMs = 0) {
    if (ttlMs && memory.remoteCacheAt && Date.now() - memory.remoteCacheAt < ttlMs) return memory.remoteCache;
    await ensureCloud();
    const devices = (await listChildren(state.cloud.manifestsFid)).filter((it) => String(it.file_type) === '0');
    const tmp = await freshDir(path.join(tmpRoot(), 'manifests'));
    const manifests = [];
    for (const dev of devices) {
      try {
        const files = (await listChildren(dev.fid)).filter((it) => String(it.file_type) === '1');
        if (!files.length) continue;
        files.sort((a, b) => String(b.filename).localeCompare(String(a.filename)));
        const latest = files[0];
        const outDir = path.join(tmp, dev.filename);
        await fs.mkdir(outDir, { recursive: true });
        const dl = await cli.download(latest.fid, outDir, { overwrite: true });
        const parsed = JSON.parse(await fs.readFile(dl.filePath, 'utf8'));
        parsed.__dir = dev.filename;
        parsed.__file = latest.filename;
        manifests.push(parsed);
      } catch (e) {
        log(`读取设备 ${dev.filename} 清单失败: ${e.message}`);
      }
    }
    memory.remoteCache = manifests;
    memory.remoteCacheAt = Date.now();
    return manifests;
  }

  function mergeManifests(manifests) {
    const merged = new Map();
    for (const m of manifests) {
      const ts = m.ts || 0;
      for (const [p, e] of Object.entries(m.entries || {})) {
        const cur = merged.get(p);
        if (!cur || ts > cur.ts) merged.set(p, { ...e, path: p, ts, device: m.device || m.__dir });
      }
    }
    return merged;
  }

  async function blobIndex(refresh = false) {
    const now = Date.now();
    if (!refresh && memory.blobIndex.map.size && now - memory.blobIndex.at < 10 * 60 * 1000) return memory.blobIndex.map;
    await ensureCloud();
    const items = (await listChildren(state.cloud.blobsFid)).filter((it) => String(it.file_type) === '1');
    const map = new Map();
    for (const it of items) map.set(it.filename, it.fid);
    memory.blobIndex = { at: now, map };
    return map;
  }

  // ---------- 本地扫描 ----------

  async function collect() {
    await load();
    if (typeof refreshScopes === 'function') {
      const next = await refreshScopes();
      if (Array.isArray(next)) {
        scopes.splice(0, scopes.length, ...next);
      }
    }
    const items = await scanAll(scopes, log);
    const files = state.files || (state.files = {});
    let hashed = 0;
    await mapLimit(items, HASH_CONCURRENCY, async (it) => {
      const cached = files[it.absPath];
      if (cached && cached.size === it.size && cached.mtimeMs === it.mtimeMs && cached.sha) {
        it.sha = cached.sha;
        return;
      }
      try {
        it.sha = await hashFile(it.absPath);
        hashed++;
      } catch (e) {
        it.sha = null;
        log(`哈希失败(跳过): ${it.absPath} ${e.code || e.message}`);
      }
      files[it.absPath] = { size: it.size, mtimeMs: it.mtimeMs, sha: it.sha };
    });
    const alive = new Set(items.map((i) => i.absPath));
    for (const key of Object.keys(files)) if (!alive.has(key)) delete files[key];
    return { items: items.filter((i) => i.sha), hashed };
  }

  /** 把一个包构建成 gzip 缓冲（tar 包或大文件直传） */
  async function buildBundleBlob(bundle) {
    if (bundle.raw) {
      const m = bundle.members[0];
      const raw = await fs.readFile(m.absPath);
      return zlib.gzipSync(raw, { level: 6 });
    }
    const entries = [];
    for (const m of bundle.members) {
      entries.push({ name: m.cloudPath, data: await fs.readFile(m.absPath) });
    }
    return zlib.gzipSync(packTar(entries), { level: 6 });
  }

  // ---------- 推送 ----------

  async function push(opts = {}) {
    await load();
    const started = Date.now();
    const { items, hashed } = await collect();

    const entries = {};
    const bundles = [];
    for (const it of items) {
      if (it.size > RAW_THRESHOLD) {
        bundles.push({ key: it.sha, members: [it], raw: true });
        entries[it.cloudPath] = { b: it.sha, s: it.size, h: it.sha, raw: 1 };
      }
    }
    const packed = planBundles(items);
    for (const b of packed) {
      bundles.push(b);
      for (const m of b.members) entries[m.cloudPath] = { b: b.key, s: m.size, h: m.sha };
    }

    // 注意：blobIndex() 返回 Map<key, fid>，必须取 keys()；直接 new Set(map) 得到的是
    // [key, fid] 二元组数组，会让 known 永远为空 → 每次推送都重复上传全部包。
    const known = new Set((await blobIndex()).keys());
    for (const m of await fetchRemoteManifests()) {
      for (const e of Object.values(m.entries || {})) if (e.b) known.add(e.b);
    }
    const need = bundles.filter((b) => !known.has(b.key));

    log(`推送：${items.length} 文件 / ${bundles.length} 包，需新建 ${need.length} 个包（缓存命中哈希 ${hashed}）`);

    const stageDir = await freshDir(path.join(tmpRoot(), `stage-${process.pid}`));
    let uploaded = 0;
    let failed = 0;
    const failedKeys = new Set();

    for (let i = 0; i < need.length; i += BUNDLES_PER_UPLOAD) {
      const group = need.slice(i, i + BUNDLES_PER_UPLOAD);
      const paths = [];
      for (const b of group) {
        try {
          const blob = await buildBundleBlob(b);
          const file = path.join(stageDir, b.key);
          await fs.writeFile(file, blob);
          paths.push(file);
        } catch (e) {
          log(`打包失败 ${b.key.slice(0, 8)}: ${e.message}`);
          failed++;
          failedKeys.add(b.key);
        }
      }
      if (!paths.length) continue;
      try {
        await cli.upload(paths, state.cloud.blobsFid, { timeoutMs: 60 * 60 * 1000 });
        uploaded += paths.length;
      } catch (e) {
        log(`上传失败(批量 ${paths.length}): ${e.message}`);
        for (const p of paths) {
          try {
            await uploadWithRetry(cli, p, state.cloud.blobsFid);
            uploaded++;
          } catch (e2) {
            failed++;
            failedKeys.add(path.basename(p));
            log(`上传失败 ${path.basename(p).slice(0, 8)}: ${e2.message}`);
          }
        }
      }
      for (const p of paths) await fs.rm(p, { force: true });
      if (opts.onProgress) opts.onProgress({ done: Math.min(i + group.length, need.length), total: need.length });
    }
    await fs.rm(stageDir, { recursive: true, force: true });
    memory.blobIndex = { at: 0, map: new Map() };

    // 打包/上传失败的包不能出现在清单里：否则拉取端会去找不存在的 blob。
    if (failedKeys.size) {
      let dropped = 0;
      for (const [p, e] of Object.entries(entries)) {
        if (e && failedKeys.has(e.b)) {
          delete entries[p];
          dropped++;
        }
      }
      log(`注意：${failedKeys.size} 个包未上传成功，清单里已剔除其 ${dropped} 个文件`);
    }

    const manifest = {
      device: deviceId,
      hostname: os.hostname(),
      platform: process.platform,
      dshVersion,
      ts: Date.now(),
      createdAt: new Date().toISOString(),
      // 不把本机绝对根路径写进云端清单；路径只存在于本机 workspace.json。
      scopes: scopes.map((s) => ({ id: s.id, cloud: s.cloud })),
      stats: { files: items.length, bytes: items.reduce((a, i) => a + i.size, 0), bundles: bundles.length },
      entries,
    };
    const devFid = await ensureDeviceDir();
    const mfile = path.join(await freshDir(path.join(tmpRoot(), 'upmanifest')), `${tsName()}.json`);
    await fs.writeFile(mfile, JSON.stringify(manifest), 'utf8');
    await uploadWithRetry(cli, mfile, devFid);
    await fs.rm(mfile, { force: true });

    state.pushedManifest = { ts: manifest.ts, entries };
    state.lastPushAt = Date.now();
    await persist();
    memory.remoteCacheAt = 0;

    return {
      ok: true,
      files: items.length,
      bundles: bundles.length,
      newBundles: need.length,
      uploaded,
      failed,
      elapsedMs: Date.now() - started,
      manifest: `${deviceId}/${path.basename(mfile)}`,
    };
  }

  // ---------- 拉取 ----------

  function absFor(cloudPath) {
    if (typeof cloudPath !== 'string' || cloudPath.includes('\\') || cloudPath.startsWith('/')) return null;
    for (const s of scopes) {
      if (cloudPath === s.cloud && s.kind === 'file') return { abs: s.root, scope: s };
      const prefix = s.cloud + '/';
      if (cloudPath.startsWith(prefix)) {
        const rel = cloudPath.slice(prefix.length);
        if (s.kind === 'file' || !rel || rel.split('/').some((part) => !part || part === '.' || part === '..')) return null;
        const abs = path.resolve(s.root, ...rel.split('/'));
        const fromRoot = path.relative(path.resolve(s.root), abs);
        if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) return null;
        return { abs, scope: s };
      }
    }
    return null;
  }

  async function assertSafeWritePath(scope, target, allowFileSidecar = false) {
    const configuredRoot = path.resolve(scope.root);
    const absolute = path.resolve(target);
    const boundary = scope.kind === 'file' ? path.dirname(configuredRoot) : configuredRoot;
    const relative = path.relative(boundary, absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('目标路径超出同步范围');
    }
    if (scope.kind === 'file') {
      const isOriginal = absolute.toLowerCase() === configuredRoot.toLowerCase();
      const isBackup = allowFileSidecar && absolute.toLowerCase() === `${configuredRoot}.qsync-prev`.toLowerCase();
      const expectedTempName = `${path.basename(configuredRoot)}.`;
      const isTemp = allowFileSidecar
        && path.dirname(absolute).toLowerCase() === path.dirname(configuredRoot).toLowerCase()
        && path.basename(absolute).startsWith(expectedTempName)
        && path.basename(absolute).endsWith('.qsync.tmp')
        && /^[0-9a-f-]{36}$/i.test(path.basename(absolute).slice(expectedTempName.length, -'.qsync.tmp'.length));
      if (!isOriginal && !isBackup && !isTemp) throw new Error('目标路径不匹配单文件同步范围');
    }

    const parsed = path.parse(absolute);
    let current = parsed.root;
    const parts = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      current = path.join(current, parts[i]);
      let st;
      try {
        st = await fs.lstat(current);
      } catch (e) {
        if (e.code === 'ENOENT') break;
        throw e;
      }
      if (st.isSymbolicLink()) throw new Error('目标路径包含符号链接/重解析点');
      const realCurrent = await fs.realpath(current);
      if (path.resolve(realCurrent).toLowerCase() !== current.toLowerCase()) {
        throw new Error('目标真实路径包含链接/重解析点');
      }
      if (i < parts.length - 1 && !st.isDirectory()) throw new Error('目标父路径不是目录');
    }
  }

  async function ensureSafeDirectoryChain(directory) {
    const parsed = path.parse(path.resolve(directory));
    let current = parsed.root;
    for (const part of path.resolve(directory).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
      current = path.join(current, part);
      try {
        await fs.mkdir(current);
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
      const st = await fs.lstat(current);
      if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('目标父路径不是普通目录');
      const real = await fs.realpath(current);
      if (path.resolve(real).toLowerCase() !== current.toLowerCase()) throw new Error('目标父路径包含链接/重解析点');
    }
  }

  async function ensureSafeParentDirectories(scope, target) {
    const base = scope.kind === 'file' ? path.dirname(path.resolve(scope.root)) : path.resolve(scope.root);
    const parent = path.dirname(path.resolve(target));
    const relative = path.relative(base, parent);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error('目标父目录超出同步范围');
    }
    await ensureSafeDirectoryChain(base);
    await assertSafeWritePath(scope, target, true);
    await ensureSafeDirectoryChain(parent);
    await assertSafeWritePath(scope, target, true);
  }

  async function pull(opts = {}) {
    await load();
    const started = Date.now();
    const manifests = await fetchRemoteManifests();
    if (!manifests.length) return { ok: false, reason: '云端还没有任何设备的清单' };

    const newest = manifests.reduce((a, b) => ((a.ts || 0) > (b.ts || 0) ? a : b));
    const versionMismatch = Boolean(newest.dshVersion && dshVersion !== 'unknown' && newest.dshVersion !== dshVersion);

    const merged = mergeManifests(manifests);
    const { items } = await collect();
    const localSha = new Map(items.map((i) => [i.cloudPath, i.sha]));
    const localMtime = new Map(items.map((i) => [i.cloudPath, i.mtimeMs]));
    const tombstones = state.deleted || (state.deleted = {});

    const todo = [];
    let newerLocal = 0;
    for (const [p, e] of merged) {
      const target = absFor(p);
      if (!target) continue;
      if (target.scope.id === 'harness-app' && !config.allowAppOverwrite) continue;
      const relative = target.scope.kind === 'dir' ? path.relative(target.scope.root, target.abs).replace(/\\/g, '/') : '';
      if (relative && isExcluded(relative, target.scope.exclude)) continue;
      if (localSha.get(p) === e.h) continue;
      // 本机比这份清单还新 → 本机赢，等下一轮 push 覆盖云端，绝不能拿旧版盖掉正在写的文件
      // （踩过：当前会话的 session.v4.jsonl.zstd 被云端旧版替换过）。
      if ((localMtime.get(p) || 0) > (e.ts || 0)) {
        newerLocal++;
        continue;
      }
      const tomb = tombstones[p];
      if (tomb && tomb >= (e.ts || 0)) continue;
      todo.push({ path: p, entry: e, abs: target.abs, scope: target.scope });
    }

    log(`拉取：云端 ${merged.size} 项，本机需更新 ${todo.length} 项${newerLocal ? `，${newerLocal} 项本机更新（跳过）` : ''}`);

    if (!todo.length) {
      state.lastPullAt = Date.now();
      await persist();
      return { ok: true, updated: 0, skipped: merged.size, versionMismatch, elapsedMs: Date.now() - started };
    }

    const index = await blobIndex(true);
    const byBundle = new Map();
    for (const t of todo) {
      const key = t.entry.b;
      if (!key) continue;
      if (!byBundle.has(key)) byBundle.set(key, []);
      byBundle.get(key).push(t);
    }

    const downDir = await freshDir(path.join(tmpRoot(), `pull-${process.pid}`));
    let updated = 0;
    let skipped = 0;
    const applied = [];

    const keys = [...byBundle.keys()];
    await mapLimit(keys, DOWNLOAD_LANES, async (key, li) => {
      const fid = index.get(key);
      if (!fid) {
        skipped += byBundle.get(key).length;
        log(`云端缺少包 ${key.slice(0, 8)}（${byBundle.get(key).length} 个文件）`);
        return;
      }
      const outDir = path.join(downDir, String(li));
      await fs.mkdir(outDir, { recursive: true });
      let raw;
      try {
        const dl = await cli.download(fid, outDir, { overwrite: true, timeoutMs: 60 * 60 * 1000 });
        raw = zlib.gunzipSync(await fs.readFile(dl.filePath));
      } catch (e) {
        skipped += byBundle.get(key).length;
        log(`下载包失败 ${key.slice(0, 8)}: ${e.message}`);
        return;
      } finally {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => {});
      }

      const first = byBundle.get(key)[0];
      const isRaw = Boolean(first.entry.raw);
      let memberMap = null;
      if (!isRaw) {
        try {
          memberMap = new Map(unpackTar(raw).map((e) => [e.name, e.data]));
        } catch (e) {
          skipped += byBundle.get(key).length;
          log(`解包失败 ${key.slice(0, 8)}: ${e.message}`);
          return;
        }
      }

      for (const t of byBundle.get(key)) {
        const data = isRaw ? raw : memberMap.get(t.path);
        if (!data) {
          skipped++;
          continue;
        }
        if (sha256(data) !== t.entry.h) {
          skipped++;
          log(`校验失败(丢弃): ${t.path}`);
          continue;
        }
        let pendingTmp = null;
        try {
          await assertSafeWritePath(t.scope, t.abs, true);
          const st = await fs.lstat(t.abs).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
          if (st?.isSymbolicLink() || (st && !st.isFile())) throw new Error('目标文件不是普通文件');
          if (st && Date.now() - st.mtimeMs < RECENT_WRITE_MS) {
            skipped++;
            log(`跳过（刚被写入）: ${t.path}`);
            continue;
          }
          await ensureSafeParentDirectories(t.scope, t.abs);
          await assertSafeWritePath(t.scope, t.abs, true);
          if (st) {
            const backup = `${t.abs}.qsync-prev`;
            await assertSafeWritePath(t.scope, backup, true);
            const backupStat = await fs.lstat(backup).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
            if (backupStat?.isSymbolicLink() || (backupStat && !backupStat.isFile())) throw new Error('备份目标不是普通文件');
            // 只保留最初那份本机备份；不要覆盖用户可能需要恢复的旧版本。
            if (!backupStat) {
              const backupTmp = `${t.abs}.${randomUUID()}.qsync.tmp`;
              pendingTmp = backupTmp;
              await assertSafeWritePath(t.scope, backupTmp, true);
              await fs.copyFile(t.abs, backupTmp, constants.COPYFILE_EXCL);
              const backupTmpStat = await fs.lstat(backupTmp);
              if (backupTmpStat.isSymbolicLink() || !backupTmpStat.isFile()) throw new Error('备份临时文件不是普通文件');
              await assertSafeWritePath(t.scope, backup, true);
              await fs.rename(backupTmp, backup);
              pendingTmp = null;
            }
          }
          const tmpFile = `${t.abs}.${randomUUID()}.qsync.tmp`;
          pendingTmp = tmpFile;
          await assertSafeWritePath(t.scope, tmpFile, true);
          await fs.writeFile(tmpFile, data, { flag: 'wx' });
          await assertSafeWritePath(t.scope, t.abs, true);
          await fs.rename(tmpFile, t.abs);
          pendingTmp = null;
          updated++;
          applied.push(t.path);
        } catch (e) {
          if (pendingTmp) await fs.rm(pendingTmp, { force: true }).catch(() => {});
          skipped++;
          log(`写入失败 ${t.path}: ${e.message}`);
        }
      }
    });

    await fs.rm(downDir, { recursive: true, force: true });
    state.lastPullAt = Date.now();
    await persist();

    return {
      ok: true,
      updated,
      skipped,
      versionMismatch,
      remoteVersion: newest.dshVersion,
      localVersion: dshVersion,
      applied: applied.slice(0, 200),
      elapsedMs: Date.now() - started,
    };
  }

  // ---------- 状态 ----------

  async function status() {
    await load();
    const info = await cli.userInfo().catch(() => null);
    const manifests = await fetchRemoteManifests(5 * 60 * 1000).catch(() => []);
    const merged = mergeManifests(manifests);
    const { items } = await collect();
    const prev = state.pushedManifest?.entries || {};
    let pending = 0;
    const perScope = {};
    for (const it of items) {
      if (!prev[it.cloudPath] || prev[it.cloudPath].h !== it.sha) pending++;
      perScope[it.scopeId] = (perScope[it.scopeId] || 0) + 1;
    }
    const rootCheck = {};
    await Promise.all(scopes.map(async (s) => {
      try {
        const st = await fs.stat(s.root);
        rootCheck[s.id] = st.isDirectory() ? 'dir' : 'file';
      } catch (e) {
        rootCheck[s.id] = e.code || 'err';
      }
    }));
    return {
      device: deviceId,
      dshVersion,
      localFiles: items.length,
      localBytes: items.reduce((a, i) => a + i.size, 0),
      pendingUpload: pending,
      scopes: perScope,
      rootCheck,
      roots: scopes.map((s) => `${s.id}=${s.root}`),
      diag: {
        homedir: os.homedir(),
        userprofile: process.env.USERPROFILE || null,
        appdata: process.env.APPDATA || null,
        agentEnv: Object.keys(process.env).filter((k) => /DSH|AGENT|SESSION|CLAUDE|CODEX|CURSOR|QWEN|TRAE/i.test(k)),
      },
      remoteFiles: merged.size,
      remoteDevices: manifests.map((m) => ({
        device: m.device || m.__dir,
        ts: m.ts,
        createdAt: m.createdAt,
        dshVersion: m.dshVersion,
        files: Object.keys(m.entries || {}).length,
      })),
      lastPushAt: state.lastPushAt,
      lastPullAt: state.lastPullAt,
      quota: info?.vipInfo ? { capacity: info.vipInfo.capacity, used: info.vipInfo.used } : null,
    };
  }

  return {
    push,
    pull,
    status,
    ensureCloud,
    getState: () => state,
    busy: () => memory.busy,
    runExclusive(name, fn) {
      if (memory.busy) throw new Error(`已有同步任务在跑：${memory.busy}`);
      memory.busy = name;
      return Promise.resolve()
        .then(fn)
        .finally(() => {
          memory.busy = null;
        });
    },
  };
}
