// 同步范围定义：本机路径 -> 云端虚拟路径
// 所有根目录支持 ${VAR} 与 %VAR% 展开，便于两台机器用户名不同也能对上。
import { createHash } from 'node:crypto';
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
    exclude: ['**/session_projcache/**'],
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
    cloud: 'workspace',
    default: true,
    note: '工作区全部文件',
    exclude: ['**/node_modules/**', '**/.git/objects/**'],
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
