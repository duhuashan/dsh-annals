// dsh-worklog 端到端沙箱模拟测试 —— 用真实磁盘复现「新工作区初始化」。
//
// 背景：dsh-fs-sandbox 后端对 writeText 的默认策略是 workspace-write +
// 进程 cwd；插件直调 ctx.fs 时若省略沙箱策略，在别的工作区写入会被拒。
// 本脚本用真实 node:fs 加一层沙箱模拟（拒绝 workspaceRoot 之外的写入），
// 验证：
//   1. 旧行为（不传策略）会被拒 —— 证明 bug 真实存在；
//   2. 修复后的 initWorkspace 会传会话策略，能成功写入；
//   3. 写入后直接跑 build-index.mjs 能 exit 0 并生成 _日志索引.md。
//   4. 初始化不在工作区创建 _文档架构.md 等其他文件。
//
// 运行：node test/e2e-sandbox.mjs
// 目标目录默认 %TEMP%\worklog-e2e-<pid>，可用第一个参数指定。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';

import { initWorkspace, localDate } from '../lib/index.js';

const root = process.argv[2] ?? join(tmpdir(), `worklog-e2e-${process.pid}`);
rmSync(root, { recursive: true, force: true });
mkdirSync(root, { recursive: true });

/** 模拟 fs-sandbox 的默认策略：workspace-write + 进程 cwd。 */
const DEFAULT_POLICY = { mode: 'workspace-write', workspaceRoot: process.cwd() };

/** 模拟会话的 standing policy：workspace-write + 会话 cwd。 */
const SESSION_POLICY = { mode: 'workspace-write', workspaceRoot: root, sessionId: 'e2e-session' };

/** @param {string} child @param {string} parent */
function isUnder(child, parent) {
  const c = resolvePath(child).toLowerCase();
  const p = resolvePath(parent).toLowerCase();
  return c === p || c.startsWith(p.endsWith('\\') ? p : p + '\\');
}

/** 真实写文件的 fs 服务，带沙箱检查。 */
function makeFs(sink) {
  return {
    async resolve(p, opts = {}) {
      return { path: resolvePath(opts.cwd ?? root, p) };
    },
    processPath(target) {
      return target.path;
    },
    async stat(target) {
      if (!existsSync(target.path)) return undefined;
      return { kind: 'file' };
    },
    async readText(target) {
      return readFileSync(target.path, 'utf8');
    },
    async writeText(target, content, _expected, _signal, policy) {
      const effective = policy ?? DEFAULT_POLICY;
      sink.push({ path: target.path, hasPolicy: policy !== undefined });
      const allowed = effective.mode === 'danger-full-access' || isUnder(target.path, effective.workspaceRoot);
      if (!allowed) {
        throw new Error(`file access denied under ${effective.mode} mode: ${target.path}`);
      }
      mkdirSync(dirname(target.path), { recursive: true });
      writeFileSync(target.path, content, 'utf8');
      return { operation: 'create' };
    },
  };
}

/** 真实执行 git init 的 shell 服务。 */
const shell = {
  calls: [],
  resolve({ command, workdir, sandboxPolicy }) {
    const spec = { command, workdir, sandboxPolicy };
    this.calls.push(spec);
    return spec;
  },
  async execute(spec) {
    try {
      const stdout = execFileSync(spec.command, {
        cwd: spec.workdir,
        shell: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return {
        result: async () => ({ exitCode: 0, stdout: { text: stdout, truncated: false }, stderr: { text: '', truncated: false } }),
      };
    } catch (error) {
      return {
        result: async () => ({
          exitCode: error.status ?? 1,
          stdout: { text: '', truncated: false },
          stderr: { text: String(error.stderr ?? error.message), truncated: false },
        }),
      };
    }
  },
};

/** @param {object} extra */
function makeCtx(extra = {}) {
  const writes = [];
  return {
    writes,
    fs: makeFs(writes),
    shell,
    get(name) {
      if (name === 'sandboxPolicy') {
        return { resolve: () => SESSION_POLICY };
      }
      return undefined;
    },
    logger: { info() {}, warn() {} },
    ...extra,
  };
}

const checks = [];
/** @param {string} label @param {boolean} ok @param {string} [detail] */
function check(label, ok, detail = '') {
  checks.push({ label, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
}

// ---------------------------------------------------------------------------
// 1. 旧行为：不传策略的裸写入会被沙箱拒绝
// ---------------------------------------------------------------------------
{
  const ctx = makeCtx();
  let denied = false;
  try {
    const target = await ctx.fs.resolve('probe.txt', { cwd: root });
    await ctx.fs.writeText(target, 'x');
  } catch (error) {
    denied = /denied/.test(String(error));
  }
  check('旧行为（不传 policy）在外部工作区被拒', denied);
}

// ---------------------------------------------------------------------------
// 2. 修复后的 initWorkspace：全部写入带上会话策略
// ---------------------------------------------------------------------------
const ctx = makeCtx();
const { created, kept } = await initWorkspace(ctx, root, { id: 'e2e-session' });
const today = localDate();

check('所有写入都带了 sandboxPolicy', ctx.writes.length > 0 && ctx.writes.every((w) => w.hasPolicy), `writes=${ctx.writes.length}`);
check('git init 带了 sandboxPolicy', shell.calls.length > 0 && shell.calls.every((c) => c.sandboxPolicy !== undefined && c.sandboxPolicy.workspaceRoot === root), `calls=${shell.calls.length}`);
check('日志目录已建', existsSync(join(root, '日志')), '');
check('.gitattributes 已建', existsSync(join(root, '日志', '.gitattributes')), '');
check('build-index.mjs 已建', existsSync(join(root, '日志', 'build-index.mjs')), '');
check('当天日志骨架已建', existsSync(join(root, '日志', `${today}.md`)));
check('不创建 _文档架构.md', !existsSync(join(root, '_文档架构.md')));
check('状态文件 state=enabled', (() => {
  const state = JSON.parse(readFileSync(join(root, '.dsh', 'log-system.json'), 'utf8'));
  return state.state === 'enabled' && state.version === 1;
})());
check('日志 .git 已初始化', existsSync(join(root, '日志', '.git')));
check('created 清单不含 _文档架构.md', !created.includes('_文档架构.md'));

// ---------------------------------------------------------------------------
// 3. 写入后直接跑生成器（先写一条日志，验证索引真的收录）
// ---------------------------------------------------------------------------
{
  writeFileSync(join(root, '日志', `${today}.md`), `# ${today}\n\n1. **测试条目** —— 端到端验证。\n`, 'utf8');
  let exitCode = -1;
  let output = '';
  try {
    output = execFileSync(process.execPath, [join(root, '日志', 'build-index.mjs')], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    exitCode = 0;
  } catch (error) {
    exitCode = error.status ?? 1;
    output = String(error.stdout ?? '') + String(error.stderr ?? error.message);
  }
  check('build-index.mjs exit 0', exitCode === 0, output.trim().split('\n').slice(-1)[0]);
  check('_日志索引.md 已生成', existsSync(join(root, '_日志索引.md')));
  const index = existsSync(join(root, '_日志索引.md')) ? readFileSync(join(root, '_日志索引.md'), 'utf8') : '';
  check('_日志索引.md 含日期标题', index.includes(today.slice(5)));
}

// ---------------------------------------------------------------------------
// 4. 幂等：再跑一次不覆盖
// ---------------------------------------------------------------------------
{
  const ctx2 = makeCtx();
  const second = await initWorkspace(ctx2, root, { id: 'e2e-session' });
  check('二次初始化不覆盖已存在文件', second.kept.includes('日志/build-index.mjs'));
  check('二次初始化不重复 git init', second.created.every((p) => p !== '日志/.git'));
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${failed.length === 0 ? '✓ 全部通过' : `✗ ${failed.length} 项失败`}（${checks.length} 项检查）`);
console.log(`目标目录：${root}`);
process.exitCode = failed.length === 0 ? 0 : 1;
