/**
 * dsh-worklog · 日志系统插件（Host 半）
 *
 * 解决什么问题：
 * 日志系统由三件事组成 —— 技能（怎么写）、规矩（一直记得写）、提醒（别忘了写）。
 * 技能会被模型遗漏加载，规矩会随上下文漂移，提醒会因插件没装而消失。
 * 这个插件把三件事装进一个包，并补上第四件：一次初始化。
 *
 * 四件事：
 * 1. 注册 `worklog` 技能 —— 正文来自包内 `assets/worklog.md`
 * 2. 常驻 systemPrompt section —— 不依赖技能加载的日志规矩
 * 3. 轮次收尾提醒 —— 改了文件但没写今天日志时 `agent.steer()` 推一条
 * 4. `worklog_init` 工具 —— 用户同意后一次建好 日志\、生成器、git、状态文件
 *
 * 初始化策略（三态）：
 * - 未决定：`agent/created` 时注入一条提示，让模型问用户一次
 * - 已启用：静默，正常提醒
 * - 已拒绝：完全静默，零副作用（记录在 `<工作区>\.dsh\log-system.json`）
 *
 * 为什么零依赖：
 * 第三方 link 插件解析不到 `@deepseek-ai/*`（本机 profile 的 node_modules/@deepseek-ai
 * 只有 cosmokit + schemastery），`createUserMessage` 只有三行，这里复刻即可。
 *
 * 为什么提醒逻辑与 `dsh-auto-memory` 同构：
 * turn-stopping 是官方契约里「模型不再欠响应时 steer 会让它必再跑一步」的通道，
 * `tool/call` 判定不依赖插件加载顺序。照抄等于继承已实测过的行为。
 */

import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, sep, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
// 检索逻辑（切词、打分、片段）全在 query.js —— 纯函数，不碰 ctx，能单测。
import { loadLogs, search as searchLogs, render as renderHits, termFrequency, genericTermHint, normalizeUserText, DEFAULT_LIMIT, MAX_LIMIT } from './query.js';
// 双向链接（出链提取 / 入链反查 / 渲染）全在 links.js —— 同样纯函数，不碰 ctx。
import { indexLinks, resolveTarget, findInLinks, renderOut, renderOutFile, renderIn, tallyBareLogRefs } from './links.js';
// 唯一的运行时依赖，只用于配置 schema。DSH 的 Loader 按 Standard Schema 校验插件配置
// （`resolveConfig()` 读 `Config["~standard"]`，见 cordis/lib/index.js:956-958）。
import z from '@deepseek-ai/schemastery';

/** 插件名（cordis id 由 patch 决定，这里是模块自报的名字）。 */
export const name = 'worklog';

/**
 * 需要的服务。少了任何一个，apply 不会被调用 —— 这是 cordis 的依赖契约。
 * 全部是标准 DSH 组合自带的：dsh-skill / dsh-system-prompt / dsh-tools /
 * dsh-fs / dsh-shell / dsh-working-directory。
 */
export const inject = ['skills', 'systemPrompt', 'tools', 'fs', 'shell', 'workingDirectory'];

/**
 * 插件配置。导出它之后，Loader 通过 `Config["~standard"].validate()` 校验并填默认值
 * （`cordis\lib\index.js:956-958`）；`apply(ctx, config)` 按同一组字段名开关功能，
 * 全部默认 true，即零配置时行为不变。
 *
 * 每个字段都带 `.volatile()`：GUI 设置表单（`dsh-settings`）只投影 volatile 字段，
 * 普通字段不会出现在 `settings.describe()` 的命名空间里。代价是 Loader 校验后的值
 * 是运行时引用对象，不是 boolean —— 用 `readFlag()` 解包，不要直接读 `config.x`。
 */
export const Config = z.object({
  enabled: z
    .boolean()
    .default(true)
    .description('总开关：关掉后不注册技能、规矩、工具和提醒（已有日志数据不受影响）')
    .volatile(),
  skill: z.boolean().default(true).description('注册 worklog 技能').volatile(),
  section: z.boolean().default(true).description('向系统提示注入日志规矩（不依赖技能加载）').volatile(),
  reminder: z.boolean().default(true).description('轮次收尾提醒：改了文件但没写今天日志时提醒一次').volatile(),
  initTool: z.boolean().default(true).description('注册 worklog_init 工具（启用/拒绝日志系统）').volatile(),
  queryTool: z.boolean().default(true).description('注册 worklog_query 工具（检索历史日志）').volatile(),
  linksTool: z.boolean().default(true).description('注册 worklog_links 工具（日志条目的双向链接：这条引用了谁 / 谁引用了它）').volatile(),
  probe: z.boolean().default(true).description('漏查探测：只记到 .dsh\\worklog-probe.jsonl，不注入、不打扰').volatile(),
  skipSubagents: z.boolean().default(true).description('子代理会话不提醒、不初始化').volatile(),
});

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 技能名。与工作区 `.dsh\skills\worklog` 同名时，项目源 rank 100 覆盖运行时 rank 250 —— 用户可改。 */
const SKILL_NAME = 'worklog';

/** 技能描述（会出现在 available_skills 目录里，≤500 字符）。 */
const SKILL_DESCRIPTION =
  '当用户要求记日志、写日志、记录一下、把本次记录写入日志、或当你要往 `日志\\YYYY-MM-DD.md` 写今天的日志、判断某件事该不该记进日志、决定这条记多详细、或问"这个要不要写进日志""日志怎么记"时使用；**也用于查历史 —— 用户问「以前是怎么弄的」「这个是不是做过」「上次那个怎么解决的」，或你要动手做一件「感觉做过」的事之前先确认有没有现成结论**。含该写/不该写的清单、六种行封闭定义（日期标题/空行/条目/正文段/子项/围栏）、A/B/C 三档详略、生成器 FAIL+WARN 规则表、正文四条硬要求（含否定面四类、引用兑现）、写完的自检与提交步骤、查历史的入口与判据。不含封卷、不含待办 —— 这两个机制已被取消。';

const LOG_DIR = '日志';
const INDEX_SCRIPT = 'build-index.mjs';
const INDEX_FILE = '_日志索引.md';
const STATE_FILE = '.dsh/log-system.json';
const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

// ============================================================================
// 包内资源（读不到就让插件加载失败，而不是带着空技能静默跑）
// ============================================================================

/**
 * @param {string} name - `assets/` 下的文件名。
 * @returns {string} 文件全文。
 */
function readAsset(name) {
  const file = join(PKG_ROOT, 'assets', name);
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new Error(`dsh-worklog: 读不到资源 ${file}（${String(error)}）`);
  }
}

// trimStart：assets/worklog.md 是「SKILL.md 去掉 frontmatter」的产物，首行会留一个空行 ——
// 技能正文不该以空行开头（dsh-worklog 的旧正文同样处理过这个细节）。
const WORKLOG_BODY = readAsset('worklog.md').trimStart();
const BUILD_INDEX_SOURCE = readAsset('build-index.mjs');
// 生成器 import 了同目录的 log-parse.mjs（词法定义单一份），两个必须一起落地 ——
// 只写 build-index.mjs 会 ERR_MODULE_NOT_FOUND，而且是在用户第一次跑的时候才炸。
const LOG_PARSE_SOURCE = readAsset('log-parse.mjs');
const GITATTRIBUTES_SOURCE = readAsset('gitattributes');

// ============================================================================
// 提示与注入文本
// ============================================================================

/** 未决定时注入给模型的引导。模型据此问用户一次并调用 worklog_init。 */
const BOOTSTRAP_TEXT = [
  '本工作区还没有启用日志系统。',
  '',
  '请先向用户确认一次，用 ask_user_question：',
  '「要不要在本工作区启用日志系统？它会建 日志\\ 目录、索引生成器和一个独立的 git 仓库，我每次干完活会把事情记进去。」',
  '',
  '用户同意 → 调用 worklog_init 工具，参数 enabled=true，它会一次建好全部文件。',
  '用户拒绝 → 调用 worklog_init 工具，参数 enabled=false，之后本工作区不再提这件事。',
  '',
  '这条提示由 dsh-worklog 插件发出。',
].join('\n');

const BOOTSTRAP_SUMMARY = '本工作区未启用日志系统，请询问用户一次';

/** 常驻系统提示里的日志规矩（精简版；细节在 worklog 技能里）。 */
const SECTION_TEXT = [
  '## 日志系统',
  '',
  '本工作区可能启用了日志系统，判据是存在 `日志\\build-index.mjs`。若已启用，遵循：',
  '',
  '- **动手前先查**：要做一件「感觉做过」的事（写脚本、跑实验、推导结论），先用 `worklog_query` 查一句。',
  '  查得到就省一次重做，查不到也只是多花一次调用 —— 日志标题是人工浓缩过的，比你自己 grep 快。',
  '- **先判断该不该写**：调 `skill` 工具加载 `worklog`，按它的正反清单判断。纯查询、中间产物、别处已有归宿的不写；拿不准问用户。',
  '- **该写就当天写，不攒着**：一天一个文件 `日志\\YYYY-MM-DD.md`，第一行 `# YYYY-MM-DD`。',
  '- 每条三行：`N. [time=HH:MM:SS][tier=B] **标题**`（标题必须加粗，否则索引查不到；`[time=]` 必填 —— 写之前先跑一次 `Get-Date -Format \'HH:mm:ss\'`，同一批写同一个值）/ 空行 / `W 空格 + 正文：…`，`W` = 编号位数 + 2（`1. ` 用 3 空格，`10. ` 用 4 空格）；之后才是 `-` 子项。编号当天从 1 连续。',
  '- **先定档再动笔**：这条按 A（正文+子项 ≤600 字符）/ B（601–1500）/ C（>1500）哪一档写，说出口；没说就是 B。同时把档位写进条目行 `[tier=A/B/C]` —— 写完生成器会算一遍，声明与实测不一致直接 FAIL：要么删字，要么显式改字段升档（升档要理由）。档位砍篇幅不砍密度，C 档必须写明细节在哪份文档。',
  '- 正文给具体路径/命令/标识符，给证据，写否定面（不是这个原因／这个没做或没验证／别这么做／我原以为 X 实际是 Y，占一即可）。引用别的条目或文档前先确认它真的存在。',
  '- 写完跑 `node 日志\\build-index.mjs`：它先修能修的（缩进、空行、行尾，只动空白），再报修不了的 FAIL。报告里有「已自动修复 N 处」时，提交前先 `git diff -w --ignore-blank-lines -- 日志\\` 核一遍，输出为空才说明只动了空白。然后 `cd 日志; git add -A; git commit -m "docs: YYYY-MM-DD …"`。commit 标题必须带前缀：只动日志/文档用 `docs:`，改代码用 `fix:`/`feat:`。',
  '- 不回头改旧条目（要更正就新开一条），不手改 `_日志索引.md`，不写概览行。',
  '- 用户说过「不用记/不需要记录」时，本会话不写。',
].join('\n');

/** 轮次收尾提醒（照抄 dsh-auto-memory 的文案骨架，只改插件名）。 */
const REMINDER_TEXT = [
  '本轮你改动过工作区文件，但还没有写今天的日志。',
  '',
  '请现在处理，不要跳过：',
  '1. 加载 `worklog` 技能，按它判断这次改动该不该记录。',
  '2. 该记就写进 `日志\\` 下今天的日期文件，然后运行 `node 日志\\build-index.mjs` 并 `git commit`。',
  '3. 不该记（例如只生成了中间产物、或只是只读查询）就用一句话说明理由，不要硬写。',
  '',
  '这条提醒由 `dsh-worklog` 插件发出，每个轮次最多一次。',
].join('\n');

const REMINDER_SUMMARY = '本轮改过文件但未写今日日志';

/**
 * 索引新鲜度提醒。
 * 「写了日志但没跑生成器」是插件原本的盲区：`wroteLog` 一置真就视为完成，
 * 索引停在旧快照、commit 里也没有 `_日志索引.md`，而没有任何人会报错。
 * 判据只看 mtime，不需要读懂日志内容。
 */
const INDEX_REMINDER_TEXT = [
  '今天份的日志已经改过了，但 `_日志索引.md` 还没更新。',
  '',
  '现在补上，不要跳过：',
  '1. 运行 `node 日志\\build-index.mjs`（FAIL 必须修）。',
  '2. `cd 日志; git add -A; git commit -m "..."`。',
  '',
  '这条提醒由 `dsh-worklog` 插件发出，每个轮次最多一次。',
].join('\n');

const INDEX_REMINDER_SUMMARY = '日志已更新但索引没更新';

const DECLINE_ACK_TEXT = [
  '✓ 已记录：本工作区不启用日志系统。',
  '',
  '之后不会再主动提这件事。如果用户以后想启用，调用 worklog_init(enabled=true) 即可。',
].join('\n');

/** 工具描述。模型据此决定何时调用。 */
const INIT_TOOL_DESCRIPTION = [
  '本工作区日志系统的初始化开关，只在用户明确答复后调用。',
  'enabled=true：一次建好 日志\\ 目录、.gitattributes、build-index.mjs、log-parse.mjs、今天的日志文件，并执行 git init；',
  'enabled=false：只写拒绝记录，之后本工作区不再询问日志系统的事。',
  '已存在的文件不会被覆盖。',
].join('\n');

/**
 * 检索工具的描述。这段文字是「装门」的一半 —— 模型只在读到它时才知道有门。
 *
 * 写法上刻意做了三件事：
 * 1. **先说什么时候该用，再说它做什么**。工具描述的第一句决定模型会不会在
 *    「这件事好像做过」的瞬间想起它；只写「检索日志」等于要求模型自己先想到要查。
 * 2. **明说比 grep 强在哪**。不然模型会想「我自己 grep 就行」，而 grep 只能给
 *    匹配行、给不了「这条当时为什么这么定」。
 * 3. **明说不该用它做什么**。日志不是文档库，问「X 怎么配置」该去读文档。
 */
const QUERY_TOOL_DESCRIPTION = [
  '在本工作区的 `日志\\` 里检索过去做过的事。',
  '',
  '**什么时候该用**：动手之前，先确认这件事以前是不是做过、踩过什么坑、当时为什么这么定。',
  '典型的触发场景 —— 要写一个「感觉写过」的脚本、要重跑一个「好像跑过」的实验、',
  '要重新推导一个「应该有结论」的判断、用户问「以前是怎么弄的」。',
  '花一次调用确认，比重新做一遍便宜得多。',
  '',
  '**比 grep 强在哪**：日志标题是人工浓缩过的（187 条标题合计约 7,600 字符，全库正文 25 万字符），',
  '这个工具先扫标题、只在标题不够时才下钻正文，并且按稀有度加权 —— 搜「插件」这种满库都有的词',
  '不会把结果淹掉。返回的是**条目标题 + 锚点 + 片段**，不是匹配行。',
  '',
  '**不该用它做什么**：问「某个配置项怎么写」「某个 API 什么签名」该去读文档和源码，不是查日志。',
  '日志记的是「这次为什么这么做」，不是「系统怎么用」。',
].join('\n');

/**
 * `worklog_links` 的工具描述。
 *
 * 与 `worklog_query` 的分工是这里最要紧的一句话：query 是**按内容找**（我忘了是哪天、
 * 哪一条），links 是**按关系找**（我知道是哪一条，想知道它牵到谁）。
 * 两者不重叠，模型选错的代价是拿到一堆不相干的结果。
 *
 * 为什么把「写引用时要带第 N 条」写进工具描述：工具描述和技能正文是两条送达路径，
 * 而改旧日志、写新日志的当下未必加载了技能。这句话是那条规矩唯一的常驻兑现点。
 */
const LINKS_TOOL_DESCRIPTION = [
  '查本工作区日志条目的双向链接：**这条引用了谁**（出链）／**谁引用了它**（入链）。',
  '',
  '**什么时候该用**：已经知道是哪条日志、想知道它的来龙去脉时。',
  '典型场景 —— 改某个文件之前想看看「以前有哪些条目碰过它、当时怎么说的」；',
  '读到一个结论想追「它是从哪来的」（这条出链指向哪些文档/日志）；',
  '要动一条旧日志，先确认有没有别处指着它。',
  '',
  '**和 `worklog_query` 的分工**：query 是**按内容找**（忘了哪条，用关键词捞）；',
  'links 是**按关系找**（知道是哪条文件/条目，看它连着谁）。先用 query 定位，再用 links 展开。',
  '',
  '**`target` 的三种写法**：',
  '- `日志\\2026-10-23.md` —— 整个文件（文件级的链）',
  '- `日志\\2026-10-23.md 第 10 条` —— 只这一条（条目级的链）',
  '- `tools\\check-refs.mjs` —— 任意工作区文件，**必须写全路径**；只有日志文件可以只写日期',
  '',
  '**入链只扫日志**：来源固定是 `日志\\*.md` 的正文，非日志文档里的引用查不到 ——',
  '查不到不等于没人引过，别据一次空结果下结论。',
  '',
  '**出链只认反引号里的路径**：正文里写成 `` `tools\\check-refs.mjs` `` 才算引用，',
  '裸写的路径、Markdown 链接都不算。所以日志之间互相引用时，**要写 `日志\\YYYY-MM-DD.md` 第 N 条**，',
  '只写文件名的话「第 N 条」那一层的入链就永远查不到。',
  '',
  '**范围写法也算条目级**：`` `日志\\2026-10-22.md` 第 38–56 条 `` 被当成一条区域引用，',
  '查区间内任何一条都能命中，结果里会标明「按范围引用」。指一整段时用它，不要逐个列 19 个条目号。',
].join('\n');

// ============================================================================
// 消息构造（复刻 createUserMessage，避免 import @deepseek-ai/dsh-llm）
// ============================================================================

/**
 * 深冻结 —— 复刻 `createMessage` 的要求：消息发布前必须冻结，防止下游改动。
 * @param {any} value - 任意对象图。
 * @returns {any} 同一个对象，已就地冻结。
 */
export function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

/**
 * 构造一条 user 消息。
 * `form: 'notice'` 表示「一件刚发生的事，不取代任何东西」，需要一行摘要（≤120 字符）。
 * @param {string} text - 模型可见正文。
 * @param {string} summary - 折叠状态下的一行说明。
 * @returns {object} 冻结的 user 消息。
 */
export function makeUserMessage(text, summary) {
  return deepFreeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: SKILL_NAME, form: 'notice', summary },
  });
}

/**
 * `tool/call` 的 `arguments` 是模型原样产出的 JSON 字符串，可能不合法。
 * @param {unknown} raw - 原始参数字符串。
 * @returns {Record<string, any>} 解析结果，失败时给空对象。
 */
export function parseArgs(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * 从消息的 content 块里拼出纯文本。
 * @param {unknown} content - 消息 content 数组。
 * @returns {string} 所有 text 块拼接结果。
 */
export function contentText(content) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string' && block.text.length > 0)
    .map((block) => block.text)
    .join('\n');
}

/**
 * 本地时区的 YYYY-MM-DD（日志按用户所在时区分天，不是 UTC）。
 * @param {Date} [now] - 测试用固定时间。
 * @returns {string} 日期字符串。
 */
export function localDate(now = new Date()) {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ============================================================================
// 工作区状态：读、写、判定
// ============================================================================

/**
 * 记一条埋点到 `<工作区>\.dsh\worklog-probe.jsonl`。
 *
 * 为什么要埋点：这次加的是「装门」（给模型一个查历史的入口），但门装上了不等于
 * 有人推。两周后要判断这扇门值不值得留，只能靠数据 —— 而「模型有没有调用」这件事
 * 模型自己说不准（事后自述都是编的），只有工具执行时记下来才算数。
 *
 * 埋点什么：只记「调了没、查了什么词、返回几条」。**不记内容、不记结果** ——
 * 这个文件是为了回答「门有没有人推」，不是为了攒语料。
 *
 * 失败一律吞掉：埋点是附加物，坏了不能影响检索本身。
 *
 * @param {any} ctx - 宿主上下文。
 * @param {string} cwd - 工作区根。
 * @param {object} record - 要记的内容。
 */
export function recordProbe(ctx, cwd, record) {
  try {
    const dir = join(cwd, '.dsh');
    mkdirSync(dir, { recursive: true });
    const line = `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`;
    appendFileSync(join(dir, 'worklog-probe.jsonl'), line, 'utf8');
  } catch (error) {
    ctx?.logger?.debug?.(`worklog: 埋点写入失败（忽略）：${String(error)}`);
  }
}

/**
 * 记一条「对照埋点」：同一轮里模型自己编的查询 vs 用户原话，各查到什么。
 *
 * 要回答的问题只有一个：**换输入源到底有没有收益**。单看任何一边都不算数 ——
 * 模型词查得准可能只是运气，原话查得准也可能只是词更长。真正有信息量的是
 * `agree`：两边 top1 是不是同一条。若一直是 true，换不换都到同一处，这个方向
 * 就该放弃；若模型词频频落空而原话能命中，才值得换。
 *
 * 为什么记到 `.dsh\worklog-probe.jsonl` 而不是日志里：日志正文会进检索库
 * （`loadLogs` 只读 `日志\`，而这个文件在 `.dsh\` 下），把查询原文抄进日志等于
 * 改写下一次回测里每个 token 的 idf —— 这正是 `2026-10-26` 那两条记录干过的事，
 * `要重启吗` 的 idf 被自己写下的日志从 0 抬到 0.8696，整轮回测作废。
 *
 * 失败一律吞掉：埋点是附加物，坏了不能影响检索本身。
 *
 * @param {any} ctx - 宿主上下文。
 * @param {string} cwd - 工作区根。
 * @param {{query: string, result: object, entries: object[], userText: string}} input
 *   模型查询、它的检索结果、全库条目、本轮用户原话。
 */
export function recordComparison(ctx, cwd, { query, result, entries, userText }) {
  try {
    const clean = normalizeUserText(userText);
    if (clean === '') return;
    // 原话和查询一模一样就没什么可对照的（模型直接照抄了用户的话）。
    if (clean.toLowerCase() === String(query ?? '').toLowerCase()) return;
    if (!Array.isArray(entries) || entries.length === 0) return;

    const userResult = searchLogs(entries, clean, DEFAULT_LIMIT);
    const keyOf = (hit) => (hit === undefined ? undefined : `${hit.date}#${hit.num}`);
    const queryTop = result.hits[0];
    const userTop = userResult.hits[0];
    const queryTopKey = keyOf(queryTop);
    const agree = queryTopKey !== undefined && queryTopKey === keyOf(userTop);
    // 模型词的 top1 在原话结果里排第几 —— 越小说明两边越接近。
    const rank = queryTopKey === undefined
      ? -1
      : userResult.hits.findIndex((h) => keyOf(h) === queryTopKey);

    recordProbe(ctx, cwd, {
      tool: 'probe-compare',
      query,
      queryHits: result.hits.length,
      // 只记定位与分数，不记标题 —— 标题里常含查询词，攒多了又是新的自指。
      queryTop: queryTop === undefined
        ? null
        : { date: queryTop.date, num: queryTop.num, score: Number(queryTop.score.toFixed(4)) },
      userText: clean,
      userHits: userResult.hits.length,
      userTop: userTop === undefined
        ? null
        : { date: userTop.date, num: userTop.num, score: Number(userTop.score.toFixed(4)) },
      agree,
      queryTopRankInUser: rank < 0 ? null : rank + 1,
    });
  } catch (error) {
    ctx?.logger?.debug?.(`worklog: 对照埋点写入失败（忽略）：${String(error)}`);
  }
}

/**
 * 读状态文件；不存在或损坏都返回 undefined（损坏不等于拒绝，仍会询问一次）。
 * @param {any} ctx - 宿主上下文。
 * @param {string} cwd - 工作区根。
 * @returns {Promise<{state?: string, at?: string} | undefined>} 解析后的状态对象。
 */
export async function readStateFile(ctx, cwd) {
  try {
    const target = await ctx.fs.resolve(STATE_FILE, { cwd });
    if ((await ctx.fs.stat(target)) === undefined) return undefined;
    const parsed = JSON.parse(await ctx.fs.readText(target));
    return parsed && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 解析当前会话的沙箱策略，供插件直调 `ctx.fs` 时使用。
 * 工具侧写入会带会话的 standing policy；插件直调 fs 时若省略策略，
 * 后端会用默认策略（workspace-write + 进程 cwd），在别的工作区写入会被拒。
 * @param {any} ctx - 宿主上下文。
 * @param {any} [session] - 会话句柄；省略时只解析默认策略。
 * @returns {object | undefined} `SandboxExecutionPolicy`；服务缺失时为 undefined。
 */
export function resolveWorkspacePolicy(ctx, session) {
  try {
    const service = typeof ctx.get === 'function' ? ctx.get('sandboxPolicy') : undefined;
    if (service === undefined || service === null || typeof service.resolve !== 'function') {
      return undefined;
    }
    return service.resolve({ ...(session ? { session } : {}) });
  } catch {
    return undefined;
  }
}

/**
 * 写状态文件（自动建 `.dsh\` 目录）。
 * @param {any} ctx - 宿主上下文。
 * @param {string} cwd - 工作区根。
 * @param {'enabled' | 'declined'} state - 三态里的两个决定态。
 * @param {object} [policy] - `SandboxExecutionPolicy`；省略则后端用默认策略。
 * @returns {Promise<object>} 写下去的负载。
 */
export async function writeStateFile(ctx, cwd, state, policy) {
  const target = await ctx.fs.resolve(STATE_FILE, { cwd });
  const payload = { version: 1, state, at: new Date().toISOString(), workspace: cwd };
  await ctx.fs.writeText(target, JSON.stringify(payload, null, 2) + '\n', undefined, undefined, policy);
  return payload;
}

/**
 * @param {any} ctx - 宿主上下文。
 * @param {string} cwd - 工作区根。
 * @param {string} relPath - 相对工作区的路径。
 * @returns {Promise<boolean>} 是否存在。
 */
export async function pathExists(ctx, cwd, relPath) {
  try {
    const target = await ctx.fs.resolve(relPath, { cwd });
    return (await ctx.fs.stat(target)) !== undefined;
  } catch {
    return false;
  }
}

/**
 * 判定一个工作区的日志系统状态。
 * - `declined`：状态文件说拒绝 → 静默
 * - `enabled`：状态文件说启用且生成器在，或没有状态文件但生成器在（兼容老工作区）
 * - `undecided`：其它 → 询问一次
 * @param {any} ctx - 宿主上下文。
 * @param {string} cwd - 工作区根。
 * @returns {Promise<'declined' | 'enabled' | 'undecided'>} 状态。
 */
export async function classifyWorkspace(ctx, cwd) {
  const state = await readStateFile(ctx, cwd);
  if (state?.state === 'declined') return 'declined';
  if (state?.state === 'enabled') {
    return (await pathExists(ctx, cwd, `${LOG_DIR}/${INDEX_SCRIPT}`)) ? 'enabled' : 'undecided';
  }
  return (await pathExists(ctx, cwd, `${LOG_DIR}/${INDEX_SCRIPT}`)) ? 'enabled' : 'undecided';
}

/**
 * 写文件，但已存在就跳过（初始化绝不覆盖用户数据）。
 * @param {any} ctx - 宿主上下文。
 * @param {string} cwd - 工作区根。
 * @param {string} relPath - 相对工作区的路径。
 * @param {string} content - 要写入的内容。
 * @param {string[]} created - 新建清单（原地追加）。
 * @param {string[]} kept - 跳过清单（原地追加）。
 * @param {object} [policy] - `SandboxExecutionPolicy`；省略则后端用默认策略。
 */
export async function ensureFile(ctx, cwd, relPath, content, created, kept, policy) {
  const target = await ctx.fs.resolve(relPath, { cwd });
  if ((await ctx.fs.stat(target)) !== undefined) {
    kept.push(relPath);
    return;
  }
  await ctx.fs.writeText(target, content, undefined, undefined, policy);
  created.push(relPath);
}

/**
 * 跑一条 shell 命令，返回合并后的结果。
 * @param {any} ctx - 宿主上下文。
 * @param {string} command - 命令（跨平台用简单命令）。
 * @param {string} workdir - 工作目录（绝对路径）。
 * @param {object} [policy] - `SandboxExecutionPolicy`；省略则执行器用默认策略。
 * @returns {Promise<any>} `ShellRunResult`。
 */
export async function runShell(ctx, command, workdir, policy) {
  const spec = ctx.shell.resolve({ command, workdir, sandboxPolicy: policy });
  const execution = await ctx.shell.execute(spec);
  return execution.result();
}

/**
 * 初始化一个工作区的日志系统（幂等，不覆盖）。
 * @param {any} ctx - 宿主上下文。
 * @param {string} cwd - 工作区根。
 * @param {any} [session] - 会话句柄，用于解析沙箱策略（工具侧传入）。
 * @returns {Promise<{report: string, created: string[], kept: string[]}>} 结果报告。
 */
export async function initWorkspace(ctx, cwd, session) {
  const created = [];
  const kept = [];
  const today = localDate();
  const policy = resolveWorkspacePolicy(ctx, session);

  await ensureFile(ctx, cwd, `${LOG_DIR}/.gitattributes`, GITATTRIBUTES_SOURCE, created, kept, policy);
  await ensureFile(ctx, cwd, `${LOG_DIR}/${INDEX_SCRIPT}`, BUILD_INDEX_SOURCE, created, kept, policy);
  await ensureFile(ctx, cwd, `${LOG_DIR}/log-parse.mjs`, LOG_PARSE_SOURCE, created, kept, policy);
  await ensureFile(ctx, cwd, `${LOG_DIR}/${today}.md`, `# ${today}\n`, created, kept, policy);

  if (await pathExists(ctx, cwd, `${LOG_DIR}/.git`)) {
    kept.push(`${LOG_DIR}/.git`);
  } else {
    const logDirAbs = ctx.fs.processPath(await ctx.fs.resolve(LOG_DIR, { cwd }));
    const result = await runShell(ctx, 'git init', logDirAbs, policy);
    if (result.exitCode !== 0) {
      const stderr = result.stderr?.text?.trim() ?? '';
      throw new Error(`git init 失败（exit ${result.exitCode ?? 'null'}）：${stderr || '(无输出)'}`);
    }
    created.push(`${LOG_DIR}/.git`);
  }

  await writeStateFile(ctx, cwd, 'enabled', policy);
  created.push(STATE_FILE);

  const lines = ['✓ 日志系统已在本工作区启用。'];
  if (created.length > 0) lines.push(`  新建：${created.join('、')}`);
  if (kept.length > 0) lines.push(`  已存在跳过：${kept.join('、')}`);
  lines.push('', '下一步：干完活后按 worklog 技能写 `日志\\YYYY-MM-DD.md`，再跑 `node 日志\\build-index.mjs` 并 `git commit`。');
  return { report: lines.join('\n'), created, kept };
}

/**
 * 判断「日志比索引新」—— 捕捉「写了日志但没跑生成器」。
 *
 * 只看文件修改时间，不读内容：生成器每次运行都会重写 `_日志索引.md`，
 * 所以「索引 mtime < 日志 mtime」就意味着生成器没跑过（或跑在写入之前）。
 * 索引文件不存在同理。
 *
 * 已知盲区：两者落在同一时间戳精度内时 `<` 不成立，会漏报一次。NTFS 精度到
 * 100ns，实际几乎撞不上；改成 `<=` 反而会把「刚跑完生成器、没改日志」误判成陈旧。
 *
 * @param {string} cwd - 工作区根（真实绝对路径，不是 FsTarget）。
 * @param {string} date - 当天日期 `YYYY-MM-DD`。
 * @returns {boolean} true = 索引需要重新生成。
 */
export function isIndexStale(cwd, date) {
  let logMtime;
  try {
    logMtime = statSync(join(cwd, LOG_DIR, `${date}.md`)).mtimeMs;
  } catch {
    // 今天的日志文件还不存在：不属于「写过日志」的情况，交给写日志那条提醒。
    return false;
  }
  try {
    return statSync(join(cwd, INDEX_FILE)).mtimeMs < logMtime;
  } catch {
    // 索引还不存在 —— 说明一次都没跑过生成器。
    return true;
  }
}

/**
 * 读今天日志文件的时间戳快照，用于判断「这一轮有没有动过日志」。
 *
 * 为什么不用命令串猜：写日志的写法太多（`Set-Content`、`[System.IO.File]::WriteAllText`、
 * `>>` 重定向、JS 的 `appendFileSync`），且路径在不同引号/转义层级下形态各异
 * （`日志\x.md` 与 `日志\\x.md`）—— 关键词与正则永远漏。文件系统时间戳是唯一
 * 「真的写了才变」的客观信号，读文件不会改它。
 *
 * 与 `isIndexStale` 的区别：那个比的是「日志 vs 索引」谁新，这个比的是
 * 「轮首 vs 轮尾」同一个文件变没变。后者能抓住「写了又还原」（mtime 变了、
 * 内容一样）这种关键词方案靠运气才抓到的情况。
 *
 * @param {string} cwd - 工作区根（真实绝对路径）。
 * @param {string} date - 日期 `YYYY-MM-DD`。
 * @returns {{mtimeMs: number, size: number} | null} 文件不存在或读不到时 null。
 */
export function snapshotLogStamp(cwd, date) {
  try {
    const stat = statSync(join(cwd, LOG_DIR, `${date}.md`));
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return null;
  }
}

/**
 * 比对轮首与轮尾的日志文件快照。
 *
 * @param {{mtimeMs: number, size: number} | null | undefined} before - 轮首快照。
 *   `undefined` 表示轮首没取到（拿不到 cwd / 工作区未定），此时无法判定。
 * @param {{mtimeMs: number, size: number} | null} after - 轮尾快照。
 * @returns {boolean | undefined} true=动过，false=没动，undefined=无法判定。
 */
export function logChangedSince(before, after) {
  if (before === undefined) return undefined;
  // 一侧存在、一侧不存在 —— 创建或删除，都算动过。
  if (before === null || after === null) return before !== after;
  return before.mtimeMs !== after.mtimeMs || before.size !== after.size;
}

/**
 * 这个路径在不在工作区里面。
 *
 * 文件工具的 `file_path` 是**结构化参数**：一个干净的、带盘符的绝对路径
 * （全会话实测 70/70 都是绝对路径），可以直接判。命令行那条不行 ——
 * `command` 是一整串文本，路径与语法混在一起，还可能 `cd` 过，
 * 所以那边不用这个函数，改用整区快照比对。
 *
 * 语义细节：
 * - `cwd` 拿不到 → 返回 true（当成在里面）。判不了就别拦，宁可多报。
 * - 相对路径按 `cwd` 解析后判断。
 * - `..` 逃出工作区 → false。判据是 `relative()` 结果以 `..` 开头
 *   （`.foo` 这种以点开头的目录名不会被误伤，因为比的是 `..` + 分隔符）。
 * - 跨盘符 → false（`relative()` 会原样返回绝对路径）。
 * - Windows 大小写差异由 `path.relative` 自己处理（`D:\X` vs `D:\x` 视为同一层）。
 *
 * @param {string} cwd - 工作区根。
 * @param {string} target - 待判路径，绝对或相对。
 * @returns {boolean} 是否落在工作区内。
 */
export function isInsideWorkspace(cwd, target) {
  if (typeof cwd !== 'string' || cwd.length === 0) return true;
  if (typeof target !== 'string' || target.length === 0) return true;
  let rel;
  try {
    const absolute = isAbsolute(target) ? target : join(cwd, target);
    rel = relative(cwd, absolute);
  } catch {
    return true;
  }
  if (rel.length === 0) return true;
  if (isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * 整目录跳过：**只为 `.git` 一个**。
 *
 * 这不是性能取舍，是判据正确性 —— `git status` / `git add` 会重写
 * `.git\index`（实测：把已跟踪文件的 mtime 推后 1 秒、内容一字不动，
 * `git status --porcelain` 仍返回空，但 `.git\index` 的 mtime 被改写了）。
 * 不跳过它，插件自己或模型跑的任何 git 命令都会被算成「改了工作区」。
 *
 * `node_modules` 等重目录**不在这里**：用户明确说先不管，等有人反映再加。
 */
const SCAN_SKIP_DIRS = new Set(['.git']);

/**
 * 插件**自己写**的状态文件（工作区相对路径，正斜杠），整区快照要跳过。
 *
 * 与 `.git` 同一个道理，只是方向反过来：`git` 是外部工具顺手改的，
 * 这两个是插件自己每轮可能改的。不跳过就会出现**自指误报** ——
 * 实测 2026-10-25 18:46：调一次 `worklog_query` 会往
 * `.dsh\worklog-probe.jsonl` 追加一行，轮尾快照因此判「工作区改过」，
 * 于是当场催「你改过文件但还没写今天的日志」。而那一轮只做了一次只读检索，
 * 什么都没改。
 *
 * 危害不只是多一条提醒：它把「用这个工具」和「被催写日志」绑在了一起 ——
 * 查得越多，被催得越勤。这正好打在本工具要治的病上（检索意愿本来就低）。
 *
 * 只列这两个文件，**不整个跳过 `.dsh\`** —— 用户或模型可能在
 * `.dsh\skills\` 等子目录里干正事，那些改动该照常算数。
 */
const OWN_STATE_FILES = new Set([STATE_FILE, '.dsh/worklog-probe.jsonl']);

/** 扫描上限：超过就放弃整区快照，退回关键词判定。防超大目录白烧时间。 */
const SCAN_FILE_LIMIT = 20000;

/**
 * 给工作区拍一张「文件绝对路径 → 时间戳+大小」的快照。
 *
 * 为什么用整区快照而不是猜命令：命令串是文本，路径与语法混在一起
 * （`cd X; rm a.txt`、`Copy-Item A B`、`node -e "...writeFileSync"`），
 * 永远猜不全。而「这一轮工作区到底变没变」有客观答案 —— 拍两次快照对比即可，
 * 且一次性同时抓住**改动 / 新建 / 删除**三种情况。
 *
 * 不跟随符号链接（`Dirent.isDirectory()` 对链接返回 false），避免环。
 * 读不到的子目录跳过，不让一个权限错误毁掉整次快照。
 *
 * @param {string} cwd - 工作区根。
 * @returns {Map<string, string> | undefined} 快照；拿不到或超限时 undefined。
 */
export function snapshotWorkspaceStamp(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return undefined;
  const out = new Map();

  /** @returns {boolean} false 表示超限，中止整次扫描。 */
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(entry.name)) continue;
        if (walk(join(dir, entry.name)) === false) return false;
        continue;
      }
      if (!entry.isFile()) continue;
      const full = join(dir, entry.name);
      // 插件自己的状态文件不算工作区改动 —— 否则「调一次工具」就制造一次误报。
      if (OWN_STATE_FILES.has(relative(cwd, full).split(sep).join('/'))) continue;
      try {
        const stat = statSync(full);
        out.set(full, `${stat.mtimeMs}:${stat.size}`);
      } catch {
        continue;
      }
      if (out.size > SCAN_FILE_LIMIT) return false;
    }
    return true;
  };

  if (walk(cwd) === false) return undefined;
  return out;
}

/**
 * 比对轮首与轮尾的工作区快照。
 *
 * 一次循环同时覆盖三种变化：改过（戳不同）、新建（`before` 里没有）、
 * 删除（`before` 有、`after` 里 `get()` 得到 undefined，同样不等）。
 *
 * @param {Map<string, string> | undefined} before - 轮首快照。
 * @param {Map<string, string> | undefined} after - 轮尾快照。
 * @returns {boolean | undefined} true=有变化，false=一字未动，undefined=无法判定。
 */
export function workspaceChangedSince(before, after) {
  if (before === undefined || after === undefined) return undefined;
  for (const [path, stamp] of after) {
    if (before.get(path) !== stamp) return true;
  }
  for (const path of before.keys()) {
    if (!after.has(path)) return true;
  }
  return false;
}

/**
 * 一条命令里最多盯几个路径。
 *
 * 防的是 `find C:\ -name x` 这种把整台机器写进命令串的极端形态：
 * 不设上限就变成一次批量 stat，等于把「几乎零成本」变成「一次全盘扫描」。
 * 32 是拍的 —— 正常命令（拷几个文件、写一两个产物）远到不了。
 */
const PATH_STAMP_LIMIT = 32;

/** `homedir()` 的小写、去尾斜杠形态；模块级算一次，路径比对用。 */
const HOME_DIR_LOWER = homedir().toLowerCase().replace(/[\\/]+$/, '');

/**
 * 宿主自己在**持续写**的目录（小写路径片段）。
 *
 * 为什么要排除：`byPaths` 的语义是「这条命令点到的路径，轮内变没变」。
 * 它默认「变了 = 是我干的」，这对交付物成立，对宿主自己的状态文件不成立 ——
 * `<家目录>\.dsh\sessions\<会话>\session.v4.jsonl.zstd` 是 DSH **每步都在追加写**的，
 * 只要某一轮的命令里出现过这个路径（哪怕是解压它出来做取证），该轮就必然被判「改过文件」。
 * 不是概率事件，是确定性触发：实测 turn 13 / turn 15 两次误报都是它。
 *
 * 排除只在这一个收集出口做，不动 `looksLikeShellWrite()` 的门控，
 * 也不动 `pathStampsChangedSince()` 的投票语义 —— 那两条是 `f1d99d1` 立的契约
 *（「只投赞成票，永不投否决票」「同一路径只在首次出现时拍基准」），改它们会把
 * 「关键词认不出、但命令里点了名的真写」重新放回盲区（实测 4192 条命令里有 2083 条靠它）。
 */
const HOST_VOLATILE_SEGMENTS = [
  '\\.dsh\\sessions',
  '\\.dsh\\logs',
  '\\.dsh\\storages',
  '\\.dsh\\attachments',
];

/**
 * 这条路径是不是落在宿主自己持续写的目录里（含目录本身）。
 *
 * 目录本身也要算：`.dsh\sessions` 这一层在会话增删时 mtime 会跳，
 * 盯它同样归不了因 —— 实测 `session-clean` 删过一条会话，
 * 那一刻父目录 mtime 就变了。
 *
 * @param {string} lowerPath - 已小写、已去尾部斜杠的绝对路径。
 * @returns {boolean}
 */
function isHostVolatilePath(lowerPath) {
  return HOST_VOLATILE_SEGMENTS.some(
    (segment) => lowerPath.endsWith(segment) || lowerPath.includes(`${segment}\\`),
  );
}

/**
 * 这个目标是不是宽到没有信息量 —— 盯它等于盯住一切，变了也说不清是不是自己动的。
 * @param {string} lowerPath - 已转小写、已去尾部斜杠的绝对路径。
 * @returns {boolean}
 */
function isTooBroadTarget(lowerPath) {
  // 盘符根（`C:` / `C:\`）在调用处已被挡掉，这里兜住不带反斜杠的写法。
  if (/^[a-z]:$/.test(lowerPath)) return true;
  // 家目录本身：整台机器上绝大多数会话文件都在它下面。
  if (lowerPath === HOME_DIR_LOWER) return true;
  // 家目录下的 `.dsh` 根：DSH 的全部运行期状态都在这一层之下。
  return lowerPath === `${HOME_DIR_LOWER}\\.dsh`;
}

/**
 * 从 shell 命令里挑出「值得盯的具体路径」。
 *
 * 为什么需要它：`looksLikeShellWrite()` 是在猜命令**长得像不像写**，
 * 猜不出的命令（`node -e "...writeFileSync('D:\x')"`）一律漏掉。
 * 而命令里点名的绝对路径是**确定的事实** —— 拿它去 stat 就有了第二路证据。
 *
 * 只认绝对路径有三个理由：
 * - 相对路径要靠 cwd 解析，而 cwd 在工作区里 —— 那种情况 `snapshotWorkspaceStamp` 已经管了
 * - 相对路径会命中大量误伤（`node a.js` 里的 `a.js` 不是要写的文件）
 * - 工作区外的东西只能靠绝对路径指名，这是唯一入口
 *
 * 剥临时路径的规则与 `onlyTouchesTemp()` 共用：写临时文件本来就不算改工作区，
 * 盯它只会白 stat 一遍。
 *
 * @param {string} command - 完整命令行。
 * @returns {string[]} 去重后的绝对路径；没有则空数组。
 */
export function collectShellPaths(command) {
  if (typeof command !== 'string' || command.length === 0) return [];
  // here-string 的正文是**数据**不是命令：里面的路径是要写进文件的字面量，不是操作数。
  // 与 onlyTouchesTemp 同一条理由（turn 20 十条误判的主因）。
  const executable = stripHereString(command);
  const stripped = executable.replace(TEMP_SEGMENT_RE, ' ');
  const matches = stripped.match(ABS_PATH_RE);
  if (matches === null) return [];

  const out = [];
  const seen = new Set();
  for (const raw of matches) {
    // 尾巴上可能粘着命令分隔符或逗号（`D:\a.txt;`），那不是路径的一部分。
    const path = raw.replace(/[,;]+$/, '');
    // 盘符根（`C:\`）不是能 stat 的具体目标，盯它等于盯整块盘 —— 直接丢。
    if (/^[A-Za-z]:\\?$/.test(path)) continue;
    // Windows 路径不区分大小写，同一文件换个大小写不该记两份。
    const key = path.toLowerCase();
    // 宿主自己在持续写的目录、宽到没有信息量的目录：变了也归不了因，盯它只会制造误报。
    // 判据落在小写形态上，下面去重也用同一个 key。
    if (isHostVolatilePath(key) || isTooBroadTarget(key.replace(/\\+$/, ''))) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
    if (out.length >= PATH_STAMP_LIMIT) break;
  }
  return out;
}

/**
 * 给一组具体路径拍「时间戳 + 大小」基准。
 *
 * 只做单层 `stat`，**不递归** —— 这与 `snapshotWorkspaceStamp()` 的整区遍历
 * 不是一个量级：几十个路径各一次 stat 在毫秒级，扫几千个文件是几十到几百毫秒。
 * 「不扫描、只点名核对」正是这条路能补工作区外盲区的前提。
 *
 * 不存在的路径记成 `'absent'` 而不是跳过 —— 「本来没有、现在有了」是新建文件，
 * 恰恰最该算成改动。读不到（权限、路径非法）才跳过该条。
 *
 * @param {string[]} paths - 绝对路径列表。
 * @returns {Map<string, string> | undefined} 快照；没有有效路径时 undefined。
 */
export function snapshotPathStamps(paths) {
  if (!Array.isArray(paths) || paths.length === 0) return undefined;
  const out = new Map();
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) continue;
    try {
      const stat = statSync(path);
      out.set(path, `${stat.mtimeMs}:${stat.size}`);
    } catch {
      // ENOENT 等：现在没有，不代表一直不会有。
      out.set(path, 'absent');
    }
  }
  return out.size === 0 ? undefined : out;
}

/**
 * 比对同一组路径的两份快照。
 *
 * 语义与 `workspaceChangedSince()` 一致，只是范围收窄到点名的那些路径：
 * 戳不同（改）、新增路径（建）、消失路径（删）都算 true。
 *
 * 与工作区快照的关键差别在于**它说 false 意味着什么**：
 * 工作区快照说 false 是「整个工作区一件没动」，可以下结论；
 * 这里说 false 只是「我盯的那几处没动」，别处一概没看 ——
 * 所以调用方只能拿它投赞成票，不能用它否决别的证据。见 `agent/turn-stopping` 处。
 *
 * @param {Map<string, string> | undefined} before - 轮内首次记录时的基准。
 * @param {Map<string, string> | undefined} after - 轮尾重拍的快照。
 * @returns {boolean | undefined} true=有点名的路径变了，false=都没变，undefined=无法判定。
 */
export function pathStampsChangedSince(before, after) {
  if (before === undefined || after === undefined) return undefined;
  if (before.size === 0 || after.size === 0) return undefined;
  for (const [path, stamp] of after) {
    if (before.get(path) !== stamp) return true;
  }
  for (const path of before.keys()) {
    if (!after.has(path)) return true;
  }
  return false;
}

// ============================================================================
// 插件主体
// ============================================================================

/**
 * 读一个开关字段。
 *
 * 字段在 Config 里带 `.volatile()`：GUI 设置表单要它，但 Loader 校验后的值会是
 * cosmokit 的「运行时引用」对象（`{ get(), [cosmokit.volatile.write] }`），
 * 不是直接的 boolean（`cosmokit/lib/index.js:102-110`）。所以这里解包 `get()`。
 *
 * @param {Record<string, unknown> | undefined} config
 * @param {string} field
 * @returns {boolean} 缺省 true，只有显式 false 才算关。
 */
export function readFlag(config, field) {
  const raw = config?.[field];
  if (raw === undefined) return true;
  const value =
    raw !== null && typeof raw === 'object' && typeof raw.get === 'function' ? raw.get() : raw;
  return value !== false;
}

/**
 * @param {any} ctx - 宿主上下文。
 * @param {{enabled?: boolean, skill?: boolean, section?: boolean, reminder?: boolean, initTool?: boolean, queryTool?: boolean, linksTool?: boolean, probe?: boolean, skipSubagents?: boolean}} [config]
 *   插件配置。默认全开；任何一项都不影响其它项。
 */
export function apply(ctx, config = {}) {
  const enabled = readFlag(config, 'enabled');
  const wantSkill = readFlag(config, 'skill');
  const wantSection = readFlag(config, 'section');
  const wantReminder = readFlag(config, 'reminder');
  const wantInitTool = readFlag(config, 'initTool');
  const wantQueryTool = readFlag(config, 'queryTool');
  const wantLinksTool = readFlag(config, 'linksTool');
  const wantProbe = readFlag(config, 'probe');
  const skipSubagents = readFlag(config, 'skipSubagents');

  /**
   * 逐会话状态。键是 Session 对象本身（同一会话内对象稳定）。
   * workspace：agent/created 时判定一次；worklog_init 后更新。
   * logDirty：写过日志后的粘性标记，直到索引被确认为新鲜才清除 ——
   *   留到下个 turn 是有意的：索引停在旧快照是持续状态，只在写的那个 turn 检查会漏。
   * logStamp：本轮**轮首**时今天日志文件的时间戳快照（`undefined` = 没取到，
   *   此时退回关键词判定）。与 logDate 成对：跨日长轮次必须以轮首那天为准，
   *   否则 23:59 开轮、00:01 收尾会去比对「明天」那个还不存在的文件。
   * workspaceStamp：本轮**轮首**时整个工作区的文件戳快照（`.git` 除外）。
   *   轮尾再拍一张，两张一样就是一字未动 —— 这是「改没改文件」的客观判据。
   * pathStamps：命令串里点名的**工作区外**绝对路径在首次遇到时拍下的戳。
   *   workspaceStamp 只看得见工作区内，而交付物默认就落在工作区外
   *   （桌面、`D:\Temp`、别的仓库），那一片原来完全没有客观判据，
   *   只能靠 `looksLikeShellWrite()` 猜命令长得像不像写 —— 猜不出就漏。
   *   键是路径，值是 `${mtimeMs}:${size}` 或 `'absent'`。与 workspaceStamp 不同，
   *   它**跨 tool/call 累积**（每个新路径补一条），到轮尾才整体比对。
   * @type {Map<object, {turn: number, changed: boolean, wroteLog: boolean, logDirty: boolean, logStamp: ({mtimeMs: number, size: number} | null | undefined), logDate: string | undefined, workspaceStamp: (Map<string, string> | undefined), pathStamps: (Map<string, string> | undefined), userText: string, reminded: Set<number>, remindedIndex: Set<number>, workspace: string | undefined}>}
   */
  const states = new Map();

  /**
   * @param {object} session - 会话对象。
   * @returns {object} 该会话的状态记录（按需创建）。
   */
  function stateOf(session) {
    let state = states.get(session);
    if (state === undefined) {
      state = {
        turn: -1,
        changed: false,
        wroteLog: false,
        queried: false,
        writtenPaths: new Set(),
        logDirty: false,
        logStamp: undefined,
        logDate: undefined,
        workspaceStamp: undefined,
        pathStamps: undefined,
        userText: '',
        reminded: new Set(),
        remindedIndex: new Set(),
        workspace: undefined,
      };
      states.set(session, state);
    }
    return state;
  }

  // ---- 1. 技能注册 --------------------------------------------------------
  // enabled 是总开关：关掉它时下面三个功能一并关闭（GUI 文案承诺「不注册技能、规矩、工具」）。
  if (enabled && wantSkill) {
    ctx.effect(() => ctx.skills.register({
      name: SKILL_NAME,
      description: SKILL_DESCRIPTION,
      // source 是技能来源标识；不填则 skill 工具加载时（validateDefinition）报
      // `loaded skill "worklog" source must be a string`。
      source: 'dsh-worklog',
      content: WORKLOG_BODY,
    }));
  }

  // ---- 2. 常驻规矩 --------------------------------------------------------
  if (enabled && wantSection) {
    ctx.effect(() => ctx.systemPrompt.section({
      name: SKILL_NAME,
      // HARNESS_IDENTITY=-1000 / PERSONA_PREFIX=0 / TOOL_*=1000~3000 / HARNESS_SOURCE=10000
      order: 150,
      text: SECTION_TEXT,
    }));
  }

  // ---- 3. 初始化工具 ------------------------------------------------------
  if (enabled && wantInitTool) {
    ctx.effect(() => ctx.tools.register({
      name: 'worklog_init',
      description: INIT_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          enabled: {
            type: 'boolean',
            description: 'true = 启用（建目录/生成器/git/状态文件）；false = 拒绝（只写拒绝记录，之后不再询问）',
          },
        },
        required: ['enabled'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const session = exec?.agent?.session;
        if (session === undefined || session === null) {
          throw new Error('worklog_init 需要 live agent（无法确定工作区）');
        }
        let cwd;
        try {
          cwd = ctx.workingDirectory.get(session);
        } catch (error) {
          throw new Error(`worklog_init 拿不到工作区目录：${String(error)}`);
        }

        if (args?.enabled === true) {
          const { report } = await initWorkspace(ctx, cwd, session);
          stateOf(session).workspace = 'enabled';
          return report;
        }

        await writeStateFile(ctx, cwd, 'declined', resolveWorkspacePolicy(ctx, session));
        stateOf(session).workspace = 'declined';
        return DECLINE_ACK_TEXT;
      },
    }));
  }

  // ---- 3b. 检索工具 -------------------------------------------------------
  // 2026-10-25 加。动机：日志系统一直只有「写」的入口，没有「读」的入口 ——
  // 技能 description 的触发词全是「写」，常驻注入七行规矩也全是「写」，
  // 插件源码里 grep/检索/readLog 各 0 次。结果就是模型压根不知道有地方可查，
  // 于是一次次重新推导同一个结论（实测过三个案例，间隔 25–41 小时）。
  //
  // 这个工具只做一件事：把「这件事好像做过」变成一次调用就能确认。
  // 它不注入、不提醒、不改变任何既有行为 —— 门装上了，推不推是模型的事。
  if (enabled && wantQueryTool) {
    ctx.effect(() => ctx.tools.register({
      name: 'worklog_query',
      description: QUERY_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '要查的事。用你记得的关键词就行（中文会自动切 bigram，不用自己分词）；'
              + '多个词用空格分开表示「都要命中」。别写整句话。',
          },
          limit: {
            type: 'number',
            description: `最多返回几条（默认 ${DEFAULT_LIMIT}，上限 ${MAX_LIMIT}）。先用默认值看，不够再加。`,
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const session = exec?.agent?.session;
        if (session === undefined || session === null) {
          throw new Error('worklog_query 需要 live agent（无法确定工作区）');
        }
        let cwd;
        try {
          cwd = ctx.workingDirectory.get(session);
        } catch (error) {
          throw new Error(`worklog_query 拿不到工作区目录：${String(error)}`);
        }

        const rawLimit = Number(args?.limit);
        const limit = Number.isFinite(rawLimit) && rawLimit > 0
          ? Math.min(Math.floor(rawLimit), MAX_LIMIT)
          : DEFAULT_LIMIT;
        const query = String(args?.query ?? '').trim();
        if (query === '') return '查询是空的。给一个关键词再来。';

        const { entries, fileCount, charTotal } = loadLogs(join(cwd, LOG_DIR));
        const result = searchLogs(entries, query, limit);
        const body = renderHits(result, { query, limit, entries, fileCount, charTotal });

        // 词太泛时给一句提示 —— 附在结果后面，不占单独一次调用。
        const hint = genericTermHint(termFrequency(entries, query.split(/\s+/).filter(Boolean)), entries.length);
        const text = hint ? `${body}\n\n${hint}` : body;

        // 埋点：记下「查了」这件事，供两周后判断这扇门有没有人推。
        // 失败一律吞掉 —— 埋点坏了不能影响检索本身。
        try {
          recordProbe(ctx, cwd, { tool: 'worklog_query', query, hits: result.hits.length });
        } catch { /* 埋点是附加物，坏了不影响主流程 */ }

        // 埋点（对照）：同一轮里「模型自己编的查询」和「用户原话」各查到什么。
        //
        // 为什么要成对记：要回答「换输入源到底有没有收益」，单看任何一边都不算数 ——
        // 得知道两边指向的是不是同一条。若 `agree` 一直是 true，换不换都一样，
        // 这个方向就该放弃；若模型词经常查不到而原话查得到，才值得换。
        //
        // 为什么早先的记录作废：`2026-10-26` 那两条日志把回测用的查询原文抄进了正文，
        // 于是查询里每个 token 的 idf 都被自己写下的记录改变（`要重启吗` 的 idf 从
        // 0 被抬到 0.8696），回测结果随之失真。所以这一段**不记查询原文进日志**，
        // 只落在这个 jsonl 里；结论定了再一次性写完整日志。
        try {
          recordComparison(ctx, cwd, { query, result, entries, userText: stateOf(session).userText });
        } catch { /* 同上 */ }

        return text;
      },
    }));
  }

  // ---- 3c. 双向链接工具 ---------------------------------------------------
  // 2026-10-26 加。动机：日志里的引用一直是**单向**的 —— 一条日志写了「见
  // `日志\2026-10-22.md` 第 33 条」，可从那一条出发永远找不到这句话。于是「这个
  // 结论当初是怎么来的」「改这个文件前有没有人踩过」只能靠 query 猜关键词，猜不到就没有。
  //
  // 入链必须算，不能记：写的时候把「谁引用了它」也写进正文，就得在别人引用你的
  // 那一刻回头改你的旧条目 —— 与「写完不回头改」直接冲突。所以出链照写、入链现算。
  //
  // 与 query 的分工写在 LINKS_TOOL_DESCRIPTION 里：query 按内容找，links 按关系找。
  if (enabled && wantLinksTool) {
    ctx.effect(() => ctx.tools.register({
      name: 'worklog_links',
      description: LINKS_TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: '要查的目标。三种写法：`日志\\2026-10-23.md`（整个文件）、'
              + '`日志\\2026-10-23.md 第 10 条`（单条）、`tools\\check-refs.mjs`（任意工作区文件，必须全路径）。',
          },
          direction: {
            type: 'string',
            enum: ['both', 'in', 'out'],
            description: 'both（默认）= 两个方向都列；in = 只看「谁引用了它」；out = 只看「它引用了谁」。',
          },
        },
        required: ['target'],
        additionalProperties: false,
      },
      output: {
        schema: { type: 'string' },
        render: (_args, value) => [{ type: 'text', text: value }],
      },
      async execute(args, exec) {
        const session = exec?.agent?.session;
        if (session === undefined || session === null) {
          throw new Error('worklog_links 需要 live agent（无法确定工作区）');
        }
        let cwd;
        try {
          cwd = ctx.workingDirectory.get(session);
        } catch (error) {
          throw new Error(`worklog_links 拿不到工作区目录：${String(error)}`);
        }

        const rawTarget = String(args?.target ?? '').trim();
        const direction = ['both', 'in', 'out'].includes(args?.direction) ? args.direction : 'both';

        const index = indexLinks(join(cwd, LOG_DIR));
        const resolved = resolveTarget(rawTarget, index.dates);
        if (!resolved.ok) return resolved.message;

        const scope = { items: index.items.length, fileCount: index.fileCount };
        const blocks = [];
        const wantIn = direction === 'both' || direction === 'in';
        const wantOut = direction === 'both' || direction === 'out';

        // 入链：谁引用了 target。只算一次 —— 下面埋点还要用料，重算一遍纯属浪费。
        const inHits = wantIn ? findInLinks(index.items, resolved) : [];

        if (wantIn) blocks.push(renderIn(inHits, resolved, scope));

        // 出链：target 自己引用了谁。
        // 普通文件本身不在索引里（索引只装日志条目），所以它没有出链可列 ——
        // 这时明说一句，比返回空让模型以为「这文件谁都不理」要好。
        if (wantOut) {
          if (resolved.kind === 'file') {
            blocks.push(
              `【出链】${resolved.label}\n\n`
              + '这不是日志，本身没有出链（出链只从日志条目里提取）。这里只查得到「谁引用了它」。',
            );
          } else {
            const file = basename(resolved.logPath);
            const all = index.items.filter((i) => i.file === file);
            const own = resolved.entry === undefined ? all : all.filter((i) => i.num === resolved.entry);
            if (own.length === 0) {
              blocks.push(
                `【出链】${resolved.label}\n\n`
                + `日志里没有第 ${resolved.entry} 条（${file} 共 ${all.length} 条）。`,
              );
            } else {
              // 文件级用紧凑摘要，条目级才逐条展开原文 —— 文件级全量是 4.7 万字符
              // （实测 `2026-10-24.md`），一次倾倒会把上下文吃掉。
              blocks.push(
                resolved.entry === undefined
                  ? renderOutFile(own)
                  : own.map((item) => renderOut(item)).join('\n\n'),
              );
            }
          }
        }

        // C4b：末尾统一提示「日志之间互相引用却没写条目号」的处数。
        // 不提示的话，条目级入链查到空会被读成「没人引用过」——
        // 真实原因是当时写的是裸文件名，那部分内容查不出来。
        const bare = tallyBareLogRefs(index.items);
        if (wantIn && bare.bare > 0) {
          blocks.push(
            `注：全库 ${bare.total} 处日志间引用里有 ${bare.bare} 处只写了文件名、没写「第 N 条」，`
            + '那些引用在条目级入链里查不到（文件级查得到）。',
          );
        }

        const text = blocks.join('\n\n');

        // 埋点：与 query 同构，只为回答「这扇门有没有人推」。失败一律吞掉。
        try {
          recordProbe(ctx, cwd, {
            tool: 'worklog_links',
            target: rawTarget,
            direction,
            inCount: inHits.length,
            outCount: resolved.kind === 'log'
              ? index.items.filter((i) => i.file === basename(resolved.logPath)).length
              : 0,
          });
        } catch { /* 埋点是附加物，坏了不影响主流程 */ }

        return text;
      },
    }));
  }

  /**
   * 读状态并按需注入一次询问引导。异步进行，不阻塞 agent/created。
   * @param {object} agent - 新建的 agent。
   */
  async function bootstrap(agent) {
    const session = agent?.session;
    if (session === undefined || session === null) return;
    let cwd;
    try {
      cwd = ctx.workingDirectory.get(session);
    } catch {
      return;
    }
    const kind = await classifyWorkspace(ctx, cwd);
    stateOf(session).workspace = kind;
    if (kind !== 'undecided') return;
    try {
      agent.inject(makeUserMessage(BOOTSTRAP_TEXT, BOOTSTRAP_SUMMARY));
    } catch (error) {
      ctx.logger?.warn?.(`worklog: 引导注入失败：${String(error)}`);
    }
  }

  if (enabled) {
    ctx.effect(() => ctx.on('agent/created', (payload) => {
      void bootstrap(payload?.agent).catch((error) => {
        ctx.logger?.warn?.(`worklog: 引导失败：${String(error)}`);
      });
    }));
  }

  // ---- 5. 逐轮状态收集 ----------------------------------------------------
  function resetTurn(state, turn) {
    state.turn = turn;
    state.changed = false;
    state.wroteLog = false;
    state.queried = false;
    state.writtenPaths = new Set();
    state.userText = '';
    // 路径基准按轮重置：上一轮盯的路径跟这一轮无关，留着只会让轮尾比对范围虚胖。
    state.pathStamps = undefined;
  }

  /**
   * 查官方 `workspaceChanges` 服务对**本轮**的改动清单。
   *
   * 为什么这么做：`tool/call` 那套关键词判定是在「猜」命令有没有写文件 ——
   * 猜不准（`form ` 里藏着 `rm `）。DSH 自带 `@deepseek-ai/dsh-workspace-changes`，
   * 每轮收尾时真的比对工作区快照，把「本轮改动了哪些文件」算出来，
   * 在 `agent/turn-stopping` 里追加一条 `workspace/changes` 事件（payload 只有 `{turn}`，
   * 摘要留在 Host 内存）。时序上它先跑完，所以这里读得到。
   *
   * 语义上**保守** —— 只在官方真的看得见时才采信：
   * - 有事件 → 采信。`total` 决定「改没改」，文件列表决定「日志写没写」
   * - 无事件 → **不采信**。`D:\AI\deepseek2` 这类非 git 目录下，官方服务只统计
   *   文件工具（write/edit）改的东西，shell 写文件它看不见，此时「无事件」不等于
   *   「没改动」。退回关键词判定，才是安全的
   *
   * @param {any} ctx - 宿主上下文。
   * @param {object} session - 会话对象。
   * @param {number} turn - 当前轮号。
   * @returns {{total: number, files: string[]} | undefined} 采信时的清单；undefined 表示不采信。
   */
  function officialChanges(ctx, session, turn) {
    let service;
    try {
      service = ctx.get?.('workspaceChanges');
    } catch {
      return undefined;
    }
    if (service === undefined || service === null || typeof service.summary !== 'function') return undefined;

    let events;
    try {
      events = session.snapshotEvents?.();
    } catch {
      return undefined;
    }
    if (!Array.isArray(events)) return undefined;

    // 同一轮可能追加多条（`turn/end` 会在轮后再补一次），以最后一条为准 ——
    // 与官方文档「The latest event for one turn replaces earlier ones」一致。
    let seq;
    for (const event of events) {
      if (event?.type === 'workspace/changes' && event.data?.turn === turn) seq = event.seq;
    }
    if (seq === undefined) return undefined;

    let summary;
    try {
      summary = service.summary(session.id, seq);
    } catch {
      return undefined;
    }
    if (summary === undefined || summary === null) return undefined;

    const files = Array.isArray(summary.files) ? summary.files : [];
    return {
      total: typeof summary.total === 'number' ? summary.total : files.length,
      files: files.map((file) => (typeof file?.path === 'string' ? file.path : '')).filter((path) => path.length > 0),
    };
  }

  // 供 turn-stopping 读取的「本轮是否该提醒」判定（纯函数，便于离线测试）。
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const type = event?.type;
    const data = event?.data;
    if (data === undefined || data === null) return;

    if (type === 'turn/start') {
      const turn = data.turn;
      if (typeof turn !== 'number') return;
      const state = stateOf(session);
      if (turn !== state.turn) resetTurn(state, turn);
      // 轮首记下今天日志文件的时间戳快照 —— 轮尾比它有没有变，就是「这轮写没写日志」。
      // 日期也一并存进 state：跨日长轮次必须以轮首那天为准。
      try {
        const cwd = ctx.workingDirectory.get(session);
        const date = localDate();
        state.logDate = date;
        state.logStamp = snapshotLogStamp(cwd, date);
        // 同时给整个工作区拍一张 —— 轮尾再拍一张，两张一样就是一字未动。
        // 这一次扫描同时覆盖改动 / 新建 / 删除，比猜命令行可靠得多。
        state.workspaceStamp = snapshotWorkspaceStamp(cwd);
      } catch {
        // 拿不到工作区 → 快照保持 undefined，轮尾退回关键词判定。
        state.logStamp = undefined;
        state.logDate = undefined;
        state.workspaceStamp = undefined;
      }
      // 补判工作区状态：错过 agent/created（会话恢复、插件热重载后继续旧会话）
      // 时 workspace 会是 undefined，不补判的话提醒永远不会触发。
      // 这里只判状态、不注入引导——引导只在 agent/created 时问一次。
      if (state.workspace === undefined) {
        try {
          const cwd = ctx.workingDirectory.get(session);
          void classifyWorkspace(ctx, cwd)
            .then((kind) => { state.workspace = kind; })
            .catch(() => {});
        } catch {
          // 拿不到工作区就保持 undefined，下个 turn 再试。
        }
      }
      return;
    }

    if (type === 'user/message') {
      // 只收用户本人说的话；插件注入的提醒、工具结果都不算。
      if (data.source?.kind !== 'user') return;
      const text = contentText(data.content);
      if (text.length > 0) stateOf(session).userText += `\n${text}`;
      return;
    }

    if (type !== 'tool/call') return;

    const tool = data.name;
    const args = parseArgs(data.arguments);
    const state = stateOf(session);

    // 记「这轮查过历史」。只记事实，不做任何判定 —— 判定在 turn-stopping 里。
    if (tool === 'worklog_query') {
      state.queried = true;
      return;
    }

    if (WRITE_TOOLS.has(tool)) {
      // `file_path` 是结构化参数，不是猜的 —— 路径干净，可以直接判在不在工作区内。
      // 判不了的（拿不到 cwd、没有路径）一律当成在里面：宁可多报，不要漏报。
      let cwd;
      try {
        cwd = ctx.workingDirectory.get(session);
      } catch {
        cwd = undefined;
      }
      const target = args.file_path ?? args.path ?? '';
      if (!isInsideWorkspace(cwd, typeof target === 'string' ? target : '')) {
        // 写的是工作区外的文件（`D:\Temp` 探针、改插件本体）——这不算改工作区。
        return;
      }
      state.changed = true;
      if (typeof target === 'string' && target.length > 0) {
        try {
          state.writtenPaths.add(isAbsolute(target) ? target : join(cwd ?? '', target));
        } catch { /* 拼不出绝对路径就跳过，探测用不着它 */ }
      }
      // 「写没写日志」只看路径形状，这条路仍然可靠（结构化参数里 `日志\YYYY-MM-DD.md` 认得出）。
      if (typeof target === 'string' && LOG_PATH_RE.test(target)) {
        state.wroteLog = true;
        state.logDirty = true;
      }
      return;
    }

    if (SHELL_TOOLS.has(tool)) {
      const command = args.command ?? args.cmd ?? args.script ?? '';
      if (typeof command !== 'string' || command.length === 0) return;
      // 先记路径基准，**再**看关键词 —— 两条独立证据，别让关键词的结论决定要不要取证。
      //
      // 基准拍在 `tool/call` 这一刻是安全的：Host 是先把 `tool/call` 事件提交进会话，
      // 之后才真正 dispatch 命令（`dsh-agent-loop` 的 startCall），所以此刻的 stat
      // 一定早于命令执行。晚一拍就没基准了 —— `tool/result` 之后什么都看不出来。
      //
      // 只补**首次见到**的路径：同一路径第二次出现时若覆盖基准，
      // 「第一枪改了、第二枪没改」就会变成两张一样的戳，改动被抹掉。
      const paths = collectShellPaths(command);
      if (paths.length > 0) {
        const fresh = state.pathStamps === undefined ? paths : paths.filter((path) => !state.pathStamps.has(path));
        if (fresh.length > 0) {
          const stamps = snapshotPathStamps(fresh);
          if (stamps !== undefined) {
            if (state.pathStamps === undefined) state.pathStamps = new Map();
            for (const [path, stamp] of stamps) state.pathStamps.set(path, stamp);
          }
        }
      }
      if (!looksLikeShellWrite(command)) return;
      state.changed = true;
      // 这里**不再**用 `LOG_PATH_RE.test(command)` 判「写没写日志」——
      // 命令串是猜的：写得进 `Set-Content`，写不进 `[System.IO.File]::WriteAllText`；
      // 路径单反斜杠认得出、转义成双反斜杠就认不出；here-string 正文里的字样还会误命中。
      // 「写了没」统一交给 agent/turn-stopping 里的 mtime 比对（轮首快照 vs 轮尾快照）。
    }
  }));

  // ---- 5b. 漏查探测（只记，不打扰）----------------------------------------
  //
  // 这一步是「装门」实验的对照组。门装上了（工具 + 注入 + 触发词），但门装上不等于
  // 有人推 —— 两周后要回答「这扇门值不值得留」，只能靠数据。
  //
  // 它**不改任何行为**：不注入、不 steer、不拦工具、不写日志文件。唯一动作是往
  // `.dsh\worklog-probe.jsonl` 追加一行。这是刻意的 —— 「每轮自动判断意图然后塞结果」
  // 正是 `RAG语义检索方案-未采用.md:326` 否决的那条路（意图分类最容易错，判错等于静默不检索），
  // 而每轮注入还会把 prompt 缓存命中率打到 0%。
  //
  // 探测什么：本轮写过的文件路径，拿它的文件名当查询词试一次。命中高分说明
  // 「这件事实在日志里写过，而这轮没查」—— 这就是一次可避免的重复。
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!enabled || !wantQueryTool || !wantProbe) return;
    const session = agent?.session;
    if (session === undefined || session === null) return;
    if (skipSubagents && session.header?.origin === 'subagent') return;
    const state = stateOf(session);
    if (state.workspace !== 'enabled') return;
    // 查过了就不算漏查 —— 这条判据的全部意义在于「该查而没查」。
    if (state.queried) return;
    // 没动过文件就没什么可重复的。
    if (!state.changed) return;

    let cwd;
    try {
      cwd = ctx.workingDirectory.get(session);
    } catch {
      return;
    }

    // 用本轮写过的路径当查询词。拿不到路径就跳过 —— 宁可漏记，不要瞎猜。
    const terms = state.writtenPaths.size > 0
      ? [...state.writtenPaths].slice(0, 3).map((p) => basename(p).replace(/\.[^.]+$/, ''))
      : [];
    if (terms.length === 0) return;

    try {
      const { entries } = loadLogs(join(cwd, LOG_DIR));
      if (entries.length === 0) return;
      const query = terms.join(' ');
      const result = searchLogs(entries, query, 3);
      // 只记「有明显命中」的情形。全库都没提过这些词，说明这确实是在做新东西。
      if (result.hits.length === 0) return;
      recordProbe(ctx, cwd, {
        tool: 'probe-miss',
        query,
        turn,
        hits: result.hits.length,
        top: result.hits[0] ? {
          date: result.hits[0].date,
          num: result.hits[0].num,
          title: result.hits[0].title,
          score: Number(result.hits[0].score.toFixed(2)),
        } : undefined,
      });
    } catch (error) {
      ctx.logger?.debug?.(`worklog: 漏查探测失败（忽略）：${String(error)}`);
    }
  }));

  // ---- 6. 轮次收尾提醒 ----------------------------------------------------  // 两条互斥：没写日志 → 催写日志；写了日志但索引陈旧 → 催跑生成器。
  // 写日志那条优先，因为索引检查本来就要求日志先存在。
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!enabled || !wantReminder) return;
    const session = agent?.session;
    if (session === undefined || session === null) return;
    if (skipSubagents && session.header?.origin === 'subagent') return;

    const state = stateOf(session);
    if (state.workspace !== 'enabled') return;

    // 先问官方服务「这轮到底改了什么」。它和下面的工作区快照是**两条独立证据**，
    // 各有一段盲区，见下文 changed 处的说明 —— 两者取并集，谁也不是谁的兜底。
    const official = officialChanges(ctx, session, turn);

    let cwd;
    try {
      cwd = ctx.workingDirectory.get(session);
    } catch {
      cwd = undefined;
    }

    // 「日志写没写」不再问命令串，直接比对今天日志文件的时间戳：
    // 轮首（turn/start）记一次快照，轮尾再记一次，变了就是动过。
    // 这是客观信号 —— 读取文件不改 mtime，写入必然改，与用什么写法无关。
    // 返回 undefined 表示轮首没取到快照（拿不到工作区），此时退回关键词判定。
    const byStamp = cwd === undefined || state.logDate === undefined
      ? undefined
      : logChangedSince(state.logStamp, snapshotLogStamp(cwd, state.logDate));

    // 「改没改文件」同理，只是范围从「今天那个日志」扩到「整个工作区」。
    // 拍两张快照对比，一次同时抓住改动 / 新建 / 删除 —— 不再猜命令行写了什么。
    const byWorkspace = cwd === undefined
      ? undefined
      : workspaceChangedSince(state.workspaceStamp, snapshotWorkspaceStamp(cwd));

    // 第三条证据：命令串里**点名过**的那几个路径，轮尾重拍一遍看变没变。
    //
    // 补的是前两条共同的盲区。工作区快照只看得见工作区内，官方清单只看得见
    // 文件工具 —— 而 `Stop-Process`/`node -e "...WriteAllText('D:\Temp\x')"`
    // 这类 shell 写在工作区外时，两边都是瞎的，只剩关键词在猜。
    // 命令里写出来的绝对路径是确定的事实，stat 一下就有客观结论。
    const namedPaths = state.pathStamps === undefined ? [] : [...state.pathStamps.keys()];
    const stampsAfter = namedPaths.length === 0 ? undefined : snapshotPathStamps(namedPaths);
    const byPaths = stampsAfter === undefined
      ? undefined
      : pathStampsChangedSince(state.pathStamps, stampsAfter);

    // 「改没改」取三条证据的**并集**，不是谁优先。
    //
    // 三条证据各有各的盲区，谁也盖不住谁：
    // - 工作区快照：看得见工作区内的一切改动（含 shell 写的），但**看不见工作区外**
    // - 官方清单：文件工具改的工作区外文件也看得见，但 shell 写的一律看不见
    // - 点名路径：工作区外的 shell 写看得见，但只在命令串里出现绝对路径时才成立
    //   （`python gen.py` 这种跑脚本的，命令里根本没有目标路径）
    //
    // 曾经的写法是「快照拿到就全信快照」，结果是：改动落在工作区外（比如桌面）
    // 时快照判 false，官方清单明明看见了却永远轮不到 —— 该提醒的从不提醒。
    // 反过来只信官方也不行：shell 写工作区内时官方看不见，会漏。
    // 所以只要任一条说「改了」就是改了；两条都说没改才盖过关键词误报。
    //
    // 注意「点名路径」这一路的 false **不能当否决票**，只能当赞成票：
    // 它说 false 只意味着「我盯的那几处没动」，而它压根没盯过的地方太多 ——
    // `python gen.py` 里写着删库它也不知道。若让它参与否决，等于把
    // 「查不到」当成「没发生」，那正是这一路要修的病。
    // 所以下面只在它是 true 时投一票，否则完全不影响结论。
    const byPathsVote = byPaths === true;
    let changed;
    if (byWorkspace !== undefined || official !== undefined || byPathsVote) {
      changed = byWorkspace === true || byPathsVote || (official !== undefined && official.total > 0);
      if (!changed && state.changed) {
        ctx.logger?.info?.('worklog: 客观证据都说没改，忽略命令行关键词误报');
      }
    } else {
      changed = state.changed;
    }

    let wroteLog = state.wroteLog;
    if (byStamp !== undefined) {
      // 时间戳说了算。state.wroteLog 只作兜底（并集，绝不会把「写了」翻成「没写」）。
      wroteLog = byStamp || state.wroteLog;
      // 补回粘性：以前 shell 分支命中时置 logDirty，让「索引没跑」跨轮继续催。
      // 现在改由快照判定，得在这里补上，否则当轮催完就断，下一轮不再提。
      if (byStamp) state.logDirty = true;
    }
    if (official !== undefined) {
      // 官方清单是另一条独立证据（文件工具改动，看得见更细的路径形态）。
      wroteLog = wroteLog || official.files.some((path) => LOG_PATH_RE.test(path));
    }

    // 6a. 该写日志却没写
    if (changed && !wroteLog && !state.reminded.has(turn) && !SKIP_RE.test(state.userText)) {
      state.reminded.add(turn);
      try {
        agent.steer(makeUserMessage(REMINDER_TEXT, REMINDER_SUMMARY));
        ctx.logger?.info?.('worklog: 已在 turn-stopping 提醒补写日志');
      } catch (error) {
        ctx.logger?.warn?.(`worklog: 提醒失败：${String(error)}`);
      }
      return;
    }

    // 6b. 写了日志但索引没跟上（粘性：logDirty 留到索引确认新鲜为止）
    // 采信官方清单时，用「日志确实被改过」替代粘性的 logDirty —— 后者只在
    // tool/call 命中的那一轮置位，而官方看得见 shell 之外的更多写入途径。
    if (official !== undefined) {
      if (!wroteLog) return;
    } else if (!state.logDirty && byStamp !== true) {
      return;
    }
    if (state.remindedIndex.has(turn)) return;
    if (SKIP_RE.test(state.userText)) return;
    if (cwd === undefined) return;
    // 用轮首那天，不用轮尾重新算 —— 跨日时长轮次会比错文件。
    if (!isIndexStale(cwd, state.logDate ?? localDate())) {
      // 索引已是最新（模型跑过生成器），清掉粘性标记，别再打扰。
      state.logDirty = false;
      return;
    }
    state.remindedIndex.add(turn);
    try {
      agent.steer(makeUserMessage(INDEX_REMINDER_TEXT, INDEX_REMINDER_SUMMARY));
      ctx.logger?.info?.('worklog: 已在 turn-stopping 提醒重跑生成器');
    } catch (error) {
      ctx.logger?.warn?.(`worklog: 索引提醒失败：${String(error)}`);
    }
  }));

  // ---- 7. 会话销毁 --------------------------------------------------------
  ctx.effect(() => ctx.on('session/disposed', (session) => {
    states.delete(session);
  }));
}

// ============================================================================
// 判定常量
// ============================================================================

/** 一调用就必然改动文件系统的工具（不需要看参数）。 */
const WRITE_TOOLS = new Set(['write', 'edit', 'str_replace_editor']);

/** 可能改动文件系统的 shell 工具 —— 命令里出现下列关键词才算数。 */
const SHELL_TOOLS = new Set(['pwsh', 'bash']);

/**
 * 判定「这条 shell 命令在改文件」的长关键词 —— 用 `includes` 子串匹配。
 *
 * 只收**长到不会在自然语言里偶然撞上**的词（`Set-Content`、`git commit`）。
 * 短词根（`rm `、`mv `、`cp `）**不能放这里**：`includes` 是无锚点子串匹配，
 * `echo "==== form 枚举定义 ===="` 里的 `form ` 就字面包含 `rm `，会被判成删除。
 * 短词根走下面的 `SHELL_WRITE_RE`。
 *
 * 宁可多报也不要漏报：多报的后果只是模型多回一句「这次不用记」，
 * 漏报的后果是改动没进日志 —— 但「多报」不该多到把只读查询也算进来。
 */
const SHELL_WRITE_HINTS = [
  // PowerShell（动词-名词形式，够长）
  'Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Remove-Item', 'Move-Item',
  'Copy-Item', 'Rename-Item', 'Clear-Content', 'Set-ItemProperty',
  // 跨平台 / 项目级
  'git commit', 'git add', 'git mv', 'git rm', 'git checkout --', 'git reset',
  'npm install', 'pnpm add', 'pnpm install', 'yarn add',
  'sed -i',
];

/**
 * 短词根的正则版 —— **必须带词边界**，否则 `form ` 会命中 `rm `。
 *
 * 规则：命令名前面必须是「命令串开头」或 shell 分隔符（`;` `&` `|` `(` `{`
 * 换行），或一个空白；命令名后面必须跟空白。
 *
 * - `rm file.txt` → 匹配（开头）
 * - `Get-Content x | rm y` → 匹配（`|` 后）
 * - `echo "form 枚举定义"` → **不匹配**（`rm` 前是 `fo`）
 * - `Select-String -Pattern 'rm '` → **不匹配**（`rm` 前是 `'`，不是分隔符）
 *
 * 已知局限：它不解析引号，所以 `echo "; rm x"` 这种「引号里藏着完整命令」仍会误报。
 * 这个代价可以接受 —— 真正被引号包住且形如命令的字符串，在只读调研里很罕见。
 */
const SHELL_WRITE_RE =
  /(?:^|[;&|(\n{]|\s)(?:rm|mv|cp|tee|mkdir|rmdir|touch|ln|dd)\s/;

/**
 * 剥掉引号包住的文本 —— 引号里的 `>` 不可能是重定向。
 *
 * `Select-String -Pattern 'a>b'` 里的 `>` 在引号内，是搜索词的一部分。
 * 长度信息会丢（`'abc'` 变 `''`），但这里只判「有没有重定向」，不关心内容。
 *
 * @param {string} command - 完整命令行。
 * @returns {string} 引号内容被清空的命令。
 */
export function stripQuoted(command) {
  return command.replace(/'[^']*'/g, "''").replace(/"[^"]*"/g, '""');
}

/**
 * 剥掉 PowerShell here-string 的**正文**，只留会执行的命令。
 *
 * `@'` … `'@` 之间是字面文本，`@"` … `"@` 之间只有 `$` 变量会展开 —— 两者都
 * 不会被当成命令执行，所以里面出现 `New-Item`、`Set-Content` 只是**数据**。
 *
 * 为什么不能直接用 `stripQuoted`：那会把引号里的**命令**也一起抹掉，
 * 于是 `pwsh -Command "Remove-Item x"` 这种真写会漏判。here-string 的正文
 * 是纯数据，剥它没有这个副作用。
 *
 * 真写命令总出现在 here-string **外面**（`@'…'@ | Set-Content $path` 这一截），
 * 不受影响。
 *
 * @param {string} command - 完整命令行。
 * @returns {string} here-string 正文被清空的命令。
 */
export function stripHereString(command) {
  return command
    .replace(/@'[ \t]*\r?\n[\s\S]*?\r?\n'@/g, "@''@")
    .replace(/@"[ \t]*\r?\n[\s\S]*?\r?\n"@/g, '@""@');
}

/**
 * 重定向写入：命令真的把输出引进一个文件。
 *
 * 历史教训 —— 这里曾是 `/>\s*\S/`，即「有 `>` 且有后续字符」就算，结果
 * `2>&1`（几乎每条带 `| Select-Object -Last N` 的命令都有）、`->`、`=>`
 * 全被当成写文件，导致**几乎每轮都误报**。改回逐条排除：
 *
 * - `(?<![-=<>])` —— `>` 前面不能是 `-`/`=`/`<`/`>`：拦住 `->`、`=>`、`>>>`
 * - `(?:[1-6]|\*)?` —— 允许 `2>` 这种流编号，它不改变「是不是重定向」
 * - `(?![&$>])` —— `>` 后面不能是 `&`/`$`/`>`：拦住 `2>&1`、`> $null`、`>>>`
 * - `(?!nul\b)` —— 拦住 `2>nul`
 * - `[^\s&|>]` —— 目标必须是个实打实的词（路径/文件名/变量），不是空白
 *
 * 保留的真阳性（不能一起修掉）：
 * - `echo hi > out.txt`、`echo hi>out.txt`、`echo hi >> out.txt`（实测 PowerShell 无空格也真写文件）
 * - `node build.mjs 2>&1 > log.txt` —— 合流之后另有一个真 `>`，仍然判改
 */
const SHELL_REDIRECT_RE =
  /(?<![-=<>])(?:[1-6]|\*)?>>?\s*(?![&$>])(?!nul\b)[^\s&|>]/i;

/**
 * 临时目录标记。命令里**只**出现这些路径时，不算改工作区。
 *
 * 依据：官方 `dsh-workspace-changes` 的 `isTemporaryPath()`（`lib\index.js:108-110`）
 * 与 `temporaryRoots(["/tmp", tmpdir()])`（`:75-82`）对临时目录本就豁免；
 * 这里是关键词兜底路径下的等价规则。
 *
 * 分两层，缺一不可：
 * 1. `TEMP_PATH_RE` —— **词形**（`$env:TEMP`、`%TEMP%`、`/tmp/`）。这些是命令里怎么写都一样的写法。
 * 2. `TEMP_ROOT_RE` —— **真实绝对路径**（`os.tmpdir()` 现算）。`New-Item D:\Temp\x` 直接写全路径时，
 *    光靠词形认不出来 —— 而 `os.tmpdir()` 在 Windows 上通常就是 `%TEMP%` 展开后的值。
 *
 * 为什么用 `os.tmpdir()` 而不是写死：写死等于把插件绑到某台机器 / 某个环境变量上。
 * 换台机器、或用户改了 `TEMP` 指向，写死的字符串立刻失效；`tmpdir()` 每次运行时现算。
 *
 * 为什么**不**认工作区自己的 `Temp\`：插件不该知道任何具体工作区的目录习惯。
 * 某个目录算不算"可丢弃"，是那个工作区自己的约定，不是这个插件的判据。
 */
const TEMP_PATH_RE = /\$env:TEMP|\$env:TMP|%TEMP%|%TMP%|\\AppData\\Local\\Temp\\|\/tmp\/|\/var\/tmp\//i;

/** 把一段字面文本转义成正则片段（`C:\Users` 里的 `\` 必须转义，否则是任意字符）。 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 运行时收集的临时目录绝对路径。
 *
 * - `os.tmpdir()` 放在最前，它才是本机权威答案；
 * - `/tmp`、`/var/tmp` 是 POSIX 惯例，`os.tmpdir()` 在少数容器里可能不覆盖；
 * - **过滤掉根目录**（`C:\`、`/`）：若 `tmpdir()` 意外返回根，豁免会扩到整台机器。
 */
const TEMP_ROOTS = (() => {
  const roots = [];
  try {
    const fromOs = tmpdir();
    if (typeof fromOs === 'string' && fromOs.length > 0) roots.push(fromOs);
  } catch {
    // 取不到就退回纯词形判定，不影响主流程。
  }
  roots.push('/tmp', '/var/tmp');
  return [...new Set(
    roots
      .map((root) => root.replace(/[\\/]+$/, ''))
      .filter((root) => root.length > 0 && !/^[A-Za-z]:$/.test(root) && root !== '/'),
  )];
})();

/** 动态临时根拼成的正则片段；空集合时给出永不匹配的兜底，避免拼出 `(?:)`。 */
const TEMP_ROOT_ALT = TEMP_ROOTS.length > 0
  ? TEMP_ROOTS.map(escapeRegExp).join('|')
  : '(?!)';

/**
 * 命令里出现「真实临时目录 + 边界」才算，`D:\Tempest` 不会命中 `D:\Temp`。
 *
 * 边界必须含**空白**：`cd D:\Temp` 后面跟的常常是换行或空格，不是 `\`。
 * 只认 `\` `/` 与结尾时，`cd D:\Temp\n<下一条命令>` 认不出临时目录，
 * 豁免失效 → 临时目录里写文件被当成改工作区（turn 20 十条误判里有九条栽在这）。
 *
 * 分号仍是缺口：`cd D:\Temp; x` 不命中。实测 turn 20 无此形态，暂不扩大。
 */
const TEMP_ROOT_RE = new RegExp(`(?:${TEMP_ROOT_ALT})(?:[\\\\/\\s]|$)`, 'i');

/** 命令里一段「临时路径」的具体形态，剥掉它之后再看还有没有别的绝对路径。 */
const TEMP_SEGMENT_RE = new RegExp(
  '(?:\\$env:TEMP|\\$env:TMP|%TEMP%|%TMP%)[^\\s"\';|)]*'
  + '|\\\\AppData\\\\Local\\\\Temp\\\\[^\\s"\';|)]*'
  + `|(?:${TEMP_ROOT_ALT})[^\\s"';|)]*`
  + '|\\/tmp\\/[^\\s"\';|)]*'
  + '|\\/var\\/tmp\\/[^\\s"\';|)]*',
  'gi',
);

/** 绝对路径（盘符形式）。剥掉临时路径后如果还剩，说明命令碰了真东西。 */
const ABS_PATH_RE = /[A-Za-z]:\\[^\s"';|)]+/g;

/**
 * 这条命令是不是**只**动了临时目录。
 *
 * 判据：先认出「命令里提到了临时目录」，再把临时路径片段整段剥掉，
 * 看剩下的部分还有没有别的绝对路径。没有就认为它没碰工作区。
 *
 * 「提到了临时目录」有两条路：词形（`$env:TEMP`）或真实根路径（`os.tmpdir()` 现算）。
 *
 * - `New-Item $env:TEMP\probe -ItemType Directory` → 词形命中 → 剥掉后剩 `New-Item   -ItemType Directory` → 豁免
 * - `New-Item D:\Temp\probe`（本机 `tmpdir()` 就是 `D:\Temp`）→ 根路径命中 → 剥掉后无残留 → 豁免
 * - `Copy-Item $env:TEMP\a D:\AI\deepseek2\b` → 剥掉后剩 `Copy-Item   D:\AI\deepseek2\b` → **不**豁免
 * - `Copy-Item D:\AI\deepseek2\a $env:TEMP\b` → 剩 `Copy-Item D:\AI\deepseek2\a` → **不**豁免
 *   （这条其实只是把工作区文件复制出去，工作区没变，属于可接受的多报）
 *
 * @param {string} command - 完整命令行。
 * @returns {boolean} 是否只碰了临时目录。
 */
export function onlyTouchesTemp(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  // here-string 正文里的路径是**要被写进文件的内容**，不是命令的操作数。
  // 不剥它，`@'\nD:\AI\x\n'@ | Set-Content D:\Temp\v.mjs` 会因为正文里那句
  // 工作区路径被判成「碰了工作区」——turn 20 十条误判的主因。
  const executable = stripHereString(command);
  if (!TEMP_PATH_RE.test(executable) && !TEMP_ROOT_RE.test(executable)) return false;
  const stripped = executable.replace(TEMP_SEGMENT_RE, ' ');
  const absolute = stripped.match(ABS_PATH_RE);
  return absolute === null || absolute.length === 0;
}

/**
 * 这条 shell 命令是否值得当成「改了文件」。
 *
 * 三层判定，任一命中即算改：
 * 1. 长关键词子串命中（`Set-Content`、`git commit`）
 * 2. 短词根**带边界**命中（`rm x`、`| mv y`），`form ` 不会命中
 * 3. 重定向写入（`> file`），判前先剥引号，`'a>b'` 与 `2>&1` 不算
 *
 * 命中的命令还要再过一道临时目录豁免 —— 作用于临时目录的写入不计入工作区。
 *
 * @param {string} command - 完整命令行。
 * @returns {boolean} 是否算改了工作区。
 */
export function looksLikeShellWrite(command) {
  if (typeof command !== 'string' || command.length === 0) return false;
  // here-string 的正文是**数据**不是命令：`@'…'@` 里写满 `New-Item` 也不执行它。
  // 只剥正文，不碰其余部分 —— 真写总在 `'@ | Set-Content x` 这一截，剥不到。
  const executable = stripHereString(command);
  // 引号里的内容不当命令看：`Select-String -Pattern 'a>b'` 的 `>` 是搜索词。
  // 只对重定向这一条生效 —— 长关键词（`New-Item`）与短词根（`rm x`）
  // 仍用原串判，否则 `pwsh -Command "Remove-Item x"` 这种带引号的真写会漏。
  const unquoted = stripQuoted(command);
  const wrote =
    SHELL_WRITE_HINTS.some((hint) => executable.includes(hint))
    || SHELL_WRITE_RE.test(executable)
    || SHELL_REDIRECT_RE.test(unquoted);
  if (!wrote) return false;
  if (onlyTouchesTemp(command)) return false;
  return true;
}

/** 日志文件形状：`日志\2026-10-19.md` 或 `日志/2026-10-19.md`。 */
const LOG_PATH_RE = /日志[\\/]\d{4}-\d{2}-\d{2}\.md/;

/**
 * 用户这句话表示本轮不用记 —— 尊重它，别提醒。
 *
 * 取向：宁可漏压（多提醒一次），不可误压（该提醒时不提醒）。
 * 分支说明：
 * - `不[用要]记` 保底覆盖裸的「不用记/不要记」（不带「日志」二字）；
 * - `不记(?!得|录)` 「不记」但挡住「不记得」「不记录」；
 * - `不记录(?!一下)` 挡住「不记录一下的话…请写」；
 * - `不[用要]?[写记碰动]日志` 覆盖「不写日志/不记日志/不碰日志/不动日志」；
 * - `别[记写碰动](?!不)` 「动不动」是固定词（意为「轻易、频繁」），不加 `(?!不)`
 *   会把「别动不动就改我代码」误当成不让碰日志。
 */
const SKIP_RE =
  /不[用要]记|不记(?!得|录)|不记录(?!一下)|不[用要]?[写记碰动]日志|别[记写碰动](?!不)|无需记录|不需要记录|跳过日志|免记/;
