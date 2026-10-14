/**
 * 技术栈适配器：把各栈的构建/测试输出形态翻译成统一的门禁声明。
 *
 * 边界（很重要）：
 *   - 适配器只提供「模板与默认值」，真正的命令由项目自己维护；
 *   - 应用适配器时**只补缺失**，绝不覆盖已有脚本或已有门禁声明；
 *   - 不替项目安装依赖（那是包管理器的事），只在缺少脚本时给出明确提示。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { readJson } from './manifest.mjs';

export function loadAdapters(kitRoot) {
  return readJson(path.join(kitRoot, 'spec', 'adapters.json')).adapters;
}

/**
 * 按标记文件检测技术栈；返回命中的适配器列表（按命中数排序）。
 *
 * strict=true 时**只看项目根**，不看祖先目录 —— 否则在临时目录/子目录里 init 会继承上层
 * 项目（例如上层 devflow-kit 自己带的 package.json）的标记，识别出错误的技术栈。
 */
export function detectAdapters(projectRoot, adapters, { strict = true } = {}) {
  const hits = [];
  for (const [id, def] of Object.entries(adapters)) {
    const matched = (def.markers || []).filter((m) => existsSync(path.join(projectRoot, m)));
    if (matched.length) hits.push({ id, name: def.name, matched, score: matched.length });
  }
  if (!hits.length && !strict) {
    // 非严格模式：向上找最近的标记（用于"我这个目录属于哪个项目"这类查询）
    let dir = path.dirname(path.resolve(projectRoot));
    for (let i = 0; i < 8 && dir !== path.dirname(dir); i += 1) {
      for (const [id, def] of Object.entries(adapters)) {
        const matched = (def.markers || []).filter((m) => existsSync(path.join(dir, m)));
        if (matched.length) hits.push({ id, name: def.name, matched, score: matched.length, foundIn: dir });
      }
      if (hits.length) break;
      dir = path.dirname(dir);
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/**
 * 应用适配器：补缺失的脚本 + 合并门禁声明（不覆盖已有内容）。
 * @returns {{scripts:{written:string[], skipped:string[]}, gates:{added:string[], kept:string[]}, adapter:string}}
 */
export function applyAdapter({ projectRoot, adapters, id, dryRun = false, demo = false, replacePlaceholders = false, forceScripts = false }) {
  const def = adapters[id];
  if (!def) throw new Error(`未知适配器：${id}`);
  const scripts = { written: [], skipped: [], replaced: [] };
  const gates = { added: [], kept: [] };
  // demo 模式：用自包含的演示脚本，输出该栈真实形态 —— 用于"不装工具也能验证整条链路"
  const scriptSet = demo && def.demo?.scripts ? def.demo.scripts : (def.scripts || {});

  // ① 脚本：只写缺失的。路径统一落在 scripts/ 下 —— 必须与生成的 run 命令（./scripts/xxx.sh）一致，
  //    否则 init 当场就产出一份跑不起来的配置。
  for (const [rel0, content] of Object.entries(scriptSet)) {
    const rel = rel0.startsWith('scripts/') ? rel0 : path.join('scripts', rel0);
    const full = path.join(projectRoot, rel);
    if (existsSync(full)) {
      // 关键：带哨兵的"占位脚本"可以替换（它本来就是 init 的临时产物）；
      //       用户自己写过的脚本一律不覆盖。
      let isPlaceholder = false;
      let isAdapterScript = false;
      /** 识别"骨架式负向对照"：只有注释 + exit 1，没有任何说明性输出。
       *  这类脚本（早期 init 生成）既无哨兵也无适配器标记，会被当成"用户脚本"而永远无法更新；
       *  且它不满足"负向对照须输出失败证据"的门禁要求 ⇒ 必须可被替换。 */
      let isBareNegativeControl = false;
      try {
        const content = readFileSync(full, 'utf8');
        isPlaceholder = content.includes('devflow:placeholder');
        isAdapterScript = content.includes('devflow:adapter');
        const codeLines = content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#') && !l.startsWith('set '));
        isBareNegativeControl = /-should-fail\.sh$/.test(rel)
          && codeLines.length <= 1
          && codeLines.every((l) => /^exit\s+[1-9]\d*$/.test(l));
      } catch {
        isPlaceholder = false;
        isAdapterScript = false;
      }
      // 可替换的三种情形：
      //   ① --replace-placeholders 且是 init 的占位脚本；
      //   ② --force-scripts 且是**适配器自己生成的**脚本（想从真实模板切到 demo 时必需）；
      //   用户自己写过的脚本（既无哨兵也无适配器标记）**永不覆盖**。
      const replaceable =
        (replacePlaceholders && (isPlaceholder || isBareNegativeControl))
        || (forceScripts && (isAdapterScript || isPlaceholder || isBareNegativeControl));
      if (!replaceable) {
        scripts.skipped.push(`${rel}（已存在${isPlaceholder ? '且为占位脚本' : isAdapterScript ? '且为适配器脚本' : isBareNegativeControl ? '且为骨架式负向对照' : '（用户自己的脚本）'}，未覆盖）`);
        continue;
      }
      scripts.replaced = scripts.replaced || [];
      scripts.replaced.push(rel);
    }
    if (!dryRun) {
      mkdirSync(path.dirname(full), { recursive: true });
      writeFileSync(full, content, { mode: 0o755 });
    }
    scripts.written.push(rel);
  }

  // ② 门禁声明：只补缺失的
  const configPath = path.join(projectRoot, 'devflow.json');
  if (existsSync(configPath) && !dryRun) {
    const config = readJson(configPath);
    config.gates = config.gates || {};
    const declared = config.gates;
    const testDef = demo && def.demo?.test ? { ...def.test, run: def.demo.test } : def.test;
    const buildDef = demo && def.demo?.build ? { ...def.build, run: def.demo.build } : def.build;
    const isReplaceable = (g) => !g || typeof g.run !== 'string' || g.source === 'default';
    const settle = (name, def) => {
      if (!def || !def.run) return;
      if (isReplaceable(declared[name])) {
        declared[name] = stripAdapterMeta(def);
        gates.added.push(name);
      } else {
        gates.kept.push(`${name}（用户已声明，未改动）`);
      }
    };
    settle('test', testDef);
    settle('build', buildDef);
    if (!config.stack || config.stack === 'node') config.stack = id;
    if (config.devflow) config.devflow.stack = id;
    config.devflow = config.devflow || {};
    config.devflow.stack = id;
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
  } else if (existsSync(configPath)) {
    gates.kept.push('（空跑，未写入）');
  }

  return { adapter: id, scripts, gates, stack: id, applied: !dryRun, demo };
}

/** 去掉适配器里的说明性字段，只保留门禁声明需要的键 */
function stripAdapterMeta(gate) {
  const keep = ['run', 'count_regex', 'require_min_tests', 'negative_control'];
  const out = {};
  for (const k of keep) if (gate[k] !== undefined) out[k] = gate[k];
  out.source = 'adapter';
  return out;
}

/** 校验适配器的 count_regex 是否能抓到它自己声明的样本输出（防"配了但抓不到"） */
export function auditAdapterRegex(adapters) {
  const problems = [];
  for (const [id, def] of Object.entries(adapters)) {
    const gate = def.test || {};
    if (!gate.count_regex || !gate.sample_output) continue;
    let m = null;
    try {
      m = new RegExp(gate.count_regex).exec(gate.sample_output);
    } catch (error) {
      problems.push(`${id}: count_regex 语法错误 —— ${error.message}`);
      continue;
    }
    if (!m) problems.push(`${id}: count_regex 抓不到自己声明的样本输出（${gate.count_regex}）`);
    else if (!Number.isFinite(Number(m[1]))) problems.push(`${id}: count_regex 的第 1 个捕获组不是数字`);
    else if (gate.require_min_tests && Number(m[1]) < gate.require_min_tests) {
      problems.push(`${id}: 样本输出里的计数 ${m[1]} 低于 require_min_tests=${gate.require_min_tests}`);
    }
  }
  return problems;
}
