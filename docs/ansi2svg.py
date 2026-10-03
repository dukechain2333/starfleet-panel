#!/usr/bin/env python3
"""Render a `tmux capture-pane -e -p` dump as an SVG (and optionally a PNG).

Used to make docs/preview.svg from a real Claude Code session:

    tmux capture-pane -e -p -t <session> > capture.ans
    python3 docs/ansi2svg.py capture.ans docs/preview.svg --rows 37-44

Block elements (half blocks, quadrants, the gauge cells, the rule) are drawn
as rectangles rather than text, so the LCARS frame is crisp in any viewer
whatever fonts it has. Standard library only; `--png` needs Pillow.
"""

from __future__ import annotations

import argparse
import html
import re
import sys
import unicodedata

CELL_W = 9
CELL_H = 19
PAD = 16
FONT_SIZE = 15
BACKGROUND = "#0b0b0f"
FOREGROUND = "#d8d8d8"

# xterm 16-color palette, then the 6x6x6 cube and the grey ramp.
BASE16 = [
    "#000000", "#cd0000", "#00cd00", "#cdcd00", "#0000ee", "#cd00cd", "#00cdcd", "#e5e5e5",
    "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff",
]


def color256(n: int) -> str:
    if n < 16:
        return BASE16[n]
    if n < 232:
        n -= 16
        steps = [0, 95, 135, 175, 215, 255]
        return "#%02x%02x%02x" % (steps[n // 36], steps[(n // 6) % 6], steps[n % 6])
    v = 8 + (n - 232) * 10
    return "#%02x%02x%02x" % (v, v, v)


def cell_width(ch: str) -> int:
    if unicodedata.combining(ch):
        return 0
    return 2 if unicodedata.east_asian_width(ch) in ("W", "F") else 1


SGR = re.compile(r"\x1b\[([0-9;:]*)m")
OTHER_ESC = re.compile(r"\x1b(\[[0-9;?]*[A-Za-z]|\][^\x07]*\x07|[()][A-Z0-9])")


def parse(text: str):
    """Yields rows of cells: (char, fg, bg, bold, dim)."""
    rows = []
    for line in text.split("\n"):
        fg, bg, bold, dim = None, None, False, False
        cells = []
        pos = 0
        while pos < len(line):
            m = SGR.match(line, pos)
            if m:
                params = [p for p in re.split(r"[;:]", m.group(1))] if m.group(1) else ["0"]
                i = 0
                while i < len(params):
                    p = int(params[i] or 0)
                    if p == 0:
                        fg, bg, bold, dim = None, None, False, False
                    elif p == 1:
                        bold = True
                    elif p == 2:
                        dim = True
                    elif p == 22:
                        bold, dim = False, False
                    elif p == 39:
                        fg = None
                    elif p == 49:
                        bg = None
                    elif p in (38, 48) and i + 1 < len(params):
                        mode = int(params[i + 1] or 0)
                        if mode == 2 and i + 4 < len(params):
                            value = "#%02x%02x%02x" % tuple(int(x or 0) for x in params[i + 2 : i + 5])
                            i += 4
                        elif mode == 5 and i + 2 < len(params):
                            value = color256(int(params[i + 2] or 0))
                            i += 2
                        else:
                            value = None
                        if p == 38:
                            fg = value
                        else:
                            bg = value
                        i += 1
                    elif 30 <= p <= 37:
                        fg = BASE16[p - 30]
                    elif 90 <= p <= 97:
                        fg = BASE16[p - 90 + 8]
                    elif 40 <= p <= 47:
                        bg = BASE16[p - 40]
                    elif 100 <= p <= 107:
                        bg = BASE16[p - 100 + 8]
                    i += 1
                pos = m.end()
                continue
            m = OTHER_ESC.match(line, pos)
            if m:
                pos = m.end()
                continue
            ch = line[pos]
            pos += 1
            w = cell_width(ch)
            if w == 0:
                continue
            cells.append((ch, fg, bg, bold, dim))
            if w == 2:
                cells.append(("", fg, bg, bold, dim))
        rows.append(cells)
    return rows


# Block glyphs as rectangles in a unit cell: (x, y, w, h) fractions.
BLOCKS = {
    "█": [(0, 0, 1, 1)],
    "▀": [(0, 0, 1, 0.5)],
    "▄": [(0, 0.5, 1, 0.5)],
    "▌": [(0, 0, 0.5, 1)],
    "▐": [(0.5, 0, 0.5, 1)],
    "▖": [(0, 0.5, 0.5, 0.5)],
    "▗": [(0.5, 0.5, 0.5, 0.5)],
    "▘": [(0, 0, 0.5, 0.5)],
    "▝": [(0.5, 0, 0.5, 0.5)],
    "━": [(0, 0.42, 1, 0.16)],
    "─": [(0, 0.47, 1, 0.06)],
    "▰": [(0.12, 0.22, 0.76, 0.56)],
}
OUTLINES = {"▱": (0.12, 0.22, 0.76, 0.56)}


def dimmed(color: str) -> str:
    r, g, b = (int(color[i : i + 2], 16) for i in (1, 3, 5))
    return "#%02x%02x%02x" % (r // 2, g // 2, b // 2)


def to_svg(rows) -> str:
    width = max((len(r) for r in rows), default=0)
    w = PAD * 2 + width * CELL_W
    h = PAD * 2 + len(rows) * CELL_H
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}" '
        f'font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, \'DejaVu Sans Mono\', monospace" font-size="{FONT_SIZE}">',
        f'<rect width="100%" height="100%" rx="10" fill="{BACKGROUND}"/>',
    ]
    for y, row in enumerate(rows):
        top = PAD + y * CELL_H
        for x, (ch, fg, bg, bold, dim) in enumerate(row):
            left = PAD + x * CELL_W
            if bg:
                out.append(f'<rect x="{left}" y="{top}" width="{CELL_W + 0.4}" height="{CELL_H + 0.4}" fill="{bg}"/>')
        for x, (ch, fg, bg, bold, dim) in enumerate(row):
            if ch in ("", " "):
                continue
            left = PAD + x * CELL_W
            color = fg or FOREGROUND
            if dim:
                color = dimmed(color)
            if ch in BLOCKS:
                for fx, fy, fw, fh in BLOCKS[ch]:
                    out.append(
                        f'<rect x="{left + fx * CELL_W:.2f}" y="{top + fy * CELL_H:.2f}" '
                        f'width="{fw * CELL_W + 0.4:.2f}" height="{fh * CELL_H + 0.4:.2f}" fill="{color}"/>'
                    )
                continue
            if ch in OUTLINES:
                fx, fy, fw, fh = OUTLINES[ch]
                out.append(
                    f'<rect x="{left + fx * CELL_W + 0.5:.2f}" y="{top + fy * CELL_H + 0.5:.2f}" '
                    f'width="{fw * CELL_W - 1:.2f}" height="{fh * CELL_H - 1:.2f}" fill="none" stroke="{color}" stroke-width="1"/>'
                )
                continue
            weight = ' font-weight="bold"' if bold else ""
            out.append(
                f'<text x="{left}" y="{top + CELL_H - 5}" fill="{color}"{weight}>{html.escape(ch)}</text>'
            )
    out.append("</svg>")
    return "\n".join(out)


def to_png(rows, path: str) -> None:
    from PIL import Image, ImageDraw, ImageFont

    regular = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", FONT_SIZE - 1)
    bold_font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf", FONT_SIZE - 1)
    width = max((len(r) for r in rows), default=0)
    img = Image.new("RGB", (PAD * 2 + width * CELL_W, PAD * 2 + len(rows) * CELL_H), BACKGROUND)
    draw = ImageDraw.Draw(img)
    for y, row in enumerate(rows):
        top = PAD + y * CELL_H
        for x, (ch, fg, bg, bold, dim) in enumerate(row):
            left = PAD + x * CELL_W
            if bg:
                draw.rectangle([left, top, left + CELL_W, top + CELL_H], fill=bg)
            if ch in ("", " "):
                continue
            color = fg or FOREGROUND
            if dim:
                color = dimmed(color)
            if ch in BLOCKS:
                for fx, fy, fw, fh in BLOCKS[ch]:
                    draw.rectangle(
                        [left + fx * CELL_W, top + fy * CELL_H, left + (fx + fw) * CELL_W, top + (fy + fh) * CELL_H],
                        fill=color,
                    )
            elif ch in OUTLINES:
                fx, fy, fw, fh = OUTLINES[ch]
                draw.rectangle(
                    [left + fx * CELL_W, top + fy * CELL_H, left + (fx + fw) * CELL_W, top + (fy + fh) * CELL_H],
                    outline=color,
                )
            else:
                draw.text((left, top + 2), ch, fill=color, font=bold_font if bold else regular)
    img.save(path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("capture", help="a tmux capture-pane -e -p dump")
    parser.add_argument("svg", help="where to write the SVG")
    parser.add_argument("--rows", help="first-last rows to keep (0-based, inclusive)")
    parser.add_argument("--png", help="also write a PNG here (needs Pillow)")
    args = parser.parse_args()
    with open(args.capture, encoding="utf-8") as f:
        rows = parse(f.read())
    if args.rows:
        first, last = (int(n) for n in args.rows.split("-"))
        rows = rows[first : last + 1]
    while rows and not rows[-1]:
        rows.pop()
    with open(args.svg, "w", encoding="utf-8") as f:
        f.write(to_svg(rows))
    if args.png:
        to_png(rows, args.png)
    return 0


if __name__ == "__main__":
    sys.exit(main())
