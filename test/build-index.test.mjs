// build-index.mjs 的端到端用例：每个用例建一个临时工作区，把真实的生成器脚本
// 放进去，用 execFileSync 跑一遍，然后断言「退出码 + 输出关键字 + 索引条目数」。
//
// 为什么单独开一个文件：test/offline.mjs 里的 32 个用例测的是插件本体，
// build-index.mjs 在里面只以 `// stub` 的占位形式出现 —— 生成器逻辑零覆盖。
// 而生成器是这套日志系统里唯一真正执行约定的东西，出错没人拦得住。
//
// 运行：node --test test/build-index.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, '..', 'assets', 'build-index.mjs');

const DAY = '2026-10-22';

// 建一个临时工作区：<tmp>\日志\<文件>，并把生成器复制到 日志\ 下。
// files: { '文件名.md': '内容' }，内容按原样写（不额外加工，方便精确控字节）。
function makeWs(files, opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bi-'));
  const logDir = join(root, '日志');
  mkdirSync(logDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(logDir, name), content);
  }
  const scriptDir = opts.scriptInRoot ? root : logDir;
  if (!opts.noScript) copyFileSync(SCRIPT, join(scriptDir, 'build-index.mjs'));
  return { root, logDir };
}

// 跑生成器，返回 { code, out, index }。
// index 是索引文件内容；没生成则为 null。
function run(ws, opts = {}) {
  const scriptPath = join(opts.scriptInRoot ? ws.root : ws.logDir, 'build-index.mjs');
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [scriptPath], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  const indexPath = join(ws.root, '_日志索引.md');
  const index = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : null;
  return { code, out, index };
}

// 索引里的条目行数
function entryCount(index) {
  if (!index) return 0;
  return index.split('\n').filter((l) => l.startsWith('- ')).length;
}

// 一份最小合法日志
function log(...body) {
  return `# ${DAY}\n\n${body.join('\n\n')}\n`;
}

const CASES = [];
function cleanup(t) {
  CASES.push(t.ws.root);
}

const results = [];
test.after(() => {
  for (const dir of results) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* 忽略 */
    }
  }
});

function caseWs(files, opts) {
  const ws = makeWs(files, opts);
  results.push(ws.root);
  return ws;
}

// ── 正常路径 ────────────────────────────────────────────────

test('正常两条：索引 2 条、exit 0', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('1. **甲** —— 正文甲。', '2. **乙** —— 正文乙。') });
  const r = run(ws);
  assert.equal(r.code, 0);
  assert.equal(entryCount(r.index), 2);
  assert.match(r.index, /甲 · 日志\\2026-10-22\.md:3/);
});

test('缩进的非加粗子项是合法的', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log('1. **甲** —— 正文。', '   - **要点**：细节'),
  });
  const r = run(ws);
  assert.equal(r.code, 0);
  assert.equal(entryCount(r.index), 1);
});

// ── 问题 1、2：代码围栏 ──────────────────────────────────────

test('代码围栏里的条目不被收录', () => {
  const fence = '```markdown';
  const ws = caseWs({
    [`${DAY}.md`]: log(
      '1. **真条目** —— 真的。',
      [fence, '2. **这是给用户看的格式示例** —— 不是真条目。', '```'].join('\n'),
    ),
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1, '围栏里的示例不该进索引');
  assert.doesNotMatch(r.index, /格式示例/);
});

test('代码围栏里缩进加粗的示例不误报 FAIL', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log(
      '1. **甲** —— 正文。',
      ['```', '   5. **代码块里缩进加粗**', '```'].join('\n'),
    ),
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1);
});

test('代码围栏没闭合会报 WARN', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log('1. **甲** —— 正文。', ['```', '2. **乙** —— 被吞。'].join('\n')),
  });
  const r = run(ws);
  assert.match(r.out, /代码围栏没有闭合/);
  assert.equal(entryCount(r.index), 1);
});

// ── 问题 3、4：写法不规范的条目 ──────────────────────────────

test('全角数字编号会 FAIL，不静默吞掉', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('１. **甲** —— 正文。') });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /条目写法不规范/);
  assert.equal(entryCount(r.index), 0);
});

test('缺空格的 1.**甲** 会 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('1.**甲** —— 正文。') });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /条目写法不规范/);
});

test('顿号 1、**甲** 会 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('1、**甲** —— 正文。') });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /条目写法不规范/);
});

// ── 问题 5：BOM ────────────────────────────────────────────

test('UTF-8 BOM 被剥离且不误报日期标题', () => {
  const ws = caseWs({ [`${DAY}.md`]: `\uFEFF${log('1. **甲** —— 正文。')}` });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1);
  assert.match(r.out, /剥离 UTF-8 BOM/);
  // 落盘后 BOM 应当没了
  const after = readFileSync(join(ws.logDir, `${DAY}.md`), 'utf8');
  assert.equal(after.startsWith('\uFEFF'), false);
});

// ── 问题 6、7：编号文案 ──────────────────────────────────────

test('编号重复说「重复」，不出现负数', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log('1. **甲** —— 一。', '1. **乙** —— 二。', '2. **丙** —— 三。'),
  });
  const r = run(ws);
  assert.equal(r.code, 0);
  assert.match(r.out, /编号 1 重复/);
  assert.doesNotMatch(r.out, /缺 -/);
});

test('编号倒序说「比上一条小」，不出现负数', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('2. **甲** —— 一。', '1. **乙** —— 二。') });
  const r = run(ws);
  assert.equal(r.code, 0);
  assert.match(r.out, /编号 1 比上一条 2 小/);
  assert.doesNotMatch(r.out, /缺 -/);
});

test('编号跳号仍然报缺几条', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('1. **甲** —— 一。', '4. **乙** —— 二。') });
  const r = run(ws);
  assert.match(r.out, /编号从 1 跳到 4（缺 2 条）/);
});

// ── 问题 8：位置校验 ────────────────────────────────────────

test('脚本放在无关子目录会报错退出（无 日志\\ 子目录时）', () => {
  const outer = mkdtempSync(join(tmpdir(), 'bi-outer-'));
  results.push(outer);
  mkdirSync(join(outer, '日志'), { recursive: true });
  writeFileSync(join(outer, '日志', `${DAY}.md`), log('1. **甲** —— 正文。'));
  const other = join(outer, '随便');
  mkdirSync(other, { recursive: true });
  copyFileSync(SCRIPT, join(other, 'build-index.mjs'));
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(other, 'build-index.mjs')], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  assert.equal(code, 1);
  assert.match(out, /找不到工作区/);
});

// ── 问题 9、10：崩溃友好化 ──────────────────────────────────

test('同名目录不会喷栈，报「这是个目录」', () => {
  const ws = makeWs({});
  results.push(ws.root);
  mkdirSync(join(ws.logDir, `${DAY}.md`), { recursive: true });
  copyFileSync(SCRIPT, join(ws.logDir, 'build-index.mjs'));
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /这是个目录，不是文件/);
  assert.doesNotMatch(r.out, /EISDIR.*at /);
});

// ── 问题 11：只有坏名文件 ───────────────────────────────────

test('只有坏名文件时报「文件名不合规范」而非「找不到工作区」', () => {
  const ws = makeWs({ [`${DAY}-补充.md`]: log('1. **甲** —— 正文。') });
  results.push(ws.root);
  copyFileSync(SCRIPT, join(ws.logDir, 'build-index.mjs'));
  const r = run(ws);
  assert.match(r.out, /文件名不合规范/);
  assert.doesNotMatch(r.out, /找不到工作区/);
});

// ── 问题 12：概览变体 ──────────────────────────────────────

test('**概览**：加粗形式也能抓到', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('**概览**：今天干了三件大事。', '1. **甲** —— 正文。') });
  const r = run(ws);
  assert.match(r.out, /出现了「概览」行/);
});

// ── 问题 13：日期标题前导空格 ───────────────────────────────

test('日期标题带前导空格不报 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `  # ${DAY}\n\n1. **甲** —— 正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1);
});

// ── 问题 14：非法日期 ──────────────────────────────────────

test('2026-13-45.md 会 FAIL', () => {
  const ws = caseWs({ '2026-13-45.md': '# 2026-13-45\n\n1. **甲** —— 正文。\n' });
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /日期不存在/);
});

// ── 问题 15：编码 ──────────────────────────────────────────

test('非 UTF-8 字节会 WARN', () => {
  const ws = makeWs({});
  results.push(ws.root);
  // GBK 编码的「标题」两字：0xB1 0xEA 0xCC 0xE2
  const head = Buffer.from(`# ${DAY}\n\n1. **`, 'utf8');
  const gbk = Buffer.from([0xb1, 0xea, 0xcc, 0xe2]);
  const tail = Buffer.from(`** —— 正文。\n`, 'utf8');
  writeFileSync(join(ws.logDir, `${DAY}.md`), Buffer.concat([head, gbk, tail]));
  copyFileSync(SCRIPT, join(ws.logDir, 'build-index.mjs'));
  const r = run(ws);
  assert.match(r.out, /疑似非 UTF-8/);
});

// ── 原有防线回归 ───────────────────────────────────────────

test('\\r\\r\\n 被收敛成 CRLF', () => {
  const ws = makeWs({});
  results.push(ws.root);
  const body = `# ${DAY}\r\r\n\r\r\n1. **甲** —— 正文。\r\r\n`;
  writeFileSync(join(ws.logDir, `${DAY}.md`), body);
  copyFileSync(SCRIPT, join(ws.logDir, 'build-index.mjs'));
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  const after = readFileSync(join(ws.logDir, `${DAY}.md`), 'utf8');
  assert.equal(after.replace(/\r\n/g, '').includes('\r'), false, '不该残留孤立 CR');
});

test('缩进加粗的条目 FAIL（围栏外）', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('1. **甲** —— 正文。', '   2. **乙** —— 缩进加粗。') });
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /缩进的条目加了粗/);
});

test('未加粗的条目 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('1. 甲 —— 未加粗。') });
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /条目未加粗/);
});

test('条目间缺空行 WARN', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. **甲** —— 一。\n2. **乙** —— 二。\n` });
  const r = run(ws);
  assert.match(r.out, /之间没有空行/);
});

test('标题后没有正文 WARN', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. **甲**\n\n` });
  const r = run(ws);
  assert.match(r.out, /标题后没有正文/);
});

test('单日再长也不报超长 WARN（2026-10-22 取消该检查）', () => {
  const big = 'x'.repeat(20050);
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. **甲** —— ${big}\n` });
  const r = run(ws);
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /20,000|超过建议/);
  assert.match(r.out, /1 条/);
});

test('日期标题与文件名不一致 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: '# 2026-10-23\n\n1. **甲** —— 正文。\n' });
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /不一致/);
});

test('空文件 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: '' });
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /空文件/);
});

test('幂等：跑两次索引内容一致', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('1. **甲** —— 正文。') });
  const first = run(ws);
  const second = run(ws);
  assert.equal(first.index, second.index);
  assert.equal(second.code, 0);
});

test('脚本放工作区根（B 情形）也能工作', () => {
  const root = mkdtempSync(join(tmpdir(), 'bi-root-'));
  results.push(root);
  mkdirSync(join(root, '日志'), { recursive: true });
  writeFileSync(join(root, '日志', `${DAY}.md`), log('1. **甲** —— 正文。'));
  copyFileSync(SCRIPT, join(root, 'build-index.mjs'));
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [join(root, 'build-index.mjs')], { encoding: 'utf8', stdio: 'pipe' });
  } catch (err) {
    code = err.status ?? 1;
    out = `${err.stdout || ''}${err.stderr || ''}`;
  }
  assert.equal(code, 0, out);
  assert.equal(entryCount(readFileSync(join(root, '_日志索引.md'), 'utf8')), 1);
});
