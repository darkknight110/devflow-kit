// src/index.js
async function boardAlive(url) {
  try {
    const res = await fetch(`${url}/api/state`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
function devflowBoardHost(ctx) {
  const PORT = Number(process.env.DEVFLOW_BOARD_PORT || 8787);
  const URL_ = `http://127.0.0.1:${PORT}`;
  const root = process.env.DEVFLOW_ROOT || process.cwd();
  ctx.effect(() => {
    let cancelled = false;
    (async () => {
      if (await boardAlive(URL_)) return;
      if (cancelled) return;
      try {
        if (ctx.shell?.resolve && ctx.shell?.execute) {
          const spec = ctx.shell.resolve({
            command: `devflow board --port ${PORT} --root ${root}`,
            onExpiry: "none"
          });
          await ctx.shell.execute(spec);
        } else {
          ctx.logger?.info?.("[devflow] \u672A\u53D1\u73B0 ctx.shell \u2014\u2014 \u8BF7\u624B\u52A8\u8FD0\u884C devflow board");
        }
      } catch (e) {
        ctx.logger?.warn?.(`[devflow] \u770B\u677F\u670D\u52A1\u542F\u52A8\u5931\u8D25\uFF1A${e && e.message ? e.message : e}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, "devflow: ensure board service");
}
export {
  boardAlive,
  devflowBoardHost as default
};
