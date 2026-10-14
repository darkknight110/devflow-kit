/**
 * 基础标准检查器。
 *
 * 定位：把 `spec/standards.json` 从"文档"变成"可执行判定"。
 * 对当前项目逐条判定 **满足 / 未满足 / 不适用（附原因）**，
 * 未满足且未登记豁免时按 `consequence` 给出 block / weaken / info。
 *
 * 为什么需要它：本产品真实踩过的坑是"声明与实现静默背离"——
 * 配置里写着某项已达成，而门禁恰好永远不会揭穿它。
 * 因此凡是"声明"，都必须有一条可执行校验。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { resolveArtifactIn } from './gate.mjs';

const readJson = (p, dflt = null) => {
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return dflt;
  }
};

/** 项目里声明的豁免（baseline_exempt / baseline_debt）按门禁名索引 */
function collectExemptions(config) {
  const out = new Map();
  for (const [gate, def] of Object.entries(config?.gates || {})) {
    const ex = def.baseline_exempt || def.baseline_debt;
    if (ex) out.set(gate, { gate, ex, decl: def });
  }
  return out;
}

/** 项目自定义规则（devflow.json 的 standards 段） */
function collectOverrides(config) {
  const s = config?.standards || {};
  const overrides = new Map();
  for (const o of s.overrides || []) overrides.set(o.id, o);
  const added = s.additional || [];
  return { overrides, added };
}

const notApplicable = (reason) => ({ verdict: 'not-applicable', detail: reason });

/**
 * 逐条判定。
 * @param {object} args
 * @param {object} args.standards  spec/standards.json 解析结果
 * @param {object} args.config     项目 devflow.json 解析结果
 * @param {object} args.doctor     体检结果（diagnose 的返回值，可选）
 * @param {Array}  args.records    最近一次门禁运行记录（STATUS.json 的 lastRun.records，可选）
 * @param {string} args.itemDir    当前变更目录（可选，用于证据类判定）
 */
export function checkStandards({ standards, config, doctor = null, records = [], itemDir = null }) {
  const exemptions = collectExemptions(config);
  const { overrides, added } = collectOverrides(config);
  const gates = config?.gates || {};
  const all = [...(standards?.standards || []), ...added];
  const results = [];

  const findingsOf = (id) => (doctor?.findings || []).filter((f) => f.id === id);
  const recordOf = (gate) => (records || []).find((r) => r.gate === gate);
  const testRec = recordOf('test');

  for (const std of all) {
    let verdict = 'unmet';
    let detail = '';

    switch (std.id) {
      case 'STD-GATE-TEST-RUNS': {
        if (!gates.test) { verdict = 'not-applicable'; detail = '本仓未声明 test 门禁'; break; }
        const envWeak = findingsOf('D3').some((f) => /环境受限/.test(f.title));
        if (envWeak) { verdict = 'not-applicable'; detail = '环境受限，无法判定是否空转'; break; }
        const exempt = exemptions.get('test');
        const placeholderWeak = findingsOf('D3').some((f) => /没有任何测试在跑/.test(f.title));
        if (placeholderWeak) {
          verdict = 'unmet';
          detail = '测试门禁通过但没有任何测试在跑（空转）';
        } else if (!testRec) {
          // 没有门禁记录 ⇒ **无法判定**，绝不能显示为"满足"
          // （这正是本产品反复踩的坑：无法判定被当成通过）
          verdict = 'not-applicable';
          detail = '未取到 test 门禁运行记录，无法判定是否空转（先跑一次 gate run）';
        } else if (testRec.exitCode === 0 && !(Number(testRec.testCount) > 0)
          && Number((gates.test || {}).require_min_tests || 0) > 0) {
          // **通过却计数为 0**：声明了最少测试数却抓到 0 —— 典型假通过
          // （实测踩到：某仓记录写着 exit=0 count=0，而配置要求 require_min_tests=8）
          verdict = 'unmet';
          detail = `test 门禁 exit=0 但计数为 ${testRec.testCount ?? '空'}，`
            + `而配置要求至少 ${gates.test.require_min_tests} 个测试 ⇒ 计数未生效（正则或输出格式不符）`;
        } else {
          verdict = 'met';
          detail = `test 门禁 exit=${testRec.exitCode} 计数=${testRec.testCount ?? '未声明'}`;
        }
        if (placeholderWeak && exempt) detail += `；已登记豁免：${exempt.ex.reason || '(未注明)'}`;
        break;
      }

      case 'STD-GATE-NEGATIVE-CONTROL': {
        const missing = Object.keys(gates).filter((g) => !gates[g].negative_control);
        verdict = missing.length ? 'unmet' : 'met';
        detail = missing.length ? `缺少负向对照的门禁：${missing.join('、')}` : '全部门禁都声明了负向对照';
        break;
      }

      case 'STD-GATE-NEGATIVE-EVIDENCE': {
        // 判定依据统一为 D2b（体检层与门禁层同口径）；D2 只负责"恒真"（退出码 0）
        const weak = findingsOf('D2b');
        const missing = findingsOf('D2b').filter((f) => f.severity === 'block');
        if (missing.length) { verdict = 'unmet'; detail = missing[0].title; break; }
        if (weak.length) { verdict = 'unmet'; detail = weak[0].evidence; break; }
        verdict = 'met';
        detail = '负向对照均含失败证据';
        break;
      }

      case 'STD-GATE-HONEST-EXIT': {
        const blocks = findingsOf('D4').filter((f) => f.severity === 'block');
        if (blocks.length) { verdict = 'unmet'; detail = blocks[0].title; break; }
        // 除 D4（脚本内容）外，还必须看**门禁记录**：门禁失败但只在配置里声明了 baseline_debt
        // ⇒ 这是"诚实的失败"，应显示为削弱，绝不能显示为满足
        // （本产品反复踩的坑：只要门禁没"谎报"，就被当成满足）
        const failing = (records || []).filter((r) => r.exitCode !== 0);
        const debtDeclared = failing.filter((r) => {
          const d = gates[r.gate] || {};
          return d.baseline_debt || d.baseline_exempt;
        });
        const undeclared = failing.filter((r) => !(gates[r.gate] || {}).baseline_debt
          && !(gates[r.gate] || {}).baseline_exempt);
        if (undeclared.length) {
          verdict = 'unmet';
          detail = `门禁失败且未登记豁免：${undeclared.map((r) => r.gate).join('、')}`;
          break;
        }
        if (debtDeclared.length) {
          verdict = 'unmet';
          detail = `门禁失败但已登记债务：${debtDeclared
            .map((r) => `${r.gate}(${(gates[r.gate].baseline_debt || gates[r.gate].baseline_exempt).clear_when || '清除条件未注明'})`)
            .join('；')}`;
          break;
        }
        const weaks = findingsOf('D4').filter((f) => f.severity === 'weak');
        verdict = 'met';
        detail = weaks.length
          ? `${weaks.length} 项门禁为债务包装（已登记 baseline_debt）`
          : '门禁脚本均以真实退出码表达结论，且全部门禁当前通过';
        break;
      }

      case 'STD-TEST-BASELINE': {
        if (!gates.test) { verdict = 'not-applicable'; detail = '本仓未声明 test 门禁'; break; }
        const exempt = exemptions.get('test');
        const count = testRec?.testCount;
        if (typeof count === 'number' && count > 0) { verdict = 'met'; detail = `真实测试数=${count}`; break; }
        if (!testRec) {
          verdict = 'not-applicable';
          detail = '未取到 test 门禁运行记录，无法判定测试基线（先跑一次 gate run）';
          break;
        }
        verdict = 'unmet';
        detail = exempt
          ? `未跑到测试；已登记豁免（${exempt.ex.reason || '未注明'}；清除条件：${exempt.ex.clear_when || '未注明'}）`
          : '未跑到任何测试，且未登记 baseline_exempt';
        break;
      }

      case 'STD-EVIDENCE-BY-COMMAND': {
        if (!itemDir) { verdict = 'not-applicable'; detail = '未指定变更目录'; break; }
        const f = resolveArtifactIn(itemDir, 'verification.md');
        if (!existsSync(f)) { verdict = 'unmet'; detail = '缺少 verification.md'; break; }
        const text = readFileSync(f, 'utf8');
        const hasEvidence = /##\s*证据/.test(text) && /(命令|`[^`]*\s|exit|退出码)/.test(text);
        verdict = hasEvidence ? 'met' : 'unmet';
        detail = hasEvidence ? '证据节含命令或退出码' : '证据节缺少可复现的命令/退出码';
        break;
      }

      case 'STD-EVIDENCE-INDEPENDENT-REVIEW': {
        if (!itemDir) { verdict = 'not-applicable'; detail = '未指定变更目录'; break; }
        const f = resolveArtifactIn(itemDir, 'verification.md');
        if (!existsSync(f)) { verdict = 'not-applicable'; detail = '缺少 verification.md'; break; }
        const text = readFileSync(f, 'utf8');
        if (!/独立(复核|验证|视角)/.test(text)) { verdict = 'not-applicable'; detail = '未声称独立复核'; break; }
        verdict = 'met';
        detail = '声称独立复核，留痕由 G1b 校验';
        break;
      }

      case 'STD-UNVERIFIED-EXPLICIT': {
        const envWeak = findingsOf('D3').concat(findingsOf('D3b')).filter((f) => /环境受限/.test(f.title));
        verdict = 'met';
        detail = envWeak.length
          ? `${envWeak.length} 项因环境受限判为 unverified（未显示为通过、也未阻断）`
          : '无环境受限项';
        break;
      }

      case 'STD-CONTRACT-FROZEN': {
        const surface = String(config?.changeSurface || '');
        if (!itemDir) { verdict = 'not-applicable'; detail = '未指定变更目录'; break; }
        const specF = resolveArtifactIn(itemDir, 'SPEC.md');
        const specText = existsSync(specF) ? readFileSync(specF, 'utf8') : '';
        const isContract = /contract|interface/.test(surface) || /\|\s*变更面\s*\|[^|]*(contract|interface)/.test(specText);
        if (!isContract) { verdict = 'not-applicable'; detail = '本次变更面不含契约/接口'; break; }
        const cf = resolveArtifactIn(itemDir, 'CONTRACT.md');
        verdict = existsSync(cf) ? 'met' : 'unmet';
        detail = existsSync(cf) ? '已提供 CONTRACT.md' : '变更面含契约但缺少 CONTRACT.md';
        break;
      }

      case 'STD-CONTRACT-ASSERTED': {
        if (!itemDir) { verdict = 'not-applicable'; detail = '未指定变更目录'; break; }
        const cf = resolveArtifactIn(itemDir, 'CONTRACT.md');
        if (!existsSync(cf)) { verdict = 'not-applicable'; detail = '本次变更不需要契约'; break; }
        const text = readFileSync(cf, 'utf8');
        const hasCmd = /(npx |npm |node |bash |pytest|mvn |go test)/.test(text);
        verdict = hasCmd ? 'met' : 'unmet';
        detail = hasCmd ? '校验方式含可运行命令' : '校验方式未指向可运行的断言命令';
        break;
      }

      case 'STD-COMMIT-MESSAGE': {
        // 规则实现位于 tools/validate-commit-msg.mjs（本文档不重复定义）；
        // 这里只判定"项目是否提供了可用该规则校验的机制"。
        const hooked = existsSync(path.join(config?.projectRoot || '.', '.git', 'hooks', 'commit-msg'));
        verdict = 'met';
        detail = hooked ? '已安装 commit-msg 钩子（规则见 tools/validate-commit-msg.mjs）'
          : '未安装 commit-msg 钩子（规则见 tools/validate-commit-msg.mjs，可手动校验）';
        break;
      }

      case 'STD-EXEMPTION-DECLARED': {
        const bad = [...exemptions.values()].filter(({ ex }) => !ex.reason || !ex.clear_when);
        verdict = bad.length ? 'unmet' : 'met';
        detail = bad.length
          ? `豁免缺少原因或清除条件：${bad.map((b) => b.gate).join('、')}`
          : `${exemptions.size} 项豁免均已注明原因与清除条件`;
        break;
      }

      case 'STD-SCOPE-NOT-CLAIMED':
        verdict = 'not-applicable';
        detail = '需人工确认：未纳入范围的仓已在《验证边界》中标注为「无结论」';
        break;

      default:
        verdict = 'not-applicable';
        detail = '本引擎暂不支持自动判定该项目（judge=manual 或未知 id）';
    }

    // 项目覆盖（优先级：项目自定义 > 产品基础标准）
    const ov = overrides.get(std.id);
    let overridden = null;
    if (ov) {
      if (std.exemptable === false) {
        overridden = { rejected: true, reason: '该标准为产品底线，不允许项目覆盖' };
      } else if (ov.judge === 'met') {
        verdict = 'met';
        overridden = { reason: ov.reason || '(未注明)', clearWhen: ov.clear_when || null };
      }
    }

    results.push({
      id: std.id,
      title: std.title,
      tier: std.tier,
      verdict,
      consequence: std.consequence,
      exemptable: std.exemptable !== false,
      judge: std.judge,
      detail,
      overridden,
    });
  }

  const unmet = results.filter((r) => r.verdict === 'unmet');
  const summary = {
    met: results.filter((r) => r.verdict === 'met').length,
    unmet: unmet.length,
    notApplicable: results.filter((r) => r.verdict === 'not-applicable').length,
    blocking: unmet.filter((r) => r.consequence === 'block').length,
    weakened: unmet.filter((r) => r.consequence === 'weaken').length,
    total: results.length,
  };
  return { results, summary };
}

export function loadStandards(kitRoot) {
  return readJson(path.join(kitRoot, 'spec', 'standards.json'), { standards: [] });
}
