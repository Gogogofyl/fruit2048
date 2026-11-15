# -*- coding: utf-8 -*-
"""
生成软件著作权登记用「源程序」PDF（一般交存格式）。

规范要点（中国版权保护中心）：
- 页眉标注 软件名称、版本号、页码，且必须与申请表完全一致
- 程序每页不少于 50 行
- 整个程序不足 60 页的，提交全部源程序
- 最后一页结尾应为正常代码结尾（如 }）

本软件共 1400+ 行，按每页 50 行排版，全部提交。
"""

import os
import math
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont

ROOT = r"D:\fylcode\DigitalHuman\小游戏2048"
OUT_DIR = os.path.join(ROOT, "soft-copyright")
os.makedirs(OUT_DIR, exist_ok=True)

APP_NAME = "珍馐水果合成"
VERSION = "V1.0"
LINES_PER_PAGE = 70

FONT_PATH = r"C:\Windows\Fonts\simhei.ttf"
pdfmetrics.registerFont(TTFont("SimHei", FONT_PATH))
FONT_NAME = "SimHei"
FONT_SIZE = 7
LEADING = 10.5

# 源程序文件顺序：端侧逻辑 -> 渲染/平台 -> 服务端
SOURCE_FILES = [
    "minigame/js/tile.js",
    "minigame/js/grid.js",
    "minigame/js/storage_manager.js",
    "minigame/js/input_manager.js",
    "minigame/js/renderer.js",
    "minigame/js/game_manager.js",
    "minigame/js/platform.js",
    "minigame/cloud/src/server.js",
    "minigame/cloud/src/routes/login.js",
    "minigame/cloud/src/routes/report.js",
    "minigame/cloud/src/routes/leaderboard.js",
    "minigame/cloud/src/routes/myRank.js",
    "minigame/cloud/src/shared/db.js",
    "minigame/cloud/src/shared/rank.js",
    "minigame/cloud/src/shared/respond.js",
]


def read_lines(rel_path):
    path = os.path.join(ROOT, rel_path)
    with open(path, "r", encoding="utf-8", errors="replace") as f:
        raw = f.read().replace("\r\n", "\n").replace("\r", "\n")
    return raw.split("\n")


def collect():
    lines = []
    for idx, rel in enumerate(SOURCE_FILES):
        if idx > 0:
            lines.append("")
            lines.append("")
        lines.append("// file: " + rel.replace("/", "\\"))
        lines.extend(read_lines(rel))
    # 去掉末尾多余空行，保证最后一页以代码结尾
    while lines and not lines[-1].strip():
        lines.pop()
    return lines


def wrap_line(text, max_width):
    """按渲染宽度折行，避免长代码行溢出页面。"""
    if not text:
        return [""]
    out, cur = [], ""
    for ch in text:
        trial = cur + ch
        if pdfmetrics.stringWidth(trial, FONT_NAME, FONT_SIZE) > max_width and cur:
            out.append(cur)
            cur = ch
        else:
            cur = trial
    out.append(cur)
    return out


def build():
    lines = collect()
    total_pages = max(1, math.ceil(len(lines) / LINES_PER_PAGE))

    out_path = os.path.join(OUT_DIR, f"{APP_NAME}_{VERSION}_源程序.pdf")
    c = canvas.Canvas(out_path, pagesize=A4)
    width, height = A4

    left_margin = 40
    right_margin = 40
    top_y = height - 52
    bottom_limit = 42
    max_width = width - left_margin - right_margin

    page_no = 0
    for start in range(0, len(lines), LINES_PER_PAGE):
        page_no += 1
        chunk = lines[start:start + LINES_PER_PAGE]

        # 页眉
        c.setFont(FONT_NAME, 9)
        c.drawString(left_margin, height - 32, f"{APP_NAME} {VERSION}")
        c.drawRightString(width - right_margin, height - 32, f"第 {page_no} 页 / 共 {total_pages} 页")
        c.setLineWidth(0.5)
        c.line(left_margin, height - 40, width - right_margin, height - 40)

        c.setFont(FONT_NAME, FONT_SIZE)
        y = top_y
        for src_line in chunk:
            for seg in wrap_line(src_line, max_width):
                if y < bottom_limit:
                    break
                c.drawString(left_margin, y, seg)
                y -= LEADING
            if y < bottom_limit:
                break

        c.showPage()

    c.save()
    return out_path, len(lines), total_pages


if __name__ == "__main__":
    out, total_lines, pages = build()
    print("文件:", out)
    print("源码总行数:", total_lines)
    print("总页数:", pages)
    print("文件大小:", os.path.getsize(out), "字节")
