"""检测并修复 FRUIT_TEXTURES 的 alpha 缺陷。

两类缺陷：
A. 内部孔洞：轮廓内部 alpha 掉到 0（四边 flood fill 背景后未被访问到的 0 像素）
B. 边缘毛刺/碎屑：轮廓外的孤立小块，以及凹进去的锯齿缺口

用法：
  python tools/fix_fruit_alpha.py                     # 只诊断
  python tools/fix_fruit_alpha.py --preview 16        # 输出修好的 16 级到 local/images/_fix16.png
  python tools/fix_fruit_alpha.py --write 16          # 回写 fruits-data.js（可写多个等级）
"""
import re, base64, io, sys
from collections import deque
from PIL import Image, ImageFilter

SRC = r"D:\fylcode\DigitalHuman\小游戏2048\local\js\fruits-data.js"
PREVIEW_DIR = r"D:\fylcode\DigitalHuman\小游戏2048\local\images"
THRESH = 110
SOFT = 16              # 半透明碎块的判定阈值
MIN_BLOB = 400         # 小于这个像素数的连通块算碎屑（叶片通常 3000+，不会被误删）
CLOSE_K = 11           # 闭运算核：填平深达约 5px 的边缘凹口与锯齿
FEATHER = 0.55         # 边缘羽化半径


def load_pairs(s):
    return re.findall(r'(\d{1,4})\s*:\s*"data:image/(\w+);base64,([A-Za-z0-9+/=]+)"', s)


def solid_mask(a):
    return [[a.getpixel((x, y)) > THRESH for x in range(a.width)] for y in range(a.height)]


def find_holes(img):
    w, h = img.size
    a = img.getchannel("A")
    solid = solid_mask(a)
    seen = [[False] * w for _ in range(h)]
    q = deque()
    for x in range(w):
        for y in (0, h - 1):
            if not solid[y][x] and not seen[y][x]:
                seen[y][x] = True
                q.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not solid[y][x] and not seen[y][x]:
                seen[y][x] = True
                q.append((x, y))
    while q:
        x, y = q.popleft()
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and not seen[ny][nx] and not solid[ny][nx]:
                seen[ny][nx] = True
                q.append((nx, ny))
    return {(x, y) for y in range(h) for x in range(w) if not solid[y][x] and not seen[y][x]}


def label_blobs(mask):
    """返回所有连通域的像素列表（按面积从大到小）。"""
    w, h = mask.size
    px = mask.load()
    seen = [[False] * w for _ in range(h)]
    blobs = []
    for y in range(h):
        for x in range(w):
            if px[x, y] > 0 and not seen[y][x]:
                comp = []
                q = deque([(x, y)])
                seen[y][x] = True
                while q:
                    cx, cy = q.popleft()
                    comp.append((cx, cy))
                    for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                        nx, ny = cx + dx, cy + dy
                        if 0 <= nx < w and 0 <= ny < h and px[nx, ny] > 0 and not seen[ny][nx]:
                            seen[ny][nx] = True
                            q.append((nx, ny))
                blobs.append(comp)
    blobs.sort(key=len, reverse=True)
    return blobs


def paint_from_nearest(img, targets):
    """用最近的实心像素颜色填充 targets 里的像素，并置为不透明。"""
    if not targets:
        return img
    w, h = img.size
    src = img.load()
    out = img.copy()
    opx = out.load()
    done = set()
    q = deque()
    for x, y in targets:
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) not in targets and src[nx, ny][3] > THRESH:
                r, g, b, _ = src[nx, ny]
                opx[x, y] = (r, g, b, 255)
                done.add((x, y))
                q.append((x, y))
                break
    while q:
        x, y = q.popleft()
        col = opx[x, y]
        for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            nx, ny = x + dx, y + dy
            if 0 <= nx < w and 0 <= ny < h and (nx, ny) in targets and (nx, ny) not in done:
                done.add((nx, ny))
                opx[nx, ny] = col
                q.append((nx, ny))
    return out


def repair(img):
    """补内部孔洞 + 去边缘碎屑 + 平滑锯齿 + 羽化。返回 (新图, 处理说明)。"""
    w, h = img.size
    a = img.getchannel("A")
    holes = find_holes(img)
    img = paint_from_nearest(img, holes)

    mask = a.point(lambda v: 255 if v > THRESH else 0)
    soft = a.point(lambda v: 255 if v > SOFT else 0)
    blobs = label_blobs(soft)
    notes = []
    if holes:
        notes.append("补孔 %d px" % len(holes))

    # 碎屑：半透明小碎块也算，按面积筛掉（叶片面积远大于阈值，不会被误删）
    junk = set()
    junk_count = 0
    for comp in blobs:
        if len(comp) < MIN_BLOB:
            junk.update(comp)
            junk_count += 1
    if junk:
        mp = soft.load()
        for x, y in junk:
            mp[x, y] = 0
        notes.append("去碎屑 %d px / %d 块" % (len(junk), junk_count))

    # 闭运算平滑：先膨胀补缺口，再腐蚀回原尺寸
    before = mask.copy()
    mask = mask.filter(ImageFilter.MaxFilter(CLOSE_K)).filter(ImageFilter.MinFilter(CLOSE_K))
    grown = {p for p in ((x, y) for y in range(h) for x in range(w))
             if mask.getpixel(p) > 0 and before.getpixel(p) == 0}
    if grown:
        img = paint_from_nearest(img, grown)
        notes.append("补边缘 %d px" % len(grown))

    # 羽化：消除硬锯齿，只在原 alpha 更高时保留原值
    smooth = mask.filter(ImageFilter.GaussianBlur(FEATHER))
    base = img.getchannel("A")
    final = Image.new("L", (w, h), 0)
    fp = final.load()
    bp = base.load()
    sp = smooth.load()
    jp = soft.load()
    for y in range(h):
        for x in range(w):
            if jp[x, y] == 0:
                fp[x, y] = 0
                continue
            v = sp[x, y]
            if mask.getpixel((x, y)) > 0 and bp[x, y] > 200:
                v = 255
            fp[x, y] = max(bp[x, y], v) if bp[x, y] > THRESH else v
    img.putalpha(final)
    return img, ("；".join(notes) if notes else "无需处理")


def main():
    args = sys.argv[1:]
    write_vals = set()
    preview_vals = set()
    if "--write" in args:
        i = args.index("--write")
        for t in args[i + 1:]:
            if t.isdigit():
                write_vals.add(int(t))
            else:
                break
    if "--preview" in args:
        i = args.index("--preview")
        for t in args[i + 1:]:
            if t.isdigit():
                preview_vals.add(int(t))
            else:
                break

    s = open(SRC, encoding="utf-8").read()
    pairs = load_pairs(s)
    changed = {}
    print("%-5s %-10s %s" % ("等级", "孔洞", "处理"))
    for val, fmt, b64 in pairs:
        img = Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGBA")
        n_holes = len(find_holes(img))
        need = n_holes > 0 or int(val) in write_vals or int(val) in preview_vals
        if not need:
            print("%-5s %-10s 跳过" % (val, n_holes))
            continue
        fixed, note = repair(img)
        print("%-5s %-10s %s" % (val, n_holes, note))
        if int(val) in preview_vals:
            fixed.save("%s\\_fix%s.png" % (PREVIEW_DIR, val), format="PNG")
            print("      预览 -> local\\images\\_fix%s.png" % val)
        if int(val) in write_vals:
            buf = io.BytesIO()
            fixed.save(buf, format="PNG", optimize=True)
            changed[val] = base64.b64encode(buf.getvalue()).decode("ascii")

    for val, newb64 in changed.items():
        pat = re.compile(r'(\n\s*%s\s*:\s*"data:image/png;base64,)([A-Za-z0-9+/=]+)(")' % val)
        s, cnt = pat.subn(lambda m: m.group(1) + newb64 + m.group(3), s, count=1)
        print("回写 %s：替换 %d 处" % (val, cnt))
    if changed:
        open(SRC, "w", encoding="utf-8").write(s)
        print("已写入 fruits-data.js，大小 %d B" % len(s.encode("utf-8")))


if __name__ == "__main__":
    main()
