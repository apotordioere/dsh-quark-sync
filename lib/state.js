// 本地状态：文件哈希缓存、上次推送的 manifest、云端 fid 缓存
import fs from 'node:fs/promises';
import path from 'node:path';

const EMPTY = {
  version: 1,
  deviceId: null,
  files: {},        // absPath -> {size, mtimeMs, sha}
  pushedManifest: null, // {ts, entries: {path: {sha,size,mtime}}}
  cloud: { rootFid: null, blobsFid: null, manifestsFid: null, updatedAt: 0 },
  lastPushAt: 0,
  lastPullAt: 0,
};

export async function loadState(file) {
  try {
    const text = await fs.readFile(file, 'utf8');
    const parsed = JSON.parse(text);
    return { ...structuredClone(EMPTY), ...parsed };
  } catch {
    return structuredClone(EMPTY);
  }
}

export async function saveState(file, state) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
  await fs.rename(tmp, file);
}
