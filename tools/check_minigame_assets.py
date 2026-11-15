import re, os, sys

base = r"D:\fylcode\DigitalHuman\小游戏2048\minigame"
r = open(os.path.join(base, "js", "renderer.js"), encoding="utf-8").read()
imgs = re.findall(r"img: '([^']+)'", r)
dst = os.path.join(base, "images", "fruits")
missing = []
for i in imgs:
    ok = os.path.exists(os.path.join(dst, i))
    print(("OK      " if ok else "MISSING ") + i)
    if not ok:
        missing.append(i)
print("count:", len(imgs), "missing:", missing)
sys.exit(1 if missing else 0)
