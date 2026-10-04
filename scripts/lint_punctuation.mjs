#!/usr/bin/env node
/**
 * 中文标点机械检查（确定性规则）
 * 依据：GB/T 15834-2011《标点符号用法》
 *
 * 只报"位置 + 规则 + 建议"，不修改原文。语义类判定（语气、层次、
 * 引号内外点号等）不在此脚本职责内，交由模型按 references/ 复核。
 *
 * 用法：
 *   node scripts/lint_punctuation.mjs --input 文本.md [--format text|json]
 *   node scripts/lint_punctuation.mjs --text "待检文字"
 *   node scripts/lint_punctuation.mjs --input 文本.md --format json
 */

import { readFileSync } from 'node:fs';

const HELP = `中文标点机械检查（GB/T 15834-2011）

用法：
  node scripts/lint_punctuation.mjs --input <文件> [--format text|json]
  node scripts/lint_punctuation.mjs --text "<文字>" [--format text|json]

选项：
  --input, -i    待检文件路径（UTF-8）
  --text,  -t    直接传入待检文字
  --format, -f   输出格式：text（默认）或 json
  --only         只看某个严重级别：error | warn | review
  --help,  -h    显示帮助

严重级别：
  error   明确违反国标，应修改
  warn    大概率应修改
  review  需结合语境判断，交模型复核
`;

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/;
const CJK_OR_PUNCT = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;
const ASCII_WORD = /[0-9A-Za-z]/;

// ---------------------------------------------------------------- 参数解析

function parseArgs(argv) {
  const out = { format: 'text' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--input' || a === '-i') out.input = argv[++i];
    else if (a === '--text' || a === '-t') out.text = argv[++i];
    else if (a === '--format' || a === '-f') out.format = argv[++i];
    else if (a === '--only') out.only = argv[++i];
    else if (!out.input && !out.text && !a.startsWith('-')) out.input = a;
    else throw new Error(`未知参数：${a}`);
  }
  return out;
}

// ---------------------------------------------------------------- 忽略区

function buildIgnoreMask(text) {
  const ignore = new Array(text.length).fill(false);
  const mark = (re) => {
    for (const m of text.matchAll(re)) {
      for (let i = m.index; i < m.index + m[0].length; i++) ignore[i] = true;
    }
  };
  mark(/```[\s\S]*?```/g);            // 围栏代码块
  mark(/~~~[\s\S]*?~~~/g);
  mark(/`[^`\n]*`/g);                  // 行内代码
  mark(/https?:\/\/\S+/g);             // 网址
  mark(/!?\[[^\]\n]*\]\([^)\n]*\)/g);  // Markdown 链接/图片
  mark(/<\/?[a-zA-Z][^>\n]*>/g);       // HTML 标签
  return ignore;
}

// ---------------------------------------------------------------- 位置换算

function makeLocator(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (index) => {
    let lo = 0, hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid; else hi = mid - 1;
    }
    return { line: lo + 1, col: index - starts[lo] + 1 };
  };
}

function excerpt(text, index, len = 1) {
  const a = Math.max(0, index - 12);
  const b = Math.min(text.length, index + len + 12);
  return text.slice(a, b).replace(/\n/g, '⏎');
}

// ---------------------------------------------------------------- 工具

const HALF2FULL = {
  ',': '，', '.': '。', '!': '！', '?': '？', ';': '；', ':': '：',
  '(': '（', ')': '）', '[': '〔', ']': '〕', '<': '《', '>': '》',
};

function isIgnored(ignore, i) { return ignore[i] === true; }

// ---------------------------------------------------------------- 检查项

function runChecks(text) {
  const ignore = buildIgnoreMask(text);
  const chars = [...text];
  // 因 CJK 均在 BMP，char 与 code unit 一一对应，可直接用索引。
  const issues = [];

  const add = (o) => {
    if (o.index < 0 || o.index >= text.length) return;
    if (isIgnored(ignore, o.index)) return;
    for (let k = o.index; k < o.index + (o.len || 1); k++) if (isIgnored(ignore, k)) return;
    issues.push(o);
  };

  // R1 半角标点混入中文
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (!(c in HALF2FULL)) continue;
    if (c === '.' && /\d/.test(text[i - 1] || '') && /\d/.test(text[i + 1] || '')) continue; // 小数
    if (c === '.' && (text[i - 1] === '.' || text[i + 1] === '.')) continue; // 交给省略号规则 R3
    if ((c === '.' || c === ',') && ASCII_WORD.test(text[i - 1] || '') && ASCII_WORD.test(text[i + 1] || '')) continue; // 千分位/英文
    const prev = text[i - 1] || '', next = text[i + 1] || '';
    const touchCJK = CJK.test(prev) || CJK.test(next);
    if (!touchCJK) continue;
    if (c === '<' || c === '>') continue; // 交给别的规则，避免误吞比较符
    add({
      index: i, len: 1, rule: 'R1', severity: 'error', clause: '5.1',
      message: `中文文本中使用了半角标点“${c}”`,
      suggestion: `改为全角“${HALF2FULL[c]}”`,
      caseId: 'C-HALF-01',
    });
  }

  // R2 中文里的英文引号
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c !== '"' && c !== "'") continue;
    const prev = text[i - 1] || '', next = text[i + 1] || '';
    if (!CJK.test(prev) && !CJK.test(next)) continue;
    add({
      index: i, len: 1, rule: 'R2', severity: 'warn', clause: '4.8.2',
      message: '中文文本中使用了英文直引号',
      suggestion: '改为中文弯引号（双引号“”或单引号‘’）',
      caseId: 'C-QUOTE-01',
    });
  }

  // R3/R4 省略号写法
  for (const m of text.matchAll(/\.{3,}|。{3,}|…{1,}|。\s*。\s*。/g)) {
    const s = m[0];
    if (s.startsWith('…')) {
      const n = s.length;
      if (n === 2) continue; // 正确：……
      if (n > 2) {
        add({ index: m.index, len: n, rule: 'R4', severity: 'error', clause: 'A.9.1',
          message: `省略号连用超过两个（${n} 个，即 ${n * 3} 连点）`, suggestion: '最多连用两个省略号，即“……”' });
      } else {
        add({ index: m.index, len: 1, rule: 'R3', severity: 'warn', clause: '4.11.2',
          message: '省略号只写了一个“…”（三点）', suggestion: '中文省略号形式为六连点“……”', caseId: 'C-ELLIP-01' });
      }
      continue;
    }
    add({ index: m.index, len: s.length, rule: 'R3', severity: 'error', clause: '4.11.2',
      message: '省略号写法不规范（用了英文句点或中文句号连写）', suggestion: '改为六连点“……”', caseId: 'C-ELLIP-01' });
  }

  // R5 破折号写法
  for (const m of text.matchAll(/-{2,}|—{3,}|－{2,}/g)) {
    const near = CJK.test(text[m.index - 1] || '') || CJK.test(text[m.index + m[0].length] || '');
    if (!near) continue;
    add({ index: m.index, len: m[0].length, rule: 'R5', severity: 'error', clause: '4.10.2',
      message: '破折号写法不规范（用了连字符或全角减号）', suggestion: '破折号用两个“——”，占两个字位置', caseId: 'C-DASH-01' });
  }
  for (let i = 0; i + 1 < text.length; i++) {
    if (text[i] === '—' && text[i + 1] !== '—' && text[i - 1] !== '—') {
      const prev = text[i - 1] || '', next = text[i + 1] || '';
      // 单个一字线多用于连接号（如 北京—上海、1931—1945），此处仅提示复核
      if (CJK.test(prev) && CJK.test(next)) {
        add({ index: i, len: 1, rule: 'R5b', severity: 'review', clause: '4.10.2 / 4.13.3',
          message: '出现单个“—”：是破折号（应为“——”），还是连接号一字线？',
          suggestion: '表示解释说明/转折/延长用“——”；表示时间、地域起止用一字线“—”' });
      }
    }
  }

  // R6 重复标点
  for (const m of text.matchAll(/[。，、；：？！]{2,}/g)) {
    const s = m[0];
    if (/^[？！]+$/.test(s)) {
      if (s.length > 3) add({ index: m.index, len: s.length, rule: 'R7', severity: 'error', clause: '4.2.3.3 / 4.3.3.3 / 5.1.2',
        message: `${s[0]}叠用超过三个`, suggestion: `最多叠用三个“${s[0]}”` });
      continue;
    }
    if (new Set(s).size === 1) {
      add({ index: m.index, len: s.length, rule: 'R6', severity: 'error', clause: '5.1.1',
        message: `重复使用了“${s[0]}”`, suggestion: `只保留一个“${s[0]}”` });
    } else {
      add({ index: m.index, len: s.length, rule: 'R6b', severity: 'review', clause: '5.1',
        message: `标点连用可疑：“${s}”`, suggestion: '确认两个标点是否都必要，通常只保留一个' });
    }
  }

  // R8 引号配对
  const pairs = [
    ['“', '”', '双引号'],
    ['‘', '’', '单引号'],
  ];
  for (const [open, close, name] of pairs) {
    const nOpen = countOutside(text, open, ignore);
    const nClose = countOutside(text, close, ignore);
    if (nOpen !== nClose) {
      add({ index: text.indexOf(nOpen > nClose ? open : close), len: 1, rule: 'R8', severity: 'error', clause: '4.8.2',
        message: `${name}前后不配对（前 ${nOpen} 个，后 ${nClose} 个）`, suggestion: '补齐或删除多余的引号' });
    }
  }

  // R9 括号/书名号配对
  const brackets = [
    ['（', '）', '圆括号'], ['《', '》', '书名号'], ['〈', '〉', '单书名号'],
    ['【', '】', '方头括号'], ['〔', '〕', '六角括号'],
  ];
  for (const [open, close, name] of brackets) {
    const nOpen = countOutside(text, open, ignore);
    const nClose = countOutside(text, close, ignore);
    if (nOpen !== nClose) {
      add({ index: text.indexOf(nOpen > nClose ? open : close), len: 1, rule: 'R9', severity: 'error', clause: '4.9.2 / 4.15.2',
        message: `${name}前后不配对（“${open}” ${nOpen} 个，“${close}” ${nClose} 个）`, suggestion: '补齐或删除多余的括号' });
    }
  }

  // R10 顿号疑用于概数（跳过 3 项以上的并列列举，以及带小数点的序号引用）
  const NUM = '一二三四五六七八九十百千万零两';
  const enumRanges = [...text.matchAll(new RegExp(`(?:[${NUM}0-9]+\\s*、\\s*){2,}[${NUM}0-9]+`, 'g'))]
    .map((m) => [m.index, m.index + m[0].length]);
  const inEnum = (i, len) => enumRanges.some(([a, b]) => i >= a && i + len <= b);
  for (const m of text.matchAll(new RegExp(`(?<![0-9.])[${NUM}0-9]\\s*、\\s*[${NUM}0-9](?![0-9])`, 'g'))) {
    if (inEnum(m.index, m[0].length)) continue;
    add({ index: m.index, len: m[0].length, rule: 'R10', severity: 'review', clause: '4.5.3.4',
      message: `数字之间用了顿号：“${m[0]}”`, suggestion: '若表示概数（如八九公里、三五天）应删去顿号；若表示缩略并列（如二、三产业）则保留', caseId: 'C-DUNHAO-01' });
  }

  // R11 并列引号/书名号之间的顿号
  for (const m of text.matchAll(/[”》〉]\s*、\s*[“《〈]/g)) {
    add({ index: m.index, len: m[0].length, rule: 'R11', severity: 'review', clause: '4.5.3.5',
      message: `并列的引号/书名号之间用了顿号：“${m[0].replace(/\s/g, '')}”`,
      suggestion: '通常不用顿号（如《红楼梦》《三国演义》）；仅当中间夹有其他成分时才用顿号', caseId: 'C-DUNHAO-02' });
  }

  // R12 省略号与"等"类词同现
  for (const m of text.matchAll(/…{1,2}[^。！？\n]{0,10}?(等|等等|什么的)/g)) {
    add({ index: m.index, len: m[0].length, rule: 'R12', severity: 'warn', clause: 'A.9.2',
      message: '省略号与“等”类词同时使用', suggestion: '二者只用其一：能读出来用“等/等等”，不能读出来用省略号', caseId: 'C-ELLIP-02' });
  }

  // R13 破折号与"即/就是"连用
  for (const m of text.matchAll(/——\s*(即|就是|也即|也就是)/g)) {
    add({ index: m.index, len: m[0].length, rule: 'R13', severity: 'warn', clause: '编辑通行规范',
      message: `破折号后接了“${m[1]}”，语义重复`, suggestion: '破折号本身表示解释说明，删去“即/就是”，或把破折号改为逗号', caseId: 'C-DASH-02' });
  }

  // R14 序次语后的标点
  for (const m of text.matchAll(/(^|[\n。；：！？])\s*([0-9]{1,3})、/g)) {
    add({ index: m.index + m[0].length - 2, len: 2, rule: 'R14a', severity: 'warn', clause: 'B.3.3',
      message: `阿拉伯数字序次语“${m[2]}、”后用了顿号`, suggestion: `改为下脚点“${m[2]}.”，顿号只用于汉字数字序次语` });
  }
  for (const m of text.matchAll(/[（(]\s*[一二三四五六七八九十0-9]{1,3}\s*[）)]\s*[、，,.]/g)) {
    add({ index: m.index, len: m[0].length, rule: 'R14b', severity: 'warn', clause: 'B.3.4',
      message: '带括号的序次语后面加了点号', suggestion: '加括号的序次语后不用任何点号' });
  }
  for (const m of text.matchAll(/(^|[\n。；：])\s*([一二三四五六七八九十]{1,2})[，,]/g)) {
    add({ index: m.index + m[0].length - 1, len: 1, rule: 'R14c', severity: 'review', clause: 'B.3.2',
      message: `汉字数字序次语“${m[2]}，”后用了逗号`, suggestion: '不带括号的汉字数字作序次语时，后用顿号“、”' });
  }

  // R15 中文之间的多余空格
  for (let i = 1; i < text.length - 1; i++) {
    if (text[i] !== ' ') continue;
    const prev = text[i - 1], next = text[i + 1];
    if (CJK.test(prev) && CJK.test(next)) {
      add({ index: i, len: 1, rule: 'R15', severity: 'review', clause: '5.1',
        message: '两个汉字之间有多余空格', suggestion: '中文之间通常不留空格' });
    } else if (CJK.test(prev) && CJK_OR_PUNCT.test(next)) {
      add({ index: i, len: 1, rule: 'R15b', severity: 'review', clause: '5.1',
        message: '汉字与标点之间有多余空格', suggestion: '删去空格' });
    }
  }

  // R16 省略号前后多加点号（冒号作提示语、"……"作占位时属正常，不列入）
  for (const m of text.matchAll(/……\s*[。，、；]|[。，、；]\s*……/g)) {
    add({ index: m.index, len: m[0].length, rule: 'R16', severity: 'review', clause: 'B.2.4',
      message: `省略号前后多了点号：“${m[0].trim()}"`, suggestion: '省略号前后通常不用点号（强烈语气时除外）' });
  }

  // R17 破折号前多加点号（冒号作提示语时不列入）
  for (const m of text.matchAll(/[，。；]\s*——/g)) {
    add({ index: m.index, len: m[0].length, rule: 'R17', severity: 'review', clause: 'B.2.3',
      message: '破折号前有点号', suggestion: '破折号之前通常不用点号' });
  }

  // R18 ASCII 波浪线用于数值/时间范围
  for (const m of text.matchAll(/[0-9]\s*~\s*[0-9]|[一二三四五六七八九十]\s*~\s*[一二三四五六七八九十]/g)) {
    add({ index: m.index, len: m[0].length, rule: 'R18', severity: 'review', clause: '4.13.3.2',
      message: `数值/时间范围用了 ASCII 波浪线：“${m[0].trim()}”`, suggestion: '改用浪纹线“～”或一字线“—”', caseId: 'C-LINK-01' });
  }

  return issues;
}

function countOutside(text, ch, ignore) {
  let n = 0;
  for (let i = 0; i < text.length; i++) if (text[i] === ch && !isIgnored(ignore, i)) n++;
  return n;
}

// ---------------------------------------------------------------- 输出

const SEV_ORDER = { error: 0, warn: 1, review: 2 };
const SEV_LABEL = { error: '错误', warn: '警告', review: '待核' };

function dedupe(issues) {
  const seen = new Set();
  const out = [];
  for (const it of issues.sort((a, b) => a.index - b.index || SEV_ORDER[a.severity] - SEV_ORDER[b.severity])) {
    const key = `${it.index}:${it.len}:${it.rule}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(it);
  }
  return out;
}

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); process.exit(2); }
  if (args.help) { console.log(HELP); return; }
  if (!args.input && args.text === undefined) { console.error(HELP); process.exit(2); }

  let text, source;
  try {
    if (args.text !== undefined) { text = args.text; source = '(内联文字)'; }
    else { text = readFileSync(args.input, 'utf8'); source = args.input; }
  } catch (e) { console.error(`读取失败：${e.message}`); process.exit(2); }

  const locate = makeLocator(text);
  let issues = dedupe(runChecks(text));
  if (args.only) issues = issues.filter((i) => i.severity === args.only);

  if (args.format === 'json') {
    console.log(JSON.stringify({
      standard: 'GB/T 15834-2011',
      source,
      total: issues.length,
      counts: {
        error: issues.filter((i) => i.severity === 'error').length,
        warn: issues.filter((i) => i.severity === 'warn').length,
        review: issues.filter((i) => i.severity === 'review').length,
      },
      issues: issues.map((it) => {
        const { line, col } = locate(it.index);
        return { line, col, ...it, excerpt: excerpt(text, it.index, it.len) };
      }),
    }, null, 2));
    return;
  }

  const counts = {
    error: issues.filter((i) => i.severity === 'error').length,
    warn: issues.filter((i) => i.severity === 'warn').length,
    review: issues.filter((i) => i.severity === 'review').length,
  };
  const lines = [];
  lines.push(`标点机械检查（GB/T 15834-2011）`);
  lines.push(`来源：${source}`);
  lines.push(`共 ${issues.length} 处：错误 ${counts.error} / 警告 ${counts.warn} / 待核 ${counts.review}`);
  lines.push('');
  if (!issues.length) {
    lines.push('机械检查未发现问题。仍需按 references/gbt15834-audit-matrix.md 做语义复核。');
  }
  let n = 0;
  for (const it of issues) {
    n++;
    const { line, col } = locate(it.index);
    lines.push(`[${n}] 第${line}行 第${col}列  ${SEV_LABEL[it.severity]}  ${it.rule}`);
    lines.push(`    判定：${it.message}`);
    lines.push(`    建议：${it.suggestion}`);
    lines.push(`    依据：GB/T 15834-2011 ${it.clause}`);
    lines.push(`    原文：${excerpt(text, it.index, it.len)}`);
    if (it.caseId) lines.push(`    官方案例：references/official-cases.md #${it.caseId}`);
    lines.push('');
  }
  lines.push('提示：以上仅为“形式层”的机械判定；语气、层次、引号内外点号等语义问题需继续按 SKILL.md 第 3 步复核。');
  console.log(lines.join('\n'));
}

main();
