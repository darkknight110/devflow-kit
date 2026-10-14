#!/usr/bin/env node
/**
 * 提交信息规范校验（可作为 git commit-msg 钩子使用）。
 *
 * 为什么需要它：提交信息是**给人快速定位改动**用的，不是变更日志、更不是复盘文档。
 * 一旦允许写长文，就会出现"标题 50 字以内、正文 40 行"的提交 ——
 * 阅读成本高、diff 里几乎无人看、还会与代码注释/报告重复。规则必须可机器校验，否则形同虚设。
 *
 * 规则（简洁版）：
 *   1. 第一行：`<type>(<scope>): <subject>`，type ∈ feat|fix|test|refactor|perf|docs|chore|build|ci|revert
 *   2. 标题 ≤ 72 字符，不以句号结尾，不含换行
 *   3. 标题与正文之间空行
 *   4. 正文：最多 3 条要点；每条 ≤ 100 字符；**不允许空行分段**（禁止讲故事）
 *   5. 总行数 ≤ 8
 *   6. 不要求写"验证：…"这类过程叙述（由报告/门禁记录承担）
 *
 * 用法：
 *   node tools/validate-commit-msg.mjs <提交信息文件>
 *   node tools/validate-commit-msg.mjs --text "fix(a): b"
 *   安装为钩子：cp tools/validate-commit-msg.mjs .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const TYPES = ['feat', 'fix', 'test', 'refactor', 'perf', 'docs', 'chore', 'build', 'ci', 'revert'];
export const MAX_SUBJECT = 72;
export const MAX_BULLET = 100;
export const MAX_BULLETS = 3;
export const MAX_LINES = 8;

/**
 * 校验提交信息。返回错误数组（空数组 = 通过）。
 * 纯函数，便于自检直接调用。
 */
export function validateCommitMessage(message) {
  const errors = [];
  const text = String(message || '').replace(/\r\n/g, '\n').trim();
  if (!text) return ['提交信息为空'];

  const lines = text.split('\n');
  const subject = lines[0];

  // 1) 标题格式
  const m = subject.match(/^([a-z]+)(?:\(([^)]*)\))?!?:\s*(.+)$/);
  if (!m) {
    errors.push(`标题须为 "<type>(<scope>): <摘要>" 形式，当前：${subject.slice(0, 60)}`);
  } else {
    const [, type, scope, desc] = m;
    if (!TYPES.includes(type)) errors.push(`type "${type}" 不在允许集合：${TYPES.join('|')}`);
    if (!scope) errors.push('缺少 scope（如 fix(mp):、test(contract):）');
    if (!desc || !desc.trim()) errors.push('缺少摘要');
  }
  if (subject.length > MAX_SUBJECT) errors.push(`标题 ${subject.length} 字符，超过上限 ${MAX_SUBJECT}`);
  if (/[。.]$/.test(subject)) errors.push('标题不应以句号结尾');
  if (lines.length > 1 && lines[1].trim() !== '') errors.push('标题与正文之间必须空一行');

  // 2) 正文：最多 MAX_BULLETS 条要点，且不许空行分段
  const body = lines.slice(1).map((l) => l.replace(/\s+$/, '')).filter((l, i) => !(i === 0 && l === ''));
  const blankInside = body.some((l) => l.trim() === '');
  if (blankInside) {
    errors.push('正文不允许空行分段（提交信息只做概括，不写故事线；细节请放进报告或 PR 描述）');
  }
  const bullets = body.filter((l) => /^\s*[-*]\s+/.test(l));
  const nonBullets = body.filter((l) => l.trim() && !/^\s*[-*]\s+/.test(l));
  if (nonBullets.length) errors.push(`正文须全部为 "- " 开头的要点，发现 ${nonBullets.length} 行非要点`);
  if (bullets.length > MAX_BULLETS) errors.push(`正文要点 ${bullets.length} 条，超过上限 ${MAX_BULLETS}`);
  for (const b of bullets) {
    if (b.trim().length > MAX_BULLET) errors.push(`要点过长（${b.trim().length} > ${MAX_BULLET}）：${b.trim().slice(0, 40)}…`);
  }

  // 3) 总行数
  if (lines.length > MAX_LINES) errors.push(`总行数 ${lines.length} 超过上限 ${MAX_LINES}`);

  return errors;
}

function main() {
  const args = process.argv.slice(2);
  let message = '';
  const textIdx = args.indexOf('--text');
  if (textIdx >= 0) {
    message = args[textIdx + 1] || '';
  } else if (args[0]) {
    try {
      message = readFileSync(args[0], 'utf8');
    } catch (e) {
      process.stderr.write(`无法读取提交信息文件：${args[0]}\n`);
      process.exitCode = 2;
      return;
    }
  } else {
    process.stderr.write('用法：validate-commit-msg.mjs <提交信息文件> | --text "<信息>"\n');
    process.exitCode = 2;
    return;
  }

  const errors = validateCommitMessage(message);
  if (errors.length) {
    process.stderr.write('提交信息不符合规范：\n');
    for (const e of errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write('\n规范：<type>(<scope>): <摘要>（≤72 字）\\n  - 正文最多 3 条要点，每条 ≤100 字\\n  - 不允许空行分段、不要写过程叙述\\n');
    process.exitCode = 1;
    return;
  }
  process.stdout.write('提交信息符合规范\n');
}

// 入口守卫必须比较**真实路径**：
// 作为 git 钩子时本文件常以**符号链接**被执行（.git/hooks/commit-msg -> 本文件），
// 此时 import.meta.url（真实路径）与 argv[1]（符号链接路径）不相等，
// 旧写法会让 main() 永不执行、钩子**静默返回 0**（即钩子形同不存在 —— 真实踩到过）。
const invokedDirectly = (() => {
  try {
    // 必须用 fileURLToPath 解码（路径可能含空格/中文，如 ".../DeepSeek Harness.app/..."）：
    // new URL(...).pathname 会保留 %20，realpathSync 因此失败 ⇒ main() 不执行 ⇒ 钩子静默返回 0。
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) main();
