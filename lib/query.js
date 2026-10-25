/**
 * query.js —— 日志检索。给 `worklog_query` 工具用的纯逻辑，不碰 ctx。
 *
 * 设计目标（2026-10-25 定案，见日志 2026-10-25 与 grilling 十一问）：
 * 让模型在「这件事好像做过」的瞬间花一次工具调用就能确认，而不是重做一遍。
 *
 * 三个刻意的取舍：
 *
 * 1. **标题优先，正文兜底**。日志标题是人工浓缩过的（187 条标题合计约 7,600 字符，
 *    全库正文 251,341 字符，差 33 倍），先扫标题等于先筛 33 倍小的池子。标题命中
 *    够数（≥3 条）就不下钻正文 —— 这既是速度，也是精度：正文里「重启」这种词
 *    到处都是，全下钻只会把真正相关的条目淹掉。
 *
 * 2. **返回片段而不是全文**。模型拿到片段后如果真需要细节会自己 read 那个锚点。
 *    直接把全文塞进上下文，等于用检索的成本做读取的事，而且会挤掉它本来要干的活。
 *    价值在于「把范围从 25 万字符缩到 3 条」，省的是筛的时间不是找的时间。
 *
 * 3. **空结果必须说清楚搜的是什么范围**。零命中时回一句「共 N 条 / M 个文件，
 *    范围 = 日志\*.md 的标题与正文，不含其他文档。这里搜不到不代表从未做过」——
 *    否则模型会把「没搜到」当成「没做过」，那比不搜更糟。
 *
 * 零依赖（只用 node:fs / node:path）。
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// 权重：标题命中比正文命中重要得多。同一次命中封顶，避免一个词重复十次把分数刷满。
const W_TITLE = 0.3;
const CAP_TITLE = 0.6;
const W_BODY = 0.1;
const CAP_BODY = 0.3;
const W_ITEM = 0.06;
const CAP_ITEM = 0.2;
const W_FENCE = 0.02;
const CAP_FENCE = 0.1;

// 整串查询原样出现（忽略大小写）时的额外加成。这是最强的信号 ——
// 「重启插件」四个字连在一起出现，比「重启」「插件」各自出现有意义得多。
const PHRASE_BONUS = 0.5;

// 低于最高分这个比例的命中直接丢掉。
// 没有它的话，只在一个子项里蹭到一次「插件」的条目也会以 0.06 分挤进结果，
// 把真正相关的那几条淹掉 —— 检索最怕的不是漏，是噪声排在有价值的结果旁边。
const REL_FLOOR = 0.25;

// 覆盖率折算成乘子的下限：全命中（cov=1）不打折，一个词都没覆盖到只剩这个系数。
//
// 用**平方**而不是线性，是因为线性折算挡不住「半个查询命中」的假阳性：
// 搜「机器学习模型训练」时切出「机器」「模型」两个通用词，它们在这条里都出现，
// 字符覆盖率算到 0.5，线性折算还剩 0.57 的分数 —— 足够越过 ABS_FLOOR 混进来。
// 平方后 0.5 只剩 0.29，整批落到下限以下。
//
// 残留的已知盲区：一条查询如果由若干常见 bigram **拼满**（比如「完全不存在的东西」
// 拆成 完全/全不/不存/存在/在的/东西，恰好每条都能在某一条日志里找到），
// 字符覆盖率会算到 1.0，平方也压不下去。字符级 bigram 检索没有词典，
// 分不清「存在」是词还是「不存在的」里的一段，这是这类实现的固有代价 ——
// 工具输出里「这里搜不到不代表从未做过」那句就是给这种情况兜底的。
const COVERAGE_FLOOR = 0.05;
const coverageMultiplier = (coverage) => COVERAGE_FLOOR + (1 - COVERAGE_FLOOR) * coverage * coverage;

// 一条命中的**绝对**下限。低于它直接判为没命中。
//
// 光有相对阈值（REL_FLOOR）不够：搜一个全库都没有的词时，所有条目分数都极低，
// 相对阈值会让「矮子里的高个」照样通过。实测搜「完全不存在的词xyz」返回 3 条
// 全无关的条目（靠 bigram 里的「存在」蹭上的），就是这个洞。
// 0.10 的含义：至少得有一个中等稀有度的词实打实命中，才算找到东西。
const ABS_FLOOR = 0.1;

// 覆盖率的分母怎么算 —— 这一条踩过两次坑，两次的根因是同一个。
//
// 一开始分母是「所有词条 idf 之和」。搜「重启插件」切出
// `重启插件` / `重启` / `启插` / `插件`，其中「启插」这个 bigram 是纯粹的
// 副产品（四个字里只有它不构成词）。它在全库几乎不出现，idf 逼近 1.0，
// 一个词就占了 40% 的分母；真正有意义的「重启」(0.27) + 「插件」(0.20)
// 加起来才 0.47，覆盖率被压到 0.19，乘 COVERAGE_FLOOR 后整批落到 ABS_FLOOR
// 以下 —— 明明有 24 条标题含这些词，检索返回 0 条。
//
// 第二次更荒谬：给第 14 条日志写了「重启插件」这四个字之后，这个短语在库里
// 出现了 1 次，idf 从 0 跳到满值 1.0，于是**库里多了一条记录，检索反而坏掉了**。
//
// 所以分母不能是「词条的稀有度之和」，得是「查询本身的字符数」：
// 覆盖率 = 被命中的查询字符数 / 查询总字符数。无意义的 bigram 不命中就只是
// 不贡献覆盖率，不会凭空撑大分母。库里多写一条含该短语的日志，也不会再把检索搞坏。
// 折算成乘子时用哪个系数见上面的 COVERAGE_FLOOR。

/**
 * 查询串里被命中的字符占比。
 *
 * 用「在原串上标记被覆盖的位置」而不是「命中词数 / 总词数」：
 * bigram 之间是重叠的（重启 / 启插 / 插件 覆盖的其实是同一段字），
 * 按词数算会把重叠的部分重复计数，按字符位置算取的是并集。
 *
 * 空白不计入分母 —— 查询里敲的空格不是要找的内容。
 *
 * @param {string} queryLower 小写查询串。
 * @param {string[]} tokens 词条。
 * @param {string[]} texts 该条目各层的文本（小写）。
 * @returns {number} 0..1。
 */
function coverageOf(queryLower, tokens, texts) {
  const n = queryLower.length;
  if (n === 0) return 0;
  const marked = new Uint8Array(n);
  for (const t of tokens) {
    if (!t) continue;
    // 这个词得真的在这一条里出现过，才算它覆盖了查询中的那一段。
    if (!texts.some((x) => x.includes(t))) continue;
    let from = 0;
    for (;;) {
      const at = queryLower.indexOf(t, from);
      if (at < 0) break;
      for (let k = at; k < at + t.length; k++) marked[k] = 1;
      from = at + 1;
    }
  }
  let covered = 0;
  let total = 0;
  for (let i = 0; i < n; i++) {
    if (/\s/.test(queryLower[i])) continue;
    total++;
    if (marked[i]) covered++;
  }
  return total > 0 ? covered / total : 0;
}

// 片段：命中词前后各取多少。总数 240 —— 够看清上下文，又不至于一条占满屏幕。
const SNIPPET_AHEAD = 90;
const SNIPPET_BEHIND = 150;

export const DEFAULT_LIMIT = 5;
export const MAX_LIMIT = 20;
// 标题命中到这个数就不下钻正文了。低于它说明标题没覆盖住，正文里可能有货。
export const TITLE_HIT_ENOUGH = 3;

const DATE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

/**
 * 切词。空格分词 → 每段再按「中文段 / 非中文段」拆开 → 中文补 bigram。
 *
 * 为什么要拆中英混排：`非git` 如果整体当一个词，中文部分只剩单字「非」，
 * 而「非」几乎每条都有，等于凭空塞进一个万能词。拆成 `非` + `git` 之后，
 * `git` 才是那个真正有区分度的词。
 *
 * 为什么要 bigram：中文没有词边界，「重启插件」不切就搜不到「重启」。
 * 切成 bigram（重启 / 启插 / 插件）后能命中，代价是产生「启插」这种无意义片段 ——
 * 但它们几乎不会单独出现在日志里，实际不带来假命中。
 *
 * 单字只在**整段就只有一个字**时才留（搜「坑」这种），不作为 bigram 的副产品。
 *
 * @param {string} q 原始查询。
 * @returns {string[]} 去重后的小写词条。
 */
export function tokenize(q) {
  const raw = String(q ?? '').toLowerCase();
  const out = new Set();
  for (const part of raw.split(/[\s,，、;；|]+/)) {
    const s = part.trim();
    if (!s) continue;
    // 整段原样留一份（精确短语）
    out.add(s);
    // 按「中文 / 非中文」切段
    for (const seg of s.match(/[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+/g) ?? []) {
      if (!/[\u4e00-\u9fff]/.test(seg)) {
        const t = seg.trim();
        if (t) out.add(t);
        continue;
      }
      // 单字只在「整个查询就这一个字」时才收。`非git` 里的「非」不能收 ——
      // 它在 187 条里几乎处处都有，收进来等于给每条都白送一个命中。
      if (seg.length === 1) {
        if (s === seg) out.add(seg);
        continue;
      }
      for (let i = 0; i + 2 <= seg.length; i++) out.add(seg.slice(i, i + 2));
    }
  }
  return [...out];
}

/**
 * 载入全部日志。返回按日期升序的条目数组。
 *
 * 每次调用都重读 —— 日志是活的，模型刚写完一条就该能搜到。
 * 187 条 / 25 万字符读一遍是毫秒级，不需要缓存失效那一套。
 *
 * @param {string} logDir `日志\` 的绝对路径。
 * @returns {{entries: object[], fileCount: number, charTotal: number}}
 */
export function loadLogs(logDir) {
  const entries = [];
  let fileCount = 0;
  let charTotal = 0;
  let names;
  try {
    names = readdirSync(logDir).filter((f) => DATE_FILE_RE.test(f)).sort();
  } catch {
    return { entries, fileCount: 0, charTotal: 0 };
  }
  for (const name of names) {
    let text;
    try {
      text = readFileSync(join(logDir, name), 'utf8');
    } catch {
      continue;
    }
    fileCount++;
    charTotal += text.length;
    const date = name.slice(0, -3);
    const lines = text
      .replace(/\r+\n/g, '\n')
      .split('\n')
      .map((l) => l.replace(/\r$/, ''));
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

    let cur = null;
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*(?:```|~~~)/.test(line)) {
        inFence = !inFence;
        if (cur) cur.fence.push(line);
        continue;
      }
      if (inFence) {
        if (cur) cur.fence.push(line);
        continue;
      }
      const m = /^(\d+)\.\s+(?:\[[a-z][a-z0-9-]*=[^\]]*\]\s*)*\*\*(.+?)\*\*\s*$/.exec(line);
      if (m) {
        const tm = /\[time=([^\]]*)\]/.exec(line);
        const tr = /\[tier=([^\]]*)\]/.exec(line);
        cur = {
          date,
          file: name,
          num: Number(m[1]),
          line: i + 1,
          title: m[2].trim(),
          time: tm ? tm[1] : '',
          tier: tr ? tr[1] : '',
          body: [],
          items: [],
          fence: [],
        };
        entries.push(cur);
        continue;
      }
      if (!cur) continue;
      if (/^( *)(正文：)(.*)$/.test(line)) cur.body.push(line);
      else if (/^( *)- (.*)$/.test(line)) cur.items.push(line);
    }
  }
  return { entries, fileCount, charTotal };
}

/**
 * 给一条打分。返回 `{ score, where }`，score 为 0 表示没命中。
 *
 * 两层加权：
 *   · 位置权重 —— 标题 > 正文 > 子项 > 代码围栏
 *   · 词频权重 —— 一个词在全库出现得越多，它这次命中的信息量越小。
 *     「插件」在 99/187 条里都有，它命中几乎不说明任何事；「tierOf」只在 3 条里出现，
 *     命中就是强信号。
 *
 * 外加一层**覆盖率**：命中的字符占查询总字符的比例。这一层专治 bigram 的假命中 ——
 * 搜「完全不存在的词」会被切成「完全/全不/不存/存在/…」，其中「存在」满库都是，
 * 光看「有没有命中」会把一堆无关条目捞上来。按覆盖率一算，它只占几十分之一，
 * 分数自然塌下去（平方折算的细节见 COVERAGE_FLOOR）。
 *
 * @param {object} e 条目。
 * @param {string[]} tokens 词条。
 * @param {Map<string, number>} idf 每个词的稀有度（0..1，越大越稀有）。
 * @param {string} phrase 整串查询（小写）。既用来做整串加成，也是覆盖率的分母来源。
 */
function scoreEntry(e, tokens, idf, phrase) {
  let score = 0;
  let where = '';
  const titleLower = e.title.toLowerCase();
  const bodyText = e.body.join('\n').toLowerCase();
  const itemText = e.items.join('\n').toLowerCase();
  const fenceText = e.fence.join('\n').toLowerCase();

  let titleW = 0;
  let bodyW = 0;
  let itemW = 0;
  let fenceW = 0;
  for (const t of tokens) {
    const w = idf.get(t) ?? 0;
    if (!w) continue;
    if (titleLower.includes(t)) titleW += w;
    if (bodyText.includes(t)) bodyW += w;
    if (itemText.includes(t)) itemW += w;
    if (fenceText.includes(t)) fenceW += w;
  }

  if (titleW > 0) {
    score += Math.min(titleW * W_TITLE, CAP_TITLE);
    where = '标题';
  }
  if (bodyW > 0) {
    score += Math.min(bodyW * W_BODY, CAP_BODY);
    if (!where) where = '正文';
  }
  if (itemW > 0) {
    score += Math.min(itemW * W_ITEM, CAP_ITEM);
    if (!where) where = '子项';
  }
  if (fenceW > 0) {
    score += Math.min(fenceW * W_FENCE, CAP_FENCE);
    if (!where) where = '代码';
  }
  if (score === 0) return { score: 0, where: '' };

  // 整串原样出现：最强的信号，不受覆盖率打折。
  if (phrase && (titleLower.includes(phrase) || bodyText.includes(phrase) || itemText.includes(phrase))) {
    return { score: Math.min(score + PHRASE_BONUS, 1), where };
  }

  // 覆盖率：按查询串里「有几个字被这一条覆盖到了」算，不用词条数。
  // 理由见 COVERAGE_FLOOR 上面那段注释 —— 按词条算会栽在 bigram 副产品上。
  const coverage = coverageOf(phrase, tokens, [titleLower, bodyText, itemText, fenceText]);
  return { score: Math.min(score * coverageMultiplier(coverage), 1), where };
}

/**
 * 算每个词的稀有度。`idf = log(1 + 总条数 / 出现条数) / log(1 + 总条数)`，落在 0..1。
 *
 * 出现条数取「标题 + 正文 + 子项」的并集 —— 和打分时的判定面一致，
 * 否则会给一个「标题里没出现、正文里满篇都是」的词算出虚高的权重。
 *
 * **全库 0 出现的词给 0，不是给 1。** 这一条是必须的：bigram 会切出
 * 「启插」「重启插件」这类永远不会命中的片段，如果它们按「最稀有」拿满分，
 * 覆盖率的分母就被撑大一倍，真实命中（重启 + 插件）的覆盖率会被压到 0.19，
 * 结果就是明明该命中的条目一条都过不了阈值。没出现过的词没有任何信息量，
 * 不该参与分母。
 *
 * @param {object[]} entries 全部条目。
 * @param {string[]} tokens 词条。
 * @returns {Map<string, number>}
 */
export function buildIdf(entries, tokens) {
  const map = new Map();
  const total = Math.max(entries.length, 1);
  const denom = Math.log(1 + total);
  for (const t of tokens) {
    const lt = t.toLowerCase();
    let count = 0;
    for (const e of entries) {
      if (
        e.title.toLowerCase().includes(lt) ||
        e.body.join('\n').toLowerCase().includes(lt) ||
        e.items.join('\n').toLowerCase().includes(lt)
      ) {
        count++;
      }
    }
    map.set(t, count === 0 ? 0 : Math.log(1 + total / count) / denom);
  }
  return map;
}

/**
 * 取片段。围绕**出现位置最靠后（也就是最稀有）**的命中词开窗。
 *
 * 为什么挑最稀有的那个而不是第一个：常见词（「日志」「文件」）开出来的窗口
 * 多半是全篇通用的话，看不出这条到底特殊在哪。低频词附近的文字才有辨识度。
 *
 * @param {object} e 条目。
 * @param {string[]} tokens 词条。
 * @returns {string} 片段（可能为空）。
 */
function snippetOf(e, tokens) {
  const parts = [...e.body, ...e.items, ...e.fence];
  if (parts.length === 0) return '';
  const text = parts.join('\n');
  const lower = text.toLowerCase();
  let best = -1;
  let bestLen = Infinity;
  for (const t of tokens) {
    const at = lower.indexOf(t);
    if (at >= 0 && t.length < bestLen) {
      best = at;
      bestLen = t.length;
    }
  }
  if (best < 0) return '';
  const from = Math.max(0, best - SNIPPET_AHEAD);
  const to = Math.min(text.length, best + SNIPPET_BEHIND);
  let s = text.slice(from, to).replace(/\s+/g, ' ').trim();
  if (from > 0) s = `…${s}`;
  if (to < text.length) s = `${s}…`;
  return s;
}

/**
 * 检索。两阶段：先只扫标题，标题命中不够才下钻正文。
 *
 * @param {object[]} entries 全部条目。
 * @param {string} query 查询串。
 * @param {number} [limit] 返回条数上限。
 * @returns {{hits: object[], titleHitCount: number, scannedBody: boolean}}
 */
export function search(entries, query, limit = DEFAULT_LIMIT) {
  const tokens = tokenize(query);
  if (tokens.length === 0) return { hits: [], titleHitCount: 0, scannedBody: false };
  const idf = buildIdf(entries, tokens);
  const phrase = String(query ?? '').trim().toLowerCase();
  const score = (e) => scoreEntry(e, tokens, idf, phrase, phrase);

  // 阶段一：标题
  const titleHits = [];
  for (const e of entries) {
    const tl = e.title.toLowerCase();
    if (tokens.some((t) => tl.includes(t))) titleHits.push({ e, s: score(e) });
  }

  if (titleHits.length >= TITLE_HIT_ENOUGH) {
    titleHits.sort((a, b) => b.s.score - a.s.score);
    const top = titleHits[0].s.score;
    const kept = titleHits
      .filter((h) => h.s.score >= ABS_FLOOR && h.s.score >= top * REL_FLOOR)
      .slice(0, limit);
    return {
      hits: kept.map(({ e, s }) => ({ ...e, score: s.score, where: s.where, snippet: snippetOf(e, tokens) })),
      titleHitCount: titleHits.length,
      scannedBody: false,
    };
  }

  // 阶段二：全部（标题已命中的自然分数更高）
  const all = [];
  for (const e of entries) {
    const s = score(e);
    if (s.score > 0) all.push({ e, s });
  }
  all.sort((a, b) => b.s.score - a.s.score);
  const top = all.length > 0 ? all[0].s.score : 0;
  const kept = all
    .filter((x) => x.s.score >= ABS_FLOOR && x.s.score >= top * REL_FLOOR)
    .slice(0, limit);
  return {
    hits: kept.map(({ e, s }) => ({ ...e, score: s.score, where: s.where, snippet: snippetOf(e, tokens) })),
    titleHitCount: titleHits.length,
    scannedBody: true,
  };
}

/**
 * 每个词在全库出现在多少条里。用来判断「这个词太泛了」。
 *
 * @param {object[]} entries 全部条目。
 * @param {string[]} tokens 词条。
 * @returns {Array<{token: string, count: number}>} 按出现条数降序。
 */
export function termFrequency(entries, tokens) {
  return tokens
    .map((t) => {
      const lt = t.toLowerCase();
      let count = 0;
      for (const e of entries) {
        const hay = `${e.title}\n${e.body.join('\n')}\n${e.items.join('\n')}`.toLowerCase();
        if (hay.includes(lt)) count++;
      }
      return { token: t, count };
    })
    .sort((a, b) => b.count - a.count);
}

/**
 * 把检索结果渲染成给模型看的文本。
 *
 * 四段提示各自对应一种「模型会误判」的情形，见文件头注释。
 *
 * @param {object} result `search()` 的返回。
 * @param {object} ctx `{ query, limit, entries, fileCount, charTotal }`。
 * @returns {string}
 */
export function render(result, ctx) {
  const { query, limit, entries, fileCount, charTotal } = ctx;
  const { hits, titleHitCount, scannedBody } = result;

  if (entries.length === 0) {
    return `日志里还没有任何条目（${fileCount} 个文件，${charTotal} 字符）。先写一条再来查。`;
  }

  if (hits.length === 0) {
    return [
      `没有匹配「${query}」的条目。`,
      '',
      `检索范围：日志\\*.md 的标题与正文，共 ${entries.length} 条 / ${fileCount} 个文件 / ${charTotal} 字符。`,
      '**这里搜不到不代表从未做过** —— 可能当时用了别的说法，也可能只记在了别的文档里。',
      '换个说法再试一次，或者直接读 `_日志索引.md` 的标题列表扫一眼。',
    ].join('\n');
  }

  const lines = [];
  const scope = scannedBody ? '标题 + 正文' : '标题';
  lines.push(`匹配「${query}」：${hits.length} 条（范围 ${scope}，日志全库 ${entries.length} 条）`);
  lines.push('');

  for (const h of hits) {
    const tier = h.tier ? `[${h.tier}]` : '';
    const time = h.time || '--:--:--';
    lines.push(`- ${h.date} ${time}${tier} 第 ${h.num} 条 **${h.title}**`);
    lines.push(`  锚点：日志\\${h.file}:${h.line}　命中：${h.where}`);
    if (h.snippet) lines.push(`  ${h.snippet}`);
    lines.push('');
  }

  // 被过滤掉多少、为什么过滤 —— 说清楚，否则模型会以为「就这些」。
  const dropped = titleHitCount - hits.length;
  if (dropped > 0) {
    lines.push(
      `另有 ${dropped} 条标题里只蹭到了查询中的个别词（分数远低于上面这些），没列出来。`,
    );
  }
  if (hits.length >= limit) {
    lines.push(`要更多就调大 \`limit\`（上限 ${MAX_LIMIT}）。`);
  }

  return lines.join('\n').trimEnd();
}

/**
 * 一个词的命中条数远超其他词时，给一句提示。
 *
 * @param {Array<{token: string, count: number}>} freq `termFrequency()` 的返回。
 * @param {number} total 全库条目数。
 * @returns {string} 提示（可能为空）。
 */
export function genericTermHint(freq, total) {
  if (freq.length < 2) return '';
  const [first, ...rest] = freq;
  if (first.count < total * 0.3) return '';
  const others = rest.filter((f) => f.count < first.count / 3);
  if (others.length === 0) return '';
  return `「${first.token}」在 ${first.count}/${total} 条里都有，基本筛不掉什么。试试只搜 ${others
    .map((o) => `「${o.token}」`)
    .join(' / ')}。`;
}
