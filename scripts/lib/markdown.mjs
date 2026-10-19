/**
 * 极简 Markdown → HTML 渲染器（**零依赖**，与 kit 的既有约束一致）。
 *
 * 为什么自己写而不是引三方库：
 *   · kit 的立身之本是"0 依赖、单文件、离线可用"——为一个看板引入 marked/markdown-it
 *     会把这三个承诺一起打破（还要处理版本、体积、供应链）；
 *   · 我们只需要渲染**本项目自己的产物**（SPEC/TASKS/CONTRACT/verification/release…），
 *     用到的语法是可枚举的子集，不需要 CommonMark 全兼容。
 *
 * 支持的子集（覆盖本 kit 全部模板产物）：
 *   标题 #..#6 · 围栏代码块 ```lang · 表格（含对齐） · 无序/有序列表（支持一级缩进）
 *   引用块 > · 分隔线 --- / *** · 段落 · 行内 code / **粗** / *斜* / [链接](url) / 裸 URL
 *
 * 安全：**先整体转义 HTML**，再在转义后的文本上做行内替换，因此文档里的
 * `<script>` 之类只会作为文本显示，不会被当成标签执行。
 */

const escHtml = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/** 行内语法：code → 粗体 → 斜体 → 链接 → 裸 URL。输入必须是**已转义**文本。 */
function inline(text) {
  const codes = [];
  let t = text.replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000C${codes.length - 1}\u0000`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  // 斜体：两侧非空格，避免把 * 列表或算式吃掉
  t = t.replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => {
    const safe = /^(https?:|mailto:|#|\/|\.)/i.test(href) ? href : '#';
    const ext = /^https?:/i.test(safe) ? ' target="_blank" rel="noopener"' : '';
    return `<a href="${safe}"${ext}>${label}</a>`;
  });
  // 裸 URL（不在已有 href/label 里的简单情况）
  t = t.replace(/(^|[\s(])((?:https?:\/\/)[^\s<)]+)/g,
    (_, pre, url) => `${pre}<a href="${url}" target="_blank" rel="noopener">${url}</a>`);
  t = t.replace(/\u0000C(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  return t;
}

/** 表格：`| a | b |` + `|---|:--:|` */
function isTableHead(lines, i) {
  return /^\s*\|.*\|\s*$/.test(lines[i] || '')
    && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1] || '')
    && (lines[i + 1] || '').includes('-');
}

function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

/** 列表：连续的 "-" / "*" / "+" 或 "1." 行；更深缩进视为子项 */
function isListLine(line) { return /^\s*(?:[-*+]|\d+[.)])\s+/.test(line); }

function renderList(lines, start, out) {
  const items = [];
  let i = start;
  let ordered = /^\s*\d+[.)]\s+/.test(lines[i]);
  let baseIndent = (lines[i].match(/^\s*/) || [''])[0].length;
  while (i < lines.length && isListLine(lines[i])) {
    const m = lines[i].match(/^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/);
    if (!m) break;
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      // 子列表：递归渲染后续更深的行
      const sub = [];
      let j = i;
      while (j < lines.length && isListLine(lines[j])
        && (lines[j].match(/^\s*/) || [''])[0].length > baseIndent) {
        sub.push(lines[j].replace(new RegExp(`^\\s{${baseIndent + 2}}`), ''));
        j += 1;
      }
      const subHtml = renderLines(sub);
      if (items.length) items[items.length - 1].children = subHtml;
      i = j;
      continue;
    }
    items.push({ text: m[2], children: '' });
    i += 1;
  }
  const tag = ordered ? 'ol' : 'ul';
  const body = items.map((it) => `<li>${inline(escHtml(it.text))}${it.children || ''}</li>`).join('');
  out.push(`<${tag}>${body}</${tag}>`);
  return i;
}

function renderLines(lines) {
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // 围栏代码块
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const buf = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) { buf.push(lines[i]); i += 1; }
      i += 1;
      out.push(`<pre class="code"${lang ? ` data-lang="${escHtml(lang)}"` : ''}><code>${escHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }

    // 空行
    if (!line.trim()) { i += 1; continue; }

    // 标题
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const lv = h[1].length;
      out.push(`<h${lv}>${inline(escHtml(h[2]))}</h${lv}>`);
      i += 1;
      continue;
    }

    // 分隔线
    if (/^\s*([-*_])\s*(\1\s*){2,}$/.test(line)) { out.push('<hr>'); i += 1; continue; }

    // 表格
    if (isTableHead(lines, i)) {
      const head = splitRow(lines[i]);
      const align = splitRow(lines[i + 1]).map((c) => {
        if (/^:.*:$/.test(c)) return 'center';
        if (/^:/.test(c)) return 'left';
        if (/:$/.test(c)) return 'right';
        return '';
      });
      i += 2;
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(splitRow(lines[i])); i += 1; }
      const th = head.map((c, k) => `<th${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(escHtml(c))}</th>`).join('');
      const tb = rows.map((r) => `<tr>${head.map((_, k) => `<td${align[k] ? ` style="text-align:${align[k]}"` : ''}>${inline(escHtml(r[k] || ''))}</td>`).join('')}</tr>`).join('');
      out.push(`<div class="tablewrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`);
      continue;
    }

    // 列表
    if (isListLine(line)) { i = renderList(lines, i, out); continue; }

    // 引用块
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i += 1; }
      out.push(`<blockquote>${renderLines(buf)}</blockquote>`);
      continue;
    }

    // 段落：吃到空行/块级起始
    const buf = [line];
    i += 1;
    while (i < lines.length && lines[i].trim()
      && !/^\s*```/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i])
      && !isListLine(lines[i]) && !/^\s*>\s?/.test(lines[i])
      && !isTableHead(lines, i) && !/^\s*([-*_])\s*(\1\s*){2,}$/.test(lines[i])) {
      buf.push(lines[i]); i += 1;
    }
    out.push(`<p>${inline(escHtml(buf.join('\n'))).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}

/** 对外入口：Markdown 文本 → 安全的 HTML 片段 */
export function mdToHtml(src) {
  if (!src) return '';
  const text = String(src).replace(/\r\n?/g, '\n').replace(/\t/g, '  ');
  return renderLines(text.split('\n'));
}

export default mdToHtml;
