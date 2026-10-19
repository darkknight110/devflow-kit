/**
 * 终端里的文档渲染：把 Markdown 变成**适合在终端读**的文本块。
 *
 * 为什么单独一个模块：`cli.mjs` 已经 3800 行，渲染逻辑放进去既难测也难维护；
 * 这里只做纯函数（输入字符串，输出行数组），不碰文件系统、不依赖颜色实现
 * （paint 由调用方注入，便于在非 TTY / NO_COLOR 下退化为纯文本）。
 *
 * 支持：标题 / 代码块 / 表格（按显示宽度对齐，中文占 2 列）/ 列表 / 引用 / 分隔线 / 段落折行。
 * 不追求 CommonMark 全兼容 —— 只覆盖本 kit 自己模板产出的语法。
 */

/** 显示宽度：中日韩字符占 2 列 */
export function dispW(s) {
  return [...String(s)].reduce((n, ch) => n
    + (/[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1), 0);
}

/** 按显示宽度右补空格 */
export function padW(s, w) {
  return String(s) + ' '.repeat(Math.max(0, w - dispW(s)));
}

/** 去掉行内标记，保留可读文本（终端不做富文本，避免 ANSI 干扰宽度计算） */
export function stripInline(s) {
  return String(s)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1$2')
    .replace(/\s+$/, '');
}

/**
 * 按显示宽度折行：**中文逐字可断，英文/数字整词不断**。
 * 纯按字符切会把 "2026-10-15" 这种串劈成两截（实测出现过 "202" / "6-10-15"）。
 */
export function wrapW(text, width, indent = 0) {
  const avail = Math.max(20, width - indent);
  // 切词：宽字符各自成词；连续的非空白、非宽字符组成一个词；空白单独成词
  const isWide = (ch) => /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch);
  const tokens = [];
  let word = '';
  for (const ch of String(text)) {
    if (ch === ' ' || isWide(ch)) {
      if (word) { tokens.push(word); word = ''; }
      tokens.push(ch);
    } else {
      word += ch;
    }
  }
  if (word) tokens.push(word);

  const out = [];
  let line = '';
  let lw = 0;
  for (const tk of tokens) {
    const w = dispW(tk);
    if (tk === ' ' && !line) continue;              // 行首不保留空格
    if (lw + w > avail && line) {
      out.push(line);
      line = '';
      lw = 0;
      if (tk === ' ') continue;                     // 折行处的空格丢掉
    }
    // 单词本身比整行还宽：硬切（极长 URL / 无空格长串）
    if (w > avail) {
      for (const ch of tk) {
        const cw = dispW(ch);
        if (lw + cw > avail && line) { out.push(line); line = ''; lw = 0; }
        line += ch; lw += cw;
      }
      continue;
    }
    line += tk;
    lw += w;
  }
  if (line) out.push(line);
  const pad = ' '.repeat(indent);
  return out.map((l) => (l ? pad + l : ''));
}

const isTableRow = (l) => /^\s*\|.*\|\s*$/.test(l || '');
const isTableSep = (l) => /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l || '') && String(l || '').includes('-');
const cells = (l) => {
  let s = String(l).trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => stripInline(c.trim()));
};

/** 终端表格：列宽按内容算，超出总宽则截断并加 … */
function renderTable(head, rows, width, paint) {
  const cols = Math.max(head.length, ...rows.map((r) => r.length));
  const w = Array.from({ length: cols }, (_, k) => Math.max(
    dispW(head[k] || ''),
    ...rows.map((r) => dispW(r[k] || '')),
  ));
  // 总宽超出可用宽度时，按比例压缩最宽的列
  const gap = 2;
  let total = w.reduce((a, b) => a + b, 0) + gap * (cols - 1);
  while (total > width && Math.max(...w) > 6) {
    const k = w.indexOf(Math.max(...w));
    w[k] -= 1;
    total -= 1;
  }
  const fit = (s, k) => {
    const t = String(s || '');
    if (dispW(t) <= w[k]) return padW(t, w[k]);
    let out = '';
    for (const ch of t) {
      if (dispW(out) + dispW(ch) > w[k] - 1) break;
      out += ch;
    }
    return padW(out + '…', w[k]);
  };
  const line = (arr) => '  ' + arr.map((c, k) => fit(c, k)).join(' '.repeat(gap)).trimEnd();
  const out = [line(head), '  ' + w.map((x) => '─'.repeat(x)).join(' '.repeat(gap))];
  for (const r of rows) out.push(line(r));
  return out.map((l) => (paint ? paint(l, 'reset') : l));
}

/**
 * Markdown → 终端行数组。
 * @param {string} md
 * @param {{width?: number, paint?: (t: string, c: string) => string}} opts
 */
export function renderTerminal(md, opts = {}) {
  const width = Math.max(50, Math.min(Number(opts.width) || 100, 160));
  const paint = typeof opts.paint === 'function' ? opts.paint : (t) => t;
  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];

    // 围栏代码块
    if (/^\s*```/.test(raw)) {
      i += 1;
      out.push('');
      while (i < lines.length && !/^\s*```/.test(lines[i])) {
        out.push('  ' + paint('│ ', 'dim') + paint(lines[i], 'dim'));
        i += 1;
      }
      i += 1;
      out.push('');
      continue;
    }

    if (!raw.trim()) { i += 1; continue; }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (h) {
      const lv = h[1].length;
      const text = stripInline(h[2]);
      out.push('');
      out.push(paint(text, lv <= 2 ? 'bold' : 'blue'));
      if (lv <= 2) out.push(paint('─'.repeat(Math.min(width, Math.max(8, dispW(text)))), 'dim'));
      out.push('');
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(raw)) {
      out.push(paint('─'.repeat(width), 'dim'));
      i += 1;
      continue;
    }

    // 表格
    if (isTableRow(raw) && isTableSep(lines[i + 1])) {
      const head = cells(raw);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i += 1; }
      out.push('');
      out.push(...renderTable(head, rows, width - 2, paint));
      out.push('');
      continue;
    }

    // 列表
    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(raw)) {
      while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        const indent = Math.min(m[1].length, 8);
        const bullet = /\d/.test(m[2]) ? m[2] : '•';
        const body = stripInline(m[3]);
        const wrapped = wrapW(body, width, indent + 2);
        out.push(' '.repeat(indent) + paint(bullet, 'dim') + ' ' + wrapped[0].trimStart());
        for (let k = 1; k < wrapped.length; k += 1) out.push(wrapped[k]);
        i += 1;
      }
      continue;
    }

    // 引用块
    if (/^\s*>\s?/.test(raw)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(stripInline(lines[i].replace(/^\s*>\s?/, '')));
        i += 1;
      }
      const text = buf.join(' ').trim();
      if (text) {
        out.push('');
        for (const l of wrapW(text, width, 2)) {
          out.push(l.trim() ? paint('│ ', 'dim') + l.trimStart() : '');
        }
        out.push('');
      }
      continue;
    }

    // 段落：吃到空行或下一个块级起始
    const buf = [stripInline(raw)];
    i += 1;
    while (i < lines.length && lines[i].trim()
      && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
      && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])
      && !/^\s*>\s?/.test(lines[i])
      && !(isTableRow(lines[i]) && isTableSep(lines[i + 1]))
      && !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])) {
      buf.push(stripInline(lines[i]));
      i += 1;
    }
    out.push('');
    out.push(...wrapW(buf.join(' '), width, 0));
    out.push('');
  }

  // 收敛连续空行
  const cleaned = [];
  for (const l of out) {
    if (l === '' && cleaned[cleaned.length - 1] === '') continue;
    cleaned.push(l);
  }
  while (cleaned.length && cleaned[0] === '') cleaned.shift();
  while (cleaned.length && cleaned[cleaned.length - 1] === '') cleaned.pop();
  return cleaned;
}

export default renderTerminal;
