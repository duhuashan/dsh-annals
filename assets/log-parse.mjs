// 日志条目的词法与结构定义 —— **单一份**。
//
// 为什么单独成文件：同一套「什么算一条日志」的判定原来有三份副本，
// 其中一份（`日志看板\app\logparser.py`）在 2026-10-25 的结构化改造后
// 一条都匹配不上，7 个日志文件全解析出 0 条，而它不报错、只是静默空着。
// 正则散落在各处时，改格式就一定会漏掉某一处，且漏掉的那处不会喊。
//
// 这里只放**纯函数与常量**：不读文件、不写文件、不 process.exit、不打印。
// 调用方（`build-index.mjs` 的校验、`lib\query.js` 的检索、一致性测试）各自
// 决定拿它做什么。校验逻辑本身不在这里 —— 它和「修不修、报什么」绑在一起，
// 留在 build-index.mjs 里。
//
// 零依赖。

// ---- 行类型 ----

// 日期标题：容忍行首空白（有人从别处复制会带前导空格）。
export const DATE_TITLE = /^\s*#\s+(\d{4}-\d{2}-\d{2})\s*$/;

// 代码围栏。围栏内的一切都是内容，不参与任何判定。
export const FENCE = /^\s*(?:```|~~~)/;

// 正文段与子项的前缀。缩进宽度另校验。
export const BODY_PREFIX = /^( *)(正文：)(.*)$/;
export const ITEM_PREFIX = /^( *)- (.*)$/;

// 条目行：顶层无缩进、编号 + 可选方括号字段 + 加粗标题，**行尾不许再有任何东西**。
// 加 `\s*$` 是 2026-10-25 的结构化改造：旧写法 `N. **标题** —— 正文` 把正文黏在
// 标题行上，导致「标题」和「正文」在同一行里没有各自的位置。现在正文必须独立成段
// （body 行），词法上就不可能再黏回去。
export const ENTRY = /^(\d+)\.\s+(?:\[[a-z][a-z0-9-]*=[^\]]*\]\s*)*\*\*(.+?)\*\*\s*$/;

// 「看起来像条目但写法不对」：全角数字、全角句点、顿号、以及 `1.**`（缺空格）。
// 这些形状 ENTRY 匹配不上，于是整条静默消失，一条 FAIL/WARN 都没有 ——
// 必须单独捞出来，否则是最坏形态：以为记下了，索引里根本没有。
export const LOOSE_ENTRY = /^[０-９\d]+\s*[.．、]\s*\*\*/;

// ---- 方括号字段 ----

// 写入时刻：2026-10-25 起必填，永远第一个字段。只认零填充的 `HH:MM:SS` ——
// 不做「9:05」这类宽松解析：生成器补不了真实时刻，所以宁可 FAIL 让人重取一次，
// 也不要吞进一个半懂的值。日期不进字段（文件名已经给了，写两处就是两个真源）。
export const TIME_FIELD = /\[time=([^\]]*)\]/;
export const TIME_SHAPE = /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d$/;

// 详略档位：2026-10-25 起必填，紧跟 [time=] 之后。只认大写 A / B / C ——
// 索引里显示的就是 [A]，两处大小写不一致会让人以为索引错了。
// 它记的是**动笔前的声明**（这条我打算写多细），不是写完量出来的标签；
// 但声明必须与实测一致（见 TIER_A_MAX / TIER_B_MAX），否则档位就成了
// 「想写多长写多长」的橡皮图章。
export const TIER_FIELD = /\[tier=([^\]]*)\]/;
export const TIER_SHAPE = /^[ABC]$/;

// 三档详略的字数边界。技能正文 §2.3 写的是同一组数字 —— 改一处必须改两处，
// 没有第二份定义（这里算，正文只是照抄给模型看）。
// 两个都是**上限**，比较符都用 `<=`：原来写成 A_MAX 600 / C_MIN 1501，一个配 `<=`
// 一个配 `<`，读的人得在脑子里换算一次才敢确认边界到底落在 1500 还是 1501。
//
// 口径（2026-10-25 起）：只算**正文段行 + 子项行 + 围栏内行**，不算编号、方括号字段、
// 标题、条目内空行。原来按整条算，于是「加了 [time=] 那 17 个字符」本身就能把条目
// 推过 600 —— 实测 3 条因此跨档。骨架不该参与「这条写了多少东西」的度量。
export const TIER_A_MAX = 600;
export const TIER_B_MAX = 1500;

/** 按字数给出应有的档位。 */
export const tierOf = (chars) => (chars <= TIER_A_MAX ? 'A' : chars <= TIER_B_MAX ? 'B' : 'C');

/** 把合法形状的 HH:MM:SS 换算成秒，只为判断「往回走了多少」。 */
export const secOf = (t) =>
  Number(t.slice(0, 2)) * 3600 + Number(t.slice(3, 5)) * 60 + Number(t.slice(6, 8));

// ---- 空行 ----

// 空行只允许出现在这 5 个位置（前一个非空行 kind → 后一个非空行 kind）。
// 每处恰好 1 个。多一个、错位置、连续两个、文件首尾 —— 全是 FAIL。
export const BLANK_OK = new Set(['date→entry', 'entry→body', 'body→item', 'body→entry', 'item→entry']);

// ---- 纯词法分类 ----

/**
 * 逐行给出词法类型。**不看上下文、不校验、不修**。
 *
 * 和 `build-index.mjs` 里那份「带校验的分类」不是一回事：那份边分类边判缩进、
 * 边报错，分类结果会随校验失败退化成 `unclassified`。这份只回答「这一行长得像什么」。
 * 两者对**合法行**的判断一致（同一个 ENTRY / DATE_TITLE / FENCE / BODY_PREFIX /
 * ITEM_PREFIX），差异只在非法行的处置上 —— 那是校验方的职责。
 *
 * @param {string[]} lines 已经按行切开、行尾不含 `\r` 的行数组。
 * @returns {string[]} 每行一个 kind：date / blank / entry / body / item / fence / fenceInner / unclassified。
 */
export function lightKinds(lines) {
  const kinds = new Array(lines.length).fill('unclassified');
  let inF = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (FENCE.test(line)) {
      kinds[i] = 'fence';
      inF = !inF;
      continue;
    }
    if (inF) {
      kinds[i] = 'fenceInner';
      continue;
    }
    if (line.length === 0) kinds[i] = 'blank';
    else if (DATE_TITLE.test(line)) kinds[i] = 'date';
    else if (ENTRY.test(line)) kinds[i] = 'entry';
    else if (BODY_PREFIX.test(line)) kinds[i] = 'body';
    else if (ITEM_PREFIX.test(line)) kinds[i] = 'item';
  }
  return kinds;
}

// ---- 只读解析 ----

/**
 * 把一份日志文本解析成条目列表。**只读**：不校验、不报错、不修改。
 *
 * 这是给检索用的视图 —— 它要知道每条讲了什么、多长、什么时候写的。
 * 校验仍归 `build-index.mjs`（它有修复能力和逐行错误定位，那是它的活）。
 *
 * @param {string} text 日志文件全文。
 * @returns {{lines: string[], kinds: string[], entries: object[]}}
 *   entries 每项：`{ num, line, title, time, tier, chars, body, items, fence }`
 *   —— `body` / `items` / `fence` 都是原始行（不含行尾换行）。
 */
export function parseLog(text) {
  const lines = String(text)
    .replace(/\r+\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\r$/, ''));
  // 最后一个换行符之后是「空元素」，不是一行内容。
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const kinds = lightKinds(lines);
  const entries = [];
  let cur = null;

  for (let i = 0; i < lines.length; i++) {
    const k = kinds[i];
    if (k === 'entry') {
      const m = ENTRY.exec(lines[i]);
      const tm = TIME_FIELD.exec(lines[i]);
      const tr = TIER_FIELD.exec(lines[i]);
      cur = {
        num: Number(m[1]),
        line: i + 1,
        title: m[2].trim(),
        time: tm ? tm[1] : '',
        tier: tr ? tr[1] : '',
        chars: 0,
        body: [],
        items: [],
        fence: [],
      };
      entries.push(cur);
      continue;
    }
    if (!cur) continue;
    if (k === 'body') cur.body.push(lines[i]);
    else if (k === 'item') cur.items.push(lines[i]);
    else if (k === 'fence' || k === 'fenceInner') cur.fence.push(lines[i]);
    // blank / date / unclassified：不属于任何条目的内容，不计入。
  }

  // 字数口径：只算正文段行 + 子项行 + 围栏内行，不算编号、方括号字段、标题、
  // 条目内空行。与 build-index.mjs 的 e.chars 是同一个算法，必须一致 ——
  // 不一致就会出现「看板说这条 800 字、生成器说 400 字」。
  for (const e of entries) {
    let n = 0;
    for (const l of e.body) n += l.length + 1;
    for (const l of e.items) n += l.length + 1;
    for (const l of e.fence) n += l.length + 1;
    e.chars = n > 0 ? n - 1 : 0;
  }

  return { lines, kinds, entries };
}
