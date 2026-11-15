"""把背景图压成横版 JPEG 并写成 local/js/bg-data.js 的 base64 资源。"""
import base64
import io
import os

from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "local", "images", "bg-bokeh-src.jpg")
OUT = os.path.join(ROOT, "local", "js", "bg-data.js")
KEEP = os.path.join(ROOT, "local", "images", "bg-bokeh.jpg")

W, H = 1920, 1080
QUALITY = 80


def main():
    img = Image.open(SRC).convert("RGB")
    img = img.resize((W, H), Image.LANCZOS)

    # progressive=False：WebGL 那边 progressive JPEG 传不上纹理
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=QUALITY, optimize=True, progressive=False)
    raw = buf.getvalue()

    with open(KEEP, "wb") as f:
        f.write(raw)

    b64 = base64.b64encode(raw).decode("ascii")
    body = 'var BG_TEXTURE = "data:image/jpeg;base64,%s";\n' % b64

    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(body)

    print("jpeg bytes:", len(raw))
    print("bg-data.js bytes:", os.path.getsize(OUT))


if __name__ == "__main__":
    main()
