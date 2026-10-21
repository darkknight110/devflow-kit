#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把 capture_flow.py 采集到的真实输出渲染成演示 GIF / 故事板。

只负责"画"：不编任何台词。所有文字都来自 demo-flow.json（真命令输出）。

清晰度策略（第一版被反馈"糊"）：
  · 超采样：按 2 倍画，再用 LANCZOS 缩回目标尺寸 —— 文字边缘才有抗锯齿；
  · 少而大：每步最多 6 行输出、字号放大，宁可少说也不塞满；
  · 调色板 128 色、抖动关闭 —— 抖动会让文字边缘起噪点，看起来更糊；
  · 另出 PNG 故事板（无损），README 里既能动也能"一眼看清"。

用法：
    python3 tools/demo/capture_flow.py --out docs/demo-flow.json
    python3 tools/make_flow_gif.py --data docs/demo-flow.json --out docs/demo-flow.gif
"""
from __future__ import annotations

import argparse
import json
import os
from PIL import Image, ImageDraw, ImageFont

# 逻辑画布（设计坐标）
LW, LH = 1000, 620
SCALE = 1.25     # 输出尺寸 = 逻辑 × SCALE（首屏用 PNG，GIF 可以更大更清晰）
SS = 2           # 超采样倍数
K = SCALE * SS   # 绘制时所有尺寸乘 K，最后缩 SS 倍

FPS = 12
PAD = 30

BG = (9, 13, 18)
CARD = (16, 23, 31)
CARD_BORDER = (32, 45, 58)
INK = (235, 241, 247)
DIM = (150, 165, 180)
GREEN = (63, 200, 90)
RED = (250, 90, 82)
YELLOW = (220, 165, 40)
BLUE = (100, 175, 255)
PROMPT = (130, 240, 140)

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
                return ImageFont.truetype(p, int(size * K))
            except OSError:
                continue
    return ImageFont.load_default()


def is_cjk(ch: str) -> bool:
    return "\u2e80" <= ch <= "\u9fff" or "\uff00" <= ch <= "\uffef" or "\u3000" <= ch <= "\u303f"


def text_w(text, mono, cjk):
    return sum(cjk.getlength(ch) if is_cjk(ch) else mono.getlength(ch) for ch in text) / K


def draw_text(d, text, x, y, mono, cjk, fill):
    """按"ASCII 1 格、CJK 2 格"逐字排，中英混排不歪。坐标用逻辑单位。"""
    cell = mono.getlength("M")
    col = 0.0
    for ch in text:
        if is_cjk(ch):
            w = cjk.getlength(ch)
            d.text(((x * K) + col * cell + (2 * cell - w) / 2, (y - 1) * K), ch, font=cjk, fill=fill)
            col += 2
        else:
            d.text(((x * K) + col * cell, y * K), ch, font=mono, fill=fill)
            col += 1
    return col * cell / K


def truncate(text, max_cells):
    """单行截断（加 …）：终端里一行就是一行，折行会把关键词拆散、更难读。"""
    cells = 0
    out = []
    for ch in text:
        w = 2 if is_cjk(ch) else 1
        if cells + w > max_cells - 1:
            return "".join(out) + "…"
        out.append(ch)
        cells += w
    return "".join(out)


def wrap(text, max_cells):
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


def pill(d, x, y, w, h, fill, outline):
    d.rounded_rectangle([x * K, y * K, (x + w) * K, (y + h) * K], radius=h * K / 2,
                        fill=fill, outline=outline, width=max(1, int(K)))


def pick_lines(lines, limit=8):
    """输出多时保留"头两行 + … + 最后四行"。

    最后四行必须留：结论与 G9 这类关键判定都在末尾，截掉就等于把证据藏起来。
    """
    if len(lines) <= limit:
        return lines
    return lines[:2] + ["…"] + lines[-4:]


FONTS: dict = {}
DATA: dict = {}


def frame(step, idx, total, typed, shown_lines):
    img = Image.new("RGB", (int(LW * K), int(LH * K)), BG)
    d = ImageDraw.Draw(img)
    f = FONTS

    d.text((PAD * K, 16 * K), "devflow · 执行流程演示", font=f["h1"], fill=INK)
    d.text((PAD * K, 46 * K), "每一行都是真实命令输出，可复跑生成", font=f["small"], fill=DIM)
    tag = f"{idx + 1} / {total}"
    d.text(((LW - PAD) * K - f["mono_mid"].getlength(tag), 20 * K), tag, font=f["mono_mid"], fill=DIM)

    # 终端
    top = 84
    d.rounded_rectangle([PAD * K, top * K, (LW - PAD) * K, (top + 300) * K],
                        radius=14 * K, fill=CARD, outline=CARD_BORDER, width=max(1, int(K)))
    for i, c in enumerate([(255, 95, 86), (255, 189, 46), (39, 201, 63)]):
        cx = (PAD + 18 + i * 16) * K
        d.ellipse([cx, (top + 15) * K, cx + 9 * K, (top + 24) * K], fill=c)

    x0 = PAD + 20
    y = top + 46
    draw_text(d, f"❯ {typed}", x0, y, f["mono"], f["cjk"], PROMPT)
    if len(typed) < len(step["cmd"]):
        cells = sum(2 if is_cjk(c) else 1 for c in f"❯ {typed}")
        cx = x0 + cells * (f["mono"].getlength("M") / K)
        d.rectangle([cx * K, y * K, (cx + 7) * K, (y + 16) * K], fill=BLUE)
    y += 30

    for raw in pick_lines(shown_lines):
        color = DIM
        if "✓" in raw:
            color = GREEN
        elif "✗" in raw or "⛔" in raw or "BLOCKED" in raw:
            color = RED
        elif "⚠" in raw:
            color = YELLOW
        elif "结论" in raw or "已推进" in raw:
            color = INK
        if y > top + 268:
            break
        draw_text(d, truncate(raw.strip(), 88), x0, y, f["mono"], f["cjk"], color)
        y += 24

    # 说明
    for i, piece in enumerate(wrap(step["caption"], 52)[:2]):
        draw_text(d, piece, PAD + 4, 414 + i * 26, f["mid"], f["cjk_mid"], INK)

    # 状态轨
    sy = 474
    active = next((i for i, (k, _) in enumerate(STATES) if k == step["state"]), 0)
    x = PAD
    for i, (key, label) in enumerate(STATES):
        w = text_w(label, f["mono_small"], f["cjk_small"]) + 26
        if i == active:
            pill(d, x, sy, w, 30, (22, 62, 40), GREEN)
            draw_text(d, label, x + 13, sy + 8, f["mono_small"], f["cjk_small"], GREEN)
        else:
            pill(d, x, sy, w, 30, (14, 20, 27), CARD_BORDER)
            draw_text(d, label, x + 13, sy + 8, f["mono_small"], f["cjk_small"],
                      DIM if i < active else (92, 104, 118))
        x += w + 8

    # 门禁 chips
    gy = 526
    draw_text(d, "门禁", PAD + 2, gy + 4, f["small_m"], f["cjk_small"], DIM)
    gx = PAD + 54
    gates = step.get("gates", [])
    # 1200 宽放得下 11 个 chip；再多才裁（并保住末尾的 G9）
    gates = gates if len(gates) <= 12 else gates[:8] + gates[-4:]
    for g in gates:
        mark, name = g["mark"], g["name"]
        color = {"✓": GREEN, "✗": RED, "⚠": YELLOW, "■": YELLOW, "⛔": RED}.get(mark, DIM)
        text = f"{mark} {name}"
        w = text_w(text, f["mono_small"], f["cjk_small"]) + 18
        pill(d, gx, gy, w, 26, (13, 19, 26), color)
        draw_text(d, text, gx + 9, gy + 6, f["mono_small"], f["cjk_small"], color)
        gx += w + 8
        if gx > LW - PAD - 50:
            break

    draw_text(d, f"可复跑：python3 tools/demo/capture_flow.py && python3 tools/make_flow_gif.py"
                 f"   ·   devflow {DATA.get('kit_version', '')}",
              PAD, LH - 34, f["mono_small"], f["cjk_small"], (84, 96, 110))

    return img.resize((int(LW * SCALE), int(LH * SCALE)), Image.LANCZOS)


def storyboard(frames, out_png, ends):
    """四格故事板：取第 2/5/7/9 步的**末帧**（输出已完整），比按比例抽帧可靠。"""
    want = [1, 5, 6, 8]   # 建变更 / 提测被拒 / 待验证 / 已发布
    picks = [frames[ends[i]] for i in want if i < len(ends)]
    w, h = picks[0].size
    gap = int(12 * SCALE)
    canvas = Image.new("RGB", (w * 2 + gap, h * 2 + gap), (237, 240, 244))
    for i, im in enumerate(picks):
        canvas.paste(im, ((i % 2) * (w + gap), (i // 2) * (h + gap)))
    canvas.save(out_png, optimize=True)


def main() -> int:
    global DATA
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", required=True)
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    DATA = json.load(open(args.data, encoding="utf-8"))
    FONTS.update({
        "h1": load(CJK_FONTS, 24), "small": load(CJK_FONTS, 14), "small_m": load(MONO_FONTS, 13),
        "mid": load(MONO_FONTS, 18), "cjk_mid": load(CJK_FONTS, 18),
        "mono": load(MONO_FONTS, 15), "cjk": load(CJK_FONTS, 15),
        "mono_small": load(MONO_FONTS, 12), "cjk_small": load(CJK_FONTS, 12),
        "mono_mid": load(MONO_FONTS, 15),
    })

    steps = DATA["steps"]
    total = len(steps)
    frames = []
    ends = []
    for idx, step in enumerate(steps):
        cmd = step["cmd"]
        for n in range(0, len(cmd) + 1, 12):
            frames.append(frame(step, idx, total, cmd[:n], []))
        shown = []
        for line in step["lines"]:
            shown = shown + [line]
            frames.append(frame(step, idx, total, cmd, shown))
        for _ in range(3):
            frames.append(frame(step, idx, total, cmd, shown))
        ends.append(len(frames) - 1)

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    base = frames[-1].quantize(colors=96, method=Image.MEDIANCUT)
    qframes = [f.quantize(palette=base, dither=Image.NONE) for f in frames]
    qframes[0].save(args.out, save_all=True, append_images=qframes[1:], duration=int(1000 / FPS),
                    loop=0, optimize=True, disposal=2)

    poster = os.path.splitext(args.out)[0] + ".png"
    frames[-1].save(poster, optimize=True)
    storyboard(frames, os.path.splitext(args.out)[0] + "-story.png", ends)

    print(f"{args.out}  {len(frames)} 帧  {os.path.getsize(args.out)/1048576:.2f}MB  {frames[0].size}")
    print(poster)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
