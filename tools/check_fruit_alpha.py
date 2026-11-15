"""检查 FRUIT_TEXTURES 里的图是否带真实 alpha，并输出每级 bbox。"""
import re, base64, io, json
from PIL import Image

SRC = r"D:\fylcode\DigitalHuman\小游戏2048\local\js\fruits-data.js"
s = open(SRC, encoding="utf-8").read()

pairs = re.findall(r'(\d{1,4})\s*:\s*"data:image/(\w+);base64,([A-Za-z0-9+/=]+)"', s)
print("found", len(pairs), "entries")
for val, fmt, b64 in pairs:
    img = Image.open(io.BytesIO(base64.b64decode(b64)))
    mode = img.mode
    alpha_info = "-"
    bbox = img.getbbox()
    if "A" in mode:
        a = img.getchannel("A")
        lo, hi = a.getextrema()
        # 计算 alpha>16 的像素占比
        hist = a.histogram()
        solid = sum(hist[17:])
        total = img.width * img.height
        alpha_info = "alpha min=%d max=%d solid=%.1f%%" % (lo, hi, solid * 100.0 / total)
    print(val, fmt, mode, "%dx%d" % (img.size), "bbox=", bbox, alpha_info)
