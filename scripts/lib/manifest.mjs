/**
 * 引导与配置解析：0 依赖（仅 node 内置模块）。
 *
 * 职责：
 *   1. 从任意子目录向上定位项目根（以 devflow.json 为标记）
 *   2. 加载 Kit 自身的正典（spec/*.json）
 *   3. 解析项目配置、工作区清单、kit 版本约束
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Kit 根目录（scripts/lib -> 上溯两级） */
export const KIT_ROOT = path.resolve(HERE, '..', '..');

export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    const e = new Error(`JSON 解析失败：${file}\n  ${error.message}`);
    e.code = 'EJSON';
    throw e;
  }
}

/**
 * 向上查找项目根。
 *
 * 标记的稳健性很重要：只看 devflow.json 太弱 —— 任何同名的无关文件都会劫持项目根。
 * 规则（从强到弱）：
 *   1. 同时存在 devflow.json 与 .devflow/ 目录（推荐，也是 init 之后的正常形态）
 *   2. 只存在 devflow.json（允许，用于尚未初始化的项目，但会记录 warning）
 *   3. DEVFLOW_ROOT 环境变量显式指定（最高优先级，用于多项目工作区）
 * @returns {{root:string, marker:string, warning?:string}|null}
 */
export function resolveProjectRoot(startDir = process.cwd()) {
  if (process.env.DEVFLOW_ROOT) {
    const root = path.resolve(process.env.DEVFLOW_ROOT);
    if (existsSync(path.join(root, 'devflow.json'))) return { root, marker: 'DEVFLOW_ROOT' };
    return null;
  }
  let dir = path.resolve(startDir);
  let weak = null;
  for (let i = 0; i < 24; i += 1) {
    const hasConfig = existsSync(path.join(dir, 'devflow.json'));
    const hasItems = existsSync(path.join(dir, '.devflow'));
    if (hasConfig && hasItems) return { root: dir, marker: 'devflow.json + .devflow/' };
    if (hasConfig && !weak) weak = { root: dir, marker: 'devflow.json', warning: `项目根仅凭 devflow.json 判定（缺少 .devflow/ 目录）：${dir}` };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return weak;
}

/** 兼容旧调用：只要路径 */
export function findProjectRoot(startDir = process.cwd()) {
  const r = resolveProjectRoot(startDir);
  return r ? r.root : null;
}

/** 向上查找工作区清单 */
export function findWorkspaceRoot(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (let i = 0; i < 24; i += 1) {
    const candidate = path.join(dir, 'devflow.workspace.json');
    if (existsSync(candidate)) return candidate;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

export function loadKitSpec(name) {
  return readJson(path.join(KIT_ROOT, 'spec', `${name}.json`));
}

export function kitVersion() {
  const versionFile = path.join(KIT_ROOT, 'VERSION');
  return existsSync(versionFile) ? readFileSync(versionFile, 'utf8').trim() : '0.0.0';
}

/** 极简 semver 约束检查：支持 ^x.y.z、>=x.y.z、x.y.z、* */
export function satisfies(version, range) {
  if (!range || range === '*' || range === '') return true;
  const v = version.split('.').map(Number);
  const raw = String(range).trim();
  const caret = raw.startsWith('^');
  const gte = raw.startsWith('>=');
  const target = raw.replace(/^[\^>=]+/, '').split('.').map(Number);
  const cmp = (a, b) => {
    for (let i = 0; i < 3; i += 1) {
      const x = a[i] || 0;
      const y = b[i] || 0;
      if (x !== y) return x - y;
    }
    return 0;
  };
  if (caret) {
    if (cmp(v, target) < 0) return false;
    // 主版本相同（0.x 视为 0.minor）
    return target[0] === 0 ? v[0] === 0 && v[1] === target[1] : v[0] === target[0];
  }
  if (gte) return cmp(v, target) >= 0;
  return cmp(v, target) === 0;
}

/** 默认项目配置（devflow init 生成） */
export function defaultProjectConfig(project, kind = 'service', stack = 'node') {
  return {
    devflow: { kit: `^${kitVersion().split('.').slice(0, 2).join('.')}.0`, project, kind, stack },
    profile: 'team',
    budget: { warn_kb: 120, block_kb: 250 },
    // 注意：这里的门禁是"占位默认值"，标记 source=default —— 适配器可以整体替换它们，
    // 而用户自己声明过的门禁（无 source:default 标记）永不被适配器覆盖。
    gates: {
      build: { run: './scripts/build.sh', negative_control: './scripts/build-should-fail.sh', source: 'default' },
      test: { run: './scripts/test.sh', count_regex: 'Tests run: (\\d+)', require_min_tests: 1, negative_control: './scripts/test-should-fail.sh', source: 'default' },
    },
  };
}

/** 加载项目配置（含 G0 预检） */
export function loadProject(projectRoot) {
  const configPath = path.join(projectRoot, 'devflow.json');
  if (!existsSync(configPath)) {
    return { ok: false, code: 'NO_CONFIG', configPath, errors: [`未找到 ${configPath}`] };
  }
  let config;
  try {
    config = readJson(configPath);
  } catch (error) {
    return { ok: false, code: 'BAD_JSON', configPath, errors: [error.message] };
  }
  const errors = [];
  if (!config.devflow || typeof config.devflow !== 'object') errors.push('缺少 devflow 块');
  const declared = Object.keys(config.gates || {});
  if (declared.length === 0) errors.push('未声明任何门禁（gates 为空）');
  const want = config.devflow?.kit;
  const have = kitVersion();
  if (want && !satisfies(have, want)) errors.push(`kit 版本不满足：需要 ${want}，当前 ${have}`);
  return {
    ok: errors.length === 0,
    code: errors.length ? 'INVALID' : 'OK',
    configPath,
    config,
    declaredGates: declared,
    kitVersion: have,
    errors,
  };
}

/**
 * 计算指令链体积（KB）：项目根到目标目录之间所有指令文件。
 * 大小写不敏感地匹配 agents / claude 系列（含 AGENTS.local.md 这类叠加文件）——
 * 只在 Linux 上写 agents.md 的项目不应被漏算。
 */
const INSTRUCTION_PATTERN = /^(agents|claude)(\.local)?\.md$/i;

export function instructionChainKb(fromDir, rootDir) {
  let dir = path.resolve(fromDir);
  const root = path.resolve(rootDir);
  let bytes = 0;
  const files = [];
  for (let i = 0; i < 24; i += 1) {
    let entries = [];
    try {
      entries = readdirSync(dir);
    } catch {
      entries = [];
    }
    for (const entry of entries) {
      if (!INSTRUCTION_PATTERN.test(entry)) continue;
      const file = path.join(dir, entry);
      try {
        bytes += statSync(file).size;
        files.push(path.relative(root, file) || entry);
      } catch {
        /* 忽略无法读取的条目 */
      }
    }
    if (dir === root) break;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return { kb: Math.round(bytes / 102.4) / 10, files };
}

/** 规范化 git 相关只读查询（分支、未提交、未推送） */
export function gitFacts(projectRoot) {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch {
      return null;
    }
  };
  const inside = run(['rev-parse', '--is-inside-work-tree']);
  if (inside !== 'true') return { isRepo: false };
  return {
    isRepo: true,
    branch: run(['rev-parse', '--abbrev-ref', 'HEAD']) || '(unknown)',
    dirty: (run(['status', '--porcelain']) || '').split('\n').filter(Boolean).length,
    ahead: Number(run(['rev-list', '--count', '@{u}..HEAD']) || 0),
  };
}
