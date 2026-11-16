// 同步范围定义：本机路径 -> 云端虚拟路径
// 所有根目录支持 ${VAR} 与 %VAR% 展开，便于两台机器用户名不同也能对上。
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, realpathSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME = os.homedir();

// DSH 桌面版给插件进程的 env 里没有 USERPROFILE / APPDATA（实测：插件内 rootCheck 全是 ENOENT，
// 而同一份代码用 node 直接跑就正常），所以展开时必须有兜底，否则路径会塌成相对路径。
const FALLBACK_ENV = {
  USERPROFILE: HOME,
  HOME,
  APPDATA: path.join(HOME, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(HOME, 'AppData', 'Local'),
  TEMP: os.tmpdir(),
  TMP: os.tmpdir(),
};

function envValue(name) {
  const direct = process.env[name];
  if (direct) return direct;
  const key = Object.keys(FALLBACK_ENV).find((k) => k.toLowerCase() === String(name).toLowerCase());
  return key ? FALLBACK_ENV[key] : '';
}

function expand(p) {
  if (!p) return p;
  let out = p.replace(/%([^%]+)%/g, (_, name) => envValue(name));
  out = out.replace(/\$\{([^}]+)\}/g, (_, name) => envValue(name));
  return path.normalize(out);
}

/**
 * id: 云端顶层目录名
 * root: 本地绝对路径
 * kind: 'dir' 整目录 / 'file' 单文件
 * default: 首次安装是否默认启用
 * note: 给用户看的中文说明
 */
export const DEFAULT_SCOPES = [
  {
    id: 'dsh-state',
    kind: 'dir',
    root: '%USERPROFILE%\\.dsh\\sessions',
    cloud: 'dsh-state/sessions',
    default: true,
    note: '会话记录（另一台机器接手工作的核心）',
    exclude: [],
  },
  {
    id: 'dsh-mnemon',
    kind: 'dir',
    root: 'D:/Mnemon',
    cloud: 'dsh-state/mnemon',
    default: true,
    note: 'Mnemon 记忆库（MEMORY.md / USER.md / 文档）',
    exclude: [],
  },
  {
    id: 'dsh-profile',
    kind: 'dir',
    root: '%USERPROFILE%\\.dsh\\profiles',
    cloud: 'harness/profiles',
    keepNodeModules: true,
    default: true,
    note: 'harness 组件：cordis.patch.yml、package.json、node_modules 全部插件',
    exclude: ['**/node_modules/.cache/**', '**/.vite/**'],
  },
  {
    id: 'dsh-settings',
    kind: 'file',
    root: '%APPDATA%\\dsh-desktop\\harness\\settings.yaml',
    cloud: 'harness/settings.yaml',
    default: true,
    note: '全局设置（模型、审批、外观）',
  },
  {
    id: 'dsh-credentials',
    kind: 'file',
    root: '%USERPROFILE%\\.dsh\\.credentials.yaml',
    cloud: 'harness/credentials.yaml',
    default: true,
    note: '各家 API 密钥（明文，云端可见）',
  },
  {
    id: 'dsh-skills',
    kind: 'dir',
    root: '%USERPROFILE%\\.dsh\\skills',
    cloud: 'harness/skills',
    default: true,
    note: '用户级 Skill（含夸克官方 CLI 本体）',
    exclude: [],
  },
  {
    id: 'dsh-storages',
    kind: 'dir',
    root: '%USERPROFILE%\\.dsh\\storages',
    cloud: 'harness/storages',
    default: true,
    note: '调度任务、工作区索引',
    // workspace.json 含本机绝对路径与本机 UUID。两台电脑必须各自保留本地 registry，不能用另一台的文件覆盖。
    exclude: ['workspace.json', '**/workspace.json', '**/session_projcache/**'],
  },
  {
    id: 'dsh-persona',
    kind: 'file',
    // 2026-11-14：人设已并入 dsh-ivan-pet-desktop，旧 ~/.dsh/whale-persona 已删除。
    // 现在唯一的人设源是这个文件（同目录的 pet.pid/pet.lock 等是运行态，不纳入同步）。
    root: '%APPDATA%\\ivan-pet-desktop\\persona.json',
    cloud: 'harness/ivan-pet-desktop/persona.json',
    default: true,
    note: '人设配置（伊万人设，由 dsh-ivan-pet-desktop 读取）',
  },
  {
    id: 'harness-app',
    kind: 'dir',
    root: 'D:/deepseek/resources',
    cloud: 'harness/app',
    default: true,
    note: 'DSH 应用本体（只上行，B 机不盲覆盖）',
    exclude: ['**/*.log'],
  },
  {
    id: 'plugin-src-torso',
    kind: 'dir',
    root: 'D:/torso',
    registryTitle: 'torso',
    cloud: 'harness/plugin-src/torso',
    default: true,
    note: 'link: 插件源码（桌宠 dsh-ivan-pet-desktop）',
    exclude: ['**/node_modules/**', '**/.git/**'],
  },
  {
    id: 'plugin-src-dsh-plugins',
    kind: 'dir',
    root: 'D:/dsh-plugins',
    cloud: 'harness/plugin-src/dsh-plugins',
    default: true,
    note: 'link: 插件源码（dsh-notify-desktop）',
    exclude: ['**/node_modules/**', '**/.git/**'],
  },
  {
    id: 'workspace',
    kind: 'dir',
    root: 'D:/DESKTOP/DEEPSEEK专用',
    registryTitle: 'DEEPSEEK专用',
    cloud: 'workspace',
    default: true,
    note: '工作区全部文件',
    exclude: ['**/node_modules/**', '.git/**', '**/.git/**'],
  },
  {
    id: 'attachments',
    kind: 'dir',
    root: '%USERPROFILE%\\.dsh\\attachments',
    cloud: 'dsh-state/attachments',
    default: true,
    note: '聊天附件（5.4 GB，会话里的图片文件）',
    exclude: [],
  },
];

export function resolveScopes(scopes = DEFAULT_SCOPES) {
  return scopes.map((s) => {
    const root = expand(s.root);
    // 展开失败会得到相对路径（甚至空字符串→'.'），那样会往 cwd 里乱写，必须当场报错。
    if (!path.isAbsolute(root)) {
      throw new Error(`同步范围 ${s.id} 的路径无法展开：${s.root} → ${root || '(空)'}`);
    }
    return { ...s, root };
  });
}

/**
 * 从 DSH 自己维护的 storages/workspace.json 读取全部已注册工作区。
 * 只同步实际存在的路径；cloud key 由工作区名称生成（不同机器 workspace UUID/path 可不同）。
 * 主 workspace 由默认范围覆盖；工作区名称必须跨设备保持一致。
 */
export function workspaceScopesFromFile(
  filePath = path.join(HOME, '.dsh', 'storages', 'workspace.json'),
  log = () => {},
  base = resolveScopes(DEFAULT_SCOPES),
) {
  let data;
  try {
    data = JSON.parse(readFileSync(filePath, 'utf8'));
  } catch (e) {
    log(`无法读取 DSH 工作区注册表；本轮不会同步动态工作区: ${filePath} (${e.code || e.message})`);
    return [];
  }
  const table = data?.tables?.workspaces;
  if (!table || typeof table !== 'object') {
    log(`跳过无效的 DSH 工作区注册表: ${filePath}`);
    return [];
  }
  if (!Array.isArray(data?.global?.workspaceIds)) {
    log(`跳过缺少 active workspaceIds 的 DSH 注册表，避免纳入过期条目: ${filePath}`);
    return [];
  }
  const activeIds = new Set(data.global.workspaceIds);
  const baseByTitle = new Map(base.filter((s) => s.registryTitle).map((s) => [s.registryTitle.normalize('NFKC').toLowerCase(), s]));
  const isWithin = (candidate, parent) => {
    const relative = path.relative(parent, candidate);
    return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  const records = Object.entries(table)
    .filter(([id, workspace]) => (!activeIds || activeIds.has(id)) && typeof workspace?.path === 'string' && workspace.path.trim())
    .map(([workspaceId, workspace]) => {
      const expanded = expand(workspace.path);
      if (!path.isAbsolute(expanded)) return null;
      const lexicalRoot = path.resolve(expanded);
      let lst;
      let st;
      let root;
      try {
        lst = lstatSync(lexicalRoot);
        st = statSync(lexicalRoot);
        root = realpathSync(lexicalRoot);
      } catch {
        log(`跳过不存在的 DSH 工作区路径: ${lexicalRoot}`);
        return null;
      }
      // Scope root 本身若是链接/重解析点，会允许扫描指向工作区之外的任意目录，拒绝以避免意外外传。
      if (lst.isSymbolicLink() || !st.isDirectory() || path.resolve(root).toLowerCase() !== lexicalRoot.toLowerCase()) {
        log(`跳过非普通目录或链接形式的 DSH 工作区路径: ${lexicalRoot}`);
        return null;
      }
      const title = String(workspace.title || path.basename(root)).trim().normalize('NFKC');
      return { workspaceId, root, title, titleKey: title.toLowerCase() };
    })
    .filter(Boolean);

  // 相同标题无法稳定映射到同一个云端位置。包含固定 scope 标题的冲突也不能偷偷映射其中一个。
  const titleCounts = new Map();
  const rootCounts = new Map();
  for (const record of records) {
    titleCounts.set(record.titleKey, (titleCounts.get(record.titleKey) || 0) + 1);
    const rootKey = path.resolve(record.root).toLowerCase();
    rootCounts.set(rootKey, (rootCounts.get(rootKey) || 0) + 1);
  }
  const unique = records.filter((record) => {
    if (titleCounts.get(record.titleKey) > 1) {
      log(`跳过重名 DSH 工作区（避免跨设备映射歧义）：${record.title} (${record.root})`);
      return false;
    }
    const rootKey = path.resolve(record.root).toLowerCase();
    if (rootCounts.get(rootKey) > 1) {
      log(`跳过重叠 DSH 工作区路径（避免重复同步）：${record.title} (${record.root})`);
      return false;
    }
    const mappedScope = baseByTitle.get(record.titleKey);
    if (mappedScope) {
      const configuredRoot = path.resolve(mappedScope.root).toLowerCase();
      const registeredRoot = path.resolve(record.root).toLowerCase();
      const volumeRoot = path.parse(path.resolve(record.root)).root.toLowerCase();
      const overlapsOtherScope = base.some((scope) => {
        if (scope === mappedScope) return false;
        const other = path.resolve(scope.root).toLowerCase();
        if (scope.kind === 'file') return isWithin(other, registeredRoot);
        return registeredRoot === other || isWithin(registeredRoot, other) || isWithin(other, registeredRoot);
      });
      // 固定范围不能被映射成卷根、覆盖其它固定范围，或扩展到其原始根的父目录。
      if (registeredRoot === volumeRoot || overlapsOtherScope || (registeredRoot !== configuredRoot && isWithin(configuredRoot, registeredRoot))) {
        log(`跳过过宽或重叠的固定工作区映射：${record.title} (${record.root})`);
        return false;
      }
      mappedScope.root = record.root;
      return false;
    }
    return true;
  });

  // 固定 scope 的本机路径可能由 registry 映射，必须在映射之后计算保留区域。
  const reserved = base.filter((s) => s.kind === 'dir').map((s) => path.resolve(s.root).toLowerCase());
  const reservedFiles = base.filter((s) => s.kind === 'file').map((s) => path.resolve(s.root).toLowerCase());
  // 若注册工作区嵌在固定范围里，则单独映射并从固定范围排除；如果注册根反过来包住固定范围（例如 D:\\DESKTOP），则跳过，避免意外扩圈。
  // 也拒绝包住固定单文件范围的目录，避免把 credentials/settings 再作为普通工作区文件重复上传。
  const candidates = unique.filter((record) => {
    const key = record.root.toLowerCase();
    const conflictingRoot = reserved.find((root) => key === root || isWithin(root, key));
    const containsReservedFile = reservedFiles.some((file) => isWithin(file, key));
    if (conflictingRoot || containsReservedFile) {
      log(`跳过与固定同步范围重叠的 DSH 工作区：${record.title} (${record.root})`);
      return false;
    }
    return true;
  }).sort((a, b) => a.root.length - b.root.length || a.title.localeCompare(b.title, 'zh-CN'));
  const candidateRoots = candidates.map((record) => record.root);

  // 固定 scope 优先，但把其中单独映射的注册工作区排除掉，避免重复上传到两个 cloud key。
  // 这里必须从全部唯一 records 取子工作区；candidates 已排除了固定根内的工作区。
  for (const scope of base.filter((s) => s.kind === 'dir')) {
    const fixedRoot = path.resolve(scope.root).toLowerCase();
    const nested = unique
      .filter((record) => isWithin(record.root.toLowerCase(), fixedRoot) && record.root.toLowerCase() !== fixedRoot)
      .map((record) => path.relative(scope.root, record.root).replace(/\\/g, '/'));
    if (nested.length) scope.exclude = [...(scope.exclude || []), ...nested.flatMap((rel) => [rel, `${rel}/**`])];
  }

  const out = [];
  for (const record of candidates) {
    // 不用本机 workspaceId/path：另一台机器的 UUID 和根路径都可能不同；名称需在两端一致。
    const slug = record.titleKey.replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'workspace';
    const stableKey = `${slug}-${createHash('sha256').update(record.titleKey).digest('hex').slice(0, 10)}`;
    const nestedRoots = candidateRoots
      .filter((root) => root.toLowerCase() !== record.root.toLowerCase() && isWithin(root.toLowerCase(), record.root.toLowerCase()))
      .map((root) => path.relative(record.root, root).replace(/\\/g, '/'));
    out.push({
      id: `workspace-${stableKey}`,
      kind: 'dir',
      root: record.root,
      cloud: `workspaces/${stableKey}`,
      default: true,
      note: `DSH 工作区：${record.title}`,
      // 嵌套工作区独立映射，避免父工作区重复上传子树；其余忽略 VCS/依赖和同步备份。
      exclude: ['**/.git/**', '**/node_modules/**', '**/*.qsync.tmp', '**/*.qsync-prev', ...nestedRoots.flatMap((rel) => [rel, `${rel}/**`])],
    });
  }
  return out;
}

/** 默认范围 + 所有 DSH 注册的工作区。 */
export function resolveAllScopes(enabledScopes, log = () => {}) {
  // 即使用户关闭某个固定范围，也要用完整固定范围集合做碰撞/越界判定；
  // 否则仅保留 dsh-state 时，恶意或误登记的 D:\\DESKTOP 根会变成可同步的动态工作区。
  const allDefaults = resolveScopes(DEFAULT_SCOPES);
  const selectedIds = Array.isArray(enabledScopes) && enabledScopes.length > 0
    ? new Set(enabledScopes)
    : new Set(DEFAULT_SCOPES.filter((scope) => scope.default === true).map((scope) => scope.id));
  const dynamic = workspaceScopesFromFile(
    path.join(HOME, '.dsh', 'storages', 'workspace.json'),
    log,
    allDefaults,
  );
  const selected = allDefaults.filter((scope) => selectedIds.has(scope.id));
  return [...selected, ...dynamic];
}

/** 判断某个相对路径是否命中排除规则（只支持 ** 与 * 的简易 glob） */
export function isExcluded(relPath, excludes) {
  if (!excludes || !excludes.length) return false;
  const norm = relPath.replace(/\\/g, '/');
  for (const rule of excludes) {
    const re = globToRegExp(rule.replace(/\\/g, '/'));
    if (re.test(norm)) return true;
  }
  return false;
}

function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += '\\' + c;
    } else {
      out += c;
    }
  }
  return new RegExp('^' + out + '$');
}

export function deviceId() {
  // 主机名可能是中文（授权码机器名就全是中文），直接过滤会变成一串下划线，
  // 所以只保留 ASCII 前缀，再拼一段稳定哈希保证唯一。
  const raw = os.hostname();
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '').replace(/^[._-]+|[._-]+$/g, '');
  const hash = createHash('sha256')
    .update(`${raw}|${process.platform}|${os.arch()}`)
    .digest('hex')
    .slice(0, 8);
  return `${clean.slice(0, 16) || 'pc'}-${hash}`;
}
