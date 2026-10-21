// 从工作区根的 `日志\` 生成 `_日志索引.md`。
// 用法：node 日志\build-index.mjs（脚本也可放在工作区根，直接 node build-index.mjs）。
// 零依赖。读日志，写工作区根的 _日志索引.md；顺带把日志文件的行尾修正成 CRLF。

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const SELF_DIR = dirname(fileURLToPath(import.meta.url));

// 判据：目录里有 YYYY-MM-DD.md。
function hasDateFile(dir) {
  try {
    return readdirSync(dir).some((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
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
if (basename(SELF_DIR) === '日志' && hasDateFile(SELF_DIR)) {
  WORK_ROOT = dirname(SELF_DIR);
  LOG_DIR = SELF_DIR;
} else if (hasDateFile(join(SELF_DIR, '日志'))) {
  WORK_ROOT = SELF_DIR;
  LOG_DIR = join(SELF_DIR, '日志');
}

if (!WORK_ROOT) {
  console.error('找不到工作区。build-index.mjs 只允许放在：');
  console.error('  1) <工作区>\\日志\\build-index.mjs');
  console.error('  2) <工作区>\\build-index.mjs');
  console.error(`当前：${SELF_DIR}`);
  console.error('工作区必须包含 日志\\ 目录，且其中至少一个 YYYY-MM-DD.md。');
  process.exit(1);
}

const OUT = join(WORK_ROOT, '_日志索引.md');

console.log(`✓ 工作区：${WORK_ROOT}`);
console.log(`  日志目录：${LOG_DIR}`);
console.log(`  输出：${OUT}`);

// 行首无缩进的 `N. **标题**`。缩进的行不算（正文里的子列表）。
// 不加粗不算 —— 那是格式错误，单独报出来，不静默吞掉。
const ENTRY = /^(\d+)\.\s+\*\*(.+?)\*\*/;
const DATE_TITLE = /^#\s+(\d{4}-\d{2}-\d{2})\s*$/;

const errors = [];
const warnings = [];
const entries = [];
const fixedEol = [];

const files = readdirSync(LOG_DIR)
  .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
  .sort();

if (files.length === 0) {
  console.error(`日志目录里没有 YYYY-MM-DD.md：${LOG_DIR}`);
  process.exit(1);
}

for (const file of files) {
  const dateFromName = basename(file, '.md');
  const fullPath = join(LOG_DIR, file);
  const text = readFileSync(fullPath, 'utf8');

  // 行尾统一成 CRLF。写文件的工具默认输出 LF，光靠约定守不住，
  // 这里每次运行顺手修正 —— 它跑的时候日志文件一定已经写完了。
  // 只动行尾，不动任何字；修不出问题再报。
  const crlf = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
  if (crlf !== text) {
    writeFileSync(fullPath, crlf, 'utf8');
    fixedEol.push(file);
  }

  const lines = crlf.split('\n');
  // split('\n') 之后每行末尾可能带 \r（CRLF 文件），统一剥掉再匹配
  for (let i = 0; i < lines.length; i++) lines[i] = lines[i].replace(/\r$/, '');

  // 校验第一行日期标题与文件名一致（自证）
  const firstContent = lines.findIndex((l) => l.trim() !== '');
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

  let lastNum = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const hit = ENTRY.exec(line);
    if (hit) {
      const num = Number(hit[1]);
      if (num !== lastNum + 1) {
        warnings.push(`${file}:${i + 1} 编号从 ${lastNum} 跳到 ${num}（缺 ${num - lastNum - 1} 条）`);
      }
      lastNum = num;
      entries.push({ date: dateFromName, file, line: i + 1, num, title: hit[2].trim() });

      // 标题后没有正文：写日志时断行了，正文被挤到下一行或整段丢了。
      // 只报「标题行剩下的部分」和「后续行」都没有内容的情形 —— 标题独占一行、
      // 正文用缩进子项接着写是合法写法，不算。
      const rest = line.slice(hit[0].length).trim();
      if (rest === '' || /^[—–\-:：]+$/.test(rest)) {
        let hasBody = false;
        for (let j = i + 1; j < lines.length; j++) {
          const next = lines[j];
          if (next.trim() === '') continue;
          if (DATE_TITLE.test(next)) break;
          if (ENTRY.test(next)) break;
          // 非条目的任意内容（缩进子项、续行）都算正文
          hasBody = true;
          break;
        }
        if (!hasBody) {
          warnings.push(
            `${file}:${i + 1} 第 ${num} 条「${hit[2].trim()}」标题后没有正文（可能写日志时断行，正文被吞了）`,
          );
        }
      }
      continue;
    }
    // 行首无缩进的 `N. ` 但没加粗 —— 格式错误
    if (/^\d+\.\s+/.test(line)) {
      errors.push(`${file}:${i + 1} 条目未加粗，索引会漏掉：${line.slice(0, 60)}`);
    }
  }
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

writeFileSync(OUT, out.join('\n'), 'utf8');

// 报告
const chars = out.join('\n').length;
console.log(`✓ ${files.length} 个文件 / ${dates.length} 天 / ${entries.length} 条 → _日志索引.md（${chars} 字符）`);
if (fixedEol.length) {
  console.log(`  行尾修正为 CRLF：${fixedEol.join('、')}`);
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
