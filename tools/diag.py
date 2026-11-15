# -*- coding: utf-8 -*-
import os, numpy as np
from PIL import Image
d = r"D:\fylcode\DigitalHuman\小游戏2048\assets\fruits"
for fn in ['02-blueberry.png', '08-orange.png', '16-peach.png', '256-kiwi-gold.png', '32-pineapple.png']:
    a = np.asarray(Image.open(os.path.join(d, fn)).convert('RGB')).astype(float)
    h, w, _ = a.shape
    edge = np.concatenate([a[:20].reshape(-1, 3), a[-20:].reshape(-1, 3),
                           a[:, :20].reshape(-1, 3), a[:, -20:].reshape(-1, 3)])
    mx = edge.max(1); mn = edge.min(1)
    sat = (mx - mn) / np.clip(mx, 1, None)
    c = a[h//2-30:h//2+30, w//2-30:w//2+30].reshape(-1, 3)
    cmx = c.max(1); cmn = c.min(1)
    csat = (cmx - cmn) / np.clip(cmx, 1, None)
    print(fn)
    print('  edge  RGB', edge.mean(0).round(1), 'sat', round(sat.mean(), 3), 'V', round(mx.mean(), 1))
    print('  center RGB', c.mean(0).round(1), 'sat', round(csat.mean(), 3), 'V', round(cmx.mean(), 1))
