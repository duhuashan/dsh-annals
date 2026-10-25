/**
 * links.js —— 日志的双向链接。给 `worklog_links` 工具用的纯逻辑，不碰 ctx。
 *
 * 两个方向，别混：
 * - **出链**（这条引用了谁）：从条目正文里提取反引号包住的路径。写在正文里，直接读。
 * - **入链**（谁引用了它）：日志里不写这个 —— 写了就得回头改旧条目，与「不回头改」
 *   冲突。所以只能扫全库算出来。见 `assets\worklog.md` §「被谁引用」。
 *
 * 三个刻意的取舍（定案过程见 2026-10-26 的 grilling）：
 *
 * 1. **只扫 `日志\*.md`，不遍历工作区**。入链的来源固定是日志；目标可以是任意文件。
 *    为找出「非日志文档提到过日志」的那 10 处（全是不会再更新的历史文档）让插件
 *    每次递归遍历整个工作区，是拿常态成本换一次性收益。
 *
 * 2. **只认反引号里的路径**。实测 5250 处反引号内容里，Markdown 链接 0 处、裸写绝对
 *    路径 0 处 —— 加那两种分支只会让「为什么这个没被识别」的排查成本翻倍。
 *
 * 3. **不报「引用已失效」**。日志是历史快照，写的时候那个文件确实在。断链检测是
 *    另一件事，混进反查结果会让「谁引用了 X」的输出变成一半警告。
 *
 * 复用 `query.js` 的 `loadLogs()` 而不是自己解析条目：同一个工作区里，「query 查得到
 * 的条目」和「links 能链的条目」必须是同一批，两套解析器迟早漂移且不会报错。
 * 行号另外读一遍原文取 —— `loadLogs` 不保留「一行属于哪一条」的映射，
 * 而锚点必须是真的，不能给个算出来的近似值。
 *
 * 零依赖（只用 node:fs / node:path 和同目录的 query.js）。
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { loadLogs } from './query.js';

// 遍历工作区时跳过的目录。`.git` 里光对象就有上千个，且永远不会有引用指向它。
const SKIP_DIRS = new Set(['.git', 'node_modules']);

// 「疑似入链」一栏最多列几条。列全了会把正文淹掉，而这些本来就只是线索。
const SUSPECT_SHOW_MAX = 8;

/**
 * 建一张「文件名 → 它在工作区里的全部相对路径」表。
 *
 * **为什么需要它**：日志里大量裸名写法（`` `check-refs.mjs` ``、`` `说明.md` ``）。
 * 裸名不带目录，只有知道「全库这个文件名有几个、分别在哪」才能判断：
 * - 只有一个 → 就是它，可以放心补全成全路径；
 * - 有多个 → 归属不明，**不能猜**。猜成任何一个都会制造假引用。
 *
 * 实测 118 个文件、106 个不同名字，全量遍历 1.3ms —— 比重新解析一遍日志还便宜，
 * 没有理由为了省这点开销去猜。
 *
 * 这不违反「只扫日志」那条：入链的**来源**仍然只有日志，这里查的是**目标**叫什么。
 *
 * @param {string} root 工作区根目录（绝对路径）。
 * @returns {Map<string, string[]>} 文件名 → 相对路径数组（`\` 分隔，不含根）。
 */
export function indexWorkspaceFiles(root) {
  const map = new Map();
  const walk = (dir, rel) => {
    let list;
    try {
      list = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 权限不足之类，跳过整个子树比让整次查询失败好
    }
    for (const e of list) {
      if (SKIP_DIRS.has(e.name)) continue;
      const childRel = rel === '' ? e.name : `${rel}\\${e.name}`;
      if (e.isDirectory()) {
        walk(join(dir, e.name), childRel);
        continue;
      }
      if (!e.isFile()) continue;
      const arr = map.get(e.name);
      if (arr === undefined) map.set(e.name, [childRel]);
      else arr.push(childRel);
    }
  };
  walk(root, '');
  return map;
}

/**
 * 把裸名补成全路径 —— **只在全库唯一时**。
 *
 * @param {string} bare 裸文件名，如 `check-refs.mjs`。
 * @param {Map<string, string[]>|null|undefined} fileIndex `indexWorkspaceFiles()` 的表。
 * @returns {string|null} 全路径；同名有多个或表里没有就返回 null（宁可不认）。
 */
export function resolveBareName(bare, fileIndex) {
  if (!fileIndex) return null;
  const cands = fileIndex.get(bare);
  if (cands === undefined || cands.length !== 1) return null;
  return cands[0];
}

// 反引号内容。不放行换行 —— 一条正文行里的反引号跨行是格式错误，不该被当成引用。
//
// 条目号**不放在这条正则里**，改成取出反引号之后再往右看 `ENTRY_CHAIN`。原因：一行里
// 可以写多个条目号（`` `日志\2026-10-19.md` 第 11 条与第 13 条 ``），把 `第 N 条` 塞进
// TICK 只能抓到第一个，后面的要靠位置推 —— 而位置推不出「这个号属于左边哪一对反引号」。
const TICK = /`([^`\n]+)`/g;

// 闭引号之后的「第 N 条」串，允许链式并列：
//   第 11 条
//   第 11 条与第 13 条
//   第 11 条、第 13 条、第 15 条
// 连接词只认这几种。**不认斜杠**（`第 11/13 条`）—— 那是歧义写法：既可能是指 11 和 13，
// 也可能是笔误，猜错了会造出**假引用**，比查不到更糟。规矩里已禁止这种写法。
const ENTRY_ITEM = /第[ \t]*(\d+)[ \t]*条/g;

// 反引号与第一个「第 N 条」之间只允许空白；后续每一项前面允许空白 + 一个连接词。
const ENTRY_LEAD = /^[ \t]*/;
const ENTRY_SEP = /^[ \t]*(?:[与和及、,，][ \t]*)?/;

// 条目范围：`第 38–56 条`。破折号三种写法都出现过（en dash 最常见）。
// 为什么单独处理而不是「展开成 19 条出链」：展开会让出链总数虚高，而且渲染时
// 19 行长得一模一样的条目号没有信息量。保留成一条带范围的引用，反查时按区间命中。
const ENTRY_RANGE = /第[ \t]*(\d+)[ \t]*[–\-~—至][ \t]*(\d+)[ \t]*条/;

// 斜杠并列的探测。只用于报告「这种写法工具不认」，不参与解析。
const SLASH_ENTRY = /^[ \t]*第[ \t]*\d+[ \t]*\/[ \t]*\d+[ \t]*条/;

// 整行版：渲染时用来提醒「这行里有工具认不出的并列写法」。
const SLASH_ENTRY_ANY = /第[ \t]*\d+[ \t]*\/[ \t]*\d+[ \t]*条/;

/**
 * 从 `start` 处往后读一串「第 N 条」，支持 `与`／`、` 连接的并列写法与 `第 N–M 条` 范围。
 *
 * 为什么要链条而不是单抓一个：真实日志里有
 * `` `日志\2026-10-19.md` 第 11 条与第 13 条 `` 这种一句指两个条目的写法，
 * 只抓第一个会让第二个条目变成「不存在」的反向链接。
 *
 * 范围写法返回的是 `{range: [38, 56]}` 而不是 19 个条目号 —— 保留原样才能如实
 * 渲染成「第 38–56 条」，反查时按区间判断命中。
 *
 * @param {string} text 整行文本。
 * @param {number} start 闭引号之后的下标。
 * @returns {{entries: number[], range: [number, number]|null, end: number, slash: boolean,
 *   entry: number}}
 *   `entries` 为空、`range` 为 null 表示这里没有条目号；`slash` 表示遇到 `第 N/M 条`
 *   这种不认的写法；`entry` 是给下游用的单值（范围取起点）。
 */
function readEntryChain(text, start) {
  const entries = [];
  const at = ENTRY_LEAD.exec(text.slice(start));
  let pos = start + at[0].length;

  // 斜杠并列：认不出来，但要能被报告出来，不能悄悄当成「只引用了整个文件」。
  if (SLASH_ENTRY.test(text.slice(start))) {
    return { entries, range: null, end: start, slash: true, entry: 0 };
  }

  // 范围写法优先：`第 38–56 条` 里的 `38` 会被 ENTRY_ITEM 单独吃掉，
  // 必须在它之前判断，否则只剩一个 `38` 而丢掉「到 56」这层信息。
  const rm = ENTRY_RANGE.exec(text.slice(start));
  if (rm && rm.index === pos - start) {
    const lo = Number(rm[1]);
    const hi = Number(rm[2]);
    const end = pos + rm[0].length;
    // 起点大于终点是笔误，但缩成一条等于静默改字 —— 原样保留，按「区间写反了」处理。
    return {
      entries: [],
      range: [lo, hi],
      end,
      slash: false,
      entry: lo,
    };
  }

  ENTRY_ITEM.lastIndex = pos;
  const first = ENTRY_ITEM.exec(text);
  if (!first || first.index !== pos) return { entries, range: null, end: start, slash: false, entry: 0 };
  entries.push(Number(first[1]));
  pos += first[0].length;

  for (;;) {
    const sep = ENTRY_SEP.exec(text.slice(pos));
    const next = pos + sep[0].length;
    ENTRY_ITEM.lastIndex = next;
    const m = ENTRY_ITEM.exec(text);
    if (!m || m.index !== next) break;
    entries.push(Number(m[1]));
    pos = next + m[0].length;
  }
  return { entries, range: null, end: pos, slash: false, entry: entries.length > 0 ? entries[0] : 0 };
}

// 尾部「第 N 条」。这是日志引用日志的**唯一**正确写法（`assets\worklog.md` 定的）。
const ENTRY_SUFFIX = /\s*第\s*(\d+)\s*条\s*$/;

// 尾部行号：`:123` 或 `:123-130`。破折号两种写法都出现在真实日志里。
const LINE_SUFFIX = /:(\d+)(?:[-–](\d+))?$/;

// 路径尾部的标点。反引号里的人常把句子和路径一起包进去。
const TRAILING_PUNCT = /[。，、；：）】」』,.;:)\]}]+$/;

// 占位符与省略写法 —— 实测 16 处，全都不该被当成引用。
// `日志\YYYY-MM-DD.md` 是格式示例，`<工作区>\build-index.mjs` 是文档里的模板，
// `C:\...\lib\index.js` 是省略中间段的示意。它们指向不了任何确定文件。
const PLACEHOLDER = /YYYY|XXXX|<[^>]*>|\.{3}|…/;

// 扩展名白名单。为什么要白名单而不是「看着像路径就算」：
// 实测 5115 处剥完非空的反引号内容里，只有 1292 处带扩展名 —— 其余全是
// `git status`（命令）、`wroteLog`（标识符）、`#待办`（标签）、`现象：`（小标题）。
// 靠「有没有反斜杠」分不开，靠扩展名一步到位。
// 长的必须排在短的前面，否则 `xyz.jsonl` 会先匹配到 `.json` 并把 `l` 留在外面。
const EXT = /\.(jsonl|json|md|mjs|cjs|js|ts|ps1|psm1|cmd|bat|txt|ya?ml|toml|py|html|css|svg|png|jpe?g|zip|7z|exe|log|sh)$/i;

// 日志文件名：`YYYY-MM-DD.md`。
const DATE_FILE = /^\d{4}-\d{2}-\d{2}\.md$/;

// 原文行截断长度。C1 选的是「行号 + 原文行」，但一条日志行能有几千字符，
// 原样输出会把真正的路径淹掉。
const RAW_MAX = 160;

/**
 * 把路径归一化成可比较的形态：统一分隔符、去掉开头的 `.\`、去掉首尾空白与结尾反斜杠。
 *
 * 为什么不统一抹掉 `..\`：日志里写 `..\` 是有信息量的（指向工作区外），
 * 抹掉反而会把它错误地归到工作区内的同名文件上。
 *
 * @param {string} p 原始路径。
 * @returns {string} 归一化后的路径。
 */
export function normalizePath(p) {
  let s = String(p ?? '').trim();
  s = s.replace(/\//g, '\\');
  s = s.replace(/\\+$/, '');
  s = s.replace(/^\.\\/, '');
  return s;
}

/**
 * 判断一个归一化路径是不是「本工作区的日志文件」，并给出它的标准写法。
 *
 * 三种都算：`日志\2026-10-23.md`、`2026-10-23.md`、`.\日志\2026-10-23.md`。
 * **不算** `D:\AI\测试工作区5\日志\2026-10-21.md` —— 那是别的工作区的同名文件，
 * 归到本工作区会让入链凭空多出几条。实测这种写法有 1 处。
 *
 * @param {string} p 归一化路径。
 * @returns {string|null} 标准写法 `日志\<日期>.md`，或 null。
 */
export function asLogPath(p) {
  if (DATE_FILE.test(p)) return `日志\\${p}`;
  if (/^日志\\\d{4}-\d{2}-\d{2}\.md$/.test(p)) return p;
  return null;
}

/**
 * 从一条反引号内容里解析出一个链。
 *
 * @param {string} raw 反引号里的原始内容（未 trim、未剥后缀）。
 * @returns {{path: string, line: number, entry: number, logPath: string|null}|null}
 *   `line` / `entry` 是原文里带的行号 / 条目号（没带就是 0）；`logPath` 非 null 表示
 *   这条链指向本工作区的日志文件。返回 null 表示这处内容不是文件引用。
 */
export function parseTicked(raw) {
  let s = String(raw ?? '').trim();
  if (s === '') return null;
  if (PLACEHOLDER.test(s)) return null;

  // 尾部的标记从外往内剥：先「第 N 条」，再行号，最后标点。
  // 顺序不能反 —— 先剥标点会把 `日志\x.md:94` 的冒号吃掉，行号就成了路径的一部分。
  //
  // 剥的过程要**循环**：`... 第 3 条:88` 这种「条目号在前、行号在后」的写法真实存在
  // （`check-refs.mjs` 的 RE_TICK 就允许多个后缀任意组合），单跑一遍会让 `第 3 条`
  // 因为不在末尾而漏剥，反手又把整串当成「含空格的命令串」，条目号静默变 0。
  let entry = 0;
  let line = 0;
  for (;;) {
    const before = s;
    const em = ENTRY_SUFFIX.exec(s);
    if (em) {
      if (entry === 0) entry = Number(em[1]);
      s = s.slice(0, em.index);
    }
    const lm = LINE_SUFFIX.exec(s);
    if (lm) {
      if (line === 0) line = Number(lm[1]);
      s = s.slice(0, lm.index);
    }
    if (s === before) break;
  }

  s = s.replace(TRAILING_PUNCT, '').trim();
  if (s === '') return null;

  // 含空格的整串不是路径 —— 要么是命令（`node 日志\build-index.mjs`），
  // 要么是带空格的目录名（`D:\Program Files\DSH\DSH.exe`）。
  // 取最后一个带扩展名的片段：命令串能得到正确的文件；带空格的目录名会被截断成
  // `Files\DSH\DSH.exe`，这是**已知缺陷，接受** —— 带空格路径在实测 1292 处里只有 2 处，
  // 而为此做引号配对解析会引入「引号在命令里是语法还是分隔」的新歧义。
  if (/\s/.test(s)) {
    const parts = s.split(/\s+/).filter((x) => EXT.test(x));
    if (parts.length === 0) return null;
    s = parts[parts.length - 1];
  }

  if (!EXT.test(s)) return null;
  const path = normalizePath(s);
  if (path === '') return null;

  return { path, line, entry, logPath: asLogPath(path) };
}

/**
 * 从一段连续的行里提取出链。
 *
 * 扫描范围是**整条条目**：标题行、正文段行、子项行、围栏内行都算。围栏里贴的命令
 * 引用的文件同样是真实的引用关系，排除它会让「这条改过什么」漏掉一半。
 *
 * 去重规则（定案 A4a）：同一条目里同一个路径只留第一次出现的那处 —— 重复五次不会
 * 提供更多信息，而一条日志正文能到 1500 字符，全列出会把真实信息淹掉。
 *
 * **但去重键是「路径 + 条目号」，不是路径**。同一文件的第 11 条和第 13 条是两件事，
 * 按路径去重会把后者整个吞掉（`tools\check-refs.mjs:268` 的去重键也带条目号）。
 *
 * @param {string[]} lines 该条目的全部行（0-based，首行是条目行）。
 * @param {number} baseLine 首行在文件里的 1-based 行号。
 * @returns {Array<{path: string, logPath: string|null, line: number, entry: number,
 *   entryRange: [number, number]|null, atLine: number, raw: string}>} 出链列表，
 *   按出现顺序。`entryRange` 不为 null 时 `entry` 等于区间起点（给下游当单值用）。
 */
export function extractFromLines(lines, baseLine, fileIndex) {
  const out = [];
  const seen = new Set();

  for (let i = 0; i < lines.length; i++) {
    const text = lines[i];
    if (typeof text !== 'string' || !text.includes('`')) continue;
    for (const m of text.matchAll(TICK)) {
      const parsed = parseTicked(m[1]);
      if (!parsed) continue;

      // 裸名归一（问题 2）：日志里既写过 `` `check-doc-map.mjs` `` 也写过
      // `` `tools\check-doc-map.mjs` ``，不归一就会在出链里算成两个文件、总数虚高。
      // 归一的前提是**全库只有这一个同名文件** —— 有多个时不能猜，
      // 猜成任何一个都会让「谁引用了 tools\说明.md」多出三条假的入链。
      let bare = false;
      let ambiguous = null;
      if (parsed.logPath === null && !parsed.path.includes('\\') && fileIndex) {
        const cands = fileIndex.get(parsed.path);
        if (cands !== undefined && cands.length === 1) {
          parsed.path = cands[0];
        } else if (cands !== undefined) {
          bare = true;
          ambiguous = cands;
        } else {
          // 工作区里根本没有这个名字（可能是别的工作区的文件，或者已经删了）。
          // 保留原样 —— 日志是历史快照，当时的东西现在没有不代表它没存在过。
          bare = true;
        }
      }

      // 闭引号之后的「第 N 条」优先 —— 那是标准写法。反引号内写的只作为兜底。
      // 并列写法（`第 11 条与第 13 条`）会展开成多条出链；范围写法（`第 38–56 条`）
      // 保留成一条带 `entryRange` 的引用，不展开 —— 展开会让出链数虚高 19 倍，
      // 且渲染出 19 行只有编号不同的条目没有任何信息量。
      const chain = readEntryChain(text, m.index + m[0].length);
      if (chain.range) {
        const [lo, hi] = chain.range;
        const key = `${parsed.path}|${lo}-${hi}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...parsed,
          entry: lo,
          entryRange: [lo, hi],
          bare,
          ambiguous,
          atLine: baseLine + i,
          raw: text,
        });
        continue;
      }
      const entries = chain.entries.length > 0 ? chain.entries : [parsed.entry];
      for (const entry of entries) {
        const key = `${parsed.path}|${entry ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          ...parsed,
          entry,
          entryRange: null,
          bare,
          ambiguous,
          atLine: baseLine + i,
          raw: text,
        });
      }
    }
  }
  return out;
}

/**
 * 把一整个日志库解析成「每条目 + 出链」的列表。
 *
 * 入链查询必须全库扫一遍。不缓存的原因：日志是用户随时在写的文件，缓存会给出陈旧
 * 结果；一次 200 条 / 25 万字符的扫描在毫秒级，宁可重算。
 *
 * @param {string} logDir 日志目录绝对路径。
 * @param {Map<string, string[]>|null} [fileIndex] `indexWorkspaceFiles()` 的表，
 *   用来归一裸名引用。不给就保持原样（CLI/插件都会给）。
 * @returns {{items: Array<object>, fileCount: number, charTotal: number,
 *   dates: string[]}} `items` 每项在原条目上多一个 `links`（出链数组）。
 */
export function indexLinks(logDir, fileIndex) {
  const { entries, fileCount, charTotal } = loadLogs(logDir);

  // 按文件分组 —— 条目的行范围要靠同一文件的全部条目才算得出来。
  const byFile = new Map();
  for (const e of entries) {
    let list = byFile.get(e.file);
    if (list === undefined) {
      list = [];
      byFile.set(e.file, list);
    }
    list.push(e);
  }

  const items = [];
  for (const [file, list] of byFile) {
    let lines;
    try {
      lines = readFileSync(join(logDir, file), 'utf8')
        .replace(/\r+\n/g, '\n')
        .split('\n')
        .map((l) => l.replace(/\r$/, ''));
      if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
    } catch {
      lines = [];
    }

    for (let k = 0; k < list.length; k++) {
      const start = list[k].line - 1; // 0-based，指向条目行
      const end = k + 1 < list.length ? list[k + 1].line - 1 : lines.length;
      const ranged = lines.slice(start, Math.max(start, end));
      items.push({ ...list[k], links: extractFromLines(ranged, list[k].line, fileIndex) });
    }
  }

  // 排序：日期正序 + 条目号正序。loadLogs 已经按文件名排过，但条目多了之后
  // 这个顺序不能靠上游保证 —— 输出要稳定。
  items.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return a.num - b.num;
  });

  const dates = [...new Set(items.map((i) => i.date))];
  return { items, fileCount, charTotal, dates };
}

/**
 * 判断一条出链是否指向 target。
 *
 * 匹配用「尾部路径段」而不是严格相等：日志里同一个文件有时写全路径
 * （`tools\check-refs.mjs`），有时只写裸名（`check-refs.mjs`）—— 严格相等会让
 * 「查 `tools\check-refs.mjs`」漏掉所有裸名引用。
 *
 * @param {object} link 出链。
 * @param {{kind: 'log'|'file', logPath?: string|null, path?: string}} target 解析后的目标。
 * @returns {boolean}
 */
export function matchesTarget(link, target) {
  if (target.kind === 'log') {
    return link.logPath !== null && link.logPath === target.logPath;
  }
  const want = normalizePath(target.path);
  const have = link.path;
  if (have === want) return true;
  if (have.endsWith(`\\${want}`)) return true;
  // 裸名（`` `说明.md` ``）**不再按文件名放宽匹配**。
  //
  // 早先这里是 `want.split('\\').pop() === have`，看着合理，实测是把
  // 查 `tools\说明.md` 变成「全库四个 说明.md 的引用全算它的」—— 而且不报错，
  // 只是数量悄悄从 20 条变成 33 条。
  //
  // 现在裸名在 `extractFromLines` 里就已经归一了：全库唯一时补成全路径（于是走上面
  // 两条命中），有同名时保留裸名并标 `ambiguous`（于是**不命中**，由
  // `findBareSuspects` 单独列出来说「这几处指向不明」）。猜错比查不到更糟。
  return false;
}

/**
 * 查入链：哪些日志条目引用了 target。
 *
 * @param {Array<object>} items `indexLinks()` 的 items。
 * @param {object} target 解析后的目标。
 * @returns {Array<{item: object, links: object[]}>} 命中的条目（每条目内只留命中的链）。
 */
export function findInLinks(items, target) {
  const hasEntry = target.entry !== undefined && target.entry !== null;
  const hits = [];
  for (const item of items) {
    const matched = item.links.filter((l) => matchesTarget(l, target));
    if (matched.length === 0) continue;
    // target 指到具体条目时，只有「引用时也写了同一个条目号」才算。
    // 这不是苛刻，是唯一说得通的语义：`日志\x.md`（不带条目）和
    // `日志\x.md 第 3 条` 指向两样东西，混为一谈会让「第 3 条被谁引用」不准。
    //
    // 例外是**范围引用**（`第 38–56 条`）：它确实覆盖了第 40 条，说「没引用第 40 条」
    // 是错的。但也不能算成「精确命中第 40 条」—— 它引用的是那一段。所以标进 same 数组
    // 由渲染层说明「这一条是按范围引用的，不是逐条点名」。
    if (hasEntry) {
      const exact = matched.filter((l) => l.entry === target.entry && !l.entryRange);
      const within = matched.filter(
        (l) => l.entryRange && inRange(target.entry, l.entryRange),
      );
      if (exact.length === 0 && within.length === 0) continue;
      hits.push({ item, links: [...exact, ...within] });
      continue;
    }
    hits.push({ item, links: matched });
  }
  return hits;
}

/**
 * 查「可能是它、但不敢肯定」的引用：只写了文件名、而全库有多个同名文件。
 *
 * 为什么不混进正经入链里：混进去等于替用户拍板「这几处说的就是 `tools\说明.md`」。
 * 四个 `说明.md` 里到底指哪个，只有当时写的人知道；不知道就说不知道，
 * 用户一眼能判断「哦这些可能也算」，比给出精确但错误的数字好。
 *
 * @param {Array<object>} items `indexLinks()` 的 items。
 * @param {object} target 解析后的目标（`kind === 'file'` 才有意义）。
 * @returns {Array<{item: object, links: object[]}>} 疑似命中，结构同 `findInLinks()`。
 */
export function findBareSuspects(items, target) {
  if (target.kind !== 'file') return [];
  const base = normalizePath(target.path).split('\\').pop();
  const hits = [];
  for (const item of items) {
    const matched = item.links.filter(
      (l) => l.logPath === null && l.ambiguous !== null && l.path.split('\\').pop() === base,
    );
    if (matched.length > 0) hits.push({ item, links: matched });
  }
  return hits;
}

/**
 * 条目号是否落在一个范围内。容忍写反（`56–38`）—— 那多半是笔误，但按「区间」理解
 * 仍然比「什么都不命中」有用；渲染层会把原样写法显示出来，用户看得见。
 *
 * @param {number} n 条目号。
 * @param {[number, number]} range 区间。
 * @returns {boolean}
 */
export function inRange(n, range) {
  const lo = Math.min(range[0], range[1]);
  const hi = Math.max(range[0], range[1]);
  return n >= lo && n <= hi;
}

/**
 * 把用户写的 target 解析成结构化目标。
 *
 * 三种合法写法（定案 B2a / B5a）：
 * - `日志\2026-10-23.md` → 整个文件的链
 * - `日志\2026-10-23.md 第 10 条` → 只算第 10 条
 * - `tools\check-refs.mjs` → 任意工作区文件的链
 *
 * 只写 `2026-10-23.md`（不带 `日志\`）时自动补前缀 —— 日期文件名在工作区里唯一，
 * 猜不歧义。其他文件名**不猜**：全库有多个 `说明.md`，猜错比报错更糟。
 *
 * @param {string} raw 用户给的原串。
 * @param {string[]} knownDates 库里实际存在的日期（`YYYY-MM-DD` 数组）。
 * @returns {{ok: true, kind: 'log'|'file', logPath?: string, path?: string,
 *   entry?: number, label: string} | {ok: false, message: string}}
 */
export function resolveTarget(raw, knownDates) {
  let s = String(raw ?? '').trim();
  if (s === '') {
    return {
      ok: false,
      message: '没有给 target。要查「这条引用了谁」或「谁引用了它」，得说明查哪个。'
        + '例如 `日志\\2026-10-23.md 第 10 条` 或 `tools\\check-refs.mjs`。',
    };
  }

  // 「第 N 条」在末尾，先摘下来。
  let entry;
  const em = /\s*第\s*(\d+)\s*条\s*$/.exec(s);
  if (em) {
    entry = Number(em[1]);
    s = s.slice(0, em.index).trim();
  }

  // 行号后缀不算 target 的一部分（`日志\x.md:88` 和 `日志\x.md` 是同一个目标）。
  s = s.replace(LINE_SUFFIX, '').trim();
  s = s.replace(TRAILING_PUNCT, '').trim();

  const path = normalizePath(s);
  const logPath = asLogPath(path);

  if (logPath !== null) {
    const date = logPath.slice('日志\\'.length, -'.md'.length);
    if (!knownDates.includes(date)) {
      return { ok: false, message: notFoundMessage(logPath, date, knownDates) };
    }
    return {
      ok: true,
      kind: 'log',
      logPath,
      entry,
      label: entry !== undefined ? `${logPath} 第 ${entry} 条` : logPath,
    };
  }

  // 不是日期文件 —— 要求写全路径（B2a）。裸名一律拒绝，因为全库有多个 `说明.md`。
  if (!/[\\/]/.test(path)) {
    return {
      ok: false,
      message: `「${path}」没带目录，无法确定是哪个文件（全库有多个同名文件）。\n`
        + '请写全路径，例如 `tools\\check-refs.mjs`；日志文件可以只写日期，如 `2026-10-23.md`。',
    };
  }
  if (!EXT.test(path)) {
    return {
      ok: false,
      message: `「${path}」不像文件路径（没有可识别的扩展名）。要查日志就用 \`日志\\YYYY-MM-DD.md\`。`,
    };
  }

  return { ok: true, kind: 'file', path, label: path };
}

/**
 * target 的日期不存在时，给一句带候选的报错（B1b）。
 *
 * 猜的逻辑刻意保守：只试前后 1-2 天。反查失败的绝大多数是「记成 23 号、其实是 22 号」，
 * 差一天就够；差一个月的情况猜了也是错，不如让人去翻索引。
 *
 * @param {string} logPath 找不到的标准路径。
 * @param {string} date `YYYY-MM-DD`。
 * @param {string[]} knownDates 库里实际存在的日期。
 * @returns {string} 报错文本。
 */
export function notFoundMessage(logPath, date, knownDates) {
  const lines = [`找不到 \`${logPath}\`：日志里没有 ${date} 这一天。`];
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isFinite(base)) {
    const near = [];
    for (const d of [-2, -1, 1, 2]) {
      const t = new Date(base + d * 86400000).toISOString().slice(0, 10);
      if (knownDates.includes(t)) near.push(t);
    }
    if (near.length > 0) {
      lines.push('');
      lines.push(`你是不是想找：${near.map((t) => `\`日志\\${t}.md\``).join(' 或 ')}`);
    }
  }
  if (knownDates.length > 0) {
    lines.push('');
    lines.push(`库里共有 ${knownDates.length} 天：${knownDates[0]} … ${knownDates[knownDates.length - 1]}`);
  }
  return lines.join('\n');
}

/**
 * 把一行原文截到可读长度。
 *
 * @param {string} text 原文行。
 * @returns {string} 截断后的文本（不含换行）。
 */
export function clipRaw(text) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim();
  return t.length <= RAW_MAX ? t : `${t.slice(0, RAW_MAX)}…`;
}

/**
 * 渲染出链块。
 *
 * @param {object} item 条目（含 `links`）。
 * @returns {string} 文本。
 */
export function renderOut(item) {
  const head = `【出链】${item.date} 第 ${item.num} 条「${item.title}」`;
  if (item.links.length === 0) {
    return [
      head,
      '',
      '这条没有引用任何文件（正文里没有反引号包住的路径）。',
    ].join('\n');
  }

  // 日志置顶（用户 m02203 要求）：日志引用排最前，普通文件靠后。
  // 为什么是日志优先 —— 指向日志的那条还能继续往下追（那就还有下一条，
  // 顺藤摸瓜能摸到源头）；指向普通文件的那条到此为止。
  // 同组内保持原出现顺序（`sort` 是稳定的），不要按行号重排，
  // 那样会把「标题里提一次、正文里再提一次」的上下文拆散。
  const ordered = [...item.links].sort((a, b) => {
    const ra = a.logPath !== null ? 0 : 1;
    const rb = b.logPath !== null ? 0 : 1;
    return ra - rb;
  });

  const logCount = ordered.filter((l) => l.logPath !== null).length;
  const tag = logCount > 0 && logCount < ordered.length
    ? `引用了 ${ordered.length} 处（日志 ${logCount} · 文件 ${ordered.length - logCount}）`
    : `引用了 ${ordered.length} 处`;
  const lines = [head, tag, ''];
  for (const l of ordered) {
    const tags = [];
    if (l.logPath !== null) {
      if (l.entryRange) tags.push(`日志·第 ${l.entryRange[0]}–${l.entryRange[1]} 条`);
      else if (l.entry > 0) tags.push(`日志·第 ${l.entry} 条`);
      else tags.push('日志·未指定条目');
    } else {
      tags.push('文件');
    }
    if (l.line > 0) tags.push(`:${l.line}`);
    lines.push(`- \`${l.path}\`　[${tags.join(' ')}]`);
    if (l.atLine > 0) lines.push(`  ${`日志\\${item.file}`}:${l.atLine}`);
    lines.push(`  ${clipRaw(l.raw)}`);
    // 只写了文件名、全库又有多个同名文件 —— 这处到底指哪个，只有当时写的人知道。
    // 不说的话，读者会以为「这已经查清楚了」。
    if (l.ambiguous && l.ambiguous.length > 1) {
      lines.push(`  ↑ 这里只写了文件名，全库有 ${l.ambiguous.length} 个同名：${l.ambiguous.map((x) => `\`${x}\``).join('、')}。指向不明，工具不替你猜。`);
    }
    // 反引号后面写的是「第 11/13 条」这种并列缩写 —— 解析器拒绝猜，所以上面那行
    // 会显示成「未指定条目」。不说明的话，读起来像是「这里没写条目号」，与事实不符。
    if (SLASH_ENTRY_ANY.test(l.raw)) {
      lines.push('  ↑ 这行有一处 `第 N/M 条` 并列写法，工具不认 —— 它按「整个文件」计入，不是条目级。要精确反查，把它拆成两条各写全路径。');
    }
    lines.push('');
  }
  return lines.join('\n').trimEnd();
}

/**
 * 渲染文件级出链的**紧凑摘要**。
 *
 * 为什么文件级不能逐条展开：一个 29 条的文件逐条渲染是 47,000 字符（实测
 * `2026-10-24.md`），最长的 `2026-10-22.md` 是 68,938 —— 一次调用就能把上下文吃掉。
 * 文件级问的是「这天大致牵到哪些东西」，答案是一张清单，不是全部原文。
 *
 * 要原文就用条目级（`... 第 N 条`）单查，那是按需下钻，不是一次性倾倒。
 *
 * @param {Array<object>} items 该文件下的条目。
 * @returns {string} 文本。
 */
export function renderOutFile(items) {
  const withLinks = items.filter((i) => i.links.length > 0);
  const total = items.reduce((n, i) => n + i.links.length, 0);
  const lines = [
    `【出链】${items[0].date} 全部 ${items.length} 条：${withLinks.length} 条有出链，共 ${total} 处`,
    '',
  ];
  if (withLinks.length === 0) {
    lines.push('这个文件里没有任何条目引用文件。');
    return lines.join('\n');
  }
  for (const it of withLinks) {
    const paths = it.links.map((l) => l.path).join('、');
    lines.push(`- 第 ${it.num} 条「${it.title}」→ ${it.links.length} 处：${paths}`);
  }
  lines.push('');
  lines.push('要某一处的原文，用条目级再查一次：`日志\\YYYY-MM-DD.md 第 N 条`。');
  return lines.join('\n');
}

/**
 * 渲染入链块。
 *
 * @param {Array<{item: object, links: object[]}>} hits `findInLinks()` 的返回。
 * @param {object} target 解析后的目标。
 * @param {{items: number, fileCount: number}} scope 扫描范围。
 * @param {Array<{item: object, links: object[]}>} [suspects] `findBareSuspects()`
 *   的返回，附在末尾说明「还有几处指向不明」。
 * @returns {string} 文本。
 */
export function renderIn(hits, target, scope, suspects = []) {
  const head = `【入链】${target.label}`;
  const where = `检索范围：日志\\*.md 的 ${scope.items} 条正文（${scope.fileCount} 个文件）。`;

  if (hits.length === 0) {
    const empty = [
      head,
      '',
      '没有日志条目引用它。',
      '',
    ];
    if (suspects.length > 0) {
      const n = suspects.reduce((k, s) => k + s.links.length, 0);
      empty.push(
        `但有 ${n} 处只写了文件名、没带目录，而全库有多个同名文件 —— 那几处可能就是指它，也可能不是：`,
      );
      for (const s of suspects.slice(0, SUSPECT_SHOW_MAX)) {
        empty.push(`- ${s.item.date} 第 ${s.item.num} 条「${s.item.title}」　\`日志\\${s.item.file}:${s.item.line}\``);
      }
      empty.push('');
    }
    empty.push(
      where,
      '**这里查不到不代表没人引过** —— 可能是当时用了别的写法（裸文件名、`..\\` 相对路径、',
      '只写在别的文档里）。换个写法再试，或先用 `worklog_query` 搜一下相关记录。',
    );
    return empty.join('\n');
  }

  // 排序两条规则叠加：
  //
  // 一、**精确写了条目号的排前面**（用户 m02203 要求「入链也置顶」）。
  //     查「第 40 条被谁引过」时，写了 `第 40 条` 的那处是点名的，写 `第 38–56 条`
  //     的是覆盖到的，只写文件名的则完全没落到条目。三者可信度依次下降，
  //     混在一起排会让「到底谁点的名」看不出来。
  //
  // 二、同档内日期倒序 —— 用「上次那条怎么回事」的场景里，近的比远的有用。
  const rank = (h) => {
    if (h.links.some((l) => l.entry > 0 && !l.entryRange)) return 0;
    if (h.links.some((l) => l.entryRange)) return 1;
    return 2;
  };
  const sorted = [...hits].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (a.item.date !== b.item.date) return a.item.date < b.item.date ? 1 : -1;
    return b.item.num - a.item.num;
  });

  const totalLinks = sorted.reduce((n, h) => n + h.links.length, 0);
  const exactCount = sorted.filter((h) => rank(h) === 0).length;
  const summary = exactCount > 0 && exactCount < sorted.length
    ? `${sorted.length} 条日志共 ${totalLinks} 处提到了它（其中 ${exactCount} 条精确写了条目号，排在前面）`
    : `${sorted.length} 条日志共 ${totalLinks} 处提到了它`;
  const lines = [head, summary, ''];

  for (const h of sorted) {
    const it = h.item;
    lines.push(`- ${it.date} 第 ${it.num} 条「${it.title}」　\`日志\\${it.file}:${it.line}\``);
    for (const l of h.links) {
      // 按范围引用的要标出来：用户查「第 40 条被谁引过」，命中的那处写的是
      // `第 38–56 条` —— 说成「精确引用」会让人以为对方点的是名。
      const how = l.entryRange ? `（按范围引用：第 ${l.entryRange[0]}–${l.entryRange[1]} 条）` : '';
      lines.push(`  原文${how}：${clipRaw(l.raw)}`);
    }
    lines.push('');
  }

  // 指向不明的那几处单独说，不混进上面的数里 —— 混进去等于替用户拍板
  // 「这几处说的就是它」，而那正是要避免的假精确。
  //
  // 已经有正经命中时只报数字不逐条列：实测查 `tools\说明.md` 会带出 14 处
  // 「只写了 `说明.md`」的历史引用，逐条列出来会把真正的 1 条淹掉。
  // 一条正经命中都没有时才详列 —— 那时它们是唯一的线索。
  if (suspects.length > 0) {
    const n = suspects.reduce((k, s) => k + s.links.length, 0);
    const shown = hits.length === 0 ? Math.min(suspects.length, SUSPECT_SHOW_MAX) : 0;
    lines.push(
      `另有 ${n} 处只写了文件名、没带目录，而全库有多个同名文件 —— 无法判断是不是指它，未计入上面的数字：`,
    );
    for (const s of suspects.slice(0, shown)) {
      lines.push(`- ${s.item.date} 第 ${s.item.num} 条「${s.item.title}」　\`日志\\${s.item.file}:${s.item.line}\``);
    }
    if (shown === 0) {
      lines.push('（要看看是哪些，用 `worklog_query` 搜文件名。）');
    } else if (suspects.length > shown) {
      lines.push(`- ……还有 ${suspects.length - shown} 条，用 \`worklog_query\` 搜文件名能找到。`);
    }
    lines.push('');
  }

  lines.push(where);
  return lines.join('\n').trimEnd();
}

/**
 * 统计「引用日志但没写条目号」的有多少处（C4b 的末尾提示用）。
 *
 * 不算进主输出，只在末尾说一句。现状下这是绝大多数 —— 实测 45 处日志间引用里
 * 带条目号的是 0 处。假装它们不存在会让工具看起来比实际更好用。
 *
 * @param {Array<object>} items 所有条目。
 * @returns {{total: number, bare: number}} 日志间引用总数 / 其中没写条目号的。
 */
export function tallyBareLogRefs(items) {
  let total = 0;
  let bare = 0;
  for (const item of items) {
    for (const l of item.links) {
      if (l.logPath === null) continue;
      total++;
      // 范围引用（`第 38–56 条`）是条目级的，不算「只写了文件名」。
      if (l.entry === 0 && !l.entryRange) bare++;
    }
  }
  return { total, bare };
}
