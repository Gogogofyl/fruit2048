"""从水果 PNG 的 alpha 提取轮廓与高度场，生成 local/js/fruit-shapes.js

轮廓用来挤出"果体厚度"，高度场用来把正面贴图鼓成圆润曲面。
"""
import base64
import io
import json
import os
import sys

import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "local", "images", "fruits")
OUT = os.path.join(ROOT, "local", "js", "fruit-shapes.js")

# 与 game_manager.js 的 FRUIT_ORDER 对齐
LEVELS = [
    (2, "02-blueberry.png"),
    (4, "04-grape.png"),
    (8, "08-orange.png"),
    (16, "16-peach.png"),
    (32, "32-pineapple.png"),
    (64, "64-coconut.png"),
    (128, "128-melon.png"),
    (256, "256-kiwi-gold.png"),
    (512, "512-strawberry.png"),
    (1024, "1024-dragonfruit.png"),
    (2048, "2048-golden-watermelon.png"),
]

HMAP_SIZE = 32  # 高度场采样分辨率
ALPHA_CUT = 110


def label_components(mask, min_ratio=0.06):
    """4-连通标记，丢掉小于主体一定比例的碎片。"""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    comps = []
    total = int(mask.sum())

    for y0 in range(h):
        for x0 in range(w):
            if not mask[y0, x0] or seen[y0, x0]:
                continue
            stack = [(y0, x0)]
            seen[y0, x0] = True
            pix = []
            while stack:
                y, x = stack.pop()
                pix.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        stack.append((ny, nx))
            if total > 0 and len(pix) / total >= min_ratio:
                cm = np.zeros_like(mask, dtype=np.uint8)
                for y, x in pix:
                    cm[y, x] = 1
                comps.append(cm)

    comps.sort(key=lambda m: -int(m.sum()))
    return comps


def polar_profile(mask, buckets=72):
    """按质心极角分桶，每桶取最远边界点 —— 得到有序的星形轮廓，不怕多块粘连。"""
    ys, xs = np.where(mask)
    if len(xs) == 0:
        return []

    cx, cy = float(xs.mean()), float(ys.mean())

    er = Image.fromarray((mask > 0).astype(np.uint8) * 255, mode="L")
    inner = np.asarray(er.filter(ImageFilter.MinFilter(3)), dtype=np.uint8) > 127
    edge = (mask > 0) & ~inner

    ey, ex = np.where(edge)
    if len(ex) == 0:
        return []

    ang = np.arctan2(ey - cy, ex - cx)
    rad = np.sqrt((ex - cx) ** 2 + (ey - cy) ** 2)

    idx = ((ang + np.pi) / (2 * np.pi) * buckets).astype(int) % buckets

    best = {}
    for i, r in zip(idx.tolist(), rad.tolist()):
        if i not in best or r > best[i]:
            best[i] = r

    if len(best) < buckets // 2:
        return []

    out = []
    for b in range(buckets):
        if b in best:
            r = best[b]
        else:
            # 空洞用左右最近的桶插值，保证点序连续
            lo = b - 1
            while lo % buckets not in best:
                lo -= 1
            hi = b + 1
            while hi % buckets not in best:
                hi += 1
            rl = best[lo % buckets]
            rh = best[hi % buckets]
            t = (b - lo) / float(hi - lo)
            r = rl + (rh - rl) * t

        a = -np.pi + (b + 0.5) / buckets * 2 * np.pi
        out.append((cx + r * np.cos(a), cy + r * np.sin(a)))

    return out


def trace_boundary(mask):
    """Moore 邻域追踪外轮廓，返回 (y, x) 序列。"""
    ys, xs = np.where(mask)
    if len(ys) == 0:
        return []

    sy = int(ys.min())
    sx = int(xs[ys == sy].min())

    nbr = [(-1, -1), (-1, 0), (-1, 1), (0, 1), (1, 1), (1, 0), (1, -1), (0, -1)]
    h, w = mask.shape

    start = (sy, sx)
    p = start
    prev_dir = 7
    pts = [p]

    for _ in range(w * h * 4):
        moved = False
        for k in range(8):
            d = (prev_dir + 1 + k) % 8
            ny = p[0] + nbr[d][0]
            nx = p[1] + nbr[d][1]
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx]:
                prev_dir = d
                p = (ny, nx)
                pts.append(p)
                moved = True
                break
        if not moved:
            break
        if p == start and len(pts) > 3:
            break

    return pts


def rdp(points, eps):
    """Ramer-Douglas-Peucker 折线简化。"""
    if len(points) < 3:
        return points

    def dist_to_seg(pt, a, b):
        ax, ay = a
        bx, by = b
        px, py = pt
        dx, dy = bx - ax, by - ay
        if dx == 0 and dy == 0:
            return ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
        t = ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)
        t = max(0.0, min(1.0, t))
        cx, cy = ax + t * dx, ay + t * dy
        return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5

    dmax = 0.0
    index = 0
    for i in range(1, len(points) - 1):
        d = dist_to_seg(points[i], points[0], points[-1])
        if d > dmax:
            dmax = d
            index = i

    if dmax > eps:
        left = rdp(points[: index + 1], eps)
        right = rdp(points[index:], eps)
        return left[:-1] + right
    return [points[0], points[-1]]


def build_height(mask_img):
    """高斯模糊近似距离场：中心接近 1，边缘趋 0。"""
    blur = mask_img.filter(ImageFilter.GaussianBlur(radius=16))
    h = np.asarray(blur, dtype=np.float32) / 255.0
    m = np.asarray(mask_img, dtype=np.float32) / 255.0
    h = h * m
    peak = float(h.max()) or 1.0
    h = h / peak
    h = np.clip(h, 0.0, 1.0) ** 0.85

    small = Image.fromarray((h * 255).astype(np.uint8), mode="L")
    small = small.resize((HMAP_SIZE, HMAP_SIZE), Image.BILINEAR)
    return np.asarray(small, dtype=np.uint8)


def edge_color(rgba, mask):
    """取贴近轮廓一圈像素的平均色，用作果体侧壁颜色。"""
    er = Image.fromarray((mask * 255).astype(np.uint8), mode="L")
    inner = np.asarray(er.filter(ImageFilter.MinFilter(5)), dtype=np.float32) / 255.0
    ring = (mask > 0) & (inner < 0.5)
    if ring.sum() == 0:
        ring = mask > 0
    px = rgba[ring]
    rgb = px[:, :3].mean(axis=0)
    return "#%02x%02x%02x" % (int(rgb[0]), int(rgb[1]), int(rgb[2]))


def main():
    if not os.path.isdir(SRC):
        print("素材目录不存在:", SRC)
        return 1

    data = {}
    widths = []

    for level, name in LEVELS:
        path = os.path.join(SRC, name)
        if not os.path.exists(path):
            print("缺少素材:", name)
            return 1

        img = Image.open(path).convert("RGBA")
        rgba = np.asarray(img, dtype=np.uint8)
        alpha = rgba[:, :, 3]
        mask = (alpha > ALPHA_CUT).astype(np.uint8)

        # 填充主体内部的小洞，避免轮廓追踪钻进果肉缝隙
        m_img = Image.fromarray(mask * 255, mode="L")
        m_img = m_img.filter(ImageFilter.MaxFilter(3)).filter(ImageFilter.MinFilter(3))
        mask = (np.asarray(m_img, dtype=np.uint8) > 127).astype(np.uint8)

        pts = polar_profile(mask)
        if len(pts) < 12:
            print("轮廓点太少:", name, len(pts))
            return 1

        simple = rdp(pts, 1.6)
        if len(simple) < 10:
            simple = pts

        ys, xs = np.where(mask)
        bx0, bx1 = int(xs.min()), int(xs.max())
        by0, by1 = int(ys.min()), int(ys.max())
        bw, bh = bx1 - bx0 + 1, by1 - by0 + 1
        widths.append(bw)

        hmap = build_height(m_img)
        # 原始字节直出 base64：JS 侧 atob 同步解码，不用等图片加载
        hb64 = base64.b64encode(np.asarray(hmap, dtype=np.uint8).tobytes()).decode("ascii")

        data[str(level)] = {
            # 归一化到以 bbox 左上角为原点、宽度为 1 的坐标系，y 向上
            "w": bw,
            "h": bh,
            "hsize": HMAP_SIZE,
            # 贴图里主体所占的 UV 范围，果面按它取图，否则会把透明留白一起铺上
            "u0": round(bx0 / float(img.width), 4),
            "u1": round((bx1 + 1) / float(img.width), 4),
            "v0": round(1.0 - (by1 + 1) / float(img.height), 4),
            "v1": round(1.0 - by0 / float(img.height), 4),
            "pts": [[round((x - bx0) / bw, 4), round(1.0 - (y - by0) / bh, 4)] for x, y in simple],
            "hmap": hb64,
            "color": edge_color(rgba, mask),
        }

        print("%-5s %-28s 轮廓 %3d 点 -> %2d 点, bbox %3dx%-3d, 边色 %s" % (
            level, name, len(pts), len(simple), bw, bh, data[str(level)]["color"]))

    js = (
        "// 由 tools/gen_fruit_shapes.py 生成，勿手改\n"
        "var FRUIT_SHAPES = " + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n"
    )

    with open(OUT, "w", encoding="utf-8") as f:
        f.write(js)

    print("\n写入 %s (%.1f KB)" % (OUT, os.path.getsize(OUT) / 1024))
    return 0


if __name__ == "__main__":
    sys.exit(main())
