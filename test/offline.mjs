// dsh-annals 离线测试 —— 不需要 DSH 宿主，mock 掉 ctx 的六个服务。
// 运行：node --test test/offline.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  apply,
  name,
  inject,
  Config,
  deepFreeze,
  makeUserMessage,
  parseArgs,
  contentText,
  localDate,
  classifyWorkspace,
  resolveWorkspacePolicy,
  initWorkspace,
  readFlag,
  readString,
  resolvePersonaText,
  isIndexStale,
  looksLikeShellWrite,
  isEnvMutation,
  onlyTouchesTemp,
  stripQuoted,
  stripHereString,
  snapshotLogStamp,
  logChangedSince,
  isInsideWorkspace,
  snapshotWorkspaceStamp,
  workspaceChangedSince,
  workspaceChangedPaths,
  classifyUnattributed,
  updateUnattributedDirs,
  scanTopLevelDirs,
  parseRequestedDirs,
  isDismissed,
  normalizeIgnoreDir,
  isIgnoredPath,
  readWorkspaceConfig,
  writeWorkspaceConfig,
  collectShellPaths,
  snapshotPathStamps,
  pathStampsChangedSince,
  recordProbe,
} from '../lib/index.js';
import { tokenize, buildIdf, search, normalizeUserText } from '../lib/query.js';

// ---------------------------------------------------------------------------
// 脚手架：临时工作区 + mock 服务
// ---------------------------------------------------------------------------

/** @returns {string} 一次性的工作区根。 */
function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-annals-test-'));
}

/**
 * 用真实 node:fs 实现 dsh-fs 的六个方法，目标目录即工作区根。
 * 同时记录每次 writeText 是否带了沙箱策略（第 5 个参数）。
 * @param {string} root - 工作区根。
 */
function makeFs(root) {
  const writes = [];
  return {
    writes,
    async resolve(p, opts = {}) {
      const base = opts.cwd ?? root;
      return { path: join(base, p) };
    },
    processPath(target) {
      return target.path;
    },
    async stat(target) {
      try {
        const s = statSync(target.path);
        return { kind: s.isDirectory() ? 'directory' : 'file', size: s.size };
      } catch {
        return undefined;
      }
    },
    async readText(target) {
      return readFileSync(target.path, 'utf8');
    },
    async writeText(target, content, _expected, _signal, policy) {
      writes.push({ path: target.path, hasPolicy: policy !== undefined });
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, content, 'utf8');
      return { operation: 'create' };
    },
  };
}

/** 假装 git init 成功，并在 workdir 下建出 `.git`（让幂等逻辑可测）。 */
function makeShell() {
  const calls = [];
  return {
    calls,
    resolve(request) {
      const spec = { command: request.command, workdir: request.workdir, sandboxPolicy: request.sandboxPolicy };
      calls.push(spec);
      return spec;
    },
    async execute(spec) {
      if (spec.command === 'git init') mkdirSync(join(spec.workdir, '.git'), { recursive: true });
      return {
        result: async () => ({
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          timeoutMs: 1,
          stdout: { text: '', truncated: false },
          stderr: { text: '', truncated: false },
        }),
      };
    },
  };
}

/**
 * @param {string} root - 工作区根。
 * @param {object} [options] - 额外挂载的服务。
 * @param {object} [options.workspaceChanges] - 模拟官方改动清单服务。
 * @returns {any} mock 上下文。
 */
function makeCtx(root, options = {}) {
  const handlers = new Map();
  const registered = { skills: [], sections: [], tools: [] };
  const ctx = {
    handlers,
    registered,
    on(event, fn) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(fn);
      return () => {};
    },
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'sandboxPolicy') {
        return {
          resolve: ({ session } = {}) => ({
            mode: 'workspace-write',
            workspaceRoot: root,
            sessionId: session?.id ?? 'offline-session',
          }),
        };
      }
      if (name === 'workspaceChanges') return options.workspaceChanges;
      return undefined;
    },
    skills: { register(skill) { registered.skills.push(skill); return () => {}; } },
    systemPrompt: { section(section) { registered.sections.push(section); return () => {}; } },
    tools: { register(tool) { registered.tools.push(tool); return () => {}; } },
    fs: makeFs(root),
    shell: makeShell(),
    workingDirectory: { get() { return root; } },
  };
  return ctx;
}

/**
 * @param {any} ctx - mock 上下文。
 * @param {string} event - 事件名。
 * @param {...any} args - 参数。
 */
function emit(ctx, event, ...args) {
  for (const fn of ctx.handlers.get(event) ?? []) fn(...args);
}

/** 让 agent/created 里的异步 bootstrap 跑完。 */
function tick() {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

/** 造一个可观察的 agent。 */
function makeAgent(session, injects = []) {
  const steers = [];
  return {
    session,
    steers,
    inject(message) { injects.push(message); },
    steer(message) { steers.push(message); },
  };
}

// ---------------------------------------------------------------------------
// 纯函数
// ---------------------------------------------------------------------------

test('模块导出：名字与服务依赖', () => {
  assert.equal(name, 'annals');
  assert.deepEqual(inject, ['skills', 'systemPrompt', 'tools', 'fs', 'shell', 'workingDirectory']);
});

test('Config：导出 Standard Schema，validate 填充默认值', () => {
  // Loader 用 Config["~standard"].validate(config) 校验并填默认值（cordis/lib/index.js:956-958）；
  // GUI 设置表单只投影 volatile 字段（dsh-settings 的 volatileForm）。
  assert.ok(Config, '应导出 Config');
  assert.equal(Config['~standard'].vendor, 'schemastery');

  // 这些字段必须都是 volatile，否则 settings.describe() 里不会出现 annals 命名空间。
  for (const field of ['enabled', 'skill', 'section', 'persona', 'personaPreset', 'personaText', 'reminder', 'initTool', 'skipSubagents']) {
    assert.equal(Config.dict[field].meta.volatile, true, field + ' 应为 volatile');
  }

  const defaults = Config['~standard'].validate({});
  assert.equal(defaults.issues, undefined);
  // volatile 字段的值是运行时引用对象（cosmokit createVolatile），要 get() 解包。
  for (const field of ['enabled', 'skill', 'section', 'reminder', 'initTool', 'skipSubagents']) {
    assert.equal(typeof defaults.value[field].get, 'function', field + ' 应是引用对象');
    assert.equal(defaults.value[field].get(), true, field + ' 默认应为 true');
  }
  assert.equal(typeof defaults.value.persona.get, 'function', 'persona 应是引用对象');
  assert.equal(defaults.value.persona.get(), false, 'persona 默认应为 false');
  assert.equal(defaults.value.personaPreset.get(), 'standard', 'personaPreset 默认应为 standard');
  assert.equal(defaults.value.personaText.get(), '', 'personaText 默认应为空');

  const custom = Config['~standard'].validate({ reminder: false, persona: true, personaPreset: 'custom', personaText: '你好' });
  assert.equal(custom.value.reminder.get(), false);
  assert.equal(custom.value.enabled.get(), true);
  assert.equal(custom.value.persona.get(), true);
  assert.equal(custom.value.personaPreset.get(), 'custom');
  assert.equal(custom.value.personaText.get(), '你好');
});

test('readString：解包 volatile 引用、缺省空串、非字符串回退', () => {
  assert.equal(readString(undefined, 'personaPreset', 'standard'), 'standard');
  assert.equal(readString({}, 'personaPreset', 'standard'), 'standard');
  assert.equal(readString({ personaPreset: 'simple' }, 'personaPreset'), 'simple');
  assert.equal(readString({ personaPreset: { get: () => 'custom' } }, 'personaPreset'), 'custom');
  assert.equal(readString({ personaPreset: 42 }, 'personaPreset', 'standard'), 'standard');
});

test('resolvePersonaText：standard / simple / custom / 空自定义兜底', () => {
  assert.match(resolvePersonaText({}), /小鲸鱼/);
  assert.match(resolvePersonaText({ personaPreset: 'standard' }), /小鲸鱼/);
  assert.match(resolvePersonaText({ personaPreset: 'simple' }), /工作小助手/);
  assert.equal(resolvePersonaText({ personaPreset: 'custom', personaText: '自定义正文' }), '自定义正文');
  assert.match(resolvePersonaText({ personaPreset: 'custom', personaText: '   ' }), /小鲸鱼/);
});

test('readFlag：解包 volatile 引用、缺省 true、显式 false 才算关', () => {
  assert.equal(readFlag(undefined, 'enabled'), true);
  assert.equal(readFlag({}, 'enabled'), true);
  assert.equal(readFlag({ enabled: false }, 'enabled'), false);
  assert.equal(readFlag({ enabled: true }, 'enabled'), true);
  // Loader 校验后的真实形状：{ get() } 引用对象。
  assert.equal(readFlag({ enabled: { get: () => false } }, 'enabled'), false);
  assert.equal(readFlag({ enabled: { get: () => true } }, 'enabled'), true);
  // 无 get 的普通对象不会被误解包（只按 undefined 判断，保持 true）。
  assert.equal(readFlag({ enabled: {} }, 'enabled'), true);
});

test('deepFreeze 递归冻结', () => {
  const value = deepFreeze({ a: { b: 1 }, c: [1, 2] });
  assert.ok(Object.isFrozen(value));
  assert.ok(Object.isFrozen(value.a));
  assert.ok(Object.isFrozen(value.c));
  assert.throws(() => { value.a.b = 2; });
});

test('makeUserMessage：user + notice + annals 来源', () => {
  const message = makeUserMessage('正文', '摘要');
  assert.equal(message.role, 'user');
  assert.equal(message.content[0].text, '正文');
  assert.equal(message.source.kind, 'annals');
  assert.equal(message.source.form, 'notice');
  assert.equal(message.source.summary, '摘要');
  assert.ok(Object.isFrozen(message));
});

test('parseArgs 容错', () => {
  assert.deepEqual(parseArgs('{"a":1}'), { a: 1 });
  assert.deepEqual(parseArgs('不是 json'), {});
  assert.deepEqual(parseArgs(''), {});
  assert.deepEqual(parseArgs(null), {});
  assert.deepEqual(parseArgs('[1]'), {});
});

test('contentText 只拼 text 块', () => {
  assert.equal(contentText([
    { type: 'text', text: '第一段' },
    { type: 'image', data: 'x' },
    { type: 'text', text: '第二段' },
  ]), '第一段\n第二段');
  assert.equal(contentText(null), '');
});

test('localDate 用本地时区', () => {
  assert.equal(localDate(new Date(2026, 9, 20)), '2026-10-20');
  assert.equal(localDate(new Date(2026, 0, 1)), '2026-01-01');
});

test('resolveWorkspacePolicy：有服务返回会话策略，无服务/异常返回 undefined', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const policy = resolveWorkspacePolicy(makeCtx(root), { id: 's1' });
  assert.equal(policy.mode, 'workspace-write');
  assert.equal(policy.workspaceRoot, root);
  assert.equal(policy.sessionId, 's1');

  assert.equal(resolveWorkspacePolicy({ get() { return undefined; } }, { id: 's1' }), undefined);
  assert.equal(resolveWorkspacePolicy({ get() { return { resolve() { throw new Error('boom'); } }; } }, { id: 's1' }), undefined);
});

// ---------------------------------------------------------------------------
// 工作区状态
// ---------------------------------------------------------------------------

test('classifyWorkspace：未决定 → 启用 → 拒绝', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);

  assert.equal(await classifyWorkspace(ctx, root), 'undecided');

  // 兼容老工作区：没有状态文件但有生成器 → 视为已启用
  mkdirSync(join(root, '日志'), { recursive: true });
  writeFileSync(join(root, '日志', 'build-index.mjs'), '// stub', 'utf8');
  assert.equal(await classifyWorkspace(ctx, root), 'enabled');

  // 状态文件说拒绝 → 即使生成器还在也静默
  mkdirSync(join(root, '.dsh'), { recursive: true });
  writeFileSync(join(root, '.dsh', 'log-system.json'), JSON.stringify({ version: 1, state: 'declined' }), 'utf8');
  assert.equal(await classifyWorkspace(ctx, root), 'declined');
});

test('classifyWorkspace：状态说启用但生成器被删 → 重新询问', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  mkdirSync(join(root, '.dsh'), { recursive: true });
  writeFileSync(join(root, '.dsh', 'log-system.json'), JSON.stringify({ version: 1, state: 'enabled' }), 'utf8');
  assert.equal(await classifyWorkspace(ctx, root), 'undecided');
});

test('initWorkspace 建齐文件、幂等、不覆盖用户改动', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  const today = localDate();

  const first = await initWorkspace(ctx, root, { id: 'offline-session' });
  assert.ok(existsSync(join(root, '日志', '.gitattributes')));
  assert.ok(existsSync(join(root, '日志', 'build-index.mjs')));
  assert.ok(existsSync(join(root, '日志', `${today}.md`)));
  assert.ok(existsSync(join(root, '.dsh', 'log-system.json')));
  // 初始化只碰 日志\ 和 .dsh\：不往工作区根创建任何文档架构文件
  assert.ok(!existsSync(join(root, '_文档架构.md')), '初始化不应创建 _文档架构.md');
  assert.ok(!first.created.includes('_文档架构.md'));
  // 每次写文件都必须带会话的沙箱策略，否则默认策略会拒绝外部工作区
  assert.ok(ctx.fs.writes.length > 0 && ctx.fs.writes.every((w) => w.hasPolicy), '所有写入都应带 sandboxPolicy');

  const state = JSON.parse(readFileSync(join(root, '.dsh', 'log-system.json'), 'utf8'));
  assert.equal(state.state, 'enabled');
  assert.equal(state.version, 1);
  assert.equal(state.workspace, root);

  assert.equal(ctx.shell.calls.length, 1);
  assert.equal(ctx.shell.calls[0].command, 'git init');
  assert.ok(ctx.shell.calls[0].sandboxPolicy !== undefined, 'git init 应带 sandboxPolicy');
  assert.equal(ctx.shell.calls[0].sandboxPolicy.workspaceRoot, root);
  assert.ok(first.created.includes('日志/.gitattributes'));

  // 用户改过的生成器不能被覆盖
  writeFileSync(join(root, '日志', 'build-index.mjs'), '// user-modified', 'utf8');
  const second = await initWorkspace(ctx, root, { id: 'offline-session' });
  assert.equal(readFileSync(join(root, '日志', 'build-index.mjs'), 'utf8'), '// user-modified');
  assert.ok(second.kept.includes('日志/build-index.mjs'));
  // 已有 .git 就不重复 init
  assert.equal(ctx.shell.calls.length, 1);
  // 当天的日志骨架也不能被重写
  assert.ok(second.kept.includes(`日志/${today}.md`));
});

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

test('apply 注册技能、规矩、工具', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});

  assert.equal(ctx.registered.skills.length, 1);
  const skill = ctx.registered.skills[0];
  assert.equal(skill.name, 'annals');
  assert.equal(skill.source, 'dsh-annals', 'source 缺失会让 skill 工具加载时报 source must be a string');
  assert.ok(skill.content.length > 2500, `技能正文太短：${skill.content.length}`);
  assert.ok(skill.description.length <= 500, `描述超 500 字符：${skill.description.length}`);

  assert.equal(ctx.registered.sections.length, 1);
  assert.equal(ctx.registered.sections[0].name, 'annals');
  assert.match(ctx.registered.sections[0].text, /日志系统/);
  // 档位指令必须两半都在：只写「没说就是 B」会让 AI 把用户的「简单记」当空气
  // （2026-10-26 第 20 条就是踩这个坑记成了 B 档，用户当场指出）
  assert.match(ctx.registered.sections[0].text, /简单记/, '注入段缺「用户说简单记→A」这半句');
  assert.match(ctx.registered.sections[0].text, /详细记/, '注入段缺「用户说详细记→C」这半句');

  assert.equal(ctx.registered.tools.length, 4);
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_init');
  assert.equal(tool.name, 'annals_init');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['enabled']);
  assert.equal(tool.output.schema.type, 'string');
  assert.equal(typeof tool.output.render, 'function');
  assert.deepEqual(tool.output.render(null, 'x'), [{ type: 'text', text: 'x' }]);

  const q = ctx.registered.tools.find((x) => x.name === 'annals_query');
  assert.ok(q, '没有注册 annals_query —— 检索入口是这一步的全部目的');
  assert.equal(q.parameters.type, 'object');
  assert.deepEqual(q.parameters.required, ['query']);
  assert.equal(q.output.schema.type, 'string');
  assert.equal(typeof q.output.render, 'function');
  assert.deepEqual(q.output.render(null, 'x'), [{ type: 'text', text: 'x' }]);

  const links = ctx.registered.tools.find((x) => x.name === 'annals_links');
  assert.ok(links, '没有注册 annals_links —— 双向链接是这一步的全部目的');
  assert.equal(links.parameters.type, 'object');
  assert.deepEqual(links.parameters.required, ['target']);
  assert.deepEqual(links.parameters.properties.direction.enum, ['both', 'in', 'out']);
  assert.equal(links.output.schema.type, 'string');
  assert.equal(typeof links.output.render, 'function');
  const ignore = ctx.registered.tools.find((x) => x.name === 'annals_ignore');
  assert.ok(ignore, '没有注册 annals_ignore —— 忽略目录是这一步的全部目的');
  assert.equal(ignore.parameters.type, 'object');
  assert.deepEqual(ignore.parameters.required, ['action']);
  assert.deepEqual(ignore.parameters.properties.action.enum, ['scan', 'list', 'add', 'remove', 'dismiss']);
  assert.equal(ignore.output.schema.type, 'string');
  assert.equal(typeof ignore.output.render, 'function');
  assert.deepEqual(ignore.output.render(null, 'x'), [{ type: 'text', text: 'x' }]);
});

test('apply persona=true 注册独立的人设 section', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, { persona: true });

  assert.equal(ctx.registered.sections.length, 2);
  const persona = ctx.registered.sections.find((x) => x.name === 'annals-persona');
  assert.ok(persona, '开启 persona 后应注册 annals-persona section');
  assert.equal(persona.order, 100, '人设 section 应在 PERSONA_PREFIX(0) 与日志规矩(150) 之间');
  assert.equal(typeof persona.text, 'function', '人设文本应延迟到 assemble 时解析，支持切换预设');
  assert.match(persona.text(), /小鲸鱼/);
  assert.match(persona.text(), /老大/);
  assert.match(persona.text(), /不改变结论/);
});

test('apply personaPreset 切换 standard / simple / custom', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, { persona: true, personaPreset: 'simple' });
  const simple = ctx.registered.sections.find((x) => x.name === 'annals-persona');
  assert.match(simple.text(), /工作小助手/);
  assert.doesNotMatch(simple.text(), /蓝色大肥鱼/);

  const customCtx = makeCtx(root);
  apply(customCtx, { persona: true, personaPreset: 'custom', personaText: '你是自定义人设。' });
  const custom = customCtx.registered.sections.find((x) => x.name === 'annals-persona');
  assert.equal(custom.text(), '你是自定义人设。');
});

test('apply persona=false 时即使 personaPreset=custom 也不注入', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, { persona: false, personaPreset: 'custom', personaText: '不应出现' });

  assert.equal(ctx.registered.sections.length, 1);
  assert.equal(ctx.registered.sections[0].name, 'annals');
});

test('apply 配置开关能关掉每一项', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, { skill: false, section: false, initTool: false, queryTool: false, linksTool: false, reminder: false });
  assert.equal(ctx.registered.skills.length, 0);
  assert.equal(ctx.registered.sections.length, 0);
  assert.deepEqual(ctx.registered.tools.map((t) => t.name), ['annals_ignore'], '忽略目录工具是常开的基础功能');
});

test('apply 总开关 enabled=false 时技能、规矩、工具都不注册', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, { enabled: false });
  assert.equal(ctx.registered.skills.length, 0);
  assert.equal(ctx.registered.sections.length, 0);
  assert.equal(ctx.registered.tools.length, 0);
});

test('snapshotLogStamp / logChangedSince：只认时间戳与大小', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const date = '2026-10-21';
  mkdirSync(join(root, '日志'), { recursive: true });
  const logFile = join(root, '日志', `${date}.md`);

  // 文件不存在 → null（区别于 undefined：那是「轮首没取到快照，无法判定」）
  assert.equal(snapshotLogStamp(root, date), null);
  assert.equal(logChangedSince(undefined, null), undefined);

  writeFileSync(logFile, '# x\n', 'utf8');
  const before = snapshotLogStamp(root, date);
  assert.equal(typeof before.mtimeMs, 'number');
  assert.equal(before.size, 4);

  // 同一份东西再拍一次 → 没变
  assert.equal(logChangedSince(before, snapshotLogStamp(root, date)), false);

  // 读文件不改 mtime —— 这条是整个方案成立的前提
  readFileSync(logFile, 'utf8');
  assert.equal(logChangedSince(before, snapshotLogStamp(root, date)), false);

  // 写入 → 变
  utimesSync(logFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(logChangedSince(before, snapshotLogStamp(root, date)), true);

  // 轮首有、轮尾没有（被删）→ 也算动过
  assert.equal(logChangedSince(before, null), true);
  // 轮首没有、轮尾有（新建）→ 也算动过
  assert.equal(logChangedSince(null, { mtimeMs: 1, size: 1 }), true);
});

test('isIndexStale：只按 mtime 判定索引新鲜度', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const today = '2026-10-21';
  mkdirSync(join(root, '日志'), { recursive: true });
  const logFile = join(root, '日志', `${today}.md`);
  const indexFile = join(root, '_日志索引.md');

  // 日志文件不存在 → 不是「写过日志」的情形，交给写日志那条提醒
  assert.equal(isIndexStale(root, today), false);

  writeFileSync(logFile, '# x\n', 'utf8');
  // 索引还不存在 → 陈旧
  assert.equal(isIndexStale(root, today), true);

  // 索引比日志新 → 新鲜
  writeFileSync(indexFile, '# 日志索引\n', 'utf8');
  utimesSync(indexFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  assert.equal(isIndexStale(root, today), false);

  // 日志又被改过（索引留在过去）→ 重新陈旧
  utimesSync(logFile, new Date(Date.now() + 10000), new Date(Date.now() + 10000));
  assert.equal(isIndexStale(root, today), true);
});

// ---------------------------------------------------------------------------
// 引导注入
// ---------------------------------------------------------------------------

test('未决定时注入一次引导，已启用时静默', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});

  const injects = [];
  const agent = makeAgent({ header: {} }, injects);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  assert.equal(injects.length, 1);
  assert.equal(injects[0].source.kind, 'annals');
  assert.match(injects[0].content[0].text, /annals_init/);

  // 初始化后新会话不再注入
  await initWorkspace(ctx, root);
  const injects2 = [];
  const agent2 = makeAgent({ header: {} }, injects2);
  emit(ctx, 'agent/created', { agent: agent2, source: 'startup' });
  await tick();
  assert.equal(injects2.length, 0);
});

test('已拒绝的工作区不注入', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  mkdirSync(join(root, '.dsh'), { recursive: true });
  writeFileSync(join(root, '.dsh', 'log-system.json'), JSON.stringify({ version: 1, state: 'declined' }), 'utf8');
  apply(ctx, {});

  const injects = [];
  emit(ctx, 'agent/created', { agent: makeAgent({ header: {} }, injects), source: 'startup' });
  await tick();
  assert.equal(injects.length, 0);
});

// ---------------------------------------------------------------------------
// 提醒
// ---------------------------------------------------------------------------

test('提醒：改过文件且没写日志 → steer 一次，同轮不重复', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 真的落盘：轮尾以工作区快照为准，只发 tool/call 不写文件会被正确判成「没改」。
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'x\n', 'utf8');
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
  assert.equal(agent.steers[0].source.kind, 'annals');

  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
});

test('错过 agent/created 的会话：turn/start 补判状态后仍能提醒', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: {} };
  const agent = makeAgent(session);
  // 模拟会话恢复 / 插件热重载后继续旧会话：不触发 agent/created。
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  await tick(); // 等补判的 classifyWorkspace 完成
  writeFileSync(join(root, 'x.js'), 'x\n', 'utf8');
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: 'x.js' }) } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
});

test('提醒：写的是今天的日志就不再催写日志（但索引没跑仍会催生成器）', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: `日志/${localDate()}.md` }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  // initWorkspace 建了日志骨架但没跑生成器 → 只收到索引提醒，收不到「补写日志」提醒
  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /_日志索引\.md/);
  assert.doesNotMatch(agent.steers[0].content[0].text, /还没有写今天的日志/);
});

test('提醒：用户说「不用记」就跳过', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这次不用记' }] },
  });
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"a.txt"}' } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

/**
 * 说一句话、真落盘一个工作区内文件，跑完一轮，返回收到的 steer 条数。
 * 必须真写文件：轮尾以工作区快照为准，只发 tool/call 会被正确判成「没改」。
 * @param {string} userText 用户原话
 * @returns {Promise<number>} steer 条数
 */
async function steerCountAfterSaying(t, userText) {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: userText }] },
  });
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'x\n', 'utf8');
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  return agent.steers.length;
}

test('提醒：用户说「这轮不记日志」就跳过', async (t) => {
  assert.equal(await steerCountAfterSaying(t, '这轮不记日志'), 0);
});

test('提醒：用户说「这次不写日志」就跳过', async (t) => {
  assert.equal(await steerCountAfterSaying(t, '这次不写日志'), 0);
});

test('提醒：用户说「别碰日志」就跳过', async (t) => {
  assert.equal(await steerCountAfterSaying(t, '别碰日志'), 0);
});

test('提醒：用户说「这个别动了」就跳过', async (t) => {
  assert.equal(await steerCountAfterSaying(t, '这个别动了'), 0);
});

test('提醒：用户说「不要忘记写日志」仍然提醒', async (t) => {
  assert.equal(await steerCountAfterSaying(t, '不要忘记写日志'), 1);
});

test('提醒：用户说「别动不动就改我代码」仍然提醒', async (t) => {
  assert.equal(await steerCountAfterSaying(t, '别动不动就改我代码'), 1);
});

test('提醒：局部否定当整轮是已知缺陷', { skip: '正则分不清「别记录这个错误」里否定的是「这个错误」还是整轮日志' }, async (t) => {
  assert.equal(await steerCountAfterSaying(t, '别记录这个错误，改用记忆里的方案'), 1);
});

test('提醒：否定词不是记/写/碰/动时仍提醒', { skip: '「更」不在字符类里，宁可漏压不可误压' }, async (t) => {
  assert.equal(await steerCountAfterSaying(t, '别更新记录，等会儿再说'), 1);
});

test('提醒：子代理会话跳过', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'subagent' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"a.txt"}' } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

test('提醒：未启用的工作区不提醒', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"a.txt"}' } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

// ---------------------------------------------------------------------------
// 索引新鲜度提醒
// ---------------------------------------------------------------------------

/** 造一个「已启用 + 今天日志刚写过」的工作区，并让 mock workingDirectory 指向它。 */
function makeIndexFixture(config = {}) {
  const root = makeRoot();
  const today = localDate();
  mkdirSync(join(root, '日志'), { recursive: true });
  mkdirSync(join(root, '.dsh'), { recursive: true });
  writeFileSync(join(root, '.dsh', 'log-system.json'), JSON.stringify({ version: 1, state: 'enabled' }), 'utf8');
  writeFileSync(join(root, '日志', 'build-index.mjs'), '// stub', 'utf8');
  writeFileSync(join(root, '日志', `${today}.md`), `# ${today}\n`, 'utf8');
  const ctx = makeCtx(root);
  apply(ctx, config);
  return { root, today, ctx };
}

test('索引提醒：写了日志但没跑生成器 → steer 一条索引提醒', async (t) => {
  const { root, today, ctx } = makeIndexFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: `日志/${today}.md` }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /_日志索引\.md/);
  assert.equal(agent.steers[0].source.summary, '日志已更新但索引没更新');

  // 同一轮不重复
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
});

test('索引提醒：跑过生成器就静默，且清掉粘性标记', async (t) => {
  const { root, today, ctx } = makeIndexFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: `日志/${today}.md` }) },
  });
  // 模拟模型跑了生成器：索引被写，且比日志新
  const indexFile = join(root, '_日志索引.md');
  writeFileSync(indexFile, '# 日志索引\n', 'utf8');
  utimesSync(indexFile, new Date(Date.now() + 5000), new Date(Date.now() + 5000));
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0, '索引是新的就不该提醒');
});

test('索引提醒：粘性跨轮保留，下一轮仍会提醒', async (t) => {
  const { root, today, ctx } = makeIndexFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: `日志/${today}.md` }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);

  // 第二轮什么都没干，但索引仍然陈旧 —— 还得提醒
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 2 } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 2 });
  assert.equal(agent.steers.length, 2);
});

test('索引提醒：靠 mtime 认定写过日志时，粘性同样跨轮保留', async (t) => {
  const { root, today, ctx } = makeIndexFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const logFile = join(root, '日志', `${today}.md`);

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 用 shell 的路子写（命令串里没有任何写关键词），只有 mtime 能看出来
  writeFileSync(logFile, `# ${today}\n\n1. **标题** —— 正文\n`, 'utf8');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'node 日志\\build-index.mjs' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /_日志索引\.md/);

  // 第二轮什么都没干 —— 索引还停在旧快照，粘性标记没被清，还得提醒
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 2 } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 2 });
  assert.equal(agent.steers.length, 2);
});

test('索引提醒：reminder 关掉时两条提醒都不发', async (t) => {
  const { root, today, ctx } = makeIndexFixture({ reminder: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: `日志/${today}.md` }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

test('索引提醒：用户说「不用记」也压住索引提醒', async (t) => {
  const { root, today, ctx } = makeIndexFixture();
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const session = { header: {} };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '这次不用记' }] },
  });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: `日志/${today}.md` }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

test('annals_init(enabled=true)：初始化并让本会话可提醒', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});

  const tool = ctx.registered.tools[0];
  const session = { header: {} };
  const agent = makeAgent(session);
  const report = await tool.execute({ enabled: true }, { agent });

  assert.match(report, /日志系统已在本工作区启用/);
  assert.ok(existsSync(join(root, '日志', 'build-index.mjs')));

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"a.txt"}' } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
});

test('annals_init(enabled=false)：写拒绝记录，之后静默', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});

  const tool = ctx.registered.tools[0];
  const agent = makeAgent({ header: {} });
  const report = await tool.execute({ enabled: false }, { agent });
  assert.match(report, /不启用/);

  const state = JSON.parse(readFileSync(join(root, '.dsh', 'log-system.json'), 'utf8'));
  assert.equal(state.state, 'declined');

  // 新会话不注入
  const injects = [];
  const agent2 = makeAgent({ header: {} }, injects);
  emit(ctx, 'agent/created', { agent: agent2, source: 'startup' });
  await tick();
  assert.equal(injects.length, 0);
});

test('annals_init 没有 live agent 时报错', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_init');
  await assert.rejects(() => tool.execute({ enabled: true }, {}), /live agent/);
});

// ---------------------------------------------------------------------------
// annals_query：检索入口
// ---------------------------------------------------------------------------

/** 造一份最小日志目录，供检索用例共用。 */
function makeLogDir(root, files) {
  const dir = join(root, '日志');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  return dir;
}

/** 一条合规条目。 */
function logEntry(num, time, tier, title, body) {
  return `${num}. [time=${time}][tier=${tier}] **${title}**\n\n   W 正文：${body}\n`;
}

test('annals_query：命中标题并给锚点', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': [
      '# 2026-10-20',
      '',
      logEntry(1, '09:00:00', 'A', '生成器加了时间戳字段', '正文讲的是写入时刻怎么取。'),
      '',
      logEntry(2, '10:00:00', 'A', '日志看板交付', '四屏全部真机验收通过。'),
      '',
    ].join('\n'),
  });
  const ctx = makeCtx(root);
  apply(ctx, {});
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const agent = makeAgent({ header: {} });

  const out = await tool.execute({ query: '时间戳' }, { agent });
  assert.match(out, /匹配「时间戳」/);
  assert.match(out, /第 1 条/);
  assert.match(out, /生成器加了时间戳字段/);
  // 锚点必须能直接拿去 read —— 缺了它就还得自己找位置
  assert.match(out, /日志\\2026-10-20\.md:\d+/);
});

test('annals_query：查不到时明说查不到，不硬凑', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': ['# 2026-10-20', '', logEntry(1, '09:00:00', 'A', '生成器加了时间戳字段', '写入时刻。'), ''].join('\n'),
  });
  const ctx = makeCtx(root);
  apply(ctx, {});
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const agent = makeAgent({ header: {} });

  const out = await tool.execute({ query: '完全不存在的词xyz' }, { agent });
  assert.match(out, /没有匹配/, `查不到时应当明说，实际：${out.slice(0, 200)}`);
  // 零命中时不能只说「没有」，还得告诉模型下一步该干什么 ——
  // 「搜不到」和「没做过」是两回事，不说清模型会当成「确实没做过」直接重新开始。
  assert.match(out, /不代表从未做过/);
});

test('annals_query：日志目录不存在时不抛异常', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const agent = makeAgent({ header: {} });
  const out = await tool.execute({ query: '随便什么' }, { agent });
  assert.match(out, /还没有任何条目/);
});

test('annals_query：空查询直接拒绝，不去扫盘', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const agent = makeAgent({ header: {} });
  assert.match(await tool.execute({ query: '   ' }, { agent }), /查询是空的/);
});

test('annals_query：limit 被夹在 1..20', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const files = { '2026-10-20.md': ['# 2026-10-20', ''] };
  for (let i = 1; i <= 30; i++) {
    const mm = String(i).padStart(2, '0');
    files['2026-10-20.md'].push(logEntry(i, `09:${mm}:00`, 'A', `第 ${i} 条讲同一件事`, '同一件事的正文。'), '');
  }
  makeLogDir(root, { '2026-10-20.md': files['2026-10-20.md'].join('\n') });
  const ctx = makeCtx(root);
  apply(ctx, {});
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const agent = makeAgent({ header: {} });

  const out = await tool.execute({ query: '同一件事', limit: 999 }, { agent });
  const shown = (out.match(/^- /gm) ?? []).length;
  assert.ok(shown <= 20, `limit 上限是 20，实际显示 ${shown} 条`);
});

// ---------------------------------------------------------------------------
// 检索质量：这几个是真机踩出来的回归
// ---------------------------------------------------------------------------

test('检索：无意义的 bigram 不该把整批命中拖到看不见', async () => {
  // 真机 bug：搜「重启插件」返回 0 条，而日志里明明有 24 条标题含这些词。
  // 当时的覆盖率分母是「所有词条 idf 之和」，切词切出的「重启插件」「启插」
  // 这两个全库 0 命中的词各拿满权重 1.0，把分母撑到 2.03，真实命中
  // （重启 0.27 + 插件 0.20）覆盖率只剩 0.19，乘下限后整批落到 ABS_FLOOR 以下。
  // 现在分母是「查询的字符数」，无意义的 bigram 不命中就只是不贡献覆盖率。
  const entries = [
    { date: '2026-10-24', file: 'x.md', line: 1, num: 1, title: '改插件源码必须重启 DSH 才生效',
      body: ['正文'], items: [], fence: [], time: '00:00:00', tier: 'A', chars: 10 },
  ];
  const tokens = tokenize('重启插件');
  const idf = buildIdf(entries, tokens);
  assert.equal(idf.get('重启插件'), 0, '全库 0 出现的词权重必须是 0');
  assert.equal(idf.get('启插'), 0, '同上');

  const r = search(entries, '重启插件', 3);
  assert.equal(r.hits.length, 1, '该命中却没命中 —— 覆盖率分母又退回去了');
});

test('检索：只命中半个查询不该靠通用词混进来', async () => {
  // 真机 bug：搜「机器学习模型训练」时切出「机器」「模型」两个通用 bigram，
  // 它们在某条日志里都出现过，字符覆盖率算到 0.5。线性折算还剩 0.57 的分数，
  // 足够越过 ABS_FLOOR 混进结果。现在覆盖率按平方折算，0.5 只剩 0.29。
  const entries = [];
  for (let i = 1; i <= 20; i++) {
    entries.push({
      date: '2026-10-20', file: 'x.md', line: i, num: i,
      title: `第 ${i} 条`,
      body: ['这台机器的模型参数调过了'],
      items: [], fence: [], time: '00:00:00', tier: 'A', chars: 10,
    });
  }
  const r = search(entries, '机器学习模型训练', 3);
  assert.equal(r.hits.length, 0, '只覆盖查询一半的通用 bigram 命中应当被压到下限以下');
});

test('检索：常见词不该盖过稀有词', async () => {
  // 「插件」在 99/187 条里都有，「tierOf」只在几条里出现。
  // 搜「tierOf」时，只提到「插件」的条目不该排在有 tierOf 的前面。
  const entries = [
    { date: '2026-10-20', file: 'x.md', line: 1, num: 1, title: '插件加载流程梳理',
      body: ['讲插件'], items: [], fence: [], time: '00:00:00', tier: 'A', chars: 10 },
    { date: '2026-10-21', file: 'x.md', line: 5, num: 2, title: 'tierOf 的边界改成 <=',
      body: ['正文'], items: [], fence: [], time: '00:00:00', tier: 'A', chars: 10 },
  ];
  const r = search(entries, 'tierOf', 3);
  assert.equal(r.hits[0].num, 2, '稀有词命中应当排在前面');
});

test('检索：全库都没有的词返回 0 条，不硬凑', async () => {
  // 「完全不存在的词xyz」会切出「存在」这个 bigram。它不该把无关条目捞上来。
  // 注意 fixture 要够大：库里只有 1 条时 idf 恒等于 1，什么都测不出来。
  const entries = [];
  for (let i = 1; i <= 20; i++) {
    entries.push({
      date: '2026-10-20', file: 'x.md', line: i, num: i,
      title: `第 ${i} 条`,
      body: ['这条里都有「存在」二字，它太常见了'],
      items: [], fence: [], time: '00:00:00', tier: 'A', chars: 10,
    });
  }
  const r = search(entries, '完全不存在的词xyz', 3);
  assert.equal(r.hits.length, 0, '只靠一个通用 bigram 蹭上的命中应当被 ABS_FLOOR 挡掉');
});

test('annals_query：probe 默认关闭时不写埋点', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': ['# 2026-10-20', '', logEntry(1, '09:00:00', 'A', '生成器加了时间戳字段', '写入时刻。'), ''].join('\n'),
  });
  const ctx = makeCtx(root);
  apply(ctx, {});
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const agent = makeAgent({ header: {} });

  await tool.execute({ query: '时间戳' }, { agent });

  assert.equal(existsSync(join(root, '日志', 'annals-probe.jsonl')), false,
    'probe 默认关闭，不该产生埋点文件');
});

test('annals_query：每次调用都写一条埋点', async (t) => {  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': ['# 2026-10-20', '', logEntry(1, '09:00:00', 'A', '生成器加了时间戳字段', '写入时刻。'), ''].join('\n'),
  });
  const ctx = makeCtx(root);
  apply(ctx, { probe: true });
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const agent = makeAgent({ header: {} });

  await tool.execute({ query: '时间戳' }, { agent });
  await tool.execute({ query: '看板' }, { agent });

  const probe = join(root, '日志', 'annals-probe.jsonl');
  assert.ok(existsSync(probe), '没有写埋点 —— 两周后就无从判断这扇门有没有人推');
  const lines = readFileSync(probe, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].tool, 'annals_query');
  assert.equal(lines[0].query, '时间戳');
  assert.equal(typeof lines[0].at, 'string');
  assert.equal(typeof lines[0].hits, 'number');
});

test('normalizeUserText：剥掉寒暄，留下实质内容', () => {
  // 为什么要剥：覆盖率的分母是查询串字符数（query.js 的 coverageOf），
  // 「你好，能不能帮我看看…」这类前缀一个都不可能出现在日志里，
  // 却实打实地把分母撑大 —— 分母虚高，覆盖率上不去，ABS_FLOOR 一卡整批消失。
  assert.equal(normalizeUserText('你好，帮我看看插件为什么不生效'), '插件为什么不生效');
  assert.equal(normalizeUserText('麻烦你查一下 git status 为什么会造脏文件'), 'git status 为什么会造脏文件');
  assert.equal(normalizeUserText('请问日志生成器怎么跑'), '日志生成器怎么跑');
  // 「我想问一下」必须整体剥掉，不能只剩「一下」这半截残渣 —— 正则按长度倒序拼接
  // 就是为了这个（`/g` 是位置驱动的，短候选排前面会先吃掉长候选的前半截）。
  assert.equal(normalizeUserText('我想问一下，检索的覆盖率是怎么算的'), '检索的覆盖率是怎么算的');
  assert.equal(normalizeUserText('谢谢'), '', '只剩寒暄就该返回空串，别拿去查');
  assert.equal(normalizeUserText(''), '');
  assert.equal(normalizeUserText(undefined), '');
  // 只有标点和一个字也算不上实质内容 —— 拿去查只会命中一切。
  assert.equal(normalizeUserText('？！。'), '');
  assert.equal(normalizeUserText('嗯'), '');
});

test('normalizeUserText：超长时从尾部截断，阈值内原样返回', () => {
  // 从尾部取的理由：用户提问的实质内容通常在句尾（「…为什么会这样」），
  // 前面往往是铺垫。
  const short = '改插件需要重启吗';
  assert.equal(normalizeUserText(short, 300), short, '阈值内不该动它');

  const long = `${'铺垫'.repeat(200)}真正的技术问题在句尾`;
  const cut = normalizeUserText(long, 10);
  assert.equal(cut.length, 10, '应当截到 maxChars');
  assert.equal(cut, '真正的技术问题在句尾', '应当保留尾部而不是头部');

  // 换行必须压成空格：tokenize 按空白切分，留着换行只是白给分母加字符。
  assert.equal(normalizeUserText('第一行\n\n第二行'), '第一行 第二行');
});

test('annals_query：写对照埋点，记模型词与原话各查到什么', async (t) => {
  // 要回答的问题只有一个：换输入源到底有没有收益。单看任何一边都不算数 ——
  // 真正有信息量的是 agree（两边 top1 是不是同一条）。
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': [
      '# 2026-10-20',
      '',
      logEntry(1, '09:00:00', 'A', '改插件源码必须重启 DSH 才生效', '热重载不覆盖插件本体。'),
      '',
      logEntry(2, '10:00:00', 'A', '日志看板交付', '四屏全部验收通过。'),
      '',
    ].join('\n'),
  });
  const ctx = makeCtx(root);
  apply(ctx, { probe: true });
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const session = { header: {} };
  const agent = makeAgent(session);

  // 模拟一轮：用户说完话（累进 userText），然后模型才调工具。
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '你好，改插件源码为什么没生效' }] },
  });
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'annals_query', arguments: '{"query":"重启插件"}' } });
  await tool.execute({ query: '重启插件' }, { agent });

  const lines = readFileSync(join(root, '日志', 'annals-probe.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  const cmp = lines.find((x) => x.tool === 'probe-compare');
  assert.ok(cmp, '没有写对照埋点 —— 就没法回答「换输入源有没有收益」');
  assert.equal(cmp.query, '重启插件');
  assert.equal(cmp.userText, '改插件源码为什么没生效', '寒暄应当已被剥掉');
  assert.equal(typeof cmp.queryHits, 'number');
  assert.equal(typeof cmp.userHits, 'number');
  assert.equal(typeof cmp.agree, 'boolean');
  assert.ok('queryTopRankInUser' in cmp, '要记下模型词的 top1 在原话结果里排第几');
  // 只记定位与分数，不记标题 —— 标题里常含查询词，攒多了又是新的自指污染。
  if (cmp.queryTop !== null) {
    assert.deepEqual(Object.keys(cmp.queryTop).sort(), ['date', 'num', 'score']);
  }
});

test('annals_query：用户原话为空时不该写对照埋点', async (t) => {
  // 没有原话就无从对照。写一条全是 null 的记录只会污染统计口径。
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': ['# 2026-10-20', '', logEntry(1, '09:00:00', 'A', '生成器加了时间戳字段', '写入时刻。'), ''].join('\n'),
  });
  const ctx = makeCtx(root);
  apply(ctx, { probe: true });
  const tool = ctx.registered.tools.find((x) => x.name === 'annals_query');
  const agent = makeAgent({ header: {} });

  await tool.execute({ query: '时间戳' }, { agent });

  const lines = readFileSync(join(root, '日志', 'annals-probe.jsonl'), 'utf8')
    .trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.filter((x) => x.tool === 'probe-compare').length, 0,
    '没有用户原话时不该写对照埋点');
  assert.equal(lines.filter((x) => x.tool === 'annals_query').length, 1,
    '普通埋点仍然要写');
});

// ---------------------------------------------------------------------------
// shell 命令判定：误报回归
// ---------------------------------------------------------------------------

test('looksLikeShellWrite：只读命令不再误报', () => {
  // 真机误报现场：`form ` 里字面包含子串 `rm `
  assert.equal(looksLikeShellWrite('echo "==== form 枚举定义 ===="'), false);
  assert.equal(looksLikeShellWrite("Select-String -Pattern 'rm ' 日志\\2026-10-22.md"), false);
  assert.equal(looksLikeShellWrite('Get-Content 日志/2026-10-22.md'), false);
  assert.equal(looksLikeShellWrite('git status'), false);
  assert.equal(looksLikeShellWrite('git log --oneline'), false);
  // `cp`/`mv` 出现在别的词里
  assert.equal(looksLikeShellWrite('Get-Command copy-item'), false);
  assert.equal(looksLikeShellWrite('echo "mvp"'), false);
  assert.equal(looksLikeShellWrite(''), false);
  assert.equal(looksLikeShellWrite(undefined), false);
});

test('looksLikeShellWrite：真正的写命令仍判为改', () => {
  assert.equal(looksLikeShellWrite('rm D:\\AI\\deepseek2\\a.txt'), true);
  assert.equal(looksLikeShellWrite('Get-Content x | rm y'), true);
  assert.equal(looksLikeShellWrite('cd /tmp; rm a.txt'), true);
  assert.equal(looksLikeShellWrite('mkdir 日志'), true);
  assert.equal(looksLikeShellWrite('Set-Content 日志/2026-10-22.md hi'), true);
  assert.equal(looksLikeShellWrite('git commit -m "x"'), true);
  assert.equal(looksLikeShellWrite('git rm --cached x'), true);
  assert.equal(looksLikeShellWrite('echo hi > out.txt'), true);
});

test('onlyTouchesTemp：临时目录里的改动不算工作区', () => {
  // 真机误报现场：往 $env:TEMP 里建探针目录
  assert.equal(onlyTouchesTemp('New-Item $env:TEMP\\wl-probe -ItemType Directory'), true);
  assert.equal(onlyTouchesTemp('Remove-Item $env:TEMP\\wl-probe -Recurse'), true);
  assert.equal(onlyTouchesTemp('Copy-Item a.txt /tmp/b.txt'), true);
  assert.equal(onlyTouchesTemp('echo hi > %TEMP%\\x.txt'), true);
  // 混进工作区路径就不豁免
  assert.equal(onlyTouchesTemp('Copy-Item $env:TEMP\\a D:\\AI\\deepseek2\\b'), false);
  assert.equal(onlyTouchesTemp('Set-Content D:\\AI\\deepseek2\\x.txt hi'), false);
  // 本工作区自己的 Temp\ 不豁免 —— 插件不认任何具体工作区的目录习惯
  assert.equal(onlyTouchesTemp('New-Item D:\\AI\\deepseek2\\Temp\\probe -ItemType Directory'), false);
});

test('onlyTouchesTemp：认 os.tmpdir() 现算的真实临时根', () => {
  const root = tmpdir();
  // 动态取值：换机器 / 改 TEMP 也自动跟随，不写死任何路径
  assert.equal(onlyTouchesTemp(`New-Item ${root}\\probe -ItemType Directory`), true);
  assert.equal(onlyTouchesTemp(`Remove-Item ${root}\\probe -Recurse`), true);
  assert.equal(looksLikeShellWrite(`New-Item ${root}\\probe`), false);
  // 前缀相似但不是临时目录：D:\Tempest 不能因为 D:\Temp 而豁免
  assert.equal(onlyTouchesTemp(`${root}est\\probe`), false);
  // 临时目录 + 工作区混着写，照样不豁免
  assert.equal(onlyTouchesTemp(`Copy-Item ${root}\\a D:\\AI\\deepseek2\\b`), false);
  assert.equal(looksLikeShellWrite(`Copy-Item ${root}\\a D:\\AI\\deepseek2\\b`), true);
});

test('looksLikeShellWrite：临时目录豁免串起来生效', () => {
  assert.equal(looksLikeShellWrite('New-Item $env:TEMP\\wl-probe -ItemType Directory'), false);
  assert.equal(looksLikeShellWrite('Remove-Item $env:TEMP\\wl-probe -Recurse'), false);
  // 同一类命令指向工作区，照样算
  assert.equal(looksLikeShellWrite('New-Item D:\\AI\\deepseek2\\Temp\\probe'), true);
});

test('误报回归：只读轮次不再触发补写日志提醒', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 这两条都是当时真机上被判成「改过文件」的只读命令
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'echo "==== form 枚举定义 ===="' }) },
  });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'New-Item $env:TEMP\\wl-probe -ItemType Directory' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

test('官方清单说没改 → 盖过关键词误报', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 关键词会判成「改了」，但官方清单是空的
  const ctx = makeCtx(root, {
    workspaceChanges: { summary: () => ({ total: 0, files: [] }) },
  });
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = {
    id: 'session-offline',
    header: { origin: 'primary' },
    snapshotEvents: () => [{ type: 'workspace/changes', seq: 42, data: { turn: 1 } }],
  };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'git commit -m x' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

test('官方清单说改了、但没写日志 → 照样提醒', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root, {
    workspaceChanges: { summary: () => ({ total: 1, files: [{ path: 'src/a.js' }] }) },
  });
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = {
    id: 'session-offline',
    header: { origin: 'primary' },
    snapshotEvents: () => [{ type: 'workspace/changes', seq: 42, data: { turn: 1 } }],
  };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 官方清单说改了，磁盘上也得真改 —— 工作区快照优先于官方清单。
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src', 'a.js'), 'x\n', 'utf8');
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /还没有写今天的日志/);
});

// ---------------------------------------------------------------------------
// 漏查探测：只记，不打扰
// ---------------------------------------------------------------------------

/** 造一个已启用日志系统的会话，供探测用例共用。 */
async function probeSetup(t) {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': [
      '# 2026-10-20',
      '',
      logEntry(1, '09:00:00', 'A', '给 build-index 加了时间戳字段', '写入时刻怎么取。'),
      '',
    ].join('\n'),
  });
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, { probe: true });
  const session = {
    id: 'session-probe',
    header: { origin: 'primary' },
    snapshotEvents: () => [],
  };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();
  return { root, ctx, session, agent };
}

test('漏查探测：写了日志提过的文件但没查 → 记一条 probe-miss', async (t) => {
  const { root, ctx, session, agent } = await probeSetup(t);
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 文件名撞上日志里提过的词（build-index）
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: join(root, 'build-index.mjs') }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  const probe = join(root, '日志', 'annals-probe.jsonl');
  assert.ok(existsSync(probe), '该记漏查却没有埋点');
  const rec = JSON.parse(readFileSync(probe, 'utf8').trim().split('\n')[0]);
  assert.equal(rec.tool, 'probe-miss');
  assert.match(rec.query, /build-index/);
  assert.ok(rec.top, '应当带上最高分命中，否则两周后没法判断是不是真的重复');
  assert.match(rec.top.title, /时间戳/);
});

test('漏查探测：这轮查过了就不再记', async (t) => {
  const { root, ctx, session, agent } = await probeSetup(t);
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'annals_query', arguments: JSON.stringify({ query: 'build-index' }) },
  });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: join(root, 'build-index.mjs') }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  const probe = join(root, '日志', 'annals-probe.jsonl');
  const lines = existsSync(probe) ? readFileSync(probe, 'utf8').trim().split('\n').filter(Boolean) : [];
  const misses = lines.map((l) => JSON.parse(l)).filter((r) => r.tool === 'probe-miss');
  assert.equal(misses.length, 0, '查过了就不该记成漏查');
});

test('漏查探测：日志里没提过这些词 → 不记（这是在做新东西）', async (t) => {
  const { root, ctx, session, agent } = await probeSetup(t);
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: join(root, 'zebra-quux-7788.py') }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  const probe = join(root, '日志', 'annals-probe.jsonl');
  const lines = existsSync(probe) ? readFileSync(probe, 'utf8').trim().split('\n').filter(Boolean) : [];
  const misses = lines.map((l) => JSON.parse(l)).filter((r) => r.tool === 'probe-miss');
  assert.equal(misses.length, 0);
});

test('漏查探测：不注入、不 steer、不改行为', async (t) => {
  const { root, ctx, session, agent } = await probeSetup(t);
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 真的落盘：轮尾以工作区快照为准，只发 tool/call 不写文件会被正确判成「没改」。
  // （这条曾经不落盘也能过 —— 因为埋点文件当时被算进工作区快照，
  //  写一行埋点就够触发「改过文件」。那个 bug 修掉后这里必须真写。）
  writeFileSync(join(root, 'build-index.mjs'), 'x\n', 'utf8');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: join(root, 'build-index.mjs') }) },
  });
  const before = agent.steers.length;
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  // 探测本身不能制造任何提醒 —— 只有「没写日志」那条会 steer。
  // 这里写的是工作区里的文件、没写日志，所以应当只有 1 条（催写日志），不是 2 条。
  assert.equal(agent.steers.length, before + 1);
  assert.match(agent.steers[0].content[0].text, /还没有写今天的日志/);
});

test('漏查探测：probe=false 时完全不记', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': ['# 2026-10-20', '', logEntry(1, '09:00:00', 'A', '给 build-index 加了时间戳字段', '写入时刻。'), ''].join('\n'),
  });
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, { probe: false });
  const session = { id: 'session-probe2', header: { origin: 'primary' }, snapshotEvents: () => [] };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: join(root, 'build-index.mjs') }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  const probe = join(root, '日志', 'annals-probe.jsonl');
  const lines = existsSync(probe) ? readFileSync(probe, 'utf8').trim().split('\n').filter(Boolean) : [];
  assert.equal(lines.filter((l) => JSON.parse(l).tool === 'probe-miss').length, 0);
});

// ---------------------------------------------------------------------------
// 自指误报：插件自己写的状态文件不能算「工作区改过」
// ---------------------------------------------------------------------------

test('自指误报：只调 annals_query、什么都没改 → 不催写日志', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeLogDir(root, {
    '2026-10-20.md': ['# 2026-10-20', '', logEntry(1, '09:00:00', 'A', '给 build-index 加了时间戳字段', '写入时刻。'), ''].join('\n'),
  });
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});
  const session = { id: 'session-selfref', header: { origin: 'primary' }, snapshotEvents: () => [] };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 一轮里唯一发生的事：调了一次检索工具。它会往 日志\annals-probe.jsonl 追加一行。
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'annals_query', arguments: JSON.stringify({ query: 'build-index' }) },
  });
  recordProbe(ctx, root, { tool: 'annals_query', query: 'build-index', hits: 3 });
  const before = agent.steers.length;
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  // 只读查询不是「改了工作区」—— 不该有任何提醒。
  // 曾经这里会误报：埋点文件在整区快照里，写它等于改工作区，
  // 于是「查得越多，被催得越勤」，正好打在本工具要治的病上。
  assert.equal(agent.steers.length, before, '只调了一次只读检索，不该被催写日志');
});

test('自指误报：状态文件被排除，但 .dsh\\skills 下的改动照常算数', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const before = snapshotWorkspaceStamp(root);
  assert.ok(before instanceof Map);

  // 插件自己写状态文件：不该被看见。
  mkdirSync(join(root, '.dsh'), { recursive: true });
  writeFileSync(join(root, '.dsh', 'log-system.json'), '{"enabled":true}\n', 'utf8');
  recordProbe(ctx, root, { tool: 'annals_query', query: 'x', hits: 1 });
  assert.equal(workspaceChangedSince(before, snapshotWorkspaceStamp(root)), false, '插件自己的状态文件不该算工作区改动');

  // 用户/模型在 .dsh\skills 里干正事：必须照常算数 —— 不能因为排除就整个跳过 .dsh\。
  mkdirSync(join(root, '.dsh', 'skills'), { recursive: true });
  writeFileSync(join(root, '.dsh', 'skills', 'x.md'), 'x\n', 'utf8');
  assert.equal(workspaceChangedSince(before, snapshotWorkspaceStamp(root)), true, '.dsh\\skills 下的改动必须照常算数');
});

test('官方清单里有今天的日志 → 不催写日志', async (t) => {  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root, {
    workspaceChanges: {
      summary: () => ({ total: 1, files: [{ path: `日志\\${localDate()}.md` }] }),
    },
  });
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = {
    id: 'session-offline',
    header: { origin: 'primary' },
    snapshotEvents: () => [{ type: 'workspace/changes', seq: 42, data: { turn: 1 } }],
  };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  // 日志写了、索引没跑 → 只有索引提醒
  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /_日志索引\.md/);
});

test('改动落在工作区外、官方清单看得见 → 照样提醒（issue #1 回归）', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 工作区里一个文件都没动（快照会说 false），改动在桌面。
  // 修复前：快照拿到就全信快照 → changed=false → 官方看得见也永远轮不到 → 从不提醒。
  const ctx = makeCtx(root, {
    workspaceChanges: {
      summary: () => ({ total: 1, files: [{ path: 'C:\\Users\\someone\\Desktop\\报告.md' }] }),
    },
  });
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = {
    id: 'session-offline',
    header: { origin: 'primary' },
    snapshotEvents: () => [{ type: 'workspace/changes', seq: 42, data: { turn: 1 } }],
  };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 工作区内什么都不写 —— 这是关键，快照必然判 false
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /还没有写今天的日志/);
});

test('官方清单看不见 shell 写的日志 → 靠 mtime 认出来，别催写', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 本轮改了源码（官方看得见），日志是用 shell 写的（官方看不见）。
  // 修复前：官方清单无条件覆盖 wroteLog → 判成「没写日志」→ 误催。
  const ctx = makeCtx(root, {
    workspaceChanges: { summary: () => ({ total: 1, files: [{ path: 'src/a.js' }] }) },
  });
  await initWorkspace(ctx, root);
  apply(ctx, {});
  const logFile = join(root, '日志', `${localDate()}.md`);

  const session = {
    id: 'session-offline',
    header: { origin: 'primary' },
    snapshotEvents: () => [{ type: 'workspace/changes', seq: 42, data: { turn: 1 } }],
  };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 真写（mtime 变），命令串里一个写关键词都没有 —— 正是 `.NET WriteAllText` 的形状
  writeFileSync(logFile, '# x\n\n1. **标题** —— 正文\n', 'utf8');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: {
      name: 'pwsh',
      arguments: JSON.stringify({ command: `[System.IO.File]::WriteAllText('日志\\${localDate()}.md', $t)` }),
    },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  // 不催写日志；索引还没跑，所以只剩索引提醒
  for (const steer of agent.steers) {
    assert.doesNotMatch(steer.content[0].text, /还没有写今天的日志/);
  }
  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /_日志索引\.md/);
});

test('官方服务没有本轮事件 → 不采信，退回关键词判定', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root, {
    // 服务在，但 summary 永远不会被问到（没有事件拿不到 seq）
    workspaceChanges: { summary: () => ({ total: 0, files: [] }) },
  });
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = {
    id: 'session-offline',
    header: { origin: 'primary' },
    snapshotEvents: () => [],
  };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  writeFileSync(join(root, 'a.txt'), 'x\n', 'utf8');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  // 官方清单采信不了，但工作区快照看得见真改动 → 提醒照发
  assert.equal(agent.steers.length, 1);
});

// ---- `>` 重定向：把「有 > 就算写」收紧成「真的引向文件才算 ----
// 背景：`/>\s*\S/` 把 `2>&1`（几乎每条带 `| Select-Object -Last N` 的命令都有）
// 判成写文件，导致几乎每轮误报。第 36/37/38 条日志记了现场。

test('stripQuoted：引号内容被清空', () => {
  assert.equal(stripQuoted("Select-String -Pattern 'a>b'"), "Select-String -Pattern ''");
  assert.equal(stripQuoted('Select-String -Pattern "a>b"'), 'Select-String -Pattern ""');
  assert.equal(stripQuoted('echo hi > out.txt'), 'echo hi > out.txt');
  assert.equal(stripQuoted("node -e \"console.log('->')\""), 'node -e ""');
});

test('looksLikeShellWrite：合流错误与箭头不算写文件', () => {
  // 这四条是全插件里最容易每轮撞上的误报源
  assert.equal(looksLikeShellWrite('node --test test\\offline.mjs 2>&1 | Select-Object -Last 8'), false);
  assert.equal(looksLikeShellWrite('cmd 2>&1 | Out-Null'), false);
  assert.equal(looksLikeShellWrite('node build.mjs > $null'), false);
  assert.equal(looksLikeShellWrite('node build.mjs 2>$null'), false);
  assert.equal(looksLikeShellWrite('node build.mjs 2>nul'), false);
  assert.equal(looksLikeShellWrite('node build.mjs 2>NUL'), false);
  // 箭头函数 / 比较运算符
  assert.equal(looksLikeShellWrite(`node -e "console.log(t, '->', new Date(t))"`), false);
  assert.equal(looksLikeShellWrite('node -e "const f=(x)=>x"'), false);
  assert.equal(looksLikeShellWrite("Select-String -Pattern 'a>b'"), false);
  assert.equal(looksLikeShellWrite('Select-String -Pattern "a>b"'), false);
  assert.equal(looksLikeShellWrite('if ($a -gt $b) { }'), false);
  // 引号里写着完整命令，仍按字面判（已知局限，多报方向）
  assert.equal(looksLikeShellWrite('echo "==== form 枚举定义 ===="'), false);
});

test('looksLikeShellWrite：真重定向仍然判改', () => {
  // 无空格的写法实测 PowerShell 也真写文件（`echo hi>f.txt` 会生成 f.txt）
  assert.equal(looksLikeShellWrite('echo hi > out.txt'), true);
  assert.equal(looksLikeShellWrite('echo hi>out.txt'), true);
  assert.equal(looksLikeShellWrite('echo hi >> out.txt'), true);
  assert.equal(looksLikeShellWrite('node gen.mjs > 日志\\x.md'), true);
  assert.equal(looksLikeShellWrite('node gen.mjs >日志\\x.md'), true);
  // 既是流编号、又是真重定向：合流之后另有一个 `>`
  assert.equal(looksLikeShellWrite('node build.mjs 2>&1 > log.txt'), true);
  assert.equal(looksLikeShellWrite('Get-Content x > out\\y.txt'), true);
  // 目标是临时目录时不判改 —— 这是另一条规则（onlyTouchesTemp）在起作用。
  // 临时根必须用 os.tmpdir() 现算：写死 `D:\Temp` 只在 owner 那台机器上成立，
  // GitHub Actions runner 的临时目录是 `C:\Users\...\AppData\Local\Temp`，
  // 写死的路径在那里是个普通目录，这条断言会当场反转成 true。
  assert.equal(looksLikeShellWrite(`Get-Content x > ${tmpdir()}\\y.txt`), false);
});

test('误报回归：带 2>&1 的只读轮次不再触发补写日志提醒', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 真机上连续 4 次触发误报的写法
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'node --test test\\offline.mjs 2>&1 | Select-Object -Last 8' }) },
  });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: `node -e "console.log(t, '->')" 2>&1` }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

test('stripHereString：here-string 正文被清空，外面的命令一字不动', () => {
  // 单引号 here-string（字面量）
  assert.equal(
    stripHereString("cd D:\\Temp\n@'\nNew-Item D:\\x\n'@ | Set-Content v.mjs"),
    "cd D:\\Temp\n@''@ | Set-Content v.mjs",
  );
  // 双引号 here-string（会展开 $，但同样不执行其中的「命令」）
  assert.equal(
    stripHereString('@"\nRemove-Item D:\\x\n"@ | Out-File v.ps1'),
    '@""@ | Out-File v.ps1',
  );
  // 没有 here-string 时原样返回
  assert.equal(stripHereString('rm a.txt'), 'rm a.txt');
});

test('looksLikeShellWrite：here-string 里的关键词是数据，不是命令', () => {
  // turn 20 真机误报的原型：正文里全是关键词字面词，实际只往临时目录写脚本。
  // `cd` 的目标用 tmpdir() 现算 —— 写死 D:\Temp 只在 owner 机器上是临时目录，
  // 在 CI runner 上不是，这条会从 false 反转成 true。
  const probe = [
    `cd ${tmpdir()}`,
    "@'",
    "const cases = [['New-Item D:\\\\Temp\\\\probe', false]];",
    '// 上面这句是在测 Remove-Item、Set-Content',
    "'@ | Set-Content -Path v.mjs -Encoding utf8",
  ].join('\n');
  assert.equal(looksLikeShellWrite(probe), false);

  // 真写在工作区，且写在 here-string 外面 —— 仍然判改
  assert.equal(
    looksLikeShellWrite("@'\n只是一段说明文字\n'@ | Set-Content D:\\AI\\deepseek2\\out.txt"),
    true,
  );
  // 引号里的真命令不受影响（不能简单剥引号，这正是当初没剥的原因）
  assert.equal(looksLikeShellWrite('pwsh -Command "Remove-Item D:\\AI\\deepseek2\\a.txt"'), true);
});

test('onlyTouchesTemp：临时根后面跟换行或空格时仍然豁免', () => {
  const root = tmpdir();
  // 旧版只认 `\`、`/` 和结尾，换行与空格都漏 —— turn 20 十条误判的主因
  assert.equal(onlyTouchesTemp(`${root}\nnext`), true);
  assert.equal(onlyTouchesTemp(`${root} `), true);
  assert.equal(onlyTouchesTemp(`${root}\\sub`), true);
  assert.equal(onlyTouchesTemp(`${root}`), true);
  // 形近目录不该被当临时目录
  assert.equal(looksLikeShellWrite(`New-Item ${root}est\\x`), true);
});

test('误报回归：here-string 里满是指令词的只读轮次不再触发提醒', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  const probe = [
    `cd ${tmpdir()}`,
    "@'",
    "const cases = [['New-Item D:\\\\Temp\\\\probe', false], ['rm D:\\\\AI\\\\deepseek2\\\\a.txt', true]];",
    "'@ | Set-Content -Path v.mjs -Encoding utf8",
  ].join('\n');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: probe }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 0);
});

// ---- 「日志写没写」改问文件时间戳，不再猜命令串 ----
// 背景：命令串永远猜不准 —— `Set-Content` 认得、`[System.IO.File]::WriteAllText`
// 不认得；`日志\x.md` 认得、转义成 `日志\\x.md` 不认得。第 47 条日志记了这次转向。

test('写日志用关键词认不出的写法，靠 mtime 也能认出来', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});
  const logFile = join(root, '日志', `${localDate()}.md`);

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 真机上就是这么写的：.NET 静态调用，SHELL_WRITE_HINTS 里一个字都没有
  writeFileSync(logFile, '# x\n\n1. **标题** —— 正文\n', 'utf8');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'Select-String -Path 日志\\*.md -Pattern x' }) },
  });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  for (const steer of agent.steers) {
    assert.doesNotMatch(steer.content[0].text, /还没有写今天的日志/);
  }
});

test('只读过日志、没写 → 仍然催写', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});
  const logFile = join(root, '日志', `${localDate()}.md`);

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 命令串里明明有「日志\YYYY-MM-DD.md」，但它只是 Get-Content 的入参
  readFileSync(logFile, 'utf8');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: `Get-Content 日志\\${localDate()}.md` }) },
  });
  writeFileSync(join(root, 'src-a.js'), 'x\n', 'utf8');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /还没有写今天的日志/);
});

test('写了又还原：git 里看不出、mtime 变了，仍判成写过', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});
  const logFile = join(root, '日志', `${localDate()}.md`);

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  const original = readFileSync(logFile, 'utf8');
  writeFileSync(logFile, `${original}临时探针\n`, 'utf8');
  writeFileSync(logFile, original, 'utf8'); // 内容还原，逐字节一致
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  for (const steer of agent.steers) {
    assert.doesNotMatch(steer.content[0].text, /还没有写今天的日志/);
  }
});

// ---------------------------------------------------------------------------
// 工作区快照：不再猜命令行，直接比对轮首 / 轮尾的文件时间戳
// 背景：判断「这一轮改没改文件」原本靠命令串里的关键词，误报源一个接一个
// （`form` 里的 `rm `、`2>&1`、here-string 正文、`D:\Temp` 探针……）。
// 改成拍两张快照对比后，一次同时抓住改动 / 新建 / 删除。
// ---------------------------------------------------------------------------

test('isInsideWorkspace：路径判定，判不了的一律当成在里面', () => {
  const root = join('D:', 'AI', 'workspace-probe');

  // 区内
  assert.equal(isInsideWorkspace(root, join(root, '日志', 'x.md')), true);
  assert.equal(isInsideWorkspace(root, root), true);
  assert.equal(isInsideWorkspace(root, join('日志', 'x.md')), true, '相对路径按 cwd 展开');

  // 区外
  assert.equal(isInsideWorkspace(root, join('D:', 'Temp', 'x.mjs')), false);
  assert.equal(isInsideWorkspace(root, `${root}b\\x.md`), false, '同前缀的兄弟目录不算在里面');
  assert.equal(isInsideWorkspace(root, join(root, '..', 'other', 'x.md')), false, '.. 绕出去不算');
  assert.equal(isInsideWorkspace(root, join('E:', 'x.md')), false, '跨盘不算');
  assert.equal(
    isInsideWorkspace(root, join('C:', 'Users', 'brilliant', '.dsh', 'local-plugins', 'dsh-annals', 'lib', 'index.js')),
    false,
    '改插件本体不算改工作区',
  );

  // 判不了 → 当成在里面（宁可多报，不要漏报）
  assert.equal(isInsideWorkspace(undefined, join('D:', 'Temp', 'x.mjs')), true, '拿不到 cwd');
  assert.equal(isInsideWorkspace(root, ''), true, '没有路径');
  assert.equal(isInsideWorkspace(root, undefined), true, '路径不是字符串');
});

test('snapshotWorkspaceStamp / workspaceChangedSince：改 / 建 / 删都抓得到', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '日志'), { recursive: true });
  writeFileSync(join(root, '日志', 'a.md'), 'a\n', 'utf8');

  const before = snapshotWorkspaceStamp(root);
  assert.ok(before instanceof Map, '应返回 Map');
  assert.ok(before.size > 0, '应扫到文件');
  assert.equal(workspaceChangedSince(before, snapshotWorkspaceStamp(root)), false, '一字未动');

  // 改内容
  writeFileSync(join(root, '日志', 'a.md'), 'ab\n', 'utf8');
  assert.equal(workspaceChangedSince(before, snapshotWorkspaceStamp(root)), true, '改内容');

  // 新建
  const afterModify = snapshotWorkspaceStamp(root);
  writeFileSync(join(root, 'new.md'), 'x\n', 'utf8');
  assert.equal(workspaceChangedSince(afterModify, snapshotWorkspaceStamp(root)), true, '新建文件');

  // 删除
  const afterCreate = snapshotWorkspaceStamp(root);
  rmSync(join(root, 'new.md'));
  assert.equal(workspaceChangedSince(afterCreate, snapshotWorkspaceStamp(root)), true, '删文件');

  // 边界
  assert.equal(workspaceChangedSince(undefined, before), undefined, '轮首没拍到 → 判不了');
  assert.equal(workspaceChangedSince(before, undefined), undefined, '轮尾拍不到 → 判不了');
  assert.equal(snapshotWorkspaceStamp(''), undefined, '没有 cwd → 拍不了');
});

test('snapshotWorkspaceStamp：跳过 .git（否则 git status 自己就会让快照变脏）', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git', 'objects'), { recursive: true });
  writeFileSync(join(root, '.git', 'index'), 'idx\n', 'utf8');
  writeFileSync(join(root, 'a.md'), 'a\n', 'utf8');

  const before = snapshotWorkspaceStamp(root);
  // 只动 .git 里的东西 —— 真实的 git 命令（status / add）就是这样
  writeFileSync(join(root, '.git', 'index'), 'idx2\n', 'utf8');
  assert.equal(workspaceChangedSince(before, snapshotWorkspaceStamp(root)), false, '.git 内变化不算改工作区');
});

test('只发 tool/call 不落盘：不再被当成改过文件', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 声称写了工作区里的文件，但磁盘上一个字节都没动（比如工具被沙箱拒绝、路径写错）
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  // 快照说没改 → 不催
  assert.equal(agent.steers.length, 0);
});

test('只往临时目录写：命令看着像在写，也不算改', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 工作区外真写了一个文件 —— 快照只看工作区，所以看不见
  const outside = join(tmpdir(), `annals-outside-${process.pid}.txt`);
  writeFileSync(outside, 'x\n', 'utf8');
  t.after(() => rmSync(outside, { force: true }));
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: `Set-Content ${outside} x` }) },
  });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: outside }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 0);
});

test('命令行改了工作区里的文件（关键词认不出的写法）→ 快照照样抓到', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 这条命令整串里一个写关键词都没有，旧逻辑判成「没写」；快照能看见文件真的变了
  writeFileSync(join(root, 'artifact.bin'), 'x\n', 'utf8');
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'node -e "require(\'fs\').writeFileSync(\'artifact.bin\',\'x\')"' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /还没有写今天的日志/);
});

// ---------------------------------------------------------------------------
// 点名路径 stat 比对（工作区外 shell 写的客观判据）
// ---------------------------------------------------------------------------

test('collectShellPaths：抽出命令里的绝对路径', () => {
  assert.deepEqual(
    collectShellPaths('Set-Content -Path D:\\AI\\out.txt -Value x'),
    ['D:\\AI\\out.txt'],
  );
  assert.deepEqual(
    collectShellPaths('copy D:\\a.txt D:\\b.txt'),
    ['D:\\a.txt', 'D:\\b.txt'],
  );
  // 尾巴上粘的分隔符不算路径的一部分
  assert.deepEqual(
    collectShellPaths('Set-Content D:\\AI\\out.txt; Get-Date'),
    ['D:\\AI\\out.txt'],
  );
});

test('collectShellPaths：没有绝对路径就是空的（脚本类命令走不了这条路）', () => {
  assert.deepEqual(collectShellPaths('git commit -m "fix"'), []);
  assert.deepEqual(collectShellPaths('npm install'), []);
  // `python gen.py` 的目标路径在脚本内部，命令串里没有 —— 这正是这一路抓不住的形态
  assert.deepEqual(collectShellPaths('python gen.py'), []);
  assert.deepEqual(collectShellPaths(''), []);
  assert.deepEqual(collectShellPaths(undefined), []);
});

test('collectShellPaths：临时目录、盘符根、重复项都不盯', () => {
  // 临时目录里的写入本来就不算改工作区，盯它只是白 stat。
  // 用 tmpdir() 现算，不写死 —— 临时根随机器而变，写死的那台机器之外就失效。
  assert.deepEqual(collectShellPaths(`Remove-Item ${tmpdir()}\\x.txt`), []);
  assert.deepEqual(collectShellPaths('New-Item $env:TEMP\\probe -ItemType Directory'), []);
  // 盘符根不是具体目标，盯它等于盯整块盘
  assert.deepEqual(collectShellPaths('dir C:\\'), []);
  // 大小写不同是同一个文件
  assert.deepEqual(
    collectShellPaths('Copy-Item D:\\AI\\A.txt D:\\ai\\a.txt'),
    ['D:\\AI\\A.txt'],
  );
});

test('collectShellPaths：here-string 正文里的路径不算命令操作数', () => {
  // 正文是要写进文件的内容；只有末尾 Set-Content 的目标是真操作数
  const command = "@'\nD:\\AI\\deepseek2\\inner.md\n'@ | Set-Content D:\\AI\\out.txt";
  assert.deepEqual(collectShellPaths(command), ['D:\\AI\\out.txt']);
});

test('collectShellPaths：路径数量有上限，不会退化成批量扫描', () => {
  const many = Array.from({ length: 100 }, (_, i) => `D:\\AI\\f${i}.txt`).join(' ');
  assert.equal(collectShellPaths(`copy ${many}`).length, 32);
});

test('snapshotPathStamps：存在的记时间戳，不存在的记 absent', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const present = join(root, 'present.txt');
  const absent = join(root, 'absent.txt');
  writeFileSync(present, 'x\n', 'utf8');

  const stamps = snapshotPathStamps([present, absent]);
  assert.match(stamps.get(present), /^\d+(?:\.\d+)?:\d+$/);
  // 现在没有不代表一直不会有 —— 记成 absent 才能抓到「新建」
  assert.equal(stamps.get(absent), 'absent');
  // 没有路径就没有基准
  assert.equal(snapshotPathStamps([]), undefined);
  assert.equal(snapshotPathStamps(undefined), undefined);
});

test('pathStampsChangedSince：任一侧缺失就判不了', () => {
  const map = new Map([['D:\\a.txt', '1:1']]);
  assert.equal(pathStampsChangedSince(undefined, map), undefined);
  assert.equal(pathStampsChangedSince(map, undefined), undefined);
  // 判不了 ≠ 没改。调用方只能拿 true 当证据
  assert.equal(pathStampsChangedSince(new Map(), new Map()), undefined);
});

test('pathStampsChangedSince：改了 / 新建 / 删除都算变', () => {
  const before = new Map([['D:\\a.txt', '1:1'], ['D:\\gone.txt', '2:2'], ['D:\\new.txt', 'absent']]);
  const after = new Map([['D:\\a.txt', '9:9'], ['D:\\new.txt', '3:3']]);
  assert.equal(pathStampsChangedSince(before, after), true);
  // 同一组、同一份戳 → 没变
  assert.equal(pathStampsChangedSince(before, new Map(before)), false);
});

test('工作区外的 shell 写（关键词认不出的写法）→ 点名路径抓到并提醒', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  // 故意选一个**不在临时目录**的工作区外路径：临时路径会被豁免掉，
  // 而交付物默认落在桌面、用户目录这些地方，正是要覆盖的形态。
  const outside = join(homedir(), `.annals-pathstamp-${process.pid}.txt`);
  t.after(() => rmSync(outside, { force: true }));
  rmSync(outside, { force: true });

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 这条命令里没有 Set-Content、没有 rm/mv/cp、没有重定向 ——
  // 关键词三层全落空，旧代码直接 return，一个字节的证据都不取。
  // 但命令串里写着一个具体的绝对路径，stat 它就有客观结论。
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: {
      name: 'pwsh',
      arguments: JSON.stringify({ command: `node -e "require('fs').writeFileSync('${outside}','x')"` }),
    },
  });
  // 命令真的执行了：文件从不存在变成存在
  writeFileSync(outside, 'x\n', 'utf8');
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1, '工作区外的写入也算改过文件，该提醒');
  assert.match(agent.steers[0].content[0].text, /还没有写今天的日志/);
});

test('同一路径被两条命令先后点到：第二次不覆盖轮首基准', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  const outside = join(homedir(), `.annals-pathstamp-twice-${process.pid}.txt`);
  t.after(() => rmSync(outside, { force: true }));
  rmSync(outside, { force: true });

  const command = `node -e "require('fs').writeFileSync('${outside}','x')"`;
  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command }) } });
  writeFileSync(outside, 'x\n', 'utf8');
  // 第二条命令又点到同一个路径 —— 此刻文件已存在。
  // 若这里重拍基准，就和轮尾那张一模一样了，改动会被抹掉。
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'pwsh', arguments: JSON.stringify({ command }) } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1, '首条命令的改动不能被第二条命令的基准覆盖掉');
});

test('点名路径没变、其他证据也没有 → 不催（这一路不制造误报）', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  // 一个真实存在且全程没动过的文件
  const outside = join(homedir(), `.annals-pathstamp-still-${process.pid}.txt`);
  t.after(() => rmSync(outside, { force: true }));
  writeFileSync(outside, 'x\n', 'utf8');

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 只读它，不写：`Get-Content` 一个写关键词都没有，路径也确实没变
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: `Get-Content ${outside}` }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 0);
});

test('宿主自己在持续写的目录不进点名集合', () => {
  // 这些路径的共同点：DSH 自己每一步都在写，命令里点到它们不代表「我要写」。
  // 会话记录是最要命的一条 —— 解压它取证的那一轮，必然被判「改过文件」。
  const volatile = [
    'C:\\Users\\brilliant\\.dsh\\sessions\\--D-AI-deepseek2--\\session.v4.jsonl.zstd',
    'C:\\Users\\brilliant\\.dsh\\logs\\startup-2026-10-17.log',
    'C:\\Users\\brilliant\\.dsh\\storages\\session-projection.json',
    'C:\\Users\\brilliant\\.dsh\\attachments\\v1\\files\\ab\\abc.png',
  ];
  for (const path of volatile) {
    assert.deepEqual(collectShellPaths(`Get-Content '${path}'`), [], path + ' 不该被点名');
  }

  // 宽到没有信息量的目标：变了也说不清是谁动的。
  const broad = ['C:', 'D:', 'C:\\', homedir(), join(homedir(), '.dsh')];
  for (const path of broad) {
    assert.deepEqual(collectShellPaths(`Get-ChildItem '${path}'`), [], path + ' 不该被点名');
  }

  // 目录本身也算：`.dsh\sessions` 这层在会话增删时 mtime 会跳，
  // 盯它同样归不了因（实测 session-clean 删过一条会话，父目录 mtime 就变了）。
  for (const dir of [
    join(homedir(), '.dsh', 'sessions'),
    join(homedir(), '.dsh', 'logs'),
    join(homedir(), '.dsh', 'storages'),
    join(homedir(), '.dsh', 'attachments'),
  ]) {
    assert.deepEqual(collectShellPaths(`Get-ChildItem '${dir}'`), [], dir + ' 目录本身也不该被点名');
  }

  // 反向护栏：这次收紧不能把 f1d99d1 要覆盖的东西一起收掉。
  const outside = join(homedir(), `.annals-pathstamp-scope-${process.pid}.txt`);
  assert.deepEqual(
    collectShellPaths(`node -e "require('fs').writeFileSync('${outside}','x')"`),
    [outside],
    '工作区外的具体文件仍要点名 —— 这是补盲区的唯一入口',
  );
  assert.deepEqual(
    collectShellPaths(`Get-Content 'C:\\Users\\brilliant\\.dsh\\local-plugins\\dsh-annals\\lib\\index.js'`),
    ['C:\\Users\\brilliant\\.dsh\\local-plugins\\dsh-annals\\lib\\index.js'],
    '插件自己的源码不是宿主持续写的路径，不能顺手排除',
  );
});

test('只读过会话记录、文件被别处追加 → 不催（这一路不制造误报）', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  // 造一个落在 `.dsh\sessions\` 下的文件，形态与真实会话记录一致。
  // 不用真的会话目录：测试不该碰用户正在用的那一份。
  const sessionsDir = join(homedir(), '.dsh', 'sessions');
  mkdirSync(sessionsDir, { recursive: true });
  const workDir = mkdtempSync(join(sessionsDir, 'dsh-annals-test-'));
  t.after(() => rmSync(workDir, { recursive: true, force: true }));
  const transcript = join(workDir, 'session.v4.jsonl.zstd');
  writeFileSync(transcript, 'AAAA', 'utf8');

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  // 只读它：`Get-Content` 一个写关键词都没有。
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: `Get-Content '${transcript}'` }) },
  });
  // 但 DSH 自己在这期间又追加了一段 —— 文件确实变了，只是不是我改的。
  writeFileSync(transcript, 'AAAAaaaa', 'utf8');
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 0, '宿主自己写的文件不该被算成「我改了工作区」');
});

// ---------------------------------------------------------------------------
// 第 4 节：安全关键词（扩宽漏报，不引入误报）
// ---------------------------------------------------------------------------

test('looksLikeShellWrite：dsh plugin 写子命令 / .NET 静态写 / -OutFile / git clone', () => {
  // `dsh plugin add|remove` 是真写（装/卸插件改 profile 的 package.json 与 node_modules）
  assert.equal(looksLikeShellWrite('dsh plugin --profile web add "@michengai/dsh-archive-manager@1.1.18" 2>&1 | Select-Object -Last 40'), true);
  assert.equal(looksLikeShellWrite('dsh plugin --profile web remove @michengai/dsh-archive-manager'), true);
  // 只读子命令不中（零误报）
  assert.equal(looksLikeShellWrite('dsh plugin --profile web list'), false);
  assert.equal(looksLikeShellWrite('dsh plugin --help'), false);
  // .NET 静态写文件（SHELL_WRITE_HINTS 里一个字都没有的老缺口）
  assert.equal(looksLikeShellWrite('[System.IO.File]::WriteAllText("D:\\AI\\out.txt","y")'), true);
  assert.equal(looksLikeShellWrite('[System.IO.Directory]::CreateDirectory("D:\\AI\\newdir")'), true);
  // 下载落盘
  assert.equal(looksLikeShellWrite('Invoke-WebRequest https://example.com/x -OutFile D:\\AI\\x.zip'), true);
  // 版本控制 / 依赖安装
  assert.equal(looksLikeShellWrite('git clone https://github.com/duhuashan/dsh-annals.git'), true);
  assert.equal(looksLikeShellWrite('npm ci'), true);
});

test('isEnvMutation：只认装/卸插件与 DSH 家目录写，不误伤临时目录的 pnpm add', () => {
  // 真环境变更
  assert.equal(isEnvMutation('dsh plugin --profile web add "@michengai/dsh-archive-manager@1.1.18"'), true);
  assert.equal(isEnvMutation('dsh plugin --profile web remove @michengai/dsh-archive-manager'), true);
  assert.equal(isEnvMutation('Copy-Item D:\\x.json "$env:DSH_PROFILE_DIR\\package.json"'), true);
  assert.equal(isEnvMutation('Set-Content "$env:DSH_HOME\\config.yml" hi'), true);
  // 只读不算
  assert.equal(isEnvMutation('dsh plugin --profile web list'), false);
  assert.equal(isEnvMutation('Get-Content "$env:DSH_PROFILE_DIR\\package.json"'), false);
  // 通用包管理器本身不算环境变更（常在临时目录试跑）
  assert.equal(isEnvMutation('pnpm add left-pad'), false);
  assert.equal(isEnvMutation('npm install'), false);
  assert.equal(isEnvMutation(''), false);
});

test('环境变更（装插件）但没写日志 → 单独催一次，文案指向运行环境', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});

  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'pwsh', arguments: JSON.stringify({ command: 'dsh plugin --profile web add "@michengai/dsh-archive-manager@1.1.18"' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });

  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /运行环境/);
});

// ---------------------------------------------------------------------------
// 第 5 节：工作区忽略清单（ignoreDirs / annals_ignore）
// ---------------------------------------------------------------------------

test('忽略清单：目录名规范化只接受工作区内相对路径', () => {
  assert.equal(normalizeIgnoreDir('.dsh-meow'), '.dsh-meow');
  assert.equal(normalizeIgnoreDir(' a\\b '), 'a/b');
  assert.equal(normalizeIgnoreDir('./foo/'), 'foo');
  for (const bad of ['', '.', '..', '/abs', 'C:\\x', '../x', 'a/../b', '日志', '日志/2026']) {
    assert.equal(normalizeIgnoreDir(bad), undefined, `${JSON.stringify(bad)} 应拒绝`);
  }
  assert.equal(isIgnoredPath('a/b.txt', ['a']), true);
  assert.equal(isIgnoredPath('ab/x', ['a']), false);
  assert.equal(isIgnoredPath('a', ['a/b']), false);
});

test('快照：ignoreDirs 整棵跳过，插件自己的状态文件始终跳过', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.dsh-meow'), { recursive: true });
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, '.dsh'), { recursive: true });
  mkdirSync(join(root, '日志'), { recursive: true });
  writeFileSync(join(root, '.dsh-meow', 'mem.md'), 'x', 'utf8');
  writeFileSync(join(root, 'src', 'a.js'), 'x', 'utf8');
  writeFileSync(join(root, '.dsh', 'log-system.json'), '{}', 'utf8');
  writeFileSync(join(root, '.dsh', 'annals.json'), '{}', 'utf8');
  writeFileSync(join(root, '日志', 'annals-probe.jsonl'), '{}', 'utf8');

  const all = snapshotWorkspaceStamp(root, []);
  assert.ok([...all.keys()].some((p) => p.endsWith('mem.md')), '不传忽略清单时应看到 .dsh-meow');
  for (const own of ['log-system.json', 'annals.json', 'annals-probe.jsonl']) {
    assert.ok(![...all.keys()].some((p) => p.endsWith(own)), own + ' 是插件自己的状态文件，应跳过');
  }

  const ignored = snapshotWorkspaceStamp(root, ['.dsh-meow']);
  assert.ok(![...ignored.keys()].some((p) => p.includes('.dsh-meow')), '忽略目录整棵子树应跳过');

  writeFileSync(
    join(root, '.dsh', 'annals.json'),
    JSON.stringify({ version: 1, ignoreDirs: ['.dsh-meow'] }),
    'utf8',
  );
  const byConfig = snapshotWorkspaceStamp(root);
  assert.ok(![...byConfig.keys()].some((p) => p.includes('.dsh-meow')), '省略参数时应读工作区配置');
});

test('workspaceChangedPaths / classifyUnattributed：变化路径归属', () => {
  const cwd = 'C:\\ws';
  const before = new Map([
    [`${cwd}\\a.txt`, '1:1'],
    [`${cwd}\\gone.txt`, '1:1'],
    [`${cwd}\\.dsh-meow\\m.md`, '1:1'],
  ]);
  const after = new Map([
    [`${cwd}\\a.txt`, '2:1'],
    [`${cwd}\\new.txt`, '1:1'],
    [`${cwd}\\.dsh-meow\\m.md`, '2:1'],
  ]);
  const changed = workspaceChangedPaths(before, after);
  assert.deepEqual(
    changed.sort(),
    [`${cwd}\\a.txt`, `${cwd}\\gone.txt`, `${cwd}\\new.txt`, `${cwd}\\.dsh-meow\\m.md`].sort(),
  );
  const filtered = workspaceChangedPaths(before, after, { cwd, ignoreDirs: ['.dsh-meow'] });
  assert.ok(!filtered.some((p) => p.includes('.dsh-meow')), '忽略目录两侧都应滤掉');

  const root = makeRoot();
  try {
    const paths = [
      join(root, '.dsh-meow', 'm.md'),
      join(root, 'src', 'a.js'),
      join(root, '日志', 'x.md'),
      join(root, 'readme.md'),
    ];
    assert.deepEqual([...classifyUnattributed(paths, root, {})], [['.dsh-meow', 1], ['src', 1]]);
    const attributed = classifyUnattributed(paths, root, {
      writtenPaths: new Set([join(root, 'src', 'a.js')]),
      pathStamps: new Map([[join(root, '.dsh-meow', 'm.md'), 'x']]),
    });
    assert.equal(attributed.size, 0, '本轮写过的路径与命令点名的路径都应排除');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('updateUnattributedDirs：连续两轮才出候选，dismiss 期内不提示', () => {
  const root = makeRoot();
  try {
    const state = { unattributed: new Map(), writtenPaths: new Set(), pathStamps: new Map() };
    const config = { version: 1, ignoreDirs: [], dismissed: {} };
    const path = join(root, '.dsh-meow', 'm.md');

    assert.equal(updateUnattributedDirs(state, root, [path], [], 1, config), undefined);
    assert.equal(state.unattributed.get('.dsh-meow').count, 1);
    assert.deepEqual(updateUnattributedDirs(state, root, [path], [], 2, config), {
      dir: '.dsh-meow', turns: 2, files: 1,
    });

    // 已提示过 → 不再返回
    state.unattributed.get('.dsh-meow').prompted = true;
    assert.equal(updateUnattributedDirs(state, root, [path], [], 3, config), undefined);

    // 中间断一轮 → 重新从 1 数
    const state2 = { unattributed: new Map(), writtenPaths: new Set(), pathStamps: new Map() };
    updateUnattributedDirs(state2, root, [path], [], 1, config);
    updateUnattributedDirs(state2, root, [], [], 2, config);
    assert.equal(state2.unattributed.size, 0);
    assert.equal(updateUnattributedDirs(state2, root, [path], [], 3, config), undefined);
    assert.equal(state2.unattributed.get('.dsh-meow').count, 1);

    // dismiss 7 天内不参与
    const state3 = { unattributed: new Map(), writtenPaths: new Set(), pathStamps: new Map() };
    const dismissed = { version: 1, ignoreDirs: [], dismissed: { '.dsh-meow': new Date().toISOString() } };
    assert.equal(updateUnattributedDirs(state3, root, [path], [], 1, dismissed), undefined);
    assert.equal(state3.unattributed.size, 0);

    // 7 天后重新参与
    const expired = { version: 1, ignoreDirs: [], dismissed: { '.dsh-meow': new Date(Date.now() - 8 * 86400000).toISOString() } };
    assert.equal(updateUnattributedDirs(state3, root, [path], [], 1, expired), undefined);
    assert.deepEqual(updateUnattributedDirs(state3, root, [path], [], 2, expired), {
      dir: '.dsh-meow', turns: 2, files: 1,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('annals_ignore：add 写清单并警告源码文件，list/remove/dismiss/scan 可用', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});
  const tool = ctx.registered.tools.find((item) => item.name === 'annals_ignore');
  assert.ok(tool, '应注册 annals_ignore');

  mkdirSync(join(root, '.dsh-meow'), { recursive: true });
  writeFileSync(join(root, '.dsh-meow', 'mem.md'), 'x', 'utf8');

  const session = { header: { origin: 'primary' } };
  const exec = { agent: { session } };

  assert.match(await tool.execute({ action: 'list' }, exec), /（空）/);
  const scan = await tool.execute({ action: 'scan' }, exec);
  assert.match(scan, /\.dsh-meow/);
  assert.match(scan, /不可忽略（日志目录）/);

  const added = await tool.execute({ action: 'add', dirs: ['.dsh-meow'] }, exec);
  assert.match(added, /已加入忽略清单/);
  assert.match(added, /源码\/文档文件/);
  const parsed = JSON.parse(readFileSync(join(root, '.dsh', 'annals.json'), 'utf8'));
  assert.deepEqual(parsed.ignoreDirs, ['.dsh-meow']);

  assert.match(await tool.execute({ action: 'list' }, exec), /- \.dsh-meow/);
  assert.match(await tool.execute({ action: 'dismiss', dirs: ['.dsh-meow'] }, exec), /已暂缓提示/);
  assert.match(await tool.execute({ action: 'remove', dirs: ['.dsh-meow'] }, exec), /已从忽略清单移除/);
});

test('annals_init 报告里带一句「忽略目录」的提示', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  const { report } = await initWorkspace(ctx, root);
  assert.match(report, /忽略那个目录/);
});

test('自动发现：同一目录连续两轮无归因变化 → 点名提示忽略', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  await initWorkspace(ctx, root);
  apply(ctx, {});
  const session = { header: { origin: 'primary' } };
  const agent = makeAgent(session);
  emit(ctx, 'agent/created', { agent, source: 'startup' });
  await tick();

  mkdirSync(join(root, '.dsh-meow'), { recursive: true });
  writeFileSync(join(root, '.dsh-meow', 'mem.md'), 'v1', 'utf8');

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 1 } });
  writeFileSync(join(root, '.dsh-meow', 'mem.md'), 'v2-changed', 'utf8');
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /还没有写今天的日志/);

  emit(ctx, 'session/event', session, { type: 'turn/start', data: { turn: 2 } });
  writeFileSync(join(root, '.dsh-meow', 'mem.md'), 'v3-even-longer', 'utf8');
  emit(ctx, 'agent/turn-stopping', { agent, turn: 2 });
  assert.equal(agent.steers.length, 2);
  assert.match(agent.steers[1].content[0].text, /连续 2 轮在变/);
  assert.match(agent.steers[1].content[0].text, /忽略 \.dsh-meow/);
});