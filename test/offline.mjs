// dsh-worklog 离线测试 —— 不需要 DSH 宿主，mock 掉 ctx 的六个服务。
// 运行：node --test test/offline.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, statSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  isIndexStale,
  looksLikeShellWrite,
  onlyTouchesTemp,
  stripQuoted,
  stripHereString,
} from '../lib/index.js';

// ---------------------------------------------------------------------------
// 脚手架：临时工作区 + mock 服务
// ---------------------------------------------------------------------------

/** @returns {string} 一次性的工作区根。 */
function makeRoot() {
  return mkdtempSync(join(tmpdir(), 'dsh-worklog-test-'));
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
  assert.equal(name, 'worklog');
  assert.deepEqual(inject, ['skills', 'systemPrompt', 'tools', 'fs', 'shell', 'workingDirectory']);
});

test('Config：导出 Standard Schema，validate 填充默认值', () => {
  // Loader 用 Config["~standard"].validate(config) 校验并填默认值（cordis/lib/index.js:956-958）；
  // GUI 设置表单只投影 volatile 字段（dsh-settings 的 volatileForm）。
  assert.ok(Config, '应导出 Config');
  assert.equal(Config['~standard'].vendor, 'schemastery');

  // 六个字段必须都是 volatile，否则 settings.describe() 里不会出现 worklog 命名空间。
  for (const field of ['enabled', 'skill', 'section', 'reminder', 'initTool', 'skipSubagents']) {
    assert.equal(Config.dict[field].meta.volatile, true, field + ' 应为 volatile');
  }

  const defaults = Config['~standard'].validate({});
  assert.equal(defaults.issues, undefined);
  // volatile 字段的值是运行时引用对象（cosmokit createVolatile），要 get() 解包。
  for (const field of ['enabled', 'skill', 'section', 'reminder', 'initTool', 'skipSubagents']) {
    assert.equal(typeof defaults.value[field].get, 'function', field + ' 应是引用对象');
    assert.equal(defaults.value[field].get(), true, field + ' 默认应为 true');
  }

  const custom = Config['~standard'].validate({ reminder: false });
  assert.equal(custom.value.reminder.get(), false);
  assert.equal(custom.value.enabled.get(), true);
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

test('makeUserMessage：user + notice + worklog 来源', () => {
  const message = makeUserMessage('正文', '摘要');
  assert.equal(message.role, 'user');
  assert.equal(message.content[0].text, '正文');
  assert.equal(message.source.kind, 'worklog');
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
  assert.equal(skill.name, 'worklog');
  assert.equal(skill.source, 'dsh-worklog', 'source 缺失会让 skill 工具加载时报 source must be a string');
  assert.ok(skill.content.length > 2500, `技能正文太短：${skill.content.length}`);
  assert.ok(skill.description.length <= 500, `描述超 500 字符：${skill.description.length}`);

  assert.equal(ctx.registered.sections.length, 1);
  assert.equal(ctx.registered.sections[0].name, 'worklog');
  assert.match(ctx.registered.sections[0].text, /日志系统/);

  assert.equal(ctx.registered.tools.length, 1);
  const tool = ctx.registered.tools[0];
  assert.equal(tool.name, 'worklog_init');
  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.required, ['enabled']);
  assert.equal(tool.output.schema.type, 'string');
  assert.equal(typeof tool.output.render, 'function');
  assert.deepEqual(tool.output.render(null, 'x'), [{ type: 'text', text: 'x' }]);
});

test('apply 配置开关能关掉每一项', (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, { skill: false, section: false, initTool: false, reminder: false });
  assert.equal(ctx.registered.skills.length, 0);
  assert.equal(ctx.registered.sections.length, 0);
  assert.equal(ctx.registered.tools.length, 0);
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
  assert.equal(injects[0].source.kind, 'worklog');
  assert.match(injects[0].content[0].text, /worklog_init/);

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
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
  assert.equal(agent.steers[0].source.kind, 'worklog');

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

test('worklog_init(enabled=true)：初始化并让本会话可提醒', async (t) => {
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
  emit(ctx, 'session/event', session, { type: 'tool/call', data: { name: 'write', arguments: '{"file_path":"a.txt"}' } });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
});

test('worklog_init(enabled=false)：写拒绝记录，之后静默', async (t) => {
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

test('worklog_init 没有 live agent 时报错', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ctx = makeCtx(root);
  apply(ctx, {});
  const tool = ctx.registered.tools[0];
  await assert.rejects(() => tool.execute({ enabled: true }, {}), /live agent/);
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
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  assert.equal(agent.steers.length, 1);
  assert.match(agent.steers[0].content[0].text, /还没有写今天的日志/);
});

test('官方清单里有今天的日志 → 不催写日志', async (t) => {
  const root = makeRoot();
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

test('官方清单看不见 shell 写的日志 → 关键词说写过就别催写日志', async (t) => {
  const root = makeRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // 本轮改了源码（官方看得见），日志是用 shell 写的（官方看不见）。
  // 修复前：官方清单无条件覆盖 wroteLog → 判成「没写日志」→ 误催。
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
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: {
      name: 'pwsh',
      arguments: JSON.stringify({ command: `Set-Content 日志\\${localDate()}.md 'x'` }),
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
  emit(ctx, 'session/event', session, {
    type: 'tool/call',
    data: { name: 'write', arguments: JSON.stringify({ file_path: 'src/a.js' }) },
  });
  emit(ctx, 'agent/turn-stopping', { agent, turn: 1 });
  // 采信不了官方清单时，write 工具照样算改过，提醒照发
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
  // 目标是临时目录时不判改 —— 这是另一条规则（onlyTouchesTemp）在起作用
  assert.equal(looksLikeShellWrite('Get-Content x > D:\\Temp\\y.txt'), false);
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
  // turn 20 真机误报的原型：正文里全是关键词字面词，实际只往临时目录写脚本
  const probe = [
    'cd D:\\Temp',
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
    'cd D:\\Temp',
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