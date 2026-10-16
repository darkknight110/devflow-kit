/**
 * DSH 聊天技能的安装形态与**同步**判定。
 *
 * 为什么单独成模块（同一个事实只能有一个来源）：
 *   安装戳的插入规则原先在 `cli.mjs`（setup）与 `selfcheck.mjs`（SC52）各写了一份。
 *   自检里那份是**复刻**而不是调用真实实现 —— setup 一改，SC52 会继续绿。
 *   本仓库自己反对这种"同一事实两个来源"，所以收口到这里：
 *   setup 用 `addStamp` 生产，SC52/SC67 用同一份函数校验。
 *
 * 另一件事：技能装到 `<dsh home>/skills/devflow/SKILL.md` 是**实体文件**（不是软链，
 * 因为技能枚举是否跟随软链无法保证）。所以 kit 里改了 SKILL.md，已装的副本**不会自动更新**；
 * 不比对就会静默分叉 —— 而 agent 读的正是那份副本。SC67 就是为了让这个分叉可见。
 *
 * 安装戳的硬约束（实测踩到）：**必须放在 frontmatter 之后**。
 * SKILL.md 首行必须是 `---`，否则 DSH 解析不到 frontmatter，技能会从列表里消失。
 */
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 标记：能证明"内容来自 kit"的戳；不含日期，便于比对时统一剥离。 */
export const STAMP_MARKER = 'devflow setup 安装';

/**
 * 生成安装戳（含当天日期）。
 * @param {Date} [now] 便于测试注入固定时间
 * @returns {string}
 */
export function stampFor(now = new Date()) {
  const d = new Date(now);
  const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  return `<!-- 由 ${STAMP_MARKER}（${iso}）；kit 升级后请重跑 devflow setup --global 以刷新 -->`;
}

/** 安装戳是否出现在 **frontmatter 之后**（放开头会破坏 frontmatter）。 */
export function stampPlacementOk(raw) {
  const lines = String(raw || '').split('\n');
  if (lines[0] !== '---') return false;
  const end = lines.indexOf('---', 1);
  if (end < 0) return false;
  return lines.slice(end + 1).some((l) => l.includes(STAMP_MARKER));
}

/**
 * 给 SKILL.md 正文加上安装戳（插在 frontmatter 之后）。**生产用函数，不是校验用复刻。**
 *
 * 源文件没有 frontmatter 时**显式抛错**，不静默把戳塞到首行 ——
 * 那样产出的技能首行不是 `---`，DSH 解析不到 frontmatter，技能会从列表里消失；
 * 静默产出一个"装了但看不见"的产物，正是本产品要拦的那类故障。
 * @param {string} body 源 SKILL.md 全文
 * @param {Date} [now]
 * @returns {string}
 */
export function addStamp(body, now = new Date()) {
  const src = String(body ?? '');
  const stamp = stampFor(now);
  const fmEnd = src.indexOf('\n---', 4);   // 跳过开头的 ---
  if (fmEnd < 0) {
    throw new Error('SKILL.md 缺少 frontmatter（首行必须是 ---，且要有结束的 ---）；拒绝生成会从技能列表消失的副本');
  }
  const nl = src.indexOf('\n', fmEnd + 1);
  return nl >= 0 ? `${src.slice(0, nl + 1)}${stamp}\n${src.slice(nl + 1)}` : `${src}\n${stamp}\n`;
}

/** 剥掉安装戳那一行（按标记识别，与日期无关；但只在 frontmatter 之后剥）。 */
export function stripStamp(raw) {
  const lines = String(raw ?? '').split('\n');
  if (lines[0] !== '---') return { body: lines.join('\n'), removed: false };
  const end = lines.indexOf('---', 1);
  if (end < 0) return { body: lines.join('\n'), removed: false };
  for (let i = end + 1; i < lines.length; i += 1) {
    if (lines[i].includes(STAMP_MARKER)) {
      return { body: [...lines.slice(0, i), ...lines.slice(i + 1)].join('\n'), removed: true };
    }
  }
  return { body: lines.join('\n'), removed: false };
}

/**
 * DSH 侧解析技能所需的最小形态（从 SC52 抽出，供 SC52/SC67 共用）。
 * @returns {string} 空串 = 没问题；否则是问题描述
 */
export function installedBodyProblem(raw) {
  const lines = String(raw ?? '').split('\n');
  if (lines[0] !== '---') return `首行不是 frontmatter 起点：${JSON.stringify(lines[0])}`;
  const end = lines.indexOf('---', 1);
  if (end < 0) return 'frontmatter 没有结束的 ---';
  if (!lines.slice(1, end).some((l) => /^name:\s*\S/.test(l))) return 'frontmatter 缺 name';
  return '';
}

/**
 * 比对"源技能"与"已安装副本"。**纯函数**（不碰文件系统，故可被自检直接喂夹具）。
 *
 * @param {{sourceText:string, installedText:string, installedExists:boolean}} input
 * @returns {{verdict:'missing'|'ok'|'diverged'|'malformed', reason:string,
 *            normalizedMatches:boolean, stampPlacement:boolean}}
 */
export function compareSkill({ sourceText = '', installedText = '', installedExists = true } = {}) {
  if (!installedExists) {
    return { verdict: 'missing', reason: '', normalizedMatches: false, stampPlacement: false };
  }
  const malformed = installedBodyProblem(installedText);
  if (malformed) {
    return { verdict: 'malformed', reason: malformed, normalizedMatches: false, stampPlacement: false };
  }
  const { body, removed } = stripStamp(installedText);
  if (!removed) {
    return { verdict: 'malformed', reason: '已安装副本缺少安装戳（无法证明它来自本 kit）', normalizedMatches: false, stampPlacement: false };
  }
  const stampPlacement = stampPlacementOk(installedText);
  const norm = (s) => String(s ?? '').replace(/\s+$/, '') + '\n';
  const normalizedMatches = norm(body) === norm(sourceText);
  if (!normalizedMatches) {
    return { verdict: 'diverged', reason: '已安装副本与 kit 的 SKILL.md 不一致（源改了但没重跑 setup）', normalizedMatches, stampPlacement };
  }
  return { verdict: 'ok', reason: '', normalizedMatches, stampPlacement };
}

/**
 * 比对**真实文件系统**上的源技能与已安装副本。
 * 已安装副本不存在 ⇒ 返回 `missing`（调用方按"不适用"处理，不能当失败：
 * 全新 clone 或 CI 上本来就没装过，那不是回归）。
 *
 * @param {string} sourcePath kit 里的 skill/SKILL.md
 * @param {{dshHome?:string}} [opts] dshHome 缺省时按 setup 的同一规则解析
 */
export function compareInstalledSkill(sourcePath, opts = {}) {
  const dshHome = opts.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const installedPath = path.join(dshHome, 'skills', 'devflow', 'SKILL.md');
  const sourceExists = existsSync(sourcePath);
  const installedExists = existsSync(installedPath);
  const sourceText = sourceExists ? readFileSync(sourcePath, 'utf8') : '';
  const installedText = installedExists ? readFileSync(installedPath, 'utf8') : '';
  const r = compareSkill({ sourceText, installedText, installedExists });
  return { ...r, sourcePath, installedPath, sourceExists, installedExists, dshHome };
}
