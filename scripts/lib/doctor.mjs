/**
 * doctor：项目体检。
 *
 * 设计原则（针对"看起来配好了、其实没检查"这类信任问题）：
 *   1. 只读 —— 不写任何文件、不改任何状态；
 *   2. 每条发现必须给「问题 + 依据 + 修复建议」，缺一不可；
 *   3. 三档严重度：block（会骗人/不可用）、weak（门禁被削弱）、info（提示）；
 *   4. 结论必须明确回答一个问题：**现在这套门禁，能不能信？**
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { envFailureReason } from './env-failure.mjs';
import { hasFailureEvidence } from './evidence.mjs';
import path from 'node:path';
import { instructionChainKb } from './manifest.mjs';
import { runCommand } from './evidence.mjs';
import { loadAdapters, auditAdapterRegex } from './adapter.mjs';

/**
 * 把「基础标准未满足且后果为阻断」并入体检总判定。
 *
 * 为什么抽成独立函数：这段逻辑原先写在 CLI 里，**不可被测**——
 * 我曾在调整输出顺序时把它放到结论打印之后，导致"标准阻断不体现"却无人发现。
 * 纯函数可被自检覆盖。
 *
 * @param {object} verdict  diagnose 返回的 verdict（会被就地更新）
 * @param {Array}  stdBlocking  checkStandards 中 verdict=unmet 且 consequence=block 的条目
 */
export function mergeStandardBlockers(verdict, stdBlocking) {
  if (!stdBlocking || !stdBlocking.length) return verdict;
  verdict.trustworthy = false;
  verdict.standardBlockIds = stdBlocking.map((r) => r.id);
  const gateBlocks = verdict.counts?.block ?? 0;
  verdict.summary = gateBlocks
    ? `门禁**不可信**：门禁层 ${gateBlocks} 项 + 基础标准 ${stdBlocking.length} 项会骗过你`
    : `门禁**不可信**：基础标准 ${stdBlocking.length} 项被违反（产品底线）`;
  return verdict;
}

export const SEVERITIES = {
  block: { label: '阻断', symbol: '⛔', order: 0, meaning: '会出现"看起来通过、其实没检查"或无法运行' },
  weak: { label: '削弱', symbol: '⚠', order: 1, meaning: '能跑，但门禁的强度被削弱' },
  info: { label: '提示', symbol: 'ℹ', order: 2, meaning: '不影响判定，建议关注' },
};

function finding(severity, id, title, evidence, fix) {
  return { severity, id, title, evidence, fix };
}

/**
 * 识别"init 之后没改过"的脚本。
 * 用**机器哨兵**而不是文案匹配 —— 文案一改，检测就会静默失效（踩过这个坑）。
 */
const PLACEHOLDER_SENTINEL = 'devflow:placeholder';
const PLACEHOLDER_MARKERS = [PLACEHOLDER_SENTINEL];

/**
 * 执行体检。
 * @param {object} ctx { projectRoot, config, marker, cwd, kitVersion }
 * @returns {{findings:Array, verdict:object}}
 */
export function detectEnvFailure(raw) {
  return envFailureReason(raw);
}

export function diagnose({ projectRoot, config, marker = 'unknown', cwd = projectRoot, kitVersion = '0.0.0', kitRoot = null }) {
  const findings = [];
  const gates = config?.gates || {};
  if (process.env.DEVFLOW_DEBUG) {
    process.stderr.write(`[debug] doctor gates=${Object.keys(gates).join(',')} cwd=${projectRoot}\n`);
  }

  // ── D1 未声明任何门禁 ───────────────────────────────────────
  if (Object.keys(gates).length === 0) {
    findings.push(finding('block', 'D1', '项目没有声明任何门禁',
      'devflow.json 的 gates 为空',
      '在 devflow.json 里至少声明一个门禁，例如 "build": { "run": "./scripts/build.sh", "negative_control": "./scripts/build-should-fail.sh" }'));
  }

  // ── D2 每个门禁的负向对照 ──────────────────────────────────
  for (const [name, def] of Object.entries(gates)) {
    if (!def || typeof def.run !== 'string') {
      findings.push(finding('block', 'D2', `门禁 ${name} 没有可执行的 run 命令`,
        JSON.stringify(def ?? null),
        `给 ${name} 补上 "run"，并且命令必须以自身退出码表达结论`));
      continue;
    }
    if (!def.negative_control) {
      findings.push(finding('weak', 'D2', `门禁 ${name} 缺少负向对照（恒真时无法发现）`,
        `${name}.negative_control 未声明`,
        `补一个"必定失败"的命令，例如 "negative_control": "./scripts/${name}-should-fail.sh"（脚本内容为 exit 1）。补齐后该门禁才会显示 ✓，否则始终是 ⚠ 未验证通过`));
      continue;
    }
    // 真的跑一次负向对照：它必须返回非零
    const ctl = runCommand(def.negative_control, projectRoot);
    if (process.env.DEVFLOW_DEBUG) {
      process.stderr.write(`[debug] D2 ${name}: negative_control exit=${ctl.exitCode} run=${ctl.command}\n`);
    }
    if (ctl.exitCode === 0) {
      findings.push(finding('block', 'D2', `门禁 ${name} 的负向对照返回了 0（门禁恒真，不可信）`,
        `命令 \`${ctl.command}\` 退出码 0；输出尾部：${ctl.outputTail || '(空)'}`,
        `负向对照必须是"必定失败"的命令。修正 ${name}.negative_control，使其退出码非零`));
    }
    if (ctl.exitCode === 127) {
      findings.push(finding('block', 'D2', `门禁 ${name} 的负向对照脚本不存在`,
        `命令 \`${ctl.command}\` 退出码 127（command not found）`,
        `创建该脚本并 chmod +x，或把 negative_control 指向真实存在的命令`));
    }
  }

  // ── D3 测试门禁是否"名存实亡"（真正的假通过来源） ───────────
  const testGate = gates.test;
  if (testGate && typeof testGate.run === 'string') {
    const run = runCommand(testGate.run, projectRoot);
    const tail = run.outputTail || '';
    // 先判断是不是"还没配置完"的占位脚本：那种情况由 D4 报阻断，这里只给提示，避免重复报错
    const testScriptPath = path.resolve(projectRoot, 'scripts/test.sh');
    let testScriptContent = '';
    try {
      testScriptContent = existsSync(testScriptPath) ? execSync(`cat ${JSON.stringify(testScriptPath)}`, { encoding: 'utf8' }) : '';
    } catch {
      testScriptContent = '';
    }
    // 环境受限优先判断：这类失败**不是代码问题**，不能报成"门禁不可信"
    // （真实案例：~/.m2 不可写导致 Maven 启动即失败；若报成代码失败，使用者会开始忽略所有告警）
    const testEnvCause = run.exitCode !== 0 ? detectEnvFailure(run.raw) : null;
    if (run.exitCode !== 0 && testEnvCause) {
      findings.push(finding('weak', 'D3', `测试门禁因环境受限未跑起来（非代码问题：${testEnvCause}）`,
        `命令 \`${run.command}\` 退出码 ${run.exitCode}；输出尾部：${tail}`,
        '**这不算代码失败**：修好环境（权限/网络/工具链）后重跑即可。'
        + '在环境修好之前，本仓的测试结论是"未验证"，不是"失败"'));
    } else if (testScriptContent.includes(PLACEHOLDER_SENTINEL)) {
      findings.push(finding('info', 'D3', '测试门禁尚未配置完成（详见 D4）',
        'scripts/test.sh 仍是占位脚本',
        '换成真实测试命令后，doctor 会进一步校验它是否真的在跑测试'));
    } else if (run.exitCode !== 0 && testGate.baseline_exempt) {
      // 存量项目已登记豁免：结果必须显示为"豁免"（⚠），绝不能显示为通过（✓），也不应阻断开工
      findings.push(finding('weak', 'D3', '测试门禁失败，但本仓已登记基线豁免（存量债务）',
        `命令 \`${run.command}\` 退出码 ${run.exitCode}；豁免原因：${testGate.baseline_exempt.reason || '(未注明)'}；`
        + `清除条件：${testGate.baseline_exempt.clear_when || '(未注明)'}`,
        '可以开工，但这次改动**不能**声称"测试通过"——门禁结果会显示为 ■ 基线豁免。'
        + '豁免**只减不增**：请在下一次相关改动里补上第一个测试以清除它'));
    } else if (run.exitCode !== 0) {
      // 关键：门禁命令本身跑不起来/失败，而 doctor 却说"可以开工"—— 结论与实际不一致，等于骗人。
      const raw = run.raw || '';
      const missingTool = run.exitCode === 127
        || /command not found|No module named|不是内部或外部命令|not recognized/i.test(raw);
      findings.push(finding('block', 'D3', missingTool
        ? '测试门禁的测试框架还没装（命令跑不起来）'
        : '测试门禁当前是失败的',
      `命令 \`${run.command}\` 退出码 ${run.exitCode}；输出尾部：${tail || '(空)'}`,
      (missingTool
        ? '**先写至少一个测试并安装测试框架**'
        : '**先写至少一个测试**（新仓最常见的第一步）；若已有测试，看上面的输出尾部定位失败原因')
      + '。本仓确实没有测试基座且属于**存量项目**时，才登记 baseline_exempt（只减不增）。**门禁失败 ≠ 可以开工**'));
    }
    if (process.env.DEVFLOW_DEBUG) {
      process.stderr.write(`[debug] D3 test exit=${run.exitCode} raw=${JSON.stringify((run.raw || '').slice(0, 80))}\n`);
    }
    // 注意：`0 passed` 必须要求"0"是**独立的数字**。
    // 曾用 /0 passed/ 直接匹配 ⇒ "30 passed" 里也含 "0 passed" 子串，
    // 导致测试数为 10/20/30/100 的项目被误判成"没有任何测试在跑"（真实踩到过）。
    const looksPlaceholder =
      /Tests run:\s*0\b/.test(run.raw || '') ||
      /no tests|没有测试/i.test(run.raw || '') ||
      /(?:^|[^\d])0\s+passed\b/i.test(run.raw || '') ||
      /(?:^|[^\d])0\s+tests?\b/i.test(run.raw || '');
    if (run.exitCode === 0 && looksPlaceholder && testGate.baseline_exempt) {
      findings.push(finding('weak', 'D3', '测试门禁"通过"但没有任何测试在跑（本仓已登记基线豁免）',
        `命令 \`${run.command}\` 退出码 0，但输出显示测试数为 0；豁免原因：${testGate.baseline_exempt.reason || '(未注明)'}`,
        '可以开工，但**不得**把这次结果当成"测试通过"。清除条件：'
        + `${testGate.baseline_exempt.clear_when || '(未注明)'}；豁免只减不增`));
    } else if (run.exitCode === 0 && looksPlaceholder) {
      findings.push(finding('block', 'D3', '测试门禁"通过"了，但实际没有任何测试在跑',
        `命令 \`${run.command}\` 退出码 0，但输出显示测试数为 0：${tail}`,
        '**先写至少一个测试**并让 test 命令真的运行它、输出计数。本仓确实没有测试基座且属于**存量项目**时，才登记基线豁免：' +
        '"baseline_exempt": { "reason": "本仓历史无测试基座", "clear_when": "test_count > 0" }（豁免只减不增）'));
    }
    if (run.exitCode === 0 && testGate.count_regex) {
      const m = new RegExp(testGate.count_regex).exec(run.raw || '');
      if (!m) {
        findings.push(finding('weak', 'D3', '测试计数正则抓不到任何数字',
          `count_regex=\`${testGate.count_regex}\` 在命令输出中没有匹配；输出尾部：${tail}`,
          `把 count_regex 调成能匹配你测试框架输出的形式（例：Jest 用 "Tests:\\\\s*(\\\\d+) passed"），或去掉 require_min_tests`));
      }
    }
    if (typeof testGate.require_min_tests !== 'number' && !testGate.baseline_exempt) {
      findings.push(finding('weak', 'D3', '测试门禁没有设置测试数下限',
        'test.require_min_tests 未声明',
        '加上 "require_min_tests": 1 并把 "count_regex" 配上，否则"测试数为 0"会被判为通过'));
    }
  } else if (!testGate) {
    findings.push(finding('weak', 'D3', '没有声明测试门禁',
      'devflow.json 的 gates 里没有 test',
      '至少声明一个 test 门禁；没有测试基座时也应声明并登记 baseline_exempt，而不是省略'));
  }

  // ── D3b 构建门禁当前是否可用（与 D3 同一原则：结论必须与实际一致） ──
  const buildGate = gates.build;
  if (buildGate && typeof buildGate.run === 'string') {
    const out = runCommand(buildGate.run, projectRoot);
    const scriptPath = path.resolve(projectRoot, 'scripts/build.sh');
    let content = '';
    try {
      content = existsSync(scriptPath) ? execSync(`cat ${JSON.stringify(scriptPath)}`, { encoding: 'utf8' }) : '';
    } catch {
      content = '';
    }
    const buildEnvCause = out.exitCode !== 0 ? detectEnvFailure(out.raw) : null;
    if (!content.includes(PLACEHOLDER_SENTINEL) && out.exitCode !== 0 && buildEnvCause) {
      findings.push(finding('weak', 'D3b', `构建门禁因环境受限未跑起来（非代码问题：${buildEnvCause}）`,
        `命令 \`${out.command}\` 退出码 ${out.exitCode}`,
        '**这不算代码失败**：修好环境后重跑。在此之前本仓的构建结论是"未验证"，不是"失败"'));
    } else if (!content.includes(PLACEHOLDER_SENTINEL) && out.exitCode !== 0 && buildGate.baseline_exempt) {
      findings.push(finding('weak', 'D3b', '构建门禁失败，但本仓已登记基线豁免',
        `命令 \`${out.command}\` 退出码 ${out.exitCode}；豁免原因：${buildGate.baseline_exempt.reason || '(未注明)'}`,
        '可以开工，但门禁结果会显示为 ■ 基线豁免，不计为通过；豁免只减不增'));
    } else if (!content.includes(PLACEHOLDER_SENTINEL) && out.exitCode !== 0) {
      const rawB = out.raw || '';
      const missingBuildTool = out.exitCode === 127 || /command not found|No module named|not recognized/i.test(rawB);
      findings.push(finding('block', 'D3b', missingBuildTool
        ? '构建门禁的构建工具还没装（命令跑不起来）'
        : '构建门禁当前是失败的',
      `命令 \`${out.command}\` 退出码 ${out.exitCode}；输出尾部：${out.outputTail || '(空)'}`,
      (missingBuildTool
        ? '安装构建工具，或把 build.run 改成本仓可用的命令'
        : '先让构建通过：看输出尾部定位原因') + '。**门禁失败 ≠ 可以开工**'));
    }
  }

  // ── D4 门禁脚本是否存在且可执行 ─────────────────────────────
  for (const [name, def] of Object.entries(gates)) {
    const targets = [def?.run, def?.negative_control].filter((c) => typeof c === 'string' && /^\.?\/?[\w./-]+\.sh\b/.test(c.trim()));
    for (const cmd of targets) {
      const scriptPath = cmd.trim().split(/\s+/).find((t) => t.endsWith('.sh'));
      if (!scriptPath) continue;
      const full = path.resolve(projectRoot, scriptPath);
      if (!existsSync(full)) {
        findings.push(finding('block', 'D4', `门禁 ${name} 引用的脚本不存在`,
          `${scriptPath} → ${full}`,
          `创建 ${scriptPath} 并 chmod +x，或把 devflow.json 里的命令改成本仓真实存在的命令`));
        continue;
      }
      const st = statSync(full);
      if ((st.mode & 0o111) === 0) {
        findings.push(finding('block', 'D4', `门禁 ${name} 引用的脚本没有执行权限`,
          `${scriptPath} 权限 ${st.mode.toString(8).slice(-3)}`,
          `chmod +x ${scriptPath}`));
      }
      // 「债务包装」检测（比哨兵更隐蔽的一种假绿）：
      //   lint.sh 里写着"本仓有既有债务"却 exit 0 —— 门禁永远不会失败，等于空转。
      //   必须显式登记 baseline_debt 才放行（并显示为削弱），否则判阻断。
      try {
        const probe = def === gates[name] ? def : null;
        const content = execSync(`cat ${JSON.stringify(full)}`, { encoding: 'utf8' });
        const claimsDebt = /devflow:existing-debt|既有债务|债务基线/.test(content);
        const gateDecl = (config?.gates || {})[name] || {};
        if (claimsDebt && !gateDecl.baseline_debt) {
          findings.push(finding('block', 'D4', `门禁 ${name} 的脚本声称"存在既有债务"但未登记 baseline_debt`,
            `${scriptPath} 含债务包装说明，但 devflow.json 的 gates.${name} 没有 baseline_debt 声明`,
            `两步：① 在 gates.${name} 加 "baseline_debt": { "reason": "...", "clear_when": "..." } 声明这笔债务；`
            + `② 把脚本改成**真实执行**对应命令（如 exec npx eslint src），让债务可见。`
            + `只声明不改脚本，等于把空转合法化 —— 不要那么做`));
        } else if (claimsDebt && gateDecl.baseline_debt) {
          findings.push(finding('weak', 'D4', `门禁 ${name} 是债务包装（已登记 baseline_debt）`,
            `原因：${gateDecl.baseline_debt.reason || '(未注明)'}；清除条件：${gateDecl.baseline_debt.clear_when || '(未注明)'}`,
            '可以开工，但该门禁**不计为通过**。请按清除条件尽快把脚本换成真实命令'));
        }
      } catch {
        /* 读取失败不阻塞体检 */
      }
      try {
        const content = execSync(`cat ${JSON.stringify(full)}`, { encoding: 'utf8' });
        if (PLACEHOLDER_MARKERS.some((m) => content.includes(m))) {
          findings.push(finding('block', 'D4', `门禁 ${name} 仍是 init 生成的占位脚本（该门禁现在必然失败）`,
            `${scriptPath} 含哨兵 "${PLACEHOLDER_SENTINEL}"，说明还没换成真实命令`,
            `把 ${scriptPath} 替换为你项目的真实命令，并删掉哨兵那一行。在改完之前，这个门禁不会检查任何东西、并且一定失败`));
        }
      } catch {
        /* 读取失败不阻塞体检 */
      }
    }
  }

  // ── D5 命令是否以管道收尾（退出码可能被吞） ─────────────────
  for (const [name, def] of Object.entries(gates)) {
    if (typeof def?.run === 'string' && /\|\s*[a-zA-Z][\w-]*\s*$/.test(def.run.trim())) {
      findings.push(finding('weak', 'D5', `门禁 ${name} 的命令以管道收尾，退出码可能不是你的构建结论`,
        `run=\`${def.run}\``,
        `去掉末尾的管道（例如 \`... | tail\`），或改成先把输出重定向到文件再用退出码判断。管道退出码取自最后一个命令，会把失败判成成功`));
    }
  }

  // ── D6 项目根标记 ──────────────────────────────────────────
  if (!existsSync(path.join(projectRoot, '.devflow'))) {
    findings.push(finding('weak', 'D6', '项目根仅凭 devflow.json 判定（缺少 .devflow/ 目录）',
      `项目根：${projectRoot}；标记来源：${marker}`,
      '先执行一次 `devflow init` 生成 .devflow/ 目录。双标记（devflow.json + .devflow/）能避免同名文件劫持项目根'));
  }
  if (marker === 'unknown' || marker === 'devflow.json') {
    findings.push(finding('info', 'D6', '建议固定项目根，避免多项目工作区里认错目录',
      `当前标记来源：${marker}`,
      '可选：设置环境变量 DEVFLOW_ROOT=<项目绝对路径>，或在命令上加 --root <路径>'));
  }

  // ── D2b 负向对照是否真的有失败证据（与门禁层同一口径） ──
  // 背景：门禁层（evidence.mjs）已要求"退出码非 0 **且** 输出含失败证据"，
  // 但体检层原先只看退出码 ⇒ 两层口径分叉：`exit 1` 的空转脚本会被 doctor 判为"健康"。
  // 实测踩到：负向对照脚本只有 `exit 1`（零输出），doctor 仍报"门禁配置健康：可以开工"。
  for (const [gate, def] of Object.entries(config?.gates || {})) {
    if (!def.negative_control) continue;
    const scriptPath = path.resolve(projectRoot, String(def.negative_control));
    const rel = path.relative(projectRoot, scriptPath);
    if (!existsSync(scriptPath)) {
      findings.push(finding('block', 'D2b', `门禁 ${gate} 的负向对照脚本不存在`,
        `声明为 ${def.negative_control}，但文件不存在`,
        '补上该脚本（内容必须非零退出并输出失败原因）'));
      continue;
    }
    try {
      const out = runCommand(def.negative_control, projectRoot, 60 * 1000);
      if (out.exitCode === 0) continue;   // 恒真由 D2/门禁层负责，这里只管"空转"
      if (!hasFailureEvidence(out.raw)) {
        findings.push(finding('weak', 'D2b', `门禁 ${gate} 的负向对照没有输出失败证据（疑似空转）`,
          `命令 \`${out.negative_control || def.negative_control}\` 退出码 ${out.exitCode}，但输出中无 FAIL/AssertionError/失败计数`,
          '让负向对照脚本输出明确的失败原因（如 echo "AssertionError: ..." >&2 后再 exit 1）；'
          + '否则无法区分"真的失败"与"命令根本没跑起来"'));
      }
    } catch { /* 执行异常不阻塞体检 */ }
  }

  // ── D14 架构声明是否存在；D15 任务分派是否覆盖各层 ──
  // D14：没有仓级架构声明时，新变更只能各写各的（技术栈/分层/约束必然漂移）。
  //      属提示（不阻断）—— 存量仓可逐步补。
  // D15：任务表有「负责层」但没人保证覆盖 —— 声明了 data/ui 的变更却没有对应层的任务，
  //      会在实现后才发现"漏了一端"。这条是"分派漏人"的机械检查。
  try {
    const archPath = path.join(projectRoot, '.devflow', 'architecture.md');
    const hasArch = existsSync(archPath);
    if (!hasArch) {
      findings.push(finding('info', 'D14', '缺少仓级架构声明（.devflow/architecture.md）',
        '未找到该文件',
        '运行 `devflow fill --file architecture.md` 或从 templates/architecture.md 复制，'
        + '填写技术栈、分层约定、架构决策与不可违反的约束。'
        + '作用：新变更继承架构约束，而不是每次重写（也供 devflow clarify 追加项目必答项）'));
    }
    // D15：变更面 → 应有责任层的映射
    const itemsRoot = path.join(projectRoot, '.devflow', 'items');
    const SURFACE_LAYER = { ui: ['前端'], data: ['数据库', '后端'], contract: ['契约'], interface: ['契约', '后端'] };
    if (existsSync(itemsRoot)) {
      for (const name of readdirSync(itemsRoot)) {
        const tf = path.join(itemsRoot, name, 'TASKS.md');
        if (!existsSync(tf)) continue;
        const ttext = readFileSync(tf, 'utf8');
        const rows = ttext.split('\n').filter((l) => /^\s*\|\s*T-?\d+\s*\|/.test(l));
        if (!rows.length) continue;
        const hIdx = ttext.split('\n').findIndex((l) => /^\s*\|/.test(l) && /负责层/.test(l));
        const hc = hIdx >= 0 ? ttext.split('\n')[hIdx].split('|').map((c) => c.trim()).slice(1, -1) : [];
        const iLayer = hc.indexOf('负责层'); const iCmd = hc.indexOf('验收命令');
        const layers = new Set();
        const noCmd = [];
        for (const l of rows) {
          const c = l.split('|').map((x) => x.trim()).slice(1, -1);
          if (iLayer >= 0 && c[iLayer]) layers.add(c[iLayer]);
          if (iCmd >= 0 && (!c[iCmd] || /（.*）/.test(c[iCmd]))) noCmd.push(c[0] || '?');
        }
        // 从 SPEC 读变更面
        let surface = [];
        const sf = path.join(itemsRoot, name, 'SPEC.md');
        if (existsSync(sf)) {
          const m = /change_surface\s*\|\s*([^|\n]+)/.exec(readFileSync(sf, 'utf8'));
          if (m) surface = m[1].split(/[、,，\s]+/).filter(Boolean);
        }
        const needLayers = new Set();
        for (const sfx of surface) for (const ly of (SURFACE_LAYER[sfx] || [])) needLayers.add(ly);
        const missingLayers = [...needLayers].filter((ly) => !layers.has(ly));
        if (missingLayers.length) {
          findings.push(finding('weak', 'D15', `变更 ${name} 的任务未覆盖应有责任层`,
            `变更面=${surface.join('、') || '(未声明)'}；已有层=${[...layers].join('、') || '(无)'}；缺=${missingLayers.join('、')}`,
            '为缺失的层补任务（TASKS.md 的「负责层」列），或说明为何该层不需要独立任务。'
            + '漏层通常意味着实现到一半才发现"少了一端"'));
        }
        if (noCmd.length) {
          findings.push(finding('weak', 'D15', `变更 ${name} 有任务未填验收命令`,
            `任务：${noCmd.slice(0, 6).join('、')}`,
            '每条任务都要有可运行的验收命令 —— 否则无法判断它是否真的做完'));
        }
      }
    }
  } catch { /* 不阻塞体检 */ }

  // ── D13 存储位置是否合规（spec/storage.json STO-2/STO-3）──
  // 规则：① 人写的产物在 `.devflow/items/`、机器状态在 `.devflow/.local/items/`；
  //       ② 工具自身产物不得落在**仓库根目录**（游离产物没有归属、也没有留存策略）。
  try {
    // ① 根目录游离产物（形如 devflow-*.md 或明显的过程文档）
    const stray = readdirSync(projectRoot).filter((n) => /^devflow-.*\.md$/i.test(n)
      || /^(体检结果|验证边界|交付就绪包|局限与缺口)\.md$/.test(n));
    if (stray.length) {
      findings.push(finding('weak', 'D13', `仓库根目录有游离产物（${stray.length} 个）`,
        stray.join('、'),
        '这些文件没有归属：不会被评审、也没有留存策略。按 spec/storage.json：'
        + '决策与证据放 `.devflow/items/<变更>/`（入库）；机器状态与渲染产物放 `.devflow/.local/`（gitignore）；'
        + '需别人排期的缺口生成 issue 文本，而不是文档'));
    }
    // ② 旧布局：机器状态仍写在 items/ 里（未迁移）
    const legacyDirs = [];
    const itemsRoot = path.join(projectRoot, '.devflow', 'items');
    if (existsSync(itemsRoot)) {
      for (const n of readdirSync(itemsRoot)) {
        const d = path.join(itemsRoot, n);
        if (!statSync(d).isDirectory()) continue;
        if (existsSync(path.join(d, 'STATE')) || existsSync(path.join(d, 'STATUS.json'))) legacyDirs.push(n);
      }
    }
    if (legacyDirs.length) {
      findings.push(finding('info', 'D13', `有 ${legacyDirs.length} 个变更仍是旧存储布局（机器状态在 items/ 里）`,
        legacyDirs.slice(0, 5).join('、'),
        '运行 `devflow migrate-storage` 迁移到 `.devflow/.local/items/`；'
        + '迁移后 items/ 只剩人写的产物（可入库），机器状态不再产生无意义冲突'));
    }
  } catch { /* 不阻塞体检 */ }

  // ── D12 任务切分是否可并行（角色约束 R1/R6 的机械化）──
  // R1：一个子代理 = 一个写入范围，任意两个的读写文件集合不得相交。
  // R6：分组必须按文件集合是否相交计算，不得凭感觉切分。
  //
  // 设计要点（吃过的教训）：**判定不了时必须显式说明**，不能静默跳过 ——
  // 否则 D12 就变成"看起来在检查、其实什么都没查"。因此存在任务表却解析不出写入范围时，
  // 输出一条 info（而不是什么都不说），把"未判定"暴露出来。
  try {
    const itemsDir2 = path.join(projectRoot, '.devflow', 'items');
    if (existsSync(itemsDir2)) {
      for (const name of readdirSync(itemsDir2)) {
        const tf = path.join(itemsDir2, name, 'TASKS.md');
        if (!existsSync(tf)) continue;
        const text = readFileSync(tf, 'utf8');
        // 任务表：以 `|` 开头且含 "写入范围" 的表头
        const lines = text.split('\n');
        const headerIdx = lines.findIndex((l) => /^\s*\|/.test(l) && /写入范围/.test(l));
        if (headerIdx < 0) {
          findings.push(finding('info', 'D12', `变更 ${name} 的任务表缺少「写入范围」列，无法判定切分是否可并行`,
            'TASKS.md 中没有找到含「写入范围」的表头',
            '按 templates/TASKS.md 补齐该列（写入范围用于计算子代理切分；相交的任务必须合并给同一执行者）'));
          continue;
        }
        const cols = lines[headerIdx].split('|').map((c) => c.trim());
        const iRange = cols.indexOf('写入范围');
        const iTask = cols.indexOf('T');
        const entries = [];
        for (let i = headerIdx + 1; i < lines.length; i += 1) {
          const line = lines[i];
          if (!/^\s*\|/.test(line)) break;                      // 表格结束
          if (/^\s*\|[\s:|-]+\|\s*$/.test(line)) continue;     // 分隔行
          const cells = line.split('|').map((c) => c.trim());
          const id = iTask >= 0 ? cells[iTask] : '';
          const range = cells[iRange] || '';
          if (!id || !range || /^\{\{/.test(range)) continue;     // 未填写的占位行跳过
          const paths = range.split(/[、,，;；\s]+/).map((x) => x.trim())
            .filter((x) => x && !/^（.*）$/.test(x));
          if (paths.length) entries.push({ id, paths });
        }
        if (!entries.length) {
          findings.push(finding('info', 'D12', `变更 ${name} 的任务写入范围尚未填写，无法判定切分`,
            '任务表里没有可解析的写入范围（可能还是模板占位）',
            '填写每条任务的写入范围后再判；未判定不等于没有冲突'));
          continue;
        }
        const hits = [];
        for (let i = 0; i < entries.length; i += 1) {
          for (let j = i + 1; j < entries.length; j += 1) {
            const overlap = entries[i].paths.filter((a) => entries[j].paths
              .some((b) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`)));
            if (overlap.length) hits.push(`${entries[i].id} 与 ${entries[j].id} 相交：${[...new Set(overlap)].join('、')}`);
          }
        }
        if (hits.length) {
          findings.push(finding('weak', 'D12', `变更 ${name} 的任务写入范围有相交（违背 R1/R6）`,
            hits.slice(0, 5).join('；'),
            '相交的任务不能交给不同执行者并行（会互相覆盖）。① 合并为一个任务；'
            + '② 或把写入范围拆到不相交的文件（R6：按文件集合计算，不凭感觉切分）'));
        }
      }
    }
  } catch (e) {
    // **诊断自身出错必须暴露**：D12 曾因漏导入 readdirSync 而抛异常，
    // 被静默的 catch 吞掉 ⇒ 这项检查形同不存在，而体检照常输出"通过"。
    // 因此这里把异常变成一条 findings，让"检查坏了"可见（本产品最该杜绝的失败模式）。
    findings.push(finding('weak', 'D12', `任务切分检查自身执行失败：${e.message}`,
      String(e.stack || e.message).split('\n').slice(0, 2).join(' '),
      '这是**检查器缺陷**而非项目问题，请向 Kit 反馈；在此期间"写入范围是否相交"未被判定'));
  }

  // ── D7 变更目录状态 ───────────────────────────────────────
  const itemsDir = path.join(projectRoot, '.devflow', 'items');
  if (existsSync(itemsDir)) {
    const entries = execSync(`ls -1 ${JSON.stringify(itemsDir)}`, { encoding: 'utf8' }).split('\n').filter(Boolean);
    const nonDirs = entries.filter((e) => !statSync(path.join(itemsDir, e)).isDirectory());
    if (nonDirs.length) {
      findings.push(finding('weak', 'D7', '变更目录下有非目录文件',
        nonDirs.join('、'),
        '一个变更 = 一个目录。把这些文件移入对应变更目录，或删掉'));
    }
  }

  // ── D10 适配器正则自检（避免"官方模板自己就是错的"） ────────
  if (kitRoot) {
    try {
      const adapters = loadAdapters(kitRoot);
      const problems = auditAdapterRegex(adapters);
      if (problems.length) {
        findings.push(finding('weak', 'D10', '内置适配器的计数正则自检未通过',
          problems.join('；'),
          '这是 Kit 自身的问题：请修正 spec/adapters.json 里对应栈的 count_regex 或 sample_output'));
      } else {
        findings.push(finding('info', 'D10', '内置适配器自检通过',
          `${Object.keys(adapters).length} 个技术栈的 count_regex 都能抓到各自声明的样本输出`,
          '无需处理'));
      }
    } catch (error) {
      findings.push(finding('weak', 'D10', '适配器定义无法读取', error.message, '检查 spec/adapters.json 是否为合法 JSON'));
    }
  }

  // ── D11 门禁声明了 count_regex，但实际输出抓不到计数 ──────────
  for (const [name, def] of Object.entries(gates)) {
    if (!def?.count_regex || typeof def.run !== 'string') continue;
    const out = runCommand(def.run, projectRoot);
    if (out.exitCode !== 0) continue;   // 命令失败已由 D2/D3 覆盖
    let m = null;
    try {
      m = new RegExp(def.count_regex).exec(out.raw || '');
    } catch (error) {
      findings.push(finding('block', 'D11', `门禁 ${name} 的 count_regex 语法错误`,
        `${def.count_regex} → ${error.message}`,
        '修正 count_regex 的正则语法（注意反斜杠在 JSON 里要写成 \\\\d）'));
      continue;
    }
    if (!m) {
      findings.push(finding('weak', 'D11', `门禁 ${name} 声明了计数下限，但实际输出抓不到计数`,
        `count_regex=\`${def.count_regex}\` 与真实输出不匹配；输出尾部：${out.outputTail || '(空)'}`,
        '两种修法：① 把 count_regex 调成该命令真实输出的形态（可参考 devflow adapters 里各栈的模板）；② 若该门禁不需要计数（如纯构建），去掉 count_regex 与 require_min_tests'));
    }
  }

  // ── D8 指令链体积 ──────────────────────────────────────────
  const chain = instructionChainKb(cwd, projectRoot);
  if (chain.kb > 64) {
    findings.push(finding('weak', 'D8', '指令链体积超过上限（超限时宿主会优先丢弃较宽泛的文件）',
      `合计 ${chain.kb}k 字符，涉及：${chain.files.join('、') || '(无)'}`,
      '把常驻指令文件里"不是每轮都要用"的内容移到按需加载的文档，保持根级指令精简'));
  } else {
    findings.push(finding('info', 'D8', '指令链体积正常',
      `合计 ${chain.kb}k 字符（上限 64k），涉及：${chain.files.join('、') || '(无)'}`,
      '无需处理'));
  }

  // ── D9 Kit 版本 ───────────────────────────────────────────
  const want = config?.devflow?.kit;
  if (!want) {
    findings.push(finding('info', 'D9', '未声明 kit 版本约束',
      'devflow.kit 未声明',
      `建议写 "kit": "^${String(kitVersion).split('.').slice(0, 2).join('.')}.0"，版本不满足时会被 G0 拦下，而不是静默降级`));
  }

  // ── 结论 ─────────────────────────────────────────────────
  const sorted = findings.sort((a, b) => SEVERITIES[a.severity].order - SEVERITIES[b.severity].order);
  const block = sorted.filter((f) => f.severity === 'block');
  const weak = sorted.filter((f) => f.severity === 'weak');
  const verdict = {
    trustworthy: block.length === 0,
    summary: block.length
      ? `门禁**不可信**：有 ${block.length} 项会骗过你`
      : weak.length
        ? `门禁可用，但有 ${weak.length} 项强度被削弱`
        : '门禁配置健康：可以开工',
    counts: { block: block.length, weak: weak.length, info: sorted.length - block.length - weak.length },
    blockIds: block.map((f) => f.id),
  };
  return { findings: sorted, verdict };
}
