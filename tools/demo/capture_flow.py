#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""采集 devflow 的真实执行输出，供演示动画渲染。

为什么先采集再渲染：
  1. 动画里的每一行都是**真命令跑出来的**，不是手写台词；
  2. 渲染器只负责画，不负责编 —— 谁都能重跑一遍核对；
  3. 换版本后重跑一次，动画自动跟上，不会"图是去年的"。

用法：
    python3 tools/demo/capture_flow.py --out docs/demo-flow.json
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
DEVFLOW = os.path.join(ROOT, "bin", "devflow")

CONFIG = {
    "devflow": {"kit": "^1.0", "project": "demo", "kind": "service", "stack": "node"},
    "profile": "solo",
    "release": {"requires": ["check"]},
    "gates": {
        "check": {
            "run": "sh -c 'test -f ready.txt'",
            # 负向对照必须有失败证据：演示里也一样，不能靠"一定失败的命令"凑数
            "negative_control": "sh -c 'echo FAIL ready.txt-missing; exit 1'",
        }
    },
}

# 两种行形态都要认：
#   项目门禁：`✗ 失败            check   exit=1`
#   Kit 门禁：`✓                 G1b`
GATE_LINE = re.compile(r"^\s*(✓|✗|⚠|■|⛔)\s+(?:\S+\s+)?(G[0-9]+b?|[a-z][\w-]*)\s*(?:exit=(\d+))?")


def run(cmd: str, cwd: str) -> str:
    env = dict(os.environ, NO_COLOR="1", TERM="dumb")
    p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, env=env)
    return (p.stdout or "") + (p.stderr or "")


def tail_lines(text: str, n: int) -> list[str]:
    lines = [l.rstrip() for l in text.splitlines() if l.strip()]
    return lines[-n:]


def gates_of(text: str) -> list[dict]:
    """从真实输出里抽出门禁结论（不猜：认不出的行就跳过）。"""
    out = []
    for line in text.splitlines():
        tokens = line.split()
        if not tokens or tokens[0] not in ("✓", "✗", "⚠", "■", "⛔"):
            continue
        name = None
        code = None
        for i, t in enumerate(tokens):
            if re.fullmatch(r"G\d+b?", t):
                name = t
                break
            if t.startswith("exit=") and i > 0:
                name = tokens[i - 1]
                code = int(t.split("=", 1)[1]) if t.split("=", 1)[1].isdigit() else None
                break
        if name:
            out.append({"name": name, "mark": tokens[0], "exit": code})
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    if not os.path.exists(DEVFLOW):
        print(f"找不到 devflow：{DEVFLOW}", file=sys.stderr)
        return 2

    work = tempfile.mkdtemp(prefix="devflow-demo-")
    steps = []
    try:
        with open(os.path.join(work, "devflow.json"), "w", encoding="utf-8") as fh:
            json.dump(CONFIG, fh, ensure_ascii=False, indent=2)

        # 0. 接入仓库（有 .devflow/ 才不是"仅凭 devflow.json 判定"）
        text = run(f"{DEVFLOW} init --name demo", work)
        steps.append({
            "caption": "接入一个仓库：一条命令，拿到门禁与产物规范",
            "cmd": "devflow init --name demo",
            "lines": [l for l in text.splitlines() if l.strip()][:4],
            "state": "draft",
            "gates": gates_of(text),
        })

        # 1. 建变更（微档，专注演示门禁）
        cmd = "devflow new --slug first --tier micro --title '第一个变更'"
        text = run(f"{DEVFLOW} new --slug first --tier micro --title '第一个变更'", work)
        items_dir = os.path.join(work, ".devflow", ".local", "items")
        item = sorted(os.listdir(items_dir))[-1] if os.path.isdir(items_dir) else "2026-01-01-first"
        steps.append({
            "caption": "建一个变更：只需要一句话和档位",
            "cmd": cmd,
            "lines": tail_lines(text, 4),
            "state": "draft",
            "gates": gates_of(text),
        })

        # 2. 门禁没通过：拒绝推进（这里 ready.txt 还不存在）
        text = run(f"{DEVFLOW} gate run {item}", work)
        steps.append({
            "caption": "门禁跑一遍：交付条件不满足，直接 BLOCKED",
            "cmd": f"devflow gate run {item}",
            "lines": tail_lines(text, 12),
            "state": "draft",
            "gates": gates_of(text),
        })

        # 3. 修好（演示里就是补齐那个文件）
        open(os.path.join(work, "ready.txt"), "w").close()
        steps.append({
            "caption": "把缺的东西补上",
            "cmd": "touch ready.txt        # 真实项目里：修代码 / 补测试 / 补交付物",
            "lines": [],
            "state": "draft",
            "gates": [],
        })

        # 4. 再跑门禁：全绿
        text = run(f"{DEVFLOW} gate run {item}", work)
        steps.append({
            "caption": "再跑一遍：全绿，并且负向对照证明门禁不是恒真",
            "cmd": f"devflow gate run {item}",
            "lines": tail_lines(text, 12),
            "state": "draft",
            "gates": gates_of(text),
        })

        # 5. 发布：G9 会在 released 前再验一次
        text = run(f"{DEVFLOW} advance {item} --to released", work)
        steps.append({
            "caption": "发布：G9 发布前置门禁再验一次，通过才允许 released",
            "cmd": f"devflow advance {item} --to released",
            "lines": tail_lines(text, 4),
            "state": "released",
            "gates": gates_of(text),
        })
        # 6. 显式看 released 目标的门禁：G9 在列
        text = run(f"{DEVFLOW} gate run {item} --to released", work)
        steps.append({
            "caption": "看一眼 released 目标的判定：G9 发布前置门禁在列",
            "cmd": f"devflow gate run {item} --to released",
            "lines": tail_lines(text, 8),
            "state": "released",
            "gates": gates_of(text),
        })
    finally:
        shutil.rmtree(work, ignore_errors=True)

    payload = {"kit_version": open(os.path.join(ROOT, "VERSION"), encoding="utf-8").read().strip(), "steps": steps}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    print(f"{args.out}（{len(steps)} 步，{sum(len(s['lines']) for s in steps)} 行真实输出）")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
