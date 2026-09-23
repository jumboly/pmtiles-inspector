# Phase 0: 仕様確認メモ (2026-09-23)

## 確認したソース

| 対象 | 版 / 取得元 |
|---|---|
| PMTiles v3 spec | `protomaps/PMTiles` main `spec/v3/spec.md`（CHANGELOG 上 v3.6） |
| 公式 JS 実装 | `js/src/index.ts`（npm `pmtiles@4.5.0`） |
| 公式 Go CLI | `pmtiles`（fixture 生成・verify に使用） |
| MVT | `mapbox/vector-tile-spec` 2.1（これが現行。3.x は未リリース） |
| DecompressionStream | MDN: format は gzip / deflate / deflate-raw / brotli / zstd。対応はブラウザごとに違う |

## spec の要点（実装が依存しているもの）

- Header は 127 byte の固定長。u64 はすべて little-endian。Position は `int32 LE / 1e7` で (lon, lat) の順
- **header と圧縮後の root を合わせて 16384 byte 以下**でなければならない。root の最大は 16257 byte。
  root は header の直後である必要はなく、先頭 16 KiB のどこかにあればよい
- header 以外の section は並び順が決まっていない → File Layout は offset から求める
- Directory は列指向: `count, ΔTileID[], RunLength[], Length[], Offset[]`（すべて varint）
- Offset の符号化: 直前 entry の `offset+length` と一致する場合は `0`。それ以外は **`offset + 1`**。
  先頭 entry は常に `offset + 1`
- `RunLength = 0` は leaf directory を指す entry。leaf entry の offset は leaf directories section 起点、
  tile entry の offset は tile data section 起点
- Addressed Tiles / Tile Entries / Tile Contents は、いずれも `0 = 不明` を取り得る
- Clustered = tile data が TileID 順に並び、offset は「連続」か「dedup による前方参照」のどちらかで、先頭 tile の offset は 0
- Tile Type: `0 unknown, 1 mvt, 2 png, 3 jpeg, 4 webp, 5 avif, 6 mlt`（MLT は v3.5 で追加）
- Compression: `0 unknown, 1 none, 2 gzip, 3 brotli, 4 zstd`
- Terrain は Tile Type ではない。metadata の `"encoding": "terrarium"`（v3.6 で追加）で表す。
  標高 = `(R*256 + G + B/256) - 32768`

## 公式 JS 実装と spec の差 / 公式実装の挙動

| 項目 | 公式 JS | 本実装の扱い |
|---|---|---|
| magic 検査 | 先頭 2 byte ("PM") だけ見る | 7 byte すべて見る |
| version 検査 | `> 3` のみ拒否 | `!== 3` を拒否（v1/v2 はレイアウトが違うため） |
| root が 16 KiB 内にあるか | 検査しない（`TODO check root bounds`） | 収まっていなければ別 read で読み、`rootOutsideFirstRead` として記録 |
| 空 directory | root は許容、leaf は例外 | 同じ挙動。root の空は `issues` に記録 |
| directory の深さ | root を含め 4 階層まで | 同じ |
| 解凍 | none/unknown はそのまま通し、gzip のみ解凍。brotli/zstd は例外 | DecompressionStream で gzip/brotli/zstd を試し、使えなければ `UnsupportedCompressionError` |
| varint | 2^53 超は黙って丸める | 例外 |
| Header の clustered | boolean に変換 | 生の byte を保持 |
| field 名 | `jsonMetadataOffset`, `leafDirectoryOffset` | spec の用語どおり `metadataOffset`, `leafDirectoriesOffset` |

**公式 fixture の spec 違反:** `test_fixture_mlt.pmtiles` は root の entry 数が 0（spec §4.2 は MUST > 0）。
Tile Type enum を試すための空アーカイブで、公式 reader は root に限って許容している。

## Web API / 配信環境で分かったこと

- 公式 FetchSource は常に `bytes=0-16383` を要求し、16 KiB 未満のアーカイブで 416 が返ったら全長で取り直す
- サンプルサーバ (r2-public.protomaps.com) の CORS 設定は **`Access-Control-Expose-Headers: ETag` だけ**。
  ブラウザからは `Content-Range` を読めないので、アーカイブ全長が分からない。
  → 全長を知るには `Content-Length` を読める HEAD（または 0 byte の Range）が別に必要。
  取れなければ UI では「不明」と表示する
- Node 25 の DecompressionStream は brotli に対応、zstd には非対応

## fixture

| ファイル | 内容 |
|---|---|
| `test_fixture_1/2`, `test_fixture_mlt`, `invalid*` | 公式リポジトリ `js/test/data` から取得 |
| `zcta_z3.pmtiles` | 公式サンプル `cb_2018_us_zcta510_500k.pmtiles` の z0-3 を切り出したもの（MVT, gzip） |
| `terrarium_z2.pmtiles` | 公式サンプル `terrarium_z9.pmtiles` (30.5 GB) の z0-2 を切り出したもの（PNG, terrarium） |
| `leaf_z8.pmtiles` | `scripts/make-leaf-fixture.py` → `pmtiles convert` で生成。leaf 有り。Addressed 87381 / Entries 44376 / Contents 44374 |
| `leaf_z8_nocomp.pmtiles` | `leaf_z8` の Internal Compression を none にしたもの（Phase 2 で追加）。directory の varint がファイル上にそのまま現れる |

`leaf_z8` の tile の中身は PNG ではなくテキスト（`tile z/x/y` や `ocean`）。header は png を名乗っている。
Raster Inspector が失敗して Raw Inspector に fallback する例としても使える。

## Phase 1 で分かったこと

- 公式サンプル `terrarium_z9.pmtiles` の metadata には **`encoding` キーが無い**（`name: "terrarium"` のみ）。
  （spec v3.6 で encoding が追加される前に作られたためと思われる）。Viewer は名前から推測せず、`encoding` が無ければ Terrain とは扱わない。
  → Terrain mode では「手動で terrarium として解釈する」切り替えが要る可能性がある（Phase 8 で検討）
- `zcta_z3.pmtiles`（go-pmtiles の extract 出力）は Leaf Directories の長さが 0 で、offset は Tile Data と同じ位置を指す。
  長さ 0 の section は「位置は持つが中身は無い」ものとして File Layout に出す

## Phase 2 で分かったこと

- **符号化規則の理解を byte 単位で確認**: 全 fixture の全 directory（root + leaf）で、
  自前 `encodeDirectory(decode(bytes))` が公式 Go writer の解凍後 bytes と完全一致する
- Offset が explicit（`offset + 1`）になる理由は 3 通りに分けられる
  - 先頭 entry
  - **後方参照**: dedup で既出の content を指す
  - **再開**: 後方参照の直後の entry。直前 entry（= 古い content）の直後ではなく、書き込み済み末尾から続くので 0 にできない
  - clustered なら「前方ジャンプ」は起きない。`leaf_z8` では 後方参照 = 再開 = Tile Entries − Tile Contents = 2
- 公式 Go writer の leaf は `leaf_z8` では 4096 entries ずつ（最後だけ 3416）
- 圧縮の効き方（`leaf_z8` の leaf 1 つ, 4096 entries）:
  固定長の行形式と仮定すると 98,304 B → 列指向 + 差分 + varint で 16,390 B（4 B/entry）→ gzip で 69 B。
  合成データで値がほぼ一定なので極端に縮む。実データではここまで縮まない
- 小さい directory では gzip がほとんど効かない（`zcta_z3` の root: 100 B → 92 B、`terrarium_z2`: 127 B → 97 B）。
  gzip の header / trailer だけで 18 B かかるため
- `leaf_z8_nocomp.pmtiles`（`scripts/make-uncompressed-fixture.py`）: `leaf_z8` の Internal Compression を none にしたもの。
  leaf は解凍しただけで再符号化していない。leaf が大きくなって offset が伸びるため、root は 58 B → 77 B に増える。
  Go CLI の `pmtiles verify` と、公式 JS reader による全タイル比較テストで正しさを確認
