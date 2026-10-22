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
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
  skipSubagents: z.boolean().default(true).description('子代理会话不提醒、不初始化').volatile(),
});

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** 技能名。与工作区 `.dsh\skills\worklog` 同名时，项目源 rank 100 覆盖运行时 rank 250 —— 用户可改。 */
const SKILL_NAME = 'worklog';

/** 技能描述（会出现在 available_skills 目录里，≤500 字符）。 */
const SKILL_DESCRIPTION =
  '当用户要求记日志、写日志、记录一下、把本次记录写入日志、或当你要往 `日志\\YYYY-MM-DD.md` 写今天的日志、判断某件事该不该记进日志、或问"这个要不要写进日志""日志怎么记"时使用。含该写/不该写的清单、条目格式三个易错点、正文三条硬要求、写完的自检与提交步骤。不含封卷、不含待办 —— 这两个机制已被取消。';

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
  '- 一天一个文件 `日志\\YYYY-MM-DD.md`，第一行 `# YYYY-MM-DD`；做完一件事就写，不攒着。',
  '- 每条 `N. **标题** —— 正文`，编号当天从 1 连续。**标题必须加粗**，否则索引查不到。',
  '- 正文给具体路径/命令/标识符，给证据（实测、读代码、推测），写否定面。',
  '- 写完跑 `node 日志\\build-index.mjs`（FAIL 必须修），再 `cd 日志; git add -A; git commit`。',
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
  'enabled=true：一次建好 日志\\ 目录、.gitattributes、build-index.mjs、今天的日志文件，并执行 git init；',
  'enabled=false：只写拒绝记录，之后本工作区不再询问日志系统的事。',
  '已存在的文件不会被覆盖。',
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
 * @param {{enabled?: boolean, skill?: boolean, section?: boolean, reminder?: boolean, initTool?: boolean, skipSubagents?: boolean}} [config]
 *   插件配置。默认全开；任何一项都不影响其它项。
 */
export function apply(ctx, config = {}) {
  const enabled = readFlag(config, 'enabled');
  const wantSkill = readFlag(config, 'skill');
  const wantSection = readFlag(config, 'section');
  const wantReminder = readFlag(config, 'reminder');
  const wantInitTool = readFlag(config, 'initTool');
  const skipSubagents = readFlag(config, 'skipSubagents');

  /**
   * 逐会话状态。键是 Session 对象本身（同一会话内对象稳定）。
   * workspace：agent/created 时判定一次；worklog_init 后更新。
   * logDirty：写过日志后的粘性标记，直到索引被确认为新鲜才清除 ——
   *   留到下个 turn 是有意的：索引停在旧快照是持续状态，只在写的那个 turn 检查会漏。
   * @type {Map<object, {turn: number, changed: boolean, wroteLog: boolean, logDirty: boolean, userText: string, reminded: Set<number>, remindedIndex: Set<number>, workspace: string | undefined}>}
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
        logDirty: false,
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

  // ---- 4. 新会话引导 ------------------------------------------------------
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
    state.userText = '';
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

    if (WRITE_TOOLS.has(tool)) {
      state.changed = true;
      const target = args.file_path ?? args.path ?? '';
      if (typeof target === 'string' && LOG_PATH_RE.test(target)) {
        state.wroteLog = true;
        state.logDirty = true;
      }
      return;
    }

    if (SHELL_TOOLS.has(tool)) {
      const command = args.command ?? args.cmd ?? args.script ?? '';
      if (typeof command !== 'string' || command.length === 0) return;
      const writes = SHELL_WRITE_HINTS.some((hint) => command.includes(hint));
      if (!writes) return;
      state.changed = true;
      if (LOG_PATH_RE.test(command)) {
        state.wroteLog = true;
        state.logDirty = true;
      }
    }
  }));

  // ---- 6. 轮次收尾提醒 ----------------------------------------------------
  // 两条互斥：没写日志 → 催写日志；写了日志但索引陈旧 → 催跑生成器。
  // 写日志那条优先，因为索引检查本来就要求日志先存在。
  ctx.effect(() => ctx.on('agent/turn-stopping', ({ agent, turn }) => {
    if (!enabled || !wantReminder) return;
    const session = agent?.session;
    if (session === undefined || session === null) return;
    if (skipSubagents && session.header?.origin === 'subagent') return;

    const state = stateOf(session);
    if (state.workspace !== 'enabled') return;

    // 6a. 该写日志却没写
    if (state.changed && !state.wroteLog && !state.reminded.has(turn) && !SKIP_RE.test(state.userText)) {
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
    if (!state.logDirty) return;
    if (state.remindedIndex.has(turn)) return;
    if (SKIP_RE.test(state.userText)) return;
    let cwd;
    try {
      cwd = ctx.workingDirectory.get(session);
    } catch {
      return;
    }
    if (!isIndexStale(cwd, localDate())) {
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
 * 判定「这条 shell 命令在改文件」的关键词。
 * 宁可多报也不要漏报：多报的后果只是模型多回一句「这次不用记」，漏报的后果是改动没进日志。
 */
const SHELL_WRITE_HINTS = [
  // PowerShell
  'Set-Content', 'Add-Content', 'Out-File', 'New-Item', 'Remove-Item', 'Move-Item',
  'Copy-Item', 'Rename-Item', 'Clear-Content', 'Set-ItemProperty',
  // POSIX
  'rm ', 'rm -', 'mv ', 'cp ', 'mkdir ', 'rmdir ', 'touch ', 'tee ', 'sed -i',
  // 跨平台 / 项目级
  'git commit', 'git add', 'git mv', 'git rm', 'git checkout --', 'git reset',
  'npm install', 'pnpm add', 'pnpm install', 'yarn add',
  // 重定向（`>` 写入、`>>` 追加）；`> $null` 之类误报可接受
  '> ',
];

/** 日志文件形状：`日志\2026-10-19.md` 或 `日志/2026-10-19.md`。 */
const LOG_PATH_RE = /日志[\\/]\d{4}-\d{2}-\d{2}\.md/;

/** 用户这句话表示本轮不用记 —— 尊重它，别提醒。 */
const SKIP_RE = /不用记|不要记|别记|无需记录|不需要记录/;
