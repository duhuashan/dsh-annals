# dsh-annals

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

给 AI 一份跨会话的记忆：每天一个日志文件、一份可检索的索引、一个独立的 git 仓库。

> DSH（DeepSeek Harness）插件 | 版本 0.5.0 | [Releases](https://github.com/duhuashan/dsh-annals/releases)

## 为什么装它

### 问题是记忆，不是日志

AI 的每次会话都开在一张白纸上。上一轮敲定的方案、踩过的坑、否掉的路线，下一轮全都不在了 —— 于是你反复解释同一件事，它反复推荐你早就排除掉的办法。

真正的代价不是多花的那几分钟，是**你开始不再信任它的判断**：你知道它说的每句话都没查过前情，只能自己盯。

### 你需要的是一份它能自己查到的记录

写日志这件事，人靠自律，AI 靠规矩。而这个插件补的是**规矩能被执行**的那一环。

日志系统自己搭，通常死在三个地方：

1. **技能被遗漏加载** —— 模型「想到要记」才会去加载技能，而「想到要记」正是失效的那一环。
2. **规矩漂移** —— 只在 `AGENTS.md` 里写，模型偶尔漏读、读成片段、被别的指令挤掉。
3. **装好了但没初始化** —— 目录、生成器、`git init`，一样不落全得手动来。

这个插件把三件事装进一个包，并补上第四件：**一次初始化**。

### 装完你会得到什么

| 变化 | 具体表现 |
|---|---|
| **不用重复解释** | 干了三个月的事，AI 用 `annals_query` 一次调用查得到当时为什么这么定 |
| **坑只踩一次** | 失败记录留在日志里，下次撞上同一处，它先查到再动手 |
| **决定有据可查** | 三个月后你自己也忘了当初为什么排除方案 A —— 日志里有 |
| **能交接** | 换个 AI、换个人，读日志就能接上，不用口述前情 |

它不是「帮你写周报」的工具。它解决的是**你和 AI 之间没有共享上下文**这件事。

## 安装

从 [Releases](https://github.com/duhuashan/dsh-annals/releases) 下载最新的 `dsh-annals-<版本>.tgz`，然后：

```powershell
dsh plugin --profile web add C:\path\to\dsh-annals-0.5.0.tgz
```

装完**重启 DSH** 生效。

开发时可以从源码目录链进去（依赖不会自动装，需自备 `@deepseek-ai/schemastery`）：

```powershell
dsh plugin --profile web add link:C:/path/to/dsh-annals
```

> **两个装完才知道的坑**
>
> 1. **本地 tgz 是按绝对路径记的，不是解包副本**。`dsh plugin add` 会在 profile 的 `package.json` 里写下 `"dsh-annals": "file:D:/path/to/xxx.tgz"` —— tgz 一删，这个 profile 就装不上了。想长期用，把它放到不会被清理的位置。
> 2. **从 tgz 装会自动装依赖**（`@deepseek-ai/schemastery`），从 `link:` 装**不会**。这是 pnpm 的行为，不是插件选的。

## 装完会发生什么

### 第一次进新工作区：它会主动问你

不用你记着要启用。插件注入一条提示，让模型问你一次：

> 要不要在本工作区启用日志系统？它会建 `日志\` 目录、索引生成器和一个独立的 git 仓库，我每次干完活会把事情记进去。

- 你说**要** → 它调用 `annals_init(enabled=true)`，一次建好全部文件
- 你说**不要** → 写一条拒绝记录，之后**完全静默**：不询问、不提醒、零副作用

反悔了随时能开：让模型调用 `annals_init(enabled=true)`，或者删掉 `.dsh\log-system.json` 让它重新问。

### 启用后：初始化建了什么

`annals_init(enabled=true)` 一次完成，**已存在的文件全部跳过，不覆盖你的数据**：

1. `日志\.gitattributes` —— `*.md` 用 CRLF、`*.mjs` 用 LF
2. `日志\build-index.mjs` —— 索引生成器，零依赖
3. `日志\log-parse.mjs` —— 生成器用的解析模块
4. `日志\YYYY-MM-DD.md` —— 今天的日志骨架
5. 在 `日志\` 里 `git init`
6. `.dsh\log-system.json` —— 状态文件

**只碰 `日志\` 和 `.dsh\`，不在工作区根创建任何文件。**

> 顺带一个坑：插件跑的是裸 `git init`，全局没设 `init.defaultBranch` 时新仓叫 `master`。想要 `main` 就自己 `git branch -m main`。

### 干活的时候：两条提醒

提醒**不显示在 GUI 对话流里** —— 它通过 `agent.steer()` 注入给模型，你在界面上看不到，只会发现 AI 突然回头补了日志。

| 什么时候 | 提醒什么 |
|---|---|
| 这一轮改了文件，但没写今天的日志 | 催它判断该不该记、该记就写 |
| 日志写了，但 `_日志索引.md` 没更新 | 催它跑生成器、提交 |

**它只提醒，不代劳**。该不该记、记什么、什么时候跑生成器，仍然由模型判断和执行。插件不替模型写文件 —— 好处是「谁写的」永远可追溯。

### 工作区的三种状态

状态记在 `<工作区>\.dsh\log-system.json`：

| 状态 | 怎么进入 | 之后的行为 |
|---|---|---|
| 未决定（无状态文件） | 默认 | 新会话时注入提示，让模型问你一次；不催写日志 |
| 已启用（`state: "enabled"`） | 你同意，或已有 `日志\build-index.mjs` | 正常提醒 |
| 已拒绝（`state: "declined"`） | 你拒绝 | 完全静默 |

**兼容老工作区**：没有状态文件、但已经有 `日志\build-index.mjs` 的，直接视为已启用，不重复询问。

## 我该说什么话

大部分时候你什么都不用说 —— 它会自己问、自己提醒。下面这些是**说出来有明确效果**的：

| 你说 | 会发生什么 |
|---|---|
| 「好」/「启用吧」（在它问的时候） | 初始化整个日志系统 |
| 「不用了」 | 写拒绝记录，之后不再问、不再提醒 |
| 「记一下」/「先记一下」 | 让模型现在就把当前进展写进日志 |
| 「简单记」/「详细记」 | 决定这条写多细（A 档 / C 档）；不说默认 B 档 |
| 「这个不用记」/「别碰日志」 | 本会话不再催写日志 |
| 「以前那个 X 是怎么弄的？」 | 触发 `annals_query`，按内容捞历史 |
| 「这个文件以前哪些条目碰过？」 | 触发 `annals_links`，按关系反查 |

**判断记不记由模型来做**，它加载 `annals` 技能后按一份正反清单判断。拿不准会问你一句，日常小事不问也不写。

## 能力一览

| 能力 | 是什么 | 什么时候用得上 |
|---|---|---|
| `annals` 技能 | 写日志的完整规矩（该不该写、写多细、怎么排版、写完做什么） | 模型要写日志时自动加载 |
| 常驻规矩 | 一段精简版日志规矩，**每轮**都在系统提示里 | 防止「模型没加载技能就忘了要记」 |
| 轮次提醒 | 轮次收尾时判断这一轮改了文件却没写日志 | 提醒本身不占你注意力，只在它漏记时出现 |
| 索引新鲜度提醒 | 判断日志写了但索引没重新生成 | 防「写了日志就以为完事」—— 索引不跑，检索永远停在旧快照 |
| `annals_init` | 一次初始化整个日志系统 | 首次启用；或反悔后重新启用 |
| `annals_query` | **按内容找**：忘了一件事在哪，用关键词捞 | 动手做一件「感觉做过」的事之前 |
| `annals_links` | **按关系找**：知道是哪一条，看它引了谁、谁引了它 | 改文件前想知道以前哪些条目碰过它 |

`annals_query` 与 `annals_links` 不重叠：前者用在「我记得做过但忘了在哪」，后者用在「我知道是哪条，想看它牵到谁」。

**都没有自动触发**。插件不会在每轮替你检索再塞进上下文 —— 那会把 prompt 缓存命中率打到 0%，而且意图分类判错等于静默不检索。只有两处被动入口：常驻系统提示里的一句规矩、`annals` 技能的触发词。是否调用由模型自己决定。

## 配置

插件带一个 GUI 开关页：**设置面板 → 日志系统**。

六个开关读写 Host 的 `annals` 设置命名空间；保存后写进 profile 的 `cordis.patch.yml` config 段，热重载条目，**立即生效，不需要重启**。

> 插件页卡片（「插件」→ dsh-annals）不渲染配置表单 —— 那是 DSH 的既有行为：插件页只显示包信息与运行状态，配置表单由功能包自己注册设置页。

### 九个字段，六个在 GUI 里

| 字段 | 默认 | 含义 | GUI |
|---|---|---|---|
| `enabled` | `true` | 总开关 | ✅ |
| `skill` | `true` | 注册 `annals` 技能 | ✅ |
| `section` | `true` | 注入常驻日志规矩 | ✅ |
| `reminder` | `true` | 轮次收尾提醒（含索引新鲜度提醒） | ✅ |
| `initTool` | `true` | 注册 `annals_init` 工具 | ✅ |
| `skipSubagents` | `true` | 子代理会话不提醒 | ✅ |
| `queryTool` | `true` | 注册 `annals_query` 工具 | ❌ 只能改 YAML |
| `linksTool` | `true` | 注册 `annals_links` 工具 | ❌ 只能改 YAML |
| `probe` | `true` | 漏查探测：只记到 `.dsh\annals-probe.jsonl`，不注入、不打扰 | ❌ 只能改 YAML |

没有 GUI（headless / 非 web profile）时，直接在 `cordis.patch.yml` 里 override `annals` 的 config：

```yaml
- id: annals
  config:
    queryTool: false
```

改 YAML 后**需要重启 DSH**。

> **实现细节（改代码才会撞上）**：九个字段在 schema 里都带 `.volatile()` —— `dsh-settings` 的表单投影只收 volatile 字段，普通字段不会出现在 `settings.describe()` 里。代价是 Loader 校验后的配置值不是 boolean，而是 cosmokit 的运行时引用对象；插件内部统一用 `readFlag(config, '字段')` 解包，不能直接读 `config.字段`。

## 卸载

```powershell
dsh plugin --profile web remove dsh-annals
```

**卸载不删数据**：`日志\`、`.dsh\log-system.json` 都留着。重装后原样接上。

## 测试

```powershell
pnpm test    # 一条命令跑完全部 264 个用例
```

全部离线运行，不需要 DSH 宿主。五套各测什么、各自的覆盖与已知跳过项，见 [ARCHITECTURE.md](ARCHITECTURE.md#测试策略)。

仓库里**没有 commit lock 文件**，所以刚 clone 下来还没有 `node_modules`。`pnpm test` 会先自动装依赖再跑（pnpm 11 默认行为），一行命令即可；`npm test` 不会自动装，得先 `npm install`。

单独跑某一套：

```powershell
node --test test/offline.mjs            # 插件本体
node --test test/build-index.test.mjs   # 索引生成器
node --test test/links.test.mjs         # 双向链接
node --test test/version.test.mjs       # 版本号与打包清单一致性
node --test test/e2e-sandbox.test.mjs   # 真实磁盘端到端
```

## 已知边界

这些是你**真会撞上**的。纯内部实现（为什么这么判、踩过什么坑）在 [LIMITATIONS.md](LIMITATIONS.md)。

- **不自动写日志，也不自动跑生成器**。只提醒。该不该记、记什么、什么时候跑生成器，仍由模型判断和执行。
- **索引新鲜度靠文件修改时间判定，同秒可能漏报**。判据是「今天日志的 mtime > `_日志索引.md` 的 mtime」，同秒写入时不成立。NTFS 精度到 100ns，实际几乎不会撞上。
- **不扫历史**。不读已完成会话，不生成摘要。
- **状态是工作区级的**。同一工作区多个会话共享一个状态文件；不同工作区互不影响。
- **工作区自带同名技能会覆盖插件版**。DSH 的技能优先级是「工作区 `.dsh\skills`（rank 100）> 插件运行时注册（rank 250）」。想让插件版当唯一来源，就别在工作区放 `.dsh\skills\annals\SKILL.md`。
- **提醒不显示在 GUI 对话流里**。它走 `agent.steer()`，不是对话气泡。想确认提醒发生过，看会话记录里 `source.kind === "annals"` 的消息，或从下一轮行为反推。
- **日志目录名固定为 `日志`**。插件按 `日志\build-index.mjs`、`日志\YYYY-MM-DD.md` 定位，改名（如 `logs`）会被判为「未启用」，需要重新初始化。
- **已拒绝只停主动询问，不锁死**。拒绝后插件完全静默；反悔时 `annals_init(enabled=true)` 照常初始化。
- **`annals_links` 会截断带空格的 Windows 路径**。`` `D:\Program Files\DSH\DSH.exe` `` 被解析成 `Files\DSH\DSH.exe` —— 反引号内的路径没有引号可配对，按空格取「最后一个带扩展名的片段」时会把前面的目录丢掉。**要精确引用，别让路径里带空格。**
- **`annals_links` 不校验引用是否还有效**。日志是历史快照，当时确实存在就够了。代价：文件改名或删除后，反查仍会列出那些引用，读的时候要自己留意。
- **裸名不猜上限 8 条**。入链查一个全库重名的文件（如 `说明.md`）时，只在**没有正经命中**的情况下逐条列「指向不明」的疑似条目，最多 8 条；有正经命中时只报总数。

## 延伸阅读

- **[ARCHITECTURE.md](ARCHITECTURE.md)** —— 它怎么工作的：宿主契约、状态机、四条证据的提醒引擎、检索算法、双向链接的设计取舍。
- **[LIMITATIONS.md](LIMITATIONS.md)** —— 每一处「为什么不那么做」：15 条内部实现的完整推演与实测记录。

## 许可证

[MIT](LICENSE)
