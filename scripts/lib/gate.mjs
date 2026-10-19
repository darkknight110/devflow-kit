/**
 * 门禁判定核心：G0..G7。
 *
 * 设计要点：
 *   - 判定规则来自 spec/*.json，尽量不在代码里散落；
 *   - 未知状态必须报错（不返回空需求、不默认放行）；
 *   - 负向对照缺失或恒真 ⇒ unverified（⚠），不阻断、也绝不给 pass；
 *   - 启发式门禁（G7）必须自带"存在漏报"的说明，不得当作硬保证。
 */
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { dirSizeKb, exists, findSection, keyValues, parseAcceptanceCriteria, parseApprovals, parseTasks, parseVerification, readText, listFiles, isRealValue } from './checks.mjs';
import { currentFingerprint } from './review.mjs';
import { instructionChainKb } from './manifest.mjs';

const MAX_EVIDENCE_FILES = 6;

function ok(gate, checks, extra = {}) {
  return { gate, verdict: 'pass', checks, notes: [], ...extra };
}
function bad(gate, checks, notes, extra = {}) {
  return { gate, verdict: 'blocked', checks, notes: Array.isArray(notes) ? notes : [notes], ...extra };
}
function warn(gate, checks, notes, extra = {}) {
  return { gate, verdict: 'unverified', checks, notes: Array.isArray(notes) ? notes : [notes], ...extra };
}
function exempt(gate, checks, notes, extra = {}) {
  return { gate, verdict: 'exempt', checks, notes: Array.isArray(notes) ? notes : [notes], ...extra };
}


/** 记录里是否声称"独立复核/独立验证" */
/**
 * 剥离"非声称"内容。
 *
 * 判据（经两次实测校准）：模板的填写指引**只出现在首个章节标题（`## `）之前**；
 * 其后的引用块是在写内容，**可能就是作者的声称**。
 *   · 曾经"剥掉全部引用块" ⇒ 把写在 `> ` 里的真实声称也放过了（SC32 实测抓到）。
 *   · 模板注释里的「独立复核」字样若不剥 ⇒ 还没做复核就被判"声称无留痕"。
 * 因此：剥 HTML 注释（全文）+ 剥**首章之前**的引用块（模板指引）。
 */
export function stripNonClaims(text) {
  const src = String(text || '').replace(/<!--[\s\S]*?-->/g, '');
  const i = src.indexOf('\n## ');
  const head = i < 0 ? src : src.slice(0, i);
  const body = i < 0 ? '' : src.slice(i);
  const headClean = head.split('\n').filter((l) => !/^\s*>/.test(l)).join('\n');
  return headClean + body;
}

export function isIndependentClaim(text) {
  return /独立(子代理|复核|验证|视角)/.test(stripNonClaims(text));
}

/**
 * 是否有真实复核留痕。
 * 判据（任一条即可）：
 *   - 出现具体复核方（子代理 id / 人名）且带时间戳；
 *   - 或写明"复核方 + 实测"并有逐条结论。
 * 刻意保持宽松：目的是拦住"只写一句我复核过了"，而不是为难正常记录。
 */
export function hasReviewEvidence(rawText) {
  const text = stripNonClaims(rawText);
  const t = String(text || '');
  const hasActor = /(子代理|agent|reviewer|复核人|复核方|验证者)[^\n]{0,40}(id|[0-9a-f]{8}|[:：]\s*\S)/i.test(t);
  const hasStamp = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(t);
  const hasMeasured = /(实测|退出码|原始输出|BUILD SUCCESS|Tests run)/.test(t);
  return hasActor && (hasStamp || hasMeasured) && hasMeasured;
}

/**
 * 通用「占位内容」检测：模板骨架可以过结构校验，但不能算"已填写"。
 *
 * 判据（只看**表格单元或列表项的内容**，不误伤说明性提示）：
 *   - 整个单元就是括号占位，如 `（姓名）`、`（ISO 时间）`、`（命令）`；
 *   - 二选一未选定，如 `通过 / 驳回`、`已实现 / 未实现 / 阻断`；
 *   - 明显的模板说明性文字（含"把判据写清楚""请替换"等）。
 * 目的：让"引擎会校验"这句话在**内容层**也成立，而不只是章节与列名。
 */
const PLACEHOLDER_CELL = [
  /^[（(][^）)]{0,40}[）)]$/,                       // （姓名） / （ISO 时间） / （命令）
  /通过\s*\/\s*驳回/,                                 // 二选一未选定
  /已实现\s*\/\s*未实现/,                             // 三态未选定
  /把判据写清楚/, /请替换/, /一句话一条/, /把.*替换为/,   // 模板说明性文字
];


/**
 * 产物路径解析（**统一入口**）。
 *
 * 存储正典 spec/storage.json：人写的产物（①②类）在 `.devflow/items/<变更>/`，
 * 机器状态（③类）在 `.devflow/.local/items/<变更>/`。二者已分离，
 * 但历史布局把两者放在 `items/` 里。
 *
 * 因此**任何按名字读产物的地方都必须用本函数**，否则会"找不到就静默跳过"——
 * 实测踩到：占位内容检查因读机器目录而完全失效（占位文档被判为通过）。
 */
export function resolveArtifactIn(itemDir, name) {
  const candidates = [path.join(itemDir, name)];
  const m = /^(.*)\/\.devflow\/\.local\/items\/([^/]+)$/.exec(itemDir);
  if (m) candidates.push(path.join(m[1], '.devflow', 'items', m[2], name));
  for (const c of candidates) if (existsSync(c)) return c;
  return null;
}

export function findPlaceholderContent(itemDir, artifacts) {
  const problems = [];
  for (const [file, schema] of Object.entries(artifacts.artifacts || {})) {
    if (schema.type !== 'markdown') continue;
    const full = resolveArtifactIn(itemDir, file);
    if (!full) continue;
    const text = readText(full) || '';
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (!/^\s*\|/.test(line)) continue;                 // 只看表格行
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;   // 跳过分隔行
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.replace(/\*\*/g, '').trim());
      for (const cell of cells) {
        if (!cell) continue;
        if (PLACEHOLDER_CELL.some((re) => re.test(cell))) {
          problems.push(`${file} 第 ${i + 1} 行仍是模板占位（「${cell.slice(0, 24)}」）—— 占位内容不算证据`);
          break;
        }
      }
    }
  }
  return [...new Set(problems)];
}

/** 读取变更目录的档位（来自 SPEC.md 身份表的档位字段） */
export function readTier(itemDir, states) {
  const spec = readText(resolveArtifactIn(itemDir, 'SPEC.md') || '');
  if (!spec) {
    // 微档不产生 SPEC：此时档位应来自 STATUS.json（创建时写入），不能退回默认值
    const status = readText(path.join(itemDir, 'STATUS.json'));
    if (status) {
      try {
        const parsed = JSON.parse(status);
        if (parsed.tier && states.tiers[parsed.tier]) return { tier: parsed.tier, source: 'STATUS.json' };
      } catch {
        /* 忽略损坏的 STATUS.json，走下面的默认 */
      }
    }
    return { tier: 'standard', source: 'default(no-spec)' };
  }
  const kv = keyValues(spec, ['身份']);
  const raw = (kv.tier || kv['档位'] || '').trim();
  // 约定：模板里写「中文名（english）」，例如 标（standard）；解析时优先取括号里的英文 token
  const english = /[（(]([a-z][a-z-]*)[）)]/i.exec(raw);
  const candidates = [];
  if (english) candidates.push(english[1].toLowerCase());
  const bare = raw.toLowerCase().replace(/[^a-z-]/g, '');
  if (bare) candidates.push(bare);
  for (const c of candidates) {
    if (states.tiers[c]) return { tier: c, source: 'SPEC' };
  }
  const cnMap = { 微: 'micro', 轻: 'light', 标: 'standard', 标准: 'standard', 重: 'heavy', 重量级: 'heavy' };
  for (const [cn, tier] of Object.entries(cnMap)) {
    if (raw.includes(cn)) return { tier, source: `SPEC(cn:${cn})` };
  }
  return { tier: 'standard', source: `default(unrecognized:${raw || 'empty'})` };
}

/** 读取变更面（来自 SPEC 身份表的 change_surface 字段） */
export function readChangeSurface(itemDir) {
  const spec = readText(resolveArtifactIn(itemDir, 'SPEC.md') || '');
  if (!spec) return [];
  const kv = keyValues(spec, ['身份']);
  const raw = (kv.change_surface || kv['变更面'] || '').trim();
  if (!raw) return [];
  return raw
    .split(/[,，、\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => ['contract', 'interface', 'data', 'auth', 'ui', 'copy', 'internal', 'docs', 'config'].includes(s));
}

/** 解析验证记录中的豁免条目 */
export function parseExemptions(itemDir) {
  const text = readText(resolveArtifactIn(itemDir, 'verification.md') || '');
  const out = [];
  for (const line of text.split('\n')) {
    if (/基线豁免|exempt/i.test(line) && !/^\s*\|?\s*-{2,}/.test(line)) out.push(line.trim());
  }
  return out;
}

/** 计算启发式信号：实际是否触碰了契约/接口面 */
function surfaceSignals(projectRoot, itemDir, gatesSpec) {
  const signals = { contract: [], interface: [] };
  const rel = (p) => path.relative(projectRoot, p);

  // ① 变更目录里直接出现契约类文件
  for (const f of listFiles(itemDir)) {
    if (/^CONTRACT\.md$/i.test(f) || /contract/i.test(f)) signals.contract.push(rel(path.join(itemDir, f)));
  }

  // ② 项目内匹配信号路径（仅限浅扫，避免大仓全盘遍历）
  const patterns = gatesSpec.gates?.G7?.surfaceSignals || {};
  for (const [bucket, globs] of Object.entries(patterns)) {
    const needles = globs
      .map((g) => g.replace(/\*\*\//g, '').replace(/\/\*\*/g, '').replace(/\*/g, '').replace(/\{.*?\}/g, '').replace(/\//g, ''))
      .filter((s) => s.length > 1);
    for (const f of listFiles(projectRoot, { skip: ['.devflow', 'node_modules', '.git', 'target', 'dist', 'build', '.next', 'coverage'] })) {
      const segs = f.toLowerCase().split('/');
      const hit =
        globs.some((g) => simpleGlobMatch(g, f)) ||
        needles.some((n) => {
          const needle = n.toLowerCase();
          if (needle.includes('.')) return f.toLowerCase().endsWith(needle);
          // 无扩展名的信号（dto/vo/types/...）：必须作为完整路径片段命中
          return segs.some((seg) => seg === needle);
        });
      if (hit) signals[bucket].push(f);
    }
  }
  return signals;
}

/** 极简 glob：支持 ** 前缀与 * 后缀 */
function simpleGlobMatch(glob, file) {
  const g = glob.replace(/^\*\*\//, '');
  if (g.startsWith('*.')) return file.toLowerCase().endsWith(g.slice(1).toLowerCase());
  if (g.includes('{')) {
    const [head, tailRaw] = g.split('{');
    const exts = tailRaw.replace('}', '').split(',');
    return exts.some((e) => file.toLowerCase().endsWith(`.${e.trim().toLowerCase()}`)) && file.includes(head.replace(/\*/g, ''));
  }
  const flat = g.replace(/\*/g, '');
  return flat.length > 2 && file.includes(flat);
}

/**
 * 执行全部 Kit 门禁。
 * @param {object} ctx { projectRoot, itemId, itemDir, state, kitSpec:{states,artifacts,gates,roles}, config, version, cwd }
 */
export function evaluateGates(ctx) {
  const { projectRoot, itemDir, state, kitSpec, config } = ctx;
  const { states, artifacts, gates: gatesSpec } = kitSpec;
  const results = [];

  // ── G0 项目配置有效 ────────────────────────────────────────
  const g0Notes = [];
  if (!exists(path.join(projectRoot, 'devflow.json'))) g0Notes.push('缺少 devflow.json');
  if (!config || !config.devflow) g0Notes.push('缺少 devflow 块');
  if (config && Object.keys(config.gates || {}).length === 0) g0Notes.push('未声明任何门禁');
  results.push(
    g0Notes.length
      ? bad('G0', ['projectConfigExists', 'hasDevflowBlock', 'gatesDeclared'], g0Notes, { evidence: { projectRoot } })
      : ok('G0', ['projectConfigExists', 'hasDevflowBlock', 'gatesDeclared'], { evidence: { projectRoot, declaredGates: Object.keys(config.gates || {}) } }),
  );

  // ── 状态有效性（G5 的一部分：未知状态必须报错） ─────────────
  if (!states.states[state]) {
    // 未知状态：只返回阻断结果，不得让任何门禁出现 pass
    return [
      bad('G0', ['noUnknownState'], [`未知状态：${state}（状态定义必须全量枚举，禁止默认放行）`], { evidence: { state } }),
      bad('G5', ['noUnknownState'], [`未知状态：${state}。状态定义必须全量枚举，禁止默认放行`], { evidence: { state } }),
    ];
  }
  const stateDef = states.states[state];
  const tierInfo = readTier(itemDir, states);
  const tierDef = states.tiers[tierInfo.tier] || { requiredArtifacts: [] };
  const profile = states.profiles[config.profile] || states.profiles.team;

  // ── G1 产物齐备 ───────────────────────────────────────────
  // 本状态应具备的产物 = 沿状态链累积的产物 ∩ 当前档位要求的产物
  // 说明：档位产物（如 release/report.md 对轻档）只有在走到对应状态时才要求，
  //       不能因为档位声明了就提前索要 —— 否则"刚新建就被要求交发布报告"。
  const requiredChain = stateChain(states, state, tierInfo.tier, ctx.actualState);
  const accumulate = new Set();
  for (const st of requiredChain) for (const f of states.states[st]?.required || []) accumulate.add(f);
  const required = new Set(
    [...accumulate].filter((name) => {
      const schema = artifacts.artifacts[name];
      if (!schema) return true;                              // 未登记 schema 的产物（如 STATE/STATUS.json）不因此豁免
      const t = schema.tier?.required;
      return !t || t.includes(tierInfo.tier);                // 登记了档位要求的，只在该档位要求
    }),
  );
  const missing = [];
  const sectionErrors = [];
  const present = [];
  // 产物解析：人写的产物在 `.devflow/items/<变更>/`（spec/storage.json ①②类），
  // 机器状态在 `.devflow/.local/items/<变更>/`（③类）。二者已分离，故这里两处都解析：
  // 以 `itemDir`（调用方通常传机器目录）为起点，回退到人写的目录。
  const resolveArtifact = (name) => resolveArtifactIn(itemDir, name);
  for (const name of required) {
    const full = resolveArtifact(name);
    if (!full) {
      missing.push(name);
      continue;
    }
    present.push(name);
    const schema = artifacts.artifacts[name];
    if (schema && schema.type === 'markdown') {
      const text = readText(full) || '';
      for (const need of schema.requiredSections || []) {
        if (!findSection(text, [need])) sectionErrors.push(`${name} 缺少必需章节：${need}`);
      }
      for (const [sectionName, spec] of Object.entries(schema.tables || {})) {
        const section = findSection(text, [sectionName]);
        if (!section) continue;
        for (const col of spec.requiredColumns || []) {
          const headerLine = section.body.split('\n').find((l) => /^\s*\|/.test(l)) || '';
          if (!headerLine.includes(col)) sectionErrors.push(`${name} 的「${sectionName}」表缺少列：${col}`);
        }
        const rows = section.body.split('\n').filter((l) => /^\s*\|/.test(l)).length - 1;
        if (spec.minRows && rows < spec.minRows) sectionErrors.push(`${name} 的「${sectionName}」表至少需要 ${spec.minRows} 行数据`);
      }
    }
  }
  if (process.env.DEVFLOW_DEBUG) {
    process.stderr.write(`[debug] G1 state=${state} tier=${tierInfo.tier} chain=${requiredChain.join('>')} missing=${missing.join(',')}\n`);
  }
  // 状态顺序取自正典（不依赖函数内后续声明的局部变量，避免 TDZ）
  const SPEC_ORDER = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'];
  // ── 澄清未决项：质量的第一道闸 ──
  // 规则：推进到 implementing（或更后）之前，需求澄清不得有未决项。
  // 依据：质量损失的最大来源是"没人问该问的问题"；允许未决项通过等于把风险带到实现阶段。
  const clarifyProblems = [];
  if (SPEC_ORDER.indexOf(state) >= SPEC_ORDER.indexOf('implementing')) {
    const cf = resolveArtifactIn(itemDir, 'CLARIFY.md');
    if (cf) {
      const ctext = readText(cf) || '';
      const rows = ctext.split('\n').filter((l) => /^\s*\|\s*[UQ]-\d+\s*\|/.test(l));
      const pend = rows.filter((l) => /\|\s*未决\s*\|?\s*$/.test(l.trim()) || /\|\s*未决\s*\|/.test(l));
      for (const l of pend) {
        const cells = l.split('|').map((x) => x.trim()).slice(1, -1);
        clarifyProblems.push(`需求澄清仍有未决项：${cells[0]}（${String(cells[1] || '').slice(0, 40)}）`);
      }
    }
  }

  const g1Problems = [...missing.map((m) => `缺少产物：${m}`), ...sectionErrors, ...clarifyProblems];
  results.push(
    g1Problems.length
      ? bad('G1', ['stateRequiredArtifactsExist', 'tierRequiredArtifactsExist', 'requiredSectionsPresent'], g1Problems, {
          evidence: { state, tier: tierInfo.tier, tierSource: tierInfo.source, requiredChain, present, missing, sectionErrors },
        })
      : ok('G1', ['stateRequiredArtifactsExist', 'tierRequiredArtifactsExist', 'requiredSectionsPresent'], {
          evidence: { state, tier: tierInfo.tier, tierSource: tierInfo.source, requiredChain, present, missing: [], sectionErrors: [] },
        }),
  );

  // ── 内容级检查：AC 判据、任务声明、验证对照、确认记录 ────────
  // 说明：确认点有"该填的时候"——在 verified 之前填不填只是提示，不该阻断推进；
  //       到 verified 才由硬约束收口。否则会出现"刚建变更就被要求交确认记录"的假阻断。
  const acNotes = [];
  const softNotes = [];
  const stateOrder = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'];

  const specText = readText(resolveArtifactIn(itemDir, 'SPEC.md') || '');
  const verText = readText(resolveArtifactIn(itemDir, 'verification.md') || '');
  const concatText = readText(resolveArtifactIn(itemDir, 'CONTRACT.md') || '');
  if (specText) {
    const acs = parseAcceptanceCriteria(specText);
    if (acs.length === 0 && tierInfo.tier !== 'micro') acNotes.push('SPEC 未给出任何验收标准（AC 表为空）');
    for (const ac of acs) {
      if (!ac.judgement || !ac.judgementType) acNotes.push(`${ac.id} 缺少判据或判据类型（判据必须可指向一次测试或一次可观测探测）`);
      else if (!['命令', '画面', '报告卡'].includes(ac.judgementType)) acNotes.push(`${ac.id} 判据类型非法：${ac.judgementType}（允许：命令/画面/报告卡）`);
    }
    // 任务追溯：只在 implementing 起要求（spec_ready 阶段还没拆任务）
    const tasksText = readText(resolveArtifactIn(itemDir, 'TASKS.md') || '');
    if (tasksText && acs.length && stateOrder.indexOf(state) >= stateOrder.indexOf('implementing')) {
      const tasks = parseTasks(tasksText);
      const acIds = new Set(acs.map((a) => a.id.replace(/\s/g, '')));
      for (const t of tasks) {
        if (!t.scope) acNotes.push(`${t.id} 未声明写入范围（子代理切分需要它）`);
        if (!t.command) acNotes.push(`${t.id} 未声明验收命令`);
        if (!t.ac) acNotes.push(`${t.id} 未对应任何验收标准（追溯链会断环）`);
        else if (![...acIds].some((id) => t.ac.replace(/\s/g, '').includes(id))) acNotes.push(`${t.id} 对应的验收标准不存在：${t.ac}`);
      }
    }
    // 验证记录覆盖：只在 verified 起要求 —— 在 spec_ready 就索要"验证覆盖"是时序错误
    if (verText && acs.length && stateOrder.indexOf(state) >= stateOrder.indexOf('verified')) {
      const rows = parseVerification(verText);
      const covered = new Set(rows.map((r) => r.ac.replace(/\s/g, '')));
      for (const ac of acs) {
        if (![...covered].some((c) => c.includes(ac.id.replace(/\s/g, '')))) acNotes.push(`验证记录缺少对 ${ac.id} 的对照`);
      }
    }
    // 不许"声称独立复核但没有任何留痕"—— 试点里真实发生过：
    // 记录先被填成"由独立子代理复核 + 全部已实现"，而复核其实还在进行中（顺序倒置 ⇒ 不构成独立证据）。
    if (verText && stateOrder.indexOf(state) >= stateOrder.indexOf('verified') && isIndependentClaim(verText)) {
      if (!hasReviewEvidence(verText)) {
        acNotes.push(
          '验证记录声称"独立复核"，但没有任何复核留痕 —— 必须写明复核方（独立子代理/他人）与其实测结论；'
          + '若是工程侧自测，请改掉"独立复核"措辞并使用 `advance --by engineer` 留痕',
        );
      }
    }

    const appText = readText(resolveArtifactIn(itemDir, 'APPROVALS.md'));
    if (appText) {
      // 占位内容不算证据：模板里的「（姓名）」「（ISO 时间）」「通过 / 驳回」都必须被真实填写。
        const isReal = isRealValue;   // 与 review/看板共用同一口径（避免两份实现）
      const approvals = parseApprovals(appText).filter((a) => isReal(a.who) && isReal(a.at) && isReal(a.verdict));
      // 确认点随状态递进：在 spec_ready 就要求"发布批准"是假阻断。
      //   需求与判据 → 进入 spec_ready 起
      //   契约冻结   → 进入 contracted 起
      //   发布批准   → 进入 verified 起（发布前）
      // 确认点：数量由**档位**决定，但**按状态递进**收集 ——
      //   spec_ready 起要「需求与判据」；contracted 起加「契约冻结」；verified 起加「发布批准」。
      // 两个坑都踩过：① 只看 verified 会让中间状态的预演索要全部确认点；
      //              ② 不看档位会让轻档被按重档索要三个确认点。
      const approvalProgression = [
        ['spec_ready', '需求与判据'],
        ['contracted', '契约冻结'],
        ['verified', '发布批准'],
      ];
      const byTier = {
        micro: [],
        light: ['需求与判据'],
        standard: ['需求与判据', '发布批准'],
        heavy: ['需求与判据', '契约冻结', '发布批准'],
      };
      const tierPoints = byTier[tierInfo.tier] || byTier.standard;
          const targetIdx = stateOrder.indexOf(state);
      const requiredPoints = approvalProgression
        .filter(([from, point]) => targetIdx >= stateOrder.indexOf(from) && tierPoints.includes(point))
        .map(([, point]) => point);
      // 签字必须绑定它所批准的内容：材料被改过 ⇒ 原签字**失效**，等同未签。
      // 放在门禁（而非只提示）才能真的拦住"签完再改"（实测确认过这个漏洞）。
      const stalePoints = [];
      const isStale = (pt) => {
        const rec = approvals.find((a) => String(a.point).includes(pt));
        if (!rec) return false;
        const was = String(rec.fingerprint || '').trim();
        if (!was || /^[（(]/.test(was)) return false;   // 旧格式/无指纹：不判定失效（避免误伤历史记录）
        const cur = currentFingerprint({
          point: pt,
          spec: pt === '需求与判据' ? specText : undefined,
          contract: pt === '契约冻结' ? contractText : undefined,
          verification: pt === '发布批准' ? verText : undefined,
        });
        if (!cur) return false;
        if (was !== cur) { stalePoints.push({ point: pt, was, cur }); return true; }
        return false;
      };
      const missingPoints = requiredPoints.filter((p) => !approvals.some((a) => String(a.point).includes(p)) || isStale(p));
      // 规模档不允许确认点时为 0 项
      const need = tierDef.approvals ?? profile.approvalsRequired ?? 0;
      // 硬约束只在 verified 收口一次：
      //   之前的状态是提示（避免"刚建变更就被要求交确认记录"的假阻断）；
      //   released 不再重复要求（发布批准是在进入 verified 时收紧的）。
      const message = `确认记录不足：本状态需要「${requiredPoints.join('、')}」，缺少「${missingPoints.join('、')}」的完整记录`;
      if (need > 0 && missingPoints.length) {
        if (state === 'verified') acNotes.push(message);
        else softNotes.push(`${message}（到 verified 状态会成为硬约束）`);
      }
    }
  }
  // 内容层：模板占位不算填写（这一次 F3 探针暴露的洞：占位内容曾能一路推进到 released）
  const placeholderProblems = findPlaceholderContent(itemDir, artifacts).filter((msg) => {
    // 攻略性提示（草稿期）不算：只对"已经声明要交付"的阶段收口
    const idx = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'].indexOf(state);
    return idx >= 5;   // verified 起硬约束
  });
  const contentNotes = [...acNotes, ...placeholderProblems];

  results.push(
    contentNotes.length
      ? bad('G1b', ['acceptanceCriteriaHaveJudgement', 'tasksTraceable', 'verificationCoversAllAC', 'approvalsRecorded', 'noPlaceholderContent'], contentNotes)
      : softNotes.length
        ? warn('G1b', ['acceptanceCriteriaHaveJudgement', 'tasksTraceable', 'verificationCoversAllAC', 'approvalsRecorded'], softNotes)
        : ok('G1b', ['acceptanceCriteriaHaveJudgement', 'tasksTraceable', 'verificationCoversAllAC', 'approvalsRecorded', 'noPlaceholderContent']),
  );

  // ── G2 证据形态（基于上一次 STATUS.json 的门禁记录） ──────────
  const statusPath = path.join(itemDir, 'STATUS.json');
  const status = exists(statusPath) ? JSON.parse(readText(statusPath) || '{}') : null;
  const records = status?.lastRun?.records || [];
  if (state === 'tested' || state === 'verified' || state === 'released') {
    // 证据形态：字段必须存在且类型正确。
    // 注意：成功的命令可能没有任何输出（outputTail 为空字符串）—— 那是合法证据，不是缺证据。
    const malformed = records.filter(
      (r) =>
        typeof r.command !== 'string' || r.command.trim() === '' ||
        r.exitCode === undefined || r.exitCode === null ||
        typeof r.outputTail !== 'string',
    );
    results.push(
      records.length === 0
        ? bad('G2', ['everyGateHasCommand', 'everyGateHasExitCode', 'everyGateHasOutputTail'], ['尚无可核门禁记录：先运行 devflow gate run'])
        : malformed.length
          ? bad('G2', ['everyGateHasCommand', 'everyGateHasExitCode', 'everyGateHasOutputTail'], malformed.map((r) => `${r.gate} 的记录缺少命令/退出码/输出尾部`))
          : ok('G2', ['everyGateHasCommand', 'everyGateHasExitCode', 'everyGateHasOutputTail'], { evidence: { records: records.length } }),
    );
  }

  // ── G4 上下文预算 ───────────────────────────────────────────
  const size = dirSizeKb(itemDir);
  const warnKb = config?.budget?.warn_kb ?? gatesSpec.gates.G4.warnKb;
  const blockKb = config?.budget?.block_kb ?? gatesSpec.gates.G4.blockKb;
  const chain = instructionChainKb(ctx.cwd || projectRoot, projectRoot);
  const chainLimit = gatesSpec.gates.G4.instructionChainLimitKb;
  const largest = size.files.filter((f) => f.file !== 'STATUS.json').slice(0, MAX_EVIDENCE_FILES);
  if (size.totalKb > blockKb) {
    results.push(bad('G4', ['itemArtifactsUnderBlock'], [`变更产物体积 ${size.totalKb}k 超过阻断线 ${blockKb}k，要求拆分变更`], {
      evidence: { itemKb: size.totalKb, blockKb, largestFiles: largest },
    }));
  } else if (size.totalKb > warnKb) {
    results.push(warn('G4', ['itemArtifactsUnderWarn'], [`变更产物体积 ${size.totalKb}k 超过警告线 ${warnKb}k`], {
      evidence: { itemKb: size.totalKb, warnKb, blockKb, largestFiles: largest },
    }));
  } else {
    results.push(ok('G4', ['itemArtifactsUnderWarn', 'itemArtifactsUnderBlock'], {
      evidence: { itemKb: size.totalKb, warnKb, blockKb, largestFiles: largest },
    }));
  }
  if (chain.kb > chainLimit) {
    results.push(warn('G4b', ['instructionChainUnderLimit'], [`指令链体积 ${chain.kb}k 超过上限 ${chainLimit}k：超限时宿主会优先丢弃较宽泛的文件`], {
      evidence: { instructionChainKb: chain.kb, instructionChainLimitKb: chainLimit, files: chain.files },
    }));
  } else {
    results.push(ok('G4b', ['instructionChainUnderLimit'], { evidence: { instructionChainKb: chain.kb, files: chain.files } }));
  }

  // ── G5 状态一致 ────────────────────────────────────────────
  // 注意：一致性比对的是「实际状态」（状态文件里的值），不是「目标状态」——
  // 推进时我们按目标状态校验产物，但 STATE 与 STATUS.json 仍应互相一致。
  // 若把目标状态拿来比对，首次推进会永远报"不一致"。
  const actual = ctx.actualState || state;
  if (status && status.state && status.state !== actual) {
    results.push(bad('G5', ['stateFileMatchesStatusJson'], [`STATE(${actual}) 与 STATUS.json(${status.state}) 不一致`]));
  } else {
    results.push(ok('G5', ['stateFileMatchesStatusJson', 'noUnknownState'], { evidence: { state: actual, evaluatingFor: state } }));
  }

  // ── G6 基线豁免合规 ─────────────────────────────────────────
  // 豁免声明：baseline_exempt（存量豁免）与 baseline_debt（债务包装）都算
  const exemptGates = Object.entries(config.gates || {})
    .map(([name, def]) => [name, def.baseline_exempt || def.baseline_debt, def])
    .filter(([, ex]) => Boolean(ex));
  const g6Notes = [];
  for (const [name, ex] of exemptGates) {
    if (!ex.reason) g6Notes.push(`${name} 的豁免未注明原因`);
    if (!ex.clear_when) g6Notes.push(`${name} 的豁免未注明清除条件（clear_when）`);
  }
  const surface = readChangeSurface(itemDir);
  const bigSurface = surface.some((s) => ['contract', 'interface', 'data', 'auth'].includes(s));
  // allowed_scope 是文档承诺的约束字段，必须真的校验（否则使用者会以为豁免有范围限制）
  const surfaceList = surface.filter(Boolean);
  for (const [name, ex] of exemptGates) {
    const scope = ex && ex.allowed_scope;
    if (!Array.isArray(scope) || !scope.length) continue;
    const outside = surfaceList.filter((sf) => !scope.some((a) => String(a).includes(sf) || sf.includes(String(a))));
    if (outside.length) {
      g6Notes.push(
        `本次变更面 ${outside.join('/')} 不在门禁 ${name} 的豁免 allowed_scope（${scope.join('/')}）内`
        + ' ⇒ 该豁免不覆盖这次改动，请补齐该门禁的判据或调整 allowed_scope',
      );
    }
  }
  if (exemptGates.length && bigSurface) g6Notes.push('本次变更触碰契约/接口/数据/鉴权面：不得引用基线豁免');
  if (exemptGates.length && profile.baselineExemptAllowed === false) g6Notes.push(`规模档 ${config.profile} 不允许基线豁免`);
  results.push(
    g6Notes.length
      ? bad('G6', ['exemptionDeclared', 'exemptionNotUsedForBigChange', 'exemptionHasClearCondition'], g6Notes)
      : exemptGates.length
        ? exempt('G6', ['exemptionDeclared', 'exemptionHasClearCondition'], [`存在基线豁免 ${exemptGates.length} 项：只减不增，须逐项消除`], {
            evidence: { exemptions: exemptGates.map(([n]) => n) },
          })
        : ok('G6', ['noExemptionForNewProject'], { evidence: { exemptions: [] } }),
  );

  // ── G7 变更面与档位匹配（启发式，会漏报） ────────────────────
  const signals = surfaceSignals(projectRoot, itemDir, gatesSpec);
  const touched = [...new Set([...surface.filter((s) => ['contract', 'interface'].includes(s)), ...(signals.contract.length ? ['contract'] : []), ...(signals.interface.length ? ['interface'] : [])])];
  if ((tierInfo.tier === 'light' || tierInfo.tier === 'micro') && touched.length) {
    results.push(warn('G7', ['tierMatchesChangeSurface'], [`档位为 ${tierInfo.tier}，但变更面涉及 ${touched.join('/')}：需人工确认是否应升档（启发式判断，可能漏报）`], {
      evidence: { tier: tierInfo.tier, changeSurface: surface, inspectedPaths: [...signals.contract, ...signals.interface].slice(0, MAX_EVIDENCE_FILES) },
    }));
  } else {
    results.push(ok('G7', ['tierMatchesChangeSurface'], { evidence: { tier: tierInfo.tier, changeSurface: surface } }));
  }

  // ── G8 产物运行时健全性：小程序的产物里不得残留 process.env ──
  // 依据真实演练（chaincloud-business-mp）：`.env` 里缺 TARO_APP_* 变量 ⇒ Taro 不替换该成员表达式
  //   ⇒ 产物残留 `process.env.X` ⇒ 小程序运行时**没有 process 全局对象** ⇒ app.js ReferenceError、
  //     所有页面"has not been registered yet"（整包不可用）。
  // 关键点：项目自己的 build 门禁**退出码仍是 0**（只看退出码、不看产物能不能跑）——
  //   这种"门禁谎报通过"必须由引擎兜住（本仓标准 STD-GATE-HONEST-EXIT 正是禁止它）。
  {
    const miniMarkers = ['project.config.json', 'project.private.config.json', 'src/app.config.ts', 'app.config.ts'];
    const isMiniProgram = miniMarkers.some((f) => existsSync(path.join(projectRoot, f)));
    const outDirs = ['dist', 'build', 'out']
      .map((d) => path.join(projectRoot, d))
      .filter((d) => existsSync(d));
    if (isMiniProgram && outDirs.length) {
      const hits = [];
      let scanned = 0;
      for (const dir of outDirs) {
        for (const rel of listFiles(dir)) {
          if (!rel.endsWith('.js')) continue;
          scanned += 1;
          const text = readText(path.join(dir, rel)) || '';
          if (text.includes('process.env')) hits.push(`${path.basename(dir)}/${rel}`);
        }
      }
      if (hits.length) {
        results.push({
          gate: 'G8',
          verdict: 'blocked',
          checks: ['artifactHasNoProcessEnv'],
          notes: [
            `产物里残留 process.env（${hits.length}/${scanned} 个 JS 文件，如 ${hits.slice(0, 3).join('、')}）：`
              + '小程序运行时没有 process 全局对象，启动即 ReferenceError、所有页面都会"未注册"',
            '常见原因：.env 里**未定义**该 TARO_APP_* 变量 —— Taro 只替换已定义的成员表达式，未定义的会原样进产物',
            '修法：在 .env（**build 所用 mode 的那份**，如 .env.production）补齐变量，或为 process.env 加兜底 define',
          ],
          evidence: { files: hits.slice(0, MAX_EVIDENCE_FILES), scanned },
        });
      } else {
        results.push(ok('G8', ['artifactHasNoProcessEnv'], {
          evidence: { scanned, dirs: outDirs.map((d) => path.basename(d)) },
        }));
      }
    }
  }

  return results;
}

/** 汇总门禁结果 */
export function summarize(results) {
  const byVerdict = { pass: 0, unverified: 0, exempt: 0, blocked: 0, fail: 0 };
  for (const r of results) byVerdict[r.verdict] = (byVerdict[r.verdict] || 0) + 1;
  const blocking = results.filter((r) => r.verdict === 'blocked' || r.verdict === 'fail');
  const unknownState = results.some((r) => r.gate === 'G5' && r.notes.some((n) => n.includes('未知状态')));
  return {
    ...byVerdict,
    blocking: blocking.length > 0,
    fatal: unknownState,
    blockingGates: blocking.map((r) => r.gate),
  };
}

/**
 * 计算某状态应具备产物的累积链：沿状态机向前回溯，取「当前档位可达」的路径。
 * 例：标准档 implementing 的链为 draft → spec_ready → contracted → implementing。
 */
export function stateChain(states, target, tier, from) {
  const order = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'];
  const chainable = new Set(order);
  const edges = new Map();
  for (const t of states.transitions || []) {
    if (!chainable.has(t.from) || !chainable.has(t.to)) continue;
    if (!edges.has(t.to)) edges.set(t.to, []);
    edges.get(t.to).push(t.from);
  }
  const seen = new Set();
  const walk = (node) => {
    if (!node || seen.has(node)) return;
    seen.add(node);
    for (const prev of edges.get(node) || []) walk(prev);
  };
  walk(target);
  // 关键：从「实际状态」起飞。跳过的状态（如标准档跳过 contracted）不应把它的产物算进来 ——
  // 否则"可选契约"就变成了"隐性强制契约"。
  const fromIdx = from ? order.indexOf(from) : 0;
  return order.filter((s, idx) => seen.has(s) && idx >= Math.max(0, fromIdx));
}
