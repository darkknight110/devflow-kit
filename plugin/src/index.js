/**
 * devflow 看板插件的**宿主半边**：保证看板服务在跑。
 *
 * 为什么必须有这一半（用户反馈驱动的设计修正）：
 *   第一版只做了客户端 iframe，要求用户**自己到项目目录执行 `devflow board`** ——
 *   这是把本可自动化的事推给人，而且不执行就看到一片空白（实测踩到）。
 *   正确做法：插件激活时**自己把服务起起来**，用户只需打开面板。
 *
 * 用什么起进程：`ctx.shell`（DSH 官方的命令执行 seam）。
 *   · `resolve({ command, onExpiry: 'none' })` ⇒ 不设截止时间，进程常驻；
 *   · 文档明确支持"keep them running as background work"。
 *
 * 刻意保留的边界：
 *   · 只在**服务未就绪**时才启动（先探测 8787，避免重复起多个）；
 *   · 起不来**不抛异常**（面板会显示原因），插件加载失败会连累整个 web boot；
 *   · 不申请任何额外权限，不注册模型工具。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendFileSync, existsSync } from 'node:fs';
import os from 'node:os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));


/**
 * 诊断日志。**必须落到文件**：宿主的 console 在 GUI 里看不到，
 * 而"起不来但不知道为什么"正是这个插件反复失败的原因（面板只能说"没有在运行"）。
 */
function diag(line) {
  try {
    const f = path.join(os.homedir(), '.dsh', 'devflow-board.log');
    appendFileSync(f, `${new Date().toISOString()}  ${line}\n`, 'utf8');
  } catch { /* 日志失败不影响主流程 */ }
}

/** 探测看板服务是否已在监听 */
async function boardAlive(url) {
  try {
    const res = await fetch(`${url}/api/state`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 导出为 **{ name, inject, apply } 对象**（与客户端半边同一约定，也对照 dsh-context 的宿主半边）。
 * 为什么必须声明 inject：不声明 `shell`，`ctx.shell` 就是 undefined —— 服务永远起不来，
 * 而且失败是静默的（实测踩到：面板一直说"没有在运行"，却不知道原因）。
 */
const hostPlugin = {
  name: 'dsh-plugin-devflow',
  inject: ['shell'],
  apply: devflowBoardHost,
};

export default hostPlugin;

function devflowBoardHost(ctx) {
  const PORT = Number(process.env.DEVFLOW_BOARD_PORT || 8787);
  const URL_ = `http://127.0.0.1:${PORT}`;
  /**
   * 传给 `--root` 的候选。
   * **坑**：插件自身的目录（`<kit>/plugin`）既没有 devflow.json 也没有工作区清单，
   * 传进去会被 CLI 直接拒绝（实测）。所以只在候选**真的是**项目/工作区时才传，
   * 否则省略 `--root`，让看板自己从 cwd 向上找。
   */
  // 候选顺序很关键：宿主进程的 cwd 常在 `~/.dsh`（宿主目录），而宿主目录**不是**项目根
  // （我们已刻意拒绝它）⇒ 只靠 cwd 会起不来。kit 自己就在工作区里（<kit>/.. 往往是工作区根），
  // 所以从**自身位置**推最可靠 —— 与 bin 绝对路径同一思路。
  const kitDir = path.resolve(__dirname, '..', '..');
  const candidates = [
    process.env.DEVFLOW_ROOT,
    process.env.DSH_WORKSPACE,
    path.resolve(kitDir, '..'),          // <kit>/.. 常是工作区根
    kitDir,
    process.cwd(),
  ].filter(Boolean);
  // ⚠️ 不能用 `require` —— 本文件是 **ESM**，`require` 不存在，会抛错并被 catch 吞掉，
  // 结果是**每个候选都判为无效**（实测日志：候选=（无有效候选））。
  const hasMarker = (d) => ['devflow.json', 'devflow.workspace.json', '.devflow']
    .some((m) => existsSync(path.join(d, m)));
  const root = candidates.find(hasMarker) || null;

  ctx.effect(() => {
    let cancelled = false;
    (async () => {
      // ① 已在跑：什么都不做（避免起第二个、避免端口冲突）
      const alive = await boardAlive(URL_);
      diag(`激活：端口=${PORT} 已在跑=${alive} cwd=${process.cwd()} 候选=${root || '（无有效候选）'}`);
      if (alive) return;
      if (cancelled) return;

      // ② 起服务：常驻、无截止时间
      try {
        if (ctx.shell?.resolve && ctx.shell?.execute) {
          // 必须用**绝对路径**：`devflow` 不在 GUI 宿主进程的 PATH 上（实测）。
          // ⚠️ 但**绝不能在构建期烘焙**机器路径 —— 那会把作者的本机路径写进产物并入库
          // （已造成一次公开仓库泄露）。改为**运行时**从自身位置解析。
          const bin = path.resolve(__dirname, '..', '..', 'bin', 'devflow');
          const spec = ctx.shell.resolve({
            // 候选根无效时省略 --root，交给看板的向上查找
            command: `"${bin}" board --port ${PORT}` + (root ? ` --root "${root}"` : ''),
            onExpiry: 'none',
          });
          await ctx.shell.execute(spec);
          // ⚠️ 这行**必须留在 if 块内**：`spec` 是块级 const，放到块外会抛
          // `spec is not defined`，把整个启动流程打断（实测日志：启动失败：spec is not defined）
          diag(`已下发启动命令：${spec.command}`);
        } else {
          diag('未发现 ctx.shell —— 无法自动启动（请在项目里手动运行 bin/devflow board）');
          ctx.logger?.info?.('[devflow] 未发现 ctx.shell —— 请手动运行 devflow board');
        }
      } catch (e) {
        diag(`启动失败：${e && e.message ? e.message : e}`);
        // 起不来不抛：面板会显示"服务没有在运行"，那比让整个 boot 失败更有用
        ctx.logger?.warn?.(`[devflow] 看板服务启动失败：${e && e.message ? e.message : e}`);
      }
    })();
    return () => { cancelled = true; };
  }, 'devflow: ensure board service');
}

export { boardAlive };
