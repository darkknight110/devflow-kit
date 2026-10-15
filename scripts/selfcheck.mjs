/**
 * 自检：证明门禁体系本身有效。
 *
 * 为什么必须有它：门禁是"防止别人造假"的东西，所以门禁自己也必须被验证。
 * 每条用例都构造一个真实夹具，跑真实引擎，断言真实结论。
 * 说明：自检会构造"恒真门禁""未定义状态"等故意坏的输入 —— 这些输入只存在于临时目录，
 *      不会写进项目；每个用例跑完即清理。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, symlinkSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { KIT_ROOT, defaultProjectConfig, loadKitSpec } from './lib/manifest.mjs';
import { evaluateGates, summarize } from './lib/gate.mjs';
import { runProjectGates } from './lib/evidence.mjs';
import { rawState } from './lib/state.mjs';
import { diagnose, mergeStandardBlockers } from './lib/doctor.mjs';
import { collectBoardState } from './lib/board.mjs';
import { loadAdapters, detectAdapters, applyAdapter, auditAdapterRegex } from './lib/adapter.mjs';
import { findPlaceholderContent } from './lib/gate.mjs';
import { detectEnvFailure } from './lib/doctor.mjs';
import { detectEnvRestricted } from './lib/evidence.mjs';
import { validateCommitMessage } from '../tools/validate-commit-msg.mjs';
import { checkStandards } from './lib/standards.mjs';
import { extractEndpoints, normalizePath, pathMatches } from '../tools/contract-scan.mjs';
import { auditTemplates, renderTemplate, TEMPLATE_FILES } from './lib/template.mjs';
import { createItem } from './lib/state.mjs';

const KIT = {
  states: loadKitSpec('states'),
  artifacts: loadKitSpec('artifacts'),
  gates: loadKitSpec('gates'),
  roles: loadKitSpec('roles'),
};

function tmpProject(name) {
  const root = path.join(os.tmpdir(), `devflow-selfcheck-${process.pid}-${name}`);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  return root;
}

function write(root, rel, content, mode) {
  const full = path.join(root, rel);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, mode ? { mode } : undefined);
  return full;
}

function makeConfig(root, gates, profile = 'team') {
  const config = { devflow: { kit: '*', project: 'fixture', kind: 'service', stack: 'node' }, profile, gates };
  write(root, 'devflow.json', JSON.stringify(config, null, 2));
  return config;
}

function makeSpec(root, itemId, tier, surface = ['internal']) {
  const tierName = { micro: '微', light: '轻', standard: '标', heavy: '重' }[tier];
  write(root, `.devflow/items/${itemId}/SPEC.md`, `# SPEC

## 身份

| 项 | 值 |
|---|---|
| item | ${itemId} |
| 档位 | ${tierName}（${tier}） |
| 负责人 | selfcheck |
| 目标仓 | fixture |
| 变更面 | ${surface.join('、')} |
| 创建日期 | 2026-01-01 |

## 验收标准

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | ./scripts/test.sh 退出码为 0 且 Tests run 计数 ≥ 1 | 命令 | 实现者 |

## 不做什么

- 无
`);
}

function evaluate(root, itemId, state, config) {
  const itemDir = path.join(root, '.devflow', 'items', itemId);
  const results = evaluateGates({ projectRoot: root, itemId, itemDir, state, actualState: state, kitSpec: KIT, config, cwd: root });
  return { results, summary: summarize(results), itemDir };
}

function writeState(root, itemId, state) {
  write(root, `.devflow/items/${itemId}/STATE`, `${state}\n`);
}

function verdictOf(results, gate) {
  const hit = results.filter((r) => r.gate === gate);
  return hit.length ? hit[hit.length - 1].verdict : 'missing';
}

const cases = [];
function record(id, name, expect, actual, passed, detail) {
  cases.push({ id, name, expect, actual, passed, detail });
}

/** SC1 / SC2：缺件必须阻断，齐全必须通过 */
function sc1and2() {
  const root = tmpProject('g1');
  const itemId = '2026-01-01-missing';
  const config = makeConfig(root, { build: { run: 'true', negative_control: 'false' } });
  // SC1：只有 STATE，没有任何产物（故意留空，用于验证"缺件必须阻断"）
  writeState(root, itemId, 'verified');
  const before = evaluate(root, itemId, 'verified', config);
  record('SC1', '缺件必须阻断', 'G1 返回 blocked', `G1=${verdictOf(before.results, 'G1')}`, verdictOf(before.results, 'G1') === 'blocked', before.summary);

  // 补齐 verified 所需全部产物（含档位与规模档要求）
  const itemDir = path.join(root, '.devflow', 'items', itemId);
  // SC2：先补齐 SPEC（档位由它决定，缺它时引擎只能退回默认档并如实标注来源）
  makeSpec(root, itemId, 'standard');
  // 标准档从 draft 到 verified，会经过 contracted（因为 targeted 是 verified，链包含它）
  const stateDef = KIT.states.states.verified;
  const tierDef = KIT.states.tiers.standard;
  const required = [...new Set([...stateDef.required, ...tierDef.requiredArtifacts])];
  for (const file of required) {
    if (file === 'SPEC.md') continue;
    if (file === 'CONTRACT.md') {
      write(root, `.devflow/items/${itemId}/CONTRACT.md`, `# CONTRACT\n\n## 所有权\n\n| 项 | 值 |\n|---|---|\n| owner | fixture |\n| surface | /api/x |\n\n## 消费者\n\n| 消费方 | 使用方式 | 是否破坏性 |\n|---|---|---|\n| web | 调用 | 否 |\n\n## 兼容策略\n\n- 向后兼容\n\n## 校验方式\n\n- ./scripts/contract.sh\n`);
    } else if (file === 'TASKS.md') {
      write(root, `.devflow/items/${itemId}/TASKS.md`, `# TASKS\n\n## 任务\n\n| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |\n|---|---|---|---|---|---|---|---|---|\n| T-1 | fixture | 前端 | src/ | 无 | 待开始 | 张三 | ./scripts/test.sh | AC-1 |\n`);
    } else if (file === 'verification.md') {
      write(root, `.devflow/items/${itemId}/verification.md`, `# 验证记录\n\n## 逐条对照\n\n| AC | 结论 | 证据 |\n|---|---|---|\n| AC-1 | 已实现 | scripts/test.sh 退出码 0，见 STATUS.json |\n\n## 结论\n\n- 总体结论：已实现\n- 阻断项：无\n- 基线豁免：无\n\n## 证据\n\n- 命令原文与输出尾部见 STATUS.json\n`);
    } else if (file === 'APPROVALS.md') {
      write(root, `.devflow/items/${itemId}/APPROVALS.md`, `# 确认记录\n\n## 确认记录\n\n| 确认点 | 确认人 | 时间 | 结论 |\n|---|---|---|---|\n| 需求与判据 | 甲 | 2026-01-01T00:00:00Z | 通过 |\n| 契约冻结 | 乙 | 2026-01-01T01:00:00Z | 通过 |\n| 发布批准 | 丙 | 2026-01-01T02:00:00Z | 通过 |\n`);
    } else if (file === 'coding_report.md') {
      write(root, `.devflow/items/${itemId}/coding_report.md`, `# 实现报告\n\n## 改了什么\n\n- 无\n\n## 涉及提交\n\n| 提交 | 仓库 | 说明 |\n|---|---|---|\n| abc1234 | fixture | 初始 |\n`);
    } else if (file === 'release/report.md') {
      write(root, `.devflow/items/${itemId}/release/report.md`, `# 发布报告\n\n## 发布内容\n\n- 无\n\n## 验证证据\n\n- 命令原文见 STATUS.json\n\n## 观察窗口\n\n- 2026-01-01 至 2026-01-03，指标正常\n`);
    }
  }
  // 写入门禁记录，满足 G2
  write(root, `.devflow/items/${itemId}/STATUS.json`, JSON.stringify({
    item: itemId, state: 'verified',
    lastRun: {
      at: new Date().toISOString(),
      source: 'selfcheck',
      summary: { total: 1, pass: 1 },
      records: [{ gate: 'build', project: 'fixture', command: './scripts/build.sh', exitCode: 0, outputTail: 'build ok', startedAt: new Date().toISOString(), durationMs: 12, verdict: 'pass' }],
    },
  }, null, 2));

  const after = evaluate(root, itemId, 'verified', config);
  const g1 = after.results.find((r) => r.gate === 'G1');
  const g1Detail = g1 ? `missing=${JSON.stringify(g1.evidence?.missing)} sections=${JSON.stringify(g1.evidence?.sectionErrors)} tier=${g1.evidence?.tier}(${g1.evidence?.tierSource})` : 'no-g1';
  record('SC2', '齐全必须通过', 'G1 返回 pass', `G1=${verdictOf(after.results, 'G1')} ${g1Detail}`, verdictOf(after.results, 'G1') === 'pass', g1Detail);
  rmSync(root, { recursive: true, force: true });
}

/** SC3：恒真门禁必须被判不可信 */
function sc3() {
  const root = tmpProject('negctl');
  const config = makeConfig(root, {
    build: { run: 'true', negative_control: 'true' },   // 负向对照也返回 0 ⇒ 恒真
  });
  const { records } = runProjectGates(config, root);
  const v = records.find((r) => r.gate === 'build')?.verdict;
  record('SC3', '恒真门禁必须被判不可信', 'verdict=unverified（⚠），不得为 pass', `verdict=${v}`, v === 'unverified');
  rmSync(root, { recursive: true, force: true });
}

/** SC4：未声明负向对照 ⇒ 未验证通过，且不阻断 */
function sc4() {
  const root = tmpProject('noneg');
  const config = makeConfig(root, { test: { run: 'echo "Tests run: 3"' } });
  const { records } = runProjectGates(config, root);
  const v = records.find((r) => r.gate === 'test')?.verdict;
  record('SC4', '未声明负向对照记未验证通过', 'verdict=unverified 且不阻断', `verdict=${v}`, v === 'unverified');
  rmSync(root, { recursive: true, force: true });
}

/** SC5：未定义状态必须报错 */
function sc5() {
  const root = tmpProject('badstate');
  const itemId = '2026-01-01-bad';
  makeConfig(root, { build: { run: 'true' } });
  writeState(root, itemId, 'whatever');
  const info = evaluate(root, itemId, rawState(path.join(root, '.devflow/items', itemId)), makeConfig(root, { build: { run: 'true' } }));
  const g5 = info.results.find((r) => r.gate === 'G5');
  const fatal = info.summary.fatal;
  record('SC5', '未定义状态必须报错', 'G5=blocked 且 summary.fatal=true', `G5=${g5?.verdict} fatal=${fatal}`, g5?.verdict === 'blocked' && fatal === true, g5?.notes);
  rmSync(root, { recursive: true, force: true });
}

/** SC6：证据缺失必须阻断 */
function sc6() {
  const root = tmpProject('noevidence');
  const itemId = '2026-01-01-noev';
  const config = makeConfig(root, { build: { run: 'true' } });
  writeState(root, itemId, 'tested');
  makeSpec(root, itemId, 'standard');
  write(root, `.devflow/items/${itemId}/STATUS.json`, JSON.stringify({
    item: itemId, state: 'tested',
    lastRun: { at: new Date().toISOString(), records: [{ gate: 'build', command: 'true' }] },  // 缺 exitCode / outputTail
  }, null, 2));
  const info = evaluate(root, itemId, 'tested', config);
  record('SC6', '证据缺失必须阻断', 'G2=blocked', `G2=${verdictOf(info.results, 'G2')}`, verdictOf(info.results, 'G2') === 'blocked', info.results.find((r) => r.gate === 'G2')?.notes);
  rmSync(root, { recursive: true, force: true });
}

/** SC7：静默降档必须提示 */
function sc7() {
  const root = tmpProject('downgrade');
  const itemId = '2026-01-01-light';
  const config = makeConfig(root, { build: { run: 'true' } });
  writeState(root, itemId, 'draft');
  makeSpec(root, itemId, 'light', ['contract']);   // 轻档却声明契约面（触发 G7）
  write(root, `.devflow/items/${itemId}/CONTRACT.md`, '# CONTRACT\n\n## 所有权\n\n| 项 | 值 |\n|---|---|\n| owner | x |\n| surface | y |\n\n## 消费者\n\n| 消费方 | 使用方式 | 是否破坏性 |\n|---|---|---|\n| z | 调用 | 否 |\n\n## 兼容策略\n\n- 向后兼容\n\n## 校验方式\n\n- ./x.sh\n');
  const info = evaluate(root, itemId, 'draft', config);
  record('SC7', '静默降档必须提示', 'G7=unverified', `G7=${verdictOf(info.results, 'G7')}`, verdictOf(info.results, 'G7') === 'unverified', info.results.find((r) => r.gate === 'G7')?.notes);
  rmSync(root, { recursive: true, force: true });
}

/** SC8：预算超限必须阻断 */
function sc8() {
  const root = tmpProject('budget');
  const itemId = '2026-01-01-big';
  const config = makeConfig(root, { build: { run: 'true' } });
  config.budget = { warn_kb: 1, block_kb: 2 };
  makeConfig(root, config.gates);
  write(root, 'devflow.json', JSON.stringify(config, null, 2));
  writeState(root, itemId, 'draft');
  makeSpec(root, itemId, 'standard');
  write(root, `.devflow/items/${itemId}/big.md`, 'x'.repeat(4000));   // 约 4k 字符 > 2k 阻断线
  const info = evaluate(root, itemId, 'draft', config);
  record('SC8', '预算超限必须阻断', 'G4=blocked', `G4=${verdictOf(info.results, 'G4')} size=${info.results.find((r) => r.gate === 'G4')?.evidence?.itemKb}k`, verdictOf(info.results, 'G4') === 'blocked');
  rmSync(root, { recursive: true, force: true });
}

/**
 * SC9：负向对照必须**有失败证据**才判可信。
 *
 * 原用例名为「负向对照返回非零时判通过」，把"只看退出码"这条弱规则钉成了保证 ——
 * 于是"测试被 exclude ⇒ No test files found（退出码 1）"这种**空转**也能通过门禁。
 * 独立复核实测到该问题后，规则收紧为：退出码 ≠ 0 **且** 输出含失败证据。
 */
function sc9() {
  const root = tmpProject('goodneg');

  // ① 有失败证据 ⇒ 判 pass
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho "BUILD SUCCESS"\n', 0o755);
  write(root, 'scripts/build-should-fail.sh',
    '#!/usr/bin/env bash\necho "AssertionError: expected 1 to be 2" >&2\necho "FAIL test/foo.test.ts" >&2\nexit 1\n', 0o755);
  const cfgA = makeConfig(root, { build: { run: './scripts/build.sh', negative_control: './scripts/build-should-fail.sh' } });
  const a = runProjectGates(cfgA, root).records.find((x) => x.gate === 'build');

  // ② 退出码非零但**没有失败证据**（空转：如 No test files found）⇒ 必须 unverified
  write(root, 'scripts/nc-empty.sh', '#!/usr/bin/env bash\necho "No test files found, exiting with code 1" >&2\nexit 1\n', 0o755);
  const cfgB = makeConfig(root, { build: { run: './scripts/build.sh', negative_control: './scripts/nc-empty.sh' } });
  const b = runProjectGates(cfgB, root).records.find((x) => x.gate === 'build');

  record('SC9', '负向对照须有失败证据才判可信（空转必须判 unverified）',
    '含 AssertionError/FAIL ⇒ pass；仅 "No test files found" 退出 1 ⇒ unverified',
    `有证据=${a?.verdict} 空转=${b?.verdict} control=${a?.controlExitCode}`,
    a?.verdict === 'pass' && typeof a.controlExitCode === 'number' && b?.verdict === 'unverified');
  rmSync(root, { recursive: true, force: true });
}

/** SC11：项目门禁失败必须体现为阻断（不得被 Kit 结论掩盖） */
function sc11() {
  const root = tmpProject('projgatefail');
  const itemId = '2026-01-01-pg';
  const config = makeConfig(root, {
    test: { run: 'echo "Tests run: 0"', count_regex: 'Tests run: (\\d+)', require_min_tests: 1, negative_control: 'exit 1' },
  });
  writeState(root, itemId, 'draft');
  const { records, summary } = runProjectGates(config, root);
  const rec = records.find((r) => r.gate === 'test');
  const blocking = summary.blocking || rec.verdict === 'fail' || rec.verdict === 'blocked';
  record('SC11', '项目门禁失败必须阻断', 'test 记录 verdict=fail，且 summary.blocking=true', `verdict=${rec.verdict} blocking=${blocking}`, rec.verdict === 'fail' && blocking === true);
  rmSync(root, { recursive: true, force: true });
}

/** SC12：微档无 SPEC 时档位必须来自 STATUS.json，不得退回默认标准档 */
function sc12() {
  const root = tmpProject('microtier');
  const itemId = '2026-01-01-m';
  makeConfig(root, { build: { run: 'true' } });
  writeState(root, itemId, 'draft');
  write(root, `.devflow/items/${itemId}/STATUS.json`, JSON.stringify({ item: itemId, state: 'draft', tier: 'micro' }, null, 2));
  const info = evaluate(root, itemId, 'draft', makeConfig(root, { build: { run: 'true' } }));
  const tier = info.results.find((r) => r.gate === 'G1')?.evidence?.tier;
  record('SC12', '微档档位不得退回默认', 'tier=micro', `tier=${tier}`, tier === 'micro');
  rmSync(root, { recursive: true, force: true });
}

/** SC13：init 生成的占位门禁必须被 doctor 判为阻断（新人零误判） */
function sc13() {
  const root = tmpProject('doctor-placeholder');
  const cfg = defaultProjectConfig('fixture', 'service', 'node');
  write(root, 'devflow.json', JSON.stringify(cfg, null, 2));
  for (const rel of ['scripts/build.sh', 'scripts/test.sh']) {
    write(root, rel, '#!/usr/bin/env bash\n# devflow:placeholder\nexit 1\n', 0o755);
  }
  for (const rel of ['scripts/build-should-fail.sh', 'scripts/test-should-fail.sh']) {
    write(root, rel, '#!/usr/bin/env bash\nexit 1\n', 0o755);
  }
  const { verdict, findings } = diagnose({ projectRoot: root, config: cfg, marker: 'devflow.json + .devflow/', cwd: root });
  const d4 = findings.filter((f) => f.id === 'D4' && f.severity === 'block');
  record('SC13', 'init 占位门禁必须判为阻断', 'doctor 的 verdict.trustworthy=false 且 D4 有 2 条 block',
    `trustworthy=${verdict.trustworthy} D4-block=${d4.length}`, verdict.trustworthy === false && d4.length === 2);
  rmSync(root, { recursive: true, force: true });
}

/** SC14：测试命令恒过但没跑测试，必须被 doctor 报出（假通过） */
function sc14() {
  const root = tmpProject('doctor-faketest');
  const cfg = makeConfig(root, {
    test: { run: 'echo "Tests run: 0"', count_regex: 'Tests run: (\\d+)', require_min_tests: 1, negative_control: 'exit 1' },
  });
  write(root, 'scripts/test.sh', '#!/usr/bin/env bash\necho "Tests run: 0"\nexit 0\n', 0o755);
  const { verdict, findings } = diagnose({ projectRoot: root, config: cfg, marker: 'devflow.json + .devflow/', cwd: root });
  const d3 = findings.find((f) => f.id === 'D3' && f.severity === 'block');
  record('SC14', '假测试通过必须被 doctor 报出', 'D3 有一条 block 发现',
    `found=${Boolean(d3)} verdict.trustworthy=${verdict.trustworthy}`, Boolean(d3) && verdict.trustworthy === false);
  rmSync(root, { recursive: true, force: true });
}

/** SC15：产物模板必须完整且令牌合法（模板与引擎不能各写一份） */
function sc15() {
  const problems = auditTemplates(KIT_ROOT);
  record('SC15', '产物模板完整且令牌合法', 'auditTemplates 返回空数组',
    problems.length ? problems.join('；') : `模板 ${Object.keys(TEMPLATE_FILES).length} 个全部合规`, problems.length === 0);
}

/** SC16：生成的标准档变更必须"缺件为零"（模板要能直接过 G1） */
function sc16() {
  const root = tmpProject('template-perfect');
  const cfg = makeConfig(root, { build: { run: 'true', negative_control: 'false' } });
  const created = createItem({
    projectRoot: root, itemId: '2026-01-01-tpl', tier: 'standard',
    owner: 'o', repos: ['r'], changeSurface: ['internal'], states: KIT.states, title: '模板校验',
  });
  const dir = path.join(root, '.devflow', 'items', '2026-01-01-tpl');
  for (const [kind, target] of [['spec', 'SPEC.md'], ['contract', 'CONTRACT.md'], ['tasks', 'TASKS.md'],
    ['codingReport', 'coding_report.md'], ['verification', 'verification.md'], ['approvals', 'APPROVALS.md'],
    ['releaseReport', 'release/report.md']]) {
    mkdirSync(path.dirname(path.join(dir, target)), { recursive: true });
    writeFileSync(path.join(dir, target), renderTemplate(KIT_ROOT, kind, created.meta));
  }
  write(root, `.devflow/items/2026-01-01-tpl/STATUS.json`, JSON.stringify({ item: '2026-01-01-tpl', state: 'draft', tier: 'standard' }, null, 2));
  const info = evaluate(root, '2026-01-01-tpl', 'contracted', cfg);
  const g1 = info.results.find((r) => r.gate === 'G1');
  const missing = g1?.evidence?.missing || [];
  record('SC16', '模板生成的产物缺件为零', 'G1 的 missing 为空',
    `missing=${JSON.stringify(missing)} sections=${JSON.stringify(g1?.evidence?.sectionErrors || [])}`, missing.length === 0);
  rmSync(root, { recursive: true, force: true });
}

/** SC17：跳过 contracted 的标准档不得被索要契约；重档必须被索要 */
function sc17() {
  const root = tmpProject('contract-optional');
  const cfg = makeConfig(root, { build: { run: 'true', negative_control: 'false' } });

  // 标准档：draft → implementing（跳过 contracted）
  writeState(root, '2026-01-01-s', 'implementing');
  makeSpec(root, '2026-01-01-s', 'standard');
  write(root, '.devflow/items/2026-01-01-s/TASKS.md', '# TASKS\n\n## 任务\n\n| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |\n|---|---|---|---|---|---|---|---|---|\n| T-1 | r | 前端 | src/ | 无 | 待开始 | 张三 | true | AC-1 |\n');
  const std = evaluate(root, '2026-01-01-s', 'implementing', cfg);
  const stdMissing = std.results.find((r) => r.gate === 'G1')?.evidence?.missing || [];
  const stdOk = !stdMissing.includes('CONTRACT.md');

  // 重档：同样位置必须被索要
  writeState(root, '2026-01-01-h', 'implementing');
  makeSpec(root, '2026-01-01-h', 'heavy');
  write(root, '.devflow/items/2026-01-01-h/TASKS.md', '# TASKS\n\n## 任务\n\n| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |\n|---|---|---|---|---|---|---|---|---|\n| T-1 | r | 前端 | src/ | 无 | 待开始 | 张三 | true | AC-1 |\n');
  const heavy = evaluate(root, '2026-01-01-h', 'implementing', cfg);
  const heavyMissing = heavy.results.find((r) => r.gate === 'G1')?.evidence?.missing || [];
  const heavyOk = heavyMissing.includes('CONTRACT.md');

  record('SC17', '跳过契约状态的标准档不得被索要契约（重档必须）',
    '标准档 missing 不含 CONTRACT.md；重档 missing 含 CONTRACT.md',
    `standard=${JSON.stringify(stdMissing)} heavy=${JSON.stringify(heavyMissing)}`, stdOk && heavyOk);
  rmSync(root, { recursive: true, force: true });
}

/** SC18：命令成功但没有输出 ⇒ 证据合法，不得被 G2 误判为缺证据 */
function sc18() {
  const root = tmpProject('silent-success');
  const itemId = '2026-01-01-ss';
  const cfg = makeConfig(root, { build: { run: 'true', negative_control: 'false' } });
  writeState(root, itemId, 'tested');
  makeSpec(root, itemId, 'standard');
  write(root, `.devflow/items/${itemId}/STATUS.json`, JSON.stringify({
    item: itemId, state: 'tested',
    lastRun: { at: new Date().toISOString(), source: 'selfcheck', records: [
      { gate: 'build', project: 'fixture', command: './scripts/build.sh', exitCode: 0, outputTail: '', startedAt: new Date().toISOString(), durationMs: 5, verdict: 'pass' },
    ] },
  }, null, 2));
  const info = evaluate(root, itemId, 'tested', cfg);
  const g2 = info.results.find((r) => r.gate === 'G2');
  record('SC18', '静默成功不得被误判为缺证据', 'G2=pass（outputTail 为空字符串是合法证据）',
    `G2=${g2?.verdict} notes=${JSON.stringify(g2?.notes || [])}`, g2?.verdict === 'pass');
  rmSync(root, { recursive: true, force: true });
}

/** SC19：确认记录在 verified 之前只是提示，不得阻断；到 verified 必须硬约束 */
function sc19() {
  const root = tmpProject('approval-timing');
  const cfg = makeConfig(root, { build: { run: 'true', negative_control: 'false' } });
  // 标准档，SPEC 有 AC，但 APPROVALS 全是占位
  writeState(root, '2026-01-01-a', 'implementing');
  makeSpec(root, '2026-01-01-a', 'standard');
  write(root, '.devflow/items/2026-01-01-a/TASKS.md', '# TASKS\n\n## 任务\n\n| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |\n|---|---|---|---|---|---|---|---|---|\n| T-1 | r | 前端 | src/ | 无 | 待开始 | 张三 | true | AC-1 |\n');
  write(root, '.devflow/items/2026-01-01-a/APPROVALS.md', '# 确认记录\n\n## 确认记录\n\n| 确认点 | 确认人 | 时间 | 结论 |\n|---|---|---|---|\n| 需求与判据 | （姓名） | （ISO 时间） | 通过 / 驳回 |\n');
  const early = evaluate(root, '2026-01-01-a', 'implementing', cfg);
  const earlyG1b = early.results.find((r) => r.gate === 'G1b');
  const earlyBlocking = early.summary.blocking;

  // 到 verified：必须硬约束
  write(root, '.devflow/items/2026-01-01-a/verification.md', '# 验证记录\n\n## 逐条对照\n\n| AC | 结论 | 证据 |\n|---|---|---|\n| AC-1 | 已实现 | src/x.java:12 |\n\n## 结论\n\n- 总体结论：已实现\n\n## 证据\n\n- 见上\n');
  const late = evaluate(root, '2026-01-01-a', 'verified', cfg);
  const lateG1b = late.results.find((r) => r.gate === 'G1b');
  record('SC19', '确认记录：verified 前提示、verified 起硬约束',
    'implementing 时 G1b=unverified 且不阻断；verified 时 G1b=blocked',
    `early=${earlyG1b?.verdict}/blocking=${earlyBlocking} late=${lateG1b?.verdict}`,
    earlyG1b?.verdict === 'unverified' && earlyBlocking === false && lateG1b?.verdict === 'blocked');
  rmSync(root, { recursive: true, force: true });
}

/** SC20：四个适配器的 count_regex 必须能抓到各自声明的样本输出 */
function sc20() {
  const adapters = loadAdapters(KIT_ROOT);
  const problems = auditAdapterRegex(adapters);
  record('SC20', '适配器正则自检（防"配了却抓不到"）',
    'auditAdapterRegex 返回空数组，且至少覆盖四个栈',
    problems.length ? problems.join('；') : `${Object.keys(adapters).length} 个栈全部通过`,
    problems.length === 0 && Object.keys(adapters).length >= 4);
}

/** SC21：检测与占位替换 —— init --stack 必须把占位脚本换成该栈真实模板 */
function sc21() {
  const root = tmpProject('adapter-apply');
  const adapters = loadAdapters(KIT_ROOT);
  write(root, 'pom.xml', '<project/>');
  const detected = detectAdapters(root, adapters);
  const detectOk = detected.length > 0 && detected[0].id === 'java-maven';
  // 先造一个占位脚本，验证 replacePlaceholders 只替换带哨兵的
  write(root, 'scripts/test.sh', '#!/usr/bin/env bash\n# devflow:placeholder\nexit 1\n', 0o755);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\n# 用户自己的脚本\nexit 0\n', 0o755);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'x', kit: '*' }, profile: 'team', gates: {
    build: { run: './scripts/build.sh', source: 'default' },
    test: { run: './scripts/test.sh', count_regex: 'Tests run: (\\d+)', require_min_tests: 1, source: 'default' },
  } }, null, 2));
  const r = applyAdapter({ projectRoot: root, adapters, id: 'java-maven', demo: true, replacePlaceholders: true });
  const testReplaced = (r.scripts.replaced || []).includes('scripts/test.sh');
  const buildKept = (r.scripts.skipped || []).some((x) => x.includes('build.sh'));
  const cfg = JSON.parse(readFileSync(path.join(root, 'devflow.json'), 'utf8'));
  const regexApplied = cfg.gates.test.count_regex === adapters['java-maven'].test.count_regex;
  const userScriptIntact = readFileSync(path.join(root, 'scripts/build.sh'), 'utf8').includes('用户自己的脚本');
  record('SC21', '适配器只替换占位脚本、只替换默认门禁',
    'test.sh 被替换、build.sh 保留、门禁正则来自适配器',
    `detect=${detectOk} replaced=${testReplaced} kept=${buildKept} regex=${regexApplied} userIntact=${userScriptIntact}`,
    detectOk && testReplaced && buildKept && regexApplied && userScriptIntact);
  rmSync(root, { recursive: true, force: true });
}

/** SC22：适配器 demo 必须自洽 —— 门禁脚本与负向对照都来自适配器，不得残留占位哨兵 */
function sc22() {
  const root = tmpProject('adapter-demo');
  const adapters = loadAdapters(KIT_ROOT);
  write(root, 'pom.xml', '<project/>');
  mkdirSync(path.join(root, 'src/main/java'), { recursive: true });
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'x', kit: '*' }, profile: 'team', gates: {} }, null, 2));
  applyAdapter({ projectRoot: root, adapters, id: 'java-maven', demo: true, replacePlaceholders: true });
  const cfg = JSON.parse(readFileSync(path.join(root, 'devflow.json'), 'utf8'));
  const { records } = runProjectGates(cfg, root);
  const test = records.find((r) => r.gate === 'test');
  const build = records.find((r) => r.gate === 'build');
  // 占位哨兵不得残留（否则说明 demo 只替换了一部分，留下"请保持失败"的模板脚本）
  let sentinelLeft = [];
  for (const f of ['scripts/build.sh', 'scripts/test.sh', 'scripts/build-should-fail.sh', 'scripts/test-should-fail.sh']) {
    try {
      if (readFileSync(path.join(root, f), 'utf8').includes('devflow:placeholder')) sentinelLeft.push(f);
    } catch { sentinelLeft.push(`${f}(缺失)`); }
  }
  record('SC22', '适配器 demo 自洽（脚本与负向对照均来自适配器，无占位残留）',
    'test 抓到 count=12、build 通过、四个脚本均无 devflow:placeholder',
    `test=${test?.exitCode}/count=${test?.testCount} build=${build?.exitCode} 残留=${sentinelLeft.join(',') || '无'}`,
    test?.testCount === 12 && test?.exitCode === 0 && build?.exitCode === 0 && sentinelLeft.length === 0);
  rmSync(root, { recursive: true, force: true });
}

/** SC23：适配器检测必须严格（不看祖先标记）；无标记时不得硬套适配器 */
function sc23() {
  const parent = tmpProject('detect-strict');
  // 故意在父目录放一个 package.json（模拟临时目录继承上层项目的标记）
  write(parent, 'package.json', '{"name":"parent"}');
  const child = path.join(parent, 'nested', 'proj');
  mkdirSync(child, { recursive: true });
  const adapters = loadAdapters(KIT_ROOT);
  const strictHit = detectAdapters(child, adapters, { strict: true });
  const looseHit = detectAdapters(child, adapters, { strict: false });
  const strictEmpty = strictHit.length === 0;
  const looseFound = looseHit.some((h) => h.id === 'node-jest' && h.foundIn === parent);
  // 同时在 child 放一个真实标记，必须被严格模式识别
  write(child, 'go.mod', 'module example.com/x\n');
  const afterMarker = detectAdapters(child, adapters, { strict: true });
  record('SC23', '适配器检测严格（不看祖先标记，但本项目标记能识别）',
    'strict 下父目录标记不可见，放 go.mod 后识别为 go-test',
    `strictEmpty=${strictEmpty} looseFound=${looseFound} after=${afterMarker.map((h) => h.id).join(',')}`,
    strictEmpty && looseFound && afterMarker.length > 0 && afterMarker[0].id === 'go-test');
  rmSync(parent, { recursive: true, force: true });
}

/** SC24：所有适配器的脚本模板（含真实模板）必须通过 bash 语法校验 */
function sc24() {
  const adapters = loadAdapters(KIT_ROOT);
  const problems = [];
  const root = tmpProject('adapter-lint');
  for (const [id, def] of Object.entries(adapters)) {
    const sets = [['real', def.scripts || {}], ['demo', def.demo?.scripts || {}]];
    for (const [kind, scripts] of sets) {
      for (const [rel, content] of Object.entries(scripts)) {
        const file = path.join(root, `${id}-${kind}-${path.basename(rel)}`);
        writeFileSync(file, content);
        try {
          execFileSync('bash', ['-n', file], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (error) {
          problems.push(`${id}/${kind}/${rel}: ${String(error.stderr || error.message).split('\n')[0]}`);
        }
      }
    }
  }
  record('SC24', '适配器脚本模板通过 bash 语法校验（真实模板也要校验）',
    'bash -n 对全部真实与 demo 脚本均无报错',
    problems.length ? problems.join('；') : `${Object.keys(adapters).length} 个栈 × 真实+demo 全部通过`,
    problems.length === 0);
  rmSync(root, { recursive: true, force: true });
}

/** SC25：CLI 层必须硬校验非法参数（静默接受会让采用者在错的基础上继续） */
function sc25() {
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  const run = (args, cwd) => {
    try {
      execFileSync(process.execPath, [cli, ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return 0;
    } catch (error) {
      return typeof error.status === 'number' ? error.status : 1;
    }
  };
  const root = tmpProject('cli-validation');
  write(root, 'pom.xml', '<project/>');
  const badStack = run(['init', '--name', 'x', '--stack', 'node'], root);
  const goodStack = run(['init', '--name', 'x', '--stack', 'java-maven'], root);
  const badSurface = run(['new', '--slug', 'a', '--tier', 'light', '--surface', 'bogus'], root);
  const badProfile = run(['init', '--name', 'y', '--stack', 'java-maven', '--profile', 'nope'], root);
  const badTier = run(['new', '--slug', 'b', '--tier', 'nope'], root);
  const ok = badStack === 2 && goodStack === 0 && badSurface === 2 && badProfile === 2 && badTier === 2;
  record('SC25', 'CLI 硬校验非法参数（stack/surface/profile/tier 均须退出码 2）',
    '非法值=2，合法值=0',
    `stack=${badStack} goodStack=${goodStack} surface=${badSurface} profile=${badProfile} tier=${badTier}`,
    ok);
  rmSync(root, { recursive: true, force: true });
}

/** SC26：init 生成的配置必须能被 doctor 判为"可以开工"（新采用者第一天可开工） */
function sc26() {
  const root = tmpProject('init-healthy');
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  write(root, 'pom.xml', '<project/>');
  mkdirSync(path.join(root, 'src/main/java'), { recursive: true });
  // --demo：自包含脚本，避免依赖真的装 Maven
  execFileSync(process.execPath, [cli, 'init', '--name', 'x', '--stack', 'java-maven', '--demo'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let exitCode = 0;
  let log = '';
  try {
    log = execFileSync(process.execPath, [cli, 'doctor'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    exitCode = typeof error.status === 'number' ? error.status : 1;
    log = String(error.stdout || '');
  }
  const healthy = exitCode === 0 && /结论：门禁配置健康|结论：门禁可用/.test(log);
  record('SC26', 'init（带适配器）后 doctor 必须判为可以开工',
    'doctor 退出码 0 且结论为健康',
    `exit=${exitCode} 结论行=${(log.match(/结论：[^\n]*/) || ['(无)'])[0]}`,
    healthy);
  rmSync(root, { recursive: true, force: true });
}

/** SC27：模板按档位渲染 —— 轻/标/重 的确认点行数为 1/2/3，且渲染后无残留指令 */
function sc27() {
  const counts = {};
  const leftover = {};
  for (const tier of ['light', 'standard', 'heavy']) {
    const out = renderTemplate(KIT_ROOT, 'approvals', {
      item: 'i', title: 't', tier, tierName: tier, owner: 'o', repos: ['r'], changeSurface: ['internal'], createdAt: '2026-01-01',
    });
    counts[tier] = (out.match(/^\| .*（姓名）/gm) || []).length;
    leftover[tier] = /\{\{/.test(out);
  }
  // 微档：确认点为 0，CLI 根本不生成 APPROVALS.md —— 这里断言渲染器的极端情形（零行）
  const microOut = (() => {
    try {
      const raw = readFileSync(path.join(KIT_ROOT, 'templates', 'APPROVALS.md'), 'utf8');
      return raw.replace(/\{\{#TIER:([a-z,\- ]+)\}\}([\s\S]*?)\{\{\/TIER\}\}/g,
        (_m, list, body) => (String(list).split(',').map((x) => x.trim()).includes('micro') ? body : ''));
    } catch { return ''; }
  })();
  const microRows = (microOut.match(/^\| .*（姓名）/gm) || []).length;
  const expected = { light: 1, standard: 2, heavy: 3 };
  const ok = Object.entries(expected).every(([k, v]) => counts[k] === v) && Object.values(leftover).every((v) => v === false);
  record('SC27', '模板按档位渲染（确认点 1/2/3 行，微档 0 行，无残留指令）',
    'light=1 standard=2 heavy=3，微档模板不含确认行，渲染后无 {{ }} 残留',
    `counts=${JSON.stringify(counts)} micro=${microRows} 残留=${JSON.stringify(leftover)}`, ok && microRows === 0);
}

/** SC28：适配器的门禁必须走项目内的包装脚本，且脚本模板必须存在（用户可定制、可排障） */
function sc28() {
  const adapters = loadAdapters(KIT_ROOT);
  const problems = [];
  for (const [id, def] of Object.entries(adapters)) {
    const scripts = def.scripts || {};
    for (const [gateName, gate] of [['build', def.build], ['test', def.test]]) {
      if (!gate || !gate.run) continue;
      const m = /^\.\/(scripts\/[\w.-]+\.sh)$/.exec(gate.run);
      if (!m) {
        problems.push(`${id}: ${gateName}.run 不是项目内包装脚本（${gate.run}）—— 应形如 ./scripts/xxx.sh，否则用户无法定制`);
        continue;
      }
      const rel = m[1].replace(/^scripts\//, '');
      if (!scripts[rel] && !scripts[`scripts/${rel}`]) problems.push(`${id}: ${gateName}.run 指向 ${m[1]}，但适配器没提供该脚本模板`);
    }
    for (const nc of [def.build?.negative_control, def.test?.negative_control]) {
      if (!nc) continue;
      const m = /^\.\/(scripts\/[\w.-]+\.sh)$/.exec(nc);
      if (!m) { problems.push(`${id}: negative_control 不是项目内脚本（${nc}）`); continue; }
      const rel = m[1].replace(/^scripts\//, '');
      if (!scripts[rel] && !scripts[`scripts/${rel}`]) problems.push(`${id}: negative_control 指向 ${m[1]}，但没有该脚本模板`);
    }
  }
  record('SC28', '适配器门禁走项目内包装脚本（run/negative_control 均有脚本模板）',
    '四个栈的 run 与 negative_control 都指向存在的 scripts/*.sh',
    problems.length ? problems.join('；') : `${Object.keys(adapters).length} 个栈全部合规`,
    problems.length === 0);
}

/** SC29：占位内容必须在 verified 起被拦下（F3：占位曾能一路推进到 released） */
function sc29() {
  const root = tmpProject('placeholder-content');
  const itemId = '2026-01-01-ph';
  const cfg = makeConfig(root, { build: { run: 'true', negative_control: 'false' } });
  writeState(root, itemId, 'verified');
  // SPEC 结构与章节都齐全，但表格单元全是模板占位
  write(root, `.devflow/items/${itemId}/SPEC.md`, [
    '# SPEC', '', '## 身份', '',
    '| 项 | 值 |', '|---|---|', '| item | i |', '| 档位 | 轻（light） |',
    '| 负责人 | （姓名） |', '| 目标仓 | (本仓) |', '| 变更面 | ui |', '',
    '## 验收标准', '', '| AC | 判据 | 判据类型 | 责任方 |', '|---|---|---|---|',
    '| AC-1 | （一次测试 / 一次可观测探测：命令 + 期望结果） | 命令 | 实现者 |', '',
    '## 不做什么', '', '- 无', '',
  ].join('\n'));
  const info = evaluate(root, itemId, 'verified', cfg);
  const g1b = info.results.find((r) => r.gate === 'G1b');
  const caught = (g1b?.notes || []).some((n) => n.includes('占位内容不算证据'));
  // draft 阶段必须是提示而非阻断（不能刚建变更就卡住）
  const early = evaluate(root, itemId, 'draft', cfg);
  const earlyBlocking = early.summary.blocking;
  record('SC29', '占位内容在 verified 起被拦下（draft 阶段不误伤）',
    'verified 时 G1b 阻断且点名占位；draft 时不阻断',
    `verified=${g1b?.verdict} caught=${caught} draftBlocking=${earlyBlocking}`,
    g1b?.verdict === 'blocked' && caught && earlyBlocking === false);
  rmSync(root, { recursive: true, force: true });
}

/** SC30：adapters --apply --force-scripts 能覆盖"适配器自己生成的"脚本，但不动用户脚本 */
function sc30() {
  const root = tmpProject('force-scripts');
  const adapters = loadAdapters(KIT_ROOT);
  write(root, 'go.mod', 'module x\n');
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'x', kit: '*' }, profile: 'team', gates: {} }, null, 2));
  // 先落"真实模板"（非 demo）
  applyAdapter({ projectRoot: root, adapters, id: 'go-test', replacePlaceholders: true });
  const realTest = readFileSync(path.join(root, 'scripts/test.sh'), 'utf8');
  const isReal = realTest.includes('go test');
  // 再切到 demo：必须靠 --force-scripts
  const without = applyAdapter({ projectRoot: root, adapters, id: 'go-test', demo: true, replacePlaceholders: true });
  const stillReal = readFileSync(path.join(root, 'scripts/test.sh'), 'utf8').includes('go test');
  const withForce = applyAdapter({ projectRoot: root, adapters, id: 'go-test', demo: true, replacePlaceholders: true, forceScripts: true });
  const nowDemo = readFileSync(path.join(root, 'scripts/test.sh'), 'utf8').includes(':demo');
  // 用户自己的脚本永不被覆盖
  write(root, 'scripts/mine.sh', '#!/usr/bin/env bash\necho mine\n', 0o755);
  const userFile = readFileSync(path.join(root, 'scripts/mine.sh'), 'utf8');
  record('SC30', '--force-scripts 只覆盖适配器生成的脚本（用户脚本不动）',
    '不加时保留真实模板；加了切到 demo；用户脚本内容不变',
    `real=${isReal} 不加force仍真实=${stillReal} 加force后demo=${nowDemo} skipped=${without.scripts.skipped.length} user=${userFile.includes('mine')}`,
    isReal && stillReal && nowDemo && without.scripts.replaced.length === 0 && userFile.includes('mine'));
  rmSync(root, { recursive: true, force: true });
}

/** SC31：多测试类输出必须累加计数（试点真实缺陷：15 个测试曾被记成 4 个） */
function sc31() {
  const root = tmpProject('multi-class-count');
  const multi = [
    '[INFO] Tests run: 4, Failures: 0, Errors: 0, Skipped: 0 -- in ATest',
    '[INFO] Tests run: 3, Failures: 0, Errors: 0, Skipped: 0 -- in BTest',
    '[INFO] Tests run: 8, Failures: 0, Errors: 0, Skipped: 0 -- in CTest',
    '[INFO] Tests run: 15, Failures: 0, Errors: 0, Skipped: 0',   // Maven 的汇总行
  ].join('\n');
  write(root, 'scripts/test.sh', `#!/usr/bin/env bash\ncat <<'OUT'\n${multi}\nOUT\n`, 0o755);
  write(root, 'scripts/test-should-fail.sh', '#!/usr/bin/env bash\nexit 1\n', 0o755);
  const cfg = makeConfig(root, {
    test: { run: './scripts/test.sh', count_regex: 'Tests run: (\\d+),\\s*Failures', require_min_tests: 1, negative_control: './scripts/test-should-fail.sh' },
  });
  const { records } = runProjectGates(cfg, root);
  const rec = records.find((r) => r.gate === 'test');
  // 逐类 4+3+8=15，加上 Maven 自己的汇总行 15 ⇒ 累加为 30；关键是**不是 4**
  const summed = rec?.testCount;
  record('SC31', '多测试类输出必须累加计数（不得只取第一行）',
    '累加所有匹配（本例 4+3+8+15=30），且不再出现"只取第一行=4"',
    `count=${summed} 匹配行数=${rec?.countMatches}`,
    summed === 30 && rec?.countMatches === 4);
  rmSync(root, { recursive: true, force: true });
}

/** SC32：声称"独立复核"却无留痕必须被拦（试点里真实发生过的顺序倒置） */
function sc32() {
  const root = tmpProject('independence-claim');
  const itemId = '2026-01-01-ind';
  const cfg = makeConfig(root, { build: { run: 'true', negative_control: 'false' } });
  writeState(root, itemId, 'verified');
  makeSpec(root, itemId, 'light');
  const base = (verText) => {
    write(root, `.devflow/items/${itemId}/verification.md`, verText);
    const info = evaluate(root, itemId, 'verified', cfg);
    return info.results.find((r) => r.gate === 'G1b');
  };
  // ① 声称独立复核、但没有任何留痕 ⇒ 必须被拦
  const claimed = base([
    '# 验证记录', '', '## 逐条对照', '',
    '| AC | 结论 | 证据 |', '|---|---|---|',
    '| AC-1 | 已实现 | src/main/java/x.java:12 |', '',
    '## 结论', '', '- 总体结论：已实现', '', '## 证据', '',
    '> 本记录由独立子代理（全新上下文）执行只读复核。',
  ].join('\n'));
  const blockedClaim = (claimed?.notes || []).some((n) => n.includes('没有任何复核留痕'));
  // ② 有复核方 + 时间戳 + 实测 ⇒ 必须放行
  const evidenced = base([
    '# 验证记录', '', '## 逐条对照', '',
    '| AC | 结论 | 证据 |', '|---|---|---|',
    '| AC-1 | 已实现 | src/main/java/x.java:12 |', '',
    '## 结论', '', '- 总体结论：已实现', '', '## 证据', '',
    '> 复核方：独立子代理 55b6bf22（2026-10-13 15:20）实测：`./mvnw test` 退出码 0，Tests run: 17',
  ].join('\n'));
  const passedEvidence = evidenced?.verdict === 'pass' || !(evidenced?.notes || []).some((n) => n.includes('没有任何复核留痕'));
  record('SC32', '声称独立复核却无留痕必须被拦（有留痕则放行）',
    '无留痕 ⇒ G1b 点名；有复核方+时间+实测 ⇒ 不因该条被拦',
    `无留痕blocked=${blockedClaim} 有留痕通过=${passedEvidence}`,
    blockedClaim && passedEvidence);
  rmSync(root, { recursive: true, force: true });
}

/** SC33：登记基线豁免的存量仓，doctor 必须判"可开工但削弱"，不得阻断（也不得判为通过） */
function sc33() {
  const root = tmpProject('exempt-doctor');
  const itemId = '2026-01-01-x';
  // 测试命令成功退出但没有任何测试在跑（某存量库的真实形态：测试命令成功退出却一个用例都没跑）
  write(root, 'scripts/test.sh', '#!/usr/bin/env bash\necho "[INFO] No tests to run."\necho "[INFO] BUILD SUCCESS"\n', 0o755);
  write(root, 'scripts/test-should-fail.sh', '#!/usr/bin/env bash\nexit 1\n', 0o755);
  const base = {
    test: { run: './scripts/test.sh', count_regex: 'Tests run: (\\d+),\\s*Failures', require_min_tests: 1, negative_control: './scripts/test-should-fail.sh' },
  };
  const strict = makeConfig(root, base);
  const strictDiag = diagnose({ projectRoot: root, config: strict, marker: 'devflow.json + .devflow/', cwd: root, kitRoot: KIT_ROOT });
  const strictBlocked = strictDiag.verdict.trustworthy === false;

  // 登记豁免后：应变为"可开工但削弱"，且不得被判为"健康无提示"
  const exemptCfg = JSON.parse(JSON.stringify(base));
  exemptCfg.test.baseline_exempt = { reason: '历史无测试基座', clear_when: 'test_count > 0' };
  const exemptDiag = diagnose({ projectRoot: root, config: { devflow: { project: 'x', kit: '*' }, profile: 'legacy', gates: exemptCfg }, marker: 'devflow.json + .devflow/', cwd: root, kitRoot: KIT_ROOT });
  const exemptOk = exemptDiag.verdict.trustworthy === true;
  const shownAsWeak = exemptDiag.findings.some((f) => f.severity === 'weak' && /豁免|没有任何测试在跑/.test(f.title));
  const notShownAsPass = !exemptDiag.findings.some((f) => f.severity === 'info' && /豁免/.test(f.title));
  record('SC33', '登记豁免的存量仓：可开工但显示为削弱（不得阻断/不得显示为通过）',
    '未登记 ⇒ 不可信；登记后 ⇒ 可信且发现为 weak',
    `strictTrustworthy=${strictDiag.verdict.trustworthy} exemptTrustworthy=${exemptDiag.verdict.trustworthy} weak=${shownAsWeak} notPass=${notShownAsPass}`,
    strictBlocked && exemptOk && shownAsWeak && notShownAsPass);
  rmSync(root, { recursive: true, force: true });
}

/** SC34：声称有既有债务却 exit 0 的门禁，必须显式登记 baseline_debt（否则判阻断） */
function sc34() {
  const root = tmpProject('debt-wrapper');
  // 一个"永远成功"的债务包装脚本（这正是我上轮犯的错）
  write(root, 'scripts/lint.sh', '#!/usr/bin/env bash\n# devflow:existing-debt\n# 既有债务\nexit 0\n', 0o755);
  const baseGates = { lint: { run: './scripts/lint.sh' } };
  const cfgNoDecl = { devflow: { project: 'x', kit: '*' }, profile: 'legacy', gates: JSON.parse(JSON.stringify(baseGates)) };
  write(root, 'devflow.json', JSON.stringify(cfgNoDecl, null, 2));
  const d1 = diagnose({ projectRoot: root, config: cfgNoDecl, marker: 'devflow.json + .devflow/', cwd: root, kitRoot: KIT_ROOT });
  const blocked = d1.findings.some((f) => f.severity === 'block' && /baseline_debt/.test(f.evidence + f.fix));

  // 显式登记后：应降级为 weak（可开工但不计为通过）
  const cfgDecl = { devflow: { project: 'x', kit: '*' }, profile: 'legacy',
    gates: { lint: { run: './scripts/lint.sh', baseline_debt: { reason: '存量 lint 债务', clear_when: 'eslint 退出码 0' } } } };
  write(root, 'devflow.json', JSON.stringify(cfgDecl, null, 2));
  const d2 = diagnose({ projectRoot: root, config: cfgDecl, marker: 'devflow.json + .devflow/', cwd: root, kitRoot: KIT_ROOT });
  const weakened = d2.findings.some((f) => f.severity === 'weak' && /债务包装/.test(f.title));

  record('SC34', '债务包装门禁必须显式登记 baseline_debt（未登记=阻断，登记=削弱）',
    '未登记 ⇒ block；登记 ⇒ weak',
    `blocked=${blocked} weakened=${weakened}`, blocked && weakened);
  rmSync(root, { recursive: true, force: true });
}

/** SC10（附加）：未知状态不得被当作"无需求"放行 */
function sc10() {
  const root = tmpProject('unknownstate');
  const itemId = '2026-01-01-u';
  makeConfig(root, { build: { run: 'true' } });
  writeState(root, itemId, 'not-a-state');
  const info = evaluate(root, itemId, 'not-a-state', { devflow: {}, profile: 'team', gates: { build: {} } });
  const passCount = info.results.filter((r) => r.verdict === 'pass').length;
  record('SC10', '未知状态不得放行任何门禁', '结果中不得出现 pass', `pass 计数=${passCount}`, passCount === 0, info.results.map((r) => `${r.gate}:${r.verdict}`));
  rmSync(root, { recursive: true, force: true });
}

export function runSelfcheck() {
  cases.length = 0;
  sc1and2();
  sc3();
  sc4();
  sc5();
  sc6();
  sc7();
  sc8();
  sc9();
  sc10();
  sc11();
  sc12();
  sc13();
  sc14();
  sc15();
  sc16();
  sc17();
  sc18();
  sc19();
  sc20();
  sc21();
  sc22();
  sc23();
  sc24();
  sc25();
  sc26();
  sc27();
  sc28();
  sc29();
  sc30();
  sc31();
  sc32();
  sc33();
/** SC35：豁免的 allowed_scope 必须被真正校验（曾只写在文档里、引擎不检查） */
function sc35() {
  const root = tmpProject('allowed-scope');
  const itemId = '2026-01-01-scope';
  write(root, 'scripts/test.sh', '#!/usr/bin/env bash\necho "Tests run: 0, Failures: 0"\n', 0o755);
  write(root, 'scripts/test-should-fail.sh', '#!/usr/bin/env bash\nexit 1\n', 0o755);
  makeSpec(root, itemId, 'light');
  const gates = {
    test: { run: './scripts/test.sh', count_regex: 'Tests run: (\\d+),', require_min_tests: 1,
      negative_control: './scripts/test-should-fail.sh',
      baseline_exempt: { reason: '无测试基座', clear_when: 'test_count > 0',
        allowed_scope: ['ui-tweak', 'copy-change'] } },
    build: { run: 'true', negative_control: 'false' },
  };
  const cfg = { devflow: { project: 'x', kit: '*' }, profile: 'legacy', gates };
  const before = evaluate(root, itemId, 'tested', cfg);
  const g6a = before.results.find((r) => r.gate === 'G6');
  const flagged = /allowed_scope/.test(JSON.stringify(g6a?.notes || []));

  gates.test.baseline_exempt.allowed_scope = ['internal', 'ui-tweak'];
  const after = evaluate(root, itemId, 'tested', cfg);
  const g6b = after.results.find((r) => r.gate === 'G6');
  const stillFlagged = /allowed_scope/.test(JSON.stringify(g6b?.notes || []));

  record('SC35', '豁免的 allowed_scope 会被 G6 真正校验（超范围要拦）',
    'internal 不在 allowed_scope ⇒ G6 点名；纳入后 ⇒ 不再点名',
    `超范围点名=${flagged} 纳入后点名=${stillFlagged}`,
    flagged && !stillFlagged);
  rmSync(root, { recursive: true, force: true });
}

  sc34();
/** SC36：测试计数为 10/20/30/100 时不得被误判成"没有测试在跑"（D3 正则曾命中 "30 passed" 的子串） */
function sc36() {
  const root = tmpProject('count-zero-substring');
  write(root, 'scripts/test-should-fail.sh', '#!/usr/bin/env bash\nexit 1\n', 0o755);
  const cases = [
    { out: 'Tests  30 passed (30)', wantBlock: false },
    { out: 'Tests  100 passed (100)', wantBlock: false },
    { out: 'Tests  10 passed (10)', wantBlock: false },
    { out: 'Tests  0 passed (0)', wantBlock: true },
    { out: 'No tests found, exiting with code 0', wantBlock: true },
  ];
  const results = cases.map((c) => {
    write(root, 'scripts/test.sh', `#!/usr/bin/env bash\necho "${c.out}"\n`, 0o755);
    const cfg = {
      devflow: { project: 'x', kit: '*' }, profile: 'team',
      gates: { test: { run: './scripts/test.sh', count_regex: 'Tests\\s+(\\d+)\\s+passed',
        require_min_tests: 1, negative_control: './scripts/test-should-fail.sh' } },
    };
    const d = diagnose({ projectRoot: root, config: cfg, marker: 'devflow.json + .devflow/', cwd: root, kitRoot: KIT_ROOT });
    const blocked = d.findings.some((f) => f.id === 'D3' && f.severity === 'block');
    return { out: c.out, blocked, want: c.wantBlock, ok: blocked === c.wantBlock };
  });
  const allOk = results.every((r) => r.ok);
  record('SC36', '测试计数 10/20/30/100 不得被误判为"没有测试在跑"',
    '30/100/10 passed ⇒ 不阻断；0 passed / No tests found ⇒ 阻断',
    results.map((r) => `${r.out.slice(0, 18)}→blocked=${r.blocked}`).join('; '),
    allOk);
  rmSync(root, { recursive: true, force: true });
}

  sc35();
/** SC37：跨仓契约扫描器（Spring 注解解析 + 路径匹配 + 假阳性防护） */
function sc37() {
  // ① Spring 注解形态：无参注解、value = 形式、类级 + 方法级跨行、@RequestMapping(method=)
  const ctrl = [
    '@RestController',
    '@RequestMapping("/api/marketing/coupon")',
    'public class CouponController {',
    '  @GetMapping("/{couponId}") public Object a() { return null; }',
    '  @PostMapping',
    '  public Object b() { return null; }',
    '  @PostMapping(value = "/receive")',
    '  public Object c() { return null; }',
    '  @DeleteMapping("/{id}")',
    '  public Object d() { return null; }',
    '  @RequestMapping(method = RequestMethod.PUT, value = "/{id}")',
    '  public Object e() { return null; }',
    '}',
    '',
    '// 注释里的假注解不得被采信： @PostMapping("/this/should/be/ignored")',
    '/* @PostMapping("/also/ignored") */',
  ].join('\n');
  const eps = extractEndpoints(ctrl, 'CouponController.java');
  const got = new Set(eps.map((e) => `${e.verb} ${e.path}`));
  const want = [
    'GET /api/marketing/coupon/{couponId}',
    'POST /api/marketing/coupon',
    'POST /api/marketing/coupon/receive',
    'DELETE /api/marketing/coupon/{id}',
    'PUT /api/marketing/coupon/{id}',
  ];
  const missing = want.filter((w) => !got.has(w));
  const polluted = [...got].filter((g) => /ignored|should/.test(g));

  // ② 路径匹配：后端 {var} 是通配符，但「字面量+变量」不是；段数必须一致
  const m1 = pathMatches('/api/fulfillment/schedule-slots/technician/me', '/api/fulfillment/schedule-slots/technician/{technicianId}');
  // 字面量段 vs 后端变量段 ⇒ 匹配（后端真有 /coupon/{id}，use 是它的合法取值）
  const m2 = pathMatches('/api/marketing/coupon/use', '/api/marketing/coupon/{id}');
  // 前缀+变量（tree${x}）vs 后端纯变量 ⇒ **不匹配**（tree 列表 ≠ 按 id 取单条）
  const m3 = pathMatches('/api/supply/categories/tree${x}', '/api/supply/categories/{id}');
  const m4 = pathMatches('/api/trade/orders/${orderNo}/cancel', '/api/trade/orders/{orderNo}/cancel');
  // 前端注入变量 vs 后端字面量 ⇒ 不匹配（字面量是具体资源名）
  const m5 = pathMatches('/api/a/x/${y}', '/api/a/{id}/z');
  // 已知不可判定：纯字面量 tree vs {id} 在字符串上匹配，语义不同 ⇒ 属工具局限（输出中已明示），
  // 这里只断言它**不报错**，不断言真假，避免把局限伪装成保证。
  const m6 = typeof pathMatches('/api/supply/categories/tree', '/api/supply/categories/{id}') === 'boolean';

  // ③ 归一化
  const n1 = normalizePath('/api/x/${a}/y?k=1') === '/api/x/{x}/y';
  const n2 = normalizePath('/api/x/{a}/y') === '/api/x/{x}/y';

  record('SC37', '跨仓契约扫描器：注解解析准确、路径匹配不误报',
    '5 种 Spring 注解形态全部识别、注释里的假注解不被采信、通配符语义正确',
    `缺失=${missing.length} 误采信=${polluted.length} m1=${m1} m2=${m2} m3=${m3} m4=${m4} m5=${m5} 归一化=${n1 && n2}`,
    missing.length === 0 && polluted.length === 0
      && m1 === true && m2 === true && m3 === false && m4 === true && m5 === false && m6 && n1 && n2);
}

  sc36();
/** SC38：必须区分「环境受限」与「代码失败」（否则会把环境问题误报成代码坏，导致告警被忽略） */
function sc38() {
  const cases = [
    ['[ERROR] FileNotFoundException: /Users/x/.m2/repository/a/b/resolver-status.properties (Operation not permitted)', '权限'],
    ['[ERROR] Could not resolve dependencies for project x', '依赖'],
    ['sh: jest: command not found', '工具'],
    ['No module named pytest', '工具'],
    ['[ERROR] Tests run: 3, Failures: 1, Errors: 0', null],          // 代码失败 ⇒ 不得被当作环境问题
    ['[ERROR] COMPILATION ERROR : cannot find symbol', null],          // 代码失败
    ['BUILD SUCCESS', null],
  ];
  const results = cases.map(([raw, kind]) => {
    const got = detectEnvFailure(raw);
    const ok = kind === null ? got === null : Boolean(got) && got.includes(kind);
    return { ok, raw: raw.slice(0, 40), got, want: kind };
  });
  const bad = results.filter((r) => !r.ok);
  record('SC38', '区分环境受限与代码失败（环境问题不得误报为代码坏）',
    '权限/依赖/工具缺失 ⇒ 判为环境；测试失败与编译错误 ⇒ 判为代码问题',
    bad.length ? bad.map((b) => `${b.raw}=>${b.got}(期望${b.want})`).join('; ') : `全部 ${results.length} 例符合预期`,
    bad.length === 0);
}

  sc37();
/** SC39：门禁层与体检层对环境受限必须**口径一致**（否则使用者会收到两个矛盾结论） */
function sc39() {
  const root = tmpProject('env-restricted');
  // 一个"因外部依赖缺失而失败"的测试命令（Spring 上下文加载失败的真实形态）
  write(root, 'scripts/test.sh',
    '#!/usr/bin/env bash\necho "Caused by: java.lang.IllegalStateException: Connection refused: 127.0.0.1:9401/oauth2/token" >&2\n'
    + 'echo "[ERROR] Failed to load ApplicationContext" >&2\nexit 1\n', 0o755);
  write(root, 'scripts/test-should-fail.sh', '#!/usr/bin/env bash\nexit 1\n', 0o755);
  const cfg = makeConfig(root, {
    test: { run: './scripts/test.sh', count_regex: 'Tests run: (\\d+)', require_min_tests: 1,
      negative_control: './scripts/test-should-fail.sh' },
  });
  const { records, summary } = runProjectGates(cfg, root);
  const rec = records.find((r) => r.gate === 'test');

  // 对照：真正的代码失败必须仍然判 fail
  write(root, 'scripts/test.sh', '#!/usr/bin/env bash\necho "Tests run: 3, Failures: 1"\nexit 1\n', 0o755);
  const cfg2 = makeConfig(root, {
    test: { run: './scripts/test.sh', count_regex: 'Tests run: (\\d+)', require_min_tests: 1,
      negative_control: './scripts/test-should-fail.sh' },
  });
  const { records: recs2 } = runProjectGates(cfg2, root);
  const rec2 = recs2.find((r) => r.gate === 'test');

  const envOk = rec?.verdict === 'unverified' && rec?.envRestricted === true;
  const codeOk = rec2?.verdict === 'fail' && !rec2?.envRestricted;
  // 体检层同口径
  const diagSame = Boolean(detectEnvFailure('Failed to load ApplicationContext')) === true;
  record('SC39', '门禁层与体检层对环境受限口径一致（环境⇒unverified，代码⇒fail）',
    '连接被拒/上下文加载失败 ⇒ unverified；真实测试失败 ⇒ fail；两层判定一致',
    `env=${rec?.verdict}/${rec?.envRestricted} code=${rec2?.verdict}/${rec2?.envRestricted} 体检同口径=${diagSame} 汇总unverified=${summary.unverified}`,
    envOk && codeOk && diagSame);
  rmSync(root, { recursive: true, force: true });
}

  sc38();
/** SC40：提交信息规范必须可机器校验（禁止"讲故事"式提交信息） */
function sc40() {
  const good = [
    'fix(mp): 修正 base 前缀',
    'fix(mp): 修正 base 前缀\n\n- 要点一\n- 要点二',
    'test(contract): 建测试基座\n\n- 覆盖请求契约\n- 含负向对照\n- 门禁改为真实执行',
  ];
  const bad = [
    ['fix: 没有 scope', /scope/],
    ['fix(mp) 缺少冒号', /<type>/],
    ['fix(mp): 结尾带句号。', /句号/],
    ['fix(mp): 标题与正文之间没有空行\n- 要点', /空一行/],
    ['fix(mp): a\n\n- 一\n\n- 二', /空行分段/],
    ['fix(mp): a\n\n- 一\n- 二\n- 三\n- 四', /超过上限 3/],
    ['fix(mp): a\n\n' + 'x'.repeat(120), /要点过长|非要点/],
    ['fix(mp): ' + 'y'.repeat(80), /超过上限 72/],
    ['fix(mp): a\n\n- 一\n- 二\n- 三\n' + '- 四\n- 五\n- 六\n- 七\n- 八\n- 九', /总行数|超过上限/],
    ['', /为空/],
  ];
  const goodOk = good.every((m) => validateCommitMessage(m).length === 0);
  const badResults = bad.map(([m, re]) => {
    const errs = validateCommitMessage(m);
    return { m: m.slice(0, 24), ok: errs.length > 0 && errs.some((e) => re.test(e)), errs };
  });
  const badOk = badResults.every((r) => r.ok);
  // 反向对照：真实历史里那种 20 行的"讲故事"提交必须被拒
  const verbose = 'fix(a): t\n\n背景\n\n细节\n\n- 一\n- 二\n- 三\n- 四\n\n验证：ok';
  const verboseRejected = validateCommitMessage(verbose).length > 0;

  // ④ 入口守卫必须支持**符号链接**执行（git 钩子就是这种形态）。
  // 旧写法 `import.meta.url === file://argv[1]` 经符号链接时不相等 ⇒ main() 不执行 ⇒ 钩子静默返回 0。
  let hookViaSymlinkOk = false;
  let hookViaSymlinkDetail = '未执行';
  const hookTmp = mkdtempSync(path.join(os.tmpdir(), 'sc40-hook-'));
  try {
    const src = fileURLToPath(new URL('../tools/validate-commit-msg.mjs', import.meta.url));
    const link = path.join(hookTmp, 'commit-msg-link');
    try { rmSync(link, { force: true }); } catch { /* ignore */ }
    symlinkSync(src, link);
    // 必须**先**把违规信息写进文件，再执行钩子（否则钩子读不到文件 ⇒ exit 2，测的是别的东西）
    const badMsgFile = path.join(hookTmp, 'bad_msg.txt');
    writeFileSync(badMsgFile, 'fix: 没有 scope\n');
    const r = spawnSync('node', [link, badMsgFile], { encoding: 'utf8' });
    hookViaSymlinkDetail = `exit=${r.status}`;
    hookViaSymlinkOk = r.status === 1;
  } catch (e) {
    hookViaSymlinkDetail = `异常：${e.message}`;
  }
  record('SC40', '提交信息规范可机器校验（简化为规则，拒绝讲故事式长文）',
    '3 条合规样例通过；10 条违规样例各自命中对应错误；20 行长文被拒',
    `合规=${goodOk} 违规命中=${badResults.filter((r) => r.ok).length}/${bad.length} 长文被拒=${verboseRejected} 符号链接钩子=${hookViaSymlinkDetail}`,
    goodOk && badOk && verboseRejected && hookViaSymlinkOk);
  rmSync(hookTmp, { recursive: true, force: true });
}

  sc39();
/** SC41：契约扫描器必须可用于 CI（退出码语义 + --json + --flag=value 解析） */
function sc41() {
  const tool = fileURLToPath(new URL('../tools/contract-scan.mjs', import.meta.url));
  const ws = mkdtempSync(path.join(os.tmpdir(), 'sc41-'));
  // 造一个最小工作区：后端有 GET /api/ok，前端调 /api/ok（一致）与 /api/gone（漂移，可达）
  mkdirSync(path.join(ws, 'be', 'src'), { recursive: true });
  writeFileSync(path.join(ws, 'be', 'src', 'OkController.java'),
    '@RestController\n@RequestMapping("/api")\npublic class OkController {\n  @GetMapping("/ok") public Object a() { return null; }\n}\n');
  mkdirSync(path.join(ws, 'fe', 'src'), { recursive: true });
  writeFileSync(path.join(ws, 'fe', 'src', 'api.ts'),
    "import { get, post } from './x'\n"
    + "export const good = () => get('/api/ok')\n"
    + "export const bad = () => post('/api/gone')\n"
    + "export const useBad = () => bad()\n");   // 让 bad 的引用数 > 1 ⇒ 可达
  const run = (extra) => spawnSync('node', [tool, '--workspace', ws, '--backend', 'be', '--frontend', 'fe', ...extra], { encoding: 'utf8' });

  const plain = run([]);
  const flagEq = run(['--fail-on-drift', '--fail-on=none']);
  const live = run(['--fail-on-drift', '--fail-on=live']);
  const jsonRun = run(['--json', '--fail-on-drift', '--fail-on=none']);
  let jsonOk = false;
  try {
    const d = JSON.parse(jsonRun.stdout);
    jsonOk = Array.isArray(d.drift) && d.drift.length >= 1;
  } catch { jsonOk = false; }

  record('SC41', '契约扫描器可用于 CI（退出码语义、--json、--flag=value 解析）',
    '默认 0；--fail-on=none ⇒ 0；--fail-on=live ⇒ 1（有可达漂移）；--json 可解析',
    `默认=${plain.status} none=${flagEq.status} live=${live.status} json=${jsonOk}`,
    plain.status === 0 && flagEq.status === 0 && live.status === 1 && jsonOk);
  rmSync(ws, { recursive: true, force: true });
}

  sc40();
/** SC42：基础标准必须可执行，且"不可豁免项不允许被项目覆盖" */
function sc42() {
  const root = tmpProject('standards');
  write(root, 'scripts/test.sh', '#!/usr/bin/env bash\necho "Tests  5 passed (5)"\n', 0o755);
  write(root, 'scripts/test-should-fail.sh', '#!/usr/bin/env bash\nexit 1\n', 0o755);   // 空转：无失败证据
  const baseGates = {
    test: { run: './scripts/test.sh', count_regex: 'Tests\\s+(\\d+)\\s+passed', require_min_tests: 1,
      negative_control: './scripts/test-should-fail.sh' },
  };
  // 使用**真实**的 spec/standards.json（这样被测的 STD-GATE-HONEST-EXIT / STD-GATE-TEST-RUNS 确实存在）
  const standards = JSON.parse(readFileSync(path.join(KIT_ROOT, 'spec', 'standards.json'), 'utf8'));

  // ① 未取到门禁记录 ⇒ 必须是"不适用"，不能是"满足"
  const noRecords = checkStandards({
    standards, config: { gates: baseGates, projectRoot: root },
    doctor: { findings: [] }, records: [], itemDir: null,
  });
  const baselineNoRec = noRecords.results.find((r) => r.id === 'STD-TEST-BASELINE');

  // ② 门禁失败但已登记债务 ⇒ 判未满足（削弱），不得显示为满足
  const debt = checkStandards({
    standards, config: { gates: { test: { ...baseGates.test, baseline_debt: { reason: 'x', clear_when: 'y' } } }, projectRoot: root },
    doctor: { findings: [] }, records: [{ gate: 'test', exitCode: 1, testCount: 0 }], itemDir: null,
  });
  const honest = debt.results.find((r) => r.id === 'STD-GATE-HONEST-EXIT');

  // ③ 不可豁免项被覆盖 ⇒ 必须拒绝
  const rejected = checkStandards({
    standards,
    config: { gates: baseGates, projectRoot: root,
      standards: { overrides: [{ id: 'STD-GATE-NEGATIVE-EVIDENCE', judge: 'met', reason: '我说了算', clear_when: 'x' }] } },
    doctor: { findings: [] }, records: [], itemDir: null,
  });
  const rejectedR = rejected.results.find((r) => r.id === 'STD-GATE-NEGATIVE-EVIDENCE');

  // ④ 可豁免项被覆盖 ⇒ 生效且留痕
  const accepted = checkStandards({
    standards,
    config: { gates: baseGates, projectRoot: root,
      standards: { overrides: [{ id: 'STD-GATE-NEGATIVE-CONTROL', judge: 'met', reason: '第三方 CLI 无法构造失败', clear_when: '以后' }] } },
    doctor: { findings: [] }, records: [], itemDir: null,
  });
  const acceptedR = accepted.results.find((r) => r.id === 'STD-GATE-NEGATIVE-CONTROL');

  // ⑤ 环境受限（D3 弱发现）⇒ 测试空转条判"不适用"而不是"未满足"
  const env = checkStandards({
    standards, config: { gates: baseGates, projectRoot: root },
    doctor: { findings: [{ id: 'D3', severity: 'weak', title: '测试门禁因环境受限未跑起来（非代码问题）', evidence: '', fix: '' }] },
    records: [], itemDir: null,
  });
  const runsEnv = env.results.find((r) => r.id === 'STD-GATE-TEST-RUNS');

  record('SC42', '基础标准可执行：不适用≠满足、诚实失败≠满足、不可豁免项拒绝覆盖',
    '5 个方向各自符合预期',
    `无记录=${baselineNoRec?.verdict} 债务=${honest?.verdict} 拒绝覆盖=${Boolean(rejectedR?.overridden?.rejected)} 接受覆盖=${Boolean(acceptedR?.overridden && !acceptedR.overridden.rejected)} 环境受限=${runsEnv?.verdict}`,
    baselineNoRec?.verdict === 'not-applicable'
      && honest?.verdict === 'unmet'
      && Boolean(rejectedR?.overridden?.rejected)
      && Boolean(acceptedR?.overridden && !acceptedR.overridden.rejected)
      && runsEnv?.verdict === 'not-applicable');
  rmSync(root, { recursive: true, force: true });
}

  sc41();
/**
 * SC43：角色约束 R1/R6 必须被机械化（写入范围相交要报），
 * 且**诊断自身出错必须显式暴露**（曾因漏导入 readdirSync 被静默 catch 吞掉，检查形同不存在）。
 */
function sc43() {
  const root = tmpProject('d12');
  write(root, 'devflow.json', JSON.stringify({
    devflow: { project: 'd12', kit: '^1.1.0' },
    gates: {
      build: { run: './scripts/build.sh', negative_control: './scripts/build-should-fail.sh' },
      test: { run: './scripts/test.sh', count_regex: 'Tests\\s+(\\d+)', require_min_tests: 1,
        negative_control: './scripts/test-should-fail.sh' },
    },
    baseline: { exempt: { build: { reason: '演示', clear_when: '接入真实构建后' } }, debt: {} },
  }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho "build ok"\n', 0o755);
  write(root, 'scripts/test.sh', '#!/usr/bin/env bash\necho "Tests  5"\n', 0o755);
  write(root, 'scripts/build-should-fail.sh', '#!/usr/bin/env bash\necho "AssertionError: x" >&2\nexit 1\n', 0o755);
  write(root, 'scripts/test-should-fail.sh', '#!/usr/bin/env bash\necho "AssertionError: x" >&2\nexit 1\n', 0o755);
  const item = '2026-10-14-d12';
  mkdirSync(path.join(root, '.devflow', 'items', item), { recursive: true });
  write(root, `.devflow/items/${item}/TASKS.md`,
    '# TASKS\n\n| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |\n'
    + '|---|---|---|---|---|---|\n'
    + '| T-1 | r | 前端 | src/a.ts | 无 | 待开始 | 张三 | npm test | AC-1 |\n'
    + '| T-2 | r | 后端 | src/a.ts | 无 | 待开始 | 张三 | npm test | AC-1 |\n', 0o644);
  const config = JSON.parse(readFileSync(path.join(root, 'devflow.json'), 'utf8'));
  const { findings } = diagnose({
    projectRoot: root, config, marker: 'devflow.json + .devflow/', cwd: root, kitRoot: KIT_ROOT,
  });
  const d12 = findings.filter((f) => f.id === 'D12');
  const overlapCaught = d12.some((f) => f.severity === 'weak' && /相交/.test(f.title));
  const selfErrorVisible = d12.some((f) => /检查自身执行失败/.test(f.title));

  // 反向对照：不相交时不应误报
  write(root, `.devflow/items/${item}/TASKS.md`,
    '# TASKS\n\n| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |\n'
    + '|---|---|---|---|---|---|\n'
    + '| T-1 | r | 前端 | src/a.ts | 无 | 待开始 | 张三 | npm test | AC-1 |\n'
    + '| T-2 | r | 后端 | src/b.ts | 无 | 待开始 | 张三 | npm test | AC-2 |\n', 0o644);
  const after = diagnose({ projectRoot: root, config, marker: 'x', cwd: root, kitRoot: KIT_ROOT }).findings
    .filter((f) => f.id === 'D12' && /相交/.test(f.title));

  record('SC43', '角色约束 R1/R6 机械化：写入范围相交要报，且诊断自身出错必须可见',
    '相交 ⇒ 报 weak；不相交 ⇒ 不报；诊断异常 ⇒ 显式暴露（不得静默）',
    `相交被报=${overlapCaught} 自检失败可见=${selfErrorVisible} 不相交误报=${after.length}`,
    overlapCaught && selfErrorVisible === false && after.length === 0);
  rmSync(root, { recursive: true, force: true });
}

  sc42();
/**
 * SC44：基础标准的**阻断项必须并入体检总判定**。
 *
 * 这段逻辑原先写在 CLI 里不可测 —— 我曾在调整输出顺序时把它放到结论打印之后，
 * 结果"标准阻断不体现在结论里"却无人发现（自检覆盖不到）。抽成纯函数后在此钉死。
 */
function sc44() {
  const base = () => ({ trustworthy: true, summary: '门禁配置健康：可以开工', counts: { block: 0, weak: 0, info: 2 } });

  // ① 无标准阻断 ⇒ 判定不变
  const a = mergeStandardBlockers(base(), []);
  // ② 只有标准阻断 ⇒ 不可信，且文案要说明是产品底线
  const b = mergeStandardBlockers(base(), [{ id: 'STD-EXEMPTION-DECLARED' }]);
  // ③ 门禁层与标准层都有阻断 ⇒ 文案要区分两类
  const c = mergeStandardBlockers(
    { trustworthy: false, summary: '门禁**不可信**：有 2 项会骗过你', counts: { block: 2, weak: 0, info: 0 } },
    [{ id: 'STD-EVIDENCE-BY-COMMAND' }],
  );

  const ok = a.trustworthy === true
    && b.trustworthy === false
    && /基础标准 1 项被违反/.test(b.summary)
    && JSON.stringify(b.standardBlockIds) === '["STD-EXEMPTION-DECLARED"]'
    && c.trustworthy === false
    && /门禁层 2 项 \+ 基础标准 1 项/.test(c.summary);
  record('SC44', '基础标准阻断项必须并入体检总判定（不可信 + 文案区分两层）',
    '无阻断⇒不变；仅标准阻断⇒不可信并指明产品底线；两层都有⇒文案区分',
    `无=${a.trustworthy} 仅标准=${b.trustworthy}/${b.summary.slice(0, 24)} 两层=${c.summary.slice(0, 30)}`, ok);
}

  sc43();
/**
 * SC45：`init` 必须把 devflow 的**本地产物**加入 .gitignore。
 * 实测踩到：在真实仓提交时误把 .devflow/ 与生成的 *-should-fail.sh 提交进了功能变更的 MR。
 */
function sc45() {
  const root = tmpProject('gitignore');
  // 预置一个已有 .gitignore，验证是"追加"而非覆盖
  write(root, '.gitignore', 'node_modules/\n', 0o644);
  execFileSync(process.execPath, [path.join(KIT_ROOT, 'scripts', 'cli.mjs'), 'init', '--name', 'gi'],
    { cwd: root, stdio: 'pipe' });
  const gi = readFileSync(path.join(root, '.gitignore'), 'utf8');
  const keepsOriginal = /node_modules\//.test(gi);
  const ignoresLocalOnly = /^\.devflow\/\.local\/$/m.test(gi);
  const itemsStillTrackable = !/^\.devflow\/$/m.test(gi);   // 不得忽略整个 .devflow/
  const ignoresNegative = /scripts\/\*-should-fail\.sh/.test(gi);
  // devflow.json 必须**不**被忽略（它是项目门禁声明，团队共享才有意义）
  const keepsConfigTrackable = !/^devflow\.json$/m.test(gi);

  // 幂等：再跑一次不应重复追加
  execFileSync(process.execPath, [path.join(KIT_ROOT, 'scripts', 'cli.mjs'), 'init', '--name', 'gi'],
    { cwd: root, stdio: 'pipe' });
  const gi2 = readFileSync(path.join(root, '.gitignore'), 'utf8');
  const idempotent = (gi2.match(/^\.devflow\/\.local\/$/gm) || []).length === 1;

  record('SC45', 'init 必须忽略 devflow 本地产物（追加且幂等，保留 devflow.json 可入库）',
    '.devflow/ 与 scripts/*-should-fail.sh 被忽略；原内容保留；重复 init 不重复追加；devflow.json 不被忽略',
    `保留原内容=${keepsOriginal} 忽略.local=${ignoresLocalOnly} items可入库=${itemsStillTrackable} 忽略负向脚本=${ignoresNegative} 幂等=${idempotent}`,
    keepsOriginal && ignoresLocalOnly && itemsStillTrackable && ignoresNegative && keepsConfigTrackable && idempotent);
  rmSync(root, { recursive: true, force: true });
}

  sc44();
/**
 * SC46：存储规则必须被执行 ——
 *   ① 人写的产物在 items/、机器状态在 .local/items/（新变更）；
 *   ② 旧布局会在体检中被点名，且可迁移；
 *   ③ 仓库根目录的游离产物会被 D13 抓到。
 */
function sc46() {
  const root = tmpProject('storage');
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'storage', kit: '^1.1.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'storage'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-13', '--slug', 's1', '--tier', 'light', '--title', 't'],
    { cwd: root, stdio: 'pipe' });

  const itemsDirP = path.join(root, '.devflow', 'items', '2026-10-13-s1');
  const localDirP = path.join(root, '.devflow', '.local', 'items', '2026-10-13-s1');
  const humanInItems = existsSync(path.join(itemsDirP, 'SPEC.md'));
  const machineInLocal = existsSync(path.join(localDirP, 'STATE')) && existsSync(path.join(localDirP, 'STATUS.json'));
  const machineNotInItems = !existsSync(path.join(itemsDirP, 'STATE')) && !existsSync(path.join(itemsDirP, 'STATUS.json'));

  // ③ 游离产物 ⇒ D13 必须抓到
  write(root, 'devflow-体检结果.md', '# 游离产物\n', 0o644);
  const config = JSON.parse(readFileSync(path.join(root, 'devflow.json'), 'utf8'));
  const d13 = diagnose({ projectRoot: root, config, marker: 'x', cwd: root, kitRoot: KIT_ROOT })
    .findings.filter((f) => f.id === 'D13');
  const strayCaught = d13.some((f) => /游离产物/.test(f.title));

  // ② 把机器状态搬回 items/（模拟旧布局）⇒ D13 必须提示可迁移
  mkdirSync(itemsDirP, { recursive: true });
  for (const f of ['STATE', 'STATUS.json']) {
    writeFileSync(path.join(itemsDirP, f), readFileSync(path.join(localDirP, f), 'utf8'), 'utf8');
  }
  const legacy = diagnose({ projectRoot: root, config, marker: 'x', cwd: root, kitRoot: KIT_ROOT })
    .findings.filter((f) => f.id === 'D13');
  const legacyFlagged = legacy.some((f) => /旧存储布局/.test(f.title));

  record('SC46', '存储规则被引擎执行：items/ 与人写产物、.local/ 与机器状态、游离产物告警',
    '人写产物在 items/；STATE/STATUS.json 在 .local/ 且不在 items/；游离产物与旧布局都被 D13 抓到',
    `人写=${humanInItems} 机器在local=${machineInLocal} 机器不在items=${machineNotInItems} 游离被抓=${strayCaught} 旧布局被抓=${legacyFlagged}`,
    humanInItems && machineInLocal && machineNotInItems && strayCaught && legacyFlagged);
  rmSync(root, { recursive: true, force: true });
}

  sc45();
/**
 * SC47：门禁必须能进 CI（结构强制），且 CI 配置本身合法。
 *   · `ci` 生成的 YAML 不得把注释写成数组元素（实测踩过：`- # 注释` 是语法错误）
 *   · `gate run` 必须**阻断**（本次变更），`doctor` 必须**不阻断**（否则配置债务让每次推送都红灯 ⇒ 门禁被无视）
 *   · `setup-hooks` 必须真的装上钩子且能拦住违规提交
 */
function sc47() {
  const root = tmpProject('ci');
  write(root, 'package.json', '{"name":"ci"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'ci', kit: '^1.1.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'ci'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'ci', '--platform', 'gitlab', '--item', '2026-10-13-x'],
    { cwd: root, stdio: 'pipe' });
  const yml = readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8');
  const noCommentInList = !yml.split('\n').some((l) => l.trim().startsWith('- #'));
  const gateBlocks = /devflow-gate:[\s\S]*?stage: gates/.test(yml) && !/devflow-gate:[\s\S]{0,200}allow_failure: true/.test(yml);
  const doctorNonBlocking = /devflow-doctor:[\s\S]*?allow_failure: true/.test(yml);
  const hasRequiredGate = /gate run 2026-10-13-x/.test(yml);

  // GitHub 平台同样要合法
  execFileSync(process.execPath, [cli, 'ci', '--platform', 'github', '--item', '2026-10-13-x'],
    { cwd: root, stdio: 'pipe' });
  const gh = readFileSync(path.join(root, '.github', 'workflows', 'devflow.yml'), 'utf8');
  const ghOk = /continue-on-error: true/.test(gh) && /gate run 2026-10-13-x/.test(gh);

  // setup-hooks：装钩子并验证能拦住违规提交
  execFileSync('git', ['init', '-q'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'setup-hooks'], { cwd: root, stdio: 'pipe' });
  const hookPath = path.join(root, '.git', 'hooks', 'commit-msg');
  writeFileSync(path.join(root, 'bad.txt'), 'fix: 没有 scope\n', 'utf8');
  const hookRun = spawnSync(process.execPath, [hookPath, path.join(root, 'bad.txt')], { encoding: 'utf8' });
  const hookBlocks = hookRun.status === 1;

  record('SC47', '门禁可进 CI：配置合法、gate 阻断而 doctor 不阻断、钩子能拦违规提交',
    'YAML 无「- # 注释」；devflow-gate 必过；devflow-doctor allow_failure；github 版含 continue-on-error；钩子退出码 1',
    `注释未入数组=${noCommentInList} gate阻断=${gateBlocks} doctor不阻断=${doctorNonBlocking} 含门禁步骤=${hasRequiredGate} github=${ghOk} 钩子拦截=${hookBlocks}`,
    noCommentInList && gateBlocks && doctorNonBlocking && hasRequiredGate && ghOk && hookBlocks);
  rmSync(root, { recursive: true, force: true });
}

  sc46();
/**
 * SC48：任务级干预必须可用且不破坏表格结构。
 * 踩过的三个坑都在这里钉住：① 缺「负责人」列时静默改坏表；② 重建行多出尾随空列；
 * ③ 表头未剥首尾空串导致列错位（状态写进负责人列）。另有：阻塞必须给原因。
 */
function sc48() {
  const root = tmpProject('taskcmd');
  write(root, 'package.json', '{"name":"t"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 't', kit: '^1.2.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 't'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-14', '--slug', 'd', '--tier', 'standard',
    '--title', 't', '--owner', '张三', '--repos', 'r'], { cwd: root, stdio: 'pipe' });
  const tasksPath = path.join(root, '.devflow', 'items', '2026-10-14-d', 'TASKS.md');
  const mk = (withOwner) => ['# TASKS', '', '## 任务', '',
    withOwner
      ? '| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |'
      : '| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 验收命令 | 对应AC |',
    withOwner ? '|---|---|---|---|---|---|---|---|---|' : '|---|---|---|---|---|---|---|---|',
    withOwner
      ? '| T-1 | r | 后端 | src/a.ts | 无 | 待开始 | 张三 | npm test | AC-1 |'
      : '| T-1 | r | 后端 | src/a.ts | 无 | 待开始 | npm test | AC-1 |',
    ''].join('\n');

  // ① 缺列 ⇒ 必须明确拒绝（且不改文件）
  writeFileSync(tasksPath, mk(false), 'utf8');
  const before = readFileSync(tasksPath, 'utf8');
  const r1 = spawnSync(process.execPath, [cli, 'task', '2026-10-14-d', 'T-1', '--status', '已完成'],
    { cwd: root, encoding: 'utf8' });
  const rejected = r1.status !== 0 && /缺少列/.test(r1.stdout + r1.stderr);
  const untouched = readFileSync(tasksPath, 'utf8') === before;

  // ② 阻塞不给原因 ⇒ 必须拒绝
  writeFileSync(tasksPath, mk(true), 'utf8');
  const r2 = spawnSync(process.execPath, [cli, 'task', '2026-10-14-d', 'T-1', '--status', '阻塞'],
    { cwd: root, encoding: 'utf8' });
  const blockNeedsReason = /必须给出原因/.test(r2.stdout + r2.stderr);

  // ③ 正常干预：状态与负责人必须落在正确列，且列数不变
  execFileSync(process.execPath, [cli, 'task', '2026-10-14-d', 'T-1', '--status', '阻塞', '--note', '等接口', '--owner', '王五'],
    { cwd: root, stdio: 'pipe' });
  const after = readFileSync(tasksPath, 'utf8');
  const row = after.split('\n').find((l) => l.startsWith('| T-1 |')) || '';
  const nCols = row.split('|').length - 2;
  const colsOk = nCols === 9;
  const statusCol = row.split('|')[6].trim();   // 含首空串 ⇒ 状态在第 6 位
  const ownerCol = row.split('|')[7].trim();
  const aligned = /阻塞（等接口）/.test(statusCol) && ownerCol === '王五';
  const headerOk = (after.split('\n').find((l) => l.startsWith('| T |')) || '').split('|').length - 2 === 9;

  record('SC48', '任务级干预：缺列拒绝、阻塞须给原因、状态与负责人落到正确列',
    '缺列⇒拒绝且不改文件；阻塞无原因⇒拒绝；正常干预⇒9 列且状态/负责人列正确',
    `缺列拒绝=${rejected} 文件未改=${untouched} 阻塞需原因=${blockNeedsReason} 列数=${nCols} 对齐=${aligned} 表头列数=${headerOk}`,
    rejected && untouched && blockNeedsReason && colsOk && aligned && headerOk);
  rmSync(root, { recursive: true, force: true });
}

  sc47();
/**
 * SC49：需求澄清必须机制化 —— 未决项不得推进到实现。
 * 依据：质量损失的最大来源是"没人问该问的问题"，允许未决项通过等于把风险带进实现。
 */
function sc49() {
  const root = tmpProject('clarify');
  write(root, 'package.json', '{"name":"c"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'c', kit: '^1.2.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'c'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-14', '--slug', 'd', '--tier', 'light',
    '--title', 't', '--owner', '张三', '--repos', 'r'], { cwd: root, stdio: 'pipe' });

  // ① clarify 首次运行：应生成 CLARIFY.md 且全部未决
  const list = spawnSync(process.execPath, [cli, 'clarify', '2026-10-14-d'], { cwd: root, encoding: 'utf8' });
  const created = existsSync(path.join(root, '.devflow', 'items', '2026-10-14-d', 'CLARIFY.md'));
  const allPending = /未决：6\/6/.test(list.stdout);

  // ② 存在未决项 ⇒ 拒绝推进到 implementing
  execFileSync(process.execPath, [cli, 'advance', '2026-10-14-d', '--to', 'spec_ready'], { cwd: root, stdio: 'pipe' });
  const blockedRun = spawnSync(process.execPath, [cli, 'advance', '2026-10-14-d', '--to', 'implementing'],
    { cwd: root, encoding: 'utf8' });
  const blockedByPending = blockedRun.status !== 0 && /需求澄清仍有未决项/.test(blockedRun.stdout + blockedRun.stderr);

  // ③ 全部答完 ⇒ 放行
  for (let i = 1; i <= 6; i += 1) {
    execFileSync(process.execPath, [cli, 'clarify', '2026-10-14-d', '--answer', `U-${i}`, '--text', `答案 ${i}`],
      { cwd: root, stdio: 'pipe' });
  }
  const after = spawnSync(process.execPath, [cli, 'advance', '2026-10-14-d', '--to', 'implementing'],
    { cwd: root, encoding: 'utf8' });
  const allowed = after.status === 0;

  record('SC49', '需求澄清机制化：未决项不得推进到实现',
    'clarify 生成 6 条必答项；全未决⇒拒绝；全答⇒放行',
    `生成=${created} 全未决=${allPending} 拦住=${blockedByPending} 放行=${allowed}`,
    created && allPending && blockedByPending && allowed);
  rmSync(root, { recursive: true, force: true });
}

  sc48();
/**
 * SC50：完整性的两块缺口必须补上 ——
 *   · `workspace init`（多仓工作区**可创建**；此前只能读文件、无法建 ⇒ 功能不可用）
 *   · `architecture`（架构声明**可生成**；D14 提示了却做不到等于空提示）
 */
function sc50() {
  const root = tmpProject('completeness');
  // 造两个 git 仓
  for (const n of ['alpha', 'beta']) {
    mkdirSync(path.join(root, n), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: path.join(root, n), stdio: 'pipe' });
  }
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');

  // ① workspace init：应生成清单并纳入两个仓
  const wsRun = spawnSync(process.execPath, [cli, 'workspace', 'init', '--name', 'ws'], { cwd: root, encoding: 'utf8' });
  const wsFile = path.join(root, 'devflow.workspace.json');
  const wsCreated = existsSync(wsFile);
  let membersOk = false;
  try {
    const ws = JSON.parse(readFileSync(wsFile, 'utf8'));
    membersOk = (ws.members || []).length === 2 && ws.workspace?.name === 'ws';
  } catch { membersOk = false; }

  // ② 再次 init 应拒绝（不静默覆盖）
  const again = spawnSync(process.execPath, [cli, 'workspace', 'init'], { cwd: root, encoding: 'utf8' });
  const noOverwrite = again.status !== 0 && /已存在/.test(again.stdout + again.stderr);

  // ③ workspace 查看：应可读且不报错
  const view = spawnSync(process.execPath, [cli, 'workspace'], { cwd: root, encoding: 'utf8' });
  const viewOk = view.status === 0 && /alpha/.test(view.stdout);

  // ④ architecture：在有 devflow.json 的仓里应能生成，且再次运行拒绝覆盖
  const repoRoot = path.join(root, 'alpha');
  writeFileSync(path.join(repoRoot, 'devflow.json'), JSON.stringify({ devflow: { project: 'alpha', kit: '^1.4.0' }, gates: {} }), 'utf8');
  const arch = spawnSync(process.execPath, [cli, 'architecture'], { cwd: repoRoot, encoding: 'utf8' });
  const archFile = path.join(repoRoot, '.devflow', 'architecture.md');
  const archCreated = existsSync(archFile);
  const archBodyOk = archCreated && /技术栈/.test(readFileSync(archFile, 'utf8'));
  const archAgain = spawnSync(process.execPath, [cli, 'architecture'], { cwd: repoRoot, encoding: 'utf8' });
  const archNoOverwrite = archAgain.status !== 0 && /已存在/.test(archAgain.stdout + archAgain.stderr);

  record('SC50', '完整性：workspace 可创建、architecture 可生成（且都不静默覆盖）',
    'workspace init 生成清单含 2 仓；重复 init 拒绝；workspace 可查看；architecture 生成含技术栈；重复 architecture 拒绝',
    `workspace创建=${wsCreated} 成员=${membersOk} 防覆盖=${noOverwrite} 可查看=${viewOk} arch生成=${archCreated} 内容=${archBodyOk} arch防覆盖=${archNoOverwrite}`,
    wsCreated && membersOk && noOverwrite && viewOk && archCreated && archBodyOk && archNoOverwrite);
  rmSync(root, { recursive: true, force: true });
}

  sc49();
/**
 * SC51：`devflow ci` 生成的配置必须**结构合法且可执行**。
 * 踩过的坑：① YAML 序列里混注释（`- # 注释`）；② 多行 shell 被拆成多个数组元素；
 * ③ 契约扫描在单仓 CI 里必然失败（没有后端仓）；④ 生成器里硬编码内部仓库名。
 */
function sc51() {
  const root = tmpProject('ciyaml');
  write(root, 'package.json', '{"name":"ciyaml"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'ciyaml', kit: '^1.6.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'ciyaml'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'ci', '--platform', 'gitlab', '--item', '2026-10-14-x'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'ci', '--platform', 'github', '--item', '2026-10-14-x'], { cwd: root, stdio: 'pipe' });
  const gl = readFileSync(path.join(root, '.gitlab-ci.yml'), 'utf8');
  const gh = readFileSync(path.join(root, '.github', 'workflows', 'devflow.yml'), 'utf8');

  // ① 不得出现「数组项里带注释」
  const noCommentInList = (t) => !t.split('\n').some((l) => l.trim().startsWith('- #'));
  // ② 多行 shell 必须用块标量（`- |`），不要把 if/fi 拆成多个数组元素
  const gitlabBlockScalar = /script:\s*\n\s*- \|/.test(gl) && !/^\s*- if \[/m.test(gl);
  // ③ gitlab 的每个 job 都要有 allow_failure 的显式声明（doctor/contract 是报告性质）
  const reportNonBlocking = /devflow-doctor:[\s\S]*?allow_failure: true/.test(gl)
    && /devflow-contract:[\s\S]*?allow_failure: true/.test(gl);
  // ④ 必过 job 不得有 allow_failure
  const gateBlocks = /devflow-gate:[\s\S]*?stage: gates/.test(gl) && !/devflow-gate:[\s\S]{0,300}allow_failure: true/.test(gl);
  // ⑤ 不得硬编码内部仓库名
  const noInternalName = !/metacore|chaincloud|shuaiho/i.test(gl + gh);
  // ⑥ kit 从公开地址获取（不然 CI 拿不到）
  const fetchesKit = /github\.com\/darkknight110\/devflow-kit/.test(gl) && /github\.com\/darkknight110\/devflow-kit/.test(gh);
  // ⑦ GitHub 版同样不得把注释塞进数组（YAML 列表）
  const ghOk = noCommentInList(gh) && /continue-on-error: true/.test(gh) && /gate run 2026-10-14-x/.test(gh);
  // ⑧ 不得出现「run: 命令  # 注释」这种行内注释（YAML 里值会含糊，实测生成过坏配置）
  const noInlineComment = !/^\s*run:.*#/m.test(gl + gh);
  // ⑨ Node 项目必须先装依赖，否则 gate 步骤（npx/npm test）在 CI 上空跑失败
  const installsDeps = /npm ci|npm install/.test(gh) && /npm ci|npm install/.test(gl);
  // ⑩.5 人工确认点必须进 CI 的**报告** job（不阻断）：让"谁还没签"可见，
  //      但不能把"人还没签"变成红灯（否则团队会关掉检查，比没有检查更糟）。
  const hasReviewReport = /review --all/.test(gh) && /review --all/.test(gl);
  // ⑩ GitHub 每个 step 是独立 shell ⇒ 必须写 GITHUB_ENV/GITHUB_PATH，
  //    否则 `export DEVFLOW=` 不会跨 step 存活（实测：doctor: command not found）
  const persistsEnv = /GITHUB_ENV/.test(gh) && /GITHUB_PATH/.test(gh);

  record('SC51', 'devflow ci 生成的配置结构合法、不硬编码内部名、kit 可从公网获取',
    'GitLab/GitHub 均无「数组项含注释」；GitLab 用块标量；报告 job 不阻断；gate 必过；无内部仓名；含 kit 获取',
    `gl无注释=${noCommentInList(gl)} gl块标量=${gitlabBlockScalar} 报告不阻断=${reportNonBlocking} gate必过=${gateBlocks} 无内部名=${noInternalName} 可取kit=${fetchesKit} gh=${ghOk} 无行内注释=${noInlineComment} 装依赖=${installsDeps} 跨step持久=${persistsEnv} 确认点在CI=${hasReviewReport}`,
    noCommentInList(gl) && gitlabBlockScalar && reportNonBlocking && gateBlocks && noInternalName
      && fetchesKit && ghOk && noInlineComment && installsDeps && persistsEnv && hasReviewReport);
  rmSync(root, { recursive: true, force: true });
}

  sc50();
/**
 * SC52：装出来的技能必须**能被 DSH 识别** —— 即 SKILL.md 首行必须是 `---`（frontmatter 起点）。
 * 实测教训：安装戳放在文件开头会破坏 frontmatter，技能**从列表里消失**，
 * 而且本地自检/端到端全都发现不了（只有真实集成才暴露）。
 */
function sc52() {
  const src = path.join(KIT_ROOT, 'skill', 'SKILL.md');
  const body = readFileSync(src, 'utf8');

  // 源文件本身必须合法
  const srcOk = body.startsWith('---') && /\nname:\s*devflow/.test(body) && /\nwhenToUse:/.test(body);

  // 模拟 setup 的安装戳逻辑，验证生成结果仍合法
  const stamp = '<!-- 由 devflow setup 安装（2026-10-14）；kit 升级后请重跑 devflow setup --global 以刷新 -->';
  let out = body;
  const fmEnd = out.indexOf('\n---', 4);
  if (fmEnd >= 0) {
    const nl = out.indexOf('\n', fmEnd + 1);
    out = nl >= 0 ? `${out.slice(0, nl + 1)}${stamp}\n${out.slice(nl + 1)}` : `${out}\n${stamp}\n`;
  } else { out = `${stamp}\n${out}`; }
  const lines = out.split('\n');
  const installedOk = lines[0] === '---' && /^name:\s*devflow/.test(lines[1] || '')
    && lines.some((l) => /^whenToUse:/.test(l))
    && lines.some((l) => l.includes('devflow setup'));   // 戳确实写进去了

  // 反证：若把戳放在开头，必须被判为非法（证明这条校验真的有效）
  const bad = `${stamp}\n${body}`;
  const badRejected = bad.split('\n')[0] !== '---';

  record('SC52', '安装的技能必须能被 DSH 识别（SKILL.md 首行是 ---，戳在 frontmatter 之后）',
    '源文件合法；安装后首行仍是 ---；戳已写入但不在首行；戳放开头会被判非法',
    `源合法=${srcOk} 安装后合法=${installedOk} 首行=${JSON.stringify(lines[0])} 反证有效=${badRejected}`,
    srcOk && installedOk && badRejected);
}

  sc51();
/**
 * SC53：`devflow graph` 必须产出**语法合法**的 Mermaid，且真实反映依赖与状态。
 * 依据：图的价值全在"能否被渲染 + 是否说真话"；语法错或丢列都是废图。
 */
function sc53() {
  const root = tmpProject('graph');
  write(root, 'package.json', '{"name":"g"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'g', kit: '^1.7.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'g'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-14', '--slug', 'd', '--tier', 'standard',
    '--title', 't', '--owner', '张三', '--repos', 'order-api'], { cwd: root, stdio: 'pipe' });
  // 两条任务：T-2 依赖 T-1，且 T-2 阻塞（带原因）
  writeFileSync(path.join(root, '.devflow', 'items', '2026-10-14-d', 'TASKS.md'), [
    '# TASKS', '', '## 任务', '',
    '| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |',
    '|---|---|---|---|---|---|---|---|---|',
    '| T-1 | order-api | 后端 | src/a.ts | 无 | 已完成 | 张三 | npm test | AC-1 |',
    '| T-2 | order-api | 前端 | src/b.ts | T-1 | 阻塞（等接口） | 王五 | npm test | AC-2 |',
    '',
  ].join('\n'), 'utf8');

  const run = (kind) => spawnSync(process.execPath, [cli, 'graph', '--kind', kind], { cwd: root, encoding: 'utf8' }).stdout;

  // ① 任务图：依赖边 + 状态类 + 负责人 + 阻塞原因
  const tg = run('tasks');
  const hasEdge = /T-1 --> T-2/.test(tg);
  const hasStatusClass = /:::done/.test(tg) && /:::blocked/.test(tg);
  const hasOwner = /王五/.test(tg);
  const hasReason = /等接口/.test(tg);            // 图上要能看出"为什么卡住"
  const hasSubgraph = /subgraph order-api/.test(tg);

  // ② 语法合法性（结构层面）：```mermaid 配对、头部合法、引号/方括号配对
  const blocks = [...(tg + run('flow') + run('stages')).matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);
  const syntaxOk = blocks.length >= 3 && blocks.every((b) => {
    const lines = b.split('\n').filter((l) => l.trim());
    const headOk = ['flowchart LR', 'flowchart TD', 'stateDiagram-v2'].includes(lines[0].trim());
    const quotesOk = lines.every((l) => (l.match(/"/g) || []).length % 2 === 0);
    const bracketsOk = lines.every((l) => (l.match(/\[/g) || []).length === (l.match(/\]/g) || []).length);
    return headOk && quotesOk && bracketsOk;
  });

  // ③ 流转图：必须标出需求落在哪个节点
  const fg = run('flow');
  const flowMarksItem = /2026-10-14-d/.test(fg) && /stateDiagram-v2/.test(fg);

  record('SC53', 'devflow graph 产出合法 Mermaid，且真实反映依赖/状态/负责人/阻塞原因',
    '任务图含依赖边、状态类、负责人、阻塞原因、按仓分组；三种图语法结构合法；流转图标出需求位置',
    `依赖边=${hasEdge} 状态类=${hasStatusClass} 负责人=${hasOwner} 阻塞原因=${hasReason} 按仓分组=${hasSubgraph} 语法=${syntaxOk} 流转移=${flowMarksItem}`,
    hasEdge && hasStatusClass && hasOwner && hasReason && hasSubgraph && syntaxOk && flowMarksItem);
  rmSync(root, { recursive: true, force: true });
}

  sc52();
/**
 * SC54：看板的两块地基 —— ① 任务级事件必须留痕（"前世今生"）；② 状态接口必须反映真实状态。
 * 没有①，看板只能显示"现在"；没有②，看板会撒谎。
 */
function sc54() {
  const root = tmpProject('board');
  write(root, 'package.json', '{"name":"b"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'b', kit: '^1.8.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'b'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-14', '--slug', 'd', '--tier', 'light',
    '--title', 't', '--owner', '张三', '--repos', 'r'], { cwd: root, stdio: 'pipe' });
  writeFileSync(path.join(root, '.devflow', 'items', '2026-10-14-d', 'TASKS.md'), [
    '# TASKS', '', '## 任务', '',
    '| T | 目标仓 | 负责层 | 写入范围 | 依赖 | 状态 | 负责人 | 验收命令 | 对应AC |',
    '|---|---|---|---|---|---|---|---|---|',
    '| T-1 | r | 后端 | src/a.ts | 无 | 待开始 | 张三 | npm test | AC-1 |',
    '',
  ].join('\n'), 'utf8');

  // ① 任务级事件：改状态 + 换负责人 + 澄清，都要留痕且可读
  execFileSync(process.execPath, [cli, 'task', '2026-10-14-d', 'T-1', '--status', '进行中', '--by', '王五'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'task', '2026-10-14-d', 'T-1', '--status', '阻塞', '--note', '等接口', '--by', '李四'], { cwd: root, stdio: 'pipe' });
  // 负责人也必须能改（断言 owner 之前必须先真的改过，否则测的是"没改也对"）
  execFileSync(process.execPath, [cli, 'task', '2026-10-14-d', 'T-1', '--owner', '李四'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'clarify', '2026-10-14-d', '--answer', 'U-1', '--text', '答'], { cwd: root, stdio: 'pipe' });
  const hist = spawnSync(process.execPath, [cli, 'history', '2026-10-14-d', '--json'], { cwd: root, encoding: 'utf8' });
  let events = [];
  try { events = JSON.parse(hist.stdout).events; } catch { events = []; }
  const taskEvents = events.filter((e) => e.event === 'task.update');
  const hasWho = taskEvents.every((e) => e.by);
  const hasChanges = taskEvents.some((e) => (e.changes || []).some((c) => /阻塞/.test(c)));
  const hasClarify = events.some((e) => e.event === 'clarify');

  // ② 状态接口：必须与 TASKS.md 的真实状态一致
  const st = collectBoardState(root);
  const c = st.changes.find((x) => x.itemId === '2026-10-14-d');
  const t1 = c?.tasks?.[0];
  const kindOk = t1?.kind === 'blocked';
  const noteOk = t1?.note === '等接口';
  const ownerOk = t1?.owner === '李四';
  const countsOk = c?.counts?.blocked === 1 && c?.counts?.total === 1;
  const histOk = (c?.history || []).filter((e) => e.task).length >= 2;

  record('SC54', '看板地基：任务级事件留痕 + 状态接口与 TASKS.md 一致',
    'task/clarify 都产生事件且含操作者；看板状态含 kind/note/owner/counts；任务事件可查',
    `任务事件=${taskEvents.length} 含操作者=${hasWho} 含变更=${hasChanges} 含澄清=${hasClarify} `
    + `kind=${t1?.kind} note=${t1?.note} owner=${t1?.owner} counts=${countsOk} 事件可查=${histOk}`,
    taskEvents.length >= 2 && hasWho && hasChanges && hasClarify
      && kindOk && noteOk && ownerOk && countsOk && histOk);
  rmSync(root, { recursive: true, force: true });
}

  sc53();
/**
 * SC55：人工确认点的**闸门必须真的有效**（这是"质量第一道闸"，不能是形式）。
 * 三条硬要求：
 *   ① 材料不全时**拒绝**记录"通过"（除非 --force 并留理由）；
 *   ② 占位值（模板里的「（姓名）」「已通过 / 未通过 / 未验证」）**不算**已签核/已验证；
 *   ③ 有 verification.md 但没有**真实结论**时，同样不得签核（曾漏掉这条）。
 */
function sc55() {
  const root = tmpProject('review');
  write(root, 'package.json', '{"name":"r"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'r', kit: '^1.9.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'r'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-14', '--slug', 'd', '--tier', 'light',
    '--title', 't', '--owner', '张三', '--repos', 'r'], { cwd: root, stdio: 'pipe' });
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

  // ① 模板刚生成时：判据是占位 ⇒ 必须拒签
  const before = run(['review', '2026-10-14-d', '--point', '需求与判据']);
  const refused = /暂不可签核/.test(before.stdout) && /缺判据/.test(before.stdout);
  // 且显式记录"通过"会被拒
  const denied = run(['review', '2026-10-14-d', '--point', '需求与判据', '--by', '张三', '--verdict', '通过']);
  const deniedOk = denied.status !== 0 && /拒绝记录/.test(denied.stdout + denied.stderr);
  // 模板占位行不得被当成"已签核"
  const notSigned = !/已记录（（姓名）/.test(before.stdout);

  // ② 填真实判据后：可签，且能记录
  const specFile = path.join(root, '.devflow', 'items', '2026-10-14-d', 'SPEC.md');
  let spec = readFileSync(specFile, 'utf8');
  spec = spec.replace(/（可执行的命令 \+ 期望结果）/g, '`./scripts/test.sh` exit=0')
    .replace(/（只在一端可见时用画面：截什么、看到什么算通过）/g, '消息中心出现条目')
    .replace(/（谁负责达成）/g, '后端');
  writeFileSync(specFile, spec, 'utf8');
  const ok = run(['review', '2026-10-14-d', '--point', '需求与判据']);
  const canSign = /材料齐备，可以签核/.test(ok.stdout);
  const recorded = run(['review', '2026-10-14-d', '--point', '需求与判据', '--by', '李四', '--verdict', '通过', '--note', '判据可执行']);
  const recordOk = recorded.status === 0 && /已记录/.test(recorded.stdout);
  const after = run(['review', '2026-10-14-d']);
  const showsReal = /需求与判据\s+✓ 已记录（李四 \/ 通过）/.test(after.stdout);
  // 事件留痕
  const hist = run(['history', '2026-10-14-d']);
  const eventOk = /人工确认 需求与判据 → 通过/.test(hist.stdout);

  // ③ 发布批准：有 verification.md 但全是占位 ⇒ 不得签
  const pub = run(['review', '2026-10-14-d', '--point', '发布批准']);
  const pubBlocked = /暂不可签核/.test(pub.stdout)
    && /没有\*\*真实的\*\*逐条结论|缺判据/.test(pub.stdout);

  record('SC55', '人工确认点闸门有效：材料不全拒签、占位不算证据、记录可追溯',
    '占位判据时拒签且记录被拒；占位签核不算已记录；填真实内容后可签并记录；事件留痕；空验证记录不得批准发布',
    `占位拒签=${refused} 记录被拒=${deniedOk} 占位不算签=${notSigned} 可签=${canSign} 记录成功=${recordOk} 显示真实=${showsReal} 事件=${eventOk} 空验证拒=${pubBlocked}`,
    refused && deniedOk && notSigned && canSign && recordOk && showsReal && eventOk && pubBlocked);
  rmSync(root, { recursive: true, force: true });
}

  sc54();
/**
 * SC56：**签字必须绑定所批准的内容** —— 签完再改，原签字必须失效。
 * 为什么是硬要求：实测确认过这个漏洞 —— 签字后改掉已批准的验收标准，
 * APPROVALS.md 仍显示「✓ 已记录」、门禁也照样通过。**签完就万事大吉 = 闸门形同虚设。**
 * 借鉴 doorstop 的 `reviewed` 内容指纹思路。
 */
function sc56() {
  const root = tmpProject('stale');
  write(root, 'package.json', '{"name":"s"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 's', kit: '^1.9.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 's'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-14', '--slug', 'd', '--tier', 'light',
    '--title', 't', '--owner', '张三', '--repos', 'r'], { cwd: root, stdio: 'pipe' });

  // 规整 SPEC：只留一个验收标准节，且判据是真实内容（否则占位会被拒签）
  const specFile = path.join(root, '.devflow', 'items', '2026-10-14-d', 'SPEC.md');
  let spec = readFileSync(specFile, 'utf8');
  spec = spec.replace(/## 验收标准[\s\S]*?(?=\n## |$)/,
    '## 验收标准\n\n| AC | 判据 | 判据类型 | 责任方 |\n|---|---|---|---|\n'
    + '| AC-1 | `./scripts/test.sh` exit=0 | 命令 | 后端 |\n');
  writeFileSync(specFile, spec, 'utf8');

  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

  // ① 签核 → 应写入指纹（5 列，且自动为旧表补列）
  const sign = run(['review', '2026-10-14-d', '--point', '需求与判据', '--by', '李四', '--verdict', '通过']);
  const appFile = path.join(root, '.devflow', 'items', '2026-10-14-d', 'APPROVALS.md');
  const app1 = readFileSync(appFile, 'utf8');
  const hasFpCol = /内容指纹/.test(app1);
  const fp1 = (app1.match(/\| ([0-9a-f]{12}) \|/) || [])[1] || null;

  // ② 未改动时：不应判失效
  const clean = run(['review', '2026-10-14-d', '--point', '需求与判据']);
  const notStale = !/签字已失效/.test(clean.stdout);

  // ③ 篡改已批准的内容 → 必须判失效
  writeFileSync(specFile, readFileSync(specFile, 'utf8').replace('exit=0', 'exit=0 且输出含「提前99天」'), 'utf8');
  const after = run(['review', '2026-10-14-d', '--point', '需求与判据']);
  const detected = /签字已失效/.test(after.stdout) && /指纹/.test(after.stdout);

  // ④ 门禁必须反映（G1b 报缺记录）：失效率等同于未签
  const gate = run(['gate', 'run', '2026-10-14-d', '--to', 'verified', '--check']);
  const gateReflects = /G1b/.test(gate.stdout) && /需求与判据/.test(gate.stdout);

  // ⑤ 重新签核 → 指纹更新，且不再判失效
  run(['review', '2026-10-14-d', '--point', '需求与判据', '--by', '李四', '--verdict', '通过', '--note', '重新确认']);
  const app2 = readFileSync(appFile, 'utf8');
  const fp2 = (app2.match(/\| ([0-9a-f]{12}) \|/) || [])[1] || null;
  const resigned = run(['review', '2026-10-14-d', '--point', '需求与判据']);
  const noLongerStale = !/签字已失效/.test(resigned.stdout);
  const fpChanged = Boolean(fp1 && fp2 && fp1 !== fp2);

  record('SC56', '签字绑定内容：签完再改则原签字失效（门禁等同未签）',
    '签核写入指纹并自动补列；未改动不判失效；篡改后判失效且门禁反映；重新签核后指纹更新且恢复正常',
    `指纹列=${hasFpCol} 指纹1=${fp1} 未改动不失效=${notStale} 篡改后失效=${detected} 门禁反映=${gateReflects} 指纹2=${fp2} 指纹更新=${fpChanged} 恢复=${noLongerStale}`,
    hasFpCol && fp1 && notStale && detected && gateReflects && fpChanged && noLongerStale);
  rmSync(root, { recursive: true, force: true });
}

  sc55();
/**
 * SC57：契约破坏性判定必须是**可判定的**（规则是数据），而不是靠人写散文。
 * 借鉴 buf / oasdiff / cargo-semver-checks 的「稳定规则 ID + 级别 + 基线」数据模型。
 * 关键：删端点必须判 BREAKING；加端点只算 INFO；判据进 JSON 供 CI 消费。
 */
function sc57() {
  const root = tmpProject('contract');
  write(root, 'package.json', '{"name":"ct"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'ct', kit: '^1.12.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'ct'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-14', '--slug', 'd', '--tier', 'heavy',
    '--title', 't', '--owner', '张三', '--repos', 'r', '--surface', 'contract'], { cwd: root, stdio: 'pipe' });
  const cFile = path.join(root, '.devflow', 'items', '2026-10-14-d', 'CONTRACT.md');
  const mk = (eps, consumers, withAssert) => [
    '# CONTRACT · t', '', '## 所有权', '', '| 端点 | 方法 | owner | surface |', '|---|---|---|---|',
    ...eps, '', '## 消费者', '', '| 消费方 | 依赖什么 | 需要的兼容 |', '|---|---|---|',
    ...consumers,
    ...(withAssert ? ['', '## 校验方式', '', '| 校验方式 | 命令 | 通过条件 |', '|---|---|---|',
      '| 契约断言 | ./scripts/test.sh | exit=0 |'] : []), '',
  ].join('\n');
  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

  writeFileSync(cFile, mk([
    '| /api/orders | GET | order-api | interface |',
    '| /api/orders/{no}/cancel | POST | order-api | interface |',
  ], ['| consumer-mp | 分页字段 | 加字段 |'], true), 'utf8');

  // ① 无基线时：应提示 baseline-missing（而非假装通过）
  const noBase = run(['contract', 'diff', '2026-10-14-d', '--json']);
  let noBaseJson = null;
  try { noBaseJson = JSON.parse(noBase.stdout); } catch { /* 忽略 */ }
  const hintsBaseline = Boolean(noBaseJson?.findings?.some((f) => f.id === 'baseline-missing'));

  // ② 冻结基线
  const snap = run(['contract', 'snapshot', '2026-10-14-d']);
  const snapOk = /已冻结/.test(snap.stdout);

  // ③ 无改动时：应无 BREAKING
  const sameRun = run(['contract', 'diff', '2026-10-14-d', '--json']);
  let same = null;
  try { same = JSON.parse(sameRun.stdout); } catch { /* 忽略 */ }
  const cleanNoBreaking = Boolean(same?.findings) && !same.findings.some((f) => f.severity === 'BREAKING');

  // ④ 删端点 + 改 owner + 加新端点
  writeFileSync(cFile, mk([
    '| /api/orders/{no}/cancel | POST | order-service | interface |',
    '| /api/reports | GET | order-api | data |',
  ], ['| consumer-mp | 分页字段 | 加字段 |'], true), 'utf8');
  const d = run(['contract', 'diff', '2026-10-14-d', '--json']);
  let r = null;
  try { r = JSON.parse(d.stdout); } catch { /* 忽略 */ }
  const ids = (r?.findings || []).map((f) => f.id);
  const removedBreaking = (r?.findings || []).some((f) => f.id === 'endpoint-removed' && f.severity === 'BREAKING');
  const ownerWarn = (r?.findings || []).some((f) => f.id === 'endpoint-owner-changed' && f.severity === 'WARN');
  const addedInfo = (r?.findings || []).some((f) => f.id === 'endpoint-added' && f.severity === 'INFO');

  // ⑤ CI 用退出码：有 BREAKING ⇒ 3
  const failRun = run(['contract', 'diff', '2026-10-14-d', '--fail-on-breaking']);
  const exitOk = failRun.status === 3;

  // ⑥ 规则正典可审计
  const rules = run(['contract', 'rules']);
  const rulesOk = /endpoint-removed/.test(rules.stdout) && /BREAKING|⛔/.test(rules.stdout);

  record('SC57', '契约破坏性判定可判定：规则是数据、基线可比、BREAKING 可阻断 CI',
    '无基线时提示；冻结后无改动不误报；删端点=BREAKING、改 owner=WARN、加端点=INFO；--fail-on-breaking 退出码 3；规则可列出',
    `提示基线=${hintsBaseline} 冻结=${snapOk} 无改动干净=${cleanNoBreaking} 删端点BREAKING=${removedBreaking} `
    + `改ownerWARN=${ownerWarn} 新增INFO=${addedInfo} 退出码3=${exitOk} 规则可审计=${rulesOk} ids=${ids.join(',')}`,
    hintsBaseline && snapOk && cleanNoBreaking && removedBreaking && ownerWarn && addedInfo && exitOk && rulesOk);
  rmSync(root, { recursive: true, force: true });
}

  sc56();
/**
 * SC58：可视化必须**可交付** —— `view` 要给出 fileUrl（聊天才能直接 present 给用户），
 * 且默认产物落在**项目内稳定路径**（不是 /tmp，否则用户回头就找不到）。
 * 教训：只给一条"请自己运行 devflow view"的命令，等于把工作推回给用户。
 */
function sc58() {
  const root = tmpProject('deliver');
  write(root, 'package.json', '{"name":"dv"}\n', 0o644);
  write(root, 'devflow.json', JSON.stringify({ devflow: { project: 'dv', kit: '^1.13.0' },
    gates: { build: { run: './scripts/build.sh' } } }), 0o644);
  write(root, 'scripts/build.sh', '#!/usr/bin/env bash\necho ok\n', 0o755);
  const cli = path.join(KIT_ROOT, 'scripts', 'cli.mjs');
  execFileSync(process.execPath, [cli, 'init', '--name', 'dv'], { cwd: root, stdio: 'pipe' });
  execFileSync(process.execPath, [cli, 'new', '--date', '2026-10-14', '--slug', 'd', '--tier', 'light',
    '--title', 't', '--owner', '张三', '--repos', 'r'], { cwd: root, stdio: 'pipe' });

  const run = (args) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8' });

  // ① 默认输出落在项目内（稳定路径），并给出 fileUrl
  const def = run(['view', '--json']);
  let dj = null;
  try { dj = JSON.parse(def.stdout); } catch { /* 忽略 */ }
  // 用 realpath 比较：macOS 上 /tmp 是 /private/tmp 的软链，
  // 直接比字符串会把"就在项目内"判成"在项目外"（实测踩到）
  // 默认产物必须**落在项目内**。判据不依赖 realpath：
  // macOS 上 /var 与 /private/var 是同一目录的两种写法，realpathSync 并不总是规范化，
  // 用字符串前缀或 relative 会误判（实测踩到）。直接按"文件名 + 是否可从项目根走到"判定。
  const defFile = path.join(root, '.devflow', 'board.html');
  const inProject = Boolean(dj?.out)
    && path.basename(dj.out) === 'board.html'
    && existsSync(defFile);
  const hasUrl = Boolean(dj?.fileUrl) && String(dj.fileUrl).startsWith('file://');
  const fileExists = Boolean(dj?.out) && existsSync(dj.out);

  // ② 人读输出里也要出现可打开地址（模型可能只看文本）
  const human = run(['view']);
  const humanHasUrl = /file:\/\//.test(human.stdout);

  // ③ 指定 --out 时 fileUrl 随之变化且指向该文件
  // --out 用**相对路径**（相对项目根解析），这是真实用法
  const c = run(['view', '--out', 'sub/v.html', '--json']);
  let cj = null;
  try { cj = JSON.parse(c.stdout); } catch { /* 忽略 */ }
  const customOk = Boolean(cj?.fileUrl) && cj.fileUrl.endsWith('sub/v.html')
    && existsSync(path.join(root, 'sub', 'v.html'));

  // ④ 技能里必须写明"要用 present 直接交付"（否则模型仍会把命令丢给用户）
  const skill = readFileSync(path.join(KIT_ROOT, 'skill', 'SKILL.md'), 'utf8');
  const skillDelivers = /present/.test(skill) && /不要只回复|直接交付/.test(skill);

  record('SC58', '视图可交付：给出 fileUrl、默认落在项目内、技能要求直接 present',
    '默认产物在项目内且存在；fileUrl 为 file:// 且人读输出也含地址；--out 时随之变化；技能写明直接交付',
    `项目内=${inProject} fileUrl=${hasUrl} 文件存在=${fileExists} 人读含地址=${humanHasUrl} 自定义=${customOk} 技能=${skillDelivers}`,
    inProject && hasUrl && fileExists && humanHasUrl && customOk && skillDelivers);
  rmSync(root, { recursive: true, force: true });
}

  sc57();
/**
 * SC59：**改了机制就必须同步操作指南** —— 靠人自觉必然漂移，所以由机器看守。
 *
 * 为什么是硬要求：真实踩到过 —— 命令增加到 28 个，操作指南只覆盖 21 个，
 * 用户照着文档走会遇到"文档里没有的命令"。文档漂移是产品的**可信度**问题。
 *
 * 规则：每条 CLI 命令要么出现在操作指南的命令表里，要么在**显式豁免清单**里（带理由）。
 * 不允许"没写也没登记"—— 那正是漂移发生的方式。
 */
function sc59() {
  const cli = readFileSync(path.join(KIT_ROOT, 'scripts', 'cli.mjs'), 'utf8');
  const commands = [...cli.matchAll(/^\s*case '([a-z][a-z-]*)':/gm)].map((m) => m[1]);
  const uniq = [...new Set(commands)];

  // 豁免清单：内部/被包装的命令。**必须写理由**（写不出理由就说明它该进文档）
  const INTERNAL = {
    'setup-hooks': 'setup 的内部步骤（用户应使用 setup）',
  };

  // 命令可以写在主线或进阶文档里；两处合起来必须覆盖全部命令。
  // 为什么改为并集：指南已重构为「主线 + 进阶」，命令表移到进阶，
  // 若只查主线会导致这条自检**误报**（而误报会让人去放宽断言，是更坏的结果）。
  const guideFiles = ['00-quickstart.md', '08-advanced.md']
    .map((f) => path.join(KIT_ROOT, 'docs', f));
  const guide = guideFiles.filter((f) => existsSync(f))
    .map((f) => readFileSync(f, 'utf8')).join('\n');
  const missing = uniq.filter((c) => !INTERNAL[c] && !new RegExp(`\`${c}[\\s\`\\|]`).test(guide));

  // 版本一致性：VERSION / package.json / spec/*.json 必须一致
  const vVersion = readFileSync(path.join(KIT_ROOT, 'VERSION'), 'utf8').trim();
  let vPkg = null;
  try { vPkg = JSON.parse(readFileSync(path.join(KIT_ROOT, 'package.json'), 'utf8')).version; } catch { /* 忽略 */ }
  const specDir = path.join(KIT_ROOT, 'spec');
  const specVersions = new Set();
  for (const f of readdirSync(specDir)) {
    if (!f.endsWith('.json')) continue;
    try { const j = JSON.parse(readFileSync(path.join(specDir, f), 'utf8')); if (j.version) specVersions.add(j.version); } catch { /* 忽略 */ }
  }
  const versionConsistent = vPkg === vVersion && specVersions.size === 1 && specVersions.has(vVersion);

  // 指南必须说清「怎么拿到它」与「怎么装」—— 这是新手第一步，缺了就等于没指南
  // 安装路径必须出现在**主线**（新手只看主线；放进阶等于没有）
  const quickstart = readFileSync(path.join(KIT_ROOT, 'docs', '00-quickstart.md'), 'utf8');
  const hasOnboarding = /git clone.*devflow-kit/.test(quickstart) && /devflow setup/.test(quickstart);

  record('SC59', '操作指南与实现同步：每条命令都有出处，版本号一致',
    '每条 CLI 命令要么在指南命令表里、要么在带理由的豁免清单里；VERSION/package.json/spec 版本一致；指南含安装路径',
    `命令数=${uniq.length} 未覆盖=${missing.join(',') || '无'} 版本一致=${versionConsistent} `
    + `VERSION=${vVersion} pkg=${vPkg} spec=${[...specVersions].join(',')} 含安装=${hasOnboarding}`,
    missing.length === 0 && versionConsistent && hasOnboarding);
}

  sc58();
/**
 * SC60：看板的界面资产必须齐备，且 **SSE 只在真实变化时推送**。
 * 踩过的坑：快照里含 generatedAt ⇒ 每次字符串都不同 ⇒ 去重失效，
 * 服务每 2 秒推一帧、前端全量重绘，正在展开的卡片会被冲掉（实测发现）。
 */
function sc60() {
  const src = readFileSync(path.join(KIT_ROOT, 'scripts', 'lib', 'board.mjs'), 'utf8');

  // ① 视觉资产：不要再是"单调"的默认样式
  const visuals = {
    渐变背景: /radial-gradient|linear-gradient/.test(src),
    毛玻璃顶栏: /backdrop-filter/.test(src),
    阴影层次: /box-shadow/.test(src),
    等宽数字: /tabular-nums/.test(src),
    响应式: /@media\s*\(max-width/.test(src),
    降低动效: /prefers-reduced-motion/.test(src),
    分节标题: /class="sec"/.test(src),
    空状态: /class="empty"/.test(src),
  };
  const visualsOk = Object.values(visuals).every(Boolean);

  // ② JS 依赖的钩子必须一个不少（美化最容易碰坏功能）
  const hooks = ['stats', 'lanes', 'stages', 'panel', 'panelBody', 'live', 'liveTxt', 'at'];
  const missingHooks = hooks.filter((k) => !src.includes(`id="${k}"`));

  // ③ 去重必须排除 generatedAt（否则空转也推）
  // 去重键：函数名已泛化为 keyFor(root)（每请求根），但**必须仍排除 generatedAt**
  const keyFn = /const keyFor = \(root\) => \{[\s\S]{0,300}?generatedAt[\s\S]{0,120}?\};/.test(src);
  // 无变化时：既不推快照，也**必须发心跳**（否则连接空闲会被判断开，实测面板一直"已断开"）
  const skipsUnchanged = /if \(key === last\)/.test(src);
  const sendsHeartbeat = /: ping/.test(src);

  record('SC60', '看板视觉齐备、JS 钩子完整、SSE 只在真实变化时推送',
    '含渐变/毛玻璃/阴影/等宽数字/响应式/降低动效/分节/空状态；8 个 JS 钩子齐全；去重排除 generatedAt 且无变化不推送',
    `视觉=${Object.entries(visuals).filter(([, v]) => !v).map(([k]) => k).join(',') || '齐备'} `
    + `缺钩子=${missingHooks.join(',') || '无'} 去重键=${keyFn} 跳过未变=${skipsUnchanged}`,
    visualsOk && missingHooks.length === 0 && keyFn && skipsUnchanged && sendsHeartbeat);
}

  sc59();
/**
 * SC61：插件源码卫生 —— 守住两类**已经真实发生过**的错误。
 *  ① ESM 文件里用 `require` ⇒ 抛错被 catch 吞掉，表现为"恒为 false"的静默失效
 *     （实测：候选根全部判为无效，服务起不来，日志只能看到"无有效候选"）
 *  ② 构建产物里烘焙了作者的本机路径 ⇒ 公开仓库泄露（实测发生过一次）
 */
function sc61() {
  const srcDir = path.join(KIT_ROOT, 'plugin', 'src');
  const files = existsSync(srcDir) ? readdirSync(srcDir).filter((f) => f.endsWith('.js')) : [];
  const sources = files.map((f) => ({ f, text: readFileSync(path.join(srcDir, f), 'utf8') }));

  // ① ESM 源码里不得出现 require(
  const withRequire = sources.filter((x) => /\brequire\s*\(/.test(x.text)).map((x) => x.f);

  // ② 宿主半边必须是 { name, inject, apply } 对象，且声明 inject
  const host = sources.find((x) => x.f === 'index.js');
  const hostOk = Boolean(host) && /name:\s*'/.test(host.text) && /inject:\s*\[/.test(host.text)
    && /apply/.test(host.text);

  // ③ 构建产物（若存在）不得含作者本机路径
  const artifacts = ['lib/index.js', 'lib/client.js']
    .map((f) => path.join(KIT_ROOT, 'plugin', f))
    .filter((f) => existsSync(f));
  const leaked = artifacts.filter((f) => /\/Users\/|\/home\/[a-z]/.test(readFileSync(f, 'utf8')));

  // ④ 客户端产物必须是宿主的模块加载器格式（第一版用 ESM ⇒ boot 失败）
  const clientFile = path.join(KIT_ROOT, 'plugin', 'lib', 'client.js');
  const clientOk = !existsSync(clientFile)
    || /window\.__ModuleLoader__\.load\(/.test(readFileSync(clientFile, 'utf8'));

  record('SC61', '插件源码卫生：ESM 不用 require、宿主半边形态正确、产物不含本机路径',
    'src 无 require(；宿主半边含 name/inject/apply；产物无 /Users 或 /home 路径；客户端产物为 __ModuleLoader__ 格式',
    `含require=${withRequire.join(',') || '无'} 宿主形态=${hostOk} 产物泄露=${leaked.map((f) => path.basename(f)).join(',') || '无'} 客户端格式=${clientOk}`,
    withRequire.length === 0 && hostOk && leaked.length === 0 && clientOk);
}

  sc60();
/**
 * SC62：看板支持**每请求根**（一个服务服务任意工作区），且**不变成任意路径读取器**。
 * 依据：用户诉求是"能切换工作区"；而 `?root=` 来自浏览器，必须校验后才接受。
 */
function sc62() {
  const src = readFileSync(path.join(KIT_ROOT, 'scripts', 'lib', 'board.mjs'), 'utf8');
  const hasResolve = /function resolveRoot\(/.test(src);
  const validates = /MARKERS = \['\.devflow'/.test(src) && /isRoot\(abs\) \? abs : defaultRoot/.test(src);
  const perRequest = /url\.searchParams\.get\('root'\)/.test(src);
  const rootsApi = /'\/api\/roots'/.test(src);
  // 服务端必须按订阅的根分别推送（否则切换后收到别人的数据）
  const perClientRoot = /clients\.set\(res, root\)/.test(src);
  // 面板要有切换控件，并回显实际服务的根
  const ui = ['wsInput', 'wsApply', 'wsReset', 'wsList', 'startStream'].every((k) => src.includes(k));
  const echoesRoot = /servedRoot/.test(src);

  record('SC62', '看板每请求根：可切换工作区，且无效根回退默认（不做任意路径读取）',
    'resolveRoot 校验标记后接受；state/stream 读 ?root=；有 /api/roots；按客户端各自的根推送；面板含切换控件并回显实际根',
    `校验=${validates} 每请求=${perRequest} roots接口=${rootsApi} 按根推送=${perClientRoot} 控件=${ui} 回显=${echoesRoot}`,
    hasResolve && validates && perRequest && rootsApi && perClientRoot && ui && echoesRoot);
}

  sc61();
/**
 * SC63：文档里的**内部链接必须能点开**（文件存在 + 锚点存在）。
 *
 * 为什么需要：指南已拆成「主线 + 进阶」，跨文件链接变多；
 * 锚点写错会变成死链，而**死链是静默的** —— 读者点不动却没人知道。
 * 锚点算法按 GitHub 规则：小写、去标点、空格转连字符。
 */
function sc63() {
  const docsDir = path.join(KIT_ROOT, 'docs');
  const files = readdirSync(docsDir).filter((f) => f.endsWith('.md'));
  const read = (f) => readFileSync(path.join(docsDir, f), 'utf8');

  /** GitHub 风格锚点 */
  const anchorOf = (heading) => heading.trim().toLowerCase()
    .replace(/[（）()：:，,。.、/\\|"'`？?！!［\]\[【】《》—－-]/g, '')
    .replace(/\s+/g, '-');

  const headingsOf = (f) => [...read(f).matchAll(/^#{1,6}\s+(.+)$/gm)].map((m) => anchorOf(m[1]));
  const cache = {};
  const anchors = (f) => (cache[f] = cache[f] || headingsOf(f));

  const broken = [];
  for (const f of files) {
    const body = read(f);
    for (const m of body.matchAll(/\]\(([^)]+\.md)(?:#([^)]+))?\)/g)) {
      const target = m[1];
      const want = m[2];
      if (!existsSync(path.join(docsDir, target))) { broken.push(`${f} → ${target}（文件不存在）`); continue; }
      if (!want) continue;
      const list = anchors(target);
      // 宽松匹配：去掉标点后再比一次（容忍编辑器差异）
      const norm = (x) => x.replace(/[^\p{L}\p{N}]/gu, '');
      if (!list.includes(want) && !list.some((h) => norm(h) === norm(want))) {
        broken.push(`${f} → ${target}#${want}`);
      }
    }
  }
  record('SC63', '文档内部链接可点开（文件与锚点都存在）',
    '遍历 docs/*.md 的所有 [..](x.md#anchor) 链接，校验目标文件与 GitHub 风格锚点',
    `检查文档=${files.length} 份 死链=${broken.length} 处${broken.length ? '：' + broken.slice(0, 3).join('；') : ''}`,
    broken.length === 0);
}

  sc62();
/**
 * SC64：时间**显示必须是本地时区**。
 *
 * 踩过的坑：把 ISO（UTC）字符串直接截断当本地时间显示 ——
 * 本机 CST+0800 实测差了整整 8 小时。存储用 ISO 是对的（可移植、可排序），
 * **但显示必须转换**。
 */
function sc64() {
  const files = ['scripts/cli.mjs', 'scripts/lib/board.mjs'];
  const bad = [];
  for (const f of files) {
    const text = readFileSync(path.join(KIT_ROOT, f), 'utf8');
    // 反模式：直接截断 ISO 当显示（'T' 换成空格再 slice 19）
    for (const m of text.matchAll(/replace\(\s*['"]T['"]\s*,\s*['"] ['"]\s*\)\s*\.slice\(\s*0,\s*19\s*\)/g)) {
      bad.push(`${path.basename(f)}:${text.slice(0, m.index).split('\n').length}`);
    }
  }
  // 两个格式化器必须存在（各自负责自己的显示层）
  const cli = readFileSync(path.join(KIT_ROOT, 'scripts', 'cli.mjs'), 'utf8');
  const board = readFileSync(path.join(KIT_ROOT, 'scripts', 'lib', 'board.mjs'), 'utf8');
  const hasFmt = /function localTime\(/.test(cli) && /const fmtLocal = \(/.test(board);
  // 且必须真的被用上（而不是定义了没人用）
  const usedInCli = /localTime\(e\.at\)/.test(cli);
  const usedInBoard = /fmtLocal\(e\.at\)/.test(board) && /fmtLocal\(s\.generatedAt\)/.test(board);

  record('SC64', '时间显示用本地时区（不得直接截断 ISO）',
    '源码里不得出现 ISO 截断式显示；cli 与 board 各自有本地时间格式化器且被实际调用',
    `裸截断=${bad.join(',') || '无'} 格式化器=${hasFmt} cli已用=${usedInCli} board已用=${usedInBoard}`,
    bad.length === 0 && hasFmt && usedInCli && usedInBoard);
}

  sc63();
  sc64();
  return {
    kitRoot: KIT_ROOT,
    at: new Date().toISOString(),
    cases,
    passed: cases.every((c) => c.passed),
    summary: { total: cases.length, passed: cases.filter((c) => c.passed).length, failed: cases.filter((c) => !c.passed).length },
  };
}

// 直接执行时打印结果（供 `node scripts/selfcheck.mjs` 使用）
if (process.argv[1] && process.argv[1].endsWith('selfcheck.mjs')) {
  const report = runSelfcheck();
  for (const c of report.cases) {
    process.stdout.write(`${c.passed ? '✓' : '✗'} ${c.id} ${c.name}\n`);
    if (!c.passed) process.stdout.write(`    期望：${c.expect}\n    实际：${c.actual}\n`);
  }
  process.stdout.write(`\n${report.passed ? '自检通过' : '自检失败'}：${report.summary.passed}/${report.summary.total}\n`);
  if (!report.passed) process.exitCode = 1;
}
