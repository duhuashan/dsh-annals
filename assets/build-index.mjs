// 从工作区根的 `日志\` 生成 `_日志索引.md`。
// 用法：node 日志\build-index.mjs
//       node 日志\build-index.mjs --explain   # 只报每行归属的行类型，不写索引
// 零依赖。读日志，写工作区根的 _日志索引.md；顺带把日志文件的行尾修正成 CRLF。
//
// 骨架格式（2026-10-25 起，见技能正文 §2.1）：
//   1 date   # YYYY-MM-DD                      每文件恰好 1 条，第一个非空行
//   2 blank  长度 0                            只允许出现在 5 处，每处恰好 1 个
//   3 entry  N. [k=v…] **标题**                顶层无缩进，尾部不许再有内容
//   4 body   W 空格 + "正文：" + 内容           每条恰好 1 个，非空，单行
//   5 item   W 空格 + "- " + 内容              0..n
//   6 fence  W+2 空格 + ``` 围栏               只能在 item 内，内部原样
// 其中 W = 编号位数 + 2（`1. ` → 3 空格，`10. ` → 4 空格）。
// 归不进这 6 类的行一律 FAIL「未归类行」—— 这是「每一行都有定义」的机器保证。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));
const EXPLAIN = process.argv.includes('--explain');

// 判据：目录里有 .md 文件。
// 注意这里**不能**只认 YYYY-MM-DD.md —— 那样「日志目录里只有 2026-10-22-补充.md」
// 会被判成「找不到工作区」，真正的原因（文件名不合规范）永远报不出来。
// 放宽到 *.md 之后，这种情况能走到文件名校验，报出人话。
function hasMdFile(dir) {
  try {
    return readdirSync(dir).some((f) => /\.md$/i.test(f));
  } catch {
    return false;
  }
}

// 工作区锚点就是脚本自己：只认两种合法位置，别处一律报错。
// 不猜、不错建 —— 脚本被挪到无关目录时立刻失败，而不是把索引写到某个碰巧有 日志\ 的目录。
//   A. <工作区>\日志\build-index.mjs  → 工作区根 = 上级目录
//   B. <工作区>\build-index.mjs       → 工作区根 = 自己所在目录
let WORK_ROOT = null;
let LOG_DIR = null;
let baseCase = null;
if (basename(SELF_DIR) === '日志' && hasMdFile(SELF_DIR)) {
  WORK_ROOT = dirname(SELF_DIR);
  LOG_DIR = SELF_DIR;
  baseCase = 'A';
} else if (hasMdFile(join(SELF_DIR, '日志'))) {
  WORK_ROOT = SELF_DIR;
  LOG_DIR = join(SELF_DIR, '日志');
  baseCase = 'B';
}

if (!WORK_ROOT) {
  console.error('找不到工作区。build-index.mjs 只允许放在：');
  console.error('  1) <工作区>\\日志\\build-index.mjs');
  console.error('  2) <工作区>\\build-index.mjs');
  console.error(`当前：${SELF_DIR}`);
  console.error('工作区必须包含 日志\\ 目录，且其中至少一个 .md 文件。');
  process.exit(1);
}

const OUT = join(WORK_ROOT, '_日志索引.md');

if (!EXPLAIN) {
  console.log(`✓ 工作区：${WORK_ROOT}`);
  console.log(`  日志目录：${LOG_DIR}`);
  console.log(`  输出：${OUT}`);
}

// 条目行：顶层无缩进、编号 + 可选方括号字段 + 加粗标题，**行尾不许再有任何东西**。
// 加 `\s*$` 是 2026-10-25 的结构化改造：旧写法 `N. **标题** —— 正文` 把正文黏在
// 标题行上，导致「标题」和「正文」在同一行里没有各自的位置。现在正文必须独立成段
// （body 行），词法上就不可能再黏回去。
const ENTRY = /^(\d+)\.\s+(?:\[[a-z][a-z0-9-]*=[^\]]*\]\s*)*\*\*(.+?)\*\*\s*$/;
// 日期标题：容忍行首空白（有人从别处复制会带前导空格）。
const DATE_TITLE = /^\s*#\s+(\d{4}-\d{2}-\d{2})\s*$/;
// 「看起来像条目但写法不对」：全角数字、全角句点、顿号、以及 `1.**`（缺空格）。
// 这些形状 ENTRY 匹配不上，于是整条静默消失，一条 FAIL/WARN 都没有 ——
// 必须单独捞出来，否则是最坏形态：以为记下了，索引里根本没有。
const LOOSE_ENTRY = /^[０-９\d]+\s*[.．、]\s*\*\*/;
// 代码围栏。围栏内的一切都是内容，不参与任何判定。
const FENCE = /^\s*(?:```|~~~)/;
// 正文段与子项的前缀。缩进宽度另校验。
const BODY_PREFIX = /^( *)(正文：)(.*)$/;
const ITEM_PREFIX = /^( *)- (.*)$/;

// 空行只允许出现在这 5 个位置（前一个非空行 kind → 后一个非空行 kind）。
// 每处恰好 1 个。多一个、错位置、连续两个、文件首尾 —— 全是 FAIL。
const BLANK_OK = new Set(['date→entry', 'entry→body', 'body→item', 'body→entry', 'item→entry']);

const errors = [];
const warnings = [];
const entries = [];
const fixedEol = [];
const strippedBom = [];
const explainLines = [];
const kindCount = { date: 0, blank: 0, entry: 0, body: 0, item: 0, fence: 0, fenceInner: 0, unclassified: 0 };

// 文件名必须是 YYYY-MM-DD.md。不合规范的**不静默跳过** —— 整份日志会被吞掉，
// 一条都不会进索引，而且什么信号都没有。判据只看「像不像日期」：完全不相关的
// 说明文件（README.md 之类）放过，日期形状的（2026-10-22-补充.md、20261022.md）报。
const DATE_LIKE = /^\d{4}[-_]?\d{2}[-_]?\d{2}/;
const files = [];
for (const name of readdirSync(LOG_DIR)) {
  if (!/\.md$/i.test(name)) continue;
  if (/^\d{4}-\d{2}-\d{2}\.md$/.test(name)) {
    files.push(name);
    continue;
  }
  if (DATE_LIKE.test(name)) {
    errors.push(`${name}: 文件名不合规范，整份日志不会进索引（应为 YYYY-MM-DD.md）`);
  }
}
files.sort();

if (files.length === 0) {
  console.error(`日志目录里没有 YYYY-MM-DD.md：${LOG_DIR}`);
  // 先把已经攒下的 FAIL 打出来再退出。否则「目录里只有一个 2026-10-22-补充.md」
  // 这种情况只会说「没有 YYYY-MM-DD.md」，真正的原因（文件名不合规范）被吞掉，
  // 人会以为日志丢了。
  if (errors.length) {
    console.error(`\nFAIL ${errors.length}`);
    for (const e of errors) console.error(`  ${e}`);
  }
  process.exit(1);
}

// 位置提示：B 情形下，若祖先目录里也有 日志\，很可能脚本被复制到了子目录。
// 只是提示，不阻断 —— 子目录确实可以是独立工作区。
if (baseCase === 'B') {
  let probe = dirname(WORK_ROOT);
  for (let depth = 0; depth < 6 && probe !== dirname(probe); depth++, probe = dirname(probe)) {
    if (hasMdFile(join(probe, '日志'))) {
      warnings.push(`${WORK_ROOT}: 祖先目录 ${probe} 下也有 日志\\，确认脚本没放错位置`);
      break;
    }
  }
}

for (const file of files) {
  const dateFromName = basename(file, '.md');
  const fullPath = join(LOG_DIR, file);
  const firstEntryIdx = entries.length;

  // 文件名校验：形状对 `\d{4}-\d{2}-\d{2}` 之外，还要真的是个日期。
  // 2026-13-45.md 这种「形状合法但日期不存在」的，静默收进索引毫无意义。
  const parsed = new Date(`${dateFromName}T00:00:00`);
  const roundTrip = `${String(parsed.getFullYear()).padStart(4, '0')}-${String(parsed.getMonth() + 1).padStart(2, '0')}-${String(parsed.getDate()).padStart(2, '0')}`;
  if (Number.isNaN(parsed.getTime()) || roundTrip !== dateFromName) {
    errors.push(`${file}: 文件名里的日期不存在（${dateFromName}），不会被收录`);
    continue;
  }

  let raw;
  try {
    raw = readFileSync(fullPath, 'utf8');
  } catch (err) {
    // 目录同名、权限不足、被占用…… 默认行为是把整个栈喷出来、索引不生成。
    // 对使用者来说「哪一行错了」比栈有用，所以转成一条 FAIL 并继续处理其它文件。
    const hint =
      err.code === 'EISDIR'
        ? '这是个目录，不是文件'
        : err.code === 'EPERM' || err.code === 'EACCES'
          ? '没有读写权限（只读或被占用）'
          : `${err.code || err.name}: ${err.message}`;
    errors.push(`${file}: 读不出来 —— ${hint}`);
    continue;
  }

  // UTF-8 BOM：PowerShell 5 的 Out-File、某些编辑器会加。
  // 不剥的话第一行永远不是 `# YYYY-MM-DD`，报 FAIL 而条目其实解析得好好的 ——
  // 自相矛盾的信号。剥掉再继续，并且写回时一并清掉。
  const hadBom = raw.startsWith('\uFEFF');
  const text = hadBom ? raw.slice(1) : raw;

  // 编码自检：非法/非 UTF-8 字节被 readFileSync 解成 U+FFFD。
  // 不报的话整份日志会以乱码进索引，而退出码是 0。
  if (text.includes('\uFFFD')) {
    warnings.push(`${file}: 含无法解码的字节（疑似非 UTF-8），索引里会是乱码`);
  }

  // 行尾统一成 CRLF。写文件的工具默认输出 LF，光靠约定守不住，
  // 这里每次运行顺手修正 —— 它跑的时候日志文件一定已经写完了。
  // 只动行尾，不动任何字；修不出问题再报。
  //
  // 第一句必须是 `/\r+\n/` 而不是 `/\r\n/`：遇已损坏的 `\r\r\n` 时，
  // `/\r\n/g` 只吃后一个 CR 得到 `\r\n`，第二句又把 `\n` 变回 `\r\n`，净效果为零
  // —— 跑完字节一个不变，且什么信号都没有（PowerShell 的 Set-Content/Out-File
  // 对已含 CRLF 的字符串会按 \n 分行再以 \r\n 连接，孤立 CR 就是这么来的）。
  // `\r+` 把任意多个连续 CR 先收敛成一个，再统一转 CRLF，修复与幂等同时成立。
  const crlf = text.replace(/\r+\n/g, '\n').replace(/\n/g, '\r\n');
  if (crlf !== text || hadBom) {
    try {
      writeFileSync(fullPath, crlf, 'utf8');
      if (crlf !== text) fixedEol.push(file);
      if (hadBom) strippedBom.push(file);
    } catch (err) {
      // 写不进去不要紧：内存里已经有收敛好的 crlf，继续拿它解析，
      // 索引不会缺条目。只是纠正落不了盘，报出来让人知道。
      const hint =
        err.code === 'EPERM' || err.code === 'EACCES' ? '文件只读或被占用' : `${err.code || err.name}: ${err.message}`;
      errors.push(`${file}: 行尾/BOM 修正写不回去 —— ${hint}（索引按内存内容生成，不受影响）`);
    }
  }

  const lines = crlf.split('\n');
  // split('\n') 之后每行末尾可能带 \r（CRLF 文件），统一剥掉再匹配
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\r$/, '');
  // 文件末尾的那个空元素是「最后一个换行符之后」，不是一行内容
  const tailIdx = lines.length > 0 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;

  // 校验第一个非空行是日期标题、且与文件名一致（自证）
  const firstContent = lines.findIndex((l, i) => i < tailIdx && l.trim() !== '');
  if (firstContent === -1) {
    errors.push(`${file}: 空文件`);
    continue;
  }
  const m = DATE_TITLE.exec(lines[firstContent]);
  if (!m) {
    errors.push(`${file}:${firstContent + 1} 第一行不是 "# YYYY-MM-DD" 日期标题`);
  } else if (m[1] !== dateFromName) {
    errors.push(`${file}:${firstContent + 1} 日期标题 ${m[1]} 与文件名 ${dateFromName} 不一致`);
  }

  // 单日规模不做检查。曾经有条 20,000 字符的 WARN，2026-10-22 取消：
  // 长度不是质量的判据（一天一个文件本身已经限制了最大规模），且历史文件
  // 一旦超线就会永久报警、修不掉，只会训练出对 WARN 的麻木。检索靠向量，
  // 不靠人肉控制单文件长度。

  // ---- 逐行分类 ----
  // 每个元素：{ kind, i, ... }。kindCount 顺便累计，供报告输出。
  const kinds = new Array(tailIdx).fill('unclassified');
  let lastNum = 0;
  let lastEntryLine = -1;
  let inFence = false;
  let fenceStart = -1;
  let curEntry = null; // { num, line, w, bodyCount, bodyLine, sawItem }

  for (let i = 0; i < tailIdx; i++) {
    const line = lines[i];

    // 代码围栏：``` 或 ~~~ 之间的一切都是「给别人看的示例」，不是条目。
    // 不屏蔽的话，日志里贴一段格式示例（非常常见）就会被当成真条目收进索引 ——
    // 假阳性；围栏内缩进加粗的示例还会误报 FAIL。
    // 注意：围栏判定必须在空行判定之前 —— 否则「先丢空行、后判围栏」会把代码块里的空行吃掉。
    if (FENCE.test(line)) {
      kinds[i] = 'fence';
      if (inFence) {
        inFence = false;
        fenceStart = -1;
      } else {
        inFence = true;
        fenceStart = i + 1;
        // 围栏标记行必须在 item 内，且缩进 = W+2
        if (curEntry) {
          const want = curEntry.w + 2;
          const got = line.length - line.trimStart().length;
          if (got !== want) {
            errors.push(
              `${file}:${i + 1} 代码围栏缩进 ${got} 空格，应为 ${want} 空格（= 编号位数 + 4，要能嵌在子项里）`,
            );
          }
        } else {
          errors.push(`${file}:${i + 1} 代码围栏不在任何条目内（围栏只能嵌在子项里）`);
        }
      }
      continue;
    }
    if (inFence) {
      kinds[i] = 'fenceInner';
      continue;
    }

    // 空行：整行长度必须为 0。只含空格/制表符的「看起来是空行」单独报 ——
    // 它会渲染成正常空行，但逐字节比对时是脏数据，且会让人以为空行规则已满足。
    if (line.length === 0) {
      kinds[i] = 'blank';
      continue;
    }
    if (line.trim() === '') {
      kinds[i] = 'unclassified';
      errors.push(`${file}:${i + 1} 空白行里带了空格或制表符（空行必须是长度 0 的真空行）`);
      continue;
    }

    // 日期标题
    if (DATE_TITLE.test(line)) {
      kinds[i] = 'date';
      continue;
    }

    const hit = ENTRY.exec(line);
    if (hit) {
      kinds[i] = 'entry';
      const num = Number(hit[1]);
      const w = hit[1].length + 2;
      curEntry = { num, line: i, w, bodyCount: 0, bodyLine: -1, sawItem: false };

      // 三种情形分开说。原来只有一句「从 X 跳到 Y（缺 N 条）」，遇重复编号会算出
      // 「缺 -1 条」、遇倒序算出「缺 -2 条」—— 负数，说不通，也就没人会去修。
      if (num === lastNum) {
        warnings.push(`${file}:${i + 1} 编号 ${num} 重复（上一条也是 ${num}）`);
      } else if (num < lastNum) {
        warnings.push(`${file}:${i + 1} 编号 ${num} 比上一条 ${lastNum} 小（这里应是 ${lastNum + 1}）`);
      } else if (num !== lastNum + 1) {
        warnings.push(`${file}:${i + 1} 编号从 ${lastNum} 跳到 ${num}（缺 ${num - lastNum - 1} 条）`);
      }
      lastNum = Math.max(lastNum, num);
      lastEntryLine = i;
      entries.push({ date: dateFromName, file, line: i + 1, num, title: hit[2].trim() });
      continue;
    }

    // 正文段：缩进必须恰好 W，内容必须非空，每条最多一个，且必须在任何 item 之前。
    const bm = BODY_PREFIX.exec(line);
    if (bm) {
      const indent = bm[1].length;
      if (!curEntry) {
        kinds[i] = 'unclassified';
        errors.push(`${file}:${i + 1} 「正文：」出现在任何条目之前`);
        continue;
      }
      if (indent !== curEntry.w) {
        kinds[i] = 'unclassified';
        errors.push(
          `${file}:${i + 1} 正文段缩进 ${indent} 空格，应为 ${curEntry.w} 空格（第 ${curEntry.num} 条是 ${String(curEntry.num).length} 位编号）`,
        );
        continue;
      }
      if (bm[3].trim() === '') {
        kinds[i] = 'unclassified';
        errors.push(`${file}:${i + 1} 正文段是空的（第 ${curEntry.num} 条）：\`正文：\` 后面必须写内容`);
        continue;
      }
      if (curEntry.bodyCount > 0) {
        kinds[i] = 'unclassified';
        errors.push(`${file}:${i + 1} 第 ${curEntry.num} 条有第二个正文段（每条只能有一个）`);
        continue;
      }
      if (curEntry.sawItem) {
        kinds[i] = 'unclassified';
        errors.push(`${file}:${i + 1} 第 ${curEntry.num} 条的正文段出现在子项之后（应紧跟条目行）`);
        continue;
      }
      kinds[i] = 'body';
      curEntry.bodyCount++;
      curEntry.bodyLine = i;
      continue;
    }

    // 子项：缩进必须恰好 W。
    const im = ITEM_PREFIX.exec(line);
    if (im) {
      const indent = im[1].length;
      if (!curEntry) {
        kinds[i] = 'unclassified';
        errors.push(`${file}:${i + 1} 子项出现在任何条目之前`);
        continue;
      }
      if (indent !== curEntry.w) {
        kinds[i] = 'unclassified';
        errors.push(
          `${file}:${i + 1} 子项缩进 ${indent} 空格，应为 ${curEntry.w} 空格（第 ${curEntry.num} 条是 ${String(curEntry.num).length} 位编号；缩进不对会让 Markdown 从此处断开列表）`,
        );
        continue;
      }
      if (im[2].trim() === '') {
        kinds[i] = 'unclassified';
        errors.push(`${file}:${i + 1} 子项是空的（第 ${curEntry.num} 条）：\`- \` 后面必须写内容`);
        continue;
      }
      if (curEntry.bodyCount === 0) {
        kinds[i] = 'unclassified';
        errors.push(`${file}:${i + 1} 第 ${curEntry.num} 条先出现子项、后补正文（正文段必须紧跟条目行）`);
        continue;
      }
      kinds[i] = 'item';
      curEntry.sawItem = true;
      continue;
    }

    // 「概览」行是已取消的机制（见技能 §4）。它不会被索引收录，也不会被任何
    // 检查拦住 —— 写了就等于白写，还占篇幅。
    // 用户可能加粗（`**概览**：`），所以中间允许星号。
    if (/^\s*\**\s*概览\s*\**\s*[:：]/.test(line)) {
      warnings.push(`${file}:${i + 1} 出现了「概览」行（该机制已取消，扫标题就够了）`);
    }

    // ---- 以下是「知道你想写条目，但写法不对」的各种形态，各给一句人话 ----

    // 行首无缩进的 `N. `：细分四种，别混成一句「条目未加粗」。
    // 这一段必须排在 LOOSE_ENTRY 之前 —— LOOSE_ENTRY 的 `\s*` 会连正确的
    // `6. **标题** 多余内容` 一起吞掉，于是报出「写法不规范」这种误导的话。
    if (/^\d+\.\s/.test(line)) {
      // ① 正文还黏在标题行上 —— 2026-10-25 改造前的写法
      if (/^\d+\.\s+(?:\[[a-z][a-z0-9-]*=[^\]]*\]\s*)*\*\*.+\*\*\s*——/.test(line)) {
        errors.push(
          `${file}:${i + 1} 正文还写在标题行上（\` —— \` 之后的部分）。正文段要另起一行，缩进 ${String(line.match(/^\d+/)[0].length + 2)} 空格写 \`正文：…\``,
        );
        continue;
      }
      // ② 方括号字段不合法（缺 `=` 或 key 不是小写）
      if (/^\d+\.\s+\[/.test(line) && /^\d+\.\s+(?:\[[a-z][a-z0-9-]*=[^\]]*\]\s*)*\*\*/.test(line) === false) {
        errors.push(
          `${file}:${i + 1} 条目行的方括号字段不合法（应为 \`[小写key=值]\`，可多个，如 \`[time=14:32:05]\`）：${line.trim().slice(0, 60)}`,
        );
        continue;
      }
      // ③ 加了粗但尾部还有别的内容（标题已闭合，后面又写了字）
      if (/^\d+\.\s+(?:\[[a-z][a-z0-9-]*=[^\]]*\]\s*)*\*\*.+\*\*/.test(line)) {
        errors.push(
          `${file}:${i + 1} 条目行标题后面还有内容（条目行只能是 \`N. [字段…] **标题**\`，多余的话挪到正文段或子项）：${line.trim().slice(0, 60)}`,
        );
        continue;
      }
      // ④ 真的没加粗
      errors.push(`${file}:${i + 1} 条目未加粗，索引会漏掉：${line.slice(0, 60)}`);
      continue;
    }

    // 像条目但写法不规范：全角数字、全角句点、顿号、以及 `1.**`（缺空格）。
    // ENTRY 一个都匹配不上，于是**完全静默**（exit 0、索引 0 条、零提示）。
    // 这是最坏形态，必须指名道姓地报出来。
    // 注意正则里的 `\s*` 只在「点号后直接接 `**`」时才危险 —— 上面那段已经把所有
    // 「点号 + 空格」的情形接走了，能走到这里的 `\s*` 只可能是 `1.  **`（两个空格）。
    if (/^[０-９\d]+[.．、]\*{0,2}/.test(line) && LOOSE_ENTRY.test(line)) {
      errors.push(
        `${file}:${i + 1} 条目写法不规范（编号用半角数字 + 半角小数点 + 空格），索引会漏掉：${line.trim().slice(0, 60)}`,
      );
      continue;
    }
    // 缩进的 `N. **标题**` —— 比不加粗更隐蔽：ENTRY 匹配行首，缩进行不命中，
    // 于是整条**静默消失**（不进索引、不报 WARN、不报 FAIL）。模型很容易为了
    // 表示从属关系顺手把子项加粗，结果以为记下了、索引里根本没有。必须 FAIL。
    if (/^\s+\d+\.\s+\*\*/.test(line)) {
      errors.push(
        `${file}:${i + 1} 缩进的条目加了粗（缩进子项不要加粗，用 "-"，否则这条会静默消失）：${line.trim().slice(0, 60)}`,
      );
      continue;
    }

    // 走到这里说明归不进 6 类里的任何一类 —— 这就是「未归类行」FAIL。
    // 它是本设计的核心保证：只要生成器 exit 0，日志里每一行就都有明确定义。
    // 报错前先把「这一行大概想干什么」给出来，否则人只知道错了、不知道往哪改。
    const shown = line.trim().slice(0, 70);
    let guess = '';
    if (/^\s*正文/.test(line)) guess = '　（想在正文段写，但「正文：」前有缩进以外的东西，或冒号用了半角）';
    else if (/^\s*[-*+]\s/.test(line)) guess = '　（像子项，但缩进不等于所属条目的编号位数 + 2）';
    else if (/^\s{2,}/.test(line)) guess = '　（有缩进但既不是正文段也不是子项）';
    errors.push(`${file}:${i + 1} 未归类行（既不是日期标题 / 空行 / 条目 / 正文段 / 子项 / 围栏）：${shown}${guess}`);
  }

  // 围栏没闭合：剩下的半个文件全被当成代码，条目一条都收不进来。
  // 报出来，否则就是「越写越少」的静默丢数据。
  if (inFence) {
    warnings.push(`${file}:${fenceStart} 代码围栏没有闭合，往后的条目全被跳过`);
  }

  // ---- 每条必须有恰好一个正文段 ----
  // 正文段把「这条讲了什么」从标题行解放出来。缺了它就是旧写法（正文黏在标题上），
  // 多了就是同一件事写了两遍。两种都要报 —— 缺了不报等于新规则形同虚设。
  const mine = entries.slice(firstEntryIdx);
  for (let k = 0; k < mine.length; k++) {
    const e = mine[k];
    const from = e.line - 1;
    const to = k + 1 < mine.length ? mine[k + 1].line - 1 : tailIdx;
    let bodyFound = -1;
    for (let j = from + 1; j < to; j++) {
      if (kinds[j] === 'body') {
        bodyFound = j;
        break;
      }
    }
    if (bodyFound === -1) {
      errors.push(`${file}:${e.line} 第 ${e.num} 条「${e.title}」没有正文段（条目行下面要缩进写一行 \`正文：…\`）`);
    }
    // 每条的字数（整条口径：编号 + 标题 + 正文 + 子项，含条目内部的空行，不含条目之间的空行）。
    // 这里只**统计并报告**，不判定 —— 见下面 TIER_* 处的说明。
    e.chars = lines.slice(from, to).join('\n').replace(/(\r?\n)+$/, '').length;
  }

  // ---- 空行位置校验（只允许那 5 个位置，每处恰好 1 个）----
  // 判定用「前一个非空且已归类的行」和「后一个非空且已归类的行」——
  // 未归类行的身份本来就未定，拿它去判空行位置只会连出一串假报。
  for (let i = 0; i < tailIdx; i++) {
    if (kinds[i] !== 'blank') continue;
    if (i === 0) {
      errors.push(`${file}:1 文件开头的空行（首部不许有空行）`);
      continue;
    }
    if (i === tailIdx - 1) {
      errors.push(`${file}:${i + 1} 文件末尾的空行（尾部不许有空行）`);
      continue;
    }
    if (kinds[i - 1] === 'blank') {
      errors.push(`${file}:${i + 1} 连续空行（两个空行会渲染成段间大缝隙，只许一个）`);
      continue;
    }
    if (kinds[i + 1] === 'blank') continue; // 由上面那条报，这里不重复

    let prevKind = null;
    for (let j = i - 1; j >= 0; j--) {
      if (kinds[j] === 'blank' || kinds[j] === 'unclassified') continue;
      prevKind = kinds[j];
      break;
    }
    let nextKind = null;
    for (let j = i + 1; j < tailIdx; j++) {
      if (kinds[j] === 'blank' || kinds[j] === 'unclassified') continue;
      nextKind = kinds[j];
      break;
    }
    // 前后有一边未归类：未归类行自己已经报过 FAIL，这里不再叠加
    if (prevKind === null || nextKind === null) continue;
    const pair = `${prevKind}→${nextKind}`;
    if (!BLANK_OK.has(pair)) {
      errors.push(
        `${file}:${i + 1} 空行位置不对（${prevKind} → ${nextKind}）。空行只允许在这 5 处：日期标题后、条目行后、正文段后（接子项或下一条）、最后一个子项后`,
      );
    }
  }

  // 行类型累计（跨文件）
  for (let i = 0; i < tailIdx; i++) kindCount[kinds[i]]++;

  if (EXPLAIN) {
    explainLines.push(`${file}`);
    for (let i = 0; i < tailIdx; i++) {
      let tag = '';
      if (kinds[i] === 'entry') {
        const e = entries.find((x) => x.file === file && x.line === i + 1);
        if (e) tag = `  #${e.num} ${e.title.slice(0, 40)}`;
      }
      explainLines.push(`  ${String(i + 1).padStart(5)}  ${kinds[i].padEnd(13)}${tag}`);
    }
  }
}

// 三档详略的字数边界。技能正文 §2.3 写的是同一组数字 —— 改一处必须改两处，
// 没有第二份定义（这里算，正文只是照抄给模型看）。
const TIER_A_MAX = 600;
const TIER_C_MIN = 1501;
const tierOf = (chars) => (chars <= TIER_A_MAX ? 'A' : chars < TIER_C_MIN ? 'B' : 'C');

// 只统计、不判定。2026-10-22 曾取消过一条 20,000 字符的长度 WARN，理由是
// 「长度不是质量的判据，且历史文件一旦超线就永久报警、修不掉，只会训练出对
// WARN 的麻木」。那个理由现在仍然成立：全库 58 条 C 档里真正写明「细节在哪份
// 文档」的只有 2 条，一旦改成检查就是 56 条永远修不掉的报警，而日志又不许
// 回头改。所以这里输出的是**分布**，让人看见偏移，而不是**报警**，逼人删字。
const tierCount = { A: 0, B: 0, C: 0 };
const tierChars = { A: 0, B: 0, C: 0 };
for (const e of entries) {
  const t = tierOf(e.chars);
  tierCount[t]++;
  tierChars[t] += e.chars;
}
// 最近一天 = 文件名日期最大的那天，也就是刚写完的那天。
const latestDate = [...new Set(entries.map((e) => e.date))].sort().pop();
const latest = entries.filter((e) => e.date === latestDate);
const latestTier = { A: 0, B: 0, C: 0 };
for (const e of latest) latestTier[tierOf(e.chars)]++;
const median = (arr) => {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};

// --explain：只报行类型归属，不写索引
if (EXPLAIN) {
  for (const l of explainLines) console.log(l);
  console.log(`\n行类型合计：${Object.entries(kindCount).map(([k, v]) => `${k} ${v}`).join(' / ')}`);
  if (errors.length) {
    console.log(`\nFAIL ${errors.length}`);
    for (const e of errors) console.log(`  ${e}`);
    process.exit(1);
  }
  process.exit(0);
}

// 按日期分组（日期降序，最新在前）
const byDate = new Map();
for (const e of entries) {
  if (!byDate.has(e.date)) byDate.set(e.date, []);
  byDate.get(e.date).push(e);
}
const dates = [...byDate.keys()].sort().reverse();

// 同一天内部也倒序：全篇一个方向，从新到旧往下读。
// 不这样就是「日期倒序 + 日内正序」—— 从顶上读下来是「今早 → 刚才 → 昨早 → 昨晚」，
// 时间线来回跳。日志文件里必须正序（那是叙述），索引里必须同向。
for (const list of byDate.values()) list.reverse();

// 按月分组
const byMonth = new Map();
for (const d of dates) {
  const month = d.slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, []);
  byMonth.get(month).push(d);
}
const months = [...byMonth.keys()].sort().reverse();

const out = [];
out.push('# 日志索引');
out.push('');
out.push('> 自动生成，勿手改。生成：`node 日志\\build-index.mjs`');
out.push('');
out.push(`共 ${dates.length} 天 / ${entries.length} 条。**全篇从新到旧** —— 日期降序，同一天内也倒序。`);
out.push('');

for (const month of months) {
  out.push(`## ${month}`);
  out.push('');
  for (const date of byMonth.get(month)) {
    for (const e of byDate.get(date)) {
      out.push(`- ${date.slice(5)}  ${e.title} · 日志\\${e.file}:${e.line}`);
    }
  }
  out.push('');
}

try {
  writeFileSync(OUT, out.join('\n'), 'utf8');
} catch (err) {
  console.error(`写不出索引文件：${OUT}`);
  console.error(`  ${err.code || err.name}: ${err.message}`);
  process.exit(1);
}

// 报告
const chars = out.join('\n').length;
console.log(`✓ ${files.length} 个文件 / ${dates.length} 天 / ${entries.length} 条 → _日志索引.md（${chars} 字符）`);
if (entries.length) {
  const total = tierChars.A + tierChars.B + tierChars.C;
  const pct = (n) => (total ? ((n / total) * 100).toFixed(1) : '0.0');
  console.log(
    `  详略（全库）：A ${tierCount.A} / B ${tierCount.B} / C ${tierCount.C}` +
      `，字数 A ${pct(tierChars.A)}% / B ${pct(tierChars.B)}% / C ${pct(tierChars.C)}%` +
      `，单条中位 ${median(entries.map((e) => e.chars))} 字符`,
  );
  if (latest.length) {
    console.log(
      `  详略（${latestDate.slice(5)}）：A ${latestTier.A} / B ${latestTier.B} / C ${latestTier.C}` +
        `，单条中位 ${median(latest.map((e) => e.chars))} 字符`,
    );
  }
  console.log(
    `  行类型：${Object.entries(kindCount).map(([k, v]) => `${k} ${v}`).join(' / ')}`,
  );
}
if (fixedEol.length) {
  console.log(`  行尾修正为 CRLF：${fixedEol.join('、')}`);
}
if (strippedBom.length) {
  console.log(`  剥离 UTF-8 BOM：${strippedBom.join('、')}`);
}
if (warnings.length) {
  console.log(`\nWARN ${warnings.length}`);
  for (const w of warnings) console.log(`  ${w}`);
}
if (errors.length) {
  console.log(`\nFAIL ${errors.length}`);
  for (const e of errors) console.log(`  ${e}`);
  process.exit(1);
}
