// 验证 A/B 机工作区同名异路径：A 机 manifest 应落到 B 机 registry 对应的本地路径；再次 pull 幂等。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createEngine } from '../lib/engine.js';
import { DEFAULT_SCOPES, resolveScopes, workspaceScopesFromFile } from '../lib/scope.js';
import { packTar } from '../lib/tar.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qsync-engine-routing-'));
const hash = (buf) => createHash('sha256').update(buf).digest('hex');

try {
  const rootA = path.join(temp, 'device-a', 'same-name');
  const rootB = path.join(temp, 'device-b', 'same-name');
  await fs.mkdir(rootA, { recursive: true });
  await fs.mkdir(rootB, { recursive: true });
  const externalRoot = path.join(temp, 'outside-scope');
  await fs.mkdir(externalRoot, { recursive: true });
  const externalRegistry = path.join(externalRoot, 'workspace.json');
  await fs.writeFile(externalRegistry, 'local registry must remain untouched');
  let junctionSupported = false;
  try {
    await fs.symlink(externalRoot, path.join(rootB, 'link'), 'junction');
    junctionSupported = true;
  } catch (e) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e;
  }
  const registryA = path.join(temp, 'registry-a.json');
  const registryB = path.join(temp, 'registry-b.json');
  await fs.writeFile(registryA, JSON.stringify({
    global: { workspaceIds: ['workspace-uuid-a'] },
    tables: { workspaces: { 'workspace-uuid-a': { title: 'Same Project', path: rootA } } },
  }));
  await fs.writeFile(registryB, JSON.stringify({
    global: { workspaceIds: ['workspace-uuid-b'] },
    tables: { workspaces: { 'workspace-uuid-b': { title: 'Same Project', path: rootB } } },
  }));
  const scopeA = workspaceScopesFromFile(registryA, () => {}, resolveScopes(DEFAULT_SCOPES))[0];
  const scopeB = workspaceScopesFromFile(registryB, () => {}, resolveScopes(DEFAULT_SCOPES))[0];
  assert.equal(scopeA.cloud, scopeB.cloud, 'same name yields same cloud key');
  assert.notEqual(scopeA.root, scopeB.root, 'local roots differ between devices');

  const content = Buffer.from('routed to this device\n', 'utf8');
  const targetCloudPath = `${scopeA.cloud}/proof.txt`;
  const targetBundleKey = hash(Buffer.from(`${targetCloudPath}\0${hash(content)}\n`));
  const traversalCloudPath = `${scopeB.cloud}/../escape.txt`;
  const traversalContent = Buffer.from('must not escape scope root\n', 'utf8');
  const encodedTraversalCloudPath = `${scopeB.cloud}/%2e%2e/escape2.txt`;
  const linkedCloudPath = `${scopeB.cloud}/link/workspace.json`;
  const linkedContent = Buffer.from('must not overwrite an outside file\n', 'utf8');
  const bundles = new Map();
  const addBundleEntry = (cloudPath, data) => {
    const key = hash(Buffer.from(`${cloudPath}\0${hash(data)}\n`));
    if (!bundles.has(key)) bundles.set(key, { key, entries: [] });
    bundles.get(key).entries.push({ name: cloudPath, data });
    return key;
  };
  const targetBundle = addBundleEntry(targetCloudPath, content);
  const traversalBundle = addBundleEntry(traversalCloudPath, traversalContent);
  const encodedTraversalBundle = addBundleEntry(encodedTraversalCloudPath, traversalContent);
  let linkedBundle = null;
  if (junctionSupported) linkedBundle = addBundleEntry(linkedCloudPath, linkedContent);
  const blobBytesByKey = new Map([...bundles].map(([key, bundle]) => [
    key,
    zlib.gzipSync(packTar(bundle.entries)),
  ]));
  const manifest = {
    device: 'fixture-device-a',
    dshVersion: 'test',
    ts: Date.now() - 60_000,
    entries: {
      [targetCloudPath]: { b: targetBundle, s: content.length, h: hash(content) },
    },
  };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const filesByFid = new Map([
    ['manifest-fixture', { name: '20261116-000000.json', bytes: manifestBytes }],
    ...[...blobBytesByKey].map(([key, bytes], i) => [`blob-fixture-${i}`, { name: key, bytes }]),
  ]);
  const fidByBundleKey = new Map([...blobBytesByKey.keys()].map((key, i) => [key, `blob-fixture-${i}`]));
  const cli = {
    async browse(fid) {
      if (fid === 'manifests') return { items: [
        { filename: 'fixture-device-a', file_type: '0', fid: 'device-dir' },
        { filename: 'fixture-hostile', file_type: '0', fid: 'hostile-dir' },
      ] };
      if (fid === 'device-dir') return { items: [{ filename: '20261116-000000.json', file_type: '1', fid: 'manifest-fixture' }] };
      if (fid === 'hostile-dir') return { items: [{ filename: '20261116-000001.json', file_type: '1', fid: 'manifest-hostile' }] };
      if (fid === 'blobs') return { items: [...fidByBundleKey].map(([key, blobFid]) => ({ filename: key, file_type: '1', fid: blobFid })) };
      throw new Error(`unexpected browse fid: ${fid}`);
    },
    async download(fid, outDir) {
      const fixture = filesByFid.get(fid);
      if (!fixture) throw new Error(`unexpected download fid: ${fid}`);
      await fs.mkdir(outDir, { recursive: true });
      const filePath = path.join(outDir, fixture.name);
      await fs.writeFile(filePath, fixture.bytes);
      return { filePath };
    },
  };

  const hostileManifest = {
    device: 'fixture-hostile',
    dshVersion: 'test',
    ts: Date.now() - 120_000,
    entries: {
      [traversalCloudPath]: { b: traversalBundle, s: traversalContent.length, h: hash(traversalContent) },
      [encodedTraversalCloudPath]: { b: encodedTraversalBundle, s: traversalContent.length, h: hash(traversalContent) },
      ...(junctionSupported ? { [linkedCloudPath]: { b: linkedBundle, s: linkedContent.length, h: hash(linkedContent) } } : {}),
    },
  };
  filesByFid.set('manifest-hostile', { name: '20261116-000001.json', bytes: Buffer.from(JSON.stringify(hostileManifest)) });
  const statePath = path.join(temp, 'state.json');
  await fs.writeFile(statePath, JSON.stringify({
    deviceId: 'fixture-device-b',
    cloud: { rootFid: 'root', blobsFid: 'blobs', manifestsFid: 'manifests' },
  }));
  const engine = createEngine({
    cli,
    scopes: [scopeB],
    statePath,
    deviceId: 'fixture-device-b',
    dshVersion: 'test',
    log: () => {},
  });
  const first = await engine.pull();
  assert.equal(first.ok, true);
  assert.equal(first.updated, 2, 'normal and literal percent-encoded path stay within B root');
  assert.deepEqual(await fs.readFile(path.join(rootB, 'proof.txt')), content);
  assert.deepEqual(await fs.readFile(path.join(rootB, '%2e%2e', 'escape2.txt')), traversalContent,
    'percent encoding is treated as a literal path segment, not decoded traversal');
  await assert.rejects(fs.access(path.join(rootA, 'proof.txt')));
  await assert.rejects(fs.access(path.join(temp, 'escape.txt')));
  if (junctionSupported) {
    assert.equal(await fs.readFile(externalRegistry, 'utf8'), 'local registry must remain untouched',
      'hostile manifest must not write through a workspace junction');
    await assert.rejects(fs.access(path.join(externalRoot, 'workspace.json.qsync.tmp')));
  }

  const second = await engine.pull();
  assert.equal(second.ok, true);
  assert.equal(second.updated, 0, 'second pull is idempotent');
  assert.deepEqual(await fs.readFile(path.join(rootB, 'proof.txt')), content);
  console.log('engine routing tests: OK (cross-device local path, cloud key, one-time pull, idempotent second pull)');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
