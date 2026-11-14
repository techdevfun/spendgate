#!/usr/bin/env python3
"""Render demo/transcript.txt as a terminal-typing GIF.

The transcript is generated from real CLI runs (scripts/capture-demo.sh);
this script only renders it, never edits the content.

Frames are written as PNGs to a temp dir and encoded with ffmpeg
(streaming, low memory) instead of holding every frame in RAM.
"""
from PIL import Image, ImageDraw, ImageFont
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
FRAMES_DIR = "/tmp/spendgate-gif-frames"

W = 1240
BG = (18, 18, 24)
FG = (220, 220, 220)
DIM = (150, 150, 160)
GREEN = (120, 220, 130)
YELLOW = (235, 200, 100)
RED = (240, 110, 110)
CYAN = (120, 200, 230)

font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 12)
bold = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", 12)
LINE_H = 16

lines = open(os.path.join(ROOT, "demo", "transcript.txt")).read().splitlines()
# Fixed-height scrolling terminal viewport: the transcript is long,
# so a full-height canvas OOMs the encoder. Show the last VIEW_LINES
# lines like a real terminal scrolling; content is unchanged.
VIEW_LINES = 38
H = 14 + VIEW_LINES * LINE_H + 44

def color_for(line: str):
    if line.startswith("$"):
        return GREEN
    if line.startswith("#"):
        return DIM
    if line.startswith("verdict: DENY"):
        return RED
    if line.startswith("verdict: REVIEW"):
        return YELLOW
    if line.startswith("verdict: ALLOW"):
        return GREEN
    if line.startswith("check FAILED"):
        return RED
    if line.startswith("check OK"):
        return GREEN
    if line.startswith("total spent"):
        return CYAN
    if line.startswith("  - "):
        return YELLOW
    if line.startswith("recorded as ledger"):
        return CYAN
    return FG

shutil.rmtree(FRAMES_DIR, ignore_errors=True)
os.makedirs(FRAMES_DIR)

def render(canvas_tmp):
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)
    y = 14
    for text, color in canvas_tmp[-VIEW_LINES:]:
        f = bold if text.startswith("$") else font
        d.text((14, y), text, font=f, fill=color)
        y += LINE_H
        if y > H - 30:
            break
    d.rectangle([14, H - 24, 22, H - 12], fill=GREEN)
    return img

n = 0
def save(img):
    global n
    n += 1
    img.save(os.path.join(FRAMES_DIR, f"frame{n:04d}.png"))

# Title card (3s at 20 fps).
title = Image.new("RGB", (W, H), BG)
d = ImageDraw.Draw(title)
d.text((14, 120), "spendgate - a $1 per-call cap cannot see a loop. A cumulative cap can.", font=bold, fill=GREEN)
d.text((14, 170), "1. init: scaffold policy + empty ledger", font=font, fill=FG)
d.text((14, 200), "2. simulate the Brave $0.005 fixture: ALLOW", font=font, fill=FG)
d.text((14, 230), "3. record 500 x $0.005: ledger reaches the $2.50 per-day cap", font=font, fill=FG)
d.text((14, 260), "4. 501st identical payment: DENY on the cumulative cap", font=font, fill=FG)
d.text((14, 290), "5. lookalike payee: REVIEW - denylist payee: DENY", font=font, fill=FG)
d.text((14, 320), "6. report $2.50, check exit 0, hash chain intact", font=font, fill=FG)
d.text((14, 390), "zero-dep CLI - offline, no wallet, no signing", font=font, fill=DIM)
d.text((14, 420), "synthetic fixtures, real CLI output", font=font, fill=DIM)
for _ in range(60):
    save(title.copy())

# Extra hold frames so a first-time viewer can actually read the
# verdict lines and the report. Total target is ~30 s at 20 fps.
def extra_holds(line: str) -> int:
    if line.startswith("verdict:"):
        return 20
    if line.startswith("total spent"):
        return 20
    if line.startswith("check OK"):
        return 30
    if line.startswith("check FAILED"):
        return 20
    return 0

canvas: list[tuple[str, tuple]] = []
for line in lines:
    color = color_for(line)
    # Two typing steps per line + one hold: ~3 frames/line keeps the
    # total near 30 s at 20 fps without holding frames in memory.
    half = line[: max(1, len(line) // 2)]
    save(render(canvas + [(half, color)]))
    save(render(canvas + [(line, color)]))
    canvas.append((line, color))
    save(render(canvas))
    for _ in range(extra_holds(line)):
        save(render(canvas))

out = os.path.join(ROOT, "demo", "spendgate-demo.gif")
cmd = [
    "ffmpeg", "-y", "-v", "error",
    "-framerate", "20", "-i", os.path.join(FRAMES_DIR, "frame%04d.png"),
    "-vf", "split[s0][s1];[s0]palettegen=max_colors=256[p];[s1][p]paletteuse",
    out,
]
res = subprocess.run(cmd)
if res.returncode != 0:
    print("ffmpeg failed", file=sys.stderr)
    sys.exit(1)
shutil.rmtree(FRAMES_DIR, ignore_errors=True)
size = os.path.getsize(out)
print(f"GIF written: {out} ({n} frames, {n * 50 / 1000:.1f}s, {size} bytes)")
