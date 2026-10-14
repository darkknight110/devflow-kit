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
import { itemsDir, localItemsDir, machineDir, readStatus, rawState } from './state.mjs';
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
  const tasks = parseTasks(dir);
  const history = (status.history || []).map((e) => ({
    at: e.at, event: e.event || (e.from ? 'state' : 'other'),
    task: e.task || null, changes: e.changes || null,
    from: e.from || null, to: e.to || null, by: e.by || e.actor || null,
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

export function collectBoardState(projectRoot, opts = {}) {
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
 :root{--bg:#0f172a;--panel:#111c33;--card:#16233d;--bd:#25344f;--txt:#e6edf7;--mut:#8ba0bd;
   --todo:#64748b;--doing:#d97706;--done:#059669;--blocked:#dc2626;--accent:#3b82f6}
 *{box-sizing:border-box}
 body{margin:0;font:13px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC",Arial,sans-serif;
   background:var(--bg);color:var(--txt);-webkit-font-smoothing:antialiased}
 header{padding:14px 20px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
 h1{font-size:15px;margin:0;font-weight:600}
 .live{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--mut)}
 .dot-live{width:7px;height:7px;border-radius:50%;background:var(--done);box-shadow:0 0 6px var(--done)}
 .dot-live.off{background:var(--blocked);box-shadow:0 0 6px var(--blocked)}
 .stats{display:flex;gap:10px;padding:14px 20px;flex-wrap:wrap}
 .stat{background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:10px 14px;min-width:104px}
 .stat b{display:block;font-size:20px;line-height:1.25}
 .stat span{color:var(--mut);font-size:11px}
 main{padding:0 20px 26px}
 .lanes{display:grid;grid-template-columns:repeat(auto-fit,minmax(192px,1fr));gap:12px}
 .lane{background:var(--panel);border:1px solid var(--bd);border-radius:10px;padding:10px;min-height:120px}
 .lane h3{margin:0 0 8px;font-size:12px;color:var(--mut);display:flex;justify-content:space-between}
 .card{background:var(--card);border:1px solid var(--bd);border-left:3px solid var(--todo);border-radius:8px;
   padding:8px 10px;margin-bottom:8px;cursor:pointer}
 .card:hover{border-color:var(--accent)}
 .card.doing{border-left-color:var(--doing)} .card.done{border-left-color:var(--done)}
 .card.blocked{border-left-color:var(--blocked)}
 .card .t{font-weight:600;font-family:ui-monospace,Menlo,monospace}
 .card .meta{color:var(--mut);font-size:11px;margin-top:2px}
 .tag{display:inline-block;font-size:10px;border-radius:4px;padding:0 5px;margin-left:5px;vertical-align:1px}
 .req{border-left-color:var(--accent)}
 .panel{position:fixed;top:0;right:0;height:100%;width:min(460px,92vw);background:var(--panel);
   border-left:1px solid var(--bd);transform:translateX(102%);transition:transform .18s ease;overflow:auto;padding:18px}
 .panel.open{transform:none}
 .panel h2{font-size:14px;margin:0 0 4px}
 .panel .close{position:absolute;top:12px;right:14px;background:none;border:0;color:var(--mut);font-size:18px;cursor:pointer}
 .kv{display:grid;grid-template-columns:82px 1fr;gap:4px 10px;margin:10px 0}
 .kv dt{color:var(--mut);font-size:12px} .kv dd{margin:0}
 .tl{border-left:2px solid var(--bd);margin:12px 0 0 6px;padding-left:12px}
 .ev{position:relative;padding:4px 0;font-size:12px}
 .ev:before{content:'';position:absolute;left:-17px;top:9px;width:7px;height:7px;border-radius:50%;background:var(--accent)}
 .ev .at{color:var(--mut);font-size:11px}
 .muted{color:var(--mut)} footer{padding:12px 20px;color:var(--mut);font-size:11px;border-top:1px solid var(--bd)}
</style></head><body>
<header>
  <h1>devflow 看板 · ${projectName}</h1>
  <div class="live"><span id="live" class="dot-live"></span><span id="liveTxt">连接中…</span></div>
  <div class="live" style="margin-left:auto">更新于 <span id="at">—</span></div>
</header>
<div class="stats" id="stats"></div>
<main>
  <div class="muted" style="margin:0 0 6px">按状态分栏（任务级）</div>
  <div class="lanes" id="lanes"></div>
  <div class="muted" style="margin:18px 0 6px">按阶段（需求级）</div>
  <div class="lanes" id="stages"></div>
</main>
<aside class="panel" id="panel">
  <button class="close" onclick="document.getElementById('panel').classList.remove('open')">✕</button>
  <div id="panelBody"></div>
</aside>
<footer>v1 只读看板 · 数据直接读自 <code>.devflow/</code>（文件即真相）· 要改状态请在 CLI 或聊天里操作</footer>
<script>
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
    return '<div class="lane"><h3><span>'+KIND[k][0]+'</span><span>'+all.length+'</span></h3>'
      + (all.length ? all.map(([c,t]) => taskCard(c,t)).join('') : '<div class="muted" style="font-size:12px">—</div>')
      + '</div>';
  }).join('');
  document.getElementById('stages').innerHTML = s.stageCounts.map((st) => {
    const items = s.changes.filter((c) => c.state === st.state);
    return '<div class="lane"><h3><span>'+esc(STATE_NAME[st.state]||st.state)+'</span><span>'+st.count+'</span></h3>'
      + (items.length ? items.map((c) => '<div class="card req" onclick="openChange(\\''+esc(c.itemId)+'\\')">'
        + '<div class="t">'+esc(c.itemId)+'</div>'
        + '<div class="meta">'+esc(c.tier)+' · 确认 '+(c.approvalsDone||0)+'/'+(c.approvalsTotal||0)+' · 任务 '+c.counts.done+'/'+c.counts.total
        + (c.counts.blocked ? ' · <span style="color:var(--blocked)">阻塞 '+c.counts.blocked+'</span>' : '')+'</div></div>').join('')
        : '<div class="muted" style="font-size:12px">—</div>')
      + '</div>';
  }).join('');
}
function timeline(events){
  if (!events.length) return '<p class="muted">暂无事件记录</p>';
  return '<div class="tl">' + events.slice().reverse().map((e) => {
    const at = String(e.at||'').replace('T',' ').slice(0,19);
    let txt;
    if (e.event === 'task.update') txt = '任务 '+esc(e.task)+'：'+esc((e.changes||[]).join('；'));
    else if (e.event === 'clarify') txt = '澄清 '+esc(e.task||'')+esc(e.qid?(' '+e.qid):'');
    else if (e.event === 'gate-run') txt = '门禁运行 '+(e.verdict?esc(e.verdict):'');
    else if (e.from || e.to) txt = '状态 '+esc(e.from||'?')+' → '+esc(e.to||'?');
    else txt = esc(e.event);
    return '<div class="ev">'+txt+'<div class="at">'+at+(e.by?(' · '+esc(e.by)):'')+'</div></div>';
  }).join('') + '</div>';
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
    + '<dt>创建</dt><dd>'+esc(String(c.createdAt||'').slice(0,19).replace('T',' '))+'</dd>'
    + '<dt>更新</dt><dd>'+esc(String(c.updatedAt||'').slice(0,19).replace('T',' '))+'</dd></dl>'
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
  drawStats(s); drawLanes(s);
  document.getElementById('at').textContent = String(s.generatedAt).replace('T',' ').slice(0,19);
}

// 实时刷新：EventSource（SSE）。断线自动重连由浏览器负责。
const es = new EventSource('/api/stream');
es.onmessage = (e) => { try { render(JSON.parse(e.data)); } catch {} };
es.onopen = () => { document.getElementById('live').className='dot-live';
  document.getElementById('liveTxt').textContent='实时'; };
es.onerror = () => { document.getElementById('live').className='dot-live off';
  document.getElementById('liveTxt').textContent='已断开，重连中…'; };
</script>
</body></html>`;
}

// ── 服务 ───────────────────────────────────────────────────

export function startBoard({ projectRoot, port = 8787, intervalMs = 2000, onReady }) {
  const clients = new Set();
  const snapshot = () => JSON.stringify(collectBoardState(projectRoot));

  // 变更广播：轮询文件（文件即真相，无需采集层）；内容变了才推
  let last = '';
  const timer = setInterval(() => {
    let cur;
    try { cur = snapshot(); } catch { return; }
    if (cur !== last) { last = cur; for (const res of clients) res.write(`data: ${cur}\n\n`); }
  }, intervalMs);
  timer.unref?.();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    if (url.pathname === '/' || url.pathname === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderBoardHtml(path.basename(projectRoot)));
      return;
    }
    if (url.pathname === '/api/state') {
      let body;
      try { body = snapshot(); } catch (e) { body = JSON.stringify({ error: e.message }); }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(body);
      return;
    }
    if (url.pathname === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      clients.add(res);
      try { res.write(`data: ${snapshot()}\n\n`); } catch { /* 忽略 */ }
      req.on('close', () => clients.delete(res));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });

  server.listen(port, '127.0.0.1', () => {
    const addr = `http://127.0.0.1:${port}`;
    onReady?.(addr);
  });
  const stop = () => { clearInterval(timer); for (const c of clients) { try { c.end(); } catch { /* 忽略 */ } } server.close(); };
  return { server, stop, port };
}
