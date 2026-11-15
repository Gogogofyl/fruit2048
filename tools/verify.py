# -*- coding: utf-8 -*-
import os, numpy as np
from PIL import Image
d = r"D:\fylcode\DigitalHuman\小游戏2048\assets\fruits\processed"
files = sorted(f for f in os.listdir(d) if f.endswith(".png"))
tiles = []
for fn in files:
    im = Image.open(os.path.join(d, fn)).convert("RGBA")
    a = np.asarray(im)[..., 3]
    corner = np.concatenate([a[:5, :5].ravel(), a[-5:, -5:].ravel()])
    holes = ((a > 10) & (a < 245)).mean() * 100  # 半透明边缘占比
    print(f"{fn}  角落alpha中位={np.median(corner):.0f}  半透明占比={holes:.1f}%  不透明={(a>128).mean()*100:.0f}%")
    tiles.append(im)

# 拼 4x2 拼图，叠在中性灰底上查看白边/镂空
cols, rows = 4, 2
cell = 256
sheet = Image.new("RGBA", (cols*cell, rows*cell), (128, 128, 128, 255))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % cols)*cell, (i//cols)*cell), t)
sheet.convert("RGB").save(r"D:\fylcode\DigitalHuman\小游戏2048\tools\_contact_sheet.png")
print("sheet saved")
