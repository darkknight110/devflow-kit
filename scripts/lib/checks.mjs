/**
 * 产物读取与结构校验（G1 的基础）。
 * 不引入 Markdown 解析库：只做可靠的正则切段与表格解析。
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export function exists(file) {
  return existsSync(file);
}

/** 读取文本，失败返回 null（调用方决定如何判定） */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

/** 按 `## 标题` 切段，返回 { 标题: 正文 }；也支持 `## 一、标题` 这类前缀 */
export function sections(markdown) {
  const out = {};
  if (!markdown) return out;
  const lines = markdown.split('\n');
  let current = null;
  let buffer = [];
  const flush = () => {
    if (current !== null) out[current] = buffer.join('\n');
  };
  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      current = m[1].replace(/^[一二三四五六七八九十]+[、.]\s*/, '');
      buffer = [];
    } else if (current !== null) {
      buffer.push(line);
    }
  }
  flush();
  return out;
}

/** 找出包含指定关键词的段（关键词全部命中才算） */
export function findSection(markdown, keywords) {
  const all = sections(markdown);
  const keys = Object.keys(all);
  for (const key of keys) {
    const hay = key;
    if (keywords.every((k) => hay.includes(k))) return { title: key, body: all[key] };
  }
  return null;
}

/** 解析 Markdown 表格，返回 [{ 列名: 值 }]（跳过表头与分隔行） */
export function tables(markdown) {
  const result = [];
  if (!markdown) return result;
  const lines = markdown.split('\n');
  let i = 0;
  while (i < lines.length) {
    if (/^\s*\|/.test(lines[i]) && i + 1 < lines.length && /^\s*\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const header = splitRow(lines[i]);
      const rows = [];
      let j = i + 2;
      while (j < lines.length && /^\s*\|/.test(lines[j])) {
        rows.push(splitRow(lines[j]));
        j += 1;
      }
      result.push({ header, rows });
      i = j;
    } else {
      i += 1;
    }
  }
  return result;
}

function splitRow(line) {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((c) => c.trim());
}

/** 用列名（支持部分匹配）取表格值 */
function cell(row, header, name) {
  const idx = header.findIndex((h) => h.replace(/\s/g, '').includes(name.replace(/\s/g, '')));
  return idx >= 0 ? (row[idx] || '') : '';
}

/** 键值表（| 键 | 值 | 形式）→ { 键: 值 } */
export function keyValues(markdown, sectionKeywords) {
  const section = sectionKeywords ? findSection(markdown, sectionKeywords) : { body: markdown };
  const out = {};
  if (!section) return out;
  for (const table of tables(section.body)) {
    if (table.header.length < 2) continue;
    for (const row of table.rows) {
      const k = (row[0] || '').replace(/\*\*/g, '').trim();
      if (k) out[k] = (row[1] || '').trim();
    }
  }
  return out;
}

/** 任务表 → 结构化任务清单 */
export function parseTasks(markdown) {
  const section = findSection(markdown, ['任务']);
  if (!section) return [];
  const out = [];
  for (const table of tables(section.body)) {
    for (const row of table.rows) {
      const id = cell(row, table.header, 'T');
      if (!id) continue;
      out.push({
        id,
        repo: cell(row, table.header, '目标仓'),
        scope: cell(row, table.header, '写入范围'),
        depends: cell(row, table.header, '依赖'),
        command: cell(row, table.header, '验收命令'),
        ac: cell(row, table.header, '对应AC'),
      });
    }
  }
  return out;
}

/** 验收标准表 → 结构化 AC 清单 */
export function parseAcceptanceCriteria(markdown) {
  const section = findSection(markdown, ['验收标准']);
  if (!section) return [];
  const out = [];
  for (const table of tables(section.body)) {
    for (const row of table.rows) {
      const id = cell(row, table.header, 'AC');
      if (!id) continue;
      out.push({
        id,
        judgement: cell(row, table.header, '判据'),
        judgementType: cell(row, table.header, '判据类型'),
        owner: cell(row, table.header, '责任方'),
      });
    }
  }
  return out;
}

/** 逐条对照表（验证记录）→ [{ AC, 结论, 证据 }] */
export function parseVerification(markdown) {
  const section = findSection(markdown, ['逐条对照']);
  if (!section) return [];
  const out = [];
  for (const table of tables(section.body)) {
    for (const row of table.rows) {
      const ac = cell(row, table.header, 'AC');
      if (!ac) continue;
      out.push({ ac, conclusion: cell(row, table.header, '结论'), evidence: cell(row, table.header, '证据') });
    }
  }
  return out;
}

/** 确认记录 → [{ 确认点, 确认人, 时间, 结论 }] */
export function parseApprovals(markdown) {
  const section = findSection(markdown, ['确认记录']);
  if (!section) return [];
  const out = [];
  for (const table of tables(section.body)) {
    for (const row of table.rows) {
      const point = cell(row, table.header, '确认点');
      if (!point) continue;
      out.push({
        point,
        who: cell(row, table.header, '确认人'),
        at: cell(row, table.header, '时间'),
        verdict: cell(row, table.header, '结论'),
      });
    }
  }
  return out;
}

/** 递归列出目录下所有文件（相对路径），跳过归档目录与 node_modules */
export function listFiles(dir, { skip = ['.devflow/archive', 'node_modules', '.git'] } = {}) {
  const out = [];
  if (!existsSync(dir)) return out;
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (skip.some((s) => rel === s || rel.startsWith(`${s}/`))) continue;
      if (entry.isDirectory()) walk(full);
      else out.push(rel);
    }
  };
  walk(dir);
  return out;
}

/** 统计目录下文件体积（千字符） */
export function dirSizeKb(dir, options) {
  const files = listFiles(dir, options);
  const per = files.map((rel) => {
    const full = path.join(dir, rel);
    let chars = 0;
    try {
      chars = statSync(full).size;
    } catch {
      chars = 0;
    }
    return { file: rel, kb: Math.round(chars / 102.4) / 10 };
  });
  per.sort((a, b) => b.kb - a.kb);
  const totalKb = Math.round(per.reduce((sum, f) => sum + f.kb, 0) * 10) / 10;
  return { totalKb, files: per };
}
