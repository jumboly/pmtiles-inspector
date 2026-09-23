"""
leaf_z8.pmtiles の Internal Compression を gzip → none に書き換えた fixture を作る。

なぜ必要か:
Internal Compression が gzip だと、Directory の varint は「解凍後バッファ」上にしか存在せず、
ファイル上の byte（Hex Viewer）と 1 対 1 に対応しない。無圧縮版があれば
「entry の varint ↔ ファイル offset」を直接たどれ、Directory Encoding を生 bytes のまま観察できる。

なぜ TypeScript の自前 encoder を使わないのか:
自前 encoder で書いて自前 decoder で読むと、同じ誤解を両側に埋め込んでもテストが通ってしまう。
ここでは公式 Go writer が作った leaf directory の bytes を解凍するだけで再符号化せず、
leaf の位置が変わる root だけを spec (§4.3) どおりに組み直す。検証は公式 JS reader で行う。

使い方: python3 scripts/make-uncompressed-fixture.py fixtures/leaf_z8.pmtiles fixtures/leaf_z8_nocomp.pmtiles
"""
import gzip, struct, sys

src, out = sys.argv[1], sys.argv[2]
data = open(src, "rb").read()

# spec §3.1 の header layout（127 byte, little-endian）
HEADER = struct.Struct("<7sB11QBBBBBBiiiiBii")
assert HEADER.size == 127
h = list(HEADER.unpack_from(data, 0))
(magic, version, root_off, root_len, meta_off, meta_len, leaf_off, leaf_len,
 tile_off, tile_len, n_addr, n_entries, n_contents, clustered, internal_c, *_rest) = h
assert magic == b"PMTiles" and version == 3
assert internal_c == 2, "入力は gzip の internal compression を想定"


def read_varint(buf, pos):
    value, shift = 0, 0
    while True:
        b = buf[pos]
        pos += 1
        value |= (b & 0x7F) << shift
        if b < 0x80:
            return value, pos
        shift += 7


def write_varint(v):
    out = bytearray()
    while v >= 0x80:
        out.append((v & 0x7F) | 0x80)
        v >>= 7
    out.append(v)
    return bytes(out)


def decode_dir(buf):
    n, pos = read_varint(buf, 0)
    cols = []
    for _ in range(4):
        col = []
        for _ in range(n):
            v, pos = read_varint(buf, pos)
            col.append(v)
        cols.append(col)
    deltas, runs, lengths, offs = cols
    entries, tid = [], 0
    for i in range(n):
        tid += deltas[i]
        if offs[i] == 0 and i > 0:
            off = entries[-1][3] + entries[-1][2]
        else:
            off = offs[i] - 1
        entries.append([tid, runs[i], lengths[i], off])
    return entries


def encode_dir(entries):
    out = bytearray(write_varint(len(entries)))
    last = 0
    for e in entries:
        out += write_varint(e[0] - last)
        last = e[0]
    for e in entries:
        out += write_varint(e[1])
    for e in entries:
        out += write_varint(e[2])
    for i, e in enumerate(entries):
        prev = entries[i - 1] if i > 0 else None
        out += write_varint(0 if prev and e[3] == prev[3] + prev[2] else e[3] + 1)
    return bytes(out)


root = decode_dir(gzip.decompress(data[root_off:root_off + root_len]))
metadata = gzip.decompress(data[meta_off:meta_off + meta_len])

# leaf を解凍して詰め直す。元の bytes は Go writer の符号化そのまま（再符号化しない）
leaves = bytearray()
for e in root:
    if e[1] != 0:
        continue
    raw = data[leaf_off + e[3]:leaf_off + e[3] + e[2]]
    plain = gzip.decompress(raw)
    e[3], e[2] = len(leaves), len(plain)
    leaves += plain

root_bytes = encode_dir(root)
new_root_off = 127
new_meta_off = new_root_off + len(root_bytes)
new_leaf_off = new_meta_off + len(metadata)
new_tile_off = new_leaf_off + len(leaves)
assert new_meta_off <= 16384, "header + root は先頭 16 KiB に収まる必要がある (spec §2)"

h[2:10] = [new_root_off, len(root_bytes), new_meta_off, len(metadata),
           new_leaf_off, len(leaves), new_tile_off, tile_len]
h[14] = 1  # internal compression = none
tiles = data[tile_off:tile_off + tile_len]

with open(out, "wb") as f:
    f.write(HEADER.pack(*h) + root_bytes + metadata + leaves + tiles)
print(f"root {len(root_bytes)} B, metadata {len(metadata)} B, leaves {len(leaves)} B, tiles {len(tiles)} B")
