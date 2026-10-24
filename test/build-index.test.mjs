// build-index.mjs 的端到端用例：每个用例建一个临时工作区，把真实的生成器脚本
// 放进去，用 execFileSync 跑一遍，然后断言「退出码 + 输出关键字 + 索引条目数」。
//
// 为什么单独开一个文件：test/offline.mjs 里的用例测的是插件本体，
// build-index.mjs 在里面只以 `// stub` 的占位形式出现 —— 生成器逻辑零覆盖。
// 而生成器是这套日志系统里唯一真正执行约定的东西，出错没人拦得住。
//
// 2026-10-25 骨架结构化改造后，用例里的 fixture 全部换成新格式（条目行 + 正文段 + 子项），
// 并补了十来条针对新规则的用例（未归类行、空行位置、正文段缺失/重复/缩进）。
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
  const argv = opts.argv ? [scriptPath, ...opts.argv] : [scriptPath];
  let code = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, argv, { encoding: 'utf8', stdio: 'pipe' });
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

// ── fixture 构造 ────────────────────────────────────────────

// 一条合规条目：条目行 + 空行 + 正文段 + （有子项时空行 + 子项）。
// 缩进 = 编号位数 + 2（`1. ` → 3 空格，`10. ` → 4 空格）。
// 2026-10-25 起条目必带 `[time=]`：这里默认注入一个按**调用顺序**递增的合法时刻，
// 于是「编号倒序」这类用例不会顺带撞上「时刻倒退」。要测缺字段/形状/倒退，
// 直接在 title 里自带 `[time=…]`（以 `[` 开头就不再注入）。
let seq = 0;
function e(num, title, body, ...items) {
  const pad = ' '.repeat(String(num).length + 2);
  const head = title.startsWith('[') ? title : `[time=00:00:${String(seq % 60).padStart(2, '0')}] ${title}`;
  seq++;
  const block = [`${num}. ${head}`, '', `${pad}正文：${body}`];
  if (items.length) {
    block.push('');
    for (const it of items) block.push(`${pad}- ${it}`);
  }
  return block.join('\n');
}

// 一整个日志文件：日期标题 + 若干条目（之间正好一个空行）。
// 结尾把 seq 归零，让每个用例的第一个条目都从 00:00:00 起。
function log(...blocks) {
  const s = `# ${DAY}\n\n${blocks.join('\n\n')}\n`;
  seq = 0;
  return s;
}

// 一份「最小合法日志」：一条
function one(title = '**甲**', body = '正文甲。') {
  return log(e(1, title, body));
}

// 子项里嵌的围栏块。围栏行缩进 = W+2 = 编号位数 + 4（`1. ` 的 W 是 3，围栏 5 空格）。
// 注意围栏必须紧跟在子项行后面（中间不空行）—— 围栏是子项内容的延伸，
// 空行插在 item 与 fence 之间会被判成「空行位置不对」。
function fenceIn(num, code, lang = '') {
  const pad = ' '.repeat(String(num).length + 4);
  const opener = `${pad}\`\`\`${lang}`;
  const lines = code.split('\n').map((l) => (l === '' ? l : pad + l));
  return [opener, ...lines, `${pad}\`\`\``].join('\n');
}

// 一条带围栏子项的条目：条目行 + 空行 + 正文段 + 空行 + 子项行 + 围栏块（紧邻）
function eFence(num, title, body, code, lang = '') {
  const pad = ' '.repeat(String(num).length + 2);
  const head = title.startsWith('[') ? title : `[time=00:00:${String(seq % 60).padStart(2, '0')}] ${title}`;
  seq++;
  return [`${num}. ${head}`, '', `${pad}正文：${body}`, '', `${pad}- 示例：`, fenceIn(num, code, lang)].join('\n');
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
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '正文甲。'), e(2, '**乙**', '正文乙。')) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 2);
  assert.match(r.index, /甲 · 日志\\2026-10-22\.md 第 1 条/);
});

test('子项是合法的（正文段之后的缩进 - ）', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '正文。', '**要点**：细节')) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1);
});

test('一位编号与两位编号的缩进各自正确', () => {
  // 1 → 3 空格；10 → 4 空格。两者同时出现时都必须被认成子项而不是未归类行。
  const blocks = [];
  for (let i = 1; i <= 10; i++) blocks.push(e(i, `**第 ${i} 条**`, `正文 ${i}。`, `子项 ${i}`));
  const ws = caseWs({ [`${DAY}.md`]: log(...blocks) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 10);
  assert.match(r.out, /unclassified 0/);
});

test('条目行可带方括号字段', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '[time=14:32:05][tier=B] **甲**', '正文。')) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1);
  assert.match(r.index, /甲 · 日志/);
});

// ── 写入时刻（2026-10-25 起必填）─────────────────────────────

test('索引行带写入时刻：照抄字段，不截到分', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '正文。')) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.match(r.index, /- 10-22 00:00:00  甲 · 日志\\2026-10-22\.md 第 1 条/);
});

test('缺写入时刻 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. **丙**\n\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /第 1 条缺写入时刻/);
});

test('写入时刻形状非法 FAIL（未补零 / 超出 24 小时）', () => {
  for (const bad of ['9:05:00', '25:00:00', '09:05', '09:05:61', '090500']) {
    const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=${bad}] **丙**\n\n   正文：正文。\n` });
    const r = run(ws);
    assert.equal(r.code, 1, `${bad} 应 FAIL`);
    assert.match(r.out, /写入时刻「/, `${bad} 应报形状错`);
  }
});

test('同日写入时刻倒退 FAIL', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log(e(1, '[time=09:00:00] **甲**', '一。'), e(2, '[time=08:00:00] **乙**', '二。')),
  });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /第 2 条的写入时刻 08:00:00 早于上一条的 09:00:00/);
});

test('跨零点的往回走合法（10-20 写到次日 00:07 是常事）', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log(e(1, '[time=23:56:16] **甲**', '一。'), e(2, '[time=00:07:33] **乙**', '二。')),
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 2);
});

test('同一秒写多条是合法的（一批日志如实同秒）', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log(e(1, '[time=09:00:00] **甲**', '一。'), e(2, '[time=09:00:00] **乙**', '二。')),
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 2);
});

test('无子项的条目也合法（正文段后直接下一条）', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '一。'), e(2, '**乙**', '二。')) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 2);
});

// ── 代码围栏 ────────────────────────────────────────────────

test('代码围栏里的条目不被收录', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log(
      eFence(1, '**真条目**', '真的。', '2. **这是给用户看的格式示例** —— 不是真条目。', 'markdown'),
    ),
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1, '围栏里的示例不该进索引');
  assert.doesNotMatch(r.index, /格式示例/);
});

test('代码围栏里缩进加粗的示例不误报 FAIL', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log(eFence(1, '**甲**', '正文。', '   5. **代码块里缩进加粗**')),
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1);
});

test('代码围栏没闭合会报 WARN', () => {
  // 故意只开不闭：围栏之后的条目全被吞
  const pad = ' '.repeat(5);
  const broken = `1. [time=00:00:00] **甲**\n\n${' '.repeat(3)}正文：正文。\n\n${' '.repeat(3)}- 子项：\n\n${pad}\`\`\`\n${pad}2. [time=00:00:01] **乙** —— 被吞。`;
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n${broken}\n` });
  const r = run(ws);
  assert.match(r.out, /代码围栏没有闭合/);
  assert.equal(entryCount(r.index), 1);
});

test('围栏缩进不是 W+2 会 FAIL', () => {
  // 编号 1 位 → 围栏该缩进 5 空格，这里给 3 空格
  const bad = `1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n   - 子项：\n\n   \`\`\`\n   code\n   \`\`\``;
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n${bad}\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /代码围栏缩进/);
});

test('围栏内部的空行原样保留（不受空行规则约束）', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log(eFence(1, '**甲**', '正文。', 'line1\n\nline3')),
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  const after = readFileSync(join(ws.logDir, `${DAY}.md`), 'utf8');
  assert.match(after, /line1\r?\n\r?\n\s+line3/, '围栏内的空行不该被删掉');
});

// ── 写法不规范的条目 ────────────────────────────────────────

test('全角数字编号会 FAIL，不静默吞掉', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n１. **甲**\n\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /条目写法不规范/);
  assert.equal(entryCount(r.index), 0);
});

test('缺空格的 1.**甲** 会 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1.**甲**\n\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /条目写法不规范/);
});

test('顿号 1、**甲** 会 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1、**甲**\n\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /条目写法不规范/);
});

test('正文还写在标题行上（旧写法）FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲** —— 正文还在这一行。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /正文还写在标题行上/);
  assert.match(r.out, /缩进 3 空格/);
});

test('条目行标题后面还有内容 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲** 多余的尾巴\n\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /标题后面还有内容/);
});

test('方括号字段不合法（缺等号）FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [BAD] **甲**\n\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /方括号字段不合法/);
});

test('未加粗的条目 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. 甲\n\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /条目未加粗/);
});

test('缩进加粗的条目 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '正文。'), `   2. [time=00:00:01] **乙**`) });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /缩进的条目加了粗/);
});

// ── 正文段规则 ──────────────────────────────────────────────

test('缺正文段 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /没有正文段/);
});

test('正文段是空的 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /正文段是空的/);
});

test('两个正文段 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：一。\n\n   正文：二。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /有第二个正文段/);
});

test('正文段缩进不对 FAIL（两位编号用 3 空格）', () => {
  const blocks = [];
  for (let i = 1; i <= 9; i++) blocks.push(e(i, `**第 ${i} 条**`, `正文 ${i}。`));
  // 第 10 条是两位编号，正文段该缩进 4 空格，这里故意给 3
  blocks.push(`10. [time=00:00:02] **第十条**\n\n   正文：缩进错了。`);
  const ws = caseWs({ [`${DAY}.md`]: log(...blocks) });
  // 默认入口会先把它修好，所以这里用 --no-fix 看校验器的判定
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /正文段缩进 3 空格，应为 4 空格/);
});

test('子项出现在正文段之前 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   - 先有子项。\n\n   正文：后补的。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /先出现子项、后补正文/);
});

test('子项缩进不对 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n     - 缩进多了。\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /子项缩进 5 空格，应为 3 空格/);
});

// ── 行类型封闭性 ────────────────────────────────────────────

test('未归类行 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '正文。'), '这一行什么都不是') });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /未归类行/);
});

test('--explain 报出每行的行类型归属，且退出码 0', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '正文。', '子项')) });
  const r = run(ws, { argv: ['--explain'] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /date /);
  assert.match(r.out, /entry /);
  assert.match(r.out, /body /);
  assert.match(r.out, /item /);
  assert.match(r.out, /unclassified 0/);
  // --explain 不写索引
  assert.equal(r.index, null);
});

// ── 空行规则 ────────────────────────────────────────────────

test('连续空行 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n\n2. [time=00:00:01] **乙**\n\n   正文：正文。\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /连续空行/);
});

test('文件开头有空行 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `\n# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /文件开头的空行/);
});

test('文件末尾有空行 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /文件末尾的空行/);
});

test('空行位置不对 FAIL（正文段与子项之间塞了空行后又空一行）', () => {
  // item → item 不是合法的空行位置
  const ws = caseWs({
    [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n   - 一。\n\n   - 二。\n`,
  });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /空行位置不对/);
});

test('空行里带空格 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n \n1. [time=00:00:00] **甲**\n\n   正文：正文。\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /空白行里带了空格或制表符/);
});

// 「只允许」不等于「必须出现」：上面几条查的都是「空行放错了地方」，
// 一个空行都不写反而全部通过 —— 那样 Markdown 会把正文并进标题，结构当场失效。
// 这四条补的是反向检查：该有的空行必须有。

test('缺空行 FAIL：条目行紧接正文段', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n   正文：正文。\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /缺空行（entry → body/);
});

test('缺空行 FAIL：正文段紧接子项', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n   - 子项\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /缺空行（body → item/);
});

test('缺空行 FAIL：日期标题紧接第 1 条', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /缺空行（date → entry/);
});

test('缺空行 FAIL：最后一个子项紧接下一条', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n   - 子项\n2. [time=00:00:01] **乙**\n\n   正文：正文。\n` });
  const r = run(ws, { argv: ['--no-fix'] });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /缺空行（item → entry/);
});

test('空行齐全时不报缺空行（反向检查不误报）', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '正文。', '子项'), e(2, '**乙**', '正文。')) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /缺空行/);
});

// ── BOM ─────────────────────────────────────────────────────

test('UTF-8 BOM 被剥离且不误报日期标题', () => {
  const ws = caseWs({ [`${DAY}.md`]: `\uFEFF${one()}` });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1);
  assert.match(r.out, /剥离 UTF-8 BOM/);
  const after = readFileSync(join(ws.logDir, `${DAY}.md`), 'utf8');
  assert.equal(after.startsWith('\uFEFF'), false);
});

// ── 编号文案 ────────────────────────────────────────────────

test('编号重复说「重复」，不出现负数', () => {
  const ws = caseWs({
    [`${DAY}.md`]: log(e(1, '**甲**', '一。'), e(1, '**乙**', '二。'), e(2, '**丙**', '三。')),
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /编号 1 重复/);
  assert.doesNotMatch(r.out, /缺 -/);
});

test('编号倒序说「比上一条小」，不出现负数', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(2, '**甲**', '一。'), e(1, '**乙**', '二。')) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /编号 1 比上一条 2 小/);
  assert.doesNotMatch(r.out, /缺 -/);
});

test('编号跳号仍然报缺几条', () => {
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', '一。'), e(4, '**乙**', '二。')) });
  const r = run(ws);
  assert.match(r.out, /编号从 1 跳到 4（缺 2 条）/);
});

// ── 位置校验 ────────────────────────────────────────────────

test('脚本放在无关子目录会报错退出（无 日志\\ 子目录时）', () => {
  const outer = mkdtempSync(join(tmpdir(), 'bi-outer-'));
  results.push(outer);
  mkdirSync(join(outer, '日志'), { recursive: true });
  writeFileSync(join(outer, '日志', `${DAY}.md`), one());
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

// ── 崩溃友好化 ──────────────────────────────────────────────

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

// ── 只有坏名文件 ────────────────────────────────────────────

test('只有坏名文件时报「文件名不合规范」而非「找不到工作区」', () => {
  const ws = makeWs({ [`${DAY}-补充.md`]: one() });
  results.push(ws.root);
  copyFileSync(SCRIPT, join(ws.logDir, 'build-index.mjs'));
  const r = run(ws);
  assert.match(r.out, /文件名不合规范/);
  assert.doesNotMatch(r.out, /找不到工作区/);
});

// ── 概览变体 ────────────────────────────────────────────────

test('**概览**：加粗形式也能抓到', () => {
  const ws = caseWs({ [`${DAY}.md`]: log('**概览**：今天干了三件大事。', e(1, '**甲**', '正文。')) });
  const r = run(ws);
  assert.match(r.out, /出现了「概览」行/);
});

// ── 日期标题 ────────────────────────────────────────────────

test('日期标题带前导空格不报 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: `  # ${DAY}\n\n${e(1, '**甲**', '正文。')}\n` });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.equal(entryCount(r.index), 1);
});

test('日期标题与文件名不一致 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: '# 2026-10-23\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n' });
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /不一致/);
});

// 文件中间第二个日期标题：原来无条件接受，索引里那些条目还全被记在前一天日期下，
// 日期标题变成纯装饰物 —— 写错了没人知道，写对了也没有任何作用。
test('文件中间出现第二个日期标题 FAIL', () => {
  const ws = caseWs({
    [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n# 2026-10-23\n\n2. [time=00:00:01] **乙**\n\n   正文：正文。\n`,
  });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /第二个日期标题/);
});

test('空标题 FAIL：只有空白也算空', () => {
  const ws = caseWs({ [`${DAY}.md`]: `# ${DAY}\n\n1. [time=00:00:00] **   **\n\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /标题是空的/);
  // 一个错只报一条：不能连带出「正文：出现在任何条目之前」或空行位置不对
  assert.doesNotMatch(r.out, /出现在任何条目之前/);
  assert.doesNotMatch(r.out, /空行位置不对/);
});

test('2026-13-45.md 会 FAIL', () => {
  const ws = caseWs({ '2026-13-45.md': '# 2026-13-45\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n' });
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /日期不存在/);
});

test('空文件 FAIL', () => {
  const ws = caseWs({ [`${DAY}.md`]: '' });
  const r = run(ws);
  assert.equal(r.code, 1);
  assert.match(r.out, /空文件/);
});

// ── 编码 ────────────────────────────────────────────────────

test('非 UTF-8 字节会 WARN', () => {
  const ws = makeWs({});
  results.push(ws.root);
  // GBK 编码的「标题」两字：0xB1 0xEA 0xCC 0xE2，塞进标题里
  const head = Buffer.from(`# ${DAY}\n\n1. **`, 'utf8');
  const gbk = Buffer.from([0xb1, 0xea, 0xcc, 0xe2]);
  const tail = Buffer.from(`**\n\n   正文：正文。\n`, 'utf8');
  writeFileSync(join(ws.logDir, `${DAY}.md`), Buffer.concat([head, gbk, tail]));
  copyFileSync(SCRIPT, join(ws.logDir, 'build-index.mjs'));
  const r = run(ws);
  assert.match(r.out, /疑似非 UTF-8/);
});

// ── 原有防线回归 ────────────────────────────────────────────

test('\\r\\r\\n 被收敛成 CRLF', () => {
  const ws = makeWs({});
  results.push(ws.root);
  const body = `# ${DAY}\r\r\n\r\r\n1. [time=00:00:00] **甲**\r\r\n\r\r\n   正文：正文。\r\r\n`;
  writeFileSync(join(ws.logDir, `${DAY}.md`), body);
  copyFileSync(SCRIPT, join(ws.logDir, 'build-index.mjs'));
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  const after = readFileSync(join(ws.logDir, `${DAY}.md`), 'utf8');
  assert.equal(after.replace(/\r\n/g, '').includes('\r'), false, '不该残留孤立 CR');
});

test('单日再长也不报超长 WARN（2026-10-22 取消该检查）', () => {
  const big = 'x'.repeat(20050);
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**甲**', big)) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /20,000|超过建议/);
  assert.match(r.out, /1 条/);
});

test('三档统计仍然输出，且只报告不阻断', () => {
  const big = 'x'.repeat(2000);
  const ws = caseWs({ [`${DAY}.md`]: log(e(1, '**小**', '短。'), e(2, '**大**', big)) });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /详略（全库）：A \d+ \/ B \d+ \/ C \d+/);
  assert.match(r.out, /详略（\d\d-\d\d）：A \d+ \/ B \d+ \/ C \d+/);
});

test('幂等：跑两次索引内容一致', () => {
  const ws = caseWs({ [`${DAY}.md`]: one() });
  const first = run(ws);
  const second = run(ws);
  assert.equal(first.index, second.index);
  assert.equal(second.code, 0);
});

test('脚本放工作区根（B 情形）也能工作', () => {
  const root = mkdtempSync(join(tmpdir(), 'bi-root-'));
  results.push(root);
  mkdirSync(join(root, '日志'), { recursive: true });
  writeFileSync(join(root, '日志', `${DAY}.md`), one());
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

// ── 尝试性修复（默认入口）────────────────────────────────────
//
// 上面那些 --no-fix 的用例证明「校验器认得错」；这一组证明「默认入口把能修
// 的修掉了」。两类错误在默认入口下的命运不同，所以必须分开验：
//
//   L0 行内改（缩进、空行里的空格）—— 修完直接通过，exit 0
//   L1/L2 增删行（补缺失空行、删多余空行）—— 修完直接通过，exit 0
//   答案不唯一的（正文还写在标题行上、第二个正文段…）—— 修不了，仍然 FAIL

// 只在修复器真的写盘并修好时成立：文件内容变了、报告说了改了什么、退出码 0。
test('默认入口：子项缩进能被修好，且报告说清改了哪几行', () => {
  const path = `${DAY}.md`;
  const ws = caseWs({ [path]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n     - 缩进多了。\n` });
  const before = readFileSync(join(ws.logDir, path), 'utf8');
  const r = run(ws);
  const after = readFileSync(join(ws.logDir, path), 'utf8');

  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /已自动修复 \d+ 处/);
  assert.match(r.out, /子项缩进 5 → 3 空格/);
  // 文件真的变了，且只动了空白
  assert.notEqual(before, after);
  assert.equal(before.replace(/\s+/g, ''), after.replace(/\s+/g, ''));
  // 修完之后校验器不再报这一条
  assert.doesNotMatch(r.out, /子项缩进 5 空格，应为 3 空格/);
});

test('默认入口：缺的空行会被补上，补完通过', () => {
  const path = `${DAY}.md`;
  const ws = caseWs({ [path]: `# ${DAY}\n\n1. [time=00:00:00] **甲**\n   正文：正文。\n` });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /补上 \d+ 个缺失的空行/);
  const after = readFileSync(join(ws.logDir, path), 'utf8');
  // 条目行与正文段之间确实多了空行
  assert.match(after, /1\. \[time=00:00:00\] \*\*甲\*\*\r?\n\r?\n {3}正文：/);
});

test('默认入口：多余空行与首尾空行会被删掉，删完通过', () => {
  const path = `${DAY}.md`;
  // 首部 2 个空行、末尾 3 个空行、中间夹 2 个空行（该留一个）
  const ws = caseWs({
    [path]: `\n\n# ${DAY}\n\n1. [time=00:00:00] **甲**\n\n   正文：正文。\n\n\n2. [time=00:00:01] **乙**\n\n   正文：正文。\n\n\n\n`,
  });
  const r = run(ws);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /删掉文件开头的 2 个空行/);
  assert.match(r.out, /删掉文件末尾的 3 个空行/);
  assert.match(r.out, /删掉 1 个多余的空行/);
  const after = readFileSync(join(ws.logDir, path), 'utf8');
  assert.doesNotMatch(after, /^\r?\n/);
  assert.match(after, /正文：正文。\r?\n$/);
  // 条目之间只剩一个空行
  assert.doesNotMatch(after, /\r?\n\r?\n\r?\n/);
});

test('默认入口：答案不唯一的错不修，仍然 FAIL', () => {
  const path = `${DAY}.md`;
  const ws = caseWs({ [path]: `# ${DAY}\n\n1. [time=00:00:00] **甲** —— 正文还挂在标题行上。\n\n   正文：正文。\n` });
  const before = readFileSync(join(ws.logDir, path), 'utf8');
  const r = run(ws);
  const after = readFileSync(join(ws.logDir, path), 'utf8');
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /正文还写在标题行上/);
  // 一个字都没改 —— 行尾可能被统一成 CRLF，所以比非空白字符
  assert.equal(before.replace(/\s+/g, ''), after.replace(/\s+/g, ''));
});

// 幂等：已经合规的文件内容跑一遍必须不变。「字节一个不变」这一条现在守不住也不该守 ——
// 修复前夹具是 LF、跑完统一成 CRLF，那是行尾归一化，不是内容改动。所以比非空白字符序列。
// 真正的字节级幂等由 `默认入口幂等：跑第二遍连行尾都不动` 保证。
test('默认入口幂等：合规文件跑一遍，内容一个不变', () => {
  const path = `${DAY}.md`;
  const ws = caseWs({ [path]: log(e(1, '**甲**', '正文。', '子项'), e(2, '**乙**', '正文。')) });
  const before = readFileSync(join(ws.logDir, path), 'utf8');
  const r = run(ws);
  const after = readFileSync(join(ws.logDir, path), 'utf8');
  assert.equal(r.code, 0, r.out);
  assert.equal(before.replace(/\s+/g, ''), after.replace(/\s+/g, ''));
  assert.doesNotMatch(r.out, /已自动修复/);
});

test('默认入口幂等：跑第二遍连行尾都不动', () => {
  const path = `${DAY}.md`;
  const ws = caseWs({ [path]: log(e(1, '**甲**', '正文。', '子项'), e(2, '**乙**', '正文。')) });
  run(ws); // 第一遍：归一化行尾
  const settled = readFileSync(join(ws.logDir, path), 'utf8');
  assert.match(settled, /\r\n/);
  const r2 = run(ws); // 第二遍：什么都不该变
  const again = readFileSync(join(ws.logDir, path), 'utf8');
  assert.equal(r2.code, 0, r2.out);
  assert.equal(again, settled);
  assert.doesNotMatch(r2.out, /已自动修复/);
});

// --no-fix 的意义就在这里：同一份脏文件，默认入口修好了，--no-fix 必须原样留着。
test('--no-fix 不修：脏文件一个字节都不改，且退出码 1', () => {
  const path = `${DAY}.md`;
  const dirty = `# ${DAY}\n\n1. [time=00:00:00] **甲**\n   正文：正文。\n\n     - 缩进多了。\n`;
  const ws = caseWs({ [path]: dirty });
  const r = run(ws, { argv: ['--no-fix'] });
  const after = readFileSync(join(ws.logDir, path), 'utf8');
  assert.equal(r.code, 1, r.out);
  assert.equal(after, dirty);
  assert.doesNotMatch(r.out, /已自动修复/);
  assert.match(r.out, /模式：--no-fix/);
});
