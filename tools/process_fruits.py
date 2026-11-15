# -*- coding: utf-8 -*-
"""统一处理 2048 水果素材：缩放到 256x256 -> 边缘连通泛洪去白底 -> 优化压缩 PNG。
原图保留在 assets/fruits，处理结果输出到 assets/fruits/processed。
"""
import os
from collections import deque
import numpy as np
from PIL import Image, ImageFilter

SRC = r"D:\fylcode\DigitalHuman\小游戏2048\assets\fruits"
DST = r"D:\fylcode\DigitalHuman\小游戏2048\assets\fruits\processed"
SIZE = 256
# 背景候选：高亮且低饱和
SAT_MAX, V_MIN = 0.14, 232.0

os.makedirs(DST, exist_ok=True)
files = sorted(f for f in os.listdir(SRC) if f.lower().endswith(".png"))

for fn in files:
    im = Image.open(os.path.join(SRC, fn)).convert("RGBA")
    im = im.resize((SIZE, SIZE), Image.LANCZOS)
    arr = np.array(im)
    rgb = arr[..., :3].astype(np.float32)
    alpha = arr[..., 3]

    # 已是真透明（角落 alpha 接近 0）则跳过抠图
    corner = np.median(np.concatenate([alpha[:4, :4].ravel(), alpha[-4:, -4:].ravel()]))
    if corner < 10:
        out = im
    else:
        mx = rgb.max(2); mn = rgb.min(2)
        sat = (mx - mn) / np.clip(mx, 1, None)
        bg_cand = (sat < SAT_MAX) & (mx > V_MIN)
        h, w = bg_cand.shape
        visited = np.zeros_like(bg_cand, dtype=bool)
        dq = deque()
        for x in range(w):
            for y in (0, h - 1):
                if bg_cand[y, x] and not visited[y, x]:
                    visited[y, x] = True; dq.append((y, x))
        for y in range(h):
            for x in (0, w - 1):
                if bg_cand[y, x] and not visited[y, x]:
                    visited[y, x] = True; dq.append((y, x))
        while dq:
            y, x = dq.popleft()
            for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                ny, nx = y + dy, x + dx
                if 0 <= ny < h and 0 <= nx < w and bg_cand[ny, nx] and not visited[ny, nx]:
                    visited[ny, nx] = True; dq.append((ny, nx))
        new_a = np.where(visited, 0, 255).astype(np.uint8)
        arr[..., 3] = new_a
        out = Image.fromarray(arr, "RGBA")
        # 轻微羽化边缘，去锯齿
        a = out.getchannel("A").filter(ImageFilter.GaussianBlur(0.8))
        out.putalpha(a)

    dst_path = os.path.join(DST, fn)
    out.save(dst_path, optimize=True)
    aa = np.asarray(out)[..., 3]
    opaque = (aa > 128).mean() * 100
    print(f"{fn}  {out.size}  {os.path.getsize(dst_path)//1024} KB  主体占比 {opaque:.0f}%")
