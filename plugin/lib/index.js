var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// src/index.js
async function boardAlive(url) {
  try {
    const res = await fetch(`${url}/api/state`, { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}
var hostPlugin = {
  name: "dsh-plugin-devflow",
  inject: ["shell"],
  apply: devflowBoardHost
};
var index_default = hostPlugin;
function devflowBoardHost(ctx) {
  const PORT = Number(process.env.DEVFLOW_BOARD_PORT || 8787);
  const URL_ = `http://127.0.0.1:${PORT}`;
  const candidates = [process.env.DEVFLOW_ROOT, process.env.DSH_WORKSPACE, process.cwd()].filter(Boolean);
  const hasMarker = (d) => {
    try {
      const fs = __require("node:fs");
      return ["devflow.json", "devflow.workspace.json", ".devflow"].some((m) => fs.existsSync(__require("node:path").join(d, m)));
    } catch {
      return false;
    }
  };
  const root = candidates.find(hasMarker) || null;
  ctx.effect(() => {
    let cancelled = false;
    (async () => {
      if (await boardAlive(URL_)) return;
      if (cancelled) return;
      try {
        if (ctx.shell?.resolve && ctx.shell?.execute) {
          const bin = true ? "/Users/darkrobot/projects/Private-Projects/devflow-kit/bin/devflow" : "devflow";
          const spec = ctx.shell.resolve({
            // 候选根无效时省略 --root，交给看板的向上查找
            command: `"${bin}" board --port ${PORT}` + (root ? ` --root "${root}"` : ""),
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
  index_default as default
};
