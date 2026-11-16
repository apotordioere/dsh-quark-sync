#!/usr/bin/env node
// 把当前 git HEAD 的内容推到 GitHub（走 REST API，因为这台机器 git 直连 github.com 会被重置）。
// 凭据取自 `git credential fill`（Windows 凭证管理器），脚本本身不存 token。
// 用法：node tools/push-github.mjs [--repo owner/name] [--private] [--message "..."]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const REPO = arg('repo', '');
const PRIVATE = args.includes('--private');
const MESSAGE = arg('message', null);

const ROOT = spawnSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).stdout.trim();
if (!ROOT) {
  console.error('不在 git 仓库里');
  process.exit(1);
}

const fill = spawnSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});
const token = (fill.stdout || '').split('\n').find((l) => l.startsWith('password='))?.slice(9);
if (!token) {
  console.error('取不到 GitHub 凭据（git credential fill 返回空）');
  process.exit(1);
}

const api = async (p, init = {}) => {
  const res = await fetch(`https://api.github.com${p}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'content-type': 'application/json',
      'user-agent': 'dsh-quark-sync-push',
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init.method || 'GET'} ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
};

const me = await api('/user');
const [owner, name] = REPO ? REPO.split('/') : [me.login, path.basename(ROOT)];
const full = `${owner}/${name}`;
console.log(`仓库: ${full}`);

let repo = null;
try {
  repo = await api(`/repos/${full}`);
  console.log(`已存在，默认分支 ${repo.default_branch}`);
} catch (e) {
  if (!String(e.message).includes('404')) throw e;
  repo = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name,
      private: PRIVATE,
      description: 'DSH 插件：用夸克网盘在多台电脑之间同步 DSH 状态与工作区（内容寻址打包上传 + 多设备清单合并）',
      auto_init: false,
    }),
  });
  console.log('新建仓库完成');
}

const files = spawnSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).stdout.split('\n').filter(Boolean);

let parent = null;
try {
  const ref = await api(`/repos/${full}/git/ref/heads/${repo.default_branch}`);
  parent = ref.object.sha;
} catch {
  parent = null;
}

// 空仓库不接受 git/blobs，得先用 contents API 提交一个种子文件把它初始化。
if (!parent) {
  const seed = await api(`/repos/${full}/contents/README.md`, {
    method: 'PUT',
    body: JSON.stringify({
      message: 'chore: 初始化仓库',
      content: Buffer.from(`# ${name}\n`).toString('base64'),
    }),
  });
  parent = seed.commit.sha;
  console.log('空仓库已用种子提交初始化');
}
console.log(`文件数: ${files.length}`);

const tree = [];
for (const f of files) {
  const buf = readFileSync(path.join(ROOT, f));
  const blob = await api(`/repos/${full}/git/blobs`, {
    method: 'POST',
    body: JSON.stringify({ content: buf.toString('base64'), encoding: 'base64' }),
  });
  // GitHub 树 API 允许 path 里带斜杠，会自己建出子目录
  tree.push({ path: f, mode: '100644', type: 'blob', sha: blob.sha });
}

const newTree = await api(`/repos/${full}/git/trees`, {
  method: 'POST',
  body: JSON.stringify({ tree }),
});
const commit = await api(`/repos/${full}/git/commits`, {
  method: 'POST',
  body: JSON.stringify({
    message: MESSAGE || spawnSync('git', ['log', '-1', '--pretty=%s'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(),
    tree: newTree.sha,
    ...(parent ? { parents: [parent] } : {}),
  }),
});

if (parent) {
  await api(`/repos/${full}/git/refs/heads/${repo.default_branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commit.sha, force: true }),
  });
} else {
  await api(`/repos/${full}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${repo.default_branch}`, sha: commit.sha }),
  });
}

console.log(`已推送 ${commit.sha}`);
console.log(`https://github.com/${full}`);
