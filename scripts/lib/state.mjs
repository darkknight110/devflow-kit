/**
 * 状态机：读取、推进、记录。
 *
 * 铁律：
 *   - 状态必须全量枚举；未知状态报错退出，禁止默认放行；
 *   - 推进必须经过门禁；--force 是逃生舱，但必须留下"绕过门禁"的留痕。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { evaluateGates, readTier, summarize } from './gate.mjs';
import { dirSizeKb } from './checks.mjs';
import { gitFacts, kitVersion } from './manifest.mjs';

export const STATE_FILE = 'STATE';
export const STATUS_FILE = 'STATUS.json';

export function itemsDir(projectRoot) {
  return path.join(projectRoot, '.devflow', 'items');
}

/**
 * 机器状态目录（③类产物：STATE / STATUS.json）。
 *
 * 存储正典 spec/storage.json 规则 STO-1：③类**不得**写入 items/ ——
 * 它们每次运行都变，入库只会产生无意义冲突。因此单独放在 `.devflow/.local/`（整体 gitignore）。
 */
export function localItemsDir(projectRoot) {
  return path.join(projectRoot, '.devflow', '.local', 'items');
}

/**
 * 解析某变更的**机器状态目录**，兼容两种布局：
 *   新布局：`.devflow/.local/items/<item>/`（有 STATE 或 STATUS.json）
 *   旧布局：`.devflow/items/<item>/`（迁移前）
 * 返回 null 表示两处都没有。
 */
export function machineDir(projectRoot, itemId) {
  const local = path.join(localItemsDir(projectRoot), itemId);
  for (const f of [STATE_FILE, STATUS_FILE]) {
    if (existsSync(path.join(local, f))) return local;
  }
  const legacy = path.join(itemsDir(projectRoot), itemId);
  for (const f of [STATE_FILE, STATUS_FILE]) {
    if (existsSync(path.join(legacy, f))) return legacy;
  }
  return existsSync(local) ? local : null;
}

/**
 * 列出所有变更（不含 .local）。合并两处目录，新布局优先。
 */
export function allItemIds(projectRoot) {
  const out = new Set();
  for (const dir of [localItemsDir(projectRoot), itemsDir(projectRoot)]) {
    try {
      for (const n of readdirSync(dir)) {
        if (!n.startsWith('.') && statSync(path.join(dir, n)).isDirectory()) out.add(n);
      }
    } catch { /* 目录不存在 */ }
  }
  return [...out].sort();
}

/** 只读原始状态（不校验） */
export function rawState(itemDir) {
  const file = path.join(itemDir, STATE_FILE);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
}

/** 读取原始状态，遇到未知状态抛错（G5 的硬约束） */
export function readState(itemDir, states) {
  const state = rawState(itemDir);
  if (state === null) {
    const e = new Error(`缺少状态文件：${path.join(itemDir, STATE_FILE)}`);
    e.code = 'ENOSTATE';
    throw e;
  }
  if (!states.states[state]) {
    const e = new Error(`未知状态：${state}。状态定义必须全量枚举，禁止默认放行`);
    e.code = 'EUNKNOWNSTATE';
    throw e;
  }
  return state;
}

/** 写入原始状态（内部使用；对外必须走 advance 或 forceWrite） */
function writeRawState(itemDir, state) {
  writeFileSync(path.join(itemDir, STATE_FILE), `${state}\n`, 'utf8');
}

export function readStatus(itemDir) {
  const file = path.join(itemDir, STATUS_FILE);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeStatus(itemDir, status) {
  writeFileSync(path.join(itemDir, STATUS_FILE), `${JSON.stringify(status, null, 2)}\n`, 'utf8');
}

/**
 * 评估一个变更的完整状态（供 status / gate 使用）。
 */
export function evaluateItem({ projectRoot, itemId, kitSpec, config, cwd, stateOverride }) {
  const itemDir = machineDir(projectRoot, itemId) || path.join(itemsDir(projectRoot), itemId);
  if (!existsSync(itemDir)) {
    return { ok: false, code: 'NO_ITEM', itemId, itemDir, errors: [`变更目录不存在：${itemDir}`] };
  }
  let state;
  try {
    state = readState(itemDir, kitSpec.states);
  } catch (error) {
    return { ok: false, code: error.code || 'EBADSTATE', itemId, itemDir, errors: [error.message] };
  }
  const actualState = state;
  // stateOverride：用于「按目标状态判定门禁」——推进时必须校验的是目标状态，而不是当前状态。
  // 否则 draft 状态万事无要求，缺件也能被推进，门禁形同虚设。
  if (stateOverride) state = stateOverride;
  const gates = evaluateGates({ projectRoot, itemId, itemDir, state, actualState, kitSpec, config, cwd });
  const summary = summarize(gates);
  const tier = readTier(itemDir, kitSpec.states);
  const size = dirSizeKb(itemDir);
  const status = readStatus(itemDir);
  return {
    ok: true,
    itemId,
    itemDir,
    state,
    actualState,
    targetState: stateOverride || state,
    stateName: kitSpec.states.states[state].name,
    tier: tier.tier,
    tierSource: tier.source,
    gates,
    summary,
    sizeKb: size.totalKb,
    lastRun: status?.lastRun || null,
    history: status?.history || [],
    git: gitFacts(projectRoot),
  };
}

/**
 * 推进到目标状态。
 * @returns {{ok:boolean, blockedBy?:Array, state?:string}}
 */
export function advance({ projectRoot, itemId, target, kitSpec, config, cwd, force = false, actor = 'orchestrator', by = null }) {
  const current = evaluateItem({ projectRoot, itemId, kitSpec, config, cwd });
  if (!current.ok) return { ok: false, blockedBy: [], errors: current.errors };
  if (!kitSpec.states.states[target]) {
    return { ok: false, errors: [`未知目标状态：${target}`] };
  }
  const legal = kitSpec.states.transitions.some((t) => t.from === current.state && t.to === target);
  if (!legal && !force) {
    return { ok: false, errors: [`非法状态转移：${current.state} → ${target}`], blockedBy: [] };
  }
  // ★ 关键：按「目标状态」判定门禁，而不是当前状态
  const targetEval = evaluateItem({ projectRoot: projectRoot, itemId, kitSpec, config, cwd, stateOverride: target });
  if (!targetEval.ok) return { ok: false, blockedBy: [], errors: targetEval.errors };
  const blocking = targetEval.gates.filter((g) => g.verdict === 'blocked' || g.verdict === 'fail').map((g) => ({ gate: g.gate, notes: g.notes }));
  if (blocking.length && !force) {
    return { ok: false, blockedBy: blocking, errors: [`门禁未通过，拒绝推进到 ${target}`] };
  }

  const status = readStatus(current.itemDir) || {};
  const history = status.history || [];
  history.push({
    at: new Date().toISOString(),
    actor,
    by,
    from: current.state,
    to: target,
    forced: Boolean(force),
    skippedGates: force && blocking.length ? blocking.map((b) => b.gate) : [],
    gatesVerdict: targetEval.summary,
  });
  writeRawState(current.itemDir, target);
  writeStatus(current.itemDir, {
    ...status,
    item: itemId,
    state: target,
    tier: current.tier,
    kitVersion: kitVersion(),
    updatedAt: new Date().toISOString(),
    history,
  });
  return { ok: true, state: target, forced: Boolean(force), blockedBy: blocking };
}


/**
 * 追加一条事件到变更的 history（**任务级与操作级事件**的唯一入口）。
 *
 * 为什么需要：`advance`/`gate run` 已记录事件，但**任务级变化没有记录** ——
 * 于是无法回答「T-2 什么时候被谁标成阻塞、卡了多久」。
 * 看板（devflow board）与"任务前世今生"都依赖这条链路，所以必须集中记录、结构一致。
 */
export function appendEvent(projectRoot, itemId, event) {
  const itemDir = machineDir(projectRoot, itemId) || path.join(itemsDir(projectRoot), itemId);
  if (!existsSync(itemDir)) return { ok: false, errors: [`变更目录不存在：${itemDir}`] };
  const status = readStatus(itemDir) || {};
  const history = status.history || [];
  history.push({ at: new Date().toISOString(), ...event });
  // 只保留最近 500 条，避免文件无限增长（看板只需近期事件 + 当前状态）
  const trimmed = history.length > 500 ? history.slice(-500) : history;
  writeStatus(itemDir, { ...status, item: itemId, history: trimmed, updatedAt: new Date().toISOString() });
  return { ok: true, count: trimmed.length };
}

/** 读取某变更的事件流（供 devflow history / 看板 / 测试使用） */
export function readEvents(projectRoot, itemId) {
  const itemDir = machineDir(projectRoot, itemId) || path.join(itemsDir(projectRoot), itemId);
  const status = readStatus(itemDir) || {};
  return status.history || [];
}

/** 记录一次门禁运行结果（供 gate run 使用） */
export function recordRun({ projectRoot, itemId, kitSpec, config, cwd, records, summary, source }) {
  const itemDir = machineDir(projectRoot, itemId) || path.join(itemsDir(projectRoot), itemId);
  if (!existsSync(itemDir)) return { ok: false, errors: [`变更目录不存在：${itemDir}`] };
  const state = rawState(itemDir);
  const status = readStatus(itemDir) || {};
  const history = status.history || [];
  history.push({ at: new Date().toISOString(), event: 'gate-run', source: source || 'cli', verdict: summary });
  writeStatus(itemDir, {
    ...status,
    item: itemId,
    state,
    kitVersion: kitVersion(),
    updatedAt: new Date().toISOString(),
    lastRun: { at: new Date().toISOString(), source: source || 'cli', summary, records },
    history,
  });
  return { ok: true, itemDir };
}

/** 创建变更目录骨架（new 命令） */
export function createItem({ projectRoot, itemId, tier, owner, repos, changeSurface, states, title }) {
  // 人写的产物（①②类）在 items/；机器状态（③类）在 .local/items/
  const itemDir = machineDir(projectRoot, itemId) || path.join(itemsDir(projectRoot), itemId);
  const machine = path.join(localItemsDir(projectRoot), itemId);
  for (const d of [itemDir, machine]) {
    if (existsSync(d)) {
      const entries = readdirSync(d).filter((n) => !n.startsWith('.'));
      if (entries.length) return { ok: false, errors: [`目标目录非空，拒绝覆盖：${d}`] };
    }
  }
  mkdirSync(itemDir, { recursive: true });
  mkdirSync(path.join(itemDir, 'release'), { recursive: true });
  mkdirSync(machine, { recursive: true });
  writeRawState(machine, 'draft');
  writeStatus(machine, {
    item: itemId,
    state: 'draft',
    tier,
    kitVersion: kitVersion(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastRun: null,
    history: [{ at: new Date().toISOString(), event: 'created', tier, owner, tierSource: 'explicit' }],
  });
  return {
    ok: true,
    itemDir,        // 人写的产物目录（①②类，入库）
    machineDir: machine,   // 机器状态目录（③类，gitignore）
    meta: {
      item: itemId,
      title: title || itemId,
      tier,
      tierName: states.tiers[tier]?.name || tier,
      owner: owner || '(待填)',
      repos: repos && repos.length ? repos : ['(本仓)'],
      changeSurface: changeSurface && changeSurface.length ? changeSurface : ['internal'],
      createdAt: new Date().toISOString().slice(0, 10),
    },
  };
}

/** 列表：列出全部变更（不含归档） */
export function listItems(projectRoot) {
  // 合并两处目录：新布局（.local/items 有机器状态）与旧布局（items 里什么都有）
  const ids = allItemIds(projectRoot);
  return ids.map((id) => {
    const itemDir = machineDir(projectRoot, id) || path.join(itemsDir(projectRoot), id);
    let mtime = 0;
    try {
      mtime = statSync(itemDir).mtimeMs;
    } catch {
      mtime = 0;
    }
    return { itemId: id, itemDir, rawState: rawState(itemDir), mtime };
  }).sort((a, b) => b.mtime - a.mtime);
}

/** 归档：把活跃窗口之外的已完成变更移入归档目录（只保留摘要与索引） */
export function archive({ projectRoot, kitSpec, artifactsSpec, dryRun = true }) {
  const rules = artifactsSpec.archive || { afterDays: 90, keepRecent: 20, dir: '.devflow/archive' };
  const terminal = new Set(['released']);
  const now = Date.now();
  const items = listItems(projectRoot).filter((i) => terminal.has(i.rawState));
  const candidates = items.filter((i, idx) => {
    const ageDays = (now - i.mtime) / 86400000;
    return ageDays > rules.afterDays && idx >= rules.keepRecent;
  });
  const moves = candidates.map((c) => ({
    from: path.relative(projectRoot, c.itemDir),
    to: path.join(rules.dir, c.itemId),
  }));
  if (!dryRun) {
    for (const m of moves) {
      mkdirSync(path.join(projectRoot, rules.dir), { recursive: true });
      const src = path.join(projectRoot, m.from);
      const dst = path.join(projectRoot, m.to);
      mkdirSync(dst, { recursive: true });
      for (const f of readdirSync(src)) {
        const s = path.join(src, f);
        const d = path.join(dst, f);
        if (statSync(s).isFile()) writeFileSync(d, readFileSync(s));
      }
      // 保留摘要索引，删除原目录
      writeFileSync(path.join(projectRoot, rules.dir, 'INDEX.md'), `${new Date().toISOString()} 归档 ${m.from} → ${m.to}\n`, { flag: 'a' });
      rmSync(src, { recursive: true, force: true });
    }
  }
  return { moves, rules, dryRun };
}
