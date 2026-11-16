# 夸克云同步

把 DSH 的工作状态放进自己的夸克网盘，让另一台电脑接着干活。插件通过夸克官方 skill 的 CLI 执行状态检查、上传和下载；双向同步以云端内容为中转，不改变 DSH 的原有数据格式。

## 依赖

本机必须安装夸克官方 skill：`%USERPROFILE%\.dsh\skills\quarkclouddrive`，其中包含官方 CLI `quark-drive.cjs`，并完成该 skill 要求的登录/授权。插件本身不内置 CLI，也不保存登录凭据。

## 同步范围

默认同步以下 DSH 状态范围，并自动读取 `%USERPROFILE%\.dsh\storages\workspace.json` 纳入全部已注册工作区（DSH 状态与工作区双向同步；`harness/app` 只上行，B 机不会盲覆盖）。新注册工作区会在下一轮同步自动发现。工作区云端目录由名称生成稳定键，因此两台机器工作区名称应一致；本机 `workspace.json` 不跨设备覆盖，B 机按自己的注册路径接收文件。

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
| 12 | 主工作区与所有注册工作区（自动发现） | `workspace.json` 中登记的路径（主工作区为 `D:\DESKTOP\DEEPSEEK专用`） |
| 13 | 聊天附件（5.4 GB） | `~/.dsh/attachments` |

## 使用

插件提供 Agent 工具 `quark_sync`：

- `status`：扫描本机与云端，报待上传、待下载与版本差异，不改文件。
- `push`：把本机变更上传到夸克网盘。
- `pull`：把云端变更下载到本机。

`cordis.patch.yml` 里的 `autoSync` 控制定时自动同步。当前配置为关闭（`autoSync: false`、`autoPull: false`）；完成夸克 CLI 安装/授权并验证首轮同步后，再手动启用。启用后按 `intervalSeconds: 43200`（12 小时）先 push 再 pull。也可随时手动调用 `quark_sync`。

## 新电脑（B 机）上手

1. 装好同版本 DSH，先在 B 机创建/注册需要接手的工作区（名称需与 A 机一致；路径可不同），并确认 Mnemon 使用 `D:\Mnemon`。插件按本机 `workspace.json` 把云端工作区映射到 B 机各自注册的路径。
2. 在 B 机按夸克官方 skill 的安装说明安装 CLI 并单独完成账号授权；不要复制 A 机的密钥文件。该 CLI 安装需先通过其 `scripts/install.sh` 检查。
3. 从本插件仓库下载并解压插件目录。在 B 机使用该版本 DSH 提供的本地 bundle 安装能力安装此目录；安装入口因版本而异，安装后确认插件状态为 active。若该机没有本地插件安装入口，需要由该机的 DSH 管理工具执行 `plugin_manager install_bundle`，目标为解压后的绝对目录路径。
4. 确认 B 机已注册全部同名工作区，再让 Agent 调 `quark_sync` 的 `pull`。本机最近一次只读预检约 45.6 GB、8.2 万个文件（其中 `.git` / `node_modules` 等排除项不下载）；耗时取决于网络和夸克限速，不能保证固定时长。
5. 检查 DSH 会话列表及工作区文件后，再启用自动同步。首次安装配置默认关闭自动 push/pull；启用后两台机器每 12 小时自动 push 后 pull，也可手动调用 `quark_sync`。

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
- 默认范围会上传 `~/.dsh/.credentials.yaml` 明文密钥、会话与附件；所有工作区内容也会进入个人夸克账号。云端访问权限/账号安全随之成为这些资料的安全边界；上传前确认设备与账号可信，不要把网盘目录公开分享。
- 动态工作区按 NFKC 规范化后的工作区名称建立云端 key；两台机器必须为同一工作区使用相同且唯一的名称。每台机器的本地路径可不同，但需先在 DSH 注册该工作区。工作区同步排除 `.git` 和 `node_modules`，不会同步 Git 元数据或依赖安装目录；B 机需自行安装依赖。符号链接/目录联接形式的工作区根目录会被跳过，避免越界扫描。主工作区路径仍影响会话目录编码，若要让会话 UI 完全匹配，建议两端路径一致。
- `workspace.json` 保留在各自本机，不会从云端覆盖；B 机需先用同名注册工作区，插件才能映射到正确本地路径。
- 最近一次只读预检约 45.6 GB、8.2 万个文件（取决于当时注册表与本机文件；上传压缩体积和耗时会变化），首传时间取决于网络和夸克限速，不能保证固定时长。
