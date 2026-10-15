/**
 * 人话层：把引擎内部事件翻译成人能直接读懂的一句话。
 *
 * 为什么单独成模块：CLI（`devflow history`）与看板（时间线）**必须用同一套说法**。
 * 两处各写一份的话，同一次事件在两个界面上会有两种描述 —— 那比"措辞不统一"更糟：
 * 用户会以为它们说的不是同一件事。
 *
 * 用词原则（踩过的坑）：
 *   - **不要用内部比喻**：`门禁` 是我们借来的词（gate），用户需要解码它。
 *     面向人的说法是「检查」。
 *   - **不要把 JSON 摊给用户**：`{"total":4,"pass":2}` 对人是噪音。
 *   - **不要用英文状态名**：`draft`/`released` 要写「草稿」「已发布」。
 *   - **不要显示内部执行者**：`orchestrator` 不是人，不该出现在"谁做的"位置上。
 *   - 未知事件也必须给出可读说法，**绝不回落到原始对象**。
 */

/** 状态名中文化（对外一律用这套） */
export const STATE_ZH = {
  draft: '草稿',
  spec_ready: '判据就绪',
  contracted: '契约已冻结',
  implementing: '开发中',
  tested: '已提测',
  verified: '已验证',
  released: '已发布',
};

export const stateZh = (s) => STATE_ZH[s] || (s || '（未知状态）');

/** 门禁结论 → 人话。verdict 是对象时绝不可直接打印 */
export function gateSentence(v) {
  if (!v || typeof v !== 'object') return '跑了检查';
  const total = Number(v.total || 0);
  const fail = Number(v.fail || 0);
  const unv = Number(v.unverified || 0);
  if (!total) return '跑了检查';
  const bad = fail + unv;
  if (!bad) return `跑了检查：${total} 项全部通过`;
  return `跑了检查：${total} 项，${bad} 项没过${v.blocking ? '（已阻断推进）' : ''}`;
}

/**
 * 事件 → 一句人话。
 * @param {object} e 事件（STATUS.json 的 history 条目）
 */
export function humanEvent(e) {
  if (!e) return '（无描述）';
  if (e.event === 'task.update') {
    const what = (e.changes || []).join('；') || '状态变化';
    return `任务 ${e.task || ''} 更新：${what}`;
  }
  if (e.event === 'clarify') {
    return `需求澄清：${e.qid || e.task || ''} 已记录${e.state ? `（${e.state}）` : ''}`;
  }
  if (e.event === 'gate-run') return gateSentence(e.verdict);
  if (e.event === 'created') {
    return `建了变更${e.tier ? `（${e.tier} 档）` : ''}${e.owner ? `，负责人 ${e.owner}` : ''}`;
  }
  // 人工确认点：point + verdict 是最有信息量的组合
  if (e.point) {
    const ok = /通过/.test(String(e.verdict || ''));
    return `${e.by || '有人'} ${ok ? '批准了' : '驳回了'}「${e.point}」${e.note ? `：${e.note}` : ''}`;
  }
  if (e.from || e.to) {
    const who = e.by && e.by !== 'orchestrator' && e.by !== e.actor ? `（${e.by}）` : '';
    return `推进：${stateZh(e.from)} → ${stateZh(e.to)}${e.forced ? '（强制）' : ''}${who}`;
  }
  // 兜底：只给事件名，绝不打印对象
  return e.event ? `（${e.event}）` : '（无描述）';
}
