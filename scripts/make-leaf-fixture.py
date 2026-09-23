"""
Leaf Directory / RunLength / dedup を含む教材用 fixture を生成する。

なぜ自前 writer ではなく MBTiles → `pmtiles convert` (公式 Go 実装) を経由するのか:
自前 writer で作った fixture を自前 reader で読むと、同じ誤解を両側に埋め込んでも
テストが通ってしまう。公式 writer が決めた物理レイアウトを入力にすることで、
fixture 自体を Reference Oracle 側の産物にする。
"""
import gzip, os, sqlite3, sys

out = sys.argv[1]
if os.path.exists(out):
    os.remove(out)
db = sqlite3.connect(out)
db.execute("CREATE TABLE metadata (name text, value text)")
db.execute("CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)")
meta = {"name": "leaf-fixture", "format": "png", "minzoom": "0", "maxzoom": "8",
        "bounds": "-180,-85,180,85", "center": "0,0,0",
        "description": "synthetic fixture: leaf directories, run-length, dedup"}
db.executemany("INSERT INTO metadata VALUES (?,?)", meta.items())
rows = []
for z in range(0, 9):
    n = 1 << z
    for x in range(n):
        for y in range(n):
            # 海のように同一内容が連続する領域を作り、RunLength > 1 と dedup を発生させる。
            # z>=6 の西半球は共通の "ocean" バイト列にする。
            if z >= 6 and x < n // 2:
                data = b"ocean"
            else:
                data = f"tile {z}/{x}/{y}".encode()
            tms_y = n - 1 - y  # MBTiles は TMS (y 反転)
            rows.append((z, x, tms_y, data))
db.executemany("INSERT INTO tiles VALUES (?,?,?,?)", rows)
db.commit()
db.close()
print(len(rows), "tiles")
