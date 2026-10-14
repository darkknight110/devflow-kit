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

/** 探测看板服务是否已在监听 */
async function boardAlive(url) {
  try {
    const res = await fetch(`${url}/api/state`, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

export default function devflowBoardHost(ctx) {
  const PORT = Number(process.env.DEVFLOW_BOARD_PORT || 8787);
  const URL_ = `http://127.0.0.1:${PORT}`;
  const root = process.env.DEVFLOW_ROOT || process.cwd();

  ctx.effect(() => {
    let cancelled = false;
    (async () => {
      // ① 已在跑：什么都不做（避免起第二个、避免端口冲突）
      if (await boardAlive(URL_)) return;
      if (cancelled) return;

      // ② 起服务：常驻、无截止时间
      try {
        if (ctx.shell?.resolve && ctx.shell?.execute) {
          const spec = ctx.shell.resolve({
            command: `devflow board --port ${PORT} --root ${root}`,
            onExpiry: 'none',
          });
          await ctx.shell.execute(spec);
        } else {
          ctx.logger?.info?.('[devflow] 未发现 ctx.shell —— 请手动运行 devflow board');
        }
      } catch (e) {
        // 起不来不抛：面板会显示"服务没有在运行"，那比让整个 boot 失败更有用
        ctx.logger?.warn?.(`[devflow] 看板服务启动失败：${e && e.message ? e.message : e}`);
      }
    })();
    return () => { cancelled = true; };
  }, 'devflow: ensure board service');
}

export { boardAlive };
