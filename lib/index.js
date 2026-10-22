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
import { tmpdir } from 'node:os';
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
  function resetTurn(state, turn) {    state.turn = turn;
    state.changed = false;
    state.wroteLog = false;
    state.userText = '';
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
      if (!looksLikeShellWrite(command)) return;
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

    // 先问官方服务「这轮到底改了什么」。它看得见就用它的答案，看得见与否见
    // officialChanges() 的注释 —— 采信时以它为准，不采信时退回 tool/call 的关键词判定。
    //
    // 两者关系：
    // - 官方说没改（total === 0，且确实有事件）→ 就是没改，**盖过**关键词判定的误报
    // - 官方说改了 → 改了就认
    // - 官方不采信 → 用 state.changed / state.wroteLog（旧路）
    //
    // 「改没改」与「日志写没写」取信方向相反，别一起收紧：
    // - changed 只信官方 —— 关键词那里会误报（`form` 里有 `rm `、`2>&1` 里有 `>`）
    // - wroteLog 取并集 —— 官方**看不见 shell 写出的文件**（README：只通过 shell
    //   命令做出的改动不会被记录），而日志恰恰常用 shell 写；若让官方清单无条件
    //   覆盖，就会出现「明明写了日志还被催写」。故 state.wroteLog 为真时一律认。
    const official = officialChanges(ctx, session, turn);
    let changed = state.changed;
    let wroteLog = state.wroteLog;
    if (official !== undefined) {
      changed = official.total > 0;
      wroteLog = state.wroteLog || official.files.some((path) => LOG_PATH_RE.test(path));
      if (!changed && state.changed) {
        ctx.logger?.info?.('worklog: 官方改动清单为空，忽略关键词误报');
      }
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
    } else if (!state.logDirty) {
      return;
    }
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

/** 用户这句话表示本轮不用记 —— 尊重它，别提醒。 */
const SKIP_RE = /不用记|不要记|别记|无需记录|不需要记录/;
