/**
 * DSH 聊天技能的安装形态与**同步**判定。
 *
 * 为什么单独成模块（同一个事实只能有一个来源）：
 *   安装戳的插入规则原先在 `cli.mjs`（setup）与 `selfcheck.mjs`（SC52）各写了一份。
 *   自检里那份是**复刻**而不是调用真实实现 —— setup 一改，SC52 会继续绿。
 *   本仓库自己反对这种"同一事实两个来源"，所以收口到这里：
 *   setup 用 `addStamp` 生产，SC52/SC67 用同一份函数校验。
 *
 * 另一件事：技能装到 `<dsh home>/skills/devflow/SKILL.md` 是**实体文件**，不用软链 ——
 * 实装形态是"真实目录 + 真实文件"（旧注释记录：技能枚举是否跟随软链无法保证，
 * 而 md-to-office 这个能用的技能正是真实目录）。代价是 kit 里改了 SKILL.md，
 * 已装副本**不会自动更新**，会静默分叉 —— 而 agent 读的正是那份副本。
 * 因此提供 `syncInstalledSkill()`：任何一次 devflow 命令都会顺手把已有副本收敛回与源一致，
 * SC67 再把"分叉"钉成失败兜底。
 *
 * 安装戳的硬约束（实测踩到）：**必须放在 frontmatter 之后**。
 * SKILL.md 首行必须是 `---`，否则 DSH 解析不到 frontmatter，技能会从列表里消失。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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
  return `<!-- 由 ${STAMP_MARKER}（${iso}）；每次运行 devflow 命令会自动与 kit 收敛，无需手工重装 -->`;
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
 * ⚠️ **安装戳那一行刻意不参与比对**（只要它存在且位置正确即可）：
 *   戳里带日期，若把戳的文本也纳入比对，副本每天都会"过期"、每天触发一次重写，
 *   白白制造 mtime 变动与噪音。所以戳的文案改版**不会**让副本被判为过期 ——
 *   这是设计选择，不是漏判（真实误会过一次：戳文案改了，副本仍报"已是最新"）。
 *   代价：戳里的旧提示语可能长期残留在副本里。它只是出处标记，不影响功能。
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
    return { verdict: 'diverged', reason: '已安装副本与 kit 的 SKILL.md 不一致（下次运行 devflow 命令会自动收敛，也可立即执行 devflow skill sync）', normalizedMatches, stampPlacement };
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

  // 读盘必须 fail-closed 到**结果对象**里，绝不向外抛：
  // 本模块的契约是"调用方拿到 action 再决定怎么办"，一旦抛栈，
  // `devflow skill` 会崩在面向上帝的堆栈里（实测：SKILL.md 被造成目录 ⇒ EISDIR 直接抛穿）。
  // 读失败一律当"形态非法"：既不谎报一致，也还能被 sync 重写自愈。
  let sourceText = '';
  try {
    if (sourceExists) sourceText = readFileSync(sourcePath, 'utf8');
  } catch (e) {
    return {
      verdict: 'malformed', reason: `读不到 kit 源技能（${e.code || e.message}）：${sourcePath}`,
      normalizedMatches: false, stampPlacement: false,
      sourcePath, installedPath, sourceExists, installedExists, dshHome,
    };
  }

  let installedText = '';
  let readProblem = '';
  try {
    if (installedExists) installedText = readFileSync(installedPath, 'utf8');
  } catch (e) {
    readProblem = `已安装副本读不出来（${e.code || e.message}）`;
  }

  const r = readProblem
    ? { verdict: 'malformed', reason: readProblem, normalizedMatches: false, stampPlacement: false }
    : compareSkill({ sourceText, installedText, installedExists });
  return { ...r, sourcePath, installedPath, sourceExists, installedExists, dshHome };
}

/**
 * 把**已存在**的安装副本收敛回与源一致。返回结果而不是打印，便于调用方决定怎么提示。
 *
 * 边界（刻意为之，避免自作主张）：
 *   · 副本**不存在** ⇒ `missing` 且**不安装** —— 装不装由用户决定（`devflow setup`），
 *     一次普通命令不该往用户 home 里塞东西；调用方应把它当"不适用"，不是失败。
 *   · 源文件缺失 ⇒ `source-missing`，不动副本（kit 安装不完整时不能反手清掉用户已有的技能）。
 *   · 内容已一致（含只有日期不同的戳）⇒ `ok` 且**不写盘** —— 不制造无意义 mtime 变动。
 *   · `--check` / dryRun ⇒ 只报告 `stale`，不写。
 *   · 写入失败（只读 home、沙箱拦截）⇒ `write-failed` 并带原因；**绝不抛错**
 *     —— 一个"顺手同步"的动作不能把用户本来要跑的命令搞崩。
 *
 * @param {string} sourcePath kit 里的 skill/SKILL.md
 * @param {{dshHome?:string, dryRun?:boolean, now?:Date}} [opts]
 * @returns {{action:'ok'|'stale'|'missing'|'source-missing'|'write-failed', reason:string, installedPath:string, verdict?:string}}
 */
export function syncInstalledSkill(sourcePath, opts = {}) {
  const info = compareInstalledSkill(sourcePath, opts);
  const base = { installedPath: info.installedPath, verdict: info.verdict };

  if (!info.installedExists) {
    return { ...base, action: 'missing', reason: `未安装聊天技能（${info.installedPath} 不存在）` };
  }
  if (!info.sourceExists) {
    return { ...base, action: 'source-missing', reason: `kit 安装不完整：缺少 ${sourcePath}` };
  }
  if (info.verdict === 'ok') return { ...base, action: 'ok', reason: '' };
  if (opts.dryRun) {
    return { ...base, action: 'stale', reason: info.reason || '已安装副本与源不一致' };
  }

  try {
    // 形态非法（例如缺安装戳）也要能自愈：重写一份带戳的合法副本。
    const body = addStamp(readFileSync(sourcePath, 'utf8'), opts.now);
    const problem = installedBodyProblem(body);
    if (problem) return { ...base, action: 'write-failed', reason: `拒绝写入非法形态：${problem}` };
    mkdirSync(path.dirname(info.installedPath), { recursive: true });
    writeFileSync(info.installedPath, body, 'utf8');
    return { ...base, action: 'stale', reason: info.reason || '已安装副本与源不一致' };
  } catch (e) {
    return { ...base, action: 'write-failed', reason: e.message };
  }
}
