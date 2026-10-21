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




# ─────────── 演示用的最小有效产物（内容真实，但都是示例数据） ───────────

SPEC_MD = """# SPEC · 接入登录

## 身份

| 键 | 值 |
|---|---|
| item | flow |
| tier | light |
| owner | 张三 |
| repos | demo |
| change_surface | ui |

## 验收标准

| AC | 判据 | 判据类型 | 责任方 |
|---|---|---|---|
| AC-1 | `./scripts/check.sh` 退出码 0 | 命令 | 后端 |
| AC-2 | 登录页可提交，错误提示可读 | 画面 | 前端 |

## 不做什么

| 项 | 说明 |
|---|---|
| 不做注册 | 本期只做登录 |
"""

CODING_MD = """# 实现报告

## 改了什么

| 文件 | 说明 |
|---|---|
| src/login.js | 新增登录表单校验 |

## 涉及提交

| 提交 | 说明 |
|---|---|
| a1b2c3d | feat: 登录表单 |
"""

VERIFY_MD = """# 验证记录

## 逐条对照

| AC | 结论 | 证据 |
|---|---|---|
| AC-1 | 通过 | ./scripts/check.sh exit=0 |
| AC-2 | 通过 | 截图 2026-10-21 |

## 结论

通过。

## 证据

| 项 | 内容 |
|---|---|
| 命令 | ./scripts/check.sh |
| 退出码 | 0 |

## 未验证项

| 未验证项 | 原因 | 如何补验证 | 是否接受风险 |
|---|---|---|---|
| 无 | — | — | 接受 |
"""

APPROVALS_MD = """# 确认记录

## 确认记录

| 确认点 | 确认人 | 时间 | 结论 | 内容指纹 |
|---|---|---|---|---|
| 需求与判据 | 张三 | 2026-10-21T10:00:00+08:00 | 通过 |  |
"""

RELEASE_MD = """# 发布报告

## 发布内容

| 项 | 内容 |
|---|---|
| 变更 | 接入登录 |
| 版本 | v1.0.0 |

## 验证证据

| 项 | 内容 |
|---|---|
| 门禁 | exit=0 |
| 验证记录 | verification.md |

## 观察窗口

| 项 | 时长 |
|---|---|
| 观察期 | 48 小时 |
"""


def write(work: str, item: str, rel: str, content: str) -> None:
    path = os.path.join(work, ".devflow", "items", item, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(content)


def latest_item(work: str) -> str:
    d = os.path.join(work, ".devflow", ".local", "items")
    return sorted(os.listdir(d))[-1] if os.path.isdir(d) else "2026-01-01-flow"


def step(caption: str, cmd: str, text: str, state: str, n: int, gates=None) -> dict:
    return {"caption": caption, "cmd": cmd, "lines": tail_lines(text, n), "state": state,
            "gates": gates if gates is not None else gates_of(text)}


def fresh_gates(work: str, item: str) -> list:
    """advance 成功时输出里没有门禁结论，所以另跑一次 gate run 取**当前**结论。

    不能"沿用上一次"：那会把"提测被拒时的 ✗"一路带到发布成功之后（实测踩到）。
    """
    return gates_of(run(f"{DEVFLOW} gate run {item}", work))


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
        # 门禁的"交付条件"：先满足，后面在第 5 步故意破坏它，演示"拒绝提测"
        open(os.path.join(work, "ready.txt"), "w").close()

        # 0. 接入仓库
        text = run(f"{DEVFLOW} init --name demo", work)
        steps.append(step("接入一个仓库：一条命令，拿到门禁与产物规范",
                          "devflow init --name demo", text, "draft", 4))

        # 1. 建变更（轻档：会真的走过 5 个状态）
        text = run(f"{DEVFLOW} new --slug flow --tier light --title '接入登录'", work)
        item = latest_item(work)
        steps.append(step("建一个变更：一句话 + 档位（轻档只跳过一个状态）",
                          "devflow new --slug flow --tier light --title '接入登录'", text, "draft", 4))

        # 2. 按模板补齐 SPEC，再把占位符换成真实判据
        text = run(f"{DEVFLOW} fill {item} --to spec_ready", work)
        write(work, item, "SPEC.md", SPEC_MD)
        steps.append(step("按模板补齐 SPEC，再把占位符换成可验收的判据",
                          f"devflow fill {item} --to spec_ready", text, "draft", 4))

        # 3. → spec_ready
        text = run(f"{DEVFLOW} advance {item} --to spec_ready", work)
        steps.append(step("需求就绪：判据冻结，之后才允许动代码",
                          f"devflow advance {item} --to spec_ready", text, "spec_ready", 3,
                          fresh_gates(work, item)))

        # 4. → implementing
        text = run(f"{DEVFLOW} advance {item} --to implementing", work)
        steps.append(step("进入实现：契约可跳过（轻档），但门禁一直有效",
                          f"devflow advance {item} --to implementing", text, "implementing", 3,
                          fresh_gates(work, item)))

        # 5. 门禁没过：提测被拒
        os.remove(os.path.join(work, "ready.txt"))
        text = run(f"{DEVFLOW} advance {item} --to tested", work)
        steps.append(step("自动跑门禁：交付条件不满足，提测被拒绝",
                          f"devflow advance {item} --to tested", text, "implementing", 8))  # 这里是失败，输出里自带 ✗

        # 6. 修好 → tested
        open(os.path.join(work, "ready.txt"), "w").close()
        write(work, item, "coding_report.md", CODING_MD)
        text = run(f"{DEVFLOW} advance {item} --to tested", work)
        steps.append(step("修好之后重跑：门禁通过，进入待验证",
                          f"devflow advance {item} --to tested", text, "tested", 4,
                          fresh_gates(work, item)))

        # 7. 验证记录 + 确认记录 → verified
        write(work, item, "verification.md", VERIFY_MD)
        write(work, item, "APPROVALS.md", APPROVALS_MD)
        text = run(f"{DEVFLOW} advance {item} --to verified", work)
        steps.append(step("逐条对照 + 确认记录齐了，才算已验证",
                          f"devflow advance {item} --to verified", text, "verified", 4,
                          fresh_gates(work, item)))

        # 8. 发布报告 → released（G9 再验一次）
        write(work, item, "release/report.md", RELEASE_MD)
        text = run(f"{DEVFLOW} advance {item} --to released", work)
        steps.append(step("发布：G9 发布前置门禁再验一次，通过才允许 released",
                          f"devflow advance {item} --to released", text, "released", 4,
                          fresh_gates(work, item)))

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
