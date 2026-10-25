// lib/links.js 的单元 + 端到端用例。
//
// 为什么单独开一个文件：links.js 是**纯函数**模块（只 import node:fs / node:path /
// query.js），不需要 ctx、不需要 live agent，能像数学函数一样逐条测。plugin 本体
// （test/offline.mjs）里工具注册那层只验证「注册了几次、参数对不对」，真正的解析
// 与渲染逻辑在那边测不动。
//
// 用例按「一个函数一组」组织，前缀就是被测函数名 —— 失败时看用例名就知道是哪个环节。
// 端到端那组用真实临时目录 + 真实日志文件，不 mock fs：这个模块唯一的外部输入就是
// 磁盘上的 Markdown，mock 掉它等于什么都没测。
//
// 运行：node --test test/links.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  normalizePath,
  asLogPath,
  parseTicked,
  extractFromLines,
  indexLinks,
  matchesTarget,
  findInLinks,
  inRange,
  resolveTarget,
  notFoundMessage,
  clipRaw,
  renderOut,
  renderOutFile,
  renderIn,
  tallyBareLogRefs,
} from '../lib/links.js';

// ---------------------------------------------------------------------------
// 夹具：一个临时工作区，日志目录里放几天真实格式的日志。
// ---------------------------------------------------------------------------

/**
 * 建一个临时工作区并写日志。
 *
 * @param {Record<string, string>} files 文件名（`YYYY-MM-DD.md`）→ 全文。
 * @returns {{root: string, logDir: string, cleanup: () => void}}
 */
function makeWs(files) {
  const root = mkdtempSync(join(tmpdir(), 'links-'));
  const logDir = join(root, '日志');
  mkdirSync(logDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(logDir, name), content, 'utf8');
  }
  return { root, logDir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** 拼一篇日志：标题行 + 若干条目。 */
function logFile(date, entries) {
  const body = entries
    .map((e) => {
      const head = `${e.num}. [time=${e.time ?? '10:00:00'}][tier=${e.tier ?? 'A'}] **${e.title}**`;
      const lines = [head, ''];
      if (e.body !== undefined) lines.push(`正文：${e.body}`);
      for (const item of e.items ?? []) lines.push(`   - ${item}`);
      lines.push('');
      return lines.join('\n');
    })
    .join('\n');
  return `# ${date}\n\n${body}`;
}

// ---------------------------------------------------------------------------
// normalizePath
// ---------------------------------------------------------------------------

test('normalizePath：反斜杠化、去首尾空白、去结尾反斜杠', () => {
  assert.equal(normalizePath('  tools/check-refs.mjs  '), 'tools\\check-refs.mjs');
  assert.equal(normalizePath('tools\\'), 'tools');
  assert.equal(normalizePath('.\\tools\\a.mjs'), 'tools\\a.mjs');
});

test('normalizePath：不抹 `..\\` —— 它区分「工作区外」与「工作区内同名文件」', () => {
  assert.equal(normalizePath('..\\outside\\a.mjs'), '..\\outside\\a.mjs');
});

// ---------------------------------------------------------------------------
// asLogPath
// ---------------------------------------------------------------------------

test('asLogPath：带不带 `日志\\` 都归一成同一形态', () => {
  assert.equal(asLogPath('2026-10-23.md'), '日志\\2026-10-23.md');
  assert.equal(asLogPath('日志\\2026-10-23.md'), '日志\\2026-10-23.md');
});

test('asLogPath：别的工作区的日志不算本库日志', () => {
  assert.equal(asLogPath('D:\\AI\\测试工作区5\\日志\\2026-10-23.md'), null);
});

test('asLogPath：非日期文件名不算日志', () => {
  assert.equal(asLogPath('日志\\_日志索引.md'), null);
  assert.equal(asLogPath('日志\\build-index.mjs'), null);
});

// ---------------------------------------------------------------------------
// parseTicked —— 提取规则的核心，用例最密
// ---------------------------------------------------------------------------

test('parseTicked：普通路径', () => {
  assert.deepEqual(parseTicked('tools\\check-refs.mjs'), {
    path: 'tools\\check-refs.mjs',
    line: 0,
    entry: 0,
    logPath: null,
  });
});

test('parseTicked：尾部行号被剥下来，不进路径', () => {
  const r = parseTicked('tools\\check-refs.mjs:193');
  assert.equal(r.path, 'tools\\check-refs.mjs');
  assert.equal(r.line, 193);
});

test('parseTicked：行号区间只取起点', () => {
  assert.equal(parseTicked('tools\\check-refs.mjs:193-198').line, 193);
});

test('parseTicked：尾部「第 N 条」被剥下来', () => {
  const r = parseTicked('日志\\2026-10-22.md 第 33 条');
  assert.equal(r.path, '日志\\2026-10-22.md');
  assert.equal(r.entry, 33);
  assert.equal(r.logPath, '日志\\2026-10-22.md');
});

test('parseTicked：条目号与行号可以同时出现', () => {
  const r = parseTicked('日志\\2026-10-22.md 第 33 条:352');
  assert.equal(r.entry, 33);
  // 剥的顺序是先条目号再行号，所以 `:352` 落在条目号之后时仍会被剥掉。
  assert.equal(r.path, '日志\\2026-10-22.md');
});

test('parseTicked：尾部标点被剥掉（反引号里常把句子一起包进去）', () => {
  assert.equal(parseTicked('tools\\check-refs.mjs，').path, 'tools\\check-refs.mjs');
  assert.equal(parseTicked('日志\\2026-10-22.md）').path, '日志\\2026-10-22.md');
});

test('parseTicked：占位符一律不算引用', () => {
  for (const s of [
    '日志\\YYYY-MM-DD.md',
    '<工作区>\\build-index.mjs',
    'C:\\...\\lib\\index.js',
    '日志\\XXXX.md',
  ]) {
    assert.equal(parseTicked(s), null, `应跳过占位符：${s}`);
  }
});

test('parseTicked：没有扩展名的不算引用（命令、标识符、标签）', () => {
  for (const s of ['git status', 'wroteLog', '#待办', '现象：']) {
    assert.equal(parseTicked(s), null, `应跳过：${s}`);
  }
});

test('parseTicked：带空格的命令串取最后一个带扩展名的片段', () => {
  assert.equal(parseTicked('node 日志\\build-index.mjs').path, '日志\\build-index.mjs');
});

test('parseTicked：扩展名白名单长后缀优先，`.jsonl` 不会被切成 `.json`', () => {
  assert.equal(parseTicked('.dsh\\worklog-probe.jsonl').path, '.dsh\\worklog-probe.jsonl');
});

test('parseTicked：空串与非字符串', () => {
  assert.equal(parseTicked(''), null);
  assert.equal(parseTicked(null), null);
  assert.equal(parseTicked('   '), null);
});

// ---------------------------------------------------------------------------
// extractFromLines
// ---------------------------------------------------------------------------

test('extractFromLines：同一行多处反引号都提取', () => {
  const lines = ['1. [time=10:00:00][tier=A] **标题**', '', '正文：改了 `a.mjs` 和 `b.md` 两处。'];
  const links = extractFromLines(lines, 1);
  assert.deepEqual(links.map((l) => l.path), ['a.mjs', 'b.md']);
});

test('extractFromLines：同一条目内同路径只留第一次（A4a）', () => {
  const lines = [
    '1. **标题**',
    '正文：先看 `tools\\x.mjs`。',
    '   - 又提到 `tools\\x.mjs`。',
    '   - 再提到 `tools\\x.mjs:88`。',
  ];
  const links = extractFromLines(lines, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].line, 0, '保留的是第一次出现（没带行号那次）');
});

test('extractFromLines：atLine 是文件内真实行号，不是段内偏移', () => {
  const lines = ['1. **标题**', '正文：`a.md`'];
  const links = extractFromLines(lines, 41);
  assert.equal(links[0].atLine, 42);
});

test('extractFromLines：围栏里的路径也算 —— 贴的命令同样构成引用关系', () => {
  const lines = ['1. **标题**', '```', '先跑 `tools\\check-refs.mjs` 再说', '```'];
  assert.equal(extractFromLines(lines, 1)[0].path, 'tools\\check-refs.mjs');
});

test('extractFromLines：闭引号后面的「第 N 条」被收下（工作区标准写法）', () => {
  const lines = ['1. **标题**', '正文：见 `日志\\2026-10-22.md` 第 33 条。'];
  const links = extractFromLines(lines, 1);
  assert.equal(links[0].path, '日志\\2026-10-22.md');
  assert.equal(links[0].entry, 33);
});

test('extractFromLines：同一文件不同条目号是两条出链，不能被路径去重吞掉', () => {
  const lines = [
    '1. **标题**',
    '正文：见 `日志\\2026-10-22.md` 第 11 条。',
    '   - 另见 `日志\\2026-10-22.md` 第 13 条。',
  ];
  const links = extractFromLines(lines, 1);
  assert.deepEqual(links.map((l) => l.entry), [11, 13], '第 11 条与第 13 条都要留下');
});

test('extractFromLines：「第 N 条与第 M 条」并列写法展开成两条', () => {
  const lines = ['1. **标题**', '正文：`日志\\2026-10-19.md` 第 11 条与第 13 条。'];
  const links = extractFromLines(lines, 1);
  assert.deepEqual(links.map((l) => l.entry), [11, 13]);
  assert.ok(links.every((l) => l.path === '日志\\2026-10-19.md'));
});

test('extractFromLines：「第 N 条、第 M 条」顿号并列与多余空格都认', () => {
  const lines = ['1. **标题**', '正文：`日志\\2026-10-19.md` 第 11 条、 第 13 条 、第 15 条。'];
  const links = extractFromLines(lines, 1);
  assert.deepEqual(links.map((l) => l.entry), [11, 13, 15]);
});

test('extractFromLines：范围写法「第 38–56 条」保留成一条带 entryRange 的引用，不展开', () => {
  const lines = ['1. **标题**', '正文：细节指向 `日志\\2026-10-22.md` 第 38–56 条。'];
  const links = extractFromLines(lines, 1);
  assert.equal(links.length, 1, '不能展开成 19 条 —— 那会让出链数虚高，渲染也没信息量');
  assert.deepEqual(links[0].entryRange, [38, 56]);
  assert.equal(links[0].entry, 38, 'entry 取区间起点，给下游当单值用');
});

test('extractFromLines：范围写法的破折号三种写法都认（– - ~）', () => {
  for (const dash of ['–', '-', '~']) {
    const lines = ['1. **标题**', `正文：见 \`日志\\2026-10-22.md\` 第 3${dash}7 条。`];
    const links = extractFromLines(lines, 1);
    assert.deepEqual(links[0].entryRange, [3, 7], `破折号 ${dash} 没认出来`);
  }
});

test('extractFromLines：「第 3 条」不能被误认成范围', () => {
  const lines = ['1. **标题**', '正文：见 `日志\\2026-10-22.md` 第 3 条。'];
  const links = extractFromLines(lines, 1);
  assert.equal(links[0].entryRange, null);
  assert.equal(links[0].entry, 3);
});

test('extractFromLines：斜杠并列（第 11/13 条）不猜 —— 猜错是假引用', () => {
  const lines = ['1. **标题**', '正文：`日志\\2026-10-19.md` 第 11/13 条。'];
  const links = extractFromLines(lines, 1);
  assert.equal(links.length, 1);
  assert.equal(links[0].entry, 0, '认不出就退化成文件级引用（entry 用 0 表示没条目号）');
});

test('extractFromLines：并列的条目号只对紧挨着的那一对反引号生效', () => {
  const lines = ['1. **标题**', '正文：`a.md` 第 2 条与 `b.md` 第 3 条。'];
  const links = extractFromLines(lines, 1);
  assert.deepEqual(links.map((l) => [l.path, l.entry]), [['a.md', 2], ['b.md', 3]]);
});

// ---------------------------------------------------------------------------
// indexLinks —— 端到端，真实磁盘
// ---------------------------------------------------------------------------

test('indexLinks：条目切分、行号、日期列表都对', () => {
  const ws = makeWs({
    '2026-10-22.md': logFile('2026-10-22', [
      { num: 1, title: '第一条', body: '引用 `tools\\check-refs.mjs`。' },
      { num: 2, title: '第二条', body: '没引用任何东西。' },
    ]),
    '2026-10-23.md': logFile('2026-10-23', [
      { num: 1, title: '第三天', body: '引用 `a.md`。' },
    ]),
  });
  try {
    const idx = indexLinks(ws.logDir);
    assert.equal(idx.items.length, 3);
    assert.equal(idx.fileCount, 2);
    assert.deepEqual(idx.dates, ['2026-10-22', '2026-10-23']);
    assert.deepEqual(idx.items.map((i) => `${i.date}#${i.num}`), [
      '2026-10-22#1',
      '2026-10-22#2',
      '2026-10-23#1',
    ]);
    assert.equal(idx.items[0].links.length, 1);
    assert.equal(idx.items[1].links.length, 0);
    // 条目行的行号 = 3（`# 日期` + 空行 + 条目行）
    assert.equal(idx.items[0].line, 3);
  } finally {
    ws.cleanup();
  }
});

test('indexLinks：条目正文切片不越到下一条里', () => {
  const ws = makeWs({
    '2026-10-22.md': logFile('2026-10-22', [
      { num: 1, title: '第一条', body: '干净的。' },
      { num: 2, title: '第二条', body: '引用 `b.md`。' },
    ]),
  });
  try {
    const idx = indexLinks(ws.logDir);
    assert.equal(idx.items[0].links.length, 0, '第一条不该吃到第二条的引用');
    assert.equal(idx.items[1].links.length, 1);
  } finally {
    ws.cleanup();
  }
});

test('indexLinks：日志目录不存在时返回空集，不抛错', () => {
  const idx = indexLinks(join(tmpdir(), 'links-does-not-exist-xyz'));
  assert.deepEqual(idx.items, []);
  assert.equal(idx.fileCount, 0);
  assert.deepEqual(idx.dates, []);
});

test('indexLinks：非日志文件不进索引', () => {
  const ws = makeWs({});
  try {
    writeFileSync(join(ws.logDir, '说明.md'), 'x `a.md`\n', 'utf8');
    writeFileSync(join(ws.logDir, 'build-index.mjs'), '// `b.mjs`\n', 'utf8');
    const idx = indexLinks(ws.logDir);
    assert.deepEqual(idx.items, []);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// matchesTarget / findInLinks
// ---------------------------------------------------------------------------

test('matchesTarget：日志按 logPath 严格相等', () => {
  const link = { path: '日志\\2026-10-22.md', logPath: '日志\\2026-10-22.md', entry: 0 };
  assert.equal(matchesTarget(link, { kind: 'log', logPath: '日志\\2026-10-22.md' }), true);
  assert.equal(matchesTarget(link, { kind: 'log', logPath: '日志\\2026-10-23.md' }), false);
});

test('matchesTarget：普通文件认「全路径」与「裸名」两种写法', () => {
  const full = { path: 'tools\\check-refs.mjs', logPath: null, entry: 0 };
  const bare = { path: 'check-refs.mjs', logPath: null, entry: 0 };
  const target = { kind: 'file', path: 'tools\\check-refs.mjs' };
  assert.equal(matchesTarget(full, target), true);
  assert.equal(matchesTarget(bare, target), true, '裸名引用也该命中');
});

test('matchesTarget：裸名匹配不能跨目录误伤 —— `b\\check-refs.mjs` 不该命中 `a\\check-refs.mjs`', () => {
  const link = { path: 'other\\check-refs.mjs', logPath: null, entry: 0 };
  assert.equal(matchesTarget(link, { kind: 'file', path: 'tools\\check-refs.mjs' }), false);
});

test('findInLinks：文件级 —— 不带条目号时，写了条目号的引用也算', () => {
  const ws = makeWs({
    '2026-10-23.md': logFile('2026-10-23', [
      { num: 1, title: '甲', body: '见 `日志\\2026-10-22.md` 第 2 条。' },
      { num: 2, title: '乙', body: '见 `日志\\2026-10-22.md`。' },
    ]),
    '2026-10-22.md': logFile('2026-10-22', [{ num: 2, title: '目标' }]),
  });
  try {
    const idx = indexLinks(ws.logDir);
    const hits = findInLinks(idx.items, { kind: 'log', logPath: '日志\\2026-10-22.md', label: '' });
    assert.equal(hits.length, 2, '两条都指向这个文件');
  } finally {
    ws.cleanup();
  }
});

test('findInLinks：条目级 —— 只算写了同一个条目号的引用', () => {
  const ws = makeWs({
    '2026-10-23.md': logFile('2026-10-23', [
      { num: 1, title: '甲', body: '见 `日志\\2026-10-22.md` 第 2 条。' },
      { num: 2, title: '乙', body: '见 `日志\\2026-10-22.md` 第 3 条。' },
      { num: 3, title: '丙', body: '见 `日志\\2026-10-22.md`（没写条目）。' },
    ]),
    '2026-10-22.md': logFile('2026-10-22', [{ num: 2, title: '目标' }, { num: 3, title: '别条' }]),
  });
  try {
    const idx = indexLinks(ws.logDir);
    const hits = findInLinks(idx.items, {
      kind: 'log',
      logPath: '日志\\2026-10-22.md',
      entry: 2,
      label: '',
    });
    assert.equal(hits.length, 1, '只有明确指向「第 2 条」的算');
    assert.equal(hits[0].item.num, 1);
  } finally {
    ws.cleanup();
  }
});

test('findInLinks：范围引用能命中区间内的条目，且标记为「按范围」', () => {
  const ws = makeWs({
    '2026-10-23.md': logFile('2026-10-23', [
      { num: 1, title: '甲', body: '细节指向 `日志\\2026-10-22.md` 第 38–56 条。' },
      { num: 2, title: '乙', body: '精确点名 `日志\\2026-10-22.md` 第 60 条。' },
    ]),
    '2026-10-22.md': logFile('2026-10-22', [{ num: 45, title: '区间内' }, { num: 60, title: '区间外' }]),
  });
  try {
    const idx = indexLinks(ws.logDir);
    // 查第 45 条：它被「第 38–56 条」覆盖了，说「没人引用」是错的
    const inRangeHits = findInLinks(idx.items, {
      kind: 'log', logPath: '日志\\2026-10-22.md', entry: 45, label: '',
    });
    assert.equal(inRangeHits.length, 1);
    assert.equal(inRangeHits[0].item.num, 1);
    assert.deepEqual(inRangeHits[0].links[0].entryRange, [38, 56], '要能标出「是按范围引的」');

    // 查第 60 条：不在区间内，只有精确点名那处算
    const outsideHits = findInLinks(idx.items, {
      kind: 'log', logPath: '日志\\2026-10-22.md', entry: 60, label: '',
    });
    assert.equal(outsideHits.length, 1);
    assert.equal(outsideHits[0].item.num, 2);
  } finally {
    ws.cleanup();
  }
});

test('inRange：容得下写反的区间（56–38 也当 38–56 用）', () => {
  assert.equal(inRange(45, [38, 56]), true);
  assert.equal(inRange(45, [56, 38]), true, '写反多半是笔误，按区间理解比什么都不命中更有用');
  assert.equal(inRange(37, [38, 56]), false);
  assert.equal(inRange(57, [38, 56]), false);
  assert.equal(inRange(38, [38, 56]), true, '端点算在区间内');
  assert.equal(inRange(56, [38, 56]), true);
});

test('findInLinks：查不到时返回空数组', () => {
  const ws = makeWs({
    '2026-10-22.md': logFile('2026-10-22', [{ num: 1, title: '甲', body: '引用 `a.md`。' }]),
  });
  try {
    const idx = indexLinks(ws.logDir);
    assert.deepEqual(findInLinks(idx.items, { kind: 'file', path: 'tools\\none.mjs' }), []);
  } finally {
    ws.cleanup();
  }
});

// ---------------------------------------------------------------------------
// resolveTarget
// ---------------------------------------------------------------------------

const DATES = ['2026-10-21', '2026-10-22', '2026-10-23'];

test('resolveTarget：标准日志路径', () => {
  const r = resolveTarget('日志\\2026-10-23.md', DATES);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'log');
  assert.equal(r.logPath, '日志\\2026-10-23.md');
  assert.equal(r.entry, undefined);
});

test('resolveTarget：只写日期文件，自动补 `日志\\` 前缀（日期名唯一，猜不歧义）', () => {
  const r = resolveTarget('2026-10-23.md', DATES);
  assert.equal(r.ok, true);
  assert.equal(r.logPath, '日志\\2026-10-23.md');
});

test('resolveTarget：条目级', () => {
  const r = resolveTarget('日志\\2026-10-23.md 第 10 条', DATES);
  assert.equal(r.ok, true);
  assert.equal(r.entry, 10);
  assert.equal(r.label, '日志\\2026-10-23.md 第 10 条');
});

test('resolveTarget：尾部行号不算 target 的一部分', () => {
  const r = resolveTarget('日志\\2026-10-22.md:436', DATES);
  assert.equal(r.ok, true);
  assert.equal(r.logPath, '日志\\2026-10-22.md');
});

test('resolveTarget：任意工作区文件（必须全路径）', () => {
  const r = resolveTarget('tools\\check-refs.mjs', DATES);
  assert.equal(r.ok, true);
  assert.equal(r.kind, 'file');
  assert.equal(r.path, 'tools\\check-refs.mjs');
});

test('resolveTarget：裸文件名被拒 —— 全库有多个 `说明.md`，猜错比报错更糟', () => {
  const r = resolveTarget('check-refs.mjs', DATES);
  assert.equal(r.ok, false);
  assert.match(r.message, /请写全路径/);
});

test('resolveTarget：不存在的日期给出前后候选（B1b）', () => {
  const r = resolveTarget('日志\\2026-10-22.md', ['2026-10-21']);
  assert.equal(r.ok, false);
  assert.match(r.message, /找不到/);
  assert.match(r.message, /2026-10-21/);
});

test('resolveTarget：空 target 报错并给例子', () => {
  const r = resolveTarget('   ', DATES);
  assert.equal(r.ok, false);
  assert.match(r.message, /没有给 target/);
});

test('resolveTarget：没有扩展名的不当文件查', () => {
  const r = resolveTarget('tools\\something', DATES);
  assert.equal(r.ok, false);
  assert.match(r.message, /不像文件路径/);
});

// ---------------------------------------------------------------------------
// notFoundMessage
// ---------------------------------------------------------------------------

test('notFoundMessage：只猜前后 1-2 天，不猜更远', () => {
  const msg = notFoundMessage('日志\\2026-10-25.md', '2026-10-25', ['2026-10-20', '2026-10-23']);
  const guessLine = msg.split('\n').find((l) => l.includes('你是不是想找')) ?? '';
  assert.match(guessLine, /2026-10-23/, '相差 2 天的该被猜出来');
  assert.doesNotMatch(guessLine, /2026-10-20/, '相差 5 天的不该进候选');
});

test('notFoundMessage：一个候选都没有时仍说清库里有哪些天', () => {
  const msg = notFoundMessage('日志\\2026-10-25.md', '2026-10-25', ['2026-01-01']);
  assert.match(msg, /库里共有 1 天/);
  assert.match(msg, /2026-01-01/);
});

// ---------------------------------------------------------------------------
// clipRaw / renderOut / renderIn / tallyBareLogRefs
// ---------------------------------------------------------------------------

test('clipRaw：压空白，超长截断并加省略号', () => {
  assert.equal(clipRaw('  a\n  b  '), 'a b');
  const long = 'x'.repeat(200);
  const out = clipRaw(long);
  assert.equal(out.length, 161);
  assert.ok(out.endsWith('…'));
});

test('renderOut：带条目号与不带条目号分开标注', () => {
  const item = {
    date: '2026-10-23',
    num: 5,
    title: '标题',
    file: '2026-10-23.md',
    links: [
      { path: '日志\\2026-10-22.md', logPath: '日志\\2026-10-22.md', entry: 3, line: 0, atLine: 7, raw: '见 `日志\\2026-10-22.md` 第 3 条' },
      { path: 'tools\\a.mjs', logPath: null, entry: 0, line: 9, atLine: 8, raw: '改 `tools\\a.mjs`' },
    ],
  };
  const text = renderOut(item);
  assert.match(text, /【出链】2026-10-23 第 5 条「标题」/);
  assert.match(text, /引用了 2 处/);
  assert.match(text, /日志·第 3 条/);
  assert.match(text, /\[文件 :9\]/);
});

test('renderOut：没有出链时明确说「没有」，不返回空串', () => {
  const text = renderOut({
    date: '2026-10-23',
    num: 5,
    title: '标题',
    file: '2026-10-23.md',
    links: [],
  });
  assert.match(text, /没有引用任何文件/);
});

test('renderOut：斜杠并列写法要在输出里说明「工具不认」，不能装作没写条目号', () => {
  const item = {
    date: '2026-10-23',
    num: 5,
    title: '标题',
    file: '2026-10-23.md',
    links: [
      { path: '日志\\2026-10-20.md', logPath: '日志\\2026-10-20.md', entry: 0, line: 0, atLine: 8, raw: '改过 `日志\\2026-10-20.md` 第 11/13 条' },
    ],
  };
  const text = renderOut(item);
  assert.match(text, /日志·未指定条目/, '解析上退化成文件级');
  assert.match(text, /并列写法，工具不认/, '但要明说原因，否则读起来像「这里本来就没写条目号」');
});

test('renderOut：没有斜杠写法时不该出现那条提示', () => {
  const item = {
    date: '2026-10-23',
    num: 5,
    title: '标题',
    file: '2026-10-23.md',
    links: [
      { path: '日志\\2026-10-20.md', logPath: '日志\\2026-10-20.md', entry: 11, line: 0, atLine: 8, raw: '见 `日志\\2026-10-20.md` 第 11 条' },
    ],
  };
  assert.doesNotMatch(renderOut(item), /并列写法/);
});

test('renderOut：范围引用显示成「第 38–56 条」，不是「未指定条目」', () => {
  const item = {
    date: '2026-10-22',
    num: 57,
    title: '标题',
    file: '2026-10-22.md',
    links: [
      { path: '日志\\2026-10-22.md', logPath: '日志\\2026-10-22.md', entry: 38, entryRange: [38, 56], line: 0, atLine: 654, raw: '细节指向 `日志\\2026-10-22.md` 第 38–56 条' },
    ],
  };
  const text = renderOut(item);
  assert.match(text, /日志·第 38–56 条/);
  assert.doesNotMatch(text, /未指定条目/, '范围是条目级的，不能降格成文件级');
});

test('renderIn：按范围命中的那处要注明「按范围引用」，不能装成精确点名', () => {
  const hits = [
    {
      item: { date: '2026-10-22', num: 57, title: '标题', file: '2026-10-22.md', line: 645 },
      links: [{ raw: '见 `日志\\2026-10-22.md` 第 38–56 条', entryRange: [38, 56] }],
    },
  ];
  const text = renderIn(hits, { label: '日志\\2026-10-22.md 第 45 条' }, { items: 10, fileCount: 3 });
  assert.match(text, /按范围引用：第 38–56 条/);
});

test('renderIn：精确点名的那处不加「按范围」前缀', () => {
  const hits = [
    {
      item: { date: '2026-10-22', num: 5, title: '标题', file: '2026-10-22.md', line: 10 },
      links: [{ raw: '见 `日志\\2026-10-22.md` 第 45 条', entryRange: null }],
    },
  ];
  const text = renderIn(hits, { label: '日志\\2026-10-22.md 第 45 条' }, { items: 10, fileCount: 3 });
  assert.doesNotMatch(text, /按范围引用/);
});

test('renderIn：命中时日期倒序、给锚点与原文、末尾带检索范围', () => {
  const hits = [
    { item: { date: '2026-10-21', num: 1, title: '早', file: '2026-10-21.md', line: 3 }, links: [{ raw: 'x' }] },
    { item: { date: '2026-10-25', num: 2, title: '晚', file: '2026-10-25.md', line: 9 }, links: [{ raw: 'y' }] },
  ];
  const text = renderIn(hits, { label: 'tools\\a.mjs' }, { items: 10, fileCount: 3 });
  const iLate = text.indexOf('2026-10-25');
  const iEarly = text.indexOf('2026-10-21');
  assert.ok(iLate < iEarly, '晚的排在前面');
  assert.match(text, /`日志\\2026-10-25\.md:9`/);
  assert.match(text, /检索范围：日志\\\*\.md 的 10 条正文（3 个文件）/);
});

test('renderIn：空结果时给检索范围 + 「查不到不代表没有」的提醒', () => {
  const text = renderIn([], { label: 'tools\\a.mjs' }, { items: 10, fileCount: 3 });
  assert.match(text, /没有日志条目引用它/);
  assert.match(text, /这里查不到不代表没人引过/);
  assert.match(text, /检索范围/);
});

test('tallyBareLogRefs：只统计指向日志的引用，分得出没写条目号的', () => {
  const items = [
    {
      links: [
        { logPath: '日志\\a.md', entry: 3 },
        { logPath: '日志\\b.md', entry: 0 },
        { logPath: null, entry: 0 },
      ],
    },
    { links: [{ logPath: '日志\\c.md', entry: 0 }] },
  ];
  assert.deepEqual(tallyBareLogRefs(items), { total: 3, bare: 2 });
});

test('tallyBareLogRefs：范围引用是条目级的，不算「只写了文件名」', () => {
  const items = [
    {
      links: [
        { logPath: '日志\\a.md', entry: 38, entryRange: [38, 56] },
        { logPath: '日志\\b.md', entry: 0, entryRange: null },
      ],
    },
  ];
  assert.deepEqual(tallyBareLogRefs(items), { total: 2, bare: 1 });
});

// ---------------------------------------------------------------------------
// renderOutFile —— 文件级出链必须紧凑
// ---------------------------------------------------------------------------

test('renderOutFile：只给路径清单，不贴原文', () => {
  const items = [
    { date: '2026-10-24', num: 1, title: '甲', links: [{ path: 'a.mjs', raw: '正文：改了 a.mjs 和别的' }, { path: 'b.md', raw: '正文：见 b.md' }] },
    { date: '2026-10-24', num: 2, title: '乙', links: [] },
    { date: '2026-10-24', num: 3, title: '丙', links: [{ path: 'c.js', raw: '正文：c.js' }] },
  ];
  const text = renderOutFile(items);
  assert.match(text, /全部 3 条：2 条有出链，共 3 处/);
  assert.match(text, /第 1 条「甲」→ 2 处：a\.mjs、b\.md/);
  assert.match(text, /第 3 条「丙」→ 1 处：c\.js/);
  // 紧凑的关键：原文行一次都不出现（否则一个 29 条的文件就是 4.7 万字符）
  assert.doesNotMatch(text, /正文：/);
  assert.doesNotMatch(text, /​日志\\\\2026-10-24\.md:\d/);
});

test('renderOutFile：全都没出链时明确说「没有」', () => {
  const text = renderOutFile([{ date: '2026-10-24', num: 1, title: '甲', links: [] }]);
  assert.match(text, /没有任何条目引用文件/);
});
