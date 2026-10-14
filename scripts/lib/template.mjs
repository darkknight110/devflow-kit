/**
 * 产物模板渲染。
 *
 * 单一事实源：templates/*.md。CLI 通过本模块渲染，因此"模板与引擎"不会各写一份。
 * 校验两条：① 模板里的每个令牌都被替换；② 允许出现的令牌是白名单内的（防止拼错后静默留空）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

export const TEMPLATE_FILES = {
  spec: 'SPEC.md',
  contract: 'CONTRACT.md',
  tasks: 'TASKS.md',
  codingReport: 'coding_report.md',
  verification: 'verification.md',
  approvals: 'APPROVALS.md',
  releaseReport: 'release-report.md',
  architecture: 'architecture.md',
};

export const TEMPLATE_TOKENS = ['TITLE', 'ITEM', 'TIER', 'TIER_NAME', 'OWNER', 'REPOS', 'SURFACE', 'DATE'];

export function templatesDir(kitRoot) {
  return path.join(kitRoot, 'templates');
}

/** 渲染一个模板；缺文件或含未知令牌时抛错（不静默） */
export function renderTemplate(kitRoot, kind, meta) {
  const file = TEMPLATE_FILES[kind];
  if (!file) throw new Error(`未知模板类型：${kind}`);
  const full = path.join(templatesDir(kitRoot), file);
  if (!existsSync(full)) throw new Error(`模板缺失：${full}（kit 安装不完整）`);
  const raw = readFileSync(full, 'utf8');
  const values = {
    TITLE: meta.title || meta.item,
    ITEM: meta.item,
    TIER: meta.tier,
    TIER_NAME: meta.tierName || meta.tier,
    OWNER: meta.owner || '(待填)',
    REPOS: (meta.repos || []).join('、') || '(本仓)',
    SURFACE: (meta.changeSurface || []).join('、') || 'internal',
    DATE: meta.createdAt || new Date().toISOString().slice(0, 10),
  };
  let out = raw;

  // 条件块：{{#TIER:light,standard}} … {{/TIER}}
  // 用**精确匹配**（tier 必须在列表里），避免"重档顺手包含轻档内容"的含糊。
  const tier = String(meta.tier || 'standard');
  out = out.replace(/\{\{#TIER:([a-z,\- ]+)\}\}([\s\S]*?)\{\{\/TIER\}\}/g, (_m, list, body) => {
    const allowed = String(list).split(',').map((x) => x.trim()).filter(Boolean);
    return allowed.includes(tier) ? body : '';
  });
  const badDirective = out.match(/\{\{[#/][A-Z]+/g);
  if (badDirective) throw new Error(`模板 ${file} 含未闭合或未知的条件指令：${[...new Set(badDirective)].join('、')}`);

  // 令牌替换
  for (const token of TEMPLATE_TOKENS) out = out.split(`{{${token}}}`).join(values[token]);
  const leftover = out.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) throw new Error(`模板 ${file} 含未替换令牌：${[...new Set(leftover)].join('、')}`);
  return out;
}

/** 体检模板集：文件齐全 + 令牌合法。返回发现列表。 */
export function auditTemplates(kitRoot) {
  const dir = templatesDir(kitRoot);
  const problems = [];
  if (!existsSync(dir)) return [`模板目录不存在：${dir}`];
  const present = new Set(readdirSync(dir));
  for (const [kind, file] of Object.entries(TEMPLATE_FILES)) {
    if (!present.has(file)) {
      problems.push(`模板 ${file}（${kind}）缺失`);
      continue;
    }
    const raw = readFileSync(path.join(dir, file), 'utf8');
    const used = [...new Set((raw.match(/\{\{([A-Z_]+)\}\}/g) || []).map((t) => t.slice(2, -2)))];
    for (const token of used) {
      if (!TEMPLATE_TOKENS.includes(token)) problems.push(`模板 ${file} 使用了未知令牌 {{${token}}}（渲染时会留空）`);
    }
    // 条件块配对检查
    const opens = (raw.match(/\{\{#TIER:/g) || []).length;
    const closes = (raw.match(/\{\{\/TIER\}\}/g) || []).length;
    if (opens !== closes) problems.push(`模板 ${file} 的条件块不配对：#TIER=${opens} / /TIER=${closes}`);
    const unknownDirectives = [...new Set((raw.match(/\{\{[#/]([A-Za-z]+)/g) || []).filter((d) => !/#TIER|\/TIER/.test(d)))];
    if (unknownDirectives.length) problems.push(`模板 ${file} 含未知条件指令：${unknownDirectives.join('、')}`);
    if (used.length === 0) problems.push(`模板 ${file} 不含任何令牌（可能忘了参数化）`);
  }
  return problems;
}
