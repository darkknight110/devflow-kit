#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 capture_flow.py 采集到的真实输出渲染成演示 GIF。

只负责"画"：不编任何台词。所有文字都来自 docs/demo-flow.json（真命令输出）。
生成两张：
  docs/demo-flow.gif   动图（README 顶部用）
  docs/demo-flow.png   末帧静图（不支持动图的地方用）

用法：
    python3 tools/demo/capture_flow.py --out docs/demo-flow.json
    python3 tools/make_flow_gif.py --data docs/demo-flow.json --out docs/demo-flow.gif
"""
from __future__ import annotations

import argparse
import json
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 880, 520
FPS = 12
PAD = 28

BG = (10, 14, 19)
CARD = (17, 24, 32)
CARD_BORDER = (31, 43, 56)
INK = (230, 237, 243)
DIM = (140, 155, 170)
GREEN = (63, 185, 80)
RED = (248, 81, 73)
YELLOW = (210, 153, 34)
BLUE = (88, 166, 255)
PROMPT = (126, 231, 135)

STATES = [("draft", "草稿"), ("spec_ready", "需求就绪"), ("contracted", "契约冻结"),
          ("implementing", "实现中"), ("tested", "待验证"), ("verified", "已验证"), ("released", "已发布")]

CJK_FONTS = [
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "C:/Windows/Fonts/msyh.ttc",
]
MONO_FONTS = [
    "/System/Library/Fonts/Menlo.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
    "C:/Windows/Fonts/consola.ttf",
]


def load(fonts, size):
    for p in fonts:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except OSError:
                continue
    return ImageFont.load_default()


def is_cjk(ch: str) -> bool:
    return "\u2e80" <= ch <= "\u9fff" or "\uff00" <= ch <= "\uffef" or "\u3000" <= ch <= "\u303f"


def draw_grid_text(d, text, x, y, mono, cjk, fill):
    """按"ASCII 1 格、CJK 2 格"逐字排，保证中文与英文混排不歪。"""
    cell = mono.getlength("M")
    col = 0.0
    for ch in text:
        if is_cjk(ch):
            w = cjk.getlength(ch)
            d.text((x + col * cell + (2 * cell - w) / 2, y - 1), ch, font=cjk, fill=fill)
            col += 2
        else:
            d.text((x + col * cell, y), ch, font=mono, fill=fill)
            col += 1
    return col * cell


def wrap_grid(text, max_cells, mono):
    """按格宽折行（中文可断，英文尽量整词）。"""
    out, line, cells = [], "", 0
    for ch in text:
        w = 2 if is_cjk(ch) else 1
        if cells + w > max_cells:
            out.append(line)
            line, cells = "", 0
        line += ch
        cells += w
    if line:
        out.append(line)
    return out


def text_w(text, mono, cjk):
    return sum(cjk.getlength(ch) if is_cjk(ch) else mono.getlength(ch) for ch in text)


def pill(d, x, y, w, h, fill, outline):
    d.rounded_rectangle([x, y, x + w, y + h], radius=h / 2, fill=fill, outline=outline, width=1)


def frame(step, idx, total, typed, shown_lines, poster=False):
    font = FONTS
    mono_title = FONTS["mono_title"]
    mono_small = FONTS["mono_small"]
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 头部
    d.text((PAD, 18), "devflow · 执行流程演示", font=font["h1"], fill=INK)
    d.text((PAD, 46), "每一行都是真实命令输出，可复跑生成", font=font["small"], fill=DIM)
    tag = f"{idx + 1} / {total}"
    d.text((W - PAD - mono_title.getlength(tag), 22), tag, font=mono_title, fill=DIM)

    # 终端卡片
    top = 78
    d.rounded_rectangle([PAD, top, W - PAD, top + 268], radius=12, fill=CARD, outline=CARD_BORDER, width=1)
    # 三个圆点
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        d.ellipse([PAD + 16 + i * 16, top + 14, PAD + 24 + i * 16, top + 22], fill=c)

    x0 = PAD + 18
    y = top + 44
    # 命令行（打字体）
    cur = f"❯ {typed}"
    draw_grid_text(d, cur, x0, y, font["mono"], font["cjk"], PROMPT)
    if len(typed) < len(step["cmd"]):
        # 光标
        cells = sum(2 if is_cjk(c) else 1 for c in cur)
        d.rectangle([x0 + cells * font["mono"].getlength("M"), y, x0 + cells * font["mono"].getlength("M") + 7, y + 14],
                    fill=BLUE)
    y += 26

    # 输出行
    max_cells = int((W - PAD * 2 - 40) / font["mono"].getlength("M"))
    for raw in shown_lines:
        color = DIM
        if "✓" in raw:
            color = GREEN
        elif "✗" in raw or "⛔" in raw or "BLOCKED" in raw:
            color = RED
        elif "⚠" in raw:
            color = YELLOW
        elif "结论" in raw or "已推进" in raw:
            color = INK
        for piece in wrap_grid(raw.strip(), max_cells, font["mono"])[:2]:
            if y > top + 245:
                break
            draw_grid_text(d, piece, x0, y, font["mono"], font["cjk"], color)
            y += 18

    # 说明
    cap = step["caption"]
    for i, piece in enumerate(wrap_grid(cap, 66, font["mono"])[:2]):
        draw_grid_text(d, piece, PAD + 4, 362 + i * 22, font["mono_mid"], font["cjk_mid"], INK)

    # 状态轨
    sy = 414
    state = step["state"]
    active = next((i for i, (k, _) in enumerate(STATES) if k == state), 0)
    x = PAD
    for i, (key, label) in enumerate(STATES):
        w = text_w(label, font["mono_small"], font["cjk_small"]) + 28
        if i == active:
            pill(d, x, sy, w, 26, (23, 61, 40), GREEN)
            draw_grid_text(d, label, x + 9, sy + 6, font["mono_small"], font["cjk_small"], GREEN)
        elif i < active:
            pill(d, x, sy, w, 26, (16, 24, 33), CARD_BORDER)
            draw_grid_text(d, label, x + 9, sy + 6, font["mono_small"], font["cjk_small"], DIM)
        else:
            pill(d, x, sy, w, 26, (13, 19, 26), CARD_BORDER)
            draw_grid_text(d, label, x + 9, sy + 6, font["mono_small"], font["cjk_small"], (90, 100, 112))
        x += w + 8
        if i < len(STATES) - 1:
            d.line([x - 4, sy + 13, x + 0, sy + 13], fill=CARD_BORDER)

    # 门禁 chips
    gy = 456
    d.text((PAD + 2, gy - 2), "门禁", font=font["small"], fill=DIM)
    gx = PAD + 52
    for g in step.get("gates", [])[:11]:
        mark, name = g["mark"], g["name"]
        color = {"✓": GREEN, "✗": RED, "⚠": YELLOW, "■": YELLOW, "⛔": RED}.get(mark, DIM)
        text = f"{mark} {name}"
        w = text_w(text, font["mono_small"], font["cjk_small"]) + 14
        pill(d, gx, gy - 6, w, 22, (15, 22, 30), color)
        draw_grid_text(d, text, gx + 7, gy - 3, font["mono_small"], font["cjk_small"], color)
        gx += w + 6
        if gx > W - PAD - 60:
            break

    # 页脚
    foot = f"可复跑：python3 tools/demo/capture_flow.py && python3 tools/make_flow_gif.py   ·   devflow {DATA.get('kit_version','')}"
    draw_grid_text(d, foot, PAD, H - 30, font["mono_small"], font["cjk_small"], (80, 92, 105))
    return img


def build_frames(data):
    frames = []
    steps = data["steps"]
    total = len(steps)
    for idx, step in enumerate(steps):
        cmd = step["cmd"]
        # 打字：每帧 4 个字符
        for n in range(0, len(cmd) + 1, 4):
            frames.append(frame(step, idx, total, cmd[:n], []))
        # 逐行出现
        shown = []
        for line in step["lines"]:
            shown = shown + [line]
            frames.append(frame(step, idx, total, cmd, shown))
        # 静置
        for _ in range(9):
            frames.append(frame(step, idx, total, cmd, shown))
    return frames


DATA = {}
FONTS = {}


def main() -> int:
    global DATA
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    DATA = json.load(open(args.data, encoding="utf-8"))
    FONTS.update({
        "h1": load(CJK_FONTS, 20),
        "small": load(CJK_FONTS, 12),
        "mono": load(MONO_FONTS, 13),
        "cjk": load(CJK_FONTS, 13),
        "mono_mid": load(MONO_FONTS, 15),
        "cjk_mid": load(CJK_FONTS, 15),
        "mono_small": load(MONO_FONTS, 11),
        "cjk_small": load(CJK_FONTS, 11),
        "mono_title": load(MONO_FONTS, 13),
    })

    frames = build_frames(DATA)
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    palette_src = frames[-1].quantize(colors=48, method=Image.MEDIANCUT)
    qframes = [f.quantize(palette=palette_src, dither=Image.NONE) for f in frames]
    qframes[0].save(args.out, save_all=True, append_images=qframes[1:], duration=int(1000 / FPS),
                    loop=0, optimize=True, disposal=2)

    poster = os.path.splitext(args.out)[0] + ".png"
    frames[-1].save(poster, optimize=True)
    size_mb = os.path.getsize(args.out) / 1048576
    print(f"{args.out}  {len(frames)} 帧  {size_mb:.2f}MB")
    print(f"{poster}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
