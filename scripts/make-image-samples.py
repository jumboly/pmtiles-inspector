"""
Raster Inspector のテスト用に、寸法が既知の小さな画像を各形式で作る。

なぜ自前で bytes を組み立てずに外部 encoder (Pillow / cwebp / sips) を使うのか:
header parser を自作しているので、入力まで自作すると同じ誤解を両側に埋め込んでもテストが通ってしまう。
幅と高さを別の値（37 x 23、どちらも奇数）にしているのは、width と height の取り違えや
「- 1」の付け忘れ（VP8L / VP8X は寸法 - 1 を格納する）をテストで検出するため。

使い方: python3 scripts/make-image-samples.py tests/data/images
"""
import os, subprocess, sys, tempfile
from PIL import Image

W, H = 37, 23
out = sys.argv[1]
os.makedirs(out, exist_ok=True)

rgb = Image.new("RGB", (W, H))
rgba = Image.new("RGBA", (W, H))
for y in range(H):
    for x in range(W):
        rgb.putpixel((x, y), (x * 6, y * 10, 128))
        rgba.putpixel((x, y), (x * 6, y * 10, 128, (x * 7) % 256))

rgb.save(f"{out}/rgb.png")
rgb.save(f"{out}/baseline.jpg", quality=80)
rgb.save(f"{out}/progressive.jpg", quality=80, progressive=True)

with tempfile.TemporaryDirectory() as tmp:
    rgba.save(f"{tmp}/rgba.png")
    # 無透明の lossy は 'VP8 '、-lossless は 'VP8L'、alpha 付き lossy は 'VP8X' + ALPH + 'VP8 ' になる
    subprocess.run(["cwebp", "-quiet", "-q", "80", f"{out}/rgb.png", "-o", f"{out}/lossy.webp"], check=True)
    subprocess.run(["cwebp", "-quiet", "-lossless", f"{out}/rgb.png", "-o", f"{out}/lossless.webp"], check=True)
    subprocess.run(["cwebp", "-quiet", "-q", "80", "-exact", f"{tmp}/rgba.png", "-o", f"{out}/alpha.webp"], check=True)
subprocess.run(["sips", "-s", "format", "avif", f"{out}/rgb.png", "--out", f"{out}/rgb.avif"], check=True, stdout=subprocess.DEVNULL)
