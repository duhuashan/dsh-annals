# 架构与实现

这份文档回答「它为什么这么工作」。想知道**怎么用**看 [README.md](README.md)；想知道**为什么没采用另一种做法**看 [LIMITATIONS.md](LIMITATIONS.md)。

## 目录结构

```
dsh-annals/
├── lib/
│   ├── index.js        2013 行 · 插件主体：注册、状态机、提醒引擎、路径判定
│   ├── query.js         604 行 · 检索算法，纯函数、不碰 ctx、可单测
│   └── links.js         892 行 · 双向链接：解析反引号引用、建索引、出链入链
├── client/
│   └── client.js       设置面板的「日志系统」页（web 端 client 半）
├── assets/
│   ├── annals.md      329 行 · annals 技能的正文，运行时注册进技能系统
│   ├── build-index.mjs  索引生成器，初始化时**复制**进用户工作区
│   ├── log-parse.mjs    生成器的解析模块，同样复制进工作区
│   └── gitattributes    复制成 日志\.gitattributes
├── test/
│   ├── offline.mjs      2316 行 · 103 个离线用例（另有 2 个 skip）
│   ├── build-index.test.mjs  927 行 · 77 个生成器端到端用例
│   ├── links.test.mjs        855 行 · 75 个双向链接用例
│   ├── version.test.mjs       82 行 · 6 个版本号与打包清单一致性用例
│   ├── e2e-sandbox.mjs       204 行 · 真实磁盘端到端脚本（自己 console.log、自己设退出码）
│   └── e2e-sandbox.test.mjs   39 行 · 上者的 node:test 包装器（断言退出码 + 清理临时目录）
├── cordis.patch.yml    让插件进入 DSH 配置树的 patch
└── package.json
```

`lib/index.js` 之所以大，是因为它有 **7 个互不相关的能力块**（技能注册、常驻规矩、三个工具、引导注入、提醒引擎、漏查探测），并且带着大量「为什么不是另一种写法」的注释。它是单文件无内部依赖，拆成多个文件只会让人在 import 之间跳来跳去。

---

## 宿主契约

`lib/index.js:50` 声明依赖：

```js
export const inject = ['skills', 'systemPrompt', 'tools', 'fs', 'shell', 'workingDirectory'];
```

| 服务 / 钩子 | 用途 | 关键约束 |
|---|---|---|
| `ctx.skills.register()` | 注册 `annals` 技能 | **必须带 `source`**，否则加载时抛 `loaded skill "annals" source must be a string` |
| `ctx.systemPrompt.section()` | 注入常驻规矩，`order: 150` | 不依赖技能加载；每轮都在系统提示里 |
| `ctx.tools.register()` | 注册 `annals_init` / `annals_query` / `annals_links` | 描述文字是「装门」的一半 —— 模型只在读到它时才知道有这个工具 |
| `ctx.fs.*` | 读写文件、判存在 | 直调时**必须传沙箱策略**，否则退回 `workspace-write` + 进程 cwd |
| `ctx.shell.resolve()/execute()` | 跑 `git init` | 同样必须传会话策略 |
| `ctx.workingDirectory.get(session)` | 拿工作区根 | 拿不到时抛错，所有调用点都包了 try |

宿主事件：

| 事件 | 什么时候 | 用来做什么 |
|---|---|---|
| `agent/created` | 新会话建立 | 判定工作区状态，`undecided` 时注入一次询问引导 |
| `session/event` → `turn/start` | 每轮开始 | 拍轮首快照（今天日志的 mtime / 整个工作区的文件戳） |
| `session/event` → `tool/call` | 工具**执行前** | 收点名路径、补判工作区状态、判断这轮改了没 |
| `agent/turn-stopping` | 轮次即将收尾 | 判「该提醒吗」，是则 `agent.steer()` 插一条消息 |
| `session/disposed` | 会话销毁 | 清掉该会话的逐会话状态 |

### 为什么 `agent.steer()` 能当场生效

官方契约：turns 即将关闭时 `steer` 必定再跑一步。所以模型收到提醒后还有机会当场补写，不用等下一轮。

代价是提醒**不出现在 GUI 对话流里** —— 它是注入给模型的 user 侧消息，不是对话气泡。想确认它发生过，看会话记录里 `source.kind === "annals"` 的消息。

---

## 状态机：三态

状态存在 `<工作区>\.dsh\log-system.json`，判定逻辑在 `lib/index.js:508` 的 `classifyWorkspace`：

```js
const state = await readStateFile(ctx, cwd);
if (state?.state === 'declined') return 'declined';
if (state?.state === 'enabled') {
  return (await pathExists(ctx, cwd, `${LOG_DIR}/${INDEX_SCRIPT}`)) ? 'enabled' : 'undecided';
}
return (await pathExists(ctx, cwd, `${LOG_DIR}/${INDEX_SCRIPT}`)) ? 'enabled' : 'undecided';
```

| 返回值 | 条件 | 行为 |
|---|---|---|
| `'declined'` | 状态文件说拒绝 | 完全静默：不询问、不提醒、不探测 |
| `'enabled'` | 状态文件说启用 **且** `日志\build-index.mjs` 在 | 正常提醒 |
| `'enabled'` | **没有**状态文件，但生成器在（兼容老工作区） | 正常提醒，不重复询问 |
| `'undecided'` | 其它 | `agent/created` 时注入询问引导 |

**注意 `'enabled'` 的那道 `&&`**：状态文件说启用但生成器被删了，会退回 `'undecided'` 重新询问 —— 否则插件会一直催一个永远跑不起来的生成器。

### 逐会话状态

`apply()` 里有一个 `states = new Map()`，键是 **Session 对象本身**（同一会话内对象稳定）。`session/disposed` 时清掉，防内存泄漏。

单会话状态里最要紧的几个：

| 字段 | 含义 | 为什么存在 |
|---|---|---|
| `logDate` | 轮首那天的日期 | **跨日长轮次**必须以轮首为准，否则 23:59 开轮、00:01 收尾会去比对「明天」那个还不存在的文件 |
| `logStamp` | 轮首时今天日志的 `{mtimeMs, size}` | 判「这轮写没写日志」的客观依据 |
| `workspaceStamp` | 轮首时整个工作区的文件戳快照 | 判「这轮改没改文件」 |
| `pathStamps` | 命令串里点名过的路径 → 轮首戳 | **跨 `tool/call` 累积**，到轮尾才整体比对 |
| `logDirty` | 写过日志但索引没跑 | **粘性标记**：索引停在旧快照是持续状态，只在写的那个 turn 检查会漏 |
| `reminded` / `remindedIndex` | 已提醒过的轮次号 | 每轮每类提醒最多一次 |

`turn/start` 时如果发现 `state.workspace === undefined`（会话恢复、插件热重载后继续旧会话），会补判一次状态 —— 但**只判状态、不注入引导**，引导只在 `agent/created` 时问一次。

---

## 提醒引擎：四条证据的并集

这是整个插件最复杂的部分。它要回答两个问题：**这轮改了文件吗？这轮写日志了吗？**

### 为什么不用命令串猜

早期版本靠正则匹配 `pwsh` 命令里有没有 `Set-Content`、`rm `、`>` 之类。这条路会持续误报：

- `echo "==== form 枚举定义 ===="` 里的 `form ` 字面包含 `rm `
- `2>&1` 里有 `>`
- here-string 正文里出现的指令词
- 只碰 `D:\Temp` 的命令

每修一个就要加一条正则，而新的写法（`[System.IO.File]::WriteAllText`、`node -e "..."`）永远漏得掉。所以后来改成**拍快照比差异**。

### 四条证据

| 证据 | 看得见什么 | 盲区 |
|---|---|---|
| **日志 mtime**（`snapshotLogStamp` + `logChangedSince`） | 今天那个日志文件这轮变没变 | 只有今天这一个文件；同秒可能漏 |
| **工作区快照**（`snapshotWorkspaceStamp` + `workspaceChangedSince`） | 工作区内**一切**改动，含 shell 写的；一次同时覆盖改动/新建/删除 | 看不见工作区外；超过 `SCAN_FILE_LIMIT = 20000` 个文件就放弃 |
| **官方变更清单**（`officialChanges`，来自 `dsh-workspace-changes`） | 文件工具改的**工作区外**文件 | 非 git 工作区里 shell 写的一律看不见 |
| **点名路径**（`collectShellPaths` + `pathStamps`） | 命令串里出现过的绝对路径改没改 | 命令里没写路径的写法（`python gen.py`）完全不知 |

**取并集，不是谁优先**。任一条说「改了」就是改了；都不说没改才盖过关键词误报。

> 0.1.3 及以前是「快照拿到就全信快照」，导致改动落在工作区外（桌面）时快照判 false、官方明明看见了也轮不到 —— 该提醒的从不提醒。见 issue #1。

### 点名路径只投赞成票

```js
const byPathsVote = byPaths === true;
let changed;
if (byWorkspace !== undefined || official !== undefined || byPathsVote) {
  changed = byWorkspace === true || byPathsVote || (official !== undefined && official.total > 0);
  ...
} else {
  changed = state.changed;   // 三条客观证据全拿不到，退回关键词
}
```

`byPaths === false` 被**直接丢掉**。它说 false 只意味着「我盯的那几处没动」，而它压根没盯过的地方太多 —— `python gen.py` 里写着删库它也不知道。拿它否决别的证据，等于把「我没查」当成「没发生」。

### 快照要跳过什么

| 跳过的 | 为什么 |
|---|---|
| `.git` | `git status` / `git add` 本身会重写 `.git\index`，不跳会把自己扫成「改过」 |
| `.dsh\log-system.json`、`.dsh\annals-probe.jsonl` | **插件自己写的**。不跳就是自指误报：调一次 `annals_query` 追加一行探测记录，轮尾快照判「改过」，当场催写日志 —— 查得越多被催得越勤，正好打在本工具要治的病上 |

只跳过这两个文件，**不整个跳过 `.dsh\`** —— 用户或模型可能在 `.dsh\skills\` 里干正事。

### `SKIP_RE`：用户说「不用记」

```js
const SKIP_RE =
  /不[用要]记|不记(?!得|录)|不记录(?!一下)|不[用要]?[写记碰动]日志|别[记写碰动](?!不)|无需记录|不需要记录|跳过日志|免记/;
```

两处负向断言是踩出来的：

- `不记(?!得|录)` —— 挡「不记得」，否则「我不记得那个了」会被当成不让记
- `别[记写碰动](?!不)` —— 挡「动不动」，否则「别动不动就改我代码」会被当成不让碰日志

取向是**宁可漏压也不误压**：漏压只多提醒一次，误压是该提醒时不提醒。

已知认不出的：`别记录这个错误，改用记忆里的方案` —— 局部否定会被当成整轮。这是正则表达力的上限，不是 bug。

### 提醒优先级

写日志那条优先于索引那条，因为索引检查本来就要求日志先存在。同一轮里两条互斥。

索引提醒有**粘性**：`logDirty` 置真后留到索引被确认新鲜为止，不是当轮催完就断。

---

## 检索算法

全在 `lib/query.js`，纯函数、不碰 `ctx`、可单测。

### 一次检索的流程

```
查询串 → tokenize → buildIdf → 阶段一（只扫标题）
                                    ↓ 标题命中 < TITLE_HIT_ENOUGH(3)
                                 阶段二（全文）
                                    ↓
                          scoreEntry 打分 → 过滤 → 取片段
```

### `tokenize`：空格分词 + 中文 bigram

```js
for (const part of raw.split(/[\s,，、;；|]+/)) {
  out.add(part);                                    // 整段原样留一份（精确短语）
  for (const seg of part.match(/[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+/g)) {
    if (中文段 && seg.length > 1) for (i…) out.add(seg.slice(i, i+2));  // bigram
  }
}
```

**为什么要拆中英混排**：`非git` 整体当一个词时，中文只剩单字「非」，而「非」几乎每条都有，等于凭空塞进一个万能词。拆成 `非` + `git` 后，`git` 才是那个真正有区分度的词。

**为什么要 bigram**：中文没有词边界，「重启插件」不切就搜不到「重启」。切成 `重启 / 启插 / 插件` 后能命中，代价是产生「启插」这种无意义片段 —— 但它们几乎不会单独出现在日志里。

**单字只在整段就一个字时才留**（搜「坑」这种），不作为 bigram 的副产品。

### `scoreEntry`：四层加权 + 封顶

| 层 | 权重 | 封顶 |
|---|---|---|
| 标题 | `W_TITLE = 0.3` | `CAP_TITLE = 0.6` |
| 正文 | `W_BODY = 0.1` | `CAP_BODY = 0.3` |
| 子项 | `W_ITEM = 0.06` | `CAP_ITEM = 0.2` |
| 围栏 | `W_FENCE = 0.02` | `CAP_FENCE = 0.1` |

每层是「命中词条的 idf 之和 × 权重」，**同层封顶** —— 否则一个词在正文里重复十次就把分数刷满了。

命中方式是 `includes` 布尔判定，**不管出现几次都只算一次**。所以它**不是 BM25**，别按 BM25 的参数去调。

`idf = log(1 + 总条数 / 出现条数) / log(1 + 总条数)`，落在 0..1，越大越稀有。

> **全库 0 出现的词给 0，不是给 1。** 这条是必须的：bigram 会切出「启插」这类永远不命中的片段，若它们按「最稀有」拿满分，覆盖率分母被撑大一倍，真实命中会被压到过不了阈值。

### 覆盖率：分母是查询串的字符数

```js
const COVERAGE_FLOOR = 0.05;
const coverageMultiplier = (coverage) => COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * coverage * coverage;
```

**分母踩过两次坑，根因是同一个**：

1. 一开始分母是「所有词条的 idf 之和」。搜「重启插件」切出 `重启插件/重启/启插/插件`，其中「启插」全库几乎不出现、idf 逼近 1.0，一个词占了 40% 分母；真正有意义的「重启」(0.27) + 「插件」(0.20) 加起来才 0.47，覆盖率被压到 0.19 —— 明明有 24 条标题含这些词，检索返回 0 条。
2. 改成「查询本身字符数」后仍有陷阱：给第 14 条日志写了「重启插件」四个字，这个短语在库里出现 1 次，idf 从 0 跳到满值 1.0 —— **库里多写一条记录，检索反而坏掉了**。

现在的算法：`覆盖率 = 被命中的查询字符数 / 查询总字符数`。无意义的 bigram 不命中就只是不贡献覆盖率，不会凭空撑大分母；库里多写一条含该短语的日志，也不会再把检索搞坏。

**用「标记字符位置取并集」而不是「命中词数 / 总词数」**：bigram 之间是重叠的（`重启 / 启插 / 插件` 覆盖的其实是同一段字），按词数算会把重叠部分重复计数。

**平方折算而不是线性**：搜「机器学习模型训练」时切出「机器」「模型」两个通用词，字符覆盖率 0.5，线性折算还剩 0.57 —— 足够越过 `ABS_FLOOR` 混进来；平方后只剩 0.29，整批落到下限以下。

**残留盲区**：一条查询如果由若干常见 bigram **拼满**（「完全不存在的东西」→ 完全/全不/不存/存在/在的/东西，恰好每条都能在某条日志里找到），字符覆盖率会算到 1.0，平方也压不下去。字符级 bigram 没有词典，分不清「存在」是词还是「不存在的」里的一段 —— 这是这类实现的固有代价。工具输出里「这里搜不到不代表从未做过」那句就是给这种情况兜底的。

### 两道阈值

| 常量 | 值 | 作用 |
|---|---|---|
| `ABS_FLOOR` | `0.1` | **绝对**下限。低于它直接判没命中 |
| `REL_FLOOR` | `0.25` | **相对**下限：低于最高分这个比例的丢掉 |

光有相对阈值不够：搜一个全库都没有的词时所有条目分数都极低，`REL_FLOOR` 会让「矮子里的高个」照样通过（实测搜「完全不存在的词xyz」返回 3 条全无关条目，靠 bigram 里的「存在」蹭上的）。

光有绝对阈值也不够：只在一个子项里蹭到一次「插件」的条目会以 0.06 分挤进结果，把真正相关的几条淹掉。

### 两阶段检索与它的结构性问题

```js
if (titleHits.length >= TITLE_HIT_ENOUGH) {   // 3
  // 只返回标题命中
}
// 否则才扫全文
```

**为什么两阶段**：日志标题是人工浓缩过的（187 条标题合计约 7,600 字符，全库正文 25 万字符），先扫标题能省掉绝大部分正文扫描。

**代价**：短语加成 `PHRASE_BONUS = 0.5` 虽然是最强信号，但它在**打分阶段**才产出，而两阶段检索先扫标题、标题命中够 3 条就不进正文 —— 标题里一个词都不含的条目拿不到这个加成。

**另一条反噬**：日志正文抄了查询原文会改写下一次查询里每个 token 的 idf，把失败记录自身顶成第一名。

### 片段取用

`SNIPPET_AHEAD = 90` / `SNIPPET_BEHIND = 150`，合计约 240 字符。

围绕**出现位置最靠后（最稀有）**的命中词开窗，不是第一个 —— 常见词（「日志」「文件」）开出来的窗口多半是全篇通用的话，低频词附近才有辨识度。

### `normalizeUserText`

剥掉「你好/帮我看看/我想问一下/谢谢」这类没有区分度的前缀。

**为什么必须做**：覆盖率的分母是查询串的字符数，这些寒暄一个都不可能出现在日志里，却实打实把分母撑大。实测（195 条库）：3 个原本返回 0 条的查询被救回来。

实现细节：中文候选项**必须按长度倒序拼接正则**。`/g` 是位置驱动的，若「我想问」排在「我想问一下」前面，「我想问一下检索…」会在位置 0 被吃掉，留下「一下，检索…」这半截残渣。

---

## 双向链接

全在 `lib/links.js`。

### `annals_query` 与 `annals_links` 的分工

| | 按什么找 | 用在什么时候 |
|---|---|---|
| `annals_query` | **内容** —— 忘了一件事在哪 | 做一件「感觉做过」的事之前 |
| `annals_links` | **关系** —— 知道是哪一条 | 改文件前想知道以前哪些条目碰过它 |

两者不重叠，选错的代价是拿到一堆不相干的结果。

### `target` 的三种写法

```
annals_links({ target: "日志\2026-10-23.md" })              // 整个文件
annals_links({ target: "日志\2026-10-23.md 第 10 条" })      // 只这一条
annals_links({ target: "tools\check-refs.mjs" })            // 任意工作区文件，必须写全路径
```

裸日期（`2026-10-23.md`）自动补成 `日志\` 前缀 —— 这个形态在工作区里唯一，猜错概率为零。其他文件必须写全路径：全库有四个 `说明.md`，只报文件名等于让工具替你猜。

### 出链的识别：反引号 + 扩展名白名单

每处引用必须写成**反引号包裹的路径**：`` `tools\check-refs.mjs` `` 算引用，裸写的路径不算。

**为什么靠扩展名白名单而不是「有没有反斜杠」**：实测 5115 处剥完非空的反引号内容里，只有 1292 处带扩展名 —— 其余全是 `git status`（命令）、`wroteLog`（标识符）、`#待办`（标签）、`现象：`（小标题）。靠反斜杠分不开，靠扩展名一步到位。

```js
const EXT = /\.(jsonl|json|md|mjs|cjs|js|ts|ps1|psm1|cmd|bat|txt|ya?ml|toml|py|html|css|svg|png|jpe?g|zip|7z|exe|log|sh)$/i;
```

长的必须排在短的前面，否则 `xyz.jsonl` 会先匹配到 `.json` 并把 `l` 留在外面。

**占位符不算引用**：`YYYY`、`XXXX`、`<工作区>`、`C:\...\lib\index.js` 这类（实测 16 处）指向不了任何确定文件。

### 三条设计取舍

1. **入链只扫日志**。引用来源固定是 `日志\*.md`，不遍历其他文档 —— 日志是**只增不改**的，而工作区文档会变；让一个会变的集合当引用来源，反查结果会随时间漂移。
2. **出链只认反引号里的路径**。理由见上。
3. **日志之间互相引用也要写「第 N 条」**。只写文件名，条目级入链永远查不到它 —— 工具会把「全库还有多少处只写了文件名」打在末尾提醒你。

### 排序与不猜

- **出链里日志排在普通文件前面** —— 日志引用是「还能继续往下追」的活链接，文件引用到此为止。
- **入链里精确写了条目号的排前面**，范围引用（`第 38–56 条`）次之，只写文件名的最后。
- **裸名不猜**。引用里只写 `说明.md` 而全库有四个同名时，标出「指向不明」并列候选，**不计入命中数** —— 宁可少算一处，也不悄悄把四个文件的引用混在一起（那个 bug 曾让一个查询的数量从 20 条悄悄变成 33 条，且不报错）。
- **裸名不猜上限 `SUSPECT_SHOW_MAX = 8`**。只在**没有正经命中**时才逐条列疑似条目，最多 8 条；有正经命中时只报总数。防的是把真正的 1 条淹在 14 条历史裸引用里。

### 路径归一化

```js
export function normalizePath(p) {
  s = s.replace(/\//g, '\\').replace(/\\+$/, '').replace(/^\.\\/, '');
}
```

**不统一抹掉 `..\`** —— 日志里写 `..\` 是有信息量的（指向工作区外），抹掉反而会把它错误归到工作区内的同名文件上。

`asLogPath` 只认本工作区的日志文件（`日志\YYYY-MM-DD.md`、`YYYY-MM-DD.md`、`.\日志\...`），**不认** `D:\其他工作区\日志\2026-10-21.md` —— 那是别的工作区的同名文件，归过来会让入链凭空多几条。

---

## 初始化

`initWorkspace` 在 `lib/index.js:558`，**幂等、不覆盖**：

```js
await ensureFile(ctx, cwd, `${LOG_DIR}/.gitattributes`, GITATTRIBUTES_SOURCE, created, kept, policy);
await ensureFile(ctx, cwd, `${LOG_DIR}/${INDEX_SCRIPT}`, BUILD_INDEX_SOURCE, created, kept, policy);
await ensureFile(ctx, cwd, `${LOG_DIR}/log-parse.mjs`, LOG_PARSE_SOURCE, created, kept, policy);
await ensureFile(ctx, cwd, `${LOG_DIR}/${today}.md`, `# ${today}\n`, created, kept, policy);
// git init（已存在 .git 就跳过）
await writeStateFile(ctx, cwd, 'enabled', policy);
```

`ensureFile` 先 `ctx.fs.stat`，存在就塞进 `kept` 跳过，**绝不覆盖用户数据**。

### 三份资产是**复制**不是引用

`assets/build-index.mjs`、`log-parse.mjs`、`gitattributes` 在初始化时被**原样复制**进用户工作区。这是刻意的：生成器必须在用户工作区里独立运行（`node 日志\build-index.mjs`），不依赖插件是否还装着。

代价：插件升级后，已初始化的工作区里那份生成器**不会自动更新**。要拿新版得手动覆盖 `日志\build-index.mjs`。

### 生成器怎么认工作区

`build-index.mjs` 用**脚本自身位置**当锚点，不依赖 `_文档架构.md` 之类的锚点文件：

- 认 `<工作区>\日志\build-index.mjs`（也兼容放在工作区根）
- 被挪到别处会明确报错退出，不会把索引写到某个碰巧有 `日志\` 的目录

实际判据是「自己所在目录」或「自己的 `日志\` 子目录」里有 `.md` 文件。若把脚本复制到一个同时也有 `日志\` 子目录的无关路径下，它会把那里当成独立工作区正常生成 —— 语义上合法（子目录确实可以是另一个工作区），所以只加了一条「祖先目录下也有 `日志\`」的 WARN，不阻断。

### 沙箱策略必须透传

`git init` 走 `runShell`，`ensureFile` 走 `ctx.fs.writeText` —— 两者都显式传会话的 `sandboxPolicy`。

**省略会出什么事**：`ctx.shell.resolve` 不传策略时，`dsh-pwsh-sandbox` 会退回默认 `workspace-write` 并尝试 ACL 沙箱；`ctx.fs.writeText` 省略时后端退到 `workspace-write` + **进程 cwd** —— 于是在「打开的其他目录工作区」里初始化会被拒。

`resolveWorkspacePolicy` 取的是 `ctx.get('sandboxPolicy').resolve({ session })`，服务缺失时返回 `undefined`（退回默认）。

---

## 配置系统

### 九个字段与 `.volatile()`

```js
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  // … 共九个
});
```

**为什么全带 `.volatile()`**：`dsh-settings` 的表单投影只收 volatile 字段（`volatileForm`，`dsh-settings\lib\index.js:122-131`），普通字段不会出现在 `settings.describe()` 的命名空间里 —— 那样 GUI 页就拿不到它们。

**代价**：Loader 校验后的配置值不是 boolean，而是 cosmokit 的**运行时引用对象**（`{ get(), [cosmokit.volatile.write] }`，`cosmokit\lib\index.js:102-110`）。所以插件内部必须统一用 `readFlag()` 解包：

```js
export function readFlag(config, field) {
  const raw = config?.[field];
  if (raw === undefined) return true;
  const value = raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
  return value !== false;      // 缺省 true，只有显式 false 才算关
}
```

**不能直接读 `config.字段`** —— 那拿到的是对象，永远真值。

### GUI 只渲染 6 个

`queryTool` / `linksTool` / `probe` 不在 `client/client.js` 的 `FIELDS` 数组里，只能改 `cordis.patch.yml`。

三个字段里有两个是后加的（0.4.0 的双链、0.4.0 的漏查探测），第三个 `probe` 是调试用的观测开关 —— 保持 YAML-only 是有意的：GUI 上摆太多开关，用户会以为每个都该调。

### GUI 的写路径

`api.mutate(state.row.ns, ops, state.row.revision)`：

- 改**回默认值**时发 `{ op: 'unset', path: [field] }`，不是 `set: true` —— 这样 patch 里不会留下冗余项
- 成功回 `response.ok === true`
- 冲突回 `settings-conflict` 并重载

### 插件页不渲染配置表单

「插件」→ dsh-annals 那张卡片只显示包信息与运行状态。这是 DSH 的既有行为：配置表单由功能包自己注册设置页。

---

## 测试策略

五套测试，全部离线，不需要 DSH 宿主。`pnpm test` 一条命令跑完，合计 **264 项**（262 pass / 2 skip）。

| 文件 | 用例数 | 覆盖 |
|---|---|---|
| `test/offline.mjs` | **103**（另 2 个 skip） | 见下 |
| `test/build-index.test.mjs` | **77** | 生成器端到端（真实临时目录 + 真实子进程） |
| `test/links.test.mjs` | **75** | 双向链接（纯函数 + 临时工作区夹具） |
| `test/version.test.mjs` | **6** | 版本号一致性与打包清单（见下） |
| `test/e2e-sandbox.test.mjs` | **1** | 包装 `e2e-sandbox.mjs`：真实磁盘初始化全流程 |

`pnpm test` 的 `scripts.test` 是**显式列出五个文件**，不是 glob。原因有两个：`offline.mjs` 不带 `.test` 后缀，`test/*.test.mjs` 匹配不到它，那 103 个用例会**静默地一条都不跑**；而 `node --test` 无参数时的默认发现规则又会把 `test/` 下所有 `.mjs` 都当测试文件执行，包括 `e2e-sandbox.mjs` —— 它是个独立脚本，被直接执行时目标目录是 `%TEMP%\annals-e2e-<pid>` 且不自删，每跑一次留一个垃圾目录。两个坑都只在「换个跑法」时才暴露，所以这里写死文件名。

### version.test.mjs：为什么需要它

仓库没有 CI。`version` 这个数字同时存在于三处字面量里 —— `package.json:3`、`README.md:7` 的横幅、`README.md:45` 那条安装命令里的 `dsh-annals-X.Y.Z.tgz`。升版本时漏改任何一处**都不会报错**：

- README 横幅留着旧版本号 → 读者以为自己在装旧版
- 安装命令里的 tgz 名对不上 → 用户照着抄一个不存在的文件名

同理 `files` 白名单：列了不存在的文件，打包静默缺内容；漏列新文档，从 tgz 安装的人点 README 里的链接会 404。这两类都属于「沉默地错」，最该用测试钉住。

六条断言：版本形状合法 / README 横幅与 `package.json` 一致 / 安装命令里的 tgz 名一致 / `files` 每一项真实存在 / `files` 覆盖三个对外文档 / 白名单里的 `.md` 不是空文件。

这三条版本相关断言都做过反向验证：分别把 README 横幅改回 `0.4.0`、把 tgz 名改回 `0.4.0`、从 `files` 里删掉 `ARCHITECTURE.md`，每次都**精确命中对应的那一条**并给出说明性报错，而不是笼统失败。永远通过的测试等于没写。

`offline.mjs` 的分节（对应文件中带横线的小标题）：

- **脚手架**：临时工作区 + mock 服务
- **纯函数**：`localDate`、`parseArgs`、`contentText`、路径归一化
- **工作区状态**：三态判定、老工作区兼容
- **注册**：技能 / 规矩 / 工具注册形态、Config schema 形状
- **引导注入**：`undecided` 时注入、已启用时不注入
- **提醒**：触发与跳过、「不用记」豁免话术（`SKIP_RE` 的 24 条正反样本）
- **索引新鲜度提醒**：不存在 / 陈旧 / 已最新 / 开关关闭
- **工具**：`annals_init` 两个分支、`annals_query` 检索入口
- **检索质量**：真机踩出来的回归
- **shell 命令判定**：误报回归（`rm ` 子串、`2>&1`、here-string、临时目录豁免、上限截断）
- **漏查探测**：只记，不打扰
- **自指误报**：插件自己写的状态文件不能算「工作区改过」

`build-index.test.mjs` 覆盖：代码围栏屏蔽（含未闭合）、编号写法不规范（全角数字/顿号/缺空格）的 FAIL、编号重复/倒序/跳号的文案、BOM 剥离、日期不存在、非 UTF-8 WARN、同名目录与只读文件的友好报错、概览加粗变体、行尾 `\r\r\n` 收敛、幂等，以及 A/B 两种脚本位置。

---

## 日志格式的机械定义在哪

**在 `日志\build-index.mjs`，不在这份文档里**。

它是执行者：跑一遍就知道对不对，不用在文档里抄一遍正则。`log-parse.mjs` 里那些正则是唯一真源：

```js
export const DATE_TITLE = /^\s*#\s+(\d{4}-\d{2}-\d{2})\s*$/;
export const ENTRY = /^(\d+)\.\s+(?:\[[a-z][a-z0-9-]*=[^\]]*\]\s*)*\*\*(.+?)\*\*\s*$/;
export const TIER_A_MAX = 600;
export const TIER_B_MAX = 1500;
export const BLANK_OK = new Set(['date→entry', 'entry→body', 'body→item', 'body→entry', 'item→entry']);
```

`BLANK_OK` 那五个就是「空行只允许在这 5 处」的机器可读版本 —— **既查「只允许」也查「必须有」**，两件事都查。

写作规矩本身在 `assets/annals.md`（技能正文）里，运行时注册成 `annals` 技能。
