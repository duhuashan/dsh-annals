# dsh-worklog

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

把「每天一个日志文件 + 自动索引 + git 版本记录」装进一条命令：技能、规矩、提醒、初始化一次给齐。

> DSH（DeepSeek Harness）插件 | 版本 0.1.3 | [Releases](https://github.com/duhuashan/dsh-worklog/releases)

## 解决什么问题

日志系统通常死在三个环节：

1. **技能被遗漏加载** —— 模型「想到要记」才会去加载技能，而想到要记正是失效的那一环。
2. **规矩漂移** —— 只在 AGENTS.md 里写，模型偶尔漏读、读成片段、被别的指令挤掉。
3. **装好了但没初始化** —— 用户装完插件，还得手动建目录、写生成器、跑 git init。

这个插件把三件事装进一个包，并补上第四件：一次初始化。

## 四件事

| 能力 | 机制 | 为什么这样 |
|---|---|---|
| `worklog` 技能 | `ctx.skills.register()`（运行时 rank 250） | 工作区 `.dsh\skills\worklog` 同名时 rank 100 覆盖它 —— 用户可改，不锁死 |
| 常驻规矩 | `ctx.systemPrompt.section()`，order 150 | 不依赖技能加载；每轮都在系统提示里 |
| 轮次提醒 | `agent/turn-stopping` 里 `agent.steer()`，判据是轮首/轮尾的工作区快照 | 官方契约：turns 即将关闭时 steer 必定再跑一步，模型当场补写 |
| 索引新鲜度提醒 | 同上，`turn-stopping` 里比对 mtime | 防「写了日志就以为完事」—— 索引是生成物，不跑生成器就永远停在旧快照 |
| 初始化 | `worklog_init` 工具 | 一次建好 日志\\、生成器、git、状态文件；已存在的文件绝不覆盖 |

## 初始化：三态

状态记在 `<工作区>\.dsh\log-system.json`：

| 状态 | 触发 | 行为 |
|---|---|---|
| 未决定（无状态文件） | 新会话 `agent/created` | 注入一条提示，让模型问用户一次；不提醒写日志 |
| 已启用（`state: "enabled"`） | 用户同意或已有 `日志\build-index.mjs` | 正常提醒补写 |
| 已拒绝（`state: "declined"`） | 用户拒绝 | 完全静默，不注入、不提醒、零副作用 |

拒绝后如何再开：直接让模型调用 `worklog_init(enabled=true)`，或删掉 `.dsh\log-system.json` 让插件重新询问。

**兼容老工作区**：没有状态文件但已有 `日志\build-index.mjs` 的，直接视为已启用，不重复询问。

## 初始化做了什么

`worklog_init(enabled=true)` 一次完成：

1. 写 `日志\.gitattributes`（`*.md` 用 CRLF、`*.mjs` 用 LF）
2. 写 `日志\build-index.mjs`（索引生成器，零依赖）
3. 写 `日志\YYYY-MM-DD.md` 骨架（`# 日期`）
4. 在 `日志\` 里 `git init`
5. 写 `.dsh\log-system.json`

**只碰 `日志\` 和 `.dsh\`，不在工作区根创建任何文件**（生成器用脚本自身位置识别工作区根，不依赖 `_文档架构.md` 之类的锚点文件）。

已存在的文件全部跳过，不覆盖用户数据。所有写入都带会话的沙箱策略（`sandboxPolicy.resolve({session})`），因此即使 DSH 进程的 cwd 不在该工作区，初始化也不会被 fs-sandbox 默认策略拒绝。

## 配置

插件带一个 GUI 开关页：**设置面板 → 日志系统**（web 端 client 半注册 `settings.section`，六个开关读写 Host 的 `worklog` 设置命名空间；保存写进 profile 的 `cordis.patch.yml` config 段，Loader 校验后热重载条目，立即生效，不需要重启）。

> 插件页卡片（「插件」→ dsh-worklog）不渲染配置表单——那是 DSH 的既有行为：插件页只显示包信息与运行状态，配置表单由功能包自己注册设置页。
>
> 六个字段在 schema 里带 `.volatile()`：`dsh-settings` 的表单投影只收 volatile 字段（`volatileForm`，`dsh-settings\lib\index.js:122-131`），普通字段不会出现在 `settings.describe()` 的命名空间里。代价是 Loader 校验后的配置值是 cosmokit 的运行时引用对象（`cosmokit\lib\index.js:102-110`），不是 boolean——插件内部统一用 `readFlag(config, '字段')` 解包 `get()`，不要直接读 `config.字段`。

没有 GUI 时，也可以在 `cordis.patch.yml` 里 override `worklog` 的 config（Loader 用 Standard Schema 校验并填默认值，`cordis\lib\index.js:956-958`）：

| 字段 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关 |
| `skill` | `true` | 注册 `worklog` 技能 |
| `section` | `true` | 注入常驻日志规矩 |
| `reminder` | `true` | 轮次收尾提醒（含索引新鲜度提醒） |
| `initTool` | `true` | 注册 `worklog_init` 工具 |
| `skipSubagents` | `true` | 子代理会话不提醒 |

GUI 保存立即生效；改 `cordis.patch.yml` 后需重启 DSH。

**依赖**：唯一运行时依赖是 `@deepseek-ai/schemastery`（只用于配置 schema）。从 tarball / npm 安装时 pnpm 会随包自动装；`link:` 安装不会装依赖，需在插件目录备好 `node_modules/@deepseek-ai/schemastery`。

## 安装

从 [Releases](https://github.com/duhuashan/dsh-worklog/releases) 下载 `dsh-worklog-0.1.3.tgz`，然后：

```powershell
dsh plugin --profile web add C:\path\to\dsh-worklog-0.1.3.tgz
```

开发时也可以从源码目录链进去（依赖不会自动装，需自备 `schemastery`）：

```powershell
dsh plugin --profile web add link:C:/path/to/dsh-worklog
```

装完**重启 DSH** 生效。

## 卸载

```powershell
dsh plugin --profile web remove dsh-worklog
```

卸载不删数据：`日志\`、`.dsh\log-system.json` 都留着。

## 测试

```powershell
node --test test/offline.mjs            # 62 个离线用例（mock 服务）
node --test test/build-index.test.mjs   # 29 个生成器端到端用例（真实临时目录 + 真实子进程）
node test/e2e-sandbox.mjs "D:\某个空目录"   # 真实磁盘端到端：模拟 fs-sandbox 拒绝默认策略、验证初始化全部写入成功、再跑生成器
```

离线用例覆盖状态三态、初始化幂等、引导注入、提醒触发/跳过、索引新鲜度（不存在/陈旧/已最新/开关关闭/「不用记」）、工具两个分支、沙箱策略解析与透传、Config schema 形状。全部 mock 服务，不需要 DSH 宿主。

生成器用例覆盖：代码围栏屏蔽（含未闭合）、编号写法不规范（全角数字/顿号/缺空格）的 FAIL、编号重复/倒序/跳号的文案、BOM 剥离、日期不存在、非 UTF-8 WARN、同名目录与只读文件的友好报错、只有坏名文件时的原因、概览加粗变体、日期标题前导空格、行尾 `\r\r\n` 收敛、幂等，以及 A/B 两种脚本位置。

## 已知边界

- **不自动写日志，也不自动跑生成器**。只提醒，该不该记、记什么、什么时候跑 `build-index.mjs`，仍由模型判断和执行。插件不替模型写文件，好处是「谁写的」永远可追溯。
- **索引新鲜度靠 mtime 判定，同秒可能漏报**。判据是「今天日志的 mtime > `_日志索引.md` 的 mtime」，同秒写入时不成立。NTFS 精度到 100ns，实际几乎不会撞上；改成 `<=` 会误报「刚跑完生成器但没改日志」的情形，不值得。
- **「日志写没写」也靠 mtime，不认命令写法**。轮首（`turn/start`）给今天的日志文件拍一次 `{mtimeMs, size}` 快照，轮尾再拍一次，变了就算写过。好处是写法无关：`Set-Content`、`[System.IO.File]::WriteAllText`、`>>`、Node 的 `appendFileSync` 一视同仁；且能抓住「写了又还原」（内容一致但 mtime 变了）。代价是**判据是「动过」而非「动了内容」** —— 用编辑器打开再原样保存也算。另有一条副作用是想要的行为：读取日志不改 mtime，所以「命令里提到日志路径但只是 `Get-Content`」不会被误判成写过。
- **「改没改文件」靠工作区快照，不再猜命令行**。轮首（`turn/start`）扫一遍工作区，记下每个文件的 `mtimeMs:size`；轮尾再扫一遍，两张不一样就是改过 —— 一次同时覆盖**改动 / 新建 / 删除**，与命令怎么写完全无关（`echo`、`Set-Content`、`node -e`、here-string 一视同仁）。代价：①「动过」即算改，用编辑器打开再原样保存也算；②大目录（`node_modules` 那种）每次要扫全量，超过 20000 个文件会放弃本次判定并退回旧逻辑；③`.git` 目录必须跳过 —— `git status`/`git add` 本身会重写 `.git\index`，不跳会把自己扫成「改过」。
- **文件工具这条路上还有一层路径过滤**。`write`/`edit`/`str_replace_editor` 的 `file_path` 是结构化参数，可以直接判在不在工作区内；判不了（拿不到 cwd、参数里没路径）一律当成在里面，宁可多报不要漏报。
- **官方 `workspaceChanges` 服务只在快照拿不到时兜底**。它看得见 `write`/`edit` 改了什么，但**在非 git 工作区，shell 写的它一律看不见**（`dsh-workspace-changes` README 自述），所以「没有事件」不等于「没有改动」。现在它只用来补「这几轮改的列表里有没有今天的日志」，不再决定「改没改文件」。
- **保留下来的关键词判定只在三种情况下生效**：轮首/轮尾拍不到快照、工作区文件数超过上限、或快照与官方清单都拿不到。这套判定是猜的，历史误报源包括 `echo "==== form 枚举定义 ===="` 里的 `form`（含 `rm `）、`2>&1` 里的 `>`、here-string 正文里出现的指令词、以及只碰 `D:\Temp` 的命令。均已单独修掉，但它终究是启发式。
- **不扫历史**。不读已完成会话，不生成摘要。
- **工作区级状态**。同一工作区多个会话共享一个状态文件；不同工作区互不影响。
- **工作区若自带同名技能会覆盖插件版**。DSH 的技能优先级是「工作区 `.dsh\skills`（rank 100）> 插件运行时注册（rank 250）」，所以某个工作区里放了 `.dsh\skills\worklog\SKILL.md` 时，模型用的是它而不是包内的 `assets/worklog.md`。想让插件版当唯一来源，就别在工作区放同名副本。
- **初始化写入按会话沙箱策略解析**。插件直调 `ctx.fs.writeText` 时传 `sandboxPolicy.resolve({session})` 的策略；省略的话 fs-sandbox 后端会退回默认 workspace-write + 进程 cwd，在「打开的其他目录工作区」里初始化会被拒（`file access denied under workspace-write mode`）。已实测并修复。
- **初始化不在工作区根创建文件**。只写 `日志\` 与 `.dsh\log-system.json`。生成器 `build-index.mjs` 用**脚本自身位置**当锚点：只认 `<工作区>\日志\build-index.mjs`（也兼容放在工作区根），被挪到别处会明确报错退出，不会把索引写到某个碰巧有 `日志\` 的目录。生成物是 `_日志索引.md`。**注意**：位置校验的实际判据是「自己所在目录」或「自己的 `日志\` 子目录」里有 `.md` 文件 —— 若把脚本复制到一个同时也有 `日志\` 子目录的无关路径下，它会把那里当成独立工作区正常生成。后者在语义上是合法的（子目录确实可以是另一个工作区），所以只加了一条「祖先目录下也有 `日志\`」的 WARN 提示，不阻断。
- **初始化里的 `git init` 同样按会话沙箱策略执行**。`ctx.shell.resolve` 不传 `sandboxPolicy` 时，dsh-pwsh-sandbox 会退回默认 workspace-write 并尝试 ACL 沙箱；本机 ACL 后端初始化失败（`windows-acl-run: AclSandbox init failed`），`git init` 被拒。修复：`runShell` 把同一个会话策略传给 `shell.resolve`。
- **技能注册必须带 `source`**。`ctx.skills.register()` 的 `validateRuntimeSkill` 不查 source，但 skill 工具加载时 `skills.get()` 会 `validateDefinition`，缺 source 抛 `loaded skill "worklog" source must be a string`。已补 `source: 'dsh-worklog'`。
- **GUI 开关页来自 client 半**。插件在 `package.json` 声明 `dsh.client.platform: "web"` 并导出 `./client`，宿主把它编进浏览器入口图（`/plugins` 路由，`window.__DSH_BOOT__` 里能看到 `dsh-worklog` 条目）。非 web profile 没有这一页，只能改 `cordis.patch.yml`。
- **提醒不显示在 GUI 对话流里**。提醒是通过 `agent.steer()` 注入给模型的 user 侧消息，不是对话气泡；GUI 会话里看不到它，模型会在思考/工具调用之间收到并处理。判断提醒是否发生，看会话记录里的 `source.kind === "worklog"` 消息，或从下一轮行为反推。
- **日志目录名固定为 `日志`**。插件按 `日志\build-index.mjs`、`日志\YYYY-MM-DD.md` 定位，改名（如 `logs`）会被判为「未启用」，需要重新初始化。
- **已拒绝只停主动询问，不锁死**。`worklog_init(enabled=false)` 写拒绝记录后插件完全静默（不询问、不提醒）；用户反悔时 `worklog_init(enabled=true)` 照常初始化，一次建齐全套（已在空工作区实测先拒后立）。
