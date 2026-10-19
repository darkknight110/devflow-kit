#!/usr/bin/env node
/**
 * devflow · 命令行入口（0 依赖，仅 node 内置模块）
 *
 * 命令：
 *   init        在当前项目写入 devflow.json 与目录骨架（可选 --force 覆盖）
 *   doctor      只读体检：门禁是否可信、配置是否可用（问题 + 依据 + 修法）
 *   adapters    技术栈适配器：列出 / 检测 / 应用（只补缺失）
 *   new        新建一个变更（不覆盖任何已有内容）
 *   fill       按模板补齐缺失产物（不覆盖已存在文件）
 *   status      单个变更 / 全项目 / 全工作区的状态
 *   gate run    执行项目门禁并记录证据，随后评估 G0..G7
 *   advance     推进状态（门禁未通过则拒绝；--force 留痕）
 *   report      生成静态 HTML 看板（只读视图）
 *   archive     归档已完成变更（默认空跑）
 *   selfcheck   门禁体系自检（负向对照自己也要被验证）
 *   version     版本信息
 *
 * 通用参数：--json 机器可读 | --root <目录> | --help
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  KIT_ROOT,
  defaultProjectConfig,
  findProjectRoot,
  resolveProjectRoot,
  findWorkspaceRoot,
  kitVersion,
  loadKitSpec,
  loadProject,
  gitFacts,
  instructionChainKb,
} from './lib/manifest.mjs';
import { createItem, evaluateItem, itemsDir, localItemsDir, machineDir, allItemIds, listItems, recordRun, advance, archive, readStatus, rawState, appendEvent, readEvents } from './lib/state.mjs';
import { humanEvent } from './lib/humanize.mjs';
import { evaluateGates, summarize, resolveArtifactIn } from './lib/gate.mjs';
import { runProjectGates } from './lib/evidence.mjs';
import { diagnose, SEVERITIES, mergeStandardBlockers } from './lib/doctor.mjs';
import { startBoard, collectBoardState, discoverProjectRoot } from './lib/board.mjs';
import { reviewPack, renderPack, currentFingerprint, staleInfo, fingerprint, specDigest } from './lib/review.mjs';
import { normalizeContract, diffContracts, renderDiff } from './lib/contract.mjs';
import { loadStandards, checkStandards } from './lib/standards.mjs';
import { renderTemplate, TEMPLATE_FILES } from './lib/template.mjs';
import { loadAdapters, detectAdapters, applyAdapter, auditAdapterRegex } from './lib/adapter.mjs';
import { dirSizeKb, exists, readText, parseAcceptanceCriteria, parseVerification, parseUnverifiedItems, parseApprovals, isRealValue } from './lib/checks.mjs';
import { runSelfcheck } from './selfcheck.mjs';
import { addStamp, syncInstalledSkill } from './lib/skill-sync.mjs';
// 文档默认渲染成排版好的 HTML（源码仍可展开查看）——零依赖实现见 lib/markdown.mjs
import { mdToHtml } from './lib/markdown.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const kitSpecCache = {};
function spec(name) {
  if (!kitSpecCache[name]) kitSpecCache[name] = loadKitSpec(name);
  return kitSpecCache[name];
}
function allSpec() {
  return {
      states: spec('states'), artifacts: spec('artifacts'), gates: spec('gates'), roles: spec('roles'),
      breakingRules: spec('breaking-rules'),   // 破坏性判定规则（规则是数据）
    };
}

// ────────────────────────────── 参数解析 ──────────────────────────────
function parseArgs(argv) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        // 重复的 flag：保留最后一个（兼容旧行为），同时把全部取值收集到 `<key>All`。
        // 为什么：`--surface contract --surface data` 曾静默丢掉前一个 ——
        // 变更面写错会让 G7 的档位检查失效，属"静默降级"，必须支持而不是覆盖。
        if (flags[key] !== undefined && flags[key] !== true) {
          if (!Array.isArray(flags[`${key}All`])) flags[`${key}All`] = [flags[key]];
          flags[`${key}All`].push(next);
        }
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

const C = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m',
  blue: '\u001b[36m',
  orange: '\u001b[38;5;208m',
  bold: '\u001b[1m',
};
const colorEnabled = process.stdout.isTTY && !process.env.NO_COLOR;
function paint(text, color) {
  return colorEnabled ? `${C[color] || ''}${text}${C.reset}` : text;
}

const VERDICT_STYLE = {
  pass: { symbol: '✓', color: 'green', label: '通过' },
  unverified: { symbol: '⚠', color: 'yellow', label: '未验证通过' },
  exempt: { symbol: '■', color: 'yellow', label: '基线豁免' },
  blocked: { symbol: '⛔', color: 'red', label: '阻断' },
  fail: { symbol: '✗', color: 'red', label: '失败' },
  pending: { symbol: '○', color: 'dim', label: '未运行' },
  stale: { symbol: '⏸', color: 'orange', label: '停滞' },
};
function verdictText(v) {
  const s = VERDICT_STYLE[v] || VERDICT_STYLE.pending;
  return `${paint(s.symbol, s.color)}${s.label === '通过' ? '' : ` ${s.label}`}`;
}

function out(flags, human, machine) {
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(machine ?? human, null, 2)}\n`);
  } else if (typeof human === 'string') {
    process.stdout.write(`${human}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(human, null, 2)}\n`);
  }
}

function die(message, code = 1) {
  process.stderr.write(`${paint('✗', 'red')} ${message}\n`);
  // 不用 process.exit：管道下 stdout 是异步的，强制退出会截断已写出的输出
  process.exitCode = code;
  throw new SilentExit(code);
}

/** 内部信号：用于在设置了 exitCode 后优雅终止 */
class SilentExit extends Error {
  constructor(code) {
    super(`silent-exit:${code}`);
    this.name = 'SilentExit';
  }
}

/**
 * 时间显示：**一律转成本地时区**。
 * 踩过的坑：直接截断 ISO（UTC）当本地时间 ⇒ 与用户看到的差 8 小时（CST+0800 实测）。
 * 存储仍用 ISO（可移植、可排序），只在**显示**时转换。
 */
function localTime(v, withSec = true) {
  if (!v) return '—';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  const p = (n) => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSec ? `${base}:${p(d.getSeconds())}` : base;
}

/**
 * 已登记的项目/工作区（用户级）。
 *
 * 为什么需要：插件在别人机器上**无从知道**用户有哪些项目 ——
 * 以前靠"猜候选目录"，猜不到就起不来。改为在 `init`/`setup` 时**主动登记**，
 * 看板的 `/api/roots` 就能列出"你自己的项目"，用户从下拉里选即可。
 */
function rememberProject(root) {
  try {
    const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const dirs = [dshHome, path.join(os.homedir(), '.config', 'devflow')];
    for (const dir of dirs) {
      try {
        mkdirSync(dir, { recursive: true });
        const f = path.join(dir, 'devflow-kit.json');
        let cfg = {};
        try { cfg = JSON.parse(readFileSync(f, 'utf8')); } catch { /* 首次 */ }
        const list = new Set(cfg.knownProjects || []);
        list.add(path.resolve(root));
        cfg.knownProjects = [...list].sort();
        cfg.kit = KIT_ROOT;
        cfg.updatedAt = new Date().toISOString();
        writeFileSync(f, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        return true;
      } catch { /* 换下一个位置 */ }
    }
  } catch { /* 登记失败不影响主流程 */ }
  return false;
}

function resolveProject(flags, opts = {}) {
  if (flags.root) {
    const root = path.resolve(String(flags.root));
    // `--root` 也要接受**多仓工作区**：工作区根没有 devflow.json，只有 devflow.workspace.json。
    // 只认 devflow.json 会让插件/CI 从工作区根启动时直接失败（实测踩到）。
    const isProject = existsSync(path.join(root, 'devflow.json'));
    const isWorkspace = existsSync(path.join(root, 'devflow.workspace.json'));
    if (!isProject && !isWorkspace) {
      die(`--root 指向的目录既没有 devflow.json 也没有 devflow.workspace.json：${root}`, 2);
    }
    return { root, loaded: isProject ? loadProject(root) : { config: {} }, marker: '--root' };
  }
  const found = resolveProjectRoot();
  if (!found) {
    // quiet：调用方会自行回退（例如 setup 在「非 devflow 项目但属 git 仓」时要装钩子）。
    // 不能走 die —— 它抛 SilentExit 并置退出码，会让"其实成功"的命令报失败。
    if (opts.quiet) return { root: null, loaded: { ok: false, errors: ['未找到 devflow.json'] }, marker: 'none' };
    die('未找到项目根（需要 devflow.json；建议同时有 .devflow/ 目录）。可先用 `devflow init`，或指定 --root / DEVFLOW_ROOT。', 2);
  }
  if (found.warning) process.stderr.write(`${paint('⚠', 'yellow')} ${found.warning}\n`);
  return { root: found.root, loaded: loadProject(found.root), marker: found.marker };
}

function pickItem(projectRoot, positional, flags) {
  const id = flags.item || positional[0];
  if (id) return id;
  const items = listItems(projectRoot);
  if (items.length === 1) return items[0].itemId;
  return null;
}


/** 逐命令帮助：用法 / 参数 / 示例 / 备注。--help 时打印。 */
const COMMAND_HELP = {
  init: {
    usage: 'devflow init [--name <项目名>] [--kind <类型>] [--stack <技术栈>] [--profile <规模档>] [--force]\n        技术栈：java-maven | node-jest | python-pytest | go-test（不指定则按标记文件自动识别；无效值会报错）\n        规模档：solo | team | cross-team | contractor | learning | legacy（默认 team）',
    what: '在当前目录写入 devflow.json 与目录骨架，并生成门禁示例脚本。',
    notes: [
      '已有文件一律不覆盖（--force 才覆盖 devflow.json）。',
      '生成的脚本带哨兵 devflow:placeholder 且刻意失败 —— "假装检查了"比"明确未配置"危险。',
      '若识别出技术栈，会用该栈的真实脚本模板（带 count_regex）替换占位脚本。',
      '没有识别到技术栈时不会硬套适配器，保留占位脚本（明确未配置 > 假装已配置）。',
      '改完真实命令后，用 devflow doctor 确认结论为"可以开工"。',
    ],
    examples: ['devflow init --name order-api --kind service --stack java-maven'],
  },
  doctor: {
    usage: 'devflow doctor [--root <目录>] [--json]',
    what: '只读体检：门禁是否可信、配置是否可用。每条发现给出「问题 + 依据 + 修法」。',
    notes: [
      '结论只有三种：可以开工 / 强度被削弱 / 门禁不可信。',
      'severity：阻断 ⛔（会骗人）、削弱 ⚠（能跑但变弱）、提示 ℹ。',
      '不写任何文件、不改任何状态。',
    ],
    examples: ['devflow doctor'],
  },
  new: {
    usage: 'devflow new --slug <变更名> [--title <标题>] [--tier <档位>] [--owner <负责人>] [--repos a,b] [--surface <变更面>] [--date YYYY-MM-DD] [--plan]\n        档位：micro | light | standard | heavy（默认 standard）\n        变更面：contract | interface | data | auth | ui | copy | internal | docs | config\n        变更名：只允许小写字母、数字、短横线；最终 item 名为 <日期>-<变更名>，例如 2026-10-13-order-export',
    what: '新建一个变更目录（一个需求 = 一个目录），并按档位生成产物骨架。',
    notes: [
      '变更名只允许小写字母、数字、短横线（同时是目录名）。',
      '目标目录非空即拒绝，绝不覆盖。',
      '微档不留文档，只留状态记录。',
      '--plan 只打印将要生成的文件，不写任何东西。',
      '产物骨架来自 templates/*.md（单一事实源），改模板即改所有新变更。',
    ],
    examples: ['devflow new --slug order-export --tier light --title "订单导出按钮"'],
  },
  status: {
    usage: 'devflow status [<item>] [--all] [--digest] [--json]',
    what: '查看单个变更或全项目的状态与门禁结果。',
    notes: [
      '--digest 输出固定摘要（item/档位/状态/门禁/证据/阻塞/预算），适合贴进对话。',
      '不带 item 且只有一个变更时自动选中它。',
    ],
    examples: ['devflow status', 'devflow status 2026-10-13-order-export --digest'],
  },
  'gate run': {
    usage: 'devflow gate run <item> [--to <状态>] [--json]',
    what: '执行项目声明的门禁命令、留下证据，然后评估 Kit 门禁 G0..G7。',
    notes: [
      '退出码：0 = 全部通过；1 = 被阻断（可直接用于 CI）。',
      '--to <状态>：按**目标状态**判定（推荐）。不加时只按当前状态判 —— draft 状态要求不到任何产物。',
      '项目门禁失败会与 Kit 门禁合并成同一条总结论，不会被掩盖。',
    ],
    examples: ['devflow gate run 2026-10-13-order-export --to verified', 'devflow gate run 2026-10-13-order-export'],
  },
  advance: {
    usage: 'devflow advance <item> --to <状态> [--check] [--force] [--by <谁>] [--actor <角色>]',
    what: '推进变更状态。按**目标状态**校验产物，缺件即拒绝。',
    notes: [
      '状态：draft → spec_ready → contracted → implementing → tested → verified → released。',
      '轻档/微档允许 spec_ready → implementing 直连（跳过契约）。',
      '推进到 tested 时会自动执行项目门禁并留证据（不需要先手动 gate run）。',
      '--check 只读预演：告诉你能不能过、缺什么，不写任何文件（推荐先跑它）。',
      '--by <谁>：留痕"是谁验证/推进的"。工程侧自测请用 --by engineer；'
        + '独立复核请写复核方与结论，两者会在 STATUS.json 里区分开。',
      '--no-run 保留：即使没有门禁记录也不要自动跑（用于只想看状态）。',
      '--force 可跳步，但会在 STATUS.json 留下"绕过门禁"的留痕。',
    ],
    examples: ['devflow advance 2026-10-13-order-export --to verified --check', 'devflow advance 2026-10-13-order-export --to verified'],
  },
  fill: {
    usage: 'devflow fill <item> [--to <状态>] [--file <产物>] [--force]',
    what: '按模板补齐目标状态所需的缺失产物。缺什么补什么，绝不覆盖已有文件。',
    notes: [
      '不指定 --to 时按当前状态计算；指定后按该状态计算（配合 advance --check 用）。',
      '补出来的是**结构化占位**，必须填真实内容再推进。',
      '没有模板的产物（如自定义文件）会明确标出"需手写"。',
    ],
    examples: ['devflow fill 2026-10-13-order-export --to released', 'devflow fill 2026-10-13-order-export --file CONTRACT.md'],
  },
  adapters: {
    usage: 'devflow adapters [--apply <技术栈>] [--dry-run] [--root <目录>]',
    what: '列出技术栈适配器、按标记文件检测当前目录，并可应用（只补缺失）。',
    notes: [
      '四个内置栈：java-maven / node-jest / python-pytest / go-test。',
      '应用时绝不覆盖已有脚本与已声明的门禁；只补缺的那部分。',
      '同时自检：每个适配器的 count_regex 是否能抓到它自己声明的样本输出。',
      '--demo 用自包含的演示脚本（输出该栈真实形态），不装 Maven/pytest/Go 也能验证整条链路。',
      '--replace-placeholders 允许把 init 生成的占位脚本换成该栈模板（用户自己写过的脚本仍不会被覆盖）。',
      '--force-scripts 允许覆盖**适配器自己生成的**脚本（例如从真实模板切换到 --demo）。用户自己写的脚本永不覆盖。',
    ],
    examples: ['devflow adapters', 'devflow adapters --apply go-test --dry-run', 'devflow adapters --apply java-maven --demo'],
  },
  report: {
    usage: 'devflow report [--out <文件>]',
    what: '生成静态 HTML 看板（单文件、可离线、可作 CI 产物）。',
    notes: [
      '只读视图：不选工作区、不改状态、不做审批。',
      '干预必须回到会话并经过门禁。',
    ],
    examples: ['devflow report --out .devflow/board.html'],
  },
  archive: {
    usage: 'devflow archive [--go]',
    what: '把活跃窗口之外的已完成变更移入归档目录。',
    notes: [
      '默认空跑，只打印计划；确认后加 --go 才真正移动。',
      '归档规则来自 spec/artifacts.json 的 archive：**只归档已 released 的变更**，且同时满足'
        + '「超过 afterDays 天（默认 90）」与「不在最近 keepRecent 条（默认 20）之内」。',
      '所以刚发布的变更不会被归档 —— 这是刻意的；想立刻归档请用较旧的 --date 造数据或调整规则。',
    ],
    examples: ['devflow archive', 'devflow archive --go'],
  },
  workspace: {
    usage: 'devflow workspace [--workspace <清单路径>]',
    what: '跨项目汇总：每个成员项目的当前变更与门禁状态。',
    notes: ['需要 devflow.workspace.json；未指定时从当前目录向上查找。'],
    examples: ['devflow workspace'],
  },
  selfcheck: {
    usage: 'devflow selfcheck [--json]',
    what: '门禁体系自检：构造"恒真门禁、未定义状态、假测试通过"等故意坏的输入，断言引擎能拦下。',
    notes: ['门禁自己也要被验证。坏输入只存在于系统临时目录，跑完即清理。'],
    examples: ['devflow selfcheck'],
  },
  version: { usage: 'devflow version', what: '打印版本、正典清单与可用命令。', notes: [], examples: [] },
  skill: {
    usage: 'devflow skill [sync] [--check] [--json]',
    what: '把已安装的 DSH 聊天技能副本与 kit 里的源文件对齐（默认 sync）。',
    notes: [
      '技能装成真实文件（不是软链），所以源文件改了副本不会自动更新 —— 本命令用于手工收口。',
      '正常无需手跑：任何一次 devflow 命令都会顺手收敛（--check 只报告、不写）。',
      '副本不存在时不自动安装 —— 装不装由你决定，请用 devflow setup。',
    ],
    examples: ['devflow skill --check', 'devflow skill sync --json'],
  },
};

function printCommandHelp(name) {
  const h = COMMAND_HELP[name];
  if (!h) return false;
  const lines = [
    `${paint(`devflow ${name}`, 'bold')}`,
    ``,
    `  ${paint('作用', 'bold')}：${h.what}`,
    `  ${paint('用法', 'bold')}：${h.usage}`,
  ];
  if (h.notes.length) {
    lines.push('', `  ${paint('说明', 'bold')}：`);
    for (const n of h.notes) lines.push(`    · ${n}`);
  }
  if (h.examples.length) {
    lines.push('', `  ${paint('示例', 'bold')}：`);
    for (const e of h.examples) lines.push(`    ${e}`);
  }
  lines.push('', `  通用参数：--json 机器可读　--root <目录>　--help`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return true;
}

/** 从门禁结果里抽出"缺了哪些产物"，用于给出点名到文件的建议 */
function collectMissing(gates) {
  const out = [];
  for (const g of gates || []) {
    const missing = g?.evidence?.missing;
    if (Array.isArray(missing)) out.push(...missing);
    for (const note of g.notes || []) {
      const m = /^缺少产物：(\S+)$/.exec(String(note).trim());
      if (m) out.push(m[1]);
    }
  }
  return [...new Set(out)];
}

/**
 * 阻塞时的下一步建议：把"失败"变成"知道该做什么"。
 * 尽量点名到具体产物 —— "缺产物"这种笼统提示对使用者没有帮助。
 */
function nextStepsFor(blockingGates, itemId, missingArtifacts = [], blockingNotes = []) {
  const hints = [];
  const has = (k) => blockingGates.some((g) => String(g).includes(k));
  if (missingArtifacts.length) {
    for (const file of missingArtifacts) {
      if (file === 'CONTRACT.md') {
        hints.push('缺 CONTRACT.md：这份变更涉及契约/接口。两条路 —— ① 补写契约（用 devflow new 生成过模板，或参考 templates/CONTRACT.md）；② 若确认无接口变化，把 SPEC 的档位降为 light 并在身份表写明理由（降档必须留痕）');
      } else if (file === 'TASKS.md') {
        hints.push('缺 TASKS.md：补一份任务表，每条任务要有「目标仓 / 写入范围 / 依赖 / 验收命令 / 对应AC」（模板见 templates/TASKS.md）');
      } else if (file === 'APPROVALS.md') {
        hints.push('缺确认记录：人工确认必须落成 APPROVALS.md（口头确认不算证据）');
      } else if (file === 'verification.md') {
        hints.push('缺 verification.md：由独立上下文的验证者产出，逐条覆盖每个 AC 并附证据');
      } else if (file === 'release/report.md') {
        hints.push('缺发布报告：release/report.md 需含命令原文、验证证据与 48 小时观察窗口');
      } else {
        hints.push(`缺产物 ${file}：运行 devflow fill ${itemId} 按模板补齐`);
      }
    }
  } else if (has('G1')) {
    hints.push(`缺产物：运行 devflow fill ${itemId} 按模板补齐（缺什么补什么，不覆盖已有文件）`);
  }
  if (has('G1b')) {
    hints.push('内容不合规：验收标准要有判据与判据类型；任务要声明写入范围、验收命令与对应 AC；验证记录要逐条覆盖 AC');
    if (blockingNotes.some((n) => String(n).includes('确认记录'))) {
      hints.push('确认记录未填：APPROVALS.md 里的「（姓名）」「（ISO 时间）」「通过 / 驳回」都是占位，占位内容不算证据。');
      hints.push('填法：把「确认人」写真实姓名、「时间」写 ISO 时间、「结论」二选一填「通过」。这是人工确认的落点，不能省。');
    }
  }
  if (has('G2')) hints.push('缺少可核证据：先跑 devflow gate run 生成记录（需包含命令原文、退出码、输出尾部）');
  if (has('G3') || has('G6')) hints.push('门禁强度问题：运行 devflow doctor 查看具体修法');
  if (has('G4')) hints.push('产物体积超限：拆分这个变更，或在 devflow.json 的 budget 里调整阈值');
  if (has('G5')) hints.push('状态不一致：STATE 与 STATUS.json 不同步，检查是否手工改过状态文件');
  if (has('G7')) hints.push('档位可能偏低：如果确实改了接口或契约，请升档并补 CONTRACT.md');
  if (has('项目门禁')) hints.push('项目门禁失败：看上方对应门禁的输出尾部定位原因；必要时手动运行该命令复现');
  if (hints.length === 0) hints.push('运行 devflow status ' + itemId + ' 查看完整门禁依据');
  hints.push(`处理完后重跑：devflow gate run ${itemId}`);
  return hints;
}

// ────────────────────────────── 命令实现 ──────────────────────────────
function cmdInit(flags) {
  const root = flags.root ? path.resolve(String(flags.root)) : process.cwd();
  const configPath = path.join(root, 'devflow.json');
  const projectName = flags.name || path.basename(root);
  const config = defaultProjectConfig(projectName, flags.kind || 'service', flags.stack || 'node');
  if (flags.profile) {
    const profiles = Object.keys(spec('states').profiles).filter((k) => !k.startsWith('$'));
    if (!profiles.includes(String(flags.profile))) {
      die(`未知规模档：${flags.profile}\n  可选：${profiles.join(' / ')}（默认 team）`, 2);
    }
    config.profile = String(flags.profile);
  }

  // 技术栈适配：显式 --stack 优先，否则按标记文件自动识别
  const adapters = loadAdapters(KIT_ROOT);
  const detected = detectAdapters(root, adapters, { strict: true });
  // 只有两种情况才应用适配器：① 用户显式 --stack；② 在项目根识别到标记。
  // 都识别不到就**不套用任何适配器**，保留占位脚本（明确未配置＞假装已配置）。
  const stackId = flags.stack ? String(flags.stack) : (detected.length ? detected[0].id : null);
  if (flags.stack && !adapters[flags.stack]) {
    // 无效的 --stack 必须硬失败：静默接受会写出一份指向不存在适配器的配置，
    // 采用者以为配好了，其实后面每一步都在错的基础上跑。
    die(`未知技术栈：${flags.stack}\n  可用：${Object.keys(adapters).join(' / ')}\n  查看全部：devflow adapters`, 2);
  }

  const created = [];
  const skipped = [];
  if (existsSync(configPath) && !flags.force) {
    skipped.push('devflow.json（已存在，未覆盖；需要覆盖请加 --force）');
  } else {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
    created.push('devflow.json');
  }
  for (const dir of ['.devflow/items', '.devflow/.local', 'scripts']) {
    const full = path.join(root, dir);
    if (!existsSync(full)) {
      mkdirSync(full, { recursive: true });
      created.push(`${dir}/`);
    }
  }

  // ── .gitignore：把 devflow 的**本地产物**加入忽略 ──
  // 为什么需要：实测踩到 —— 在某个存量仓提交时误把 .devflow/ 与生成的
  // scripts/*-should-fail.sh 一起提交，混进了功能变更的 MR。这些是本地产物，不该入库。
  // 刻意**不**忽略 devflow.json（它是项目门禁声明，团队共享才有意义；本仓/共享由使用者决定）。
  // 精确规则，**不是**整个 .devflow/：
  // items/ 里是人写的产物（①②类），应当入库让评审看到；只有机器状态与渲染产物不入库。
  // （历史错误：曾忽略整个 .devflow/，导致"该共享的没共享、该走的还在"。）
  const GITIGNORE_BLOCK = [
    '',
    '# devflow 机器状态与渲染产物（可重算，不入库；items/ 里的产物仍应入库）',
    '.devflow/.local/',
    'scripts/*-should-fail.sh',
  ].join('\n');
  const giPath = path.join(root, '.gitignore');
  try {
    let cur = existsSync(giPath) ? readFileSync(giPath, 'utf8') : '';
    if (!/devflow/.test(cur)) {
      writeFileSync(giPath, `${cur.replace(/\n*$/, '')}${cur ? '\n' : ''}${GITIGNORE_BLOCK}\n`, 'utf8');
      created.push('.gitignore（追加 devflow 规则）');
    } else if (/^\.devflow\/$/m.test(cur)) {
      // 旧规则忽略了整个 .devflow/ ⇒ 连该入库的 items/ 也被挡了。升级为精确规则。
      cur = cur.replace(/^\.devflow\/$/m, '.devflow/.local/');
      if (!/scripts\/\*-should-fail\.sh/.test(cur)) cur = `${cur.replace(/\n*$/, '')}\nscripts/*-should-fail.sh\n`;
      writeFileSync(giPath, cur, 'utf8');
      created.push('.gitignore（把「整个 .devflow/」升级为「.devflow/.local/」，使 items/ 可入库）');
    } else {
      skipped.push('.gitignore（已含精确 devflow 规则，未改动）');
    }
  } catch { /* 无权限写 .gitignore 不影响 init 主流程 */ }
  // 门禁示例脚本：只在不存在时创建，绝不覆盖
  const samples = {
    'scripts/build.sh': `#!/usr/bin/env bash
# devflow:placeholder  ← 机器哨兵：改成本脚本真实内容时请删除这一行
# ⚠ 占位脚本：还没有配置你的构建命令。
# 它刻意返回非零 —— "假装检查了"比"明确未配置"危险得多。
# 改成你的真实构建命令，并且保证以自身退出码表达结论（不要用管道收尾）。
echo "[devflow] build 门禁尚未配置：请把本脚本替换为你项目的真实构建命令" >&2
exit 1
`,
    'scripts/build-should-fail.sh': `#!/usr/bin/env bash
# 负向对照：必须返回非零，用来证明 build 门禁不是恒真。请保持失败。
exit 1
`,
    'scripts/test.sh': `#!/usr/bin/env bash
# devflow:placeholder  ← 机器哨兵：改成本脚本真实内容时请删除这一行
# ⚠ 占位脚本：还没有配置你的测试命令。
# 它刻意返回非零 —— "假装检查了"比"明确未配置"危险得多。
# 改成你的真实测试命令，并让输出里带上测试计数（供 count_regex 抓取）。
# 若本仓确实没有测试基座，请在 devflow.json 里登记 baseline_exempt（只减不增）。
echo "[devflow] test 门禁尚未配置：请把本脚本替换为你项目的真实测试命令" >&2
exit 1
`,
    'scripts/test-should-fail.sh': `#!/usr/bin/env bash
# 负向对照：必须返回非零。请保持失败。
exit 1
`,
  };
  for (const [rel, content] of Object.entries(samples)) {
    const full = path.join(root, rel);
    if (!existsSync(full)) {
      writeFileSync(full, content, { mode: 0o755 });
      created.push(rel);
    } else {
      skipped.push(`${rel}（已存在）`);
    }
  }
  // 应用适配器：只补缺失的脚本与门禁声明，绝不覆盖
  let adapterResult = null;
  if (stackId && adapters[stackId]) {
    try {
      adapterResult = applyAdapter({ projectRoot: root, adapters, id: stackId, dryRun: false, demo: Boolean(flags.demo), replacePlaceholders: true });
      for (const f of adapterResult.scripts.written) if (!created.includes(f)) created.push(f);
      for (const f of adapterResult.scripts.replaced || []) {
        const idx = created.indexOf(f);
        if (idx >= 0) created[idx] = `${f}（替换占位脚本）`;
      }
      for (const f of adapterResult.scripts.skipped) if (!skipped.includes(f)) skipped.push(f);
    } catch (error) {
      process.stderr.write(`${paint('⚠', 'yellow')} 适配器应用失败：${error.message}\n`);
    }
  }

  // 登记到用户级清单：看板的面板下拉要列出用户自己的项目

  try { rememberProject(root); } catch { /* 忽略 */ }


  out(flags, [
    `${paint('devflow init', 'bold')}  项目：${projectName}`,
    stackId
      ? `  技术栈：${adapters[stackId]?.name || stackId}（${stackId}）${detected.length && detected[0].id === stackId ? `　← 按 ${detected[0].matched.join('、')} 自动识别` : ''}`
      : `  技术栈：未识别（未套用适配器，保留占位脚本）　提示：devflow adapters 可查看支持的栈，或用 --stack 显式指定`,
    created.length ? `  新建：${created.join('、')}` : '  新建：无',
    skipped.length ? `  跳过：${skipped.join('；')}` : '',
    '',
    '下一步（建议按顺序）：',
    '  1) devflow doctor        ← 先体检：它会告诉你门禁能不能信、正则抓不抓得到计数',
    '  2) 编辑 devflow.json 与 scripts/*.sh，换成你项目的真实命令',
    '  3) 让 scripts/*-should-fail.sh 保持失败（负向对照，证明门禁不是恒真）',
    '  4) devflow doctor 再来一次，直到结论是"可以开工"',
    '  5) devflow new --slug <变更名> --tier light --title "<标题>"',
  ].filter(Boolean).join('\n'), { root, created, skipped, config });
}

const TIER_TEMPLATES = {
  micro: { needGoal: false, needSpec: false, needContract: false, needTasks: false },
  light: { needGoal: false, needSpec: true, needContract: false, needTasks: false },
  // 标准档：**契约可选** —— 与 spec/states.json 的 requiredArtifacts 一致（standard 不含 CONTRACT.md）。
  // 想要契约：`devflow fill <变更> --file CONTRACT.md`（或升到 heavy），随后内容照样会被检查。
  // 踩过的坑：这里曾写成 needContract: true（与本行注释相反）⇒ new 会创建一份没人写的
  // CONTRACT.md 模板 ⇒ G1b 因"占位内容"阻断标准档变更 —— 而正典根本不要求它。
  // needGoal 与 spec/artifacts.json 的 GOAL.md tier.required 必须一致（standard/heavy 才要）。
  // 为什么轻档不要目标锚：轻档定位就是小改动，加一份文档会把它变成负担。
  standard: { needGoal: true, needSpec: true, needContract: false, needTasks: true },
  heavy: { needGoal: true, needSpec: true, needContract: true, needTasks: true },
};

function cmdNew(flags, positional) {
  const { root } = resolveProject(flags);
  const slug = (flags.slug || positional[0] || '').trim();
  if (!slug) die('缺少变更名：devflow new --slug order-export --title "订单导出"', 2);
  if (!/^[a-z0-9-]+$/.test(slug)) die('变更名只允许小写字母、数字与短横线（它同时是目录名）', 2);
  const tier = String(flags.tier || 'standard').toLowerCase();
  if (!spec('states').tiers[tier]) die(`未知档位：${tier}\n  可选：${Object.keys(spec('states').tiers).join(' / ')}\n  速记：micro 文案级 / light 单端UI / standard 单仓功能 / heavy 跨仓或改接口`, 2);
  const date = flags.date || new Date().toISOString().slice(0, 10);
  const itemId = `${date}-${slug}`;
  const reposRaw = flags.reposAll ? flags.reposAll : (flags.repos ? [flags.repos] : []);
  const repos = reposRaw.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean);
  const surfaceAllowed = ['contract', 'interface', 'data', 'auth', 'ui', 'copy', 'internal', 'docs', 'config'];
  // 变更面支持两种写法：`--surface a,b` 与重复 `--surface a --surface b`（后者此前会被静默覆盖）
  const surfaceRaw = flags.surfaceAll ? flags.surfaceAll : (flags.surface ? [flags.surface] : []);
  const surface = surfaceRaw.length
    ? surfaceRaw.flatMap((v) => String(v).split(',')).map((s) => s.trim()).filter(Boolean)
    : ['internal'];
  const badSurface = surface.filter((x) => !surfaceAllowed.includes(x));
  if (badSurface.length) {
    die(`未知变更面：${badSurface.join('、')}\n  可用：${surfaceAllowed.join(' / ')}\n  变更面决定 G7 是否提示升档，写错会让档位检查失效`, 2);
  }

  if (flags.plan) {
    const would = ['STATE', 'STATUS.json'];
    if (TIER_TEMPLATES[tier].needSpec) would.push('SPEC.md');
    if (TIER_TEMPLATES[tier].needContract) would.push('CONTRACT.md（标准档可选：不需要就跳过 contracted 状态）');
    if (TIER_TEMPLATES[tier].needTasks) would.push('TASKS.md');
    if (tier !== 'micro') would.push('coding_report.md', 'verification.md', 'APPROVALS.md');
    out(flags, [
      `${paint('devflow new --plan', 'bold')}（纯计划，未写入任何文件）`,
      `  变更：${itemId}`,
      `  档位：${spec('states').tiers[tier].name}（${tier}）   目标仓：${repos.join('、') || '(本仓)'}   变更面：${surface.join('、')}`,
      `  目录：${path.relative(root, path.join(itemsDir(root), itemId))}`,
      `  将生成：${would.join('、')}`,
      '',
      '  确认后去掉 --plan 再执行；目标目录非空会被拒绝，绝不覆盖。',
    ].join('\n'), { itemId, tier, plan: would, dryRun: true });
    return;
  }

  const created = createItem({
    projectRoot: root,
    itemId,
    tier,
    owner: flags.owner,
    repos,
    changeSurface: surface,
    states: spec('states'),
    title: flags.title || slug,
  });
  if (!created.ok) die(created.errors.join('\n'), 3);

  const tpl = TIER_TEMPLATES[tier];
  const files = [];
  const rel = (f) => path.join(created.itemDir, f);
  const plan = [];
  if (tpl.needGoal) plan.push(['GOAL.md', 'goal']);
  if (tpl.needSpec) plan.push(['SPEC.md', 'spec']);
  if (tpl.needContract) plan.push(['CONTRACT.md', 'contract']);
  if (tpl.needTasks) plan.push(['TASKS.md', 'tasks']);
  if (tier !== 'micro') {
    plan.push(['coding_report.md', 'codingReport'], ['verification.md', 'verification'], ['APPROVALS.md', 'approvals']);
  }
  for (const [target, kind] of plan) {
    writeFileSync(rel(target), renderTemplate(KIT_ROOT, kind, created.meta), 'utf8');
    files.push(target);
  }

  out(flags, [
    `${paint('devflow new', 'bold')}  ${itemId}`,
    `  档位：${created.meta.tierName}（${tier}）   目标仓：${created.meta.repos.join('、')}   变更面：${created.meta.changeSurface.join('、')}`,
    `  产物：${path.relative(root, created.itemDir) || created.itemDir}（入库）`,
    `  状态：${path.relative(root, created.machineDir) || created.machineDir}（本机，已 gitignore）`,
    files.length ? `  生成骨架：${files.join('、')}` : '  生成骨架：无（微档不留文档）',
    '',
    tier === 'micro'
      ? '提示：微档只留状态记录，不需要写文档。下一步：devflow gate run <item>'
      : '提示：先填 SPEC 的验收标准表（每条 AC 必须有判据与判据类型），再往下走。',
    tier === 'micro' ? '      微档可直接推进到 released（或只跑门禁即算完成）。' : '',
  ].join('\n'), { itemId, itemDir: created.itemDir, tier, files });
}

function cmdStatus(flags, positional) {
  const { root, loaded } = resolveProject(flags);
  const itemId = pickItem(root, positional, flags);

  if (itemId && !flags.all) {
    const r = evaluateItem({ projectRoot: root, itemId, kitSpec: allSpec(), config: loaded.config, cwd: process.cwd() });
    if (!r.ok) {
      out(flags, `${paint('✗', 'red')} ${r.errors.join('\n')}`, r);
      process.exit(3);
    }
    const lines = [
      `${paint('变更', 'bold')}  ${r.itemId}`,
      `  档位：${spec('states').tiers[r.tier]?.name || r.tier}（${r.tier}，来源 ${r.tierSource}）`,
      `  状态：${r.stateName}（${r.state}）        体积：${r.sizeKb}k`,
      `  分支：${r.git.branch || '-'}   未提交：${r.git.dirty ?? '-'}   未推送：${r.git.ahead ?? '-'}`,
      '',
      '  门禁：',
      ...r.gates.map((g) => `    ${verdictText(g.verdict).padEnd(28)} ${g.gate}  ${g.notes.join('；')}`),
      '',
      r.summary.blocking
        ? `${paint('  结论：阻断', 'red')} —— ${r.summary.blockingGates.join('、')} 未通过`
        : `  ${paint('结论：可推进', 'green')}${r.summary.unverified ? `（含 ${r.summary.unverified} 项未验证通过，⚠ 不得当作通过）` : ''}`,
    ];
    if (flags.digest) {
      out(flags, [
        `item=${r.itemId} tier=${r.tier} state=${r.state}`,
        `gates=${r.gates.map((g) => `${g.gate}:${g.verdict}`).join(' ')}`,
        `evidence=${r.gates.flatMap((g) => g.notes).slice(0, 2).join(' / ') || '无'}`,
        `blocker=${r.summary.blockingGates.join(',') || '无'}`,
        `budget=${r.sizeKb}k`,
        // 基础标准一行：日常只需一眼看清"标准有没有未满足项"
        (() => {
          try {
            const ctx = standardsContext(root, loaded, r.itemId);
            const sm = ctx.report.summary;
            return `standards=满足${sm.met} 未满足${sm.unmet}(阻断${sm.blocking}/削弱${sm.weakened}) 不适用${sm.notApplicable}`;
          } catch {
            return 'standards=未判定';
          }
        })(),
      ].join('\n'), { digest: true, item: r.itemId, tier: r.tier, state: r.state, gates: r.gates.map((g) => ({ gate: g.gate, verdict: g.verdict })), blocking: r.summary.blockingGates, budgetKb: r.sizeKb });
      return;
    }
    out(flags, lines.join('\n'), r);
    return;
  }

  const items = listItems(root);
  const detail = items.map((i) => evaluateItem({ projectRoot: root, itemId: i.itemId, kitSpec: allSpec(), config: loaded.config, cwd: process.cwd() }));
  const chain = instructionChainKb(process.cwd(), root);
  const lines = [
    `${paint('项目', 'bold')}  ${loaded.config?.devflow?.project || path.basename(root)}    规模档：${loaded.config?.profile || 'team'}    kit ${kitVersion()}`,
    `  指令链：${chain.kb}k${chain.files.length ? `（${chain.files.join('、')}）` : ''}`,
    '',
    '  变更                              档   状态          门禁',
    ...detail.map((d) => {
      const marks = (d.gates || []).filter((g) => !['G0', 'G5', 'G6', 'G7'].includes(g.gate)).map((g) => `${g.gate}${VERDICT_STYLE[g.verdict].symbol}`).join(' ');
      return `  ${(d.itemId || '?').padEnd(34)}${(spec('states').tiers[d.tier]?.name || d.tier).padEnd(3)} ${(d.stateName || '-').padEnd(13)}${marks}`;
    }),
    '',
    detail.length === 0 ? '  （暂无变更：用 devflow new 新建）' : '',
    ...detail.filter((d) => d.summary?.blocking).map((d) => `  ${paint('⛔ 阻塞', 'red')} ${d.itemId}：${d.summary.blockingGates.join('、')}`),
    ...detail.filter((d) => d.summary?.unverified).map((d) => `  ${paint('⚠ 未验证', 'yellow')} ${d.itemId}：${d.gates.filter((g) => g.verdict === 'unverified').map((g) => g.gate).join('、')}`),
  ].filter((l) => l !== '');
  out(flags, lines.join('\n'), { root, profile: loaded.config?.profile, items: detail });
}

/** 跑项目门禁并把证据写入 STATUS.json（gate run 与 advance 共用） */
function executeProjectGates({ root, loaded, itemId, source }) {
  const kitSpec = allSpec();
  const { records, summary } = runProjectGates(loaded.config, root);
  recordRun({ projectRoot: root, itemId, kitSpec, config: loaded.config, cwd: process.cwd(), records, summary, source });
  return { records, summary };
}

function cmdGate(flags, positional) {
  const { root, loaded } = resolveProject(flags);
  if (!loaded.ok) die(`项目配置无效：\n  ${loaded.errors.join('\n  ')}`, 2);
  const itemId = pickItem(root, positional, flags);
  if (!itemId) die('需要指定变更：devflow gate run <item>（或 --item）', 2);
  // 机器状态优先在 .local/items/（见 spec/storage.json STO-1），旧布局兜底
  const itemDir = machineDir(root, itemId) || path.join(itemsDir(root), itemId);
  if (!existsSync(itemDir)) die(`变更目录不存在：${itemDir}`, 3);
  const kitSpec = allSpec();
  const state = rawState(itemDir);

  // ① 先跑项目门禁，留证据
  const { records, summary } = executeProjectGates({ root, loaded, itemId, source: 'cli' });

  // ② 再评估 Kit 门禁
  // 加 --to <状态> 时按**目标状态**判定 —— 这是"引擎会校验"的可验证形态：
  // 不加它只按当前状态判，draft 状态什么都要求不到，容易让人误以为"占位内容也算过"。
  const targetState = flags.to ? String(flags.to) : state;
  if (flags.to && !kitSpec.states.states[targetState]) {
    die(`未知目标状态：${targetState}\n  可选：${Object.keys(kitSpec.states.states).join(' / ')}`, 2);
  }
  let results;
  try {
    results = evaluateGates({
      projectRoot: root, itemId, itemDir, state: targetState,
      actualState: state, kitSpec, config: loaded.config, cwd: process.cwd(),
    });
  } catch (error) {
    die(error.message, 4);
  }
  const kitSum = summarize(results);
  const projectFailed = records.filter((r) => r.verdict === 'fail' || r.verdict === 'blocked');
  const unverifiedAll = records.filter((r) => r.verdict === 'unverified').length + kitSum.unverified;
  const sum = {
    ...kitSum,
    blocking: kitSum.blocking || projectFailed.length > 0,
    blockingGates: [...kitSum.blockingGates, ...projectFailed.map((r) => `项目门禁:${r.gate}`)],
    blockingNotes: results.filter((r) => r.verdict === 'blocked' || r.verdict === 'fail').flatMap((r) => r.notes || []),
    unverified: unverifiedAll,
  };

  const lines = [
    `${paint('门禁运行', 'bold')}  ${itemId}    当前状态：${state}${flags.to ? `　按目标状态判定：${targetState}` : '　（只按当前状态判定；加 --to <状态> 可预检推进条件）'}`,
    '',
    '  项目门禁：',
    ...records.map((r) => `    ${verdictText(r.verdict).padEnd(28)} ${r.gate.padEnd(10)} exit=${r.exitCode} ${r.testCount !== null && r.testCount !== undefined ? `count=${r.testCount} ` : ''}${r.notes.join('；')}`),
    '',
    '  Kit 门禁：',
    ...results.map((r) => `    ${verdictText(r.verdict).padEnd(28)} ${r.gate.padEnd(5)} ${r.notes.join('；')}`),
    '',
    sum.blocking
      ? `${paint('  结论：BLOCKED', 'red')} —— ${sum.blockingGates.join('、')}`
      : `${paint('  结论：PASS', 'green')}${sum.unverified ? `（${sum.unverified} 项未验证通过 ⚠）` : ''}`,
  ];
  const countMisses = records.filter((r) => r.countRegex && r.testCount === null);
  if (countMisses.length) {
    lines.push('');
    lines.push('  提示：以下门禁命令成功，但测试计数正则没抓到数字，因此无法判定"是否真的跑了测试"：');
    for (const r of countMisses) lines.push(`    · ${r.gate}：count_regex=\`${r.countRegex}\` 与输出不匹配`);
    lines.push('    修法：把 count_regex 调整为该命令实际输出里的形式（例：Jest 用 "Tests:?\\s+(\\d+) passed"），或去掉 require_min_tests。');
    lines.push('    注意：这会削弱门禁 —— "测试数为 0"将无法被拦下。可用 devflow doctor 复查。');
  }
  if (sum.blocking) {
    lines.push('', '  下一步：');
    for (const hint of nextStepsFor(sum.blockingGates, itemId, collectMissing(results), sum.blockingNotes)) lines.push(`    · ${hint}`);
  }
  out(flags, lines.join('\n'), { itemId, state, projectGates: { records, summary }, kitGates: results, summary: sum });
  if (sum.blocking) process.exitCode = 1;
}

function cmdAdvance(flags, positional) {
  const { root, loaded } = resolveProject(flags);
  const itemId = pickItem(root, positional, flags);
  const target = flags.to || positional[1];
  if (!itemId || !target) die('用法：devflow advance <item> --to <状态> [--check] [--force]\n  提示：先加 --check 预演，确认能过再真推进', 2);
  const kitSpec = allSpec();
  // 目标状态是 tested 时，"跑门禁"本身就是这一步的一部分：
  // 引擎自动执行项目门禁并留证据，而不是要求用户先手动跑一次 gate run。
  let plan = null;
  if (target === 'tested' && loaded.ok) {
    const status = readStatus(machineDir(root, itemId) || path.join(itemsDir(root), itemId));
    const hasRecords = Array.isArray(status?.lastRun?.records) && status.lastRun.records.length > 0;
    if (!hasRecords || !flags['no-run']) {
      plan = loaded.config ? 'gate run' : null;
    }
  }
  if (plan === 'gate run' && !flags.check) {
    const { records, summary } = executeProjectGates({ root, loaded, itemId, source: 'advance' });
    if (summary.blocking) {
      const failed = records.filter((r) => r.verdict === 'fail' || r.verdict === 'blocked');
      const lines = [
        `${paint('拒绝推进', 'red')}  ${itemId} → ${target}`,
        '  已自动执行项目门禁，但未通过：',
        ...failed.map((r) => `    ${verdictText(r.verdict)} ${r.gate}  exit=${r.exitCode}  ${r.notes.join('；')}`),
        '',
        '  下一步：',
        '    · 看上面的输出尾部定位失败原因；必要时手动运行该命令复现',
        `    · 只跑门禁不推进：devflow gate run ${itemId}`,
      ];
      out(flags, lines.join('\n'), { itemId, target, ranGates: true, failed: failed.map((r) => r.gate) });
      process.exitCode = 1;
      return;
    }
  }

  // ── 只读预演：告诉我能不能过、缺什么，不写任何东西 ──
  if (flags.check) {
    const cur = evaluateItem({ projectRoot: root, itemId, kitSpec, config: loaded.config, cwd: process.cwd() });
    if (!cur.ok) {
      out(flags, `${paint('无法预演', 'red')}：${cur.errors.join('；')}`, cur);
      process.exitCode = 2;
      return;
    }
    if (!kitSpec.states.states[target]) {
      out(flags, `${paint('未知目标状态', 'red')}：${target}\n  可选：${Object.keys(kitSpec.states.states).join(' / ')}`, { target });
      process.exitCode = 2;
      return;
    }
    const legal = kitSpec.states.transitions.some((t) => t.from === cur.state && t.to === target);
    const target_ = evaluateItem({ projectRoot: root, itemId, kitSpec, config: loaded.config, cwd: process.cwd(), stateOverride: target });
    const blocking = target_.gates.filter((g) => g.verdict === 'blocked' || g.verdict === 'fail');
    const unverified = target_.gates.filter((g) => g.verdict === 'unverified' || g.verdict === 'exempt');
    const lines = [
      `${paint('预演（只读，未写入任何文件）', 'bold')}  ${itemId}`,
      `  当前状态：${cur.stateName}（${cur.state}）`,
      `  目标状态：${kitSpec.states.states[target].name}（${target}）　${legal ? '' : paint('⚠ 当前状态不允许直接跳到该状态', 'yellow')}`,
      '',
      '  目标状态要求：',
      ...target_.gates.map((g) => `    ${verdictText(g.verdict).padEnd(28)} ${g.gate}  ${g.notes.join('；')}`),
      '',
    ];
    if (blocking.length) {
      lines.push(`${paint('  结论：现在推不过去', 'red')} —— ${blocking.map((g) => g.gate).join('、')} 未通过`);
      lines.push('  下一步：');
      for (const hint of nextStepsFor(blocking.map((g) => g.gate), itemId, collectMissing(target_.gates), blocking.flatMap((g) => g.notes || []))) lines.push(`    · ${hint}`);
    } else if (!legal) {
      lines.push(`${paint('  结论：产物满足，但状态转移不合法', 'yellow')}`);
      lines.push(`  说明：${cur.state} 不能直接到 ${target}。若确需跳步，用 --force（会留下绕过门禁的留痕）。`);
    } else {
      lines.push(`${paint('  结论：可以推进', 'green')}${unverified.length ? `（含 ${unverified.length} 项未验证/豁免 ⚠，不会被当作通过）` : ''}`);
      lines.push(`  执行：devflow advance ${itemId} --to ${target}`);
    }
    out(flags, lines.join('\n'), { itemId, from: cur.state, target, legal, blocking: blocking.map((g) => g.gate), gates: target_.gates.map((g) => ({ gate: g.gate, verdict: g.verdict })) });
    if (blocking.length || !legal) process.exitCode = 1;
    return;
  }
  const r = advance({
    projectRoot: root,
    itemId,
    target,
    kitSpec,
    config: loaded.config,
    cwd: process.cwd(),
    force: Boolean(flags.force),
    actor: flags.actor || 'orchestrator',
    by: flags.by || null,
  });
  if (!r.ok) {
    const lines = [
      `${paint('拒绝推进', 'red')}  ${itemId} → ${target}`,
      ...(r.errors || []),
      ...(r.blockedBy || []).map((b) => `  ${b.gate}：${b.notes.join('；')}`),
    ];
    out(flags, lines.filter(Boolean).join('\n'), r);
    process.exit(1);
  }
  out(flags, `${paint('已推进', 'green')}  ${itemId} → ${target}${r.forced ? paint('（--force 绕过门禁，已留痕）', 'yellow') : ''}`, r);
}


/**
 * 取"最近有记录的那个变更目录"，供标准判定使用（证据类条目需要它）。
 * 判定顺序：显式 --item > STATE 里最近修改的变更目录 > 无。
 */
function latestItemDir(root) {
  const dir = localItemsDir(root);
  try {
    const items = readdirSync(dir).filter((n) => !n.startsWith('.'));
    if (!items.length) return null;
    let best = null;
    let bestTs = -1;
    for (const n of items) {
      try {
        const st = statSync(path.join(dir, n));
        if (st.mtimeMs > bestTs) { bestTs = st.mtimeMs; best = n; }
      } catch { /* 跳过 */ }
    }
    return best ? path.join(dir, best) : null;
  } catch {
    return null;
  }
}

/** 收集标准判定所需的上下文（门禁记录来自最近一次 gate run） */
function standardsContext(root, loaded, itemId) {
  const dir = itemId ? path.join(itemsDir(root), itemId) : latestItemDir(root);
  let records = [];
  if (dir) {
    try {
      const st = JSON.parse(readFileSync(path.join(dir, 'STATUS.json'), 'utf8'));
      records = (st.lastRun || {}).records || [];
    } catch { /* 无记录 */ }
  }
  // 记录可疑时也重跑：陈旧记录可能写着 exit=0 而 testCount=0（当时正则没匹配上），
  // 这种"通过却计数为 0"的组合正是 STD-GATE-TEST-RUNS 要抓的假通过。
  const suspicious = records.some((r) => r.gate === 'test' && r.exitCode === 0
    && (r.testCount === 0 || r.testCount === null || r.testCount === undefined)
    && Number((loaded.config?.gates?.test || {}).require_min_tests || 0) > 0);
  if (!records.length || suspicious) {
    // 没有任何门禁记录时，**实际跑一次项目门禁**再判定。
    // 为什么必须跑：否则"未跑到测试"会被误判为违反测试基线 ——
    // 实测踩到：某仓有 9 个通过的测试，只因它的在办变更还没跑过门禁，就被报"未跑到任何测试"。
    // 判定标准不能因为"还没跑"就给出错误的否定结论。
    try {
      const run = runProjectGates(loaded.config, root);
      records = (run.records || []).map((r) => ({ gate: r.gate, exitCode: r.exitCode, testCount: r.testCount }));
    } catch { /* 跑不起来就保持无记录 ⇒ 标准会判"不适用"而不是"违反" */ }
  }
  const { findings, verdict } = diagnose({
    projectRoot: root, config: loaded.config, marker: 'devflow.json + .devflow/',
    cwd: process.cwd(), kitVersion: kitVersion(), kitRoot: KIT_ROOT,
  });
  const standards = loadStandards(KIT_ROOT);
  const report = checkStandards({
    standards, config: { ...loaded.config, projectRoot: root },
    doctor: { findings, verdict }, records, itemDir: dir,
  });
  return { report, itemDir: dir, findings };
}

/** devflow standards —— 逐条判定产品基础标准 */
/**
 * devflow migrate-storage —— 把旧布局的机器状态迁入 `.devflow/.local/items/`。
 *
 * 为什么需要：存储正典改版前，机器状态（STATE / STATUS.json）和人写的产物混在 `items/` 里，
 * 结果"该入库的"与"不该入库的"无法用一条 gitignore 区分。迁移后 `items/` 只剩人写的产物。
 * 只移动这两个文件，**人类产物一律不动**；已存在目标文件时不覆盖（保守）。
 */
/**
 * devflow setup-hooks —— 安装 git 钩子。
 *
 * 为什么需要显式命令：`.git/hooks/` **不在版本控制里** ——
 * 换机器、重新 clone 后钩子全部消失，且没人知道要去装。
 * 因此：提供显式命令 + 在 `init`/`doctor` 中提示，让"钩子在不在"可见。
 */
/**
 * devflow start —— **唯一的人/模型入口**。
 *
 * 产品定位决定的：工作流最前端永远是人（或驱动人的模型），
 * 所以不能让人去记 17 个命令 —— 必须有一个命令回答：
 *   「我在哪个工作区、有哪些变更、现在该做什么、下一步是谁的动作」。
 *
 * 输出刻意是**说人话的状态 + 下一步**，而不是命令列表。
 */
/**
 * 解析 TASKS.md 的任务行 → 任务级进度。
 * 为什么需要：变更级状态无法表达「同一次变更里哪几个任务做完了」，
 * 而人和模型都需要这个粒度（这是 `devflow view` 的数据来源）。
 */
function parseTasks(itemDir) {
  const f = resolveArtifactIn(itemDir, 'TASKS.md');
  if (!f) return [];
  const text = readFileSync(f, 'utf8');
  const lines = text.split('\n');
  const hi = lines.findIndex((l) => /^\s*\|/.test(l) && /写入范围/.test(l));
  if (hi < 0) return [];
  const cols = lines[hi].split('|').map((c) => c.trim());
  const idx = (name) => cols.indexOf(name);
  const iT = idx('T'); const iRepo = idx('目标仓'); const iLayer = idx('负责层');
  const iRange = idx('写入范围'); const iDep = idx('依赖'); const iStatus = idx('状态');
  const iOwner = idx('负责人');            // 曾漏掉这一列 ⇒ 图上把有负责人的任务显示成「未指派」（实测）
  const iCmd = idx('验收命令'); const iAc = idx('对应AC');
  const out = [];
  for (let i = hi + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) break;
    if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim());
    const at = (k) => (k >= 0 ? (cells[k] || '') : '');
    if (!at(iT) || /^T$/i.test(at(iT))) continue;
    out.push({ t: at(iT), repo: at(iRepo), layer: at(iLayer), range: at(iRange),
      dep: at(iDep), status: at(iStatus), owner: at(iOwner), cmd: at(iCmd), ac: at(iAc) });
  }
  return out;
}

/** 收集一个变更的全部可视化数据 */
function collectChange(projectRoot, itemId) {
  const dir = machineDir(projectRoot, itemId) || path.join(itemsDir(projectRoot), itemId);
  const state = rawState(dir) || '?';
  const status = readStatus(dir) || {};
  const tasks = parseTasks(dir);
  const done = tasks.filter((t) => /已完成/.test(t.status)).length;
  const blocked = tasks.filter((t) => /阻塞/.test(t.status)).length;
  const running = tasks.filter((t) => /进行中/.test(t.status)).length;
  // AC 原文：任务表只有 AC 编号，点开要知道**判据到底是什么**
  const acMap = {};
  try {
    const sf = resolveArtifactIn(dir, 'SPEC.md');
    if (sf) {
      const lines = readFileSync(sf, 'utf8').split('\n');
      const hi = lines.findIndex((l) => /^\s*\|/.test(l) && /判据/.test(l) && /AC/.test(l));
      if (hi >= 0) {
        const hc = lines[hi].split('|').map((c) => c.trim()).slice(1, -1);
        const iAc = hc.indexOf('AC'); const iJudge = hc.indexOf('判据'); const iType = hc.indexOf('判据类型');
        for (let i = hi + 1; i < lines.length; i += 1) {
          if (!/^\s*\|/.test(lines[i])) break;
          if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
          const c = lines[i].split('|').map((x) => x.trim()).slice(1, -1);
          if (c[iAc]) acMap[c[iAc]] = { judge: c[iJudge] || '', type: c[iType] || '' };
        }
      }
    }
  } catch { /* 无 SPEC 不影响视图 */ }
  // 依赖反查：谁卡着这个任务
  const blockersOf = {};
  for (const t of tasks) {
    const dep = String(t.dep || '').trim();
    if (!dep || dep === '无') continue;
    for (const d of dep.split(/[、,，;；\s]+/).filter(Boolean)) {
      if (!blockersOf[d]) blockersOf[d] = [];
      blockersOf[d].push(t.t);
    }
  }
  // 每个状态要求什么、当前满足没有 —— 供状态芯片点开后查看
  const spec = allSpec().states;
  const stateOrder = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'];
  const stateInfo = stateOrder.map((k, i) => {
    const def = spec.states[k] || {};
    const has = (f) => Boolean(resolveArtifactIn(dir, f));
    const reqs = (def.required || []).map((f) => ({ file: f, ok: has(f) }));
    return {
      key: k,
      name: def.name || k,
      pos: i,
      desc: def.description || '',
      gate: def.gate || null,
      reqs,
      missing: reqs.filter((r) => !r.ok).length,
    };
  });
  // 任务与阶段的关联（此前缺失的一环）：
  //   任务只存在于「实现中 → 已验证」这段 —— 之前的阶段是需求与切分（那时任务表还没有），
  //   「已发布」在全部任务之后。因此按任务状态把它们挂到相关阶段上。
  const byStatus = {
    todo: tasks.filter((t) => /待开始/.test(t.status)),
    running: tasks.filter((t) => /进行中/.test(t.status)),
    done: tasks.filter((t) => /已完成/.test(t.status)),
    blocked: tasks.filter((t) => /阻塞/.test(t.status)),
  };
  const stageTasks = {
    implementing: [...byStatus.running, ...byStatus.todo, ...byStatus.blocked],
    tested: [...byStatus.done.filter((t) => !t.verified)],
    verified: [...byStatus.done],
  };
  // 产物全文：让视图"自解释" —— 看到"缺 verification.md"时能直接知道里面要写什么。
  // 只收已存在的产物（缺失的不编造），且限制体积避免单文件过大。
  const ARTIFACTS = ['SPEC.md', 'CONTRACT.md', 'TASKS.md', 'CLARIFY.md',
    'coding_report.md', 'verification.md', 'APPROVALS.md', 'release/report.md'];
  const docs = {};
  for (const f of ARTIFACTS) {
    const fp = resolveArtifactIn(dir, f);
    if (!fp) continue;
    try {
      const t = readFileSync(fp, 'utf8');
      docs[f] = t.length > 40000 ? `${t.slice(0, 40000)}\n\n…（过长，已截断；完整内容见 ${f}）` : t;
    } catch { /* 读不到就不收 */ }
  }
  // 仓级架构声明（供视图展示"本项目约束"）
  let arch = null;
  try {
    const ap = path.join(projectRoot, '.devflow', 'architecture.md');
    if (existsSync(ap)) arch = readFileSync(ap, 'utf8');
  } catch { /* 无架构声明 */ }
  // 未决项（需求澄清）：与门禁同口径 —— 未决项是"不许进实现"的硬约束，视图必须显示
  let clarify = { pending: 0, total: 0, rows: [] };
  try {
    const cf = resolveArtifactIn(dir, CLARIFY_FILE);
    if (cf) {
      const rows = readFileSync(cf, 'utf8').split('\n')
        .filter((l) => /^\s*\|\s*[UQ]-\d+\s*\|/.test(l))
        .map((l) => { const c = l.split('|').map((x) => x.trim()).slice(1, -1);
          return { qid: c[0], q: c[1] || '', pending: /未决/.test(c[3] || '') || !c[2] }; });
      clarify = { pending: rows.filter((r) => r.pending).length, total: rows.length, rows };
    }
  } catch { /* 无澄清记录 */ }
  // 分层覆盖：变更面 × 任务「负责层」（与 D15 同口径，视图里直接可见）
  const SURFACE_LAYER = { ui: ['前端'], data: ['数据库', '后端'], contract: ['契约'], interface: ['契约', '后端'] };
  let surface = [];
  try {
    const sf = resolveArtifactIn(dir, 'SPEC.md');
    if (sf) {
      const m = /change_surface\s*\|\s*([^|\n]+)/.exec(readFileSync(sf, 'utf8'));
      if (m) surface = m[1].split(/[、,，\s]+/).filter(Boolean);
    }
  } catch { /* 无 SPEC */ }
  const layers = [...new Set(tasks.map((t) => t.layer).filter(Boolean))];
  const needLayers = [...new Set(surface.flatMap((x) => SURFACE_LAYER[x] || []))];
  const missingLayers = needLayers.filter((ly) => !layers.includes(ly));
  return { itemId, state, tier: status.tier || '?', tasks, done, blocked, running,
    taskTotal: tasks.length, acMap, blockersOf, stateInfo, byStatus, stageTasks, docs, arch,
    clarify, layers, needLayers, missingLayers, surface,
    curIdx: stateOrder.indexOf(state) };
}

/**
 * devflow view —— 生成**自包含单文件 HTML** 视图。
 *
 * 设计取舍（刻意）：
 *   · **不做常驻 Web 服务** —— 那要服务端 + 鉴权，而收益只是"不用读终端"；
 *   · **自包含**（内联样式、零 JS 依赖）—— 可离线打开、可发群、可附在合并请求里；
 *   · **按需重算** —— 属存储正典的④类（渲染产物），不长期保留。
 */
/**
 * devflow task —— **任务级干预**。
 *
 * 为什么需要：工作流此前只能推进"变更"，无法干预"变更里的某个任务"。
 * 真实场景必然出现：某任务被阻塞、要换负责人、要改分层、要标记完成。
 * 没有这个入口，人只能手改 Markdown —— 那既容易改坏表格，也无法留痕。
 *
 * 定位（与 view 的分工）：
 *   · `view` 是**只读的可视面**（静态 HTML，无法回传动作）；
 *   · 真正的通道是**会话**：人说话 → 模型调本命令改文件 → 刷新 view。
 */
/** 通用必答清单（产品提供）；项目可在 .devflow/architecture.md 追加自己的 Q-x */
const CLARIFY_QUESTIONS = [
  ['边界', '什么时候触发/生效？范围包含什么、明确不包含什么？'],
  ['异常流', '失败、为空、超时、权限不足时，用户看到什么？'],
  ['权限归属', '谁能看、谁能改、只能操作自己的数据吗？'],
  ['并发幂等', '会不会重复触发？重复了会怎样？'],
  ['兼容', '历史数据、老版本客户端、已有约定要不要一起处理？'],
  ['验收', '怎么证明做对了？一条可跑的命令，或一个可看的画面。'],
];

const CLARIFY_FILE = 'CLARIFY.md';

/** 读取某变更的澄清记录 → [{q, answer, pending}] */
function readClarify(itemDir, projectRoot) {
  const file = resolveArtifactIn(itemDir, CLARIFY_FILE);
  const custom = [];
  try {
    const af = path.join(projectRoot, '.devflow', 'architecture.md');
    if (existsSync(af)) {
      const lines = readFileSync(af, 'utf8').split('\n');
      const hi = lines.findIndex((l) => /^\s*\|/.test(l) && /必答问题/.test(l));
      if (hi >= 0) {
        for (let i = hi + 1; i < lines.length; i += 1) {
          if (!/^\s*\|/.test(lines[i])) break;
          if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) continue;
          const c = lines[i].split('|').map((x) => x.trim()).slice(1, -1);
          const qid = c[0] || ''; const qt = c[1] || '';
          if (!/^Q-\d+/.test(qid) || !qt || /（如/.test(qt)) continue;
          custom.push([qid, qt]);
        }
      }
    }
  } catch { /* 无架构声明不阻塞 */ }
  const all = [...CLARIFY_QUESTIONS.map(([k, q], i) => [`U-${i + 1}`, `${k}：${q}`]), ...custom];
  const rows = [];
  const text = file ? readFileSync(file, 'utf8') : '';
  for (const [qid, qtext] of all) {
    // 行格式：| U-1 | 问题 | 答案 | 未决 / 已答 |
    const line = text.split('\n').find((l) => l.trim().startsWith(`| ${qid} `));
    let answer = ''; let pending = true;
    if (line) {
      const c = line.split('|').map((x) => x.trim()).slice(1, -1);
      answer = c[2] || '';
      pending = /未决/.test(c[3] || '') || !answer || /（待答）/.test(answer);
    }
    rows.push({ qid, q: qtext, answer, pending });
  }
  return { file, rows, pendingCount: rows.filter((r) => r.pending).length };
}

/**
 * devflow clarify —— 需求澄清：把「讨论」变成**可判定的产物**。
 *
 * 为什么需要：质量损失的最大来源是"没人问该问的问题"。
 * 产品把通用必答清单固定下来，项目可在 architecture.md 追加；
 * **存在未决项时不允许推进到 implementing**（门禁校验）——这是质量的第一道闸。
 */
function cmdClarify(flags, positional) {
  const { root, loaded } = resolveProject(flags);
  const itemId = flags.item ? String(flags.item) : pickItem(root, positional, flags);
  if (!itemId) die('用法：devflow clarify <变更> [--list] [--answer <U-1> --text "<答案>"] [--pending <U-2>]', 2);
  const human = path.join(itemsDir(root), itemId);
  const itemDir = machineDir(root, itemId) || human;
  if (!existsSync(itemDir) && !existsSync(human)) die(`变更目录不存在：${itemId}`, 3);
  mkdirSync(human, { recursive: true });
  const target = path.join(human, CLARIFY_FILE);
  let info = readClarify(itemDir, root);

  // 初始化文件
  if (!existsSync(target)) {
    const lines = ['# 需求澄清 · ' + itemId, '',
      '> **产物**：需求澄清记录　**变更**：' + itemId + '　**最后更新**：' + new Date().toISOString().slice(0, 10), '',
      '> **存在未决项时不允许推进到实现**（门禁会校验）。答不上来的不要编，标「未决」并写明卡在哪。', '',
      '| 编号 | 必答问题 | 答案 | 状态 |', '|---|---|---|---|'];
    for (const r of info.rows) lines.push(`| ${r.qid} | ${r.q} | | 未决 |`);
    lines.push('');
    writeFileSync(target, lines.join('\n'), 'utf8');
    info = readClarify(itemDir, root);
  }

  if (flags.list || (!flags.answer && !flags.pending && !flags.text)) {
    out(flags, [
      `${paint('devflow clarify', 'bold')}  ${itemId}`,
      `  记录：${path.relative(root, target)}`,
      `  未决：${info.pendingCount}/${info.rows.length}`,
      '',
      ...info.rows.map((r) => `  ${r.pending ? paint('○', 'yellow') : paint('●', 'green')} ${r.qid}  ${r.q}`),
      '',
      info.pendingCount ? '  → 用 --answer <编号> --text "<答案>" 逐条回答；答不上来用 --pending <编号> --text "<卡在哪>"' : '  ✓ 全部已答，可推进到实现',
    ].join('\n'), { itemId, pending: info.pendingCount, total: info.rows.length });
    return;
  }

  const qid = flags.answer || flags.pending;
  if (!info.rows.some((r) => r.qid === qid)) die(`未知问题编号：${qid}\n  可用：${info.rows.map((r) => r.qid).join(' / ')}`, 2);
  const text = flags.text ? String(flags.text) : '';
  const lines = readFileSync(target, 'utf8').split('\n');
  const idx = lines.findIndex((l) => l.trim().startsWith(`| ${qid} `));
  const c = lines[idx].split('|').map((x) => x.trim()).slice(1, -1);
  c[2] = text || '（待答）';
  c[3] = flags.pending ? '未决' : '已答';
  lines[idx] = `| ${c.join(' | ')} |`;
  writeFileSync(target, lines.join('\n'), 'utf8');
  try {
    appendEvent(root, itemId, { event: 'clarify', qid, state: flags.pending ? '未决' : '已答', by: flags.by ? String(flags.by) : 'cli' });
  } catch { /* 忽略 */ }
  info = readClarify(itemDir, root);
  out(flags, [
    `${paint('devflow clarify', 'bold')}  ${itemId} · ${qid}`,
    `  ${flags.pending ? '标记未决' : '已答'}：${text || '（空）'}`,
    `  未决：${info.pendingCount}/${info.rows.length}`,
    info.pendingCount ? '  ⚠ 仍有未决项 —— 未决项不允许推进到实现' : '  ✓ 全部已答',
  ].join('\n'), { itemId, qid, pending: info.pendingCount });
}

function cmdTask(flags, positional) {
  const { root, loaded } = resolveProject(flags);
  const itemId = flags.item ? String(flags.item) : pickItem(root, positional, flags);
  if (!itemId) die('用法：devflow task <变更> <T编号> [--status <状态>] [--owner <人>] [--layer <层>] [--note <原因>]', 2);
  // 参数形态：`devflow task <变更> <T编号>` 或 `devflow task <T编号>`（变更由上下文推断）
  // positional 里可能含变更名，故取"看起来像 T 编号"的那个。
  const pos = (positional || []).map(String);
  const tId = flags.t ? String(flags.t) : (pos.find((x) => /^T-?\d+$/i.test(x)) || null);
  if (!tId) die('需要指定任务编号，例如：devflow task 2026-10-14-demo T-2 --status 阻塞 --note 等后端接口', 2);

  const humanDir = path.join(itemsDir(root), itemId);
  const file = resolveArtifactIn(machineDir(root, itemId) || humanDir, 'TASKS.md');
  if (!file) die(`找不到 TASKS.md：变更 ${itemId} 未产出任务分解`, 3);

  const lines = readFileSync(file, 'utf8').split('\n');
  const hi = lines.findIndex((l) => /^\s*\|/.test(l) && /写入范围/.test(l));
  if (hi < 0) die('TASKS.md 里找不到任务表（缺「写入范围」列）', 3);
  // 表头与数据行都必须**先剥掉 split('|') 的首尾空串**，否则列索引整体错位 1
  // （实测踩到：状态被写进了「负责人」列）。
  const rawCols = lines[hi].split('|').map((c) => c.trim());
  const cols = rawCols.slice(1, rawCols.length - 1);
  const iT = cols.indexOf('T'); const iStatus = cols.indexOf('状态'); const iOwner = cols.indexOf('负责人'); const iLayer = cols.indexOf('负责层');
  // 缺列时必须**明确报错**，不能按 -1 索引继续 —— 否则重建行会静默改坏表格结构
  // （实测踩到：旧格式任务表没有「负责人」列，改完在行尾多出 `| |`）。
  const need = { 状态: iStatus, 负责人: iOwner, 负责层: iLayer };
  const missingCols = Object.entries(need).filter(([, i]) => i < 0).map(([k]) => k);
  if (missingCols.length) {
    die(`TASKS.md 的任务表缺少列：${missingCols.join('、')}\n`
      + '  这是旧格式任务表。修法：按 templates/TASKS.md 补齐表头与分隔行（'
      + '`| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |`）\n'
      + '  拒绝继续的理由：缺列时改写会破坏表格结构，且改动无法被正确解读。', 3);
  }

  let hit = -1;
  for (let i = hi + 1; i < lines.length; i += 1) {
    if (!/^\s*\|/.test(lines[i])) break;
    const rc = lines[i].split('|').map((c) => c.trim());
    const cells = rc.slice(1, rc.length - 1);
    if (cells[iT] === tId) { hit = i; break; }
  }
  if (hit < 0) die(`任务 ${tId} 不存在于 ${itemId} 的任务表`, 3);

  // 去掉 split('|') 产生的首尾空串，得到**真正的单元格数组**（长度 = 列数）。
  // 若不去掉，重建行时尾空串会被当作一个额外单元格（实测踩到：行尾多出 `|  |`）。
  const rawCells = lines[hit].split('|').map((c) => c.trim());
  const cells = rawCells.slice(1, rawCells.length - 1);
  const before = { status: cells[iStatus], owner: cells[iOwner], layer: cells[iLayer] };
  const changes = [];
  const setCell = (i, val, label) => {
    if (i < 0 || val == null) return;
    if (cells[i] === val) return;
    changes.push(`${label}：${cells[i] || '(空)'} → ${val}`);
    cells[i] = val;
  };
  if (flags.status) {
    const ok = ['待开始', '进行中', '已完成', '阻塞'];
    if (!ok.includes(String(flags.status))) die(`未知状态：${flags.status}\n  可用：${ok.join(' / ')}`, 2);
    // 阻塞必须给原因：没有原因的阻塞无法处理，也无法追问
    if (String(flags.status) === '阻塞' && !flags.note) {
      die('标记阻塞时必须给出原因：--note "<为什么阻塞>"\n  理由：没有原因的阻塞无法被处理，也无法追问责任人', 2);
    }
    setCell(iStatus, flags.note ? `阻塞（${flags.note}）` : String(flags.status), '状态');
  } else if (flags.note) {
    setCell(iStatus, `阻塞（${flags.note}）`, '状态');
  }
  setCell(iOwner, flags.owner ? String(flags.owner) : null, '负责人');
  setCell(iLayer, flags.layer ? String(flags.layer) : null, '负责层');

  if (!changes.length) {
    out(flags, `  ${paint('—', 'yellow')} 任务 ${tId} 无需改动（当前：${before.status} / ${before.owner} / ${before.layer}）`, { changed: false });
    return;
  }
  // 重建该行：split('|') 会产生首尾空串（`| a | b |` → ['', ' a ', ' b ', '']），
  // 所以真正的内容是 cells[1..n-1]，长度为 cols.length。曾写成 slice(1, cols.length)
  // 导致最后一个单元格被当成另一个 cell，行尾多出 `|  |`（实测踩到）。
  lines[hit] = `| ${cells.join(' | ')} |`;
  writeFileSync(file, lines.join('\n'), 'utf8');
  // 记录任务级事件（看板与"前世今生"的数据来源）
  try {
    appendEvent(root, itemId, { event: 'task.update', task: tId, changes, by: flags.by ? String(flags.by) : 'cli' });
  } catch { /* 事件记录失败不影响主流程 */ }

  out(flags, [
    `${paint('devflow task', 'bold')}  ${itemId} · ${tId}`,
    ...changes.map((c) => `  · ${c}`),
    '',
    `  已写入：${path.relative(root, file)}`,
    '  提示：运行 `devflow view` 刷新视图；阻塞任务请把原因同步到会话，便于安排解除。',
  ].join('\n'), { itemId, task: tId, changes });
}

/**
 * devflow graph —— 把工作流状态输出成 **Mermaid 图**。
 *
 * 为什么用 Mermaid 而不是自建 UI（决策依据）：
 *   · 文本格式 ⇒ **零依赖、可入库、可 diff**；
 *   · GitHub / GitLab / 多数编辑器**原生渲染** ⇒ 贴进合并请求即可看；
 *   · 我们的数据模型本就齐全（状态机 + 任务依赖 + 任务状态 + 目标仓）⇒ 只需渲染，不需新数据；
 *   · 不引入常驻进程 —— 产品保持"离线可用、单文件"的约束。
 *
 * 三种图：
 *   --kind tasks   任务依赖图（节点=任务，颜色=状态，连线=依赖，含被阻塞者）
 *   --kind flow    需求流转图（每个需求在哪个节点）
 *   --kind stages  工作流状态机（正典示意图，可直接进文档）
 */
function mermaidEscape(t) {
  return String(t == null ? '' : t).replace(/["`]/g, "'").replace(/\n/g, ' ').slice(0, 60);
}

/** 收集某仓全部变更的图数据 */
function graphData(root) {
  // 与看板**共用同一数据来源**（含多仓工作区成员）：
  // 视图与看板必须是"同一状态的两种视图"，否则两边会各说各话（UI 定论里的硬约束）。
  const boardState = collectBoardState(root);
  const items = boardState.changes.map((c) => {
    const dir = machineDir(root, c.itemId) || path.join(itemsDir(root), c.itemId);
    let extra = {};
    try { extra = collectChange(c.repo ? path.join(root, c.repo) : root, c.itemId); } catch { extra = {}; }
    return { ...extra, ...c, itemId: c.itemId, repo: c.repo || path.basename(root) };
  });
  return items;
}

function renderTaskGraph(c) {
  const out = ['```mermaid', 'flowchart LR'];
  const cls = { 待开始: 'todo', 进行中: 'doing', 已完成: 'done', 阻塞: 'blocked' };
  const byRepo = {};
  for (const t of c.tasks) {
    const r = t.repo || '(本仓)';
    if (!byRepo[r]) byRepo[r] = [];
    byRepo[r].push(t);
  }
  for (const [repo, list] of Object.entries(byRepo)) {
    out.push(`  subgraph ${mermaidEscape(repo)}`);
    for (const t of list) {
      // 阻塞原因写在状态里（阻塞（原因））—— 图上要能看出"为什么卡住"，否则图没价值
      const why = /阻塞/.test(t.status) ? String(t.status).replace(/^阻塞[（(]?/, '').replace(/[）)]$/, '') : '';
      const label = `${t.t} ${t.layer || ''} ${t.owner || '未指派'}${why ? ` ⛔${why}` : ''}`.trim();
      out.push(`    ${t.t}["${mermaidEscape(label)}"]:::${cls[String(t.status).replace(/（.*/, '')] || 'todo'}`);
    }
    out.push('  end');
  }
  for (const t of c.tasks) {
    const dep = String(t.dep || '').trim();
    if (!dep || dep === '无') continue;
    for (const d of dep.split(/[、,，;；\s]+/).filter(Boolean)) {
      if (c.tasks.some((x) => x.t === d)) out.push(`  ${d} --> ${t.t}`);
    }
  }
  out.push('  classDef todo fill:#f3f4f6,stroke:#9ca3af,color:#374151');
  out.push('  classDef doing fill:#fef3c7,stroke:#d97706,color:#78350f');
  out.push('  classDef done fill:#d1fae5,stroke:#059669,color:#065f46');
  out.push('  classDef blocked fill:#fee2e2,stroke:#dc2626,color:#7f1d1d');
  out.push('```');
  return out.join('\n');
}

function renderFlowGraph(items) {
  const stages = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'];
  const name = { draft: '草稿', spec_ready: '需求就绪', contracted: '契约冻结', implementing: '实现中',
    tested: '待验证', verified: '已验证', released: '已发布' };
  const out = ['```mermaid', 'stateDiagram-v2', '  direction LR'];
  const grouped = {};
  for (const c of items) {
    const st = stages.includes(c.state) ? c.state : 'draft';
    (grouped[st] = grouped[st] || []).push(c);
  }
  for (const st of stages) {
    const list = grouped[st] || [];
    out.push(`  state "${name[st]}${list.length ? `（${list.length}）` : ''}" as ${st}`);
  }
  for (let i = 0; i < stages.length - 1; i += 1) out.push(`  ${stages[i]} --> ${stages[i + 1]}`);
  for (const st of stages) {
    for (const c of (grouped[st] || [])) {
      // 用 note 标注每个需求落在哪个节点
      out.push(`  note right of ${st} : ${mermaidEscape(c.itemId)}`);
    }
  }
  out.push('```');
  return out.join('\n');
}

function renderStageGraph() {
  const defs = allSpec().states.states;
  const fr = { draft: 'draft', spec_ready: 'spec_ready' };
  const out = ['```mermaid', 'stateDiagram-v2', '  direction LR'];
  for (const [k, v] of Object.entries(defs)) {
    out.push(`  state "${v.name}${v.gate ? ` · ${v.gate}` : ''}" as ${k}`);
  }
  const order = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'];
  for (let i = 0; i < order.length - 1; i += 1) out.push(`  ${order[i]} --> ${order[i + 1]}`);
  out.push('```');
  return out.join('\n');
}

/** devflow history —— 查看变更事件流（任务的"前世今生"） */
/**
 * devflow board —— 启动本地看板（v1 只读 + SSE 实时刷新）。
 *
 * 形态取舍见 scripts/lib/board.mjs 顶部说明：**本地服务而非宿主插件**，
 * 这样浏览器、任何 agent、以后的桌面壳都能复用同一个状态接口。
 */
/**
 * devflow review —— 人工确认点（AP1/AP2/AP3）的**决策**命令。
 *
 * 不带 --by 时：只**摊开材料**并给出"能不能签"的结论（绝不代填）。
 * 带 --by 时：记录真人的结论（写 APPROVALS.md + 事件日志）。
 */
function buildReviewPack(root, itemId, point, flags) {
  const dir = machineDir(root, itemId) || path.join(itemsDir(root), itemId);
  const read = (names) => {
    for (const n of names) {
      for (const base of [dir, path.join(itemsDir(root), itemId)]) {
        const f = path.join(base, n);
        if (existsSync(f)) return readFileSync(f, 'utf8');
      }
    }
    return '';
  };
  const specRaw = read(['SPEC.md']);
  const appRaw = read(['APPROVALS.md']);
  const verRaw = read(['verification.md']);
  const conRaw = read(['CONTRACT.md']);
  const spec = {
    raw: specRaw,
    acceptanceCriteria: parseAcceptanceCriteria(specRaw),
    clarifyPending: (() => {
      // 澄清未决项以 `未决` 标记存在于 SPEC 的澄清表
      const out = [];
      const m = /##\s*澄清[\s\S]*?\n((?:\|.*\n)+)/.exec(specRaw);
      if (!m) return out;
      for (const line of m[1].split('\n')) {
        if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
        const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
        if (cells.some((c) => /未决/.test(c))) out.push({ id: cells[0], text: cells[1] || '' });
      }
      return out;
    })(),
  };
  const tasks = (() => {
    const t = read(['TASKS.md']);
    return parseTasks(t);
  })();
  const verification = {
    raw: verRaw,
    items: parseVerification(verRaw).filter((v) => isRealValue(v.conclusion)),
    // 未验证项必须真的解析出来：此前硬编码为 []，导致发布材料永远报「未验证项：0」（详见 parseUnverifiedItems）
    unverified: parseUnverifiedItems(verRaw),
  };
  // 未验证项表
  const uv = /##\s*未验证项[\s\S]*?\n((?:\|.*\n)+)/.exec(verRaw);
  if (uv) {
    for (const line of uv[1].split('\n')) {
      if (!/^\s*\|/.test(line) || /^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;
      const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
      // 占位/表头不算未验证项（isRealValue 与门禁同口径）
      if (isRealValue(cells[0]) && !/^(AC|项|编号|未验证)/.test(cells[0])) verification.unverified.push({ ac: cells[0], why: cells[1] || '' });
    }
  }
  const contract = { raw: conRaw, endpoints: (() => {
    const out = [];
    for (const m of conRaw.matchAll(/`?(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s`|)]*)`?/g)) out.push({ method: m[1], path: m[2] });
    return out;
  })() };
  const approvals = parseApprovals(appRaw);
  const { loaded } = { loaded: null };
  const pack = reviewPack({ itemId, point, spec, tasks, verification, contract, approvals });
  // 带上原文：签核时要用它算指纹（签字必须绑定"签的是什么"）
  pack.specRaw = specRaw; pack.contractRaw = conRaw; pack.verificationRaw = verRaw;
  return pack;
}

/**
 * 解析"项目根或工作区根"。
 * 为什么需要：工作区根没有 devflow.json（它不是"项目"），但看板/review 都要在那里能跑。
 * 抽成一处，避免每个命令各写一份回退（曾重复两次，属于"多份实现"）。
 */
function resolveProjectOrWorkspace(flags) {
  let root = null; let loaded = { config: {} };
  ({ root, loaded } = resolveProject(flags, { quiet: true }));
  if (!root || !existsSync(root)) {
    const wsFile = path.join(process.cwd(), 'devflow.workspace.json');
    if (existsSync(wsFile)) { root = process.cwd(); loaded = { config: {} }; }
  }
  return { root: root && existsSync(root) ? root : null, loaded };
}

/**
 * devflow contract —— 契约的基线化与破坏性判定。
 *
 *   snapshot <变更>   把当前契约存为基线（冻结时做一次）
 *   diff <变更>       当前契约 vs 基线，按规则正典判定破坏性
 *   rules             列出判定规则（规则是数据，可被审计与讨论）
 */
function cmdContract(flags, positional) {
  const sub = String(positional?.[0] || flags.sub || '').toLowerCase();
  const rulesSpec = allSpec()['breakingRules'] || (() => {
    try { return JSON.parse(readFileSync(path.join(KIT_ROOT, 'spec', 'breaking-rules.json'), 'utf8')); } catch { return null; }
  })();

  if (sub === 'rules') {
    const rows = (rulesSpec?.rules || []).map((r) => `  ${r.severity === 'BREAKING' ? '⛔' : r.severity === 'WARN' ? '⚠' : 'ℹ'} ${r.id.padEnd(30)} ${r.when}`);
    out(flags, [`契约破坏性判定规则（正典：spec/breaking-rules.json）`, '', ...rows,
      '', '刻意不做：', ...((rulesSpec?.nonGoals || []).map((g) => `  · ${g}`))].join('\n'), { rules: rulesSpec?.rules || [] });
    return;
  }

  const { root } = resolveProjectOrWorkspace(flags);
  if (!root) die('既不是 devflow 项目，也不是多仓工作区', 2);
  const itemId = flags.item ? String(flags.item) : pickItem(root, positional?.slice(1), flags);
  if (!itemId) die('用法：devflow contract <snapshot|diff|rules> <变更> [--json]', 2);
  const dir = machineDir(root, itemId) || path.join(itemsDir(root), itemId);
  if (!existsSync(dir)) die(`变更目录不存在：${itemId}`, 2);

  const readContract = () => {
    const names = ['contract.json', 'CONTRACT.md'];
    for (const n of names) {
      for (const base of [dir, path.join(itemsDir(root), itemId)]) {
        const f = path.join(base, n);
        if (existsSync(f)) return { file: f, text: readFileSync(f, 'utf8'), kind: n.endsWith('.json') ? 'json' : 'md' };
      }
    }
    return null;
  };
  const cur = readContract();
  if (!cur) die(`没有契约文件（contract.json 或 CONTRACT.md）—— 跨边界变更才需要契约`, 2);
  const current = normalizeContract(cur.kind === 'json' ? JSON.parse(cur.text) : cur.text);

  // 基线必须放在**入库**位置（items/ 下），不是 .local/ ——
  // 否则 CI 里永远没有基线，"破坏性判定"在 CI 就是一句空话（实测发现）。
  const baselineFile = path.join(itemsDir(root), itemId, 'baseline', 'contract.json');

  if (sub === 'snapshot') {
    mkdirSync(path.dirname(baselineFile), { recursive: true });
    const payload = {
      item: itemId,
      frozenAt: new Date().toISOString(),
      source: path.relative(root, cur.file),
      endpoints: current.endpoints,
      consumers: current.consumers,
      assertions: current.assertions,
    };
    writeFileSync(baselineFile, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    try { appendEvent(root, itemId, { event: 'contract.snapshot', endpoints: current.endpoints.length, by: 'cli' }); } catch { /* 忽略 */ }
    out(flags, [
      `${paint('✓ 契约基线已冻结', 'green')}　${itemId}`,
      `  端点：${current.endpoints.length} 个`,
      `  写入：${path.relative(root, baselineFile)}`,
      `  此后 devflow contract diff ${itemId} 会与它比对`,
    ].join('\n'), { itemId, endpoints: current.endpoints.length, baseline: path.relative(root, baselineFile) });
    return;
  }

  // 默认 diff
  let baseline = null;
  if (existsSync(baselineFile)) {
    try { baseline = JSON.parse(readFileSync(baselineFile, 'utf8')); } catch { baseline = null; }
  }
  const findings = diffContracts(baseline, current, rulesSpec);
  if (!baseline) findings.unshift({ id: 'baseline-missing', severity: 'INFO', why: '还没有基线快照', fix: `devflow contract snapshot ${itemId}`, detail: '' });

  if (flags.json) {
    out(flags, { itemId, baseline: baseline ? { endpoints: baseline.endpoints } : null, current: { endpoints: current.endpoints }, findings }, { itemId, findings });
    return;
  }
  out(flags, renderDiff({ itemId, baseline, current, findings }), { itemId, findings });
  if (flags['fail-on-breaking'] && findings.some((f) => f.severity === 'BREAKING')) process.exitCode = 3;
}

function cmdReview(flags, positional) {
  const { root } = resolveProjectOrWorkspace(flags);
  if (!root) {
    die('既不是 devflow 项目，也不是多仓工作区。\n'
      + '  · 项目：先 devflow init\n  · 工作区：在根目录 devflow workspace init', 2);
  }

  // --all：一次报告**所有变更**的确认点状态（CI 用）。默认不阻断。
  // 为什么默认不阻断：把"人还没签字"变成红灯，团队会去关掉这个检查 ——
  // 那比没有检查更糟。它应当**如实报告**，由人决定。
  if (flags.all) {
    // 复用看板的状态汇总：这样"单仓"与"多仓工作区"只有**一份**收集逻辑。
    const st = collectBoardState(root);
    if (!st.changes.length) { out(flags, '  （没有在办变更）'); return; }
    const rows = [];
    let blockedTotal = 0;
    for (const c of st.changes) {
      const ap = c.approvals || [];
      const missing = ap.filter((a) => !a.done);
      if (missing.length) blockedTotal += 1;
      rows.push({
        id: c.repo ? `${c.itemId}［${c.repo}］` : c.itemId,
        tier: c.tier, state: c.state,
        done: ap.filter((a) => a.done).length, total: ap.length,
        missing: missing.map((m) => m.name),
        who: ap.filter((a) => a.done).map((a) => `${a.name}(${a.who || '?'})`),
      });
    }
    const lines = [
      `${paint('devflow review --all', 'bold')}　人工确认点状态（共 ${rows.length} 个变更）`,
      '',
    ];
    for (const r of rows) {
      const mark = r.missing.length === 0 ? paint('✓', 'green') : paint('—', 'yellow');
      lines.push(`  ${mark} ${r.id}　${r.state}　确认 ${r.done}/${r.total}`);
      if (r.who.length) lines.push(`      已签：${r.who.join('、')}`);
      if (r.missing.length) lines.push(`      ${paint('待签：' + r.missing.join('、'), 'yellow')}`);
    }
    lines.push('');
    lines.push(`  合计：${rows.length - blockedTotal} 个已签齐，${blockedTotal} 个仍有待签项`);
    if (blockedTotal) {
      lines.push('  提示：人工确认点需要**真人**签核（agent 不得代填）；查看某个确认点的决策材料：');
      lines.push('        devflow review <变更> --point <确认点>');
    }
    out(flags, lines.join('\n'), { changes: rows.length, pending: blockedTotal, rows });
    return;
  }

  const itemId = flags.item ? String(flags.item) : pickItem(root, positional, flags);
  if (!itemId) die('用法：devflow review <变更> --point <确认点> [--by <真人> --verdict 通过|驳回]', 2);
  const dir = machineDir(root, itemId) || path.join(itemsDir(root), itemId);
  if (!existsSync(dir)) die(`变更目录不存在：${itemId}`, 2);

  const points = ['需求与判据', '契约冻结', '发布批准'];
  const point = flags.point ? String(flags.point) : null;

  // 不带 --point：列出本变更需要哪些确认点、当前状态
  if (!point) {
    const appRaw = (() => {
      for (const f of [path.join(dir, 'APPROVALS.md'), path.join(itemsDir(root), itemId, 'APPROVALS.md')]) {
        if (existsSync(f)) return readFileSync(f, 'utf8');
      }
      return '';
    })();
    const approvals = parseApprovals(appRaw);
    const lines = [`${paint('devflow review', 'bold')}  ${itemId}`, '', '本变更的确认点：'];
    for (const pt of points) {
      // ⚠️ 必须用 isRealValue 过滤：模板占位行（（姓名）/（ISO 时间）/通过 / 驳回）**不算已签核**。
      // 曾把占位显示成"✓ 已记录"，让人以为签好了 —— 与"失败必须可见"直接冲突（实测踩到）。
      const rec = approvals.find((a) => String(a.point).includes(pt)
        && isRealValue(a.who) && isRealValue(a.at) && isRealValue(a.verdict));
      const pending = approvals.find((a) => String(a.point).includes(pt) && !rec);
      const mark = rec
        ? `${paint('✓', 'green')} 已记录（${rec.who} / ${rec.verdict}）`
        : pending
          ? `${paint('—', 'yellow')} 尚未签核（仍是模板占位）`
          : '— 未记录';
      lines.push(`  ${pt}　${mark}`);
    }
    lines.push('');
    lines.push(`查看某个确认点的决策材料：devflow review ${itemId} --point <确认点>`);
    out(flags, lines.join('\n'), { itemId, approvals });
    return;
  }

  const pack = buildReviewPack(root, itemId, point, flags);
  pack.currentFingerprint = currentFingerprint({ point, spec: pack.specRaw, contract: pack.contractRaw, verification: pack.verificationRaw });

  // 记录结论
  if (flags.by || flags.verdict) {
    if (!flags.by) die('记录结论必须指定 --by <真人姓名>（agent 不得代为签核）', 2);
    if (!flags.verdict) die('记录结论必须指定 --verdict 通过|驳回', 2);
    if (!/^(通过|驳回)$/.test(String(flags.verdict))) die(`--verdict 只能是通过 或 驳回（收到：${flags.verdict}）`, 2);
    if (!pack.canSign && String(flags.verdict) === '通过' && !flags.force) {
      die([
        `材料不全，拒绝记录「通过」：`,
        ...pack.blockers.map((b) => `  ⛔ ${b}`),
        '',
        '  若确认要签（例如某项已知并接受），加 --force 并在 --note 里写明理由。',
      ].join('\n'), 2);
    }
    const appFile = (() => {
      for (const f of [path.join(dir, 'APPROVALS.md'), path.join(itemsDir(root), itemId, 'APPROVALS.md')]) {
        if (existsSync(f)) return f;
      }
      return null;
    })();
    if (!appFile) die('没有 APPROVALS.md —— 先 devflow fill <变更> --to <状态> 生成', 2);
    const lines = readFileSync(appFile, 'utf8').split('\n');
    const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    let hit = -1;
    for (let i = 0; i < lines.length; i += 1) {
      if (/^\s*\|/.test(lines[i]) && lines[i].includes(point) && !/确认点/.test(lines[i]) && !/^\s*\|[\s:|-]+\|\s*$/.test(lines[i])) { hit = i; break; }
    }
    // 旧格式（无「内容指纹」列）自动补列：否则指纹无处可写 ⇒ "签完再改"仍无人察觉
    // 旧格式（无「内容指纹」列）自动补列：否则指纹无处可写 ⇒ "签完再改"仍无人察觉
    // 注意：必须**按单元格重建整行**，不能简单在行尾贴字符串（会把列写错位，实测踩到）
    const hIdx = lines.findIndex((l) => /^\s*\|.*确认点/.test(l) && /确认人/.test(l));
    if (hIdx >= 0 && !/内容指纹/.test(lines[hIdx])) {
      const rebuild = (l, extra) => {
        const cs = l.split('|').map((c) => c.trim());
        const head = cs[0]; const tail = cs[cs.length - 1];
        const body = cs.slice(1, -1);
        while (body.length < 4) body.push('');
        return `${head}| ${body.slice(0, 4).join(' | ')} | ${extra} |${tail}`;
      };
      lines[hIdx] = rebuild(lines[hIdx], '内容指纹');
      if (/^\s*\|[\s:|-]+\|\s*$/.test(lines[hIdx + 1] || '')) lines[hIdx + 1] = rebuild(lines[hIdx + 1], '---');
      // 已有记录行补占位格：旧签字无指纹 ⇒ 保持"不判定失效"，不误伤历史
      for (let i = hIdx + 2; i < lines.length && /^\s*\|/.test(lines[i]); i += 1) {
        if (!/内容指纹/.test(lines[i])) lines[i] = rebuild(lines[i], '（无）');
      }
    }
    const cells = hit >= 0 ? lines[hit].split('|').map((c) => c.trim()).slice(1, -1) : [point, '', '', '', ''];
    while (cells.length < 5) cells.push('');
    // 指纹：签字必须绑定所批准的内容，否则「签完再改」无人察觉（实测确认过这个漏洞）
    const fp = currentFingerprint({ point, spec: pack.specRaw, contract: pack.contractRaw, verification: pack.verificationRaw });
    cells[0] = point; cells[1] = String(flags.by); cells[2] = at; cells[3] = String(flags.verdict);
    cells[4] = fp || '（无可绑定内容）';
    const row = `| ${cells.join(' | ')} |`;
    if (hit >= 0) lines[hit] = row;
    else {
      const hi = lines.findIndex((l) => /^\s*\|.*确认点/.test(l));
      if (hi >= 0) lines.splice(hi + 2, 0, row); else lines.push(row);
    }
    writeFileSync(appFile, lines.join('\n'), 'utf8');
    try {
      appendEvent(root, itemId, { event: 'approval', point, verdict: String(flags.verdict), by: String(flags.by), note: flags.note ? String(flags.note) : null });
    } catch { /* 事件失败不影响签核 */ }
    out(flags, [
      `${paint('✓ 已记录', 'green')}　${point}　${flags.by}　${flags.verdict}`,
      `  ${at}`,
      `  写入：${path.relative(root, appFile)}`,
      flags.note ? `  理由：${flags.note}` : '',
      !pack.canSign && flags.force ? '  ⚠ 本次为 --force 签核（材料不全，理由已记入事件）' : '',
    ].filter(Boolean).join('\n'), { itemId, point, recorded: { who: flags.by, at, verdict: flags.verdict } });
    return;
  }

  out(flags, renderPack(pack, itemId), { itemId, point, canSign: pack.canSign, blockers: pack.blockers });
}

function cmdBoard(flags) {
  // 工作区根没有 devflow.json（它不是"项目"）⇒ 看板在那里也要能用。
  let { root, loaded } = resolveProjectOrWorkspace(flags);
  // 从任意目录启动时（插件在宿主里起服务就会这样）向上找项目/工作区根。
  // 不这样做插件只能猜——它会猜成插件自己的目录（实测踩到）。
  if (!root) root = discoverProjectRoot(process.cwd());
  // 找不到根**不再直接失败**：照常起服务，面板会提示"选择工作区"（下拉里有你登记过的项目）。
  // 为什么：插件在别人机器上常常找不到项目（kit 在家目录、cwd 是宿主目录），
  // 若此时 die，面板就永远是"未启动"—— 用户只看到一个坏掉的面板，而不是"去选个项目"。
  if (!root) {
    process.stdout.write(`${paint('—', 'yellow')} 未找到项目/工作区：以「待选工作区」模式启动\n`
      + '    在面板右上角选择工作区，或先在本项目里跑 devflow init\n');
  }
  // 解析到根就登记一次：老项目第一次看看板即进入面板下拉，无需额外操作
  if (root) { try { rememberProject(root); } catch { /* 忽略 */ } }

  const port = Number(flags.port || process.env.DEVFLOW_BOARD_PORT || 8787);
  const intervalMs = Number(flags.interval || 2000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    die(`无效端口：${flags.port}\n  建议 1024–65535（如 --port 8787）`, 2);
  }
  out(flags, [
    `${paint('devflow board', 'bold')}  ${loaded.config?.devflow?.project || (root ? path.basename(root) : '（未选择工作区）')}`,
    '  正在启动本地看板（只读）…',
    `  提示：服务只监听 127.0.0.1，不对外暴露；按 Ctrl-C 停止。`,
  ].join('\n'));
  startBoard({
    projectRoot: root,
    port,
    intervalMs,
    // /view 复用 devflow view 的渲染结果：一个地址就能看全部阶段文档
    viewHtml: (r) => ((r || root) ? cmdView({ root: r || root }, { returnHtml: true }) : null),
    onReady: (addr) => {
      process.stdout.write([
        '',
        `  ${paint('✓ 看板已启动', 'green')}  ${paint(addr, 'bold')}`,
        `  ${paint('✓ 文档视图', 'green')}    ${paint(addr + '/view', 'bold')}  （全部变更与各阶段文档）`,
        `  （在聊天里请把上面这个地址作为可点击链接给出；不要只说"已启动"）`,
        `  内容：节点任务数 · 任务卡（状态/负责人/阻塞原因）· 点任务看「前世今生」`,
        `  实时：文件变化 2 秒内自动刷新（SSE）`,
        '',
        '  要改状态？在 CLI 或聊天里操作（例如 devflow task <变更> T-2 --status 进行中）',
      ].join('\n') + '\n');
    },
    // 端口被占用是常见情形（上一次的看板还在跑）。区分两种：
    //   ① 已有的 devflow 看板 ⇒ 直接告诉地址，复用，不报错退出；
    //   ② 别的程序占着 ⇒ 给出换端口的明确命令。
    onError: async (err) => {
      const url = `http://127.0.0.1:${port}`;
      if (!err || err.code !== 'EADDRINUSE') {
        die(`看板启动失败：${err && err.message ? err.message : err}`, 2);
        return;
      }
      let isBoard = false;
      try {
        const r = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1500) });
        const j = await r.json();
        isBoard = Boolean(j && typeof j === 'object' && 'servedRoot' in j);
      } catch { /* 不是看板，或不可达 */ }
      if (isBoard) {
        process.stdout.write([
          '',
          `  ${paint('✓ 看板已在运行', 'green')}  ${paint(url, 'bold')}`,
          '  端口上已经有一个 devflow 看板，直接用它即可（复用同一实例）。',
          '  要重启：先停掉旧进程，或换端口 → devflow board --port ' + (port + 1),
          '',
        ].join('\n') + '\n');
        process.exit(0);
      }
      die(`端口 ${port} 已被其他程序占用（不是 devflow 看板）。\n`
        + `  换一个端口：devflow board --port ${port + 1}\n`
        + `  查看占用者：lsof -nP -iTCP:${port} -sTCP:LISTEN`, 2);
    },
  });
  // 前台常驻，直到 Ctrl-C
}

function cmdHistory(flags, positional) {
  const { root } = resolveProject(flags);
  const itemId = flags.item ? String(flags.item) : pickItem(root, positional, flags);
  if (!itemId) die('用法：devflow history <变更> [--json] [--task T-2]', 2);
  let events = [];
  try { events = readEvents(root, itemId); } catch { events = []; }
  if (!events.length) {
    out(flags, `  ${itemId} 还没有事件记录（history 为空）`, { itemId, events: [] });
    return;
  }
  const only = flags.task ? String(flags.task) : null;
  const list = only ? events.filter((e) => e.task === only) : events;
  if (flags.json) { out(flags, { itemId, events: list }, { itemId, events: list }); return; }
  const fmt = (e) => {
    const t = localTime(e.at);
    if (e.event === 'task.update') return `${t}  任务 ${e.task}  ${(e.changes || []).join('；')}  (${e.by || '-'})`;
    if (e.event === 'clarify') return `${t}  澄清 ${e.qid} → ${e.state}  (${e.by || '-'})`;
    // 统一走人话层（与看板同一份说法，见 lib/humanize.mjs）——
    // 此前这里直接摊 JSON 片段、状态还是英文，用户看不懂
    return `${t}  ${humanEvent(e)}`;
  };
  out(flags, [
    `${paint('devflow history', 'bold')}  ${itemId}`,
    `  事件数：${list.length}${only ? `（仅任务 ${only}）` : ''}`,
    '',
    ...list.slice(-40).map((e) => `  ${fmt(e)}`),
    list.length > 40 ? `  …（只显示最近 40 条，共 ${list.length} 条）` : '',
  ].filter(Boolean).join('\n'), { itemId, events: list });
}

function cmdGraph(flags) {
  const { root } = resolveProject(flags);
  const kind = flags.kind ? String(flags.kind) : 'tasks';
  const items = graphData(root);
  const want = (k) => kind === 'all' || kind === k;

  if (kind === 'stages') {
    out(flags, renderStageGraph(), { kind });
    return;
  }
  if (kind === 'flow') {
    if (!items.length) die('没有在办变更 —— 先 devflow new 建一个变更', 2);
    out(flags, renderFlowGraph(items), { kind, items: items.length });
    return;
  }
  if (kind === 'all') {
    const parts = [];
    for (const c of items) {
      parts.push(`### ${c.itemId}（${c.state}）`, '', renderTaskGraph(c), '');
    }
    if (!parts.length) die('没有在办变更', 2);
    out(flags, parts.join('\n'), { kind, items: items.length });
    return;
  }
  // 默认：任务依赖图（全部变更）
  if (!items.length) die('没有在办变更 —— 先 devflow new 建一个变更', 2);
  const withTasks = items.filter((c) => c.tasks.length);
  if (!withTasks.length) die('这些变更还没有任务分解（TASKS.md 未产出）', 2);
  const parts = withTasks.map((c) => `### ${c.itemId}（${c.state}）\n\n${renderTaskGraph(c)}`);
  out(flags, parts.join('\n\n'), { kind: 'tasks', items: withTasks.length });
}

function cmdView(flags, opts = {}) {
    // 工作区根没有 devflow.json ⇒ 视图在那里也要能用（它本来就该汇总整个工作区）
  const { root, loaded, marker } = (() => {
    const r = resolveProjectOrWorkspace(flags);
    if (!r.root) die('既不是 devflow 项目，也不是多仓工作区', 2);
    return { root: r.root, loaded: r.loaded, marker: r.root ? 'workspace-or-project' : null };
  })();
  // 默认产物放在 .devflow/ 下（与其它产物一致、在项目内、可被 present）。
  // 曾与 report 各用不同默认名（devflow-view.html vs .devflow/board.html），属实现不一致。
  const outFile = flags.out ? String(flags.out) : path.join('.devflow', 'board.html');
  // 与看板**共用同一数据来源**（含多仓工作区成员）：视图与看板必须是
  // "同一状态的两种视图"，否则两边会各说各话（UI 定论里的硬约束）。
  const boardState = collectBoardState(root);
  const items = boardState.changes.length
    ? boardState.changes.map((c) => {
      const base = c.repo ? path.join(root, c.repo) : root;
      let extra = {};
      try { extra = collectChange(base, c.itemId); } catch { extra = {}; }
      return { ...extra, ...c };
    })
    : listItems(root).map((i) => collectChange(root, i.itemId));
  let verdict = null;
  try {
    verdict = diagnose({ projectRoot: root, config: loaded.config, marker,
      cwd: process.cwd(), kitVersion: kitVersion(), kitRoot: KIT_ROOT }).verdict;
  } catch { /* 体检失败不阻塞视图 */ }

  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const statusColor = (st) => (/已完成/.test(st) ? '#0a7d33' : /阻塞/.test(st) ? '#c0392b' : /进行中/.test(st) ? '#b7791f' : '#6b7280');
  const layerColor = (ly) => ({ 前端: '#2563eb', 后端: '#7c3aed', 数据库: '#0891b2', 契约: '#c2410c', 文档: '#4b5563' }[ly] || '#6b7280');

  // ── 阶段文档的锚点与目录 ─────────────────────────────────────────
  // 目标：**每个阶段的每个文档都能被点击查看，且能被深链**（#doc-<变更>-<文档>）。
  // 之前只有"当前阶段要求且已存在"的产物才可展开，用户想读某个文档得先猜它在哪个阶段里。
  const slugOf = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'x';
  const docAnchor = (itemId, file) => `doc-${slugOf(itemId)}-${slugOf(file)}`;
  const DOC_LABEL = {
    'SPEC.md': '需求与验收标准',
    'CLARIFY.md': '需求澄清答复',
    'CONTRACT.md': '契约与破坏性判定',
    'TASKS.md': '任务分解',
    'coding_report.md': '实现报告',
    'verification.md': '验证记录',
    'APPROVALS.md': '人工确认记录',
    'release/report.md': '发布报告',
  };
  const docLabelOf = (f) => DOC_LABEL[f] || f;
  // 目录来源：先按**阶段顺序**取该阶段声明的产物（保证语义顺序），
  // 再补上磁盘上确实存在、但没被任何阶段声明的文件（不丢信息）。
  const docCatalog = (c) => {
    const seen = new Set(); const list = [];
    for (const st of (c.stateInfo || [])) {
      for (const r of (st.reqs || [])) {
        if (seen.has(r.file)) continue;
        seen.add(r.file);
        list.push({ file: r.file, stage: st.name, ok: r.ok, stageKey: st.key });
      }
    }
    for (const f of Object.keys(c.docs || {})) {
      if (seen.has(f)) continue;
      seen.add(f);
      list.push({ file: f, stage: null, ok: true, stageKey: null });
    }
    return list;
  };
  // 缺失产物的"下一步"提示：不要只说缺失，要告诉人怎么补
  const fillHint = (c, stageKey) => {
    if (!stageKey) return '';
    return `<code class="mono">devflow fill ${esc(c.itemId)} --to ${esc(stageKey)}</code>`;
  };

  const STATE_FLOW = ['draft', 'spec_ready', 'contracted', 'implementing', 'tested', 'verified', 'released'];
  const STATE_NAME = { draft: '草稿', spec_ready: '需求就绪', contracted: '契约冻结', implementing: '实现中', tested: '待验证', verified: '已验证', released: '已发布' };

  const changeHtml = items.map((c) => {
    // 状态芯片可点击：点开看该阶段「要求什么 + 当前满足没有 + 由哪个门禁把关」
    const svg = { ok: '✓', no: '✗' };
    const flow = c.stateInfo.map((st) => {
      const cls = st.pos < c.curIdx ? 'done' : st.pos === c.curIdx ? 'now' : 'todo';
      const reqHtml = st.reqs.length
        ? `<ul class="reqs">${st.reqs.map((r) => {
          const ok = Boolean(c.docs[r.file]);
          // 已存在 ⇒ 跳到本变更的「阶段文档」区并自动展开（页尾脚本负责展开与高亮）
          return `<li class="${ok ? 'ok' : 'no'}">${ok ? '✓' : '✗'} `
            + `<a class="doclink" href="#${docAnchor(c.itemId, r.file)}"><span class="mono">${esc(r.file)}</span></a>`
            + ` <span class="small">${esc(docLabelOf(r.file))}</span>`
            + (ok ? '' : ` <span class="small">（缺失 · 可用 ${fillHint(c, st.key)} 生成）</span>`)
            + '</li>';
        }).join('')}</ul>`
        : '<p class="muted small">本阶段无额外产物要求</p>';
      const reachNote = st.pos < c.curIdx ? '已通过'
        : st.pos === c.curIdx ? '← 当前在此'
        : (st.missing === 0 ? '产物已齐，可推进' : `还缺 ${st.missing} 项产物`);
      // 该阶段的"相关任务"（任务只与 实现中/待验证/已验证 三个阶段相关）
      const rel = (c.stageTasks || {})[st.key] || null;
      const taskHtml = rel
        ? (rel.length
          ? `<p class="small muted">相关任务（${rel.length}）：</p><ul class="reqs">${rel.map((t) => {
            const col = /已完成/.test(t.status) ? '#0a7d33' : /阻塞/.test(t.status) ? '#c0392b' : /进行中/.test(t.status) ? '#b7791f' : '#6b7280';
            return `<li><span class="dot" style="background:${col}"></span><span class="mono">${esc(t.t)}</span> ${esc(t.layer || '')} ${esc(t.owner || '')} · ${esc(t.status)}</li>`;
          }).join('')}</ul>`
          : '<p class="small muted">本阶段暂无相关任务</p>')
        : '<p class="small muted">本阶段不涉及任务（需求/切分或发布收尾）</p>';
      const cnt = rel ? rel.length : 0;
      const badge = cnt ? `<span class="cnt">${cnt} 个任务</span>` : '';
      return `<details class="st ${cls}" data-stage="${esc(st.key)}">
        <summary>${esc(st.name)}${badge}</summary>
        <div class="stbody">
          <p class="sdesc">${esc(st.desc)}</p>
          <p class="small muted">${esc(reachNote)}${st.gate ? `　·　把关门禁：<span class="mono">${esc(st.gate)}</span>` : ''}</p>
          <p class="small muted">需要的产物：</p>
          ${reqHtml}
          ${taskHtml}
        </div>
      </details>`;
    }).join('<span class="arrow">→</span>');
    const pct = c.taskTotal ? Math.round((c.done / c.taskTotal) * 100) : 0;
    // 每行任务 = 一个可点击的 <details>：点开看该任务的完整信息（零 JS，离线可用）
    const rows = c.tasks.map((t) => {
      const ac = c.acMap[t.ac] || null;
      const blockedBy = c.blockersOf[t.t] || [];
      const depTxt = String(t.dep || '').trim();
      const why = depTxt && depTxt !== '无'
        ? `依赖 ${esc(depTxt)} 先完成${blockedBy.length ? '' : '（该依赖当前无明确负责人，建议在会话里确认）'}`
        : '无依赖，可直接开始';
      const acTxt = ac ? `判据：${esc(ac.judge)}　类型：${esc(ac.type)}` : '（该 AC 在 SPEC 中未找到，建议核对编号）';
      // data-stages：该任务在哪些阶段相关（供阶段芯片点击后过滤）
      const stageOf = (st) => {
        if (/阻塞/.test(t.status)) return ['implementing'];
        if (/进行中/.test(t.status) || /待开始/.test(t.status)) return ['implementing'];
        if (/已完成/.test(t.status)) return ['tested', 'verified'];
        return ['implementing'];
      };
      return `<details class="task" id="task-${slugOf(c.itemId)}-${slugOf(t.t)}" data-task="${esc(t.t)}" data-stages="${stageOf(t).join(',')}">
      <summary>
        <span class="mono tid">${esc(t.t)}</span>
        <span class="tag" style="background:${layerColor(t.layer)}">${esc(t.layer || '—')}</span>
        <span class="sum-repo">${esc(t.repo)}</span>
        <span class="sum-status"><span class="dot" style="background:${statusColor(t.status)}"></span>${esc(t.status || '未标注')}</span>
        <span class="sum-owner">${esc(t.owner || '(未指派)')}</span>
        <span class="caret">点击展开</span>
      </summary>
      <div class="detail">
        <dl>
          <dt>对应验收标准</dt><dd>${esc(t.ac)}　${acTxt}</dd>
          <dt>验收命令</dt><dd class="mono">${esc(t.cmd || '(未填)')}</dd>
          <dt>写入范围</dt><dd class="mono">${esc(t.range)}</dd>
          <dt>依赖</dt><dd>${why}</dd>
          <dt>负责人</dt><dd>${esc(t.owner || '(未指派)')}</dd>
        </dl>
      </div>
    </details>`;
    }).join('');
    // 两条与门禁同口径的提示：未决项（拦住实现）、分层覆盖（D15 会报漏层）
    const alerts = [];
    if (c.clarify.total) {
      alerts.push(c.clarify.pending
        ? `<span class="alert bad">需求澄清 ${c.clarify.pending}/${c.clarify.total} 未决 —— 未决项不允许进实现</span>`
        : `<span class="alert ok">需求澄清已全部回答（${c.clarify.total} 项）</span>`);
    }
    if (c.needLayers.length) {
      alerts.push(c.missingLayers.length
        ? `<span class="alert bad">任务缺责任层：${esc(c.missingLayers.join('、'))}</span>`
        : `<span class="alert ok">责任层已覆盖：${esc(c.layers.join('、'))}</span>`);
    }
    // ── 阶段文档中心 ──────────────────────────────────────────────
    // 把本变更的**全部**阶段产物聚到一处（含尚未产出的），每个都有锚点：
    // 点 chip 或点阶段里的产物名 → 跳到对应文档并自动展开。
    const catalog = docCatalog(c);
    const chips = catalog.map((d) => {
      const label = esc(d.file);
      if (!d.ok) {
        return `<span class="dchip no" title="尚未产出${d.stage ? `（${esc(d.stage)}阶段要求）` : ''}">✗ ${label}</span>`;
      }
      return `<a class="dchip ok" href="#${docAnchor(c.itemId, d.file)}" title="${esc(docLabelOf(d.file))}${d.stage ? ` · ${esc(d.stage)}` : ''}">${label}</a>`;
    }).join('');
    const docBlocks = catalog.map((d) => {
      const id = docAnchor(c.itemId, d.file);
      const body = c.docs[d.file];
      const stageTag = `<span class="dstage">${d.stage ? esc(d.stage) : '—'}</span>`;
      if (!body) {
        return `<div class="doc missing" id="${id}">
          <div class="drow"><span class="no">✗</span> <span class="mono">${esc(d.file)}</span>${stageTag}
            <span class="small">尚未产出${d.stageKey ? `　·　可用 ${fillHint(c, d.stageKey)} 生成模板` : ''}</span></div>
        </div>`;
      }
      return `<details class="doc" id="${id}">
        <summary><span class="ok">✓</span> <span class="mono">${esc(d.file)}</span>${stageTag}
          <span class="dlabel">${esc(docLabelOf(d.file))}</span>
          <span class="copy">查看全文</span></summary>
        <div class="docbody md">${mdToHtml(body)}</div>
        <details class="raw"><summary>查看 Markdown 源码</summary><pre class="docbody">${esc(body)}</pre></details>
      </details>`;
    }).join('');
    const produced = catalog.filter((d) => d.ok).length;
    const docCenter = catalog.length ? `<div class="doccenter">
      <div class="docbar">
        <span class="muted small">阶段文档（${produced}/${catalog.length} 已产出）：</span>
        ${chips}
        <span class="docbar-actions">
          <button type="button" class="dbx" data-doc-expand="1">全部展开</button>
          <button type="button" class="dbx" data-doc-expand="0">全部收起</button>
        </span>
      </div>
      <div class="docs">${docBlocks}</div>
    </div>` : '';

    return `<section class="card" id="chg-${slugOf(c.itemId)}">
    <h2>${esc(c.itemId)} <span class="tier">${esc(c.tier)}</span></h2>
    ${alerts.length ? `<div class="alerts">${alerts.join('')}</div>` : ''}
    <div class="flow">${flow}</div>
    ${docCenter}
    <div class="progress"><div class="bar" style="width:${pct}%"></div></div>
    <div class="muted">任务进度：${c.done}/${c.taskTotal} 已完成（进行中 ${c.running}，阻塞 ${c.blocked}）</div>
    ${c.taskTotal ? (() => {
      // 依赖关系用原生 HTML 表达（不再依赖 Mermaid CDN）——离线也能正确显示，
      // 且每个依赖都是可点的锚点，直接跳到目标任务。
      const depRows = c.tasks.filter((t) => {
        const d = String(t.dep || '').trim();
        return d && d !== '无';
      }).map((t) => {
        const deps = String(t.dep).split(/[、,，;；\s]+/).filter(Boolean);
        const links = deps.map((d) => {
          const known = c.tasks.some((x) => x.t === d);
          return known
            ? `<a class="doclink mono" href="#task-${slugOf(c.itemId)}-${slugOf(d)}">${esc(d)}</a>`
            : `<span class="mono">${esc(d)}</span>`;
        }).join('、');
        return `<li><a class="doclink mono" href="#task-${slugOf(c.itemId)}-${slugOf(t.t)}">${esc(t.t)}</a>`
          + ` <span class="small">依赖</span> ${links}</li>`;
      }).join('');
      return `<details class="graph"><summary>任务依赖关系（${depRows ? '点编号跳到任务' : '无依赖'}）</summary>
      ${depRows ? `<ul class="deplist">${depRows}</ul>`
        : '<p class="muted small">所有任务相互独立，无依赖。</p>'}
    </details>`;
    })() : ''}
    ${c.taskTotal ? `<div class="filterbar" data-for="${esc(c.itemId)}">
      <span class="muted small">任务列表：</span>
      <button type="button" class="fbtn on" data-filter="all">全部 ${c.taskTotal}</button>
      <button type="button" class="fbtn" data-filter="implementing">实现中 ${(c.stageTasks.implementing || []).length}</button>
      <button type="button" class="fbtn" data-filter="tested">待验证 ${(c.stageTasks.tested || []).length}</button>
      <button type="button" class="fbtn" data-filter="verified">已验证 ${(c.stageTasks.verified || []).length}</button>
      <span class="fnote"></span>
    </div><div class="tasks">${rows}</div>`
      : '<p class="muted">尚无任务分解（TASKS.md 未产出或未填写）</p>'}
  </section>`;
  }).join('');

  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>devflow 视图 · ${esc(loaded.config?.devflow?.project || path.basename(root))}</title>
<style>
 :root{--bd:#e5e7eb;--mut:#6b7280}
 *{box-sizing:border-box}
 body{font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Helvetica Neue",Arial,sans-serif;margin:0;padding:28px;background:#f8fafc;color:#111827}
 h1{font-size:20px;margin:0 0 4px} h2{font-size:16px;margin:0 0 12px}
 .sub{color:var(--mut);margin-bottom:20px}
 .card{background:#fff;border:1px solid var(--bd);border-radius:10px;padding:18px;margin-bottom:16px}
 .flow{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:12px}
 details.st{position:relative}
 details.st>summary{padding:3px 10px;border-radius:999px;font-size:12px;border:1px solid var(--bd);color:var(--mut);background:#fff;cursor:pointer;list-style:none}
 details.st>summary::-webkit-details-marker{display:none}
 details.st>summary:hover{border-color:#94a3b8;color:#111827}
 details.st.done>summary{background:#e8f5ec;color:#0a7d33;border-color:#bfe3c9}
 details.st.now>summary{background:#fff4e5;color:#b7791f;border-color:#f0d6a8;font-weight:600}
 details.st[open]>summary{outline:2px solid #cbd5e1}
 .stbody{position:absolute;z-index:5;left:0;top:calc(100% + 6px);width:300px;background:#fff;border:1px solid var(--bd);
   border-radius:8px;padding:12px;box-shadow:0 6px 20px rgba(15,23,42,.12);text-align:left;font-weight:400}
 .sdesc{margin:0 0 6px}
 .cnt{display:inline-block;margin-left:6px;font-size:11px;background:#e0e7ff;color:#3730a3;border-radius:999px;padding:0 6px;font-weight:600}
 .alerts{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px}
 .alert{font-size:12px;border-radius:6px;padding:3px 9px}
 .alert.ok{background:#e8f5ec;color:#0a7d33} .alert.bad{background:#fdecea;color:#c0392b}
 .filterbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:12px 0 6px}
 .fbtn{font:inherit;font-size:12px;padding:3px 10px;border:1px solid var(--bd);background:#fff;color:#374151;
   border-radius:999px;cursor:pointer}
 .fbtn:hover{border-color:#94a3b8}
 .fbtn.on{background:#1d4ed8;border-color:#1d4ed8;color:#fff;font-weight:600}
 .fnote{font-size:12px;color:var(--mut)}
 details.task.hidden{display:none}
 .nofilter{display:none;padding:10px 12px;color:var(--mut);font-size:13px}
 details.graph{margin:0 0 10px}
 details.graph>summary{cursor:pointer;color:var(--mut);font-size:12px}
 details.graph>summary::-webkit-details-marker{display:none}
 details.arch>summary{cursor:pointer;font-weight:600}
 details.doc>summary{cursor:pointer;list-style:none}
 details.doc>summary::-webkit-details-marker{display:none}
 .copy{font-size:11px;color:#2563eb;border:1px solid #bfdbfe;border-radius:999px;padding:0 6px}
 pre.docbody{max-height:300px;overflow:auto;background:#0f172a;color:#e2e8f0;padding:10px;border-radius:6px;
   font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;margin:6px 0 2px}
 ul.reqs{list-style:none;padding:0;margin:4px 0 0;font-size:12px}
 ul.reqs li{padding:1px 0}
 ul.reqs li.ok{color:#0a7d33} ul.reqs li.no{color:#c0392b}
 .chip{padding:3px 10px;border-radius:999px;font-size:12px;border:1px solid var(--bd);color:var(--mut);background:#fff}
 .chip.done{background:#e8f5ec;color:#0a7d33;border-color:#bfe3c9}
 .chip.now{background:#fff4e5;color:#b7791f;border-color:#f0d6a8;font-weight:600}
 .arrow{color:#cbd5e1}
 .progress{height:8px;background:#eef2f7;border-radius:999px;overflow:hidden;margin:6px 0 10px}
 .bar{height:100%;background:linear-gradient(90deg,#34d399,#059669)}
 table{width:100%;border-collapse:collapse;margin-top:10px}
 .tasks{margin-top:10px;border:1px solid var(--bd);border-radius:8px;overflow:hidden}
 details.task{border-bottom:1px solid var(--bd);background:#fff}
 details.task:last-child{border-bottom:0}
 details.task>summary{display:flex;align-items:center;gap:10px;padding:9px 12px;cursor:pointer;list-style:none}
 details.task>summary::-webkit-details-marker{display:none}
 details.task>summary:hover{background:#f6f9ff}
 details.task[open]>summary{background:#eef4ff;font-weight:600}
 .tid{font-weight:600;min-width:38px}
 .sum-repo{color:var(--mut);font-size:12px}
 .sum-status{color:var(--mut);font-size:12px}
 .sum-owner{color:var(--mut);font-size:12px;margin-left:auto}
 .caret{color:#94a3b8;font-size:11px;border:1px solid var(--bd);border-radius:999px;padding:1px 8px}
 details.task[open] .caret{visibility:hidden}
 .detail{padding:4px 14px 14px;background:#fbfdff;border-top:1px dashed var(--bd)}
 dl{display:grid;grid-template-columns:96px 1fr;gap:6px 12px;margin:10px 0 0}
 dt{color:var(--mut);font-size:12px} dd{margin:0}
 th,td{text-align:left;padding:7px 9px;border-bottom:1px solid var(--bd);vertical-align:top}
 th{font-size:12px;color:var(--mut);font-weight:600;background:#fbfdff}
 .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
 .small{font-size:12px;color:var(--mut)}
 .tag{color:#fff;border-radius:5px;padding:1px 7px;font-size:12px}
 .dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px}
 .tier{font-size:12px;color:var(--mut);border:1px solid var(--bd);border-radius:5px;padding:1px 6px;font-weight:400}
 .muted{color:var(--mut)}
 .badge{display:inline-block;padding:3px 10px;border-radius:6px;font-size:12px}
 .badge.ok{background:#e8f5ec;color:#0a7d33} .badge.warn{background:#fff4e5;color:#b7791f} .badge.bad{background:#fdecea;color:#c0392b}
 footer{margin-top:22px;color:var(--mut);font-size:12px}
  /* ── 阶段文档中心 ─────────────────────────────────────── */
  .doccenter{margin:12px 0 4px;border:1px solid var(--bd);border-radius:8px;overflow:hidden}
  .docbar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;padding:9px 12px;background:#fbfdff;border-bottom:1px solid var(--bd)}
  .docbar-actions{margin-left:auto;display:flex;gap:6px}
  .dchip{font-size:12px;border-radius:999px;padding:1px 9px;text-decoration:none;border:1px solid var(--bd)}
  .dchip.ok{background:#e8f5ec;color:#0a7d33;border-color:#bfe3c9}
  .dchip.ok:hover{background:#d7eedf}
  .dchip.no{background:#f6f7f9;color:#9ca3af;border-style:dashed}
  .dbx{font:inherit;font-size:12px;padding:2px 9px;border:1px solid var(--bd);background:#fff;border-radius:999px;cursor:pointer;color:#374151}
  .dbx:hover{border-color:#94a3b8}
  .docs{padding:2px 12px 8px}
  details.doc{border-bottom:1px dashed var(--bd)}
  details.doc:last-child{border-bottom:0}
  details.doc>summary{display:flex;align-items:center;gap:8px;padding:7px 2px;cursor:pointer;list-style:none}
  details.doc>summary::-webkit-details-marker{display:none}
  details.doc>summary:hover{background:#f6f9ff}
  details.doc[open]>summary{font-weight:600;background:#eef4ff}
  .dstage{font-size:11px;color:#fff;background:#94a3b8;border-radius:4px;padding:0 6px;white-space:nowrap}
  .dlabel{font-size:12px;color:var(--mut)}
  details.doc[open] .copy{visibility:hidden}
  .doc.missing{padding:7px 2px;border-bottom:1px dashed var(--bd);color:#c0392b}
  .doc.missing:last-child{border-bottom:0}
  .drow{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
  .ok{color:#0a7d33} .no{color:#c0392b}
  .doclink{color:#2563eb;text-decoration:none;border-bottom:1px dotted #93c5fd}
  .doclink:hover{color:#1d4ed8;border-bottom-style:solid}
  /* 锚点高亮：从阶段产物或外部深链跳进来时，让目标一眼可见 */
  details.doc:target>summary{outline:2px solid #2563eb;outline-offset:-2px;border-radius:6px;background:#eef4ff}
  .doc.missing:target{outline:2px solid #2563eb;outline-offset:-2px;border-radius:6px}
  details.task:target>summary{background:#eef4ff;outline:2px solid #2563eb;outline-offset:-2px}
  /* ── 需求流转总览（原生渲染，不依赖 Mermaid） ───────────── */
  .stageflow{display:flex;flex-wrap:wrap;align-items:flex-start;gap:8px}
  .sfcol{min-width:108px;border:1px solid var(--bd);border-radius:8px;padding:8px;background:#fbfdff}
  .sfcol.has{background:#fff;border-color:#cbd5e1}
  .sfname{font-size:12px;color:var(--mut);margin-bottom:6px;white-space:nowrap}
  .sfitem{display:block;font-size:12px;text-decoration:none;color:#2563eb;padding:2px 0;border-bottom:1px dotted #93c5fd}
  .sfitem:hover{color:#1d4ed8}
  ul.deplist{list-style:none;margin:6px 0 0;padding:0;font-size:12px}
  ul.deplist li{padding:2px 0}
  /* ── 文档正文：渲染后的 Markdown（默认视图） ────────────── */
  .docbody.md{background:#fff;border:1px solid var(--bd);border-radius:8px;padding:14px 16px;margin:6px 0 10px;
    max-height:560px;overflow:auto;line-height:1.7;font-size:13.5px;color:#1f2937}
  .docbody.md h1,.docbody.md h2,.docbody.md h3,.docbody.md h4,.docbody.md h5,.docbody.md h6{margin:14px 0 8px;line-height:1.35}
  .docbody.md h1{font-size:19px;border-bottom:1px solid var(--bd);padding-bottom:6px}
  .docbody.md h2{font-size:16px;border-bottom:1px solid var(--bd);padding-bottom:4px}
  .docbody.md h3{font-size:14.5px}
  .docbody.md h4{font-size:13.5px;color:#374151}
  .docbody.md>h1:first-child,.docbody.md>h2:first-child,.docbody.md>p:first-child{margin-top:0}
  .docbody.md p{margin:8px 0}
  .docbody.md ul,.docbody.md ol{margin:8px 0;padding-left:22px}
  .docbody.md li{margin:3px 0}
  .docbody.md blockquote{margin:10px 0;padding:6px 12px;border-left:3px solid #cbd5e1;background:#f8fafc;color:#475569}
  .docbody.md blockquote p{margin:4px 0}
  .docbody.md hr{border:0;border-top:1px solid var(--bd);margin:14px 0}
  .docbody.md a{color:#2563eb}
  .docbody.md code{background:#f1f5f9;border:1px solid var(--bd);border-radius:4px;padding:1px 5px;
    font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
  .docbody.md pre.code{background:#0f172a;color:#e2e8f0;padding:10px 12px;border-radius:6px;overflow:auto;
    font-size:12px;line-height:1.55;margin:10px 0}
  .docbody.md pre.code code{background:none;border:0;padding:0;color:inherit;font-size:inherit}
  .docbody.md .tablewrap{overflow:auto;margin:10px 0}
  .docbody.md table{width:100%;border-collapse:collapse;font-size:12.5px}
  .docbody.md th,.docbody.md td{border:1px solid var(--bd);padding:6px 9px;text-align:left;vertical-align:top}
  .docbody.md th{background:#f8fafc;font-weight:600;color:#374151}
  .docbody.md tbody tr:nth-child(even) td{background:#fcfdff}
  details.raw{margin:0 0 10px}
  details.raw>summary{cursor:pointer;color:var(--mut);font-size:12px;list-style:none}
  details.raw>summary::-webkit-details-marker{display:none}
  details.raw>summary:hover{color:#111827}
</style></head><body>
<h1>devflow 视图 · ${esc(loaded.config?.devflow?.project || path.basename(root))}</h1>
<div class="sub">${esc(root)}　·　生成于 ${esc(localTime(new Date().toISOString()))}</div>
${verdict ? `<section class="card"><h2>门禁可信度</h2><span class="badge ${verdict.trustworthy ? (verdict.counts?.weak ? 'warn' : 'ok') : 'bad'}">${esc(verdict.summary)}</span><div class="muted" style="margin-top:8px">阻断 ${verdict.counts?.block ?? 0} · 削弱 ${verdict.counts?.weak ?? 0} · 提示 ${verdict.counts?.info ?? 0}</div></section>` : ''}
${items.length ? `<section class="card"><h2>需求流转总览</h2>
  <div class="stageflow">${STATE_FLOW.map((k, i) => {
    const list = items.filter((c) => (STATE_FLOW.includes(c.state) ? c.state : 'draft') === k);
    const col = `<div class="sfcol ${list.length ? 'has' : ''}">
      <div class="sfname">${esc(STATE_NAME[k])}<span class="cnt">${list.length}</span></div>
      ${list.map((c) => `<a class="sfitem" href="#chg-${slugOf(c.itemId)}">${esc(c.itemId)}</a>`).join('')}
    </div>`;
    return (i ? '<span class="arrow">→</span>' : '') + col;
  }).join('')}</div>
  <p class="muted small">点任意变更跳到它下面。文档锚点形如 <code class="mono">#doc-&lt;变更&gt;-&lt;文档&gt;</code>，可直接分享。</p>
</section>` : ''}
${changeHtml || '<section class="card"><p class="muted">暂无在办变更。可在对话里提出一个需求开始。</p></section>'}
${items[0] && items[0].arch ? `<section class="card"><details class="arch"><summary>项目架构与约定（.devflow/architecture.md）</summary><div class="docbody md">${mdToHtml(items[0].arch)}</div></details></section>` : ''}
<footer>本文件是渲染产物（按需重算，不入库）。数据来源：变更状态、TASKS.md 的任务级状态、体检结论。
<!-- 图形渲染：**不依赖任何 CDN**。阶段流转与任务依赖已改为原生 HTML，
     离线打开与断网环境下的显示完全一致（此前用 Mermaid CDN，失败时会露出源码）。 -->
<script>
/* 唯一的脚本：让"阶段芯片"与"任务列表"联动。
   设计约束：① 不联网、不依赖外部库；② 禁用 JS 时信息仍完整可见（脚本只做显隐，不生成内容）。 */
(function(){
  function applyFilter(card, key){
    var tasks = card.querySelectorAll('details.task');
    var shown = 0;
    tasks.forEach(function(t){
      var stages = (t.getAttribute('data-stages') || '').split(',');
      var ok = (key === 'all') || stages.indexOf(key) >= 0;
      t.classList.toggle('hidden', !ok);
      if (ok) shown++;
    });
    card.querySelectorAll('.fbtn').forEach(function(b){
      b.classList.toggle('on', b.getAttribute('data-filter') === key);
    });
    var note = card.querySelector('.fnote');
    if (note){
      note.textContent = (key === 'all') ? '' :
        (shown ? ('已过滤：' + shown + ' 个任务属该阶段') : '该阶段暂无任务');
    }
  }
  document.querySelectorAll('.card').forEach(function(card){
    var bar = card.querySelector('.filterbar');
    if (!bar) return;
    bar.addEventListener('click', function(e){
      var b = e.target.closest('.fbtn');
      if (!b) return;
      applyFilter(card, b.getAttribute('data-filter'));
    });
    /* 点击阶段芯片：展开它的同时，把任务列表过滤到该阶段 */
    card.querySelectorAll('details.st').forEach(function(st){
      st.addEventListener('toggle', function(){
        if (!st.open) return;
        var key = st.getAttribute('data-stage') || 'all';
        card.querySelectorAll('details.st').forEach(function(o){ if (o !== st) o.open = false; });
        applyFilter(card, key);
      });
    });
  });
})();
</script>
<script>
/* 交互增强：深链锚点自动展开 + 文档区批量展开/收起。
   约束：不联网、无外部依赖；即使脚本不执行，所有内容仍可见（details 可手点）。 */
(function(){
  function openHashTarget(){
    var raw = (location.hash || '').replace(/^#/, '');
    if (!raw) return;
    var id;
    try { id = decodeURIComponent(raw); } catch (e) { id = raw; }
    var el = document.getElementById(id);
    if (!el) return;
    // 逐层展开祖先 details（文档可能位于折叠的容器里）
    var n = el;
    while (n && n !== document.body) {
      if (n.tagName === 'DETAILS') n.open = true;
      n = n.parentElement;
    }
    if (el.tagName === 'DETAILS') el.open = true;
    try { el.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
  }
  window.addEventListener('hashchange', openHashTarget);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', openHashTarget);
  } else {
    openHashTarget();
  }
  document.querySelectorAll('[data-doc-expand]').forEach(function(btn){
    btn.addEventListener('click', function(){
      var want = btn.getAttribute('data-doc-expand') === '1';
      var card = btn.closest('.card');
      if (!card) return;
      card.querySelectorAll('.docs details.doc').forEach(function(d){ d.open = want; });
    });
  });
})();
</script>
</footer>
</body></html>`;

  // 供 board 的 /view 路由复用：只渲染、不落盘、不打印
  if (opts.returnHtml) return html;
  const full = path.isAbsolute(outFile) ? outFile : path.join(root, outFile);
  mkdirSync(path.dirname(full), { recursive: true });   // --out 可能指向不存在的子目录
  writeFileSync(full, html, 'utf8');
  const totalTasks = items.reduce((a, c) => a + c.taskTotal, 0);
  const doneTasks = items.reduce((a, c) => a + c.done, 0);
  // fileUrl 是给**聊天**用的：模型拿到它就应当直接 present 给用户 ——
  // 用户说"看看进度"就应看到界面，而不是拿到一条要自己敲的命令。
  const fileUrl = pathToFileURL(full).href;
  out(flags, [
    `${paint('devflow view', 'bold')}`,
    `  已生成：${full}`,
    `  可打开：${fileUrl}`,
    `  内容：${items.length} 个变更 · ${totalTasks} 个任务（已完成 ${doneTasks}）`,
    verdict ? `  门禁：${verdict.summary}` : '',
    '',
    '  单文件、离线可用、可直接发给别人。',
  ].filter(Boolean).join('\n'), { out: full, fileUrl, changes: items.length, tasks: totalTasks, done: doneTasks });
}

/**
 * devflow setup —— **一条命令把环境装好**：本地提交钩子 + DSH 聊天技能。
 *
 * 为什么合并成一个入口：别人拿到 kit 后需要做两件事（装钩子、装技能），
 * 分散成两个命令就会漏做其一 —— 而漏做技能意味着"聊天里用不了"，
 * 那正是本产品的主入口。
 */
/**
 * 安装/更新 **DSH 插件**（薄框看板面板）。
 *
 * 为什么由我们自己做，而不是让用户跑 `dsh plugin add`：
 *   · 那条命令**需要 pnpm**（实测报 `pnpm not found on PATH`），而多数人没装；
 *   · 而插件安装的实际内容只有 3 步，都在 profile 目录内，我们自己就能做。
 *
 * 三步（已对照真实 profile 结构核实）：
 *   ① `node_modules/<pkg>` → `<kit>/plugin`（软链）
 *   ② profile `package.json` 的 `dependencies` 加 `"link:<kit>/plugin"`
 *   ③ profile `package.json` 的 `dsh.profile.bundles` 加包名
 *
 * 安全：写 profile 前**先备份**，写完**校验 JSON**，失败即回滚。
 */
function setupDshPlugin(flags) {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const profilesDir = path.join(dshHome, 'profiles');
  const want = flags.profile ? String(flags.profile) : (process.env.DSH_PROFILE || 'desktop');
  const profileDir = path.join(profilesDir, want);
  const pkgName = 'dsh-plugin-devflow';
  const pluginDir = path.join(KIT_ROOT, 'plugin');
  const L = [];
  const dry = Boolean(flags['dry-run']);

  if (!existsSync(profilesDir)) {
    L.push(`  — 跳过：未发现 DSH profiles 目录（${profilesDir}）`);
    L.push('    若你不用 DSH：本步可忽略，用 `devflow board` 在浏览器看板即可');
    return L;
  }
  if (!existsSync(path.join(profileDir, 'package.json'))) {
    L.push(`  — 跳过：profile「${want}」不存在或没有 package.json`);
    L.push(`    可用 --profile <名字> 指定；现有：${readdirSync(profilesDir).filter((n) => !n.startsWith('.')).join('、')}`);
    return L;
  }
  if (!existsSync(path.join(pluginDir, 'lib', 'client.js'))) {
    L.push('  ⚠ plugin/lib 里没有构建产物（client.js）—— 面板会加载失败');
    L.push('    先在 plugin/ 里构建：node tools/build.mjs');
  }

  const pkgFile = path.join(profileDir, 'package.json');
  const linkPath = path.join(profileDir, 'node_modules', pkgName);
  const wantLink = `link:${pluginDir}`;

  // ── 探测当前状态（幂等：已装则只报告） ──
  let cfg = {};
  try { cfg = JSON.parse(readFileSync(pkgFile, 'utf8')); } catch { /* 下面会报错 */ }
  const deps = cfg.dependencies || {};
  const bundles = (cfg.dsh && cfg.dsh.profile && cfg.dsh.profile.bundles) || [];
  const linkOk = (() => { try { return readlinkSync(linkPath) === pluginDir; } catch { return false; } })();
  const depOk = deps[pkgName] === wantLink;
  const bundleOk = bundles.includes(pkgName);

  if (linkOk && depOk && bundleOk) {
    L.push(`  ✓ 插件已安装且是最新（profile：${want}）`);
    return L;
  }

  if (dry) {
    L.push(`  （预演，未改动）profile：${want}`);
    L.push(`    ① 软链：${linkPath} → ${pluginDir}${linkOk ? '（已就绪）' : ''}`);
    L.push(`    ② dependencies.${pkgName} = ${wantLink}${depOk ? '（已就绪）' : ''}`);
    L.push(`    ③ dsh.profile.bundles 加入 ${pkgName}${bundleOk ? '（已就绪）' : ''}`);
    return L;
  }

  // ── 备份 → 改 → 校验 → 失败回滚 ──
  const backup = `${pkgFile}.devflow-bak`;
  const original = readFileSync(pkgFile, 'utf8');
  try {
    if (!existsSync(linkPath)) {
      mkdirSync(path.dirname(linkPath), { recursive: true });
      symlinkSync(pluginDir, linkPath);
    }
    const next = JSON.parse(original);
    next.dependencies = { ...(next.dependencies || {}), [pkgName]: wantLink };
    next.dsh = next.dsh || {};
    next.dsh.profile = next.dsh.profile || {};
    const list = Array.isArray(next.dsh.profile.bundles) ? [...next.dsh.profile.bundles] : [];
    if (!list.includes(pkgName)) list.push(pkgName);
    next.dsh.profile.bundles = list;
    const text = `${JSON.stringify(next, null, 2)}\n`;
    JSON.parse(text);                                  // 校验：写之前必须是合法 JSON
    writeFileSync(backup, original, 'utf8');           // 备份
    writeFileSync(pkgFile, text, 'utf8');
    JSON.parse(readFileSync(pkgFile, 'utf8'));         // 校验：写之后仍合法
    L.push(`  ✓ 插件已安装（profile：${want}）`);
    L.push(`      软链：${linkPath}`);
    L.push(`      已写入 dependencies 与 dsh.profile.bundles`);
    L.push(`      备份：${path.basename(backup)}（确认无误后可删）`);
    L.push('      **需要重启 DSH 生效**；面板在右栏「devflow 看板」');
  } catch (e) {
    try { writeFileSync(pkgFile, original, 'utf8'); } catch { /* 尽力回滚 */ }
    L.push(`  ✗ 安装失败并已回滚：${e && e.message ? e.message : e}`);
    L.push(`    可手动检查 ${pkgFile}`);
  }
  return L;
}

function cmdSetup(flags) {
  const onlyGlobal = Boolean(flags.global);
  const onlyProject = Boolean(flags.project);
  const wantDsh = Boolean(flags.dsh);
  if (onlyGlobal && onlyProject) die('--global 与 --project 不能同时使用', 2);
  process.stdout.write(`${paint('devflow setup', 'bold')}  ${onlyGlobal ? '（只装用户级）' : onlyProject ? '（只装本项目的钩子）' : '（用户级 + 本项目）'}\n`);

  if (onlyProject) {
    process.stdout.write('  只装本项目：跳过用户级（技能/配置）—— 它们装一次即可，跨所有项目生效\n\n');
  }

  // ① 本地 git 钩子 —— **项目级**：每个 git 仓各装一次
  //    说明：`.git/hooks/` 不在版本控制里，clone 后必然缺失，所以必须逐仓装。
  if (onlyGlobal) {
    process.stdout.write('  只装用户级：跳过本项目的 git 钩子（逐仓安装，请在本项目里跑 devflow setup --project）\n\n');
  } else {
    cmdSetupHooks(flags, { soft: true });
  }
  if (onlyProject) return;

  // ③ DSH 插件（用户级，但**不是** skill —— 是界面面板；可选，失败不影响其它能力）
  if (wantDsh) {
    process.stdout.write(`\n${paint('devflow setup', 'bold')}  DSH 插件（薄框看板面板）\n`);
    for (const line of setupDshPlugin(flags)) process.stdout.write(`${line}\n`);
  }

  // ② 用户级配置：记录 kit 位置（跨工作区共享）。
  // 为什么必须有：聊天技能需要知道 CLI 在哪；把它写进一个**稳定位置**，
  // 技能就不用猜路径（原先技能里写死了作者本机路径 ⇒ 别人拿到用不了，实测踩到）。
  {
    // 写在 DSH 家目录（已确认可写）；~/.config 在部分环境受权限限制（实测 EPERM）
    const dshHomeForCfg = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
    const tries = [
      // ⚠️ 文件名**不能**叫 devflow.json —— 那是项目清单的标记名，
      // 放一份在 ~/.dsh 里会让"向上找项目根"把 ~/.dsh 当成项目（实测踩到：看板显示 .dsh / 0 变更）
      { dir: dshHomeForCfg, file: path.join(dshHomeForCfg, 'devflow-kit.json') },
      { dir: path.join(os.homedir(), '.config', 'devflow'), file: path.join(os.homedir(), '.config', 'devflow', 'config.json') },
    ];
    let wrote = null;
    for (const t of tries) {
      try {
        mkdirSync(t.dir, { recursive: true });
        writeFileSync(t.file, `${JSON.stringify({ kit: KIT_ROOT, updatedAt: new Date().toISOString() }, null, 2)}\n`, 'utf8');
        wrote = t.file; break;
      } catch { /* 试下一个 */ }
    }
    process.stdout.write(`${paint('devflow setup', 'bold')}  用户配置\n`);
    if (wrote) {
      process.stdout.write(`  ✓ 已记录 kit 位置：${wrote}\n      kit → ${KIT_ROOT}\n`);
    } else {
      process.stdout.write(`${paint('—', 'yellow')} 未能写入用户配置（权限受限）\n`);
      process.stdout.write(`    可手动设置：export DEVFLOW=${path.join(KIT_ROOT, 'bin', 'devflow')}\n`);
    }
  }

  // ③ DSH 聊天技能（**用户级**）：软链到 <dsh home>/skills/devflow —— 装一次，跨所有项目可用
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
  const skillsDir = path.join(dshHome, 'skills');
  const link = path.join(skillsDir, 'devflow');
  const src = path.join(KIT_ROOT, 'skill');
  const lines = ['', `${paint('devflow setup', 'bold')}  聊天技能（DSH）`];
  if (!existsSync(skillsDir)) {
    lines.push(`  — 跳过：未发现 DSH skills 目录（${skillsDir}）`);
    lines.push('    若你用 DSH：先启动一次 DSH，让它建出该目录，再重跑本命令');
  } else if (!existsSync(src)) {
    lines.push(`  ✗ kit 安装不完整：缺少 ${src}`);
  } else {
    let linked = false;
    try {
      // **必须装成真实目录 + 真实文件**，不用软链：
      // 技能枚举是否跟随软链无法保证（对照：同目录下能用的 md-to-office 是真实目录）。
      // 装软链的风险是"看起来装了、其实不被发现"，属于本产品最反对的静默失效。
      const skillMd = path.join(src, 'SKILL.md');
      // ⚠️ 安装戳的插入规则在 `lib/skill-sync.mjs`（**单一来源**）：
      // 戳**必须放在 frontmatter 之后** —— SKILL.md 首行必须是 `---`，
      // 否则 DSH 解析不到 frontmatter，技能会**从列表里消失**（实测踩到，且只有真实集成能发现）。
      // 自检 SC52/SC67 调用同一个函数校验，不再各写一份复刻。
      const body = addStamp(readFileSync(skillMd, 'utf8'));
      rmSync(link, { force: true, recursive: true });
      mkdirSync(link, { recursive: true });
      writeFileSync(path.join(link, 'SKILL.md'), body, 'utf8');
      lines.push(`  ✓ 已安装（真实目录）：${link}`);
      lines.push(`      SKILL.md ← ${skillMd}`);
      linked = true;
    } catch (e) {
      // 沙箱/权限不允许写 home 时：给出**可复制执行的命令**，而不是只报错
      lines.push(`  ✗ 无法写入 ${link}（${e.message}）`);
      lines.push('    请手动执行：');
      lines.push(`      mkdir -p ${link} && cp ${path.join(src, 'SKILL.md')} ${link}/SKILL.md`);
    }
    if (linked) {
      lines.push('');
      lines.push('  之后在 DSH 聊天里说人话即可驱动工作流（无需记命令）：');
      lines.push('    · "我有个需求：……"      → 走需求澄清',
        '    · "这个怎么分"            → 按责任层拆任务',
        '    · "现在到哪了"            → 状态与下一步',
        '    · "看看进度"              → 生成可点击视图');
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

function cmdStart(flags) {
  const { root, loaded, marker } = resolveProject(flags);
  const project = loaded.ok ? (loaded.config?.devflow?.project || path.basename(root)) : path.basename(root);
  const lines = [`${paint('devflow', 'bold')} · ${project}`, `  位置：${root}`, ''];

  // ① 工作区：有没有多仓配置
  const wsPath = path.join(root, '.devflow', 'workspace.json');
  let ws = null;
  try { ws = JSON.parse(readFileSync(wsPath, 'utf8')); } catch { /* 未配置 */ }
  if (ws) {
    const repos = ws.repos || [];
    lines.push(`  工作区：已配置（${repos.length} 个仓）`);
    for (const r of repos.slice(0, 8)) {
      lines.push(`    · ${r.name || r.path}${r.role ? `（${r.role}）` : ''}`);
    }
    if (repos.length > 8) lines.push(`    …另有 ${repos.length - 8} 个`);
  } else {
    lines.push('  工作区：未配置（单仓模式）');
    lines.push('    → 想纳入多个仓一起协作：devflow workspace init');
  }

  // ② 在办变更：列出状态与"下一步是谁的动作"
  let items = [];
  try { items = listItems(root); } catch { items = []; }
  lines.push('');
  if (!items.length) {
    lines.push('  在办变更：无');
    lines.push('');
    lines.push('  想做什么？可以直接说：');
    lines.push('    · 我有个想法/需求 → 走需求澄清，产出 SPEC 与验收标准');
    lines.push('    · 接入这个仓     → devflow init + devflow doctor');
  } else {
    lines.push(`  在办变更：${items.length} 个`);
    for (const it of items.slice(0, 6)) {
      const st = rawState(it.itemDir) || '?';
      const stName = (allSpec().states.states[st] || {}).name || st;
      lines.push(`    · ${it.itemId}  ${stName}`);
      lines.push(`        ${nextAction(st)}`);
    }
    if (items.length > 6) lines.push(`    …另有 ${items.length - 6} 个（devflow status --all）`);
  }

  // ③ 门禁是否可信（决定"下一步的结论能不能信"）
  lines.push('');
  try {
    const { verdict } = diagnose({ projectRoot: root, config: loaded.config, marker,
      cwd: process.cwd(), kitVersion: kitVersion(), kitRoot: KIT_ROOT });
    lines.push(`  门禁：${verdict.summary}`);
    if (!verdict.trustworthy) {
      lines.push('    注意：门禁不可信时，"通过"不能当作证据 —— 先处理阻断项（devflow doctor）');
    }
  } catch { lines.push('  门禁：未能体检（devflow doctor 查看原因）'); }

  lines.push('');
  lines.push('  说人话即可，我会接到对应环节；需要你决策时我会用选择框问你。');
  out(flags, lines.join('\n'), { project, root, workspace: ws ? (ws.repos || []).length : 0, items: items.map((i) => i.itemId) });
}

/** 由当前状态推出"下一步是谁的动作" */
function nextAction(state) {
  const map = {
    draft: '下一步：补 SPEC 的验收标准（谁：产品负责人 + 你）',
    spec_ready: '下一步：冻结契约（谁：产品负责人）或进入实现',
    contracted: '下一步：开始实现（谁：实现者）',
    implementing: '下一步：实现完成 → 提测（谁：实现者）',
    tested: '下一步：独立验证（谁：验证者，需独立上下文）',
    verified: '下一步：发布批准（谁：产品负责人）',
    released: '已完成；观察窗口到期后回填结论',
  };
  return map[state] || '下一步：运行 devflow status 查看详情';
}

function cmdSetupHooks(flags, opts = {}) {
  let root = null; let loaded = { ok: false };
  ({ root, loaded } = resolveProject(flags, { quiet: true }));
  // 回退：没有 devflow.json 时用 **git 仓根**。
  // 为什么必须回退：刚克隆下来的 kit 自己**不是** devflow 项目（它是工具），
  // 若不回退，setup 在「最该能用」的场景里直接失败（实测踩到）。
  if (!root || !existsSync(root)) {
    try {
      root = execSync('git rev-parse --show-toplevel', { cwd: process.cwd(), encoding: 'utf8' }).trim();
    } catch {
      die('既不是 devflow 项目，也不在 git 仓库内 —— 无法安装提交钩子。\n'
        + '  用法：在项目根（有 devflow.json）或任意 git 仓内运行 devflow setup', 2);
    }
  }
  const hooksDir = path.join(root, '.git', 'hooks');
  if (!existsSync(hooksDir)) {
    // `setup` 调用时只警告不中断 —— 它还要继续装聊天技能（那是主入口）。
    if (opts.soft) {
      process.stdout.write(`${paint('—', 'yellow')} 跳过提交钩子：本目录不是 git 仓库（${root}）\n`);
      return;
    }
    out(flags, `${paint('✗', 'red')} 不是 git 仓库（找不到 .git/hooks）：${root}`, { ok: false });
    process.exitCode = 2;
    return;
  }
  const validator = path.join(KIT_ROOT, 'tools', 'validate-commit-msg.mjs');
  const target = path.join(hooksDir, 'commit-msg');
  const installed = [];
  const skipped = [];
  // 不覆盖用户已有的钩子（可能是别人的团队规范）
  if (existsSync(target)) {
    let isOurs = false;
    try {
      isOurs = readFileSync(target, 'utf8').includes('devflow');
    } catch {
      try { isOurs = readFileSync(target, 'utf8').includes('validate-commit-msg'); } catch { /* 符号链接 */ }
    }
    if (!isOurs && !flags.force) {
      skipped.push('commit-msg（已存在且不是 devflow 安装的，未覆盖；需要覆盖请加 --force）');
    }
  }
  if (!skipped.length) {
    try {
      // 用软链而非拷贝：升级 kit 后钩子自动跟随（且不产生多份漂移的规则副本）
      rmSync(target, { force: true });
      symlinkSync(validator, target);
      installed.push(`commit-msg → ${path.relative(root, validator)}（提交信息规范）`);
    } catch (e) {
      // 平台不支持软链时退回复制
      // 登记到用户级清单（看板面板的下拉要列出用户自己的项目）
      try { rememberProject(root); } catch { /* 忽略 */ }

      writeFileSync(target, `#!/usr/bin/env node\nimport('${validator.replace(/'/g, "\\'")}');\n`, { mode: 0o755 });
      installed.push(`commit-msg（复制式安装：${e.message}）`);
    }
  }
  out(flags, [
    `${paint('devflow setup-hooks', 'bold')}  ${loaded.config?.devflow?.project || path.basename(root)}`,
    installed.length ? `  ✓ 已安装：${installed.join('；')}` : '',
    skipped.length ? `  — 跳过：${skipped.join('；')}` : '',
    '',
    '  注意：.git/hooks 不在版本控制里 —— **每台新机器、每次重新 clone 都要跑一次本命令**。',
    '  CI 中不需要钩子：CI 用 `devflow gate run` 做强制（见 devflow ci）。',
  ].filter(Boolean).join('\n'), { ok: true, installed, skipped });
}

/**
 * 生成 CI 配置：把门禁从"本地约定"变成"结构强制"。
 *
 * 分工（刻意区分，避免 CI 长期红灯而被无视）：
 *   · `gate run`   = "**本次变更**是否达标" ⇒ CI 每次必跑、失败即阻断
 *   · `doctor`     = "**门禁本身**是否可信" ⇒ 配置问题（一次性），放独立 job 且默认允许失败
 *   · 契约扫描      = 跨仓漂移（可达）⇒ 独立 job，默认允许失败（漂移常来自后端未实现）
 * 若把 doctor 放进必过步骤，一个存量仓的配置债务会让**每一次**推送都红灯 ——
 * 红灯一旦常态化，门禁就失效了。
 */
function cmdCi(flags) {
  const { root, loaded } = resolveProject(flags);
  const platform = flags.platform || 'gitlab';
  // 变更绑定：显式 --item > 仓库里**唯一**的在办变更 > 不绑定（跳过 gate run）。
  // 为什么必须这样：刚 clone 的仓里 `.devflow/items/` 可能为空（本地产物未入库），
  // 此时生成 `gate run <item>` 会必然失败 —— 那不是门禁，那是坏配置。
  let item = flags.item ? String(flags.item) : null;
  let itemSource = item ? 'explicit' : null;
  if (!item) {
    try {
      // **只绑定已入库的变更**：CI 是 checkout 出来的仓库，未入库的变更在 CI 里不存在。
      // 绑定一个本地未提交的变更 ⇒ 生成的配置在 CI 上必然失败（实测踩到）。
      const ids = listItems(root).map((i) => i.itemId).filter((id) => {
        try {
          const out = execSync(`git ls-files --error-unmatch .devflow/items/${id}`, {
            cwd: root, stdio: 'pipe', encoding: 'utf8',
          });
          return Boolean(out);
        } catch { return false; }
      });
      if (ids.length === 1) { item = ids[0]; itemSource = 'single-tracked'; }
      else if (ids.length > 1) { itemSource = 'ambiguous'; }
      else { itemSource = 'none'; }
    } catch { itemSource = 'none'; }
  }
  const strictDoctor = Boolean(flags['strict-doctor']);
  if (!['gitlab', 'github'].includes(platform)) {
    die(`未知平台：${platform}\n  可用：gitlab | github`, 2);
  }
  const dryRun = Boolean(flags['dry-run']);

  // kit 的获取方式（默认从公开 GitHub 取；可用 --kit-path 改为内网/镜像，或 --kit-repo 换地址）
  const repoUrl = flags['kit-repo'] ? String(flags['kit-repo'])
    : 'https://github.com/darkknight110/devflow-kit.git';
  const kitDir = flags['kit-path'] ? String(flags['kit-path']) : '.devflow-kit';
  const fetchLine = (indent) => [
    `if [ ! -x "${kitDir}/bin/devflow" ]; then`,
    `  git clone --depth 1 ${repoUrl} ${kitDir}`,
    'fi',
  ];
  // GitLab：同一 job 内共享 shell，export 即可
  const setup = [
    ...fetchLine(),
    `export DEVFLOW="$PWD/${kitDir}/bin/devflow"`,
    `[ -x "$DEVFLOW" ] || { echo "找不到 devflow：检查 kit 地址或网络"; exit 2; }`,
    `echo "$PWD/${kitDir}/bin" >> $GITHUB_PATH 2>/dev/null || true`,
  ];
  // GitHub：每个 step 独立 shell ⇒ 必须写 GITHUB_ENV / GITHUB_PATH，否则下个 step 找不到命令
  const setupGh = [
    ...fetchLine(),
    `echo "DEVFLOW=$PWD/${kitDir}/bin/devflow" >> "$GITHUB_ENV"`,
    `echo "$PWD/${kitDir}/bin" >> "$GITHUB_PATH"`,
    `[ -x "$PWD/${kitDir}/bin/devflow" ] || { echo "找不到 devflow：检查 kit 地址或网络"; exit 2; }`,
  ];
  const setupNote = 'devflow 未随仓库分发 —— CI 里按需获取（可用 devflow ci --kit-repo/--kit-path 改成本团队的获取方式）';
  // 无变更可绑定时，用仓库自己的门禁脚本作为必过步骤（那是这个仓真实的验证入口），
  // 并明确说明为什么没有绑定变更 —— 不许生成一个必然失败的步骤。
  const repoGate = (() => {
    try {
      const g = (loaded.config?.gates || {});
      const t = g.test?.run;
      if (t) return String(t);
      const b = g.build?.run;
      return b ? String(b) : null;
    } catch { return null; }
  })();
  // 说明与命令**分行**（不要写成 `run: cmd  # 注释` —— YAML 里行内注释会让值含糊，实测生成过坏配置）
  const GATE = item
    ? `$DEVFLOW gate run ${item}`
    : (repoGate
      ? `# 未绑定变更：先跑本仓测试门禁（.devflow/items 里没有可绑定的变更）\n${repoGate}`
      : 'echo "本仓未声明 test 门禁脚本，请在 devflow.json 里配置"');
  const GATE_BLOCK = GATE.includes('\n');
  // 契约扫描需要**后端仓在工作区内**。单仓 CI 里通常没有 ⇒ 不能无条件跑：
  // 无条件跑会必然失败（找不到后端仓），把报告 job 变成噪音（实测：生成的配置跑不通）。
  // 契约扫描需要工作区内有后端仓。单仓 CI 通常没有 ⇒ 条件执行而不是必然失败。
  // 后端仓名由 --backend 指定（**不硬编码任何内部仓名**）。
  const backendRepo = flags.backend ? String(flags.backend) : '';
  const SCAN = backendRepo
    ? `if [ -d "./${backendRepo}" ]; then\n`
      + `  $DEVFLOW contract-scan --workspace . --backend ${backendRepo} --fail-on-drift --fail-on=live\n`
      + 'else\n'
      + `  echo "未发现后端仓 ${backendRepo}，跳过契约扫描"\n`
      + 'fi'
    : 'echo "未指定 --backend，跳过契约扫描（多仓工作区可用 devflow ci --backend <仓名> 生成）"';

  let content;
  let file;
  if (platform === 'gitlab') {
    file = '.gitlab-ci.yml';
    content = [
      '# devflow 门禁（由 `devflow ci --platform gitlab` 生成）',
      '# 作用：把门禁从"本地约定"变成"结构强制" —— 跳过门禁的变更合不进去。',
      '',
      'stages: [gates, report]',
      '',
      '# 必过：本次变更是否达到门禁要求',
      'devflow-gate:',
      '  stage: gates',
      '  script:',
      '    - |',
      '      if [ -f package.json ]; then',
      '        if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi',
      '      fi',
      ...setup.map((l, i) => (i === 0 ? `    - |\n      ${l}` : `      ${l}`)),
      `      ${GATE}`,
      '',
      '# 报告性质：门禁自身是否可信（配置债务，默认不阻断）',
      'devflow-doctor:',
      '  stage: report',
      '  script:',
      ...setup.map((l, i) => (i === 0 ? `    - |\n      ${l}` : `      ${l}`)),
      '      $DEVFLOW review --all',
      '      $DEVFLOW doctor',
      `  allow_failure: ${strictDoctor ? 'false' : 'true'}`,
      '',
      '# 报告性质：跨仓契约漂移（可达）',
      'devflow-contract:',
      '  stage: report',
      '  script:',
      ...setup.map((l, i) => (i === 0 ? `    - |\n      ${l}` : `      ${l}`)),
      ...SCAN.split('\n').map((l) => `      ${l}`),
      '  allow_failure: true',
      '',
      '# 注意：不要用 `|| true` 掩盖 devflow-gate 的失败 —— 那会让门禁静默失效。',
      '',
    ].join('\n');
  } else {
    file = '.github/workflows/devflow.yml';
    content = [
      '# devflow 门禁（由 `devflow ci --platform github` 生成）',
      'name: devflow',
      'on: [push, pull_request]',
      'jobs:',
      '  # 必过：本次变更是否达到门禁要求',
      '  gate:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@v4',
      '        with: { node-version: "22" }',
      '      - name: 安装依赖（Node 项目需要；无 package.json 则自动跳过）',
      '        run: |',
      '          if [ -f package.json ]; then',
      '            if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi',
      '          else',
      '            echo "非 Node 项目，跳过 npm 安装"',
      '          fi',
      '      - name: 准备 devflow',
      '        run: |',
      ...setupGh.map((l) => `          ${l}`),
      '      - name: 门禁（本次变更）',
      ...(GATE_BLOCK ? ['        run: |', ...GATE.split('\n').map((l) => `          ${l}`)] : [`        run: ${GATE}`]),
      '',
      '  # 报告性质：门禁自身是否可信 + 跨仓契约漂移',
      '  report:',
      '    runs-on: ubuntu-latest',
      '    continue-on-error: true',
      '    steps:',
      '      - uses: actions/checkout@v4',
      '      - uses: actions/setup-node@v4',
      '        with: { node-version: "22" }',
      '      - name: 安装依赖（Node 项目需要；无 package.json 则自动跳过）',
      '        run: |',
      '          if [ -f package.json ]; then',
      '            if [ -f package-lock.json ]; then npm ci; else npm install --no-audit --no-fund; fi',
      '          else',
      '            echo "非 Node 项目，跳过 npm 安装"',
      '          fi',
      '      - name: 准备 devflow',
      '        run: |',
      ...setupGh.map((l) => `          ${l}`),
      '      - name: 人工确认点状态（如实报告，不阻断）',
      '        run: $DEVFLOW review --all',
      ...(item ? [
        '      # 契约破坏性判定：仅在有绑定变更时跑（需要该变更已有基线快照）',
        '      - name: 契约破坏性判定（报告）',
        '        run: $DEVFLOW contract diff ' + item + ' || true',
      ] : []),
      '      - name: 体检（门禁自身是否可信）',
      '        run: $DEVFLOW doctor',
      '      - name: 跨仓契约漂移',
      '        run: |',
      ...SCAN.split('\n').map((l) => `          ${l}`),
      '',
    ].join('\n');
  }

  const full = path.join(root, file);
  const existed = existsSync(full);
  if (!dryRun) {
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content, 'utf8');
  }
  const lines = [
    `${paint('devflow ci', 'bold')}  平台：${platform}${dryRun ? '（预演，未写入）' : ''}`,
    `  文件：${file}${existed ? '（已存在，已覆盖）' : ''}`,
    '',
    ...content.split('\n').map((l) => `    ${l}`),
    '',
    '  分工：`gate run` 必过（本次变更）；`doctor` 与契约扫描默认不阻断（配置债务与跨仓漂移）。',
    item ? `  已绑定变更：${item}（来源：${itemSource === 'explicit' ? '--item' : '仓库内唯一已入库的变更'}）`
      : (itemSource === 'ambiguous'
        ? '  注意：仓库内有多个在办变更，未自动绑定 —— 请用 `devflow ci --item <变更>` 明确指定'
        : '  注意：仓库内没有**已入库**的在办变更，门禁步骤改为跑本仓测试脚本；'
          + '需要绑定变更时用 `devflow ci --item <变更>`'),
    strictDoctor ? '  注意：--strict-doctor 已开启，doctor 失败会阻断（要求门禁配置零债务）。' : '',
    '  提示：git 钩子只在本地生效，clone 后需重装（`devflow setup-hooks`）。',
  ].filter((x) => x !== '');
  out(flags, lines.join('\n'), { platform, file, content });
}

function cmdMigrateStorage(flags) {
  const { root, loaded } = resolveProject(flags);
  if (!loaded.ok && loaded.code === 'NO_CONFIG') {
    out(flags, `${paint('✗', 'red')} 未找到 devflow.json：${loaded.configPath}`, loaded);
    process.exitCode = 2;
    return;
  }
  const dryRun = Boolean(flags['dry-run']);
  const moves = [];
  const src = itemsDir(root);
  if (!existsSync(src)) {
    out(flags, '  ✓ 没有需要迁移的内容（.devflow/items 不存在）', { moved: 0 });
    return;
  }
  for (const name of readdirSync(src)) {
    if (name.startsWith('.')) continue;
    const from = path.join(src, name);
    try { if (!statSync(from).isDirectory()) continue; } catch { continue; }
    for (const f of ['STATE', 'STATUS.json']) {
      const fFrom = path.join(from, f);
      if (!existsSync(fFrom)) continue;
      const fTo = path.join(localItemsDir(root), name, f);
      moves.push({ item: name, file: f, from: fFrom, to: fTo, exists: existsSync(fTo) });
    }
  }
  if (!moves.length) {
    out(flags, '  ✓ 全部变更已是新布局（机器状态不在 items/ 里）', { moved: 0 });
    return;
  }
  if (!dryRun) {
    for (const m of moves) {
      mkdirSync(path.dirname(m.to), { recursive: true });
      if (m.exists) continue;              // 目标已存在 ⇒ 不覆盖（保守）
      writeFileSync(m.to, readFileSync(m.from, 'utf8'), 'utf8');
      rmSync(m.from);
    }
  }
  const lines = [
    `${paint('devflow migrate-storage', 'bold')}${dryRun ? '（预演，未改动任何文件）' : ''}`,
    `  待迁移：${moves.length} 个文件，涉及 ${new Set(moves.map((m) => m.item)).size} 个变更`,
    `  → ${path.relative(root, localItemsDir(root))}/<变更>/{STATE,STATUS.json}`,
    '',
    ...moves.slice(0, 10).map((m) => `  ${m.item}/${m.file}${m.exists ? '（目标已存在，将跳过）' : ''}`),
    moves.length > 10 ? `  …另有 ${moves.length - 10} 个` : '',
    '',
    dryRun ? '  确认无误后去掉 --dry-run 执行' : '  完成。.devflow/items/ 现在只剩人写的产物（可入库）',
  ].filter(Boolean);
  out(flags, lines.join('\n'), { dryRun, moves: moves.length });
}

function cmdStandards(flags) {
  const { root, loaded } = resolveProject(flags);
  if (!loaded.ok && loaded.code === 'NO_CONFIG') {
    out(flags, `${paint('✗', 'red')} 未找到 devflow.json：${loaded.configPath}\n  先执行：devflow init --name <项目名>`, loaded);
    process.exitCode = 2;
    return;
  }
  const { report, itemDir } = standardsContext(root, loaded, flags.item ? String(flags.item) : null);
  if (flags.json) { out(flags, report, report); return; }

  const icon = (r) => (r.verdict === 'met' ? paint('✓', 'green')
    : r.verdict === 'not-applicable' ? paint('—', 'gray')
    : r.consequence === 'block' ? paint('⛔', 'red') : paint('⚠', 'yellow'));
  const lines = [
    `${paint('devflow standards', 'bold')}  ${loaded.config?.devflow?.project || path.basename(root)}`,
    `  判定范围：${report.summary.total} 条　判定依据：spec/standards.json（产品基础标准）`,
    itemDir ? `  变更上下文：${path.basename(itemDir)}` : '  变更上下文：(无在办变更，证据类条目判为不适用)',
    '',
    `  满足 ${report.summary.met} · 未满足 ${report.summary.unmet}（阻断 ${report.summary.blocking} / 削弱 ${report.summary.weakened}）· 不适用 ${report.summary.notApplicable}`,
    '',
  ];
  for (const r of report.results) {
    lines.push(`  ${icon(r)} ${r.id}  ${r.title}`);
    lines.push(`      ${r.detail}`);
    if (r.overridden?.rejected) lines.push(`      ${paint('项目覆盖被拒绝', 'red')}：${r.overridden.reason}`);
    else if (r.overridden) lines.push(`      ${paint('项目已覆盖', 'yellow')}：${r.overridden.reason}`);
  }
  lines.push('');
  lines.push('  说明：标准条目见 docs/04-standards.md；在 devflow.json 的 standards 段可覆盖/追加（不可豁免项除外）。');
  out(flags, lines.join('\n'), report);
  if (report.summary.blocking > 0) process.exitCode = 1;
}

function cmdDoctor(flags) {
  const { root, loaded, marker } = resolveProject(flags);
  if (!loaded.ok && loaded.code === 'NO_CONFIG') {
    out(flags, `${paint('✗', 'red')} 未找到 devflow.json：${loaded.configPath}\n  先执行：devflow init --name <项目名>`, loaded);
    process.exitCode = 2;
    return;
  }
  const { findings, verdict } = diagnose({
    projectRoot: root,
    config: loaded.config,
    marker,
    cwd: process.cwd(),
    kitVersion: kitVersion(),
    kitRoot: KIT_ROOT,
  });

  const lines = [
    `${paint('devflow doctor', 'bold')}  ${loaded.config?.devflow?.project || path.basename(root)}`,
    `  项目根：${root}（标记：${marker}）`,
    '',
  ];
  if (findings.length === 0) {
    lines.push('  ✓ 没有发现问题');
  } else {
    for (const f of findings) {
      const sev = SEVERITIES[f.severity];
      const color = f.severity === 'block' ? 'red' : f.severity === 'weak' ? 'yellow' : 'dim';
      lines.push(`  ${paint(sev.symbol, color)} ${paint(`[${sev.label}]`, color)} ${f.id}  ${f.title}`);
      lines.push(`      依据：${f.evidence}`);
      lines.push(`      修法：${f.fix}`);
      lines.push('');
    }
  }
  // ── 基础标准达成摘要 ──
  // 标准阻断项**并入总判定**：它表示产品底线被违反（如负向对照空转、结论无命令支撑），
  // 严重度等同于门禁层的 block。但**不**直接把 finding 塞进 D 序列，以免与 D4 等重复计数；
  // 这里只在结论文案里显式区分"门禁层"与"标准层"两类阻断。
  let standardsSummary = null;
  let stdBlocking = [];
  try {
    const ctx = standardsContext(root, loaded, flags.item ? String(flags.item) : null);
    standardsSummary = ctx.report.summary;
    const s2 = ctx.report;
    stdBlocking = s2.results.filter((r) => r.verdict === 'unmet' && r.consequence === 'block');
    lines.push('');
    lines.push(`  ${paint('基础标准', 'bold')}（${s2.summary.total} 条，依据 spec/standards.json）`);
    lines.push(`    满足 ${s2.summary.met} · 未满足 ${s2.summary.unmet}（阻断 ${s2.summary.blocking} / 削弱 ${s2.summary.weakened}）· 不适用 ${s2.summary.notApplicable}`);
    const unmet = s2.results.filter((r) => r.verdict === 'unmet');
    for (const r of unmet.slice(0, 5)) {
      const mark = r.consequence === 'block' ? paint('⛔', 'red') : paint('⚠', 'yellow');
      lines.push(`    ${mark} ${r.id}  ${r.detail.slice(0, 80)}`);
    }
    if (unmet.length > 5) lines.push(`    …另有 ${unmet.length - 5} 项未满足，运行 devflow standards 查看全部`);
    if (!unmet.length) lines.push(`    ${paint('✓', 'green')} 无未满足项`);
    lines.push('    详情：devflow standards');
  } catch (e) {
    // 标准判定自身失败必须可见（不得静默）
    lines.push('');
    lines.push(`  ${paint('⚠', 'yellow')} 基础标准判定自身失败：${e.message}`);
  }

  // 总判定：门禁层阻断 + 标准层阻断（两者都使「不可信」成立）
  // 逻辑抽在 doctor.mergeStandardBlockers（纯函数，可被 selfcheck 覆盖）
  mergeStandardBlockers(verdict, stdBlocking);

  // 结论文案必须在总判定确定之后输出（否则标准层阻断不会体现在结论里）
  lines.push(`  ${paint('结论', 'bold')}：${verdict.summary}`);
  lines.push(`  统计：阻断 ${verdict.counts.block} · 削弱 ${verdict.counts.weak} · 提示 ${verdict.counts.info}`
    + (stdBlocking.length ? ` · 标准阻断 ${stdBlocking.length}` : ''));
  if (!verdict.trustworthy) {
    lines.push('');
    lines.push('  下一步：按上面的「修法」逐条处理，然后重新运行 devflow doctor。');
    lines.push('  在阻断项清零之前，任何"门禁通过"都不能当作证据。');
  } else if (verdict.counts.weak > 0) {
    lines.push('');
    lines.push('  可以开工。削弱项不影响当前判定，但会削弱门禁强度，建议在下一个变更里顺手处理。');
  } else {
    lines.push('');
    lines.push('  可以开工：devflow new --slug <变更名> --tier <micro|light|standard|heavy> --title "<标题>"');
  }

  out(flags, lines.join('\n'), { projectRoot: root, marker, findings, verdict, standards: standardsSummary });
  if (!verdict.trustworthy) process.exitCode = 1;
}


/** 产物名 → 模板种类的映射（fill 用） */
const ARTIFACT_TEMPLATE_KIND = {
  'GOAL.md': 'goal',
  'SPEC.md': 'spec',
  'CONTRACT.md': 'contract',
  'TASKS.md': 'tasks',
  'coding_report.md': 'codingReport',
  'verification.md': 'verification',
  'APPROVALS.md': 'approvals',
  'release/report.md': 'releaseReport',
};

function cmdFill(flags, positional) {
  const { root, loaded } = resolveProject(flags);
  const itemId = pickItem(root, positional, flags);
  if (!itemId) die('用法：devflow fill <item> [--to <状态>] [--file <产物>] [--force]\n  示例：devflow fill 2026-10-13-order-export --to released', 2);
  // 机器状态优先在 .local/items/（见 spec/storage.json STO-1），旧布局兜底
  // fill 写的是**人写的产物**（SPEC/CONTRACT/TASKS/coding_report/verification/APPROVALS/release）
  // ⇒ 必须落在 items/（入库区）。曾因用「机器目录优先」把新增产物写进 .local/（gitignore 区），
  // 导致产物被排除在版本控制之外 —— 直接违反存储正典 STO-2。
  const machineDirP = machineDir(root, itemId);
  const humanDirP = path.join(itemsDir(root), itemId);
  const itemDir = machineDirP || humanDirP;      // 读状态：机器目录优先，旧布局兜底
  const outDir = humanDirP;                       // 写产物：一律人写目录
  mkdirSync(outDir, { recursive: true });
  if (!existsSync(itemDir)) die(`变更目录不存在：${itemDir}`, 3);
  const kitSpec = allSpec();
  const state = rawState(itemDir);
  const target = flags.to || state;
  if (!kitSpec.states.states[target]) die(`未知状态：${target}`, 2);

  // 目标状态（含档位要求）所需产物 − 已有产物 = 待补
  const status = readStatus(itemDir) || {};
  const tier = status.tier || 'standard';
  const probe = evaluateItem({ projectRoot: root, itemId, kitSpec, config: loaded.config, cwd: process.cwd(), stateOverride: target });
  const missing = (probe.gates.find((g) => g.gate === 'G1')?.evidence?.missing || []).filter(Boolean);
  const only = flags.file ? [String(flags.file)] : missing;

  const written = [];
  const skipped = [];
  const skippable = [];
  for (const file of only) {
    const kind = ARTIFACT_TEMPLATE_KIND[file];
    const full = path.join(outDir, file);
    if (existsSync(full) && !flags.force) {
      skipped.push(`${file}（已存在，未覆盖）`);
      continue;
    }
    if (!kind) {
      skippable.push(`${file}（没有对应模板，需手写）`);
      continue;
    }
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, renderTemplate(KIT_ROOT, kind, {
      title: itemId, item: itemId, tier, tierName: kitSpec.states.tiers[tier]?.name || tier,
      owner: flags.owner, repos: [], changeSurface: [], createdAt: new Date().toISOString().slice(0, 10),
    }), 'utf8');
    written.push(file);
  }

  const lines = [
    `${paint('devflow fill', 'bold')}  ${itemId}    目标状态：${kitSpec.states.states[target].name}（${target}）`,
    `  档位：${kitSpec.states.tiers[tier]?.name || tier}（${tier}）`,
    '',
    written.length ? `  已按模板补齐：${written.join('、')}` : '  未写入任何文件',
    skipped.length ? `  跳过：${skipped.join('；')}` : '',
    skippable.length ? `  ${paint('需手写', 'yellow')}：${skippable.join('；')}` : '',
    '',
    '  提示：模板里是结构化占位，**必须填真实内容**再推进；引擎会校验章节与表格列。',
    `  下一步：devflow advance ${itemId} --to ${target} --check`,
  ].filter(Boolean);
  out(flags, lines.join('\n'), { itemId, target, written, skipped, needsManual: skippable });
}


function cmdAdapters(flags) {
  const adapters = loadAdapters(KIT_ROOT);
  const root = flags.root ? path.resolve(String(flags.root)) : (findProjectRoot() || process.cwd());
  const detected = detectAdapters(root, adapters);
  const detectedIds = new Set(detected.map((d) => d.id));
  const problems = auditAdapterRegex(adapters);

  const lines = [
    `${paint('可用技术栈适配器', 'bold')}　目录：${root}`,
    '',
    '  技术栈            标记文件                        测试计数样例',
    ...Object.entries(adapters).map(([id, def]) => {
      const mark = detectedIds.has(id) ? paint('●', 'green') : ' ';
      return `  ${mark} ${id.padEnd(15)}${(def.markers || []).join('、').padEnd(30)}${def.test?.count_regex || '(无)'}`;
    }),
    '',
    detected.length
      ? `  检测结果：${detected.map((d) => `${d.id}（命中 ${d.matched.join('、')}）`).join('；')}`
      : '  检测结果：未识别到已知技术栈（可用 --stack 显式指定）',
    '',
    problems.length
      ? `${paint('  适配器自检未通过：', 'red')}`
      : '  适配器自检：全部 count_regex 都能抓到各自声明的样本输出 ✓',
    ...problems.map((p) => `    · ${p}`),
  ];
  if (flags.apply) {
    if (!adapters[flags.apply]) die(`未知技术栈：${flags.apply}。可用：${Object.keys(adapters).join(' / ')}`, 2);
    if (!existsSync(path.join(root, 'devflow.json'))) die(`该目录没有 devflow.json：先执行 devflow init`, 2);
    const r = applyAdapter({ projectRoot: root, adapters, id: String(flags.apply), dryRun: Boolean(flags['dry-run']), demo: Boolean(flags.demo), replacePlaceholders: Boolean(flags['replace-placeholders']), forceScripts: Boolean(flags['force-scripts']) });
    lines.push('', `${paint('已应用适配器', 'bold')}：${r.adapter}${flags['dry-run'] ? '（空跑，未写入）' : ''}`);
    lines.push(r.scripts.written.length ? `  补写脚本：${r.scripts.written.join('、')}` : '  补写脚本：无（都已存在）');
    lines.push(r.scripts.replaced.length ? `  替换占位脚本：${r.scripts.replaced.join('、')}` : '');
    lines.push(r.scripts.skipped.length ? `  跳过：${r.scripts.skipped.join('；')}` : '');
    lines.push(r.gates.added.length ? `  补门禁声明：${r.gates.added.join('、')}` : '  补门禁声明：无（都已声明）');
    lines.push('', '  下一步：devflow doctor 复查，确认结论为"可以开工"。');
  } else {
    lines.push('', '  应用方式：devflow adapters --apply <技术栈>（只补缺失，不覆盖已有脚本与声明）');
    lines.push('  替换 init 占位脚本：--replace-placeholders　替换适配器已生成的脚本（如切到 --demo）：--force-scripts');
    lines.push('  新建项目时也可直接指定：devflow init --stack <技术栈>');
  }
  out(flags, lines.filter((l) => l !== '').join('\n'), { adapters: Object.keys(adapters), detected, problems, applied: flags.apply || null });
}

/**
 * cmdReport —— **view 的历史别名**（保留兼容，不再各写一份实现）。
 *
 * 为什么合并：report 与 view 本来都是"生成只读 HTML 视图"，却各有一份渲染路径，
 * 结果 report 落后于 view（不含 Mermaid 图形、不支持工作区）。
 * 同一件事有两份实现，必然漂移 —— 所以这里直接委托给 `view`。
 */
function cmdReport(flags) {
  process.stdout.write('  提示：report 是 view 的历史别名（两者等价）；建议直接用 devflow view\n');
  return cmdView(flags);
}

function renderBoard({ title, profile, items, generatedAt }) {
  const rows = items.map((d) => {
    const tier = spec('states').tiers[d.tier]?.name || d.tier;
    const gates = (d.gates || []).filter((g) => !['G0', 'G1b', 'G4b', 'G5'].includes(g.gate));
    const badge = gates.map((g) => {
      const s = VERDICT_STYLE[g.verdict];
      return `<span class="v v-${g.verdict}" title="${escapeHtml(g.gate)}: ${escapeHtml(g.notes.join('；'))}">${s.symbol}${escapeHtml(g.gate)}</span>`;
    }).join(' ');
    const blocking = d.summary?.blocking ? `<span class="block">⛔ ${escapeHtml(d.summary.blockingGates.join('、'))}</span>` : '';
    const unverified = d.summary?.unverified ? `<span class="warn">⚠ 含未验证通过</span>` : '';
    return `<tr><td>${escapeHtml(d.itemId)}</td><td>${escapeHtml(tier)}</td><td>${escapeHtml(d.stateName || d.state)}</td><td>${badge}</td><td>${d.sizeKb}k</td><td>${blocking}${unverified}</td></tr>`;
  }).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>devflow 看板 · ${escapeHtml(title)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.6 -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; margin: 24px; max-width: 1100px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .meta { color: #888; font-size: 12px; margin-bottom: 16px; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border-bottom: 1px solid #8883; padding: 8px 10px; text-align: left; font-size: 13px; }
  th { font-weight: 600; color: #666; }
  .v { display: inline-block; margin-right: 6px; padding: 1px 6px; border-radius: 10px; font-size: 12px; border: 1px solid transparent; }
  .v-pass { color: #147a3d; background: #147a3d1a; border-color: #147a3d55; }
  .v-unverified, .v-exempt { color: #8a6100; background: #8a61001a; border-color: #8a610055; }
  .v-blocked, .v-fail { color: #b3261e; background: #b3261e1a; border-color: #b3261e55; }
  .block { color: #b3261e; margin-right: 8px; }
  .warn { color: #8a6100; }
  .note { margin-top: 18px; font-size: 12px; color: #888; }
</style></head>
<body>
<h1>devflow 看板 · ${escapeHtml(title)}</h1>
<div class="meta">规模档：${escapeHtml(profile)}　生成时间：${escapeHtml(generatedAt)}　只读视图（干预请回到会话）</div>
<table>
<thead><tr><th>变更</th><th>档位</th><th>状态</th><th>门禁</th><th>体积</th><th>提示</th></tr></thead>
<tbody>
${rows || '<tr><td colspan="6">暂无变更</td></tr>'}
</tbody></table>
<div class="note">
  图例：✓ 通过（有证据）　⚠ 未验证通过（含豁免，或负向对照缺失）　⛔ 阻断　✗ 失败。
  悬停徽章可看判定理由。门禁原始输出在变更目录的 STATUS.json 中（本页面不复制正文）。
</div>
</body></html>
`;
}

function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function cmdArchive(flags) {
  const { root } = resolveProject(flags);
  const r = archive({ projectRoot: root, kitSpec: allSpec(), artifactsSpec: spec('artifacts'), dryRun: !flags.go });
  const lines = [
    `${paint('归档', 'bold')}${r.dryRun ? '（空跑，未改动任何文件；确认后加 --go）' : ''}`,
    `  规则：只归档已 released 的变更，且「超过 ${r.rules.afterDays} 天」与「不在最近 ${r.rules.keepRecent} 条之内」同时满足`,
    `  规则来源：spec/artifacts.json 的 archive（改这里即可调整）`,
    r.moves.length ? r.moves.map((m) => `  ${m.from} → ${m.to}`).join('\n') : '  无符合条件的变更',
  ];
  out(flags, lines.join('\n'), r);
}

function cmdSelfcheck(flags) {
  const report = runSelfcheck();
  const lines = [
    `${paint('门禁体系自检', 'bold')}   用例 ${report.cases.length} 条`,
    '',
    ...report.cases.map((c) => `  ${c.passed ? paint('✓', 'green') : paint('✗', 'red')} ${c.id} ${c.name}${c.passed ? '' : `\n      期望：${c.expect}\n      实际：${c.actual}`}`),
    '',
    report.passed ? `${paint('  结论：自检通过', 'green')}` : `${paint(`  结论：自检失败（${report.cases.filter((c) => !c.passed).length} 条）`, 'red')}`,
  ];
  out(flags, lines.join('\n'), report);
  if (!report.passed) process.exitCode = 1;
}

/**
 * devflow workspace —— 工作区（多仓协作）的**创建与查看**。
 *
 * 此前只有"查看"：它要求 `devflow.workspace.json` 已存在，却没有任何创建路径 ——
 * 于是"怎么设置/选择工作区"这个用户问题无法回答（只能读不能建 = 不可用）。
 * 本命令补齐：`init`（创建）/ `add`（加仓）/ `remove`（移除）/ 默认（查看）。
 */
/**
 * devflow architecture —— 生成/更新**仓级架构声明**（`.devflow/architecture.md`）。
 *
 * 为什么需要：D14 会提示"缺少架构声明"，但此前没有便捷的生成路径 ——
 * 提示了却做不到，等于空提示。本命令把"从模板生成"这一步补齐。
 *
 * 设计：不覆盖已有文件（架构声明是团队共识，不能因为跑个命令就丢）；
 * 需要重建时显式 --force；支持 --dry-run 先看内容。
 */
function cmdArchitecture(flags) {
  const { root, loaded } = resolveProject(flags);
  const rel = '.devflow/architecture.md';
  const target = path.join(root, rel);
  const exists = existsSync(target);
  if (exists && !flags.force) {
    die(`${rel} 已存在（架构声明是团队共识，不覆盖）\n`
      + '  想重新生成：devflow architecture --force（会覆盖，注意先备份）\n'
      + '  想看当前内容：直接打开该文件，或用 devflow view 点开查看', 2);
  }
  // 从模板渲染：复用模板系统（技术栈等由项目自己填）
  const meta = {
    title: loaded.config?.devflow?.project || path.basename(root),
    item: '(仓级)', tier: 'n/a', tierName: '仓级',
    // repos / changeSurface 必须是数组（renderTemplate 用 join('、')；传字符串会 TypeError）
    owner: '(待填)', repos: [path.basename(root)], changeSurface: ['internal'],
    createdAt: new Date().toISOString().slice(0, 10),
  };
  let content;
  try {
    content = renderTemplate(KIT_ROOT, 'architecture', meta);
  } catch (e) {
    die(`模板渲染失败：${e.message}\n  说明：kit 安装可能不完整（缺少 templates/architecture.md）`, 3);
  }
  if (flags['dry-run']) {
    out(flags, [`${paint('devflow architecture', 'bold')}（预演，未写入）`,
      `  将写入：${rel}`, '', ...content.split('\n').slice(0, 12).map((l) => `    ${l}`),
      '    …', '', '  确认后去掉 --dry-run 执行'].join('\n'), { dryRun: true, rel });
    return;
  }
  mkdirSync(path.join(root, '.devflow'), { recursive: true });
  writeFileSync(target, content, 'utf8');
  out(flags, [
    `${paint('devflow architecture', 'bold')}  ${meta.title}`,
    `  ${exists ? '已覆盖' : '已生成'}：${rel}`,
    '',
    '  请填写：技术栈、分层与目录约定、架构决策（ADR）、不可违反的约束、项目自定义必答项。',
    '  作用：',
    '    · 新变更继承架构约束，而不是每次重写',
    '    · devflow clarify 会读取「需求必答清单」中的项目自定义项（Q-x）',
    '    · devflow view 里可点开查看',
    '',
    '  提示：架构声明是**仓级永久产物，应当入库**（与 devflow.json 同级）。',
  ].join('\n'), { rel, created: !exists });
}

function cmdWorkspaceInit(root, flags) {
  const file = path.join(root, 'devflow.workspace.json');
  if (existsSync(file) && !flags.force) {
    die(`工作区清单已存在：${file}\n  需要重建请加 --force`, 2);
  }
  // 扫描一级子目录里的 git 仓（并跳过已归档/无 devflow.json 的）
  const entries = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .filter((n) => existsSync(path.join(root, n, '.git')));
  const selected = flags.repos
    ? String(flags.repos).split(',').map((x) => x.trim()).filter(Boolean)
    : entries;
  const bad = selected.filter((n) => !existsSync(path.join(root, n, '.git')));
  if (bad.length) die(`不是 git 仓：${bad.join('、')}`, 2);

  const members = selected.map((n) => {
    const sub = path.join(root, n, 'devflow.json');
    let kind = '未接入';
    try {
      const c = JSON.parse(readFileSync(sub, 'utf8'));
      kind = c.devflow?.kind || c.devflow?.project || '已接入';
    } catch { /* 未接入 */ }
    return { name: n, path: `./${n}`, kind };
  });
  const ws = {
    $comment: '工作区清单：本文件把多个仓纳入同一个工作流视图。由 `devflow workspace init` 生成。',
    version: '1.0.0',
    workspace: { name: flags.name ? String(flags.name) : path.basename(root) },
    members,
  };
  if (flags['dry-run']) {
    out(flags, [`${paint('devflow workspace init', 'bold')}（预演，未写入）`,
      `  将纳入 ${members.length} 个仓：${members.map((m) => m.name).join('、') || '(无)'}`,
      `  写入：${path.relative(process.cwd(), file) || file}`,
      '', '  确认后去掉 --dry-run 执行'].join('\n'), { dryRun: true, members });
    return;
  }
  writeFileSync(file, `${JSON.stringify(ws, null, 2)}\n`, 'utf8');
  const notOnboarded = members.filter((m) => m.kind === '未接入');
  out(flags, [
    `${paint('devflow workspace init', 'bold')}  ${ws.workspace.name}`,
    `  已写入：${path.relative(process.cwd(), file) || file}`,
    `  纳入 ${members.length} 个仓：${members.map((m) => m.name).join('、') || '(无)'}`,
    notOnboarded.length ? '' : '',
    notOnboarded.length ? `  ⚠ 其中 ${notOnboarded.length} 个仓尚未接入 devflow：${notOnboarded.map((m) => m.name).join('、')}` : '',
    notOnboarded.length ? `    逐个接入：cd <仓> && devflow init --name <名字> && devflow doctor` : '',
    '',
    '  查看工作区：devflow workspace',
  ].filter(Boolean).join('\n'), { file, members });
}

function cmdWorkspace(flags, positional) {
  const sub = (positional || [])[0];
  // 创建/维护：修掉"只能读不能建"的缺口
  if (sub === 'init') {
    const root = flags.workspace ? path.dirname(path.resolve(String(flags.workspace))) : process.cwd();
    cmdWorkspaceInit(root, flags);
    return;
  }
  if (sub === 'add' || sub === 'remove') {
    const file = flags.workspace ? path.resolve(String(flags.workspace)) : findWorkspaceRoot();
    if (!file || !existsSync(file)) die('未找到工作区清单（devflow.workspace.json）。先运行 devflow workspace init。', 2);
    const ws = JSON.parse(readFileSync(file, 'utf8'));
    const target = (positional || [])[1];
    if (!target) die(`用法：devflow workspace ${sub} <仓名>`, 2);
    if (sub === 'add') {
      if ((ws.members || []).some((m) => m.name === target)) die(`工作区已含该仓：${target}`, 2);
      if (!existsSync(path.join(path.dirname(file), target, '.git'))) die(`不是 git 仓：${target}`, 2);
      ws.members = [...(ws.members || []), { name: target, path: `./${target}`, kind: '未接入' }];
    } else {
      const before = (ws.members || []).length;
      ws.members = (ws.members || []).filter((m) => m.name !== target);
      if (ws.members.length === before) die(`工作区不含该仓：${target}`, 2);
    }
    // --out 可能指向不存在的子目录：先建父目录（否则用户自定义路径会直接失败）
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(ws, null, 2)}\n`, 'utf8');
    out(flags, `${paint('devflow workspace ' + sub, 'bold')}  ${target}\n  现有 ${ws.members.length} 个仓：${ws.members.map((m) => m.name).join('、') || '(无)'}`,
      { action: sub, member: target, count: ws.members.length });
    return;
  }
  const file = flags.workspace ? path.resolve(String(flags.workspace)) : findWorkspaceRoot();
  if (!file || !existsSync(file)) {
    die('未找到工作区清单（devflow.workspace.json）—— 本目录还不是工作区。\n'
      + '  创建：devflow workspace init [--repos a,b] [--name <工作区名>] [--dry-run]\n'
      + '  说明：工作区把多个仓纳入同一个视图；单仓项目直接用 devflow start 即可。', 2);
  }
  const ws = JSON.parse(readFileSync(file, 'utf8'));
  const wsRoot = path.dirname(file);
  const members = (ws.members || []).map((m) => {
    const root = path.resolve(wsRoot, m.path || '.');
    const configPath = path.join(root, 'devflow.json');
    const loaded = existsSync(configPath) ? loadProject(root) : { ok: false, errors: ['缺少 devflow.json'] };
    let items = [];
    if (loaded.ok) {
      items = listItems(root).map((i) => evaluateItem({ projectRoot: root, itemId: i.itemId, kitSpec: allSpec(), config: loaded.config, cwd: process.cwd() }));
    }
    return { name: m.name, kind: m.kind, root, loaded, items };
  });
  const lines = [
    `${paint('工作区', 'bold')}  ${ws.workspace?.name || path.basename(wsRoot)}    kit ${kitVersion()}`,
    '',
    '  项目            类型        变更                档   状态          门禁',
    ...members.flatMap((m) => (m.items.length
      ? m.items.map((d) => `  ${m.name.padEnd(15)}${String(m.kind || '-').padEnd(12)}${d.itemId.padEnd(19)}${(spec('states').tiers[d.tier]?.name || d.tier).padEnd(3)} ${(d.stateName || '-').padEnd(13)}${(d.gates || []).filter((g) => !['G0', 'G1b', 'G4b'].includes(g.gate)).map((g) => `${g.gate}${VERDICT_STYLE[g.verdict].symbol}`).join(' ')}`)
      : [`  ${m.name.padEnd(15)}${String(m.kind || '-').padEnd(12)}${'（无在办变更）'}`])),
    '',
    ...members.filter((m) => !m.loaded.ok).map((m) => `  ${paint('✗ 不可用', 'red')} ${m.name}：${m.loaded.errors.join('；')}`),
  ];
  out(flags, lines.join('\n'), { workspace: ws.workspace, members: members.map((m) => ({ name: m.name, ok: m.loaded.ok, items: m.items.length, errors: m.loaded.errors })) });
}

function cmdVersion(flags) {
  const v = {
    kit: kitVersion(),
    node: process.version,
    kitRoot: KIT_ROOT,
    spec: Object.keys(allSpec()),
    commands: ['init', 'doctor', 'adapters', 'new', 'fill', 'status', 'gate run', 'advance', 'report', 'archive', 'workspace', 'selfcheck', 'skill', 'version'],
  };
  out(flags, [
    `devflow-kit ${v.kit}`,
    `  node：${v.node}`,
    `  kit：${v.kitRoot}`,
    `  正典：${v.spec.join(' / ')}`,
    `  适配器：${Object.keys(loadAdapters(KIT_ROOT)).join(' / ')}`,
    `  命令：${v.commands.join('、')}`,
  ].join('\n'), v);
}

function cmdSkill(flags, positional) {
  const sub = positional[0] || 'sync';
  if (sub !== 'sync') die(`未知子命令：skill ${sub}（目前只支持 skill sync）`, 2);
  const r = syncInstalledSkill(path.join(KIT_ROOT, 'skill', 'SKILL.md'), { dryRun: !!flags.check });

  if (flags.json) {
    // 退出码是给 CI / 脚本用的契约：
    //   0 = 已一致 / 未安装（无可同步之物，不算问题）
    //   1 = `--check` 发现不一致（过期，可修）
    //   2 = 真错误（源缺失、写入失败）
    if (r.action === 'source-missing' || r.action === 'write-failed') process.exitCode = 2;
    else if (flags.check && r.action === 'stale') process.exitCode = 1;
    out(flags, '', { action: r.action, installedPath: r.installedPath, verdict: r.verdict, reason: r.reason, check: !!flags.check });
    return;
  }

  const lines = [];
  switch (r.action) {
    case 'ok':
      lines.push(`聊天技能已是最新：${r.installedPath}`);
      break;
    case 'stale':
      lines.push(flags.check
        ? `聊天技能**与 kit 不一致**（需要同步）：${r.installedPath}`
        : `聊天技能已同步到最新：${r.installedPath}`);
      lines.push(`  原因：${r.reason}`);
      if (flags.check) {
        lines.push('  同步：devflow skill sync');
        process.exitCode = 1;   // --check 是给 CI 用的：不一致就该非零
      }
      break;
    case 'missing':
      lines.push(`未安装聊天技能（${r.installedPath} 不存在）`);
      lines.push('  安装：devflow setup');
      break;
    case 'source-missing':
      lines.push(`✗ ${r.reason}`);
      process.exitCode = 2;
      break;
    default:
      lines.push(`✗ 同步失败：${r.reason}`);
      lines.push('  已安装副本保持原样；可手工执行：devflow setup');
      process.exitCode = 2;
  }
  out(flags, lines.join('\n'), r);
}

/**
 * 任何一次 devflow 命令都顺手把**已存在**的聊天技能副本收敛回与源一致。
 *
 * 为什么放在这里而不是让用户记得重跑 setup：技能装成真实文件（不是软链），
 * 源改了副本不会自动更新 —— 而 agent 读的正是副本。真实踩到：源里的 npm 指令已删，
 * 副本里还留着，于是 agent 一直建议用户去装同名的别人项目，且全程无报错。
 *
 * 约束：只收敛**已存在**的副本（不替用户安装）；失败静默（一个顺手动作不能搞崩用户要跑的命令）；
 * 只在实际有改动时提示，且刻意不写成警告（这不是错误，是已自动完成的事）。
 */
function autoSyncSkill(command) {
  const skip = new Set(['skill', 'version', 'selfcheck', 'setup', 'setup-hooks']);
  if (skip.has(command)) return;
  try {
    const r = syncInstalledSkill(path.join(KIT_ROOT, 'skill', 'SKILL.md'));
    if (r.action === 'stale') {
      process.stdout.write(`  · 已自动同步聊天技能副本（源已更新）：${r.installedPath}\n`);
    }
  } catch { /* 读不到 home / 环境受限：静默跳过，不影响命令本身 */ }
}

function usage() {
  return `${paint('devflow', 'bold')} · 通用研发工作流（0 依赖）

用法：devflow <命令> [参数]

  init                 初始化项目（写 devflow.json 与目录骨架，绝不覆盖已有文件）
  new --slug <名> [--title <标题>] [--tier micro|light|standard|heavy] [--plan]
                       新建一个变更（目录非空即拒绝；--plan 只出计划）
  fill <item> [--to <状态>] [--file <产物>]
                       按模板补齐缺失产物（不覆盖已存在文件）
  doctor               体检：门禁是否可信、配置是否可用（只读，给出问题+依据+修法）
  adapters [--apply <栈>] [--dry-run] [--demo]
                       列出/检测技术栈适配器；--apply 只补缺失的脚本与门禁声明
  status [item]        查看变更 / 项目状态；--all 列出全部；--digest 输出固定摘要
  gate run [item]      执行项目门禁并留证据，随后评估 G0..G7
  advance <item> --to <状态> [--force]
                       推进状态（门禁未通过则拒绝；--force 会留痕）
  report [--out <文件>] 生成静态 HTML 看板（只读视图）
  archive [--go]       归档已完成变更（默认空跑）
  workspace            跨项目聚合视图（--workspace 指定清单）
  selfcheck            门禁体系自检
  version              版本信息

通用参数：--json 机器可读　--root <目录>　--help
逐命令帮助：devflow help <命令>   或   devflow <命令> --help
`;
}

// ────────────────────────────── 路由 ──────────────────────────────
const argv = process.argv.slice(2);
const { flags, positional } = parseArgs(argv);
const command = positional.shift();

if (!command || (flags.help && !COMMAND_HELP[command]) || command === 'help') {
  const topic = positional[0];
  if (command === 'help' && topic && printCommandHelp(topic)) process.exit(0);
  process.stdout.write(usage());
  if (!command) {
    const found = resolveProjectRoot();
    process.stdout.write(`\n${paint('推荐路径', 'bold')}：\n`);
    if (!found) {
      process.stdout.write('  1) devflow init --name <项目名>      初始化当前目录\n');
      process.stdout.write('  2) devflow doctor                    体检：门禁能不能信\n');
      process.stdout.write('  3) devflow new --slug <变更名> --tier light --title "<标题>"\n');
    } else {
      process.stdout.write(`  当前项目：${found.root}\n`);
      process.stdout.write('  1) devflow doctor                    体检：门禁能不能信（建议每次开工先跑）\n');
      process.stdout.write('  2) devflow status                    看当前有哪些变更、卡在哪\n');
      process.stdout.write('  3) devflow advance <item> --to <状态> --check   预演能不能推进\n');
      process.stdout.write('  4) devflow gate run <item>           跑门禁、留证据\n');
    }
    process.stdout.write(`\n  逐命令帮助：devflow help <命令>\n`);
  }
  process.exit(0);
}
if (flags.help && COMMAND_HELP[command]) {
  printCommandHelp(command);
  process.exit(0);
}

// 收敛放在**命令执行之前**：它只依赖 kit 与用户 home，与"这条命令能不能跑成"无关。
// 放在之后会漏掉所有 die() 退出的命令（找不到项目根、参数错误…），那些恰恰是新手最常遇到的。
autoSyncSkill(command);

try {
  switch (command) {
    case 'init': cmdInit(flags); break;
    case 'new': cmdNew(flags, positional); break;
    case 'fill': cmdFill(flags, positional); break;
    case 'doctor': cmdDoctor(flags); break;
    case 'standards': cmdStandards(flags); break;
    case 'migrate-storage': cmdMigrateStorage(flags); break;
    case 'start': cmdStart(flags); break;
    case 'view': cmdView(flags); break;
    case 'graph': cmdGraph(flags); break;
    case 'history': cmdHistory(flags, positional); break;
    case 'board': cmdBoard(flags); break;
    case 'review': cmdReview(flags, positional); break;
    case 'contract': cmdContract(flags, positional); break;
    case 'task': cmdTask(flags, positional); break;
    case 'clarify': cmdClarify(flags, positional); break;
    case 'setup': cmdSetup(flags); break;
    case 'setup-hooks': cmdSetupHooks(flags); break;
    case 'ci': cmdCi(flags); break;
    case 'adapters': cmdAdapters(flags); break;
    case 'status': cmdStatus(flags, positional); break;
    case 'gate': {
      const sub = positional.shift();
      if (sub !== 'run') die(`未知子命令：gate ${sub || ''}（目前只支持 gate run）`, 2);
      cmdGate(flags, positional);
      break;
    }
    case 'advance': cmdAdvance(flags, positional); break;
    case 'report': cmdReport(flags); break;
    case 'archive': cmdArchive(flags); break;
    case 'workspace': cmdWorkspace(flags, positional); break;
    case 'architecture': cmdArchitecture(flags); break;
    case 'selfcheck': cmdSelfcheck(flags); break;
    case 'skill': cmdSkill(flags, positional); break;
    case 'version': cmdVersion(flags); break;
    default: die(`未知命令：${command}\n\n${usage()}`, 2);
  }
} catch (error) {
  if (error && error.name === 'SilentExit') {
    // 已设置好 exitCode，正常结束
  } else {
    die(error.stack || error.message, 9);
  }
}
