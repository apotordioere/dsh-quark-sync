import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SCOPES, isExcluded, resolveScopes, workspaceScopesFromFile } from '../lib/scope.js';
import { expandEnv } from '../index.js';
import { scanScope } from '../lib/scan.js';

const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'qsync-scope-test-'));
const mk = async (name) => {
  const p = path.join(temp, name);
  await fs.mkdir(p, { recursive: true });
  return p;
};
const writeRegistry = async (file, records) => {
  const tables = {};
  const ids = [];
  for (const [id, title, root, active = true] of records) {
    tables[id] = { title, path: root };
    if (active) ids.push(id);
  }
  await fs.writeFile(file, JSON.stringify({ global: { workspaceIds: ids }, tables: { workspaces: tables } }));
};

try {
  const savedUserProfile = process.env.USERPROFILE;
  const savedHome = process.env.HOME;
  delete process.env.USERPROFILE;
  delete process.env.HOME;
  assert.equal(expandEnv('%USERPROFILE%\\.dsh\\x'), path.join(os.homedir(), '.dsh', 'x'),
    'USERPROFILE falls back to the OS home directory');
  assert.equal(expandEnv('${HOME}/.dsh/x'), path.join(os.homedir(), '.dsh', 'x'),
    'HOME falls back to the OS home directory');
  if (savedUserProfile !== undefined) process.env.USERPROFILE = savedUserProfile;
  if (savedHome !== undefined) process.env.HOME = savedHome;

  const localA = {
    main: await mk('device-a/main'),
    mainChild: await mk('device-a/main/child'),
    torso: await mk('device-a/torso'),
    alpha: await mk('device-a/alpha'),
    nested: await mk('device-a/alpha/nested'),
    inactive: await mk('device-a/inactive'),
  };
  const registryA = path.join(temp, 'a.json');
  await writeRegistry(registryA, [
    ['uuid-main-a', 'DEEPSEEK专用', localA.main],
    ['uuid-main-child-a', 'Child Of Main', localA.mainChild],
    ['uuid-torso-a', 'torso', localA.torso],
    ['uuid-alpha-a', 'Alpha Project', localA.alpha],
    ['uuid-nested-a', 'Nested Project', localA.nested],
    ['uuid-old-a', 'Inactive Project', localA.inactive, false],
  ]);

  const baseA = resolveScopes(DEFAULT_SCOPES).map((s) => ({ ...s }));
  const scopesA = workspaceScopesFromFile(registryA, () => {}, baseA);
  const mappedMain = baseA.find((s) => s.id === 'workspace');
  const mappedTorso = baseA.find((s) => s.id === 'plugin-src-torso');
  assert.equal(mappedMain.root, localA.main, 'fixed main workspace maps to local registry path');
  assert.equal(mappedTorso.root, localA.torso, 'fixed torso workspace maps to local registry path');
  assert.ok(isExcluded('child/proof.txt', mappedMain.exclude), 'registered child workspace is excluded from fixed parent scope');
  assert.ok(scopesA.some((s) => s.note === 'DSH 工作区：Child Of Main'), 'registered child under fixed workspace gets its own cloud mapping');
  const alphaA = scopesA.find((s) => s.note === 'DSH 工作区：Alpha Project');
  const nestedA = scopesA.find((s) => s.note === 'DSH 工作区：Nested Project');
  assert.ok(alphaA && nestedA, 'active non-fixed workspaces are discovered');
  assert.ok(!scopesA.some((s) => s.note.includes('Inactive Project')), 'inactive registry rows are omitted');
  assert.ok(alphaA.exclude.includes('nested') && alphaA.exclude.includes('nested/**'), 'nested workspace is excluded from its parent');
  assert.ok(isExcluded('.git/config', alphaA.exclude), '.git is excluded');
  assert.ok(isExcluded('node_modules/pkg/index.js', alphaA.exclude), 'node_modules is excluded');
  assert.ok(isExcluded('file.qsync-prev', alphaA.exclude), 'sync backups are excluded');
  assert.ok(!isExcluded('ref/private-document.txt', alphaA.exclude), 'ordinary user files remain included');

  const localB = await mk('device-b/alpha');
  const registryB = path.join(temp, 'b.json');
  await writeRegistry(registryB, [['different-uuid-b', 'Alpha Project', localB]]);
  const scopesB = workspaceScopesFromFile(registryB, () => {}, resolveScopes(DEFAULT_SCOPES).map((s) => ({ ...s })));
  const alphaB = scopesB.find((s) => s.note === 'DSH 工作区：Alpha Project');
  assert.ok(alphaB, 'same-name workspace discovered on device B');
  assert.equal(alphaA.cloud, alphaB.cloud, 'same workspace title maps to identical cloud key across devices');
  assert.notEqual(alphaA.root, alphaB.root, 'device-specific local roots remain independent');

  const broadMain = await mk('device-c');
  const broadFixed = await mk('device-c/fixed-main');
  const broadRegistry = path.join(temp, 'broad-root.json');
  await writeRegistry(broadRegistry, [['broad-main', 'DEEPSEEK专用', broadMain]]);
  const broadScopes = resolveScopes(DEFAULT_SCOPES).map((s) => ({ ...s }));
  broadScopes.find((s) => s.id === 'workspace').root = broadFixed;
  const broadWarnings = [];
  const broadDynamic = workspaceScopesFromFile(broadRegistry, (m) => broadWarnings.push(m), broadScopes);
  assert.equal(broadScopes.find((s) => s.id === 'workspace').root, broadFixed,
    'fixed main scope must not expand to an ancestor workspace path');
  assert.equal(broadDynamic.length, 0, 'overwide workspace mapping is skipped rather than including unrelated parent contents');
  assert.ok(broadWarnings.some((m) => m.includes('过宽')));

  const conflictScopes = resolveScopes(DEFAULT_SCOPES).map((s) => ({ ...s }));
  const configuredTorsoRoot = conflictScopes.find((s) => s.id === 'plugin-src-torso').root;
  conflictScopes.find((s) => s.id === 'workspace').root = localA.main;
  const conflictRegistry = path.join(temp, 'overlapping-fixed-root.json');
  await writeRegistry(conflictRegistry, [['torso-overlap', 'torso', localA.main]]);
  const conflictWarnings = [];
  workspaceScopesFromFile(conflictRegistry, (m) => conflictWarnings.push(m), conflictScopes);
  assert.equal(conflictScopes.find((s) => s.id === 'plugin-src-torso').root, configuredTorsoRoot,
    'fixed scope must not remap onto another fixed scope root');
  assert.ok(conflictWarnings.some((m) => m.includes('重叠')));
  const fixedRootCollision = path.join(temp, 'device-fixed-collision');
  await fs.mkdir(fixedRootCollision, { recursive: true });
  const collisionRegistry = path.join(temp, 'fixed-root-collision.json');
  await writeRegistry(collisionRegistry, [['workspace-collision', 'Unrelated Project', configuredTorsoRoot]]);
  const collisionWarnings = [];
  const collisionDynamic = workspaceScopesFromFile(collisionRegistry, (m) => collisionWarnings.push(m), conflictScopes);
  assert.equal(collisionDynamic.length, 0, 'dynamic workspace cannot remap onto any fixed scope root');
  assert.ok(collisionWarnings.some((m) => m.includes('范围')));

  const duplicate1 = await mk('device-a/duplicate1');
  const duplicate2 = await mk('device-a/duplicate2');
  const duplicateRegistry = path.join(temp, 'duplicates.json');
  await writeRegistry(duplicateRegistry, [
    ['dup-a', 'Duplicate Name', duplicate1],
    ['dup-b', 'Duplicate Name', duplicate2],
  ]);
  const warnings = [];
  const duplicateScopes = workspaceScopesFromFile(duplicateRegistry, (m) => warnings.push(m), resolveScopes(DEFAULT_SCOPES));
  assert.equal(duplicateScopes.length, 0, 'ambiguous duplicate-title scopes are skipped');
  assert.equal(warnings.length, 2, 'each ambiguous workspace is logged');

  const externalRoot = await mk('external-root');
  const linkedRoot = path.join(temp, 'linked-workspace-root');
  let rootLinkSupported = false;
  try {
    await fs.symlink(externalRoot, linkedRoot, 'junction');
    rootLinkSupported = true;
  } catch (e) {
    if (!['EPERM', 'EACCES', 'ENOSYS'].includes(e.code)) throw e;
  }
  if (rootLinkSupported) {
    const linkRegistry = path.join(temp, 'linked-root.json');
    await writeRegistry(linkRegistry, [['linked-root', 'Linked Root', linkedRoot]]);
    const linkedWarnings = [];
    assert.equal(workspaceScopesFromFile(linkRegistry, (m) => linkedWarnings.push(m), resolveScopes(DEFAULT_SCOPES)).length, 0,
      'workspace root junctions are rejected to prevent scanning outside registry path');
    assert.ok(linkedWarnings.some((m) => m.includes('链接形式')));
    assert.deepEqual(await scanScope({ id: 'linked-root', kind: 'dir', root: linkedRoot, cloud: 'linked-root' }, () => {}), [],
      'scanner refuses a symlink/junction even when caller bypasses registry scope discovery');
  }

  const badRegistry = path.join(temp, 'bad-registry.json');
  await fs.writeFile(badRegistry, '{not-json');
  const badWarnings = [];
  assert.equal(workspaceScopesFromFile(badRegistry, (m) => badWarnings.push(m), resolveScopes(DEFAULT_SCOPES)).length, 0,
    'invalid workspace registry is ignored safely');
  assert.ok(badWarnings.some((m) => m.includes('无法读取')), 'invalid registry emits a visible warning');

  const duplicateRootRegistry = path.join(temp, 'duplicate-root.json');
  await writeRegistry(duplicateRootRegistry, [
    ['same-root-a', 'Same Root A', duplicate1],
    ['same-root-b', 'Same Root B', duplicate1],
  ]);
  const duplicateRootWarnings = [];
  assert.equal(workspaceScopesFromFile(duplicateRootRegistry, (m) => duplicateRootWarnings.push(m), resolveScopes(DEFAULT_SCOPES)).length, 0,
    'duplicate registry roots are skipped');
  assert.equal(duplicateRootWarnings.length, 2, 'each duplicate root is logged');

  const credentialParent = await mk('credential-parent');
  const credentialFile = path.join(credentialParent, 'credentials.yaml');
  await fs.writeFile(credentialFile, 'sensitive fixture');
  const credentialRegistry = path.join(temp, 'credential-parent-registry.json');
  await writeRegistry(credentialRegistry, [['credential-parent', 'Credential Parent', credentialParent]]);
  const credentialBase = [{ id: 'fixture-credential', kind: 'file', root: credentialFile, cloud: 'fixture/credentials' }];
  const credentialWarnings = [];
  assert.equal(workspaceScopesFromFile(credentialRegistry, (m) => credentialWarnings.push(m), credentialBase).length, 0,
    'a workspace containing a fixed sensitive file is skipped');
  assert.ok(credentialWarnings.some((m) => m.includes('固定同步范围')),
    'a workspace skipped because it contains a fixed file scope is logged');

  console.log('scope tests: OK (active filtering, fixed-scope path mapping, stable cloud keys, nested excludes, duplicate-title/root safety, fixed-file ancestor protection, invalid registry warning, root junction rejection)');
} finally {
  await fs.rm(temp, { recursive: true, force: true });
}
