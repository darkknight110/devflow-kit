#!/usr/bin/env node
/**
 * 跨仓契约扫描器（只读，不修改任何文件）。
 *
 * 解决问题：后端 Spring Controller 是端点的事实来源，前端各仓按自己的记忆/旧快照调用，
 * 于是出现「前端调用的端点后端根本没有」这类**类型检查完全抓不到**的漂移
 * （真实案例：小程序调 POST /api/marketing/coupon/use 与 /coupon/refund，后端均不存在）。
 *
 * 做法：
 *   1. 解析后端所有 *Controller.java：类级 @RequestMapping + 方法级 @Get/Post/Put/Delete/Patch Mapping，
 *      正确处理「无参注解」「value = "..."」「注解与路径跨行」「排除 @RequestMapping(method=...)」；
 *   2. 解析前端 *.ts 的 post/get/put/del 调用路径与 HTTP 方法（模板变量归一化，去查询串）；
 *   3. 输出漂移清单：前端调了但后端无匹配端点。
 *
 * 用法：
 *   node tools/contract-scan.mjs --workspace <工作区根> [--json] [--backend <仓名>] [--frontend a,b]
 *   环境变量 DEVFLOW_WORKSPACE 亦可指定工作区根。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const HTTP_ANNOTATIONS = ['Get', 'Post', 'Put', 'Delete', 'Patch'];

/** 去掉 // 行注释与 /* *\/ 块注释，避免注释里的注解被误读 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** 提取注解参数里的第一个字符串字面量（支持 value = "x" / "x" / 多路径 {"a","b"}） */
function firstStringLiterals(annotationArgs) {
  const out = [];
  const re = /"([^"]*)"/g;
  let m;
  while ((m = re.exec(annotationArgs)) !== null) out.push(m[1]);
  return out;
}

function joinPath(base, sub) {
  const b = (base || '').replace(/\/+$/, '');
  const s = (sub || '').replace(/^\/+/, '');
  if (!b) return '/' + s;
  if (!s) return b || '/';
  return `${b}/${s}`;
}

/** 从 controller 源码抽取端点 */
export function extractEndpoints(src, file) {
  const clean = stripComments(src);
  const endpoints = [];

  // 类级 @RequestMapping（取第一个）
  const clsMatch = clean.match(/@RequestMapping\s*\(([\s\S]*?)\)/);
  const classBase = clsMatch ? (firstStringLiterals(clsMatch[1])[0] || '') : '';

  // 方法级注解：逐个扫描 @XxxMapping
  const re = /@(Get|Post|Put|Delete|Patch|Request)Mapping\s*(\([\s\S]*?\))?/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const kind = m[1];
    const args = m[2] || '';
    if (kind === 'Request') {
      // 方法级 @RequestMapping(method = RequestMethod.POST, value = "...")
      const methodMatch = args.match(/RequestMethod\.(GET|POST|PUT|DELETE|PATCH)/);
      if (!methodMatch) continue; // 无 method 的 @RequestMapping 不构成具体端点（或为类级，已处理）
      const paths = firstStringLiterals(args);
      const sub = paths.find((p) => !/^[A-Z_]+$/.test(p)) || '';
      endpoints.push({ verb: methodMatch[1], path: joinPath(classBase, sub), file, kind: 'RequestMapping+method' });
      continue;
    }
    const verb = kind.toUpperCase();
    const paths = firstStringLiterals(args);
    // 无参注解 @PostMapping 表示映射到类级路径本身
    const sub = paths.length ? paths[0] : '';
    endpoints.push({ verb, path: joinPath(classBase, sub), file, kind: `@${kind}Mapping` });
  }
  return endpoints;
}

/** 递归收集文件 */
function walk(dir, filter, acc = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return acc;
  }
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'dist' || e === 'target' || e === '.devflow') continue;
    const full = path.join(dir, e);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(full, filter, acc);
    else if (filter(full)) acc.push(full);
  }
  return acc;
}

/** 归一化路径：把 {var} 统一成 {x}，去掉查询串 */
export function normalizePath(p) {
  return p
    .split('?')[0]
    .replace(/\$\{[^}]*\}/g, '{x}')   // 前端模板插值 ${x} ⇒ {x}
    .replace(/\{[^}]*\}/g, '{x}')       // 后端路径变量 {var} ⇒ {x}
    .replace(/\/+$/, '') || '/';
}

/** 从后端仓抽端点清单 */
export function scanBackend(backendRoot) {
  const files = walk(backendRoot, (f) => f.endsWith('Controller.java'));
  const endpoints = [];
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    for (const ep of extractEndpoints(src, path.relative(backendRoot, f))) endpoints.push(ep);
  }
  return endpoints;
}

/**
 * 判断某个调用点是否"可达"：统计同一仓内对该调用所在导出符号的其他引用数。
 * 目的：区分「死代码里的陈旧调用」（删掉即可）与「用户真会走到的调用」（必须对齐契约）。
 * 判据保守：找不到承载符号时按"可达"处理（宁可多提醒，不可漏报）。
 */
function findEnclosingSymbol(src, index) {
  // 向前找最近的 export const NAME = 或 export function NAME
  const head = src.slice(0, index);
  const re = /export\s+(?:const|function|async\s+function)\s+([A-Za-z0-9_$]+)/g;
  let last = null;
  let m;
  while ((m = re.exec(head)) !== null) last = m[1];
  return last;
}

function countReferences(frontendRoot, symbol) {
  if (!symbol) return -1; // 未知 ⇒ 视为可达
  const files = walk(frontendRoot, (f) => /\.(ts|tsx|js)$/.test(f) && !f.includes('/test/'));
  let n = 0;
  const re = new RegExp(`\\b${symbol.replace(/\$/g, '\\$')}\\b`, 'g');
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    const matches = src.match(re);
    if (matches) n += matches.length;
  }
  return n;
}

/** 从前端仓抽调用清单 */
export function scanFrontend(frontendRoot) {
  const files = walk(frontendRoot, (f) => /\.(ts|tsx|js)$/.test(f) && !f.includes('/test/'));
  const calls = [];
  // 匹配 post<T>('/api/...'  /  get<T>(`/api/...`  等
  const re = /\b(post|get|put|del|patch)\s*(?:<[^>]*>)?\(\s*[`'"]([^`'"]+)[`'"]/g;
  for (const f of files) {
    let src;
    try {
      src = readFileSync(f, 'utf8');
    } catch {
      continue;
    }
    // **必须先剥注释**：被注释掉的调用（如 utils/share.ts 里 `// const res = await post('/api/share/poster', ...)`）
    // 不是真实调用，否则会产生假阳性（真实踩到过）。
    src = stripComments(src);
    let m;
    while ((m = re.exec(src)) !== null) {
      const method = m[1].toUpperCase().replace('DEL', 'DELETE');
      const raw = m[2];
      if (!raw.startsWith('/api')) continue; // 只看真正的接口路径
      const symbol = findEnclosingSymbol(src, m.index);
      // 模板里内联的查询串：`/a/${x}${cond ? '?k=v' : ''}` ⇒ 截到字面量 ? 之前再去掉尾部变量段
      // 只剥掉「内含查询串的条件表达式」外壳，保留普通路径变量：
      //   `/a/${userId}`            ⇒ 原样保留
      //   `/a/${id}${c ? '?x=1' : ''}` ⇒ `/a/${id}`
      //   `/a/${id}/cancel${c ? '?r=' + r : ''}` ⇒ `/a/${id}/cancel`
      // 归一化前端路径：末尾承载查询串的模板变量段要丢掉
      //   `/a/${orderNo}/cancel${query}` ⇒ `/a/${orderNo}/cancel`（query 里是 "?reason=..."）
      //   `/a/tree${query}`             ⇒ `/a/tree`
      // 判据：末尾 ${...} 段内部的字面量里出现 `?`。非查询串的变量（如 /${userId}）保留。
      const cleaned = raw
        .replace(/\$\{[^}]*['"]\?[^}]*\}/g, '')        // 条件表达式含 ? ⇒ 整段丢
        .replace(/\$\{[^}]*\?[^}]*\}$/, '')            // 末尾变量内部含 ? ⇒ 丢该段
        .split("'?")[0]
        .split('"?')[0];
      calls.push({
        method,
        path: normalizePath(cleaned),
        rawPath: raw,
        file: path.relative(frontendRoot, f),
        line: src.slice(0, m.index).split('\n').length,
        symbol,
        // 引用数（含定义行自身）==1 表示只有定义、无人调用 ⇒ 死代码
        refCount: countReferences(frontendRoot, symbol),
      });
    }
  }
  return calls;
}

/** 前端路径去掉网关服务前缀，便于与后端路径比较 */
/**
 * 段级路径匹配：后端路径里的 {var} 视为通配符（匹配任意一段），字面量段必须相等。
 * 这样 `/technician/me` 能匹配 `/technician/{technicianId}`（真实存在），
 * 而 `/technician/me/extra` 段数不同则不匹配。
 */

/**
 * 逐段严格比较：返回 match / literal-mismatch / length-mismatch。
 * 与 pathMatches 的区别：本函数**不**允许"前端字面量 ↔ 后端变量段"被视为同资源，
 * 因此不会把 `/categories/tree` 误算成 `/categories/{id}`（复核实测的误报根因）。
 */
export function compareSegments(callerPath, backendPath) {
  const isVar = (seg) => /^\$?\{[^}]*\}$/.test(seg) || /^.*\$?\{[^}]*\}$/.test(seg);
  const segs = (p) => p.split('?')[0].split('/').filter(Boolean);
  // 「字面量+变量」段（tree{x}）剥掉变量尾巴，按字面段处理；纯变量段才是通配
  const strip = (s) => (/^\$?\{[^}]*\}$/.test(s) ? '{x}' : s.replace(/\$?\{[^}]*\}$/, ''));
  const a = segs(callerPath).map(strip);
  const b = segs(backendPath).map(strip);
  if (a.length !== b.length) return { kind: 'length-mismatch' };
  let sawLiteralMismatch = false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] === b[i]) continue;
    if (b[i] === '{x}') continue;          // 后端变量段：可通配任意前端段
    sawLiteralMismatch = true;             // 后端字面段与前端不同 ⇒ 是不同资源
  }
  return { kind: sawLiteralMismatch ? 'literal-mismatch' : 'match' };
}

export function pathMatches(callerPath, backendPath) {
  // 归一化：整段变量 ⇒ {x}；前缀+变量（tree${x}）⇒ 保留前缀并标记为前缀通配 tree*
  const normSeg = (seg) => {
    if (/^\$?\{[^}]*\}$/.test(seg)) return '{x}';
    const m = seg.match(/^(.*?)\$?\{[^}]*\}$/);
    if (m && m[1]) return m[1] + '*';
    return seg;
  };
  const segs = (p, shell) =>
    p.split('?')[0]
      .split('/')
      .filter(Boolean)
      .map((seg) => (shell ? seg.replace(/^\$?\{[^}]*\}$/, '{x}') : seg));
  // 前端：模板插值段归一为 {x}；后端：**保留字面段**，只有 {var} 段才是通配符
  const a = segs(callerPath, false).map(normSeg);
  const b = segs(backendPath, false).map(normSeg);
  if (a.length !== b.length) return false;
  /**
   * 段匹配规则（定稿）：
   *   1. 完全相同 ⇒ 匹配；
   *   2. 前端是**字面量**、后端是变量段（如 me vs {id}）⇒ 匹配（字面量是变量域内的合法取值）；
   *   3. 前端是带前缀的动态段（tree${x} ⇒ tree*），后端是纯变量 {id} ⇒ **不匹配**
   *      （tree 是"分类树"，与"按 id 取单个分类"不是同一资源；这是真实漂移，必须报出来）；
   *   4. 双方都是前缀动态段 ⇒ 前缀相同才匹配。
   */
  const segMatch = (x, y) => {
    if (x === y) return true;
    const pre = (v) => (v.endsWith('*') ? v.slice(0, -1) : null);
    const px = pre(x), py = pre(y);
    if (px !== null && py !== null) return px === py;
    if (px !== null) return y !== '{x}' && y.startsWith(px);   // 前端动态：后端不能是纯变量
    if (py !== null) return x.startsWith(py);
    if (y === '{x}') return true;                              // 前端字面量 vs 后端变量 ⇒ 匹配
    if (x === '{x}') return y === '{x}';                       // 前端注入的变量段 vs 后端**字面量**段 ⇒ 不匹配（字面量是具体资源名）
    return false;
  };
  return a.every((seg, i) => segMatch(seg, b[i]));
}

export function stripGatewayPrefix(p) {
  // 网关前缀由调用方传入（不硬编码某个团队的网关名）
  return p;
}

export function detectBackendRepos(workspace) {
  const out = [];
  for (const e of readdirSync(workspace)) {
    const full = path.join(workspace, e);
    try {
      if (!statSync(full).isDirectory()) continue;
    } catch {
      continue;
    }
    if (!existsSync(path.join(full, '.git'))) continue;
    const ctrls = walk(full, (f) => f.endsWith('Controller.java'));
    if (ctrls.length) out.push(e);
  }
  return out.sort();
}

export function buildReport({ workspace, backendRepo, backendRepos, frontendRepos, gatewayPrefixes = [] }) {
  const repos = backendRepos && backendRepos.length ? backendRepos : [backendRepo];
  const endpoints = [];
  for (const r of repos) {
    const root = path.join(workspace, r);
    if (!existsSync(root)) continue;
    for (const ep of scanBackend(root)) endpoints.push({ ...ep, repo: r });
  }
  const index = new Map();
  for (const ep of endpoints) {
    const key = `${ep.verb} ${normalizePath(ep.path)}`;
    if (!index.has(key)) index.set(key, ep);
  }

  const backendPathVerbs = new Map();   // 路径模板 → 已注册动词集合
  for (const ep of endpoints) {
    const key = normalizePath(ep.path);
    if (!backendPathVerbs.has(key)) backendPathVerbs.set(key, new Set());
    backendPathVerbs.get(key).add(ep.verb);
  }

  const perFrontend = {};
  const allDrift = [];
  for (const repo of frontendRepos) {
    const calls = scanFrontend(path.join(workspace, repo));
    const drift = [];
    for (const c of calls) {
      let p = c.path;
      for (const pre of gatewayPrefixes) p = stripGatewayPrefix(p.replace(new RegExp(`^${pre}`), ''));
      const norm = normalizePath(p);
      const exact = index.has(`${c.method} ${norm}`);
      if (exact) continue;
      // 增强匹配（在 exact 失败后、判定漂移前）：
      // 处理"字面段 + 查询变量"形态 —— 前端 `tree${query}`（query 是 "?isService="）归一化后成 `tree{x}`，
      // 而后端是字面量 `tree`。这在**段级**上应视为同一资源（复核实测这两条被误报为缺失）。
      const withLiteralStripped = norm
        .split('/')
        .map((seg) => seg.replace(/\{[^}]*\}$/, (m) => (seg.length > m.length ? '' : m)))
        .join('/');
      if (index.has(`${c.method} ${withLiteralStripped}`)) continue;
      // 路径是否存在？——**必须逐段严格**：后端字面段要完全相同，只有后端变量段可通配。
      // 旧实现直接复用 pathMatches（它允许"前端字面量 ↔ 后端变量"），
      // 于是仅靠变量槽命中的调用会先 exact 失败、再被误判成"动词不符"，
      // 且会把后端变量段名当成动词列表打印出来（荒谬提示）。复核实测 3/9 条纯误报源于此。
      const samePathVerbs = new Set();
      const literalMismatch = [];
      for (const [bpath, verbs] of backendPathVerbs) {
        const cmp = compareSegments(norm, bpath);
        if (cmp.kind === 'match') verbs.forEach((v) => samePathVerbs.add(v));
        else if (cmp.kind === 'literal-mismatch') literalMismatch.push(bpath);
      }
      // 只要存在"字面段不同"的同形路径，就不能判为动词不符（那很可能是资源不同 ⇒ 应为端点缺失）
      if (literalMismatch.length && samePathVerbs.size) {
        for (const bpath of literalMismatch) {
          for (const v of backendPathVerbs.get(bpath) || []) samePathVerbs.delete(v);
        }
      }
      drift.push({
        ...c,
        normalized: norm,
        kind: samePathVerbs.size ? 'method_mismatch' : 'missing_endpoint',
        backendVerbs: [...samePathVerbs].sort(),
      });
    }
    perFrontend[repo] = { callCount: calls.length, drift };
    allDrift.push(...drift.map((d) => ({ repo, ...d })));
  }

  return {
    backendRepo,
    backendRepos: repos,
    endpointCount: endpoints.length,
    endpoints,
    index: [...index.keys()].sort(),
    perFrontend,
    drift: allDrift,
  };
}

function main() {
  const args = process.argv.slice(2);
  // 同时支持 `--flag value` 与 `--flag=value` 两种写法。
  // （曾只支持前者，导致 `--fail-on=none` 被静默忽略、退回默认值 —— 真实踩到过）
  const get = (name, dflt) => {
    const eq = args.find((a) => a.startsWith(`${name}=`));
    if (eq) return eq.slice(name.length + 1);
    const i = args.indexOf(name);
    return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : dflt;
  };
  const workspace = get('--workspace', process.env.DEVFLOW_WORKSPACE || process.cwd());
  // 刻意**不设内部仓库名默认值**：这类默认值只对某个团队成立，别人拿到会默认扫不存在的仓。
  // 未指定时给出明确用法，而不是猜。
  const backendRepo = get('--backend', null);
  const backendAll = args.includes('--all-backends');
  const frontendRepos = (get('--frontend', null) || '').split(',').map((s) => s.trim()).filter(Boolean);
  const asJson = args.includes('--json');
  // CI 用法：发现漂移时以非零退出码表达结论（默认 0，便于人工巡检时不打断）
  const failOnDrift = args.includes('--fail-on-drift');
  // 分级阈值：dead（死代码里的陈旧调用）默认不阻断；live（可达）默认阻断
  const failOn = get('--fail-on', 'live');   // live | any | none

  if (!backendRepo && !backendAll) {
    process.stderr.write('需要指定后端仓：--backend <仓名>（或用 --all-backends 扫描全部后端仓）\n');
    process.exitCode = 2;
    return;
  }
  if (backendRepo && !existsSync(path.join(workspace, backendRepo))) {
    process.stderr.write(`找不到后端仓：${path.join(workspace, backendRepo)}\n`);
    process.exitCode = 2;
    return;
  }
  const detected = detectBackendRepos(workspace);
  const report = buildReport({
    workspace, backendRepo, frontendRepos,
    backendRepos: backendAll ? detected : [backendRepo],
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    exitForDrift(report, { failOnDrift, failOn });
    return;
  }

  process.stdout.write(`跨仓契约扫描  工作区：${workspace}\n`);
  process.stdout.write(`  后端仓：${(report.backendRepos || [backendRepo]).join(', ')}　声明端点 ${report.endpointCount} 个（去重后 ${report.index.length}）\n\n`);
  for (const [repo, info] of Object.entries(report.perFrontend)) {
    process.stdout.write(`  ${repo}：调用 ${info.callCount} 条，未匹配后端端点 ${info.drift.length} 条\n`);
  }
  if (report.drift.length) {
    const line = (d) => {
      const extra = d.kind === 'method_mismatch' ? `  后端只接受 ${d.backendVerbs.join('/')}` : '';
      return `    ${d.method.padEnd(6)} ${d.normalized.padEnd(52)} ${d.repo}  ${d.file}:${d.line}`
        + `  [${d.symbol || '?'} 引用=${d.refCount < 0 ? '未知' : d.refCount}]${extra}\n`;
    };
    // 语义存疑：路径命中后端**变量槽**、但后端没有对应取值的特例（如 `me` 这类保留字），
    // 会返回空数据而不是 404 —— 比缺失更隐蔽，必须人工判定（复核实测：technician/me）。
    const POSIX_LOOKING = /\/(me|my|current|self|all)(\/|$)/i;
    const semanticSuspects = report.drift.filter((d) => POSIX_LOOKING.test(d.normalized));
    const groups = [
      ['A. 端点缺失 + 可达（最严重：用户真会走到，必然失败）',
        report.drift.filter((d) => d.kind === 'missing_endpoint' && d.refCount !== 1)],
      ['B. HTTP 动词不符 + 可达（路径在、方法错）',
        report.drift.filter((d) => d.kind === 'method_mismatch' && d.refCount !== 1)],
      ['C. 端点缺失 + 死代码（无人调用 ⇒ 删除即可）',
        report.drift.filter((d) => d.kind === 'missing_endpoint' && d.refCount === 1)],
      ['D. HTTP 动词不符 + 死代码',
        report.drift.filter((d) => d.kind === 'method_mismatch' && d.refCount === 1)],
    ];
    if (semanticSuspects.length) {
      process.stdout.write(`\n  ⚠ 需人工判定「语义错」（路径命中后端变量槽，但后端无该取值特例 ⇒ 返回空数据而非 404）：${semanticSuspects.length} 条\n`);
      for (const d of semanticSuspects) {
        process.stdout.write(`    ${d.method.padEnd(6)} ${d.normalized.padEnd(52)} ${d.repo}  ${d.file}:${d.line}\n`);
      }
    }
    for (const [title, list] of groups) {
      process.stdout.write(`\n  ${title}：${list.length} 条\n`);
      for (const d of list) process.stdout.write(line(d));
    }
  } else {
    process.stdout.write('\n  未发现漂移。\n');
  }
  process.stdout.write('\n  已知局限（务必按此判读）：\n');
  process.stdout.write('    ① 纯字符串匹配**无法判定资源的语义**：前端 /categories/tree（列表）与后端\n');
  process.stdout.write('       GET /categories/{id}（单条）在字符串上匹配，但语义不同 ⇒ 可能漏报，需人工看业务含义。\n');
  process.stdout.write('    ② 后端可能存在本工具未识别的映射形态（如自定义组合注解）⇒ 可能假阳性。\n');
  process.stdout.write('    ③ 查询串由**变量**承载时（如 `.../cancel${query}`，query="?reason=x"）无法静态判定，\n');
  process.stdout.write('       会被当成多一段路径 ⇒ 可能假阳性。已知两例：/orders/{no}/cancel、/supply/categories/tree。\n');
  process.stdout.write('    ⇒ 每条结论都必须人工核实后再据此改动代码。\n');

  exitForDrift(report, { failOnDrift, failOn });
}

/**
 * 按分级阈值决定退出码。
 *   live（默认）：可达调用里的漂移（用户真会走到）⇒ 非零
 *   any        ：任何漂移（含死代码）⇒ 非零
 *   none       ：恒 0（只报告）
 * 退出码约定：0 = 未达阈值；1 = 达到阈值；2 = 用法/环境错误。
 */
function exitForDrift(report, { failOnDrift, failOn }) {
  if (!failOnDrift || failOn === 'none') return;
  const live = report.drift.filter((d) => d.refCount !== 1);
  const hit = failOn === 'any' ? report.drift.length : live.length;
  if (hit > 0) {
    process.stderr.write(
      `\n契约漂移达到阈值（--fail-on=${failOn}）：${hit} 条，退出码 1\n`,
    );
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
