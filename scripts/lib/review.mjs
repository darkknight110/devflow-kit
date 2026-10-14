/**
 * 人工确认点（AP1/AP2/AP3）的**决策包**与**签核**。
 *
 * 为什么需要这个模块（产品初衷的直接落点）：
 *   门禁已经在**验签**（要求真实姓名/时间/结论），但**没有任何东西帮人做决策** ——
 *   人只能自己翻 SPEC/TASKS/verification/契约，判断"我该不该签"。
 *   结果是两种坏情况：① 草率签核（闸门形同虚设）；② 因为麻烦而拖延（效率变差）。
 *   本模块把材料**摊开**、把**判断标准**说清、把**决定记下来**，并对"能不能签"给出硬结论。
 *
 * 铁律：**agent 不得代填结论**。记录结论必须显式给出 --by（真人）与 --verdict。
 */

import { isRealValue } from './checks.mjs';

/** 编辑距离宽松匹配：容忍"发布批准"与"AP3 发布批准"这类写法差异 */
function samePoint(a, b) {
  return String(a).includes(String(b)) || String(b).includes(String(a));
}

/**
 * 判定某个确认点**是否具备签核条件**。
 * 返回 { point, name, canSign, blockers, evidence, criteria }
 *   canSign=false 时，blockers 说明"缺什么" —— 这不是限制人签字，而是**不许在材料不全时签**。
 */
export function reviewPack({ itemId, tier, point, spec, tasks, verification, contract, approvals, gateResult }) {
  const has = (s) => Boolean(s && s.trim());
  // 只认真实填写过的记录：模板里的「（姓名）/ 通过 / 驳回」是占位，不算已签核。
  // 口径必须与门禁一致（共用 isRealValue），否则会出现"门禁说没签、这里说签了"。
  const recorded = (approvals || []).find((a) => samePoint(a.point, point)
    && isRealValue(a.who) && isRealValue(a.at) && isRealValue(a.verdict));
  const base = { point, recorded: recorded || null };

  if (point === '需求与判据') {
    const acs = spec?.acceptanceCriteria || [];
    // parseAcceptanceCriteria 返回 { id, judgement, judgementType, owner } —— 用 id（曾错用 ac，导致 AC 显示 undefined）
    const noJudgement = acs.filter((a) => !isRealValue(a.judgement) || !has(a.judgementType));
    const pendingClarify = spec?.clarifyPending || [];
    const untraced = (tasks || []).filter((t) => !has(t.ac));
    const blockers = [];
    if (!acs.length) blockers.push('SPEC 里没有「验收标准」表 —— 没有判据就无法批准需求');
    if (noJudgement.length) blockers.push(`${noJudgement.length} 条验收标准缺判据或判据类型（${noJudgement.map((a) => a.id).join('、')}）`);
    if (pendingClarify.length) blockers.push(`仍有 ${pendingClarify.length} 项澄清未决（${pendingClarify.map((q) => q.id || q).join('、')}）`);
    if (untraced.length) blockers.push(`${untraced.length} 条任务未对应 AC（追溯链断环：${untraced.map((t) => t.t).join('、')}）`);
    return {
      ...base,
      name: '需求与判据',
      question: '这份需求要解决的问题说清楚了吗？每条验收标准**都能被验证**吗？',
      criteria: [
        '每条 AC 都有**可执行的判据**（命令 / 画面 / 报告卡），不接受"体验良好"这类无法判定的说法',
        '**明确的边界**：包含什么、不包含什么',
        '**异常流**：失败/为空/超时/无权限时，用户看到什么',
        '**未决项**已显式登记（而不是被含糊过去）',
      ],
      evidence: {
        验收标准数: acs.length,
        逐条:

          acs.map((a) => ({ AC: a.id, 判据: String(a.judgement || '（缺）').slice(0, 46), 类型: a.judgementType || '（缺）', 责任: a.owner || '-' })),
        未决澄清: pendingClarify.length,
      },
      blockers,
      canSign: blockers.length === 0,
    };
  }

  if (point === '契约冻结') {
    const eps = contract?.endpoints || [];
    const blockers = [];
    if (!has(contract?.raw)) blockers.push('没有 CONTRACT.md —— 涉及跨边界变更却未冻结契约');
    if (has(contract?.raw) && !eps.length) blockers.push('CONTRACT.md 里没有解析到端点/字段定义');
    return {
      ...base,
      name: '契约冻结',
      question: '这份契约**双方认同**吗？改了它，谁需要跟着改？',
      criteria: [
        '端点的**请求/响应字段**完整，且与后端实现一致',
        '**兼容性**：老版本调用方是否受影响（是否要灰度/版本号）',
        '**由谁改**：契约变了，前后端各自的任务是否已列进 TASKS',
      ],
      evidence: { 端点数: eps.length, 契约摘要: eps.slice(0, 12).map((e) => `${e.method || ''} ${e.path || ''}`.trim()) },
      blockers,
      canSign: blockers.length === 0,
    };
  }

  if (point === '发布批准') {
    const unverified = (verification?.unverified || []).filter((u) => isRealValue(u.ac));
    const covered = verification?.items || [];
    const blockers = [];
    if (!has(verification?.raw)) blockers.push('没有 verification.md —— 没有验证记录就不能批准发布');
    // 有文件但**没有真实结论**同样是"没验证"（模板占位不算）。曾漏掉这条 ⇒ 空记录也能签核（实测踩到）。
    if (has(verification?.raw) && !covered.length) {
      blockers.push('verification.md 里没有**真实的**逐条结论（模板占位不算）—— 没有验证证据就不能批准发布');
    }
    if (unverified.length) blockers.push(`仍有 ${unverified.length} 项未验证（${unverified.map((u) => u.ac || u).join('、')}）`);
    if (covered.length) {
      const acs = spec?.acceptanceCriteria || [];
      const missed = acs.map((a) => a.id).filter((id) => !covered.some((v) => String(v.ac).includes(String(id))));
      if (missed.length) blockers.push(`验证记录未覆盖全部验收标准，缺：${missed.join('、')}`);
    }
    if (gateResult && !gateResult.ok) blockers.push(`门禁未通过：${(gateResult.errors || []).slice(0, 3).join('；')}`);
    return {
      ...base,
      name: '发布批准',
      question: '每条验收标准**都有证据**吗？发布后怎么发现出问题、怎么回退？',
      criteria: [
        '每条 AC 都有**证据**（命令 + 原始输出 + 退出码，或画面截图），不接受"已通过"三个字',
        '**未验证项**已显式登记并说明原因（未验证 ≠ 可以）',
        '**观察窗口**：看什么指标、看多久、什么情况算失败',
        '**回退方案**存在且可行',
      ],
      evidence: {
        验证条目: covered.length,
        逐条: covered.map((v) => ({ AC: v.ac, 结论: v.conclusion || '-', 证据: String(v.evidence || '').slice(0, 60) })),
        未验证项: unverified.length,
      },
      blockers,
      canSign: blockers.length === 0,
    };
  }

  return { ...base, name: String(point), question: '（未定义的确认点）', criteria: [], evidence: {}, blockers: [`未知的确认点：${point}`], canSign: false };
}

/** 人类可读的决策包文本 */
export function renderPack(pack, itemId) {
  const L = [];
  const st = staleInfo(pack.recorded, pack.currentFingerprint);
  const recLine = !pack.recorded ? '　（尚未记录）'
    : st.stale ? `　⏸ **签字已失效**（记录：${pack.recorded.who} / ${pack.recorded.verdict}）`
      : `　（已记录：${pack.recorded.who} / ${pack.recorded.verdict}）`;
  L.push(`确认点：${pack.name}${recLine}`);
  if (st.stale) {
    L.push('');
    L.push(`⏸ **失效原因**：${st.reason}`);
    L.push('  意味着：有人签字之后，这份材料被改动了 —— 因此**当时的批准不再适用于现在的内容**。');
    L.push('  需要重新确认。若改动无关紧要（例如仅格式调整），由确认人重新签核即可。');
  } else if (pack.recorded && st.reason) {
    L.push('');
    L.push(`  ℹ ${st.reason}`);
  }
  L.push('');
  L.push(`要判断的问题：${pack.question}`);
  L.push('');
  L.push('判断标准：');
  for (const c of pack.criteria) L.push(`  · ${c}`);
  L.push('');
  L.push('材料（你有权看到全部原文）：');
  const ev = pack.evidence || {};
  for (const [k, v] of Object.entries(ev)) {
    if (Array.isArray(v)) {
      L.push(`  ${k}：`);
      if (!v.length) L.push('    （空）');
      for (const row of v.slice(0, 12)) {
        L.push(`    ${Object.entries(row).map(([a, b]) => `${a}=${b}`).join('  ')}`);
      }
      if (v.length > 12) L.push(`    …（共 ${v.length} 条）`);
    } else {
      L.push(`  ${k}：${v}`);
    }
  }
  L.push('');
  if (st.stale && pack.canSign) {
    L.push('结论建议：内容已变，**原签字失效** —— 需由确认人重新签核（材料本身是齐备的）。');
    L.push(`重新签核：devflow review ${itemId} --point ${pack.point} --by <真人姓名> --verdict 通过|驳回 --note "<重新确认的理由>"`);
    return L.join('\n');
  }
  if (pack.canSign) {
    L.push('结论建议：材料齐备，可以签核。');
    L.push(`记录：devflow review ${itemId} --point ${pack.point} --by <真人姓名> --verdict 通过|驳回 [--note <理由>]`);
  } else {
    L.push('结论建议：**暂不可签核** —— 以下项必须先补齐：');
    for (const b of pack.blockers) L.push(`  ⛔ ${b}`);
    L.push('');
    L.push('（这不是限制你签字，而是防止在材料不全的情况下"走个形式"—— 那会让确认点失去意义。）');
  }
  return L.join('\n');
}

// ── 内容指纹：让"签字"绑定"签的是什么" ─────────────────────
//
// 为什么必须有：实测确认 —— 签字后**改掉已批准的验收标准**，APPROVALS.md 仍显示
// 「✓ 已记录」，门禁也照样通过。**签完就万事大吉等于闸门形同虚设。**
// 做法（借鉴 doorstop 的 `reviewed` 指纹）：把该确认点所批准的**材料内容**取哈希，
// 签名时一并记录；之后每次复算比对，不一致即判定该签字**已失效**。

import { createHash } from 'node:crypto';

/** 取材料指纹（前 12 位十六进制，足够区分且便于人工核对） */
export function fingerprint(text) {
  return createHash('sha256').update(String(text || ''), 'utf8').digest('hex').slice(0, 12);
}

/** 提取 SPEC 的「验收标准」整节原文（AP1 批准的就是它） */
export function specDigest(SPEC) {
  const m = /##\s*验收标准[\s\S]*?(?=\n##\s|\n*$)/.exec(String(SPEC || ''));
  return m ? m[0] : '';
}

/**
 * 计算某确认点**当前**应绑定的指纹。
 * 返回 null 表示"该确认点没有可绑定的材料"（此时不做失效判定，避免误伤）。
 */
export function currentFingerprint({ point, spec, contract, verification }) {
  const fp = (t) => (t && String(t).trim() ? fingerprint(t) : null);
  if (point === '需求与判据') return fp(specDigest(spec));
  if (point === '契约冻结') return fp(contract);
  if (point === '发布批准') return fp(verification);
  return null;
}

/** 判定一条已记录签字是否因内容变化而失效 */
export function staleInfo(recorded, current) {
  if (!recorded || !current) return { stale: false, reason: null };
  const was = String(recorded.fingerprint || '').trim();
  if (!was) return { stale: false, reason: '未记录指纹（旧格式签字，无法判定是否失效）' };
  if (was !== current) return { stale: true, reason: `签字时的内容指纹 ${was} ≠ 当前 ${current}（材料已被修改）` };
  return { stale: false, reason: null };
}
