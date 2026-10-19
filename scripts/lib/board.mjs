/**
 * devflow board —— 本地看板服务（v1：只读 + 实时刷新）。
 *
 * 定位（与 dsh-context 的差异）：它需要**独立采集层**把数据攒起来；
 * 我们的状态本来就在磁盘上（`.devflow/` + TASKS.md + STATUS.json），**读文件即真相**，
 * 所以看板只需要"读取 + 推送"，不需要采集与聚合引擎。
 *
 * 为什么是本地服务而不是 DSH 插件：
 *   · 界面应消费**统一的状态接口**，不该绑死某个宿主（换宿主不用重写前端）；
 *   · 插件要写宿主 API，且只在宿主里可用 —— 与本产品"零依赖、通用"的定位冲突。
 *
 * 安全边界（刻意收紧）：
 *   · 只监听 127.0.0.1（不对外暴露）；
 *   · v1 **只读**：不接受任何写操作（要改状态请用 CLI 或在聊天里说）；
 *   · 无鉴权 —— 因为只读 + 仅本机；一旦要加写操作，必须同时加鉴权。
 *
 * 依赖：仅 node 内置模块（http / fs），保持零依赖。
 */
import http from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { itemsDir, localItemsDir, machineDir, readStatus, rawState, withTaskKinds } from './state.mjs';
import { humanEvent } from './humanize.mjs'
import { isRealValue, parseApprovals } from './checks.mjs';

// ── 数据收集 ───────────────────────────────────────────────

/** 解析 TASKS.md 的任务行（与 CLI 的解析保持同一口径） */
function parseTasks(itemDir) {
  const candidates = [path.join(itemDir, 'TASKS.md')];
  const m = /^(.*)\/\.devflow\/\.local\/items\/([^/]+)$/.exec(itemDir);
  if (m) candidates.push(path.join(m[1], '.devflow', 'items', m[2], 'TASKS.md'));
  const file = candidates.find((c) => existsSync(c));
  if (!file) return [];
  const lines = readFileSync(file, 'utf8').split('\n');
  const hi = lines.findIndex((l) => /^\s*\|/.test(l) && /写入范围/.test(l));
  if (hi < 0) return [];
  const rawCols = lines[hi].split('|').map((c) => c.trim());
  const cols = rawCols.slice(1, rawCols.length - 1);
  const idx = (n) => cols.indexOf(n);
  const [iT, iRepo, iLayer, iRange, iDep, iStatus, iOwner, iCmd, iAc] = [
    idx('T'), idx('目标仓'), idx('负责层'), idx('写入范围'), idx('依赖'),
    idx('状态'), idx('负责人'), idx('验收命令'), idx('对应AC'),
  ];
  const out = [];
  for (let i = hi + 1; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i])) break;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
    const rc = lines[i].split('|').map((c) => c.trim());
    const cells = rc.slice(1, rc.length - 1);
    const at = (k) => (k >= 0 ? (cells[k] || '') : '');
    if (!at(iT) || /^T$/i.test(at(iT))) continue;
    const statusRaw = at(iStatus);
    const kind = /已完成/.test(statusRaw) ? 'done'
      : /阻塞/.test(statusRaw) ? 'blocked'
        : /进行中/.test(statusRaw) ? 'doing' : 'todo';
    out.push({
      t: at(iT), repo: at(iRepo), layer: at(iLayer), range: at(iRange),
      dep: at(iDep), status: statusRaw, kind, owner: at(iOwner),
      cmd: at(iCmd), ac: at(iAc),
      note: /阻塞/.test(statusRaw) ? statusRaw.replace(/^阻塞[（(]?/, '').replace(/[）)]$/, '') : '',
    });
  }
  return out;
}

/** 收集单个变更的看板数据 */
function collectChange(projectRoot, itemId) {
  const dir = machineDir(projectRoot, itemId) || path.join(itemsDir(projectRoot), itemId);
  const status = readStatus(dir) || {};
  // 任务显示态：**与静态视图共用同一个函数**（state.mjs 的 withTaskKinds）。
  // 此前两处各写一份推断逻辑，导致同一变更在看板显示 3/3 已完成、在视图显示 0/3（实测）。
  // 推断只作用于展示，不改写 TASKS.md；显式写了状态就以显式值为准。
  const tasks = withTaskKinds(parseTasks(dir), status.state);
  const history = (status.history || []).map((e) => ({
    at: e.at, event: e.event || (e.from ? 'state' : 'other'),
    task: e.task || null, changes: e.changes || null,
    from: e.from || null, to: e.to || null, by: e.by || e.actor || null,
    point: e.point || null,
    // 文案在服务端生成（与 CLI 共用 humanize.mjs）——避免两个界面各说一套
    text: humanEvent(e),
    note: e.note || null, verdict: typeof e.verdict === 'string' ? e.verdict : null,
  }));
  // 人工确认点进度：这是"人最需要一眼看到"的信息（谁还没签、卡在哪个确认点）
  const appRaw = (() => {
    for (const f of [path.join(dir, 'APPROVALS.md'), path.join(itemsDir(projectRoot), itemId, 'APPROVALS.md')]) {
      if (existsSync(f)) return readFileSync(f, 'utf8');
    }
    return '';
  })();
  // 与门禁/CLI 同一口径：占位值不算已签核
  const approvals = parseApprovals(appRaw)
    .filter((a) => isRealValue(a.who) && isRealValue(a.at) && isRealValue(a.verdict))
    .map((a) => ({ point: String(a.point).trim(), who: a.who, verdict: a.verdict, at: a.at }));
  const AP = [
    { id: 'AP1', name: '需求与判据', tiers: ['light', 'standard', 'heavy'] },
    { id: 'AP2', name: '契约冻结', tiers: ['standard', 'heavy'] },
    { id: 'AP3', name: '发布批准', tiers: ['light', 'standard', 'heavy'] },
  ];
  const tier = status.tier || 'standard';
  const required = AP.filter((a) => a.tiers.includes(tier)).map((a) => ({
    ...a,
    done: approvals.some((x) => x.point.includes(a.name) || a.name.includes(x.point)),
    who: approvals.find((x) => x.point.includes(a.name) || a.name.includes(x.point))?.who || null,
    verdict: approvals.find((x) => x.point.includes(a.name) || a.name.includes(x.point))?.verdict || null,
  }));

  return {
    itemId, state: rawState(dir) || '?', tier: status.tier || '?',
    approvals: required,
    approvalsDone: required.filter((a) => a.done).length,
    approvalsTotal: required.length,
    createdAt: status.createdAt || null, updatedAt: status.updatedAt || null,
    tasks, history,
    counts: {
      total: tasks.length,
      todo: tasks.filter((t) => t.kind === 'todo').length,
      doing: tasks.filter((t) => t.kind === 'doing').length,
      done: tasks.filter((t) => t.kind === 'done').length,
      blocked: tasks.filter((t) => t.kind === 'blocked').length,
    },
  };
}

/** 汇总整个工作区（或单仓）的看板状态 —— **对外唯一的状态接口** */
/**
 * 多仓工作区支持：工作区根没有 devflow.json（它不是"项目"），只有 devflow.workspace.json。
 * 若只支持单仓，看板在**最需要它的多仓场景**里直接不可用（实测踩到）。
 */
export function workspaceMembers(root) {
  const f = path.join(root, 'devflow.workspace.json');
  if (!existsSync(f)) return null;
  try {
    const d = JSON.parse(readFileSync(f, 'utf8'));
    const members = (d.members || []).map((m) => ({ name: m.name || m.repo || m.path, dir: path.join(root, m.path || m.name || m.repo) }));
    return { name: d.workspace?.name || path.basename(root), members };
  } catch { return null; }
}

/**
 * 向上寻找项目/工作区根。
 *
 * 为什么要有它：插件从任意 cwd 启动看板服务时，**它不知道用户的工作区在哪**。
 * 与其让插件猜（它会猜成插件自己的目录，实测踩到），不如让看板自己找 ——
 * 看板才知道什么算"根"（`.devflow/`、`devflow.json`、`devflow.workspace.json`）。
 */
export function discoverProjectRoot(startDir = process.cwd(), maxUp = 8) {
  const markers = ['.devflow', 'devflow.json', 'devflow.workspace.json'];
  // 防御：DSH 宿主目录里可能放着与项目清单同名的配置文件，不能把它当项目根
  const denied = [path.join(os.homedir(), '.dsh'), path.join(os.homedir(), '.config')];
  let dir = path.resolve(startDir);
  for (let i = 0; i < maxUp; i += 1) {
    if (denied.some((d) => dir === d || dir.startsWith(`${d}${path.sep}`))) {
      // 命中宿主目录：不再往上找（否则会一路找到 /）
      if (dir === denied.find((d) => dir === d)) return null;
    }
    if (markers.some((m) => existsSync(path.join(dir, m)))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function collectBoardState(projectRoot, opts = {}) {
  // 允许**没有根**：插件在别人的机器上往往找不到项目（kit 在家目录、cwd 是宿主目录）。
  // 以前这种情况直接启动失败 ⇒ 面板永远"未启动"。正确做法是**照常起服务**，
  // 返回一个空状态，让用户在面板里**选工作区**（/api/roots 提供候选）。
  if (!projectRoot || !existsSync(projectRoot)) {
    return {
      generatedAt: new Date().toISOString(),
      project: '（未选择工作区）',
      projectRoot: null,
      workspace: null,
      changes: [],
      stageCounts: ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released']
        .map((state) => ({ state, count: 0 })),
      totals: { changes: 0, tasks: 0, done: 0, blocked: 0, doing: 0 },
      needsRoot: true,
    };
  }
  const ids = [];
  for (const dir of [localItemsDir(projectRoot), itemsDir(projectRoot)]) {
    try {
      for (const n of readdirSync(dir)) {
        if (!n.startsWith('.') && statSync(path.join(dir, n)).isDirectory() && !ids.includes(n)) ids.push(n);
      }
    } catch { /* 目录不存在 */ }
  }
  const changes = ids.sort().map((id) => collectChange(projectRoot, id));
  // 多仓工作区：把成员的变更也纳进来（带仓名标注）
  const ws = workspaceMembers(projectRoot);
  if (ws) {
    for (const m of ws.members) {
      if (!existsSync(m.dir)) continue;
      for (const id of (() => {
        const out = [];
        for (const dir of [localItemsDir(m.dir), itemsDir(m.dir)]) {
          try { for (const n of readdirSync(dir)) if (!n.startsWith('.')) out.push(n); } catch { /* 无 */ }
        }
        return out;
      })()) {
        if (changes.some((c) => c.itemId === id && c.repo === m.name)) continue;
        const c = collectChange(m.dir, id);
        c.repo = m.name;
        changes.push(c);
      }
    }
  }
  const stages = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'];
  return {
    generatedAt: new Date().toISOString(),
    project: ws ? `${ws.name}（工作区 · ${ws.members.length} 仓）` : path.basename(projectRoot),
    projectRoot,
    workspace: ws ? { name: ws.name, members: ws.members.map((m) => m.name) } : null,
    changes,
    stageCounts: stages.map((s) => ({ state: s, count: changes.filter((c) => c.state === s).length })),
    totals: changes.reduce((a, c) => ({
      changes: a.changes + 1,
      tasks: a.tasks + c.counts.total,
      done: a.done + c.counts.done,
      blocked: a.blocked + c.counts.blocked,
      doing: a.doing + c.counts.doing,
    }), { changes: 0, tasks: 0, done: 0, blocked: 0, doing: 0 }),
  };
}

// ── 看板前端（单文件，无构建、无外部依赖） ─────────────────

export function renderBoardHtml(projectName) {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>devflow 看板 · ${projectName}</title>
<style>
 :root{
   /* 深色基底：低饱和、层次分明，避免"一片死黑" */
   --bg:#0b1120; --bg2:#0e1626; --panel:#131d31; --card:#18243c; --card-hi:#1d2a45;
   --bd:#26344f; --bd-soft:rgba(255,255,255,.07);
   --txt:#e8eefb; --txt2:#c2cee2; --mut:#8ea3c2;
   --accent:#5b9dff; --accent-2:#8b7cff;
   --todo:#7c8da8; --doing:#f0a132; --done:#2fbf7f; --blocked:#f2555a;
   --shadow:0 1px 2px rgba(0,0,0,.28), 0 8px 24px -12px rgba(0,0,0,.6);
   --r:12px;
 }
 *{box-sizing:border-box}
 html,body{height:100%}
 body{
   margin:0; color:var(--txt); -webkit-font-smoothing:antialiased;
   font:14px/1.65 -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Segoe UI",Arial,sans-serif;
   background:
     radial-gradient(1100px 520px at 12% -12%, rgba(91,157,255,.14), transparent 60%),
     radial-gradient(900px 460px at 100% 0%, rgba(139,124,255,.12), transparent 55%),
     linear-gradient(180deg, var(--bg) 0%, var(--bg2) 100%);
   background-attachment:fixed;
 }
 /* 顶栏：毛玻璃 + 底边高光，和内容拉开层次 */
 header{
   position:sticky; top:0; z-index:20; padding:16px 26px;
   display:flex; align-items:center; gap:16px; flex-wrap:wrap;
   background:rgba(11,17,32,.78); backdrop-filter:saturate(160%) blur(14px);
   border-bottom:1px solid var(--bd-soft);
   box-shadow:0 1px 0 rgba(255,255,255,.03) inset;
 }
 h1{
   font-size:15px; margin:0; font-weight:650; letter-spacing:.2px;
   display:flex; align-items:center; gap:9px;
 }
 h1:before{
   content:""; width:9px; height:9px; border-radius:3px;
   background:linear-gradient(135deg,var(--accent),var(--accent-2));
   box-shadow:0 0 12px rgba(91,157,255,.7);
 }
 .ws{display:flex; align-items:center; gap:6px; font-size:12px}
 .ws input{background:rgba(255,255,255,.05); border:1px solid var(--bd); border-radius:8px;
   color:var(--txt); padding:4px 8px; font-size:11.5px; width:200px; font-family:ui-monospace,Menlo,monospace}
 .ws input:focus{outline:none; border-color:var(--accent)}
 .ws button{background:rgba(255,255,255,.06); border:1px solid var(--bd); border-radius:8px;
   color:var(--txt2); padding:4px 9px; font-size:11.5px; cursor:pointer; transition:.15s}
 .ws button:hover{background:rgba(255,255,255,.12); color:var(--txt)}
 .live{display:flex; align-items:center; gap:7px; font-size:12px; color:var(--mut);
   padding:5px 11px; border:1px solid var(--bd); border-radius:999px; background:rgba(255,255,255,.02)}
 .dot-live{width:7px; height:7px; border-radius:50%; background:var(--done);
   box-shadow:0 0 0 3px rgba(47,191,127,.16), 0 0 10px var(--done)}
 .dot-live.off{background:var(--blocked); box-shadow:0 0 0 3px rgba(242,85,90,.16), 0 0 10px var(--blocked)}
 /* 文档视图入口：常驻头部，一点即开（新标签页，不打断当前看板） */
 .navview{display:inline-flex; align-items:center; gap:5px; font-size:12px; text-decoration:none;
   color:var(--accent); border:1px solid rgba(90,140,255,.45); border-radius:999px; padding:4px 11px;
   background:rgba(90,140,255,.10); transition:.15s}
 .navview:hover{background:rgba(90,140,255,.22); color:#fff; border-color:var(--accent)}
 /* 连接失败横幅：把"为什么空"与"怎么修"直接写在页面上 */
 .connfail{margin:14px 18px 0;padding:13px 16px;border:1px solid rgba(242,85,90,.55);border-radius:10px;
   background:rgba(242,85,90,.10);color:var(--txt);font-size:13px;line-height:1.65}
 .connfail code{background:rgba(255,255,255,.10);border-radius:4px;padding:1px 5px;font-size:12px}
 .connfail a{color:var(--accent)}
 .connfail .cf-sub{margin-top:6px;font-size:12px;color:var(--txt2)}
 /* 指标卡：等宽数字 + 渐隐顶线 */
 .stats{display:grid; grid-template-columns:repeat(auto-fit,minmax(118px,1fr)); gap:12px; padding:18px 26px 6px}
 .stat{
   position:relative; overflow:hidden;
   background:linear-gradient(180deg,var(--card-hi),var(--card));
   border:1px solid var(--bd); border-radius:var(--r); padding:13px 15px;
   box-shadow:var(--shadow); transition:transform .16s ease, border-color .16s ease;
 }
 .stat:hover{transform:translateY(-2px)}
 .stat:after{content:""; position:absolute; inset:0 0 auto 0; height:2px;
   background:linear-gradient(90deg,var(--accent),var(--accent-2),transparent)}
 .stat b{display:block; font-size:26px; line-height:1.2; font-weight:680;
   font-variant-numeric:tabular-nums; letter-spacing:-.4px}
 .stat span{display:block; margin-top:2px; color:var(--mut); font-size:11.5px; letter-spacing:.3px}
 main{padding:6px 26px 34px}
 .muted{color:var(--mut)}
 /* 分栏看板：列头带计数胶囊 */
 .lanes{display:grid; grid-template-columns:repeat(auto-fit,minmax(208px,1fr)); gap:14px}
 .lane{
   background:linear-gradient(180deg,rgba(255,255,255,.022),transparent 42%),var(--panel);
   border:1px solid var(--bd); border-radius:var(--r); padding:12px; min-height:132px;
   box-shadow:var(--shadow);
 }
 .lane h3{margin:0 0 10px; font-size:12px; color:var(--txt2); font-weight:600;
   display:flex; align-items:center; justify-content:space-between; letter-spacing:.4px}
 .lane h3>span:last-child{
   background:rgba(255,255,255,.06); border:1px solid var(--bd-soft);
   min-width:22px; text-align:center; border-radius:999px; padding:1px 7px;
   font-size:11px; color:var(--mut); font-variant-numeric:tabular-nums;
 }
 /* 卡片：左侧状态色条 + 悬停抬升 */
 .card{
   position:relative; background:var(--card); border:1px solid var(--bd);
   border-radius:10px; padding:9px 12px 9px 14px; margin-bottom:9px; cursor:pointer;
   transition:transform .15s ease, border-color .15s ease, background .15s ease;
 }
 .card:before{content:""; position:absolute; left:0; top:9px; bottom:9px; width:3px;
   border-radius:3px; background:var(--todo)}
 .card:hover{transform:translateY(-1px); background:var(--card-hi); border-color:#31456a}
 .card.doing:before{background:var(--doing)} .card.done:before{background:var(--done)}
 .card.blocked:before{background:var(--blocked)}
 .card.req:before{background:linear-gradient(180deg,var(--accent),var(--accent-2))}
 .card .t{font-weight:620; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12.5px}
 .card .meta{color:var(--mut); font-size:11px; margin-top:3px; line-height:1.5}
 .tag{display:inline-block; font-size:10px; font-weight:600; border-radius:5px;
   padding:1px 6px; margin-left:6px; color:#fff; vertical-align:1.5px; letter-spacing:.2px}
 /* 抽屉：滑入 + 半透明遮罩感 */
 .panel{
   position:fixed; top:0; right:0; height:100%; width:min(468px,93vw); z-index:40;
   background:linear-gradient(180deg,var(--card-hi),var(--panel) 22%);
   border-left:1px solid var(--bd); box-shadow:-24px 0 60px -20px rgba(0,0,0,.75);
   transform:translateX(102%); transition:transform .22s cubic-bezier(.4,0,.2,1);
   overflow:auto; padding:20px 22px 30px;
 }
 .panel.open{transform:none}
 .panel h2{font-size:14px; margin:0 0 5px; font-weight:650; letter-spacing:.2px}
 .panel h2:first-child{padding-right:28px}
 .panel .close{
   position:absolute; top:14px; right:16px; width:28px; height:28px; border-radius:8px;
   background:rgba(255,255,255,.05); border:1px solid var(--bd); color:var(--mut);
   font-size:14px; cursor:pointer; transition:.15s;
 }
 .panel .close:hover{background:rgba(255,255,255,.1); color:var(--txt)}
 .kv{display:grid; grid-template-columns:86px 1fr; gap:7px 12px; margin:12px 0}
 .kv dt{color:var(--mut); font-size:11.5px} .kv dd{margin:0; font-size:12.5px}
 .kv dd code,footer code{background:rgba(255,255,255,.055); border:1px solid var(--bd-soft);
   border-radius:5px; padding:1px 5px; font-family:ui-monospace,Menlo,monospace; font-size:11.5px}
 /* 时间轴：节点带光环 */
 .tl{border-left:1.5px solid var(--bd); margin:14px 0 0 7px; padding-left:14px}
 .ev{position:relative; padding:5px 0; font-size:12.5px}
 .ev:before{content:""; position:absolute; left:-20px; top:11px; width:8px; height:8px;
   border-radius:50%; background:var(--accent); box-shadow:0 0 0 3px rgba(91,157,255,.16)}
 .ev .at{color:var(--mut); font-size:11px; margin-top:1px}
 /* 分节标题与空状态：避免大片空白显得单调 */
 .sec{display:flex; align-items:baseline; gap:10px; margin:20px 0 10px}
 .sec>span{font-size:13px; font-weight:640; letter-spacing:.3px}
 .sec>i{font-style:normal; font-size:11.5px; color:var(--mut)}
 .needroot{margin:14px 26px 0; padding:11px 14px; border-radius:10px; font-size:12.5px;
   background:rgba(240,161,50,.12); border:1px solid rgba(240,161,50,.4); color:#f4d19b}
 .needroot code{background:rgba(255,255,255,.08); padding:1px 5px; border-radius:4px}
 .empty{padding:18px; text-align:center; color:var(--mut); font-size:12.5px;
   border:1px dashed var(--bd); border-radius:10px; background:rgba(255,255,255,.015)}
 footer{padding:14px 26px 26px; color:var(--mut); font-size:11.5px}
 @media (max-width:640px){
   header{padding:13px 16px} .stats{padding:14px 16px 4px} main{padding:6px 16px 26px}
   .stat b{font-size:22px}
 }
 @media (prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body>
<header>
  <h1>devflow 看板</h1>
  <span class="muted" style="font-size:12px">${projectName}</span>
  <a class="navview" href="/view"
     title="打开完整文档视图（所有变更 × 所有阶段文档）">📄 文档视图</a>
  <div class="live"><span id="live" class="dot-live"></span><span id="liveTxt">连接中…</span></div>
  <div class="ws">
    <span class="muted">工作区</span>
    <input id="wsInput" list="wsList" placeholder="默认" spellcheck="false">
    <datalist id="wsList"></datalist>
    <button id="wsApply" title="切换到这个工作区">切换</button>
    <button id="wsReset" title="回到服务默认根">默认</button>
  </div>
  <div class="live" style="margin-left:auto"><span class="muted">更新于</span> <span id="at">—</span></div>
</header>
<div id="needRoot" class="needroot" style="display:none"></div>
<div id="connFail" class="connfail" style="display:none"></div>
<div class="stats" id="stats"></div>
<main>
  <div class="sec"><span>任务看板</span><i>按状态分栏 · 点卡片看「前世今生」</i></div>
  <div class="lanes" id="lanes"></div>
  <div class="sec"><span>需求进度</span><i>按阶段分栏 · 点卡片看变更事件与人工确认点</i></div>
  <div class="lanes" id="stages"></div>
</main>
<aside class="panel" id="panel">
  <button class="close" onclick="document.getElementById('panel').classList.remove('open')">✕</button>
  <div id="panelBody"></div>
</aside>
<footer>v1 只读看板 · 数据直接读自 <code>.devflow/</code>（文件即真相）· 要改状态请在 CLI 或聊天里操作</footer>
<script>
/**
 * 时间格式化：**必须用浏览器本地时区**。
 * 踩过的坑：直接把 ISO（UTC）截断当本地时间显示 ⇒ 比本地时间少 8 小时（实测 CST+0800）。
 * 服务端只发 ISO，显示交给浏览器 —— 它才知道用户的时区。
 */
const fmtLocal = (v, withSec = true) => {
  if (!v) return '—';
  const d = new Date(v);
  if (isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  const base = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate())
    + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  return withSec ? base + ':' + p(d.getSeconds()) : base;
};
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const LAYER_COLOR = { 前端:'#2563eb', 后端:'#7c3aed', 数据库:'#0891b2', 契约:'#c2410c', 文档:'#4b5563' };
const KIND = { todo:['待开始','var(--todo)'], doing:['进行中','var(--doing)'], done:['已完成','var(--done)'], blocked:['阻塞','var(--blocked)'] };
const STATE_NAME = { draft:'草稿', spec_ready:'需求就绪', contracted:'契约冻结', implementing:'实现中',
  tested:'待验证', verified:'已验证', released:'已发布' };
let STATE = null;

function drawStats(s){
  const t = s.totals;
  const boxes = [
    ['在办变更', t.changes], ['任务总数', t.tasks],
    ['进行中', t.doing], ['已完成', t.done], ['阻塞', t.blocked],
  ].map(([k,v]) => '<div class="stat"><b>'+v+'</b><span>'+k+'</span></div>').join('');
  document.getElementById('stats').innerHTML = boxes;
}
function taskCard(c, t){
  const kind = KIND[t.kind] || KIND.todo;
  return '<div class="card '+t.kind+'" onclick="openTask(\\''+esc(c.itemId)+'\\',\\''+esc(t.t)+'\\')">'
    + '<div class="t">'+esc(t.t)+' <span class="tag" style="background:'+(LAYER_COLOR[t.layer]||'#475569')+'">'+esc(t.layer||'-')+'</span></div>'
    + '<div class="meta">'+esc(c.itemId)+' · '+esc(t.owner||'未指派')+'</div>'
    + (t.note ? '<div class="meta" style="color:var(--blocked)">⛔ '+esc(t.note)+'</div>' : '')
    + '</div>';
}
function drawLanes(s){
  const cols = ['todo','doing','done','blocked'];
  document.getElementById('lanes').innerHTML = cols.map((k) => {
    const all = [];
    for (const c of s.changes) for (const t of c.tasks) if (t.kind === k) all.push([c,t]);
    const col = KIND[k][1];
    return '<div class="lane"><h3><span style="color:'+col+'">'+KIND[k][0]+'</span>'
      + '<span>'+all.length+'</span></h3>'
      + (all.length ? all.map(([c,t]) => taskCard(c,t)).join('') : '<div class="empty">暂无任务</div>')
      + '</div>';
  }).join('');
  document.getElementById('stages').innerHTML = s.stageCounts.map((st) => {
    const items = s.changes.filter((c) => c.state === st.state);
    return '<div class="lane"><h3><span>'+esc(STATE_NAME[st.state]||st.state)+'</span><span>'+st.count+'</span></h3>'
      + (items.length ? items.map((c) => '<div class="card req" onclick="openChange(\\''+esc(c.itemId)+'\\')">'
        + '<div class="t">'+esc(c.itemId)+'</div>'
        + '<div class="meta">'+esc(c.tier)+' · 确认 '+(c.approvalsDone||0)+'/'+(c.approvalsTotal||0)+' · 任务 '+c.counts.done+'/'+c.counts.total
        + (c.counts.blocked ? ' · <span style="color:var(--blocked)">阻塞 '+c.counts.blocked+'</span>' : '')+'</div></div>').join('')
        : '<div class="empty">—</div>')
      + '</div>';
  }).join('');
}
// ── 展示辅助：相对时间（文案由服务端生成，见 humanize.mjs）──────────
/** 相对时间：人对"3 分钟前"的理解远好于 ISO 串；精确时间放 title 里备查 */
function ago(iso){
  const t = new Date(iso).getTime();
  if (isNaN(t)) return esc(String(iso || ''));
  const sec = Math.max(0, (Date.now() - t) / 1000);
  if (sec < 60) return '刚刚';
  if (sec < 3600) return Math.floor(sec / 60) + ' 分钟前';
  if (sec < 86400) return Math.floor(sec / 3600) + ' 小时前';
  if (sec < 2592000) return Math.floor(sec / 86400) + ' 天前';
  return fmtLocal(iso, false);
}

function timeline(events){
  if (!events.length) return '<p class="muted">还没有记录</p>';
  return '<div class="tl">' + events.slice().reverse().map((e) =>
    '<div class="ev">' + esc(e.text || '（无描述）')
      + '<div class="at" title="' + esc(fmtLocal(e.at)) + '">' + ago(e.at) + '</div></div>'
  ).join('') + '</div>';
}
function openTask(itemId, taskId){
  const c = STATE.changes.find((x) => x.itemId === itemId); if (!c) return;
  const t = c.tasks.find((x) => x.t === taskId); if (!t) return;
  const ev = c.history.filter((e) => e.task === taskId);
  document.getElementById('panelBody').innerHTML =
    '<h2>'+esc(t.t)+' <span class="tag" style="background:'+(LAYER_COLOR[t.layer]||'#475569')+'">'+esc(t.layer||'-')+'</span></h2>'
    + '<div class="muted">'+esc(c.itemId)+'</div>'
    + '<dl class="kv">'
    + '<dt>状态</dt><dd>'+esc(t.status)+'</dd>'
    + '<dt>负责人</dt><dd>'+esc(t.owner||'未指派')+'</dd>'
    + '<dt>目标仓</dt><dd>'+esc(t.repo)+'</dd>'
    + '<dt>写入范围</dt><dd><code>'+esc(t.range)+'</code></dd>'
    + '<dt>依赖</dt><dd>'+esc(t.dep||'无')+'</dd>'
    + '<dt>对应 AC</dt><dd>'+esc(t.ac)+'</dd>'
    + '<dt>验收命令</dt><dd><code>'+esc(t.cmd)+'</code></dd>'
    + '</dl><h2 style="margin-top:14px">前世今生（'+ev.length+' 条事件）</h2>' + timeline(ev);
  document.getElementById('panel').classList.add('open');
}
function openChange(itemId){
  const c = STATE.changes.find((x) => x.itemId === itemId); if (!c) return;
  document.getElementById('panelBody').innerHTML =
    '<h2>'+esc(c.itemId)+'</h2><div class="muted">'+esc(STATE_NAME[c.state]||c.state)+' · 档位 '+esc(c.tier)+'</div>'
    + '<dl class="kv"><dt>任务</dt><dd>'+c.counts.done+'/'+c.counts.total+' 已完成'
    + (c.counts.blocked?('，阻塞 '+c.counts.blocked):'')+'</dd>'
    + '<dt>创建</dt><dd>'+esc(fmtLocal(c.createdAt))+'</dd>'
    + '<dt>更新</dt><dd>'+esc(fmtLocal(c.updatedAt))+'</dd></dl>'
    + '<h2 style="margin-top:14px">人工确认点（'+(c.approvalsDone||0)+'/'+(c.approvalsTotal||0)+'）</h2>'
    + ((c.approvals||[]).length ? '<dl class="kv">'+(c.approvals||[]).map((a) =>
        '<dt>'+esc(a.name)+'</dt><dd>'+(a.done
          ? '<span style="color:var(--done)">✓ '+esc(a.verdict||'已签')+'</span> · '+esc(a.who||'')
          : '<span class="muted">未签核</span>')+'</dd>').join('')+'</dl>'
      : '<p class="muted">本档位无需人工确认点</p>')
    + '<h2 style="margin-top:14px">变更事件（'+c.history.length+'）</h2>' + timeline(c.history);
  document.getElementById('panel').classList.add('open');
}
function render(s){
  STATE = s;
  // 没有工作区时给出**明确指引**（而不是显示一个空看板让人以为坏了）
  const bar = document.getElementById('needRoot');
  if (bar) {
    if (s.needsRoot) {
      bar.style.display = '';
      bar.innerHTML = '未选择工作区 —— 请在右上角选择，或先在该项目里运行一次 <code>devflow init</code>。'
        + '（下拉里会列出你登记过的项目）';
    } else { bar.style.display = 'none'; }
  }
  drawStats(s); drawLanes(s);
  document.getElementById('at').textContent = fmtLocal(s.generatedAt);
  // 回显**实际服务的根**：切错工作区时能立刻看出来，而不是默默显示别人的数据
  if (s.servedRoot) document.getElementById('wsInput').value = s.servedRoot;
}

// 把数据流的真实状态报给宿主面板。**这是面板唯一能看见"流被浏览器拦掉"的通道**：
// 面板与看板不同源，它自己探测不到内嵌页里发生的事（见 plugin/README.md「踩过的坑之四」）。
function report(status){
  if (window.parent === window) return;   // 直接打开时没有父页
  try { window.parent.postMessage({ source:'devflow-board', status:status }, '*'); } catch (e) { /* 忽略 */ }
}
// ── 工作区（每个请求带 root；选择记忆在 localStorage）──────────────
/**
 * localStorage 的安全包装。
 *
 * 为什么必须有：在**沙箱 iframe 且缺 allow-same-origin** 的宿主里（例如某些面板/预览），
 * 访问 localStorage 会直接抛 SecurityError:
 *   "The document is sandboxed and lacks the 'allow-same-origin' flag."
 * 而这一行在脚本最前面 —— 抛出去会让**整段 JS 不执行**：SSE 不会建立、错误处理不会绑定，
 * 页面永远停在"连接中…"，统计与任务卡全空，且一句提示都没有（实测踩到）。
 *
 * 用内存兜底后：脚本能跑完 → SSE 该失败就失败 → 页面上给出可读的原因与解法。
 */
const SAFE_STORAGE = (() => {
  try {
    const probe = '__devflow_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch (e) {
    const mem = new Map();
    return {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => { mem.set(k, String(v)); },
      removeItem: (k) => { mem.delete(k); },
      __memoryOnly: true,
    };
  }
})();
let ROOT = SAFE_STORAGE.getItem('devflow.root') || '';
const withRoot = (p) => p + (ROOT ? (p.includes('?') ? '&' : '?') + 'root=' + encodeURIComponent(ROOT) : '');

async function loadRoots(){
  try {
    const d = await (await fetch('/api/roots')).json();
    document.getElementById('wsList').innerHTML = (d.roots || []).map((x) =>
      '<option value="'+esc(x.path || x)+'">'+esc(x.name || '')+'</option>').join('');
  } catch {}
}
function applyRoot(next){
  ROOT = next || '';
  if (ROOT) SAFE_STORAGE.setItem('devflow.root', ROOT); else SAFE_STORAGE.removeItem('devflow.root');
  document.getElementById('wsInput').value = ROOT;
  syncViewLink();
  startStream();                      // 换根 ⇒ 重建订阅
}
/** 文档视图入口跟随当前工作区：切了仓，"文档视图"按钮也指向同一个仓 */
function syncViewLink(){
  const a = document.querySelector('a.navview');
  if (a) a.href = '/view' + (ROOT ? '?root=' + encodeURIComponent(ROOT) : '');
}
document.getElementById('wsApply').onclick = () => applyRoot(document.getElementById('wsInput').value.trim());
document.getElementById('wsReset').onclick = () => applyRoot('');
document.getElementById('wsInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') applyRoot(e.target.value.trim());
});

// 实时刷新：EventSource（SSE）。断线自动重连由浏览器负责。
let es = null;
// 卸载标记：导航/关闭不该被当成"数据流失败"
let UNLOADING = false;
window.addEventListener('pagehide', () => { UNLOADING = true; });
window.addEventListener('beforeunload', () => { UNLOADING = true; });

function startStream(){
  if (es) { try { es.close(); } catch {} }
  es = new EventSource(withRoot('/api/stream'));
  es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
  es.onopen = () => { document.getElementById('live').className='dot-live';
    document.getElementById('liveTxt').textContent='实时'; report('open'); };
  es.onerror = () => {
    // 页面正在卸载（例如用户点了「文档视图」跳走）会把 EventSource 拆掉，
    // 这也会触发 onerror —— 那是**导航**，不是数据流故障，报 error 会让宿主误判 blocked。
    if (UNLOADING) return;
    document.getElementById('live').className='dot-live off';
    document.getElementById('liveTxt').textContent='已断开，重连中…';
    report('error');
    // 数据全部走 SSE：连不上就是整页空白。把**原因与解法**写在页面上，
    // 否则用户只看到"连接中…"，以为服务没起来（实测踩到：CORS 被拦时毫无线索）。
    const box = document.getElementById('connFail');
    if (!box || box.dataset.shown) return;
    box.dataset.shown = '1';
    box.style.display = 'block';
    box.innerHTML = '<b>实时数据流没有连上，所以统计与任务卡是空的。</b>'
      + '<div class="cf-sub">最常见的原因：本页被嵌在 <code>sandbox</code> iframe 里，而 sandbox 少了 '
      + '<code>allow-same-origin</code> —— 此时文档的源是 opaque 的 <code>null</code>，'
      + '对本站的 SSE 请求会被浏览器按 CORS 拒绝。</div>'
      + '<div class="cf-sub">怎么解决：① 让宿主给 iframe 加 <code>allow-same-origin</code>'
      + '（看板与宿主本就跨源，安全性不变）；或 ② 直接在浏览器打开 '
      + '<a href="' + location.href.replace(/[?#].*$/, '') + '" target="_blank" rel="noopener">这个地址</a>。</div>'
      + '<div class="cf-sub">排查：在 DevTools Console 里执行 '
      + '<code>new EventSource("' + withRoot('/api/stream') + '")</code>，'
      + '若报 Access-Control-Allow-Origin 相关错误，即命中本条。</div>'; };
}
document.getElementById('wsInput').value = ROOT;
loadRoots();
syncViewLink();
startStream();
</script>
</body></html>`;
}

// ── 服务 ───────────────────────────────────────────────────

export function startBoard({ projectRoot, port = 8787, intervalMs = 2000, onReady, onError, viewHtml }) {
  /** 默认根（启动时确定）；每个请求都可以用 ?root= 覆盖 */
  const defaultRoot = projectRoot;

  /**
   * 校验一个候选根。
   *
   * 为什么要有这一步：`?root=` 来自浏览器，**不能盲信** —— 只接受"看起来是项目/工作区"的目录
   * （含 .devflow/、devflow.json、devflow.workspace.json）。无效则回退默认根。
   * 这样服务可以服务任意工作区（一个端口、不用重启），而不会变成任意路径读取器。
   */
  const MARKERS = ['.devflow', 'devflow.json', 'devflow.workspace.json'];
  const isRoot = (d) => Boolean(d) && existsSync(d) && MARKERS.some((x) => existsSync(path.join(d, x)));
  function resolveRoot(candidate) {
    if (!candidate) return isRoot(defaultRoot) ? defaultRoot : null;
    try {
      const abs = path.resolve(String(candidate));
      if (isRoot(abs)) return abs;
      return isRoot(defaultRoot) ? defaultRoot : null;   // 无效候选：回落默认（可能为 null）
    } catch { return isRoot(defaultRoot) ? defaultRoot : null; }
  }

  /** 已知工作区候选：默认根本身 + 它的兄弟目录 + 常见位置（供面板下拉用） */
  function knownRoots() {
    const out = new Map();                       // path -> 简短名（面板下拉更可读）
    const add = (d, name) => { if (isRoot(d)) out.set(d, name || path.basename(d)); };
    add(defaultRoot);

    // ① **用户登记过的项目**（devflow init / setup 时写入）—— 这是别人机器上最可靠的来源：
    //    插件猜不到用户有哪些项目，但用户自己跑过 init 的项目在这里。
    // 必须与写入方（rememberProject）**同一套位置**：它也尊重 DSH_HOME。
    // 只读 ~/.dsh 会导致"写进去了却列不出来"（实测踩到）。
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    for (const f of [path.join(dshHome, 'devflow-kit.json'),
                     path.join(os.homedir(), '.config', 'devflow', 'config.json')]) {
      try {
        const cfg = JSON.parse(readFileSync(f, 'utf8'));
        for (const p of cfg.knownProjects || []) add(p);
      } catch { /* 无此文件 */ }
    }

    // ② 工作区的**成员仓**：这才是"在项目之间切换"的实际诉求
    try {
      if (!defaultRoot) throw new Error('no root');
      const wsFile = path.join(defaultRoot, 'devflow.workspace.json');
      if (existsSync(wsFile)) {
        const ws = JSON.parse(readFileSync(wsFile, 'utf8'));
        for (const m of ws.members || []) add(path.join(defaultRoot, m.path || m.name || m.repo), m.name);
      }
    } catch { /* 忽略 */ }

    // ③ 兄弟目录里像项目/工作区 的（多工作区并排时的另一处来源）
    try {
      if (!defaultRoot) throw new Error('no root');
      const parent = path.dirname(defaultRoot);
      for (const name of readdirSync(parent)) {
        const d = path.join(parent, name);
        try { if (statSync(d).isDirectory()) add(d); } catch { /* 跳过 */ }
      }
    } catch { /* 忽略 */ }
    return [...out.entries()].map(([p, n]) => ({ path: p, name: n }));
  }

  const snapshotFor = (root) => JSON.stringify(collectBoardState(root));
  /**
   * 去重签名：**必须排除 generatedAt**。
   * 踩过的坑：generatedAt 每次重建都变 ⇒ 快照字符串每次不同 ⇒ 去重失效，
   * 于是服务每 2 秒推一帧、前端每 2 秒全量重绘一次（正在展开的卡片会被冲掉，实测发现）。
   */
  const keyFor = (root) => {
    const { generatedAt, ...rest } = collectBoardState(root);
    return JSON.stringify(rest);
  };

  /** 客户端 → 它订阅的根（每请求根：同一个服务可同时服务多个工作区） */
  const clients = new Map();     // res -> root
  const lastKeys = new Map();    // root -> 上次签名

  const timer = setInterval(() => {
    // 按**当前有人订阅的根**逐个检查（没人看的根不计算，省开销）
    for (const root of new Set(clients.values())) {
      let key;
      try { key = keyFor(root); } catch { continue; }
      const last = lastKeys.get(root) || '';
      const watchers = [...clients.entries()].filter(([, r]) => r === root).map(([res]) => res);
      if (key === last) {
        // 无变化：不推快照，但**必须发心跳** —— 否则连接空闲会被浏览器/代理判为断开。
        // （修去重时曾把保活一起删掉，实测面板一直显示"已断开，重连中…"）
        for (const res of watchers) { try { res.write(': ping\n\n'); } catch { /* 忽略 */ } }
        continue;
      }
      lastKeys.set(root, key);
      let payload;
      try { payload = snapshotFor(root); } catch { continue; }
      for (const res of watchers) { try { res.write(`data: ${payload}\n\n`); } catch { /* 忽略 */ } }
    }
  }, intervalMs);
  timer.unref?.();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderBoardHtml(defaultRoot ? path.basename(defaultRoot) : '（未选择工作区）'));
      return;
    }
    if (url.pathname === '/api/roots') {
      // 面板的工作区下拉数据源
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ default: defaultRoot, roots: knownRoots() }));
      return;
    }
    if (url.pathname === '/api/state') {
      const root = resolveRoot(url.searchParams.get('root'));
      let body;
      try { body = JSON.stringify({ ...JSON.parse(snapshotFor(root)), servedRoot: root }); }
      catch (e) { body = JSON.stringify({ error: e.message, servedRoot: root }); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/stream') {
      const root = resolveRoot(url.searchParams.get('root'));
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      clients.set(res, root);
      try {
        res.write(`data: ${snapshotFor(root)}\n\n`);
        lastKeys.set(root, keyFor(root));
      } catch { /* 忽略 */ }
      req.on('close', () => clients.delete(res));
      return;
    }
    // /view —— **完整文档视图**（把 devflow view 的单文件视图按需渲染到这里）。
    // 有了它，用户只需要记一个地址：http://127.0.0.1:<port>/view
    // （静态文件仍可单独生成/转发，二者是同一份数据的两种取用方式）
    if (url.pathname === '/view' || url.pathname === '/view/') {
      try {
        // 跟随工作区：与 /api/state 同一套 root 解析规则，
        // 这样看板下拉切到哪个仓，/view 就渲染哪个仓。
        const vRoot = resolveRoot(url.searchParams.get('root'));
        const html = typeof viewHtml === 'function' ? viewHtml(vRoot) : null;
        if (!html) {
          res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
          res.end('视图暂不可用（服务未提供渲染器）');
          return;
        }
        // 告诉宿主：这是**静态文档视图**，本来就不需要 SSE。
        // 少了这条，面板会把之前在看板上判定的 blocked 状态一直挂在文档视图上方（实测踩到）。
        const tellStatic = '<script>try{window.parent.postMessage('
          + '{source:"devflow-board",status:"static"},"*")}catch(e){}</script>';
        // 注入回链：/view 是通过服务打开的，给用户一条回到实时看板的路
        const back = '<a href="/" style="position:fixed;right:18px;bottom:18px;z-index:999;'
          + 'background:#1d4ed8;color:#fff;padding:9px 15px;border-radius:999px;text-decoration:none;'
          + 'font:13px/1 -apple-system,BlinkMacSystemFont,\'PingFang SC\',sans-serif;'
          + 'box-shadow:0 6px 18px rgba(29,78,216,.35)">← 返回看板</a>';
        const outHtml = html.includes('</body>')
          ? html.replace('</body>', tellStatic + back + '</body>')
          : html + tellStatic + back;
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(outHtml);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('视图渲染失败：' + (e && e.message ? e.message : e));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  // 端口被占用时不要把裸 Node 栈抛给用户（实测 EADDRINUSE 会直接 crash 掉进程），
  // 交给调用方决定文案与退出码。
  server.on('error', (err) => {
    if (onError) onError(err);
    else throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    const addr = `http://127.0.0.1:${port}`;
    onReady?.(addr);
  });
  const stop = () => { clearInterval(timer); for (const c of clients.keys()) { try { c.end(); } catch { /* 忽略 */ } } server.close(); };
  return { server, stop, port, defaultRoot, resolveRoot, knownRoots };
}
