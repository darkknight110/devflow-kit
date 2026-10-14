/**
 * 契约破坏性判定（`devflow contract diff`）。
 *
 * 要解决的问题：现在「这个契约改动会不会让消费方中断」**只能靠人写散文**
 * （`CONTRACT.md` 的「破坏性判定」表），于是要么漏判、要么每次都要重新讨论一遍。
 *
 * 做法（借鉴 buf / oasdiff / cargo-semver-checks 的数据模型）：
 *   ① 把契约**规范化**成可比较的结构；
 *   ② 冻结时存**基线快照**；
 *   ③ 用 `spec/breaking-rules.json` 里的**稳定规则 ID** 判定每条差异的级别。
 *
 * 刻意不做的（写进 spec 的 nonGoals）：
 *   · 不判定**字段语义**变化（"同一字段含义变了"纯文本匹配判不出来）—— 那必须人工确认；
 *   · 不替代运行时契约测试 —— 这是**静态结构比对**。
 */

/** 从 Markdown 表格里按表头名取列（与项目其它解析器同一口径） */
function tableRows(markdown, sectionNames) {
  const lines = String(markdown || '').split('\n');
  let hi = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (!/^\s*##\s/.test(lines[i])) continue;
    const title = lines[i].replace(/^\s*##\s*/, '').trim();
    if (!sectionNames.some((n) => title.includes(n))) continue;
    for (let j = i + 1; j < lines.length; j += 1) {
      if (/^\s*##\s/.test(lines[j])) break;
      if (/^\s*\|.*\|/.test(lines[j]) && !/^\s*\|[\s:|-]+\|\s*$/.test(lines[j])) { hi = j; break; }
    }
    if (hi >= 0) break;
  }
  if (hi < 0) return [];
  const cells = (l) => l.split('|').map((c) => c.trim()).slice(1, -1);
  const header = cells(lines[hi]);
  const out = [];
  for (let i = hi + 1; i < lines.length; i += 1) {
    if (/^\s*##\s/.test(lines[i])) break;
    if (!/^\s*\|/.test(lines[i])) break;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
    const row = cells(lines[i]);
    const obj = {};
    header.forEach((h, k) => { obj[h] = row[k] || ''; });
    out.push(obj);
  }
  return out;
}

/** 占位值不算内容（与门禁同一立场） */
function isReal(v) {
  const t = String(v == null ? '' : v).trim();
  if (!t) return false;
  if (/^[（(].*[）)]$/.test(t)) return false;
  if (/^[（(]/.test(t)) return false;
  if (t.includes('/') && /通过\s*\/\s*驳回/.test(t)) return false;
  return true;
}

const normPath = (p) => String(p || '').trim().replace(/\s+/g, '').replace(/\/+$/, '');

/**
 * 把契约规范化成 `{ endpoints: [{key, method, path, owner, surface}], consumers, assertions }`。
 * 同时接受 Markdown（CONTRACT.md）与 JSON（contract.json）—— JSON 是更稳的机器格式。
 */
export function normalizeContract(input) {
  if (input && typeof input === 'object') {
    const eps = (input.endpoints || []).map((e) => ({
      method: String(e.method || '').toUpperCase(),
      path: normPath(e.path),
      owner: e.owner || '',
      surface: Array.isArray(e.surface) ? e.surface.join('/') : (e.surface || ''),
    }));
    return {
      format: 'json',
      endpoints: eps.map((e) => ({ ...e, key: `${e.method} ${e.path}` })),
      consumers: (input.consumers || []).map((c) => ({ who: c.who || c.by || '', needs: c.needs || c.compat || '' })),
      assertions: (input.assertions || []).map((a) => ({ name: a.name || '', cmd: a.cmd || a.command || '' })),
      raw: input,
    };
  }
  const md = String(input || '');
  const own = tableRows(md, ['所有权', '端点']);
  const eps = own.map((r) => {
    const path = normPath(r['端点'] || r['路径'] || '');
    const method = String(r['方法'] || '').toUpperCase().trim();
    return { method, path, owner: r['owner'] || '', surface: r['surface'] || '', key: `${method} ${path}` };
  }).filter((e) => e.path && isReal(e.path));
  const consumers = tableRows(md, ['消费者']).map((r) => ({
    who: r['消费方'] || '', needs: r['需要的兼容'] || '',
  })).filter((c) => isReal(c.who));
  const assertions = tableRows(md, ['校验方式']).map((r) => ({ name: r['校验方式'] || '', cmd: r['命令'] || '' }))
    .filter((a) => isReal(a.cmd));
  return { format: 'markdown', endpoints: eps, consumers, assertions, raw: md };
}

/** 依据规则正典判定差异 */
export function diffContracts(baseline, current, rulesSpec) {
  const rules = Object.fromEntries((rulesSpec?.rules || []).map((r) => [r.id, r]));
  const findings = [];
  const add = (id, detail, extra = {}) => {
    const r = rules[id] || { id, severity: 'WARN', why: '', fix: '' };
    findings.push({ id, severity: r.severity, why: r.why, fix: r.fix, detail, ...extra });
  };

  const baseEps = baseline?.endpoints || [];
  const curEps = current?.endpoints || [];
  const curByPath = new Map();
  for (const e of curEps) {
    if (!curByPath.has(e.path)) curByPath.set(e.path, []);
    curByPath.get(e.path).push(e);
  }

  // ① 端点消失 / 方法消失
  for (const b of baseEps) {
    const same = curEps.filter((c) => c.path === b.path);
    if (!same.length) {
      add('endpoint-removed', `${b.method} ${b.path}`, { target: `${b.method} ${b.path}` });
      continue;
    }
    if (!same.some((c) => c.method === b.method)) {
      add('method-removed', `${b.method} ${b.path}（该路径仍存在，但少了 ${b.method}）`, { target: `${b.method} ${b.path}` });
    }
    const match = same.find((c) => c.method === b.method);
    if (!match) continue;
    // ② owner / surface 变化
    if (isReal(b.owner) && isReal(match.owner) && b.owner !== match.owner) {
      add('endpoint-owner-changed', `${b.method} ${b.path}：${b.owner} → ${match.owner}`, { target: `${b.method} ${b.path}` });
    }
    if (isReal(b.surface) && isReal(match.surface) && b.surface !== match.surface) {
      add('endpoint-surface-changed', `${b.method} ${b.path}：${b.surface} → ${match.surface}`, { target: `${b.method} ${b.path}` });
    }
  }

  // ③ 新增端点（INFO，不影响兼容）
  const baseKeys = new Set(baseEps.map((e) => e.key));
  for (const c of curEps) {
    if (!baseKeys.has(c.key)) add('endpoint-added', `${c.method} ${c.path}`, { target: `${c.method} ${c.path}` });
  }

  // ④ 结构性缺失：消费方没声明兼容 / 没有可运行断言
  const badConsumers = (current?.consumers || []).filter((c) => !isReal(c.needs));
  if (badConsumers.length) {
    add('consumer-compat-not-declared', `${badConsumers.map((c) => c.who).join('、')} 未声明需要的兼容方式`, {});
  }
  if (!(current?.assertions || []).length) {
    add('no-assertion-command', '「校验方式」表里没有可运行的断言命令', {});
  }
  return findings;
}

/** 人类可读报告 */
export function renderDiff({ itemId, baseline, current, findings }) {
  const L = [];
  const order = { BREAKING: 0, WARN: 1, INFO: 2 };
  const sorted = [...findings].sort((a, b) => (order[a.severity] ?? 9) - (order[b.severity] ?? 9));
  const count = (s) => findings.filter((f) => f.severity === s).length;
  L.push(`契约破坏性判定　${itemId}`);
  L.push(`  基线：${baseline ? `${(baseline.endpoints || []).length} 个端点` : '（无基线）'}`);
  L.push(`  当前：${(current.endpoints || []).length} 个端点`);
  L.push('');
  if (!findings.length) {
    L.push('  未发现差异。');
    return L.join('\n');
  }
  for (const f of sorted) {
    const mark = f.severity === 'BREAKING' ? '⛔ BREAKING' : f.severity === 'WARN' ? '⚠ WARN' : 'ℹ INFO';
    L.push(`  ${mark}  ${f.id}`);
    if (f.detail) L.push(`      ${f.detail}`);
    if (f.severity !== 'INFO' && f.why) L.push(`      为什么：${f.why}`);
    if (f.severity !== 'INFO' && f.fix) L.push(`      怎么办：${f.fix}`);
  }
  L.push('');
  L.push(`  合计：BREAKING ${count('BREAKING')} · WARN ${count('WARN')} · INFO ${count('INFO')}`);
  if (count('BREAKING')) {
    L.push('');
    L.push('  有 BREAKING 项 ⇒ 必须在「兼容策略」与「消费者」表里给出并行发版/多版本方案，');
    L.push('  否则既有消费方会中断。这不是工具能替你决定的事，但工具能保证它**不会被漏掉**。');
  }
  return L.join('\n');
}
