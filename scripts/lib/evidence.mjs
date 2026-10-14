/**
 * 门禁执行与证据留痕。
 * 证据形态契约：每条结果必须含 命令原文 / 退出码 / 输出尾部 / 起止时间 / 判定。
 * 注意：绝不使用管道退出码判断结论 —— 引擎取的是被调用命令自身的退出码。
 */
import { execSync } from 'node:child_process';
import { isEnvRestricted } from './env-failure.mjs';

const TAIL_LINES = 12;
const TAIL_MAX = 2000;

export function tail(text, lines = TAIL_LINES, maxChars = TAIL_MAX) {
  const arr = String(text || '').replace(/\r/g, '').split('\n').filter((l) => l.trim() !== '');
  const sliced = arr.slice(-lines).join('\n');
  return sliced.length > maxChars ? sliced.slice(-maxChars) : sliced;
}

/**
 * 执行一条命令并留证据。
 * @param {string} command  命令原文（必须以自身退出码表达结论）
 * @param {string} cwd
 * @returns {{command:string, exitCode:number, outputTail:string, durationMs:number, startedAt:string, raw:string}}
 */
export function runCommand(command, cwd, timeoutMs = 15 * 60 * 1000) {
  const startedAt = new Date().toISOString();
  const t0 = Date.now();
  let raw = '';
  let exitCode = 0;
  try {
    raw = execSync(command, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs });
    exitCode = 0;
  } catch (error) {
    exitCode = typeof error.status === 'number' ? error.status : 1;
    raw = `${error.stdout || ''}${error.stderr || ''}`;
  }
  return {
    command,
    exitCode,
    outputTail: tail(raw),
    durationMs: Date.now() - t0,
    startedAt,
    raw: String(raw || ''),
  };
}

/**
 * 执行项目声明的门禁，并校验负向对照。
 *
 * 判定规则（对应 spec/gates.json 的 G3）：
 *   命令非零                     → fail（阻断）
 *   命令为零 + 负向对照返回非零   → pass
 *   命令为零 + 负向对照返回零     → unverified（⚠，恒真门禁，不可信）
 *   命令为零 + 未声明负向对照     → unverified（⚠）
 * @returns {{records:Array, summary:Object}}
 */
export function runProjectGates(config, projectRoot) {
  const gates = config.gates || {};
  const records = [];
  for (const [name, def] of Object.entries(gates)) {
    if (!def || typeof def.run !== 'string') {
      records.push({
        gate: name,
        kind: 'project',
        project: path_basename(projectRoot),
        command: '(未声明 run)',
        exitCode: null,
        outputTail: '',
        startedAt: new Date().toISOString(),
        durationMs: 0,
        verdict: 'blocked',
        notes: ['门禁未声明可执行命令'],
      });
      continue;
    }

    // 真实构建可能很慢：允许门禁声明自己的超时（默认 15 分钟，上限 60 分钟）
    const gateTimeout = Math.min(Number(def.timeout_ms) || 15 * 60 * 1000, 60 * 60 * 1000);
    const executed = runCommand(def.run, projectRoot, gateTimeout);
    const record = {
      gate: name,
      kind: 'project',
      project: path_basename(projectRoot),
      command: executed.command,
      exitCode: executed.exitCode,
      outputTail: executed.outputTail,
      startedAt: executed.startedAt,
      durationMs: executed.durationMs,
      countRegex: def.count_regex || null,
      requiredMin: typeof def.require_min_tests === 'number' ? def.require_min_tests : null,
      exemption: null,
      notes: [],
    };

    const count = def.count_regex ? matchCount(executed.raw, def.count_regex) : null;
    record.testCount = count;
    // 便于排障：多类工程里计数是"逐类汇总"的结果，记下匹配行数
    if (def.count_regex) {
      try {
        record.countMatches = ((executed.raw || '').match(new RegExp(def.count_regex, 'g')) || []).length;
      } catch {
        record.countMatches = null;
      }
    }

    // ① 命令自身失败 → 先区分「环境受限」与「代码失败」（两者结论完全不同）
    if (executed.exitCode !== 0) {
      if (detectEnvRestricted(executed.raw)) {
        record.verdict = 'unverified';
        record.envRestricted = true;
        record.notes.push('环境受限导致门禁未跑起来（权限/网络/外部依赖缺失）⇒ 结论是"未验证"，不是"失败"');
      } else {
        record.verdict = 'fail';
        if (def.baseline_exempt) {
          record.exemption = def.baseline_exempt;
          record.notes.push('存在基线豁免声明，但本次命令确实失败，豁免不适用');
        }
      }
      records.push(record);
      continue;
    }

    // ② 计数下限（测试数为 0 不许判绿）
    if (record.requiredMin !== null) {
      if (count === null) {
        record.notes.push('未取到测试计数：标记为证据未知');
      } else if (count < record.requiredMin) {
        if (def.baseline_exempt) {
          record.exemption = def.baseline_exempt;
          record.verdict = 'exempt';
          record.notes.push(`测试数 ${count} < 下限 ${record.requiredMin}，引用基线豁免（${def.baseline_exempt.reason || '未注明原因'}）`);
          records.push(record);
          continue;
        }
        record.verdict = 'fail';
        record.notes.push(`测试数 ${count} < 下限 ${record.requiredMin}`);
        records.push(record);
        continue;
      }
    }

    // ③ 负向对照（诚实标签）
    if (!def.negative_control) {
      record.verdict = 'unverified';
      record.notes.push('未声明负向对照：结果标记为未验证通过（⚠），不得显示为通过');
      records.push(record);
      continue;
    }
    const control = runCommand(def.negative_control, projectRoot, 5 * 60 * 1000);
    record.controlCommand = control.command;
    record.controlExitCode = control.exitCode;
    record.controlOutputTail = control.outputTail;
    if (control.exitCode === 0) {
      record.verdict = 'unverified';
      record.notes.push('负向对照返回 0：门禁恒真，判定该门禁不可信（⚠）');
    } else if (def.negative_control_expect_markers !== false && !hasFailureEvidence(control.raw)) {
      // 退出码非零但**没有失败证据** ⇒ 疑似空转（如测试被 exclude ⇒ No test files found）
      record.verdict = 'unverified';
      record.notes.push(
        '负向对照退出码非 0，但输出中没有任何失败证据（无 FAIL/AssertionError/失败计数）'
        + ' ⇒ 疑似空转（测试被配置排除、或命令不存在），不能判为门禁可信。'
        + `输出尾部：${(control.outputTail || '').slice(-160)}`,
      );
    } else {
      record.verdict = 'pass';
      record.notes.push(`负向对照返回 ${control.exitCode} 且输出含失败证据，门禁可信`);
    }
    records.push(record);
  }

  const summary = {
    total: records.length,
    pass: records.filter((r) => r.verdict === 'pass').length,
    fail: records.filter((r) => r.verdict === 'fail').length,
    unverified: records.filter((r) => r.verdict === 'unverified').length,
    exempt: records.filter((r) => r.verdict === 'exempt').length,
    blocked: records.filter((r) => r.verdict === 'blocked').length,
  };
  summary.blocking = summary.fail > 0 || summary.blocked > 0;
  return { records, summary };
}

/**
 * 从输出里提取测试计数。
 *
 * 关键（试点发现的真实缺陷）：多模块 / 多测试类工程里，测试框架会**逐类打印**汇总行
 * （Maven surefire 每个测试类一行 "Tests run: N"，Gradle/pytest 同理），
 * 只取第一行会把总数算小 —— 曾经把 15 个测试记成 4 个。
 * 因此默认**累加所有匹配**；输出里只有一行时结果与原来完全一致。
 */
export function detectEnvRestricted(raw) {
  return isEnvRestricted(raw);
}

/**
 * 负向对照的"失败证据"标记。
 *
 * 为什么需要：门禁原先只看"负向对照退出码 ≠ 0"就宣称可信，但**退出码 1 有多种来源** ——
 * 真实踩到过：测试框架因 `exclude` 排除了哨兵文件，报 "No test files found" 而返回 1，
 * 断言**从未执行**，门禁却显示"负向对照返回 1，门禁可信"（负向对照空转）。
 * 因此必须要求输出里出现**明确的失败证据**。
 */
const FAILURE_MARKERS = [
  /Failed Tests?\s*\d+/i,
  /AssertionError|Expected\b/i,
  /BUILD FAILURE/,
  /Failures?:\s*[1-9]|\d+\s+tests?\s+failed/i,
  /errors?:\s*[1-9]\d*/i,
  /Traceback \(most recent call last\)/,
  /--- FAIL:/,
  /FAIL\s+\S+/,
  // —— 以下为实测补充：真实工程里"违规/编译错误"的常见输出形态 ——
  /error TS\d+/i,                 // TypeScript 编译错误：src/x.ts(2,7): error TS2322
  /\d+\s+problems?\s*\(\s*[1-9]\d*\s+errors?/i,  // eslint：✖ 3 problems (3 errors, 0 warnings)
  /\berror\b.*\b(not assignable|Cannot find name|cannot find symbol|expected)\b/i,
  /COMPILATION ERROR/i,            // Maven/Javac
  /\[ERROR\]/,                    // Maven 的 [ERROR] 行
];

export function hasFailureEvidence(raw) {
  return FAILURE_MARKERS.some((re) => re.test(String(raw || '')));
}

function matchCount(raw, regex) {
  try {
    const re = new RegExp(regex, 'g');
    let total = 0;
    let found = false;
    let m;
    while ((m = re.exec(raw)) !== null) {
      if (m[1] === undefined) continue;
      const n = Number(m[1]);
      if (Number.isFinite(n)) {
        total += n;
        found = true;
      }
      if (m.index === re.lastIndex) re.lastIndex += 1;   // 防零宽匹配死循环
    }
    return found ? total : null;
  } catch {
    return null;
  }
}

function path_basename(p) {
  const parts = String(p).split('/').filter(Boolean);
  return parts[parts.length - 1] || String(p);
}
