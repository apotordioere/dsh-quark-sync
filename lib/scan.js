// 扫描同步范围：产出 {cloudPath, absPath, size, mtimeMs} 列表
import fs from 'node:fs/promises';
import path from 'node:path';
import { isExcluded } from './scope.js';

const HARD_SKIP_DIRS = new Set(['.git', 'node_modules']);
// 同步器自己产生的临时/备份文件，不能当成用户文件再传回云端
const SKIP_SUFFIXES = ['.qsync.tmp', '.qsync-prev'];

export async function scanScope(scope, log = () => {}) {
  const out = [];
  const root = scope.root;
  try {
    const lst = await fs.lstat(root);
    const real = await fs.realpath(root);
    if (lst.isSymbolicLink() || path.resolve(real).toLowerCase() !== path.resolve(root).toLowerCase()) {
      log(`跳过链接形式的同步范围根目录: ${root}`);
      return out;
    }
    if (scope.kind === 'dir' && !lst.isDirectory()) return out;
    if (scope.kind === 'file' && !lst.isFile()) return out;
  } catch (e) {
    log(`跳过不可访问的同步范围根目录: ${root} ${e.code || e.message}`);
    return out;
  }

  if (scope.kind === 'file') {
    try {
      const st = await fs.stat(root);
      if (st.isFile()) {
        out.push({ cloudPath: scope.cloud, absPath: root, size: st.size, mtimeMs: st.mtimeMs, scopeId: scope.id });
      }
    } catch {
      log(`跳过缺失文件: ${root}`);
    }
    return out;
  }

  const stack = [''];
  while (stack.length) {
    const rel = stack.pop();
    const dir = rel ? path.join(root, rel) : root;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      log(`读目录失败(跳过): ${dir} ${e.code || e.message}`);
      continue;
    }
    for (const ent of entries) {
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        // node_modules 默认保留（harness 组件必须同步），仅在 exclude 命中时跳过
        if (isExcluded(childRel, scope.exclude)) continue;
        if (HARD_SKIP_DIRS.has(ent.name) && !scope.keepNodeModules) continue;
        const childAbs = path.join(dir, ent.name);
        try {
          const lst = await fs.lstat(childAbs);
          const real = await fs.realpath(childAbs);
          if (lst.isSymbolicLink() || !lst.isDirectory() || path.resolve(real).toLowerCase() !== path.resolve(childAbs).toLowerCase()) {
            log(`跳过链接形式的子目录: ${childAbs}`);
            continue;
          }
        } catch (e) {
          log(`跳过不可访问的子目录: ${childAbs} ${e.code || e.message}`);
          continue;
        }
        stack.push(childRel);
        continue;
      }
      if (!ent.isFile()) continue;
      if (isExcluded(childRel, scope.exclude)) continue;
      if (SKIP_SUFFIXES.some((suffix) => ent.name.endsWith(suffix))) continue;
      const abs = path.join(dir, ent.name);
      let st;
      try {
        st = await fs.stat(abs);
      } catch {
        continue;
      }
      out.push({
        cloudPath: `${scope.cloud}/${childRel}`,
        absPath: abs,
        size: st.size,
        mtimeMs: Math.round(st.mtimeMs),
        scopeId: scope.id,
      });
    }
  }
  return out;
}

export async function scanAll(scopes, log) {
  const all = [];
  for (const scope of scopes) all.push(...(await scanScope(scope, log)));
  return all;
}
