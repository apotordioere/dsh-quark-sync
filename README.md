# 夸克云同步

把 DSH 的工作状态放进自己的夸克网盘，让另一台电脑接着干活。插件通过夸克官方 skill 的 CLI 执行状态检查、上传和下载；双向同步以云端内容为中转，不改变 DSH 的原有数据格式。

## 依赖

本机必须安装夸克官方 skill：`%USERPROFILE%\.dsh\skills\quarkclouddrive`，其中包含官方 CLI `quark-drive.cjs`，并完成该 skill 要求的登录/授权。插件本身不内置 CLI，也不保存登录凭据。

## 同步范围

默认同步以下 13 项（DSH 状态与工作区双向同步；`harness/app` 只上行，B 机不会盲覆盖）：

| # | 内容 | 本地路径 |
|---|------|----------|
| 1 | 会话记录（另一台接手的核心） | `~/.dsh/sessions` |
| 2 | Mnemon 记忆 | `D:\Mnemon` |
| 3 | DSH profile（含 `node_modules`、`cordis.patch.yml`） | `~/.dsh/profiles` |
| 4 | Harness 设置 | `%APPDATA%\dsh-desktop\harness\settings.yaml` |
| 5 | API 密钥（明文） | `~/.dsh/.credentials.yaml` |
| 6 | 用户级 Skill | `~/.dsh/skills` |
| 7 | 调度任务、工作区索引 | `~/.dsh/storages`（跳过 `projcache`） |
| 8 | 人设 | `%APPDATA%\ivan-pet-desktop\persona.json`（旧 `~/.dsh/whale-persona` 已于 2026-11-14 删除） |
| 9 | DSH 应用本体（只上行） | `D:\deepseek\resources` |
| 10 | Torso 插件源码 | `D:\torso` |
| 11 | 本机插件源码 | `D:\dsh-plugins` |
| 12 | 工作区 | `D:\DESKTOP\DEEPSEEK专用` |
| 13 | 聊天附件（5.4 GB） | `~/.dsh/attachments` |

## 使用

插件提供 Agent 工具 `quark_sync`：

- `status`：扫描本机与云端，报待上传、待下载与版本差异，不改文件。
- `push`：把本机变更上传到夸克网盘。
- `pull`：把云端变更下载到本机。

`cordis.patch.yml` 里 `autoSync` 控制定时自动同步（现为 `true`，每 `intervalSeconds`=900 秒一轮：先 push 再 pull）。一轮完整扫描+哈希 37k 文件约 1.5 分钟，间隔不要设太短。

## 新电脑（B 机）上手

1. 装好同版本 DSH，工作区路径与 Mnemon 路径必须和 A 机一致：`D:\DESKTOP\DEEPSEEK专用`、`D:\Mnemon`。
2. 把夸克官方 skill 目录复制到 `%USERPROFILE%\.dsh\skills\quarkclouddrive`，用同一授权码登录：`node scripts\quark-drive.cjs login --token <授权码> --session-input '...' --session-id '<ts>-<rand6>'`。
3. 把本插件目录放到 `D:\DESKTOP\DEEPSEEK专用\dsh-quark-sync`，在 DSH 里安装：`plugin_manager install_bundle`，target 填该目录绝对路径。
4. 让 Agent 调 `quark_sync` 的 `pull`，等它把 1 万多个文件拉完（首次约 20–40 分钟）。
5. 重启 DSH，会话列表里就会出现 A 机同步过来的会话，直接接着干活。之后两台机器都在 `autoSync` 下每 15 分钟自动对齐一次，也可以随时手动 `quark_sync`。

## 云端残留（需手动清理）

夸克 CLI 没有删除命令。`DSH-Sync` 下这些是开发期测试目录，可以在夸克网盘里直接删：`probe-device/`（96 文件的测试清单）、`bench/`；另外 `blobs/` 里有约 28 个带 `(1)`/`(2)` 后缀的重复块（早期重传事故留下的），删掉不影响使用。

## 实现要点

- 云端布局：`DSH-Sync/blobs/<内容哈希>` 放打包后的数据块（gzip 压缩的 tar，同目录 ≤16 MB / ≤400 文件一包；>32 MB 的单文件单独成块），`DSH-Sync/manifests/<deviceId>/<UTC 时间>.json` 放每台机器每轮的路径清单。
- 内容寻址：包名只由「路径 + 文件内容哈希」决定，内容不变则整包跳过上传。夸克 CLI 既不能覆盖同名文件也不能删除，所以不用「同名替换」那套。
- 拉取：合并所有设备清单取最新，只下缺失的包，解包后逐个校验 sha256，再原子替换（`.qsync.tmp` → rename）。
- 冲突：同一路径两台机器都改，按清单时间戳取新的一方，被覆盖的本机旧版留成 `<文件名>.qsync-prev`；删除不传播（tombstone）。
- 安全阀：`harness/app` 永不覆盖（要覆盖需显式 `allowAppOverwrite: true`）；30 秒内被写过的文件跳过，避免和正在跑的会话抢文件。

## 已知限制

- 夸克 CLI 不能覆盖也不能删除文件，旧版本块只累积不回收，需要时人工清理云端 `DSH-Sync/blobs`。
- `~/.dsh/.credentials.yaml` 是明文密钥，会随同步上传；不同步就把第 5 项从 `lib/scope.js` 的 `default` 改成 `false`。
- 两台机器的盘符与路径必须一致，否则会话按工作区路径编码的目录名对不上。
- 首传约 11.7 GB、1 万多个文件，压缩后仍要传数 GB；受夸克 CLI 单路速度限制，实际约 2–3 MB/s。
