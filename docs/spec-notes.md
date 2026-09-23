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
  → 全長を知るには `Content-Length` を読める HEAD が別に必要（Phase 5 で対応。下記参照）。
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

## Phase 3 で分かったこと

- **Tile Addressing と Physical Read を分けた**: `lookupTile(z, x, y)` は Tile Entry とファイル上の範囲
  （`tileDataOffset + entry.offset`, `entry.length`）を返すまでで、tile data は読まない。
  探索に必要な leaf だけは読む。`traceTile` は `lookupTile` + tile の read で、公式 `getZxy` との比較テストはこちらで継続
- **整列ブロックと TileID の連続性**: ズーム z の 2^k × 2^k の整列ブロック内のタイルは、必ず連続した TileID 区間になる。
  先頭は `zoomBase(z) + xy2d(z-k, x>>k, y>>k) × 4^k`。z1〜7 の全ブロックでテスト済み。
  Hilbert Viewer は z > 8 でこの性質を使い、選択タイルを含む 256×256 のブロックだけを描く
- **leaf entry の担当範囲**: 公式 `findTile` は leaf entry に対して範囲チェックをしない。
  leaf entry の担当は「次の entry の TileID の手前まで」で、最後の entry は親から受け継いだ上限まで。
  `entryTileIdRange` はこの規則で区間を返し、公式 `findTile` の hit 判定と一致することをテストした
- `leaf_z8` の root は leaf entry 11 個（4096 entries ずつ）。Hilbert grid（z8）で塗り分けると、
  各 leaf は地図上でひとかたまりの領域になる。leaf #0 は z0〜7 の全タイルと z8 の先頭部分を持つ
- binary search の比較回数は `⌈log2(n+1)⌉` 回以下（root 11 entries → 最大 4 回、leaf 4096 entries → 最大 13 回）
- 実装上の注意: TracingByteSource の read 通知は、archive が leaf をキャッシュに入れる**前**に届く。
  「leaf が読み込まれた」を知りたい Viewer は read の件数ではなく `archive.loadedLeafCount` を見る


## Phase 4 で分かったこと

- **公式実装は tile data をキャッシュしない**: `getZxyAttempt` は header と directory だけを `SharedPromiseCache` に入れ、
  tile は毎回 `source.getBytes(tileDataOffset + offset, length)` で読む（HTTP キャッシュはブラウザ任せ）。
  本実装の `readTileData` も同じで、同じタイルを 2 回 Trace すれば Read Trace に tile の read が 2 回現れる
- Tile Trace は **Tile Entry の段で止め、Range Read の段に進んだときに初めて I/O する**。
  lookup の結論（found / not-found）だけで段の数は決まるので、未読の段も「これから起こること」として先に見せている
- 解凍は Header の Tile Compression の宣言だけに従う。中身の magic bytes（`tile-inspector/raw/sniff.ts`）は
  「宣言と中身が合っているか」を見せるためだけに使い、解凍方式の選択には使わない
  - brotli の stream には magic が無いので、bytes からは確認できない
  - MVT は先頭 byte が `0x1A`（field 3 = layers, wire type 2）であることしか見ないので「mvt-like」と呼ぶ。MLT は判定しない
- `leaf_z8` は Tile Type = png を名乗るが中身はテキストで、宣言と中身の食い違いの例になる
- 1 タイルに必要な量（cold）の例: `leaf_z8` の z8 タイルは 16,384（先頭 16 KiB）+ 95（leaf）+ 14（tile）= 16,493 byte。
  小さい archive では先頭 16 KiB が大半を占める。`zcta_z3` の z3 タイルは 1 つで 494 KB（archive の 18%）あり、
  「ごく一部しか読まない」が目に見えるのは大きな archive を扱う Phase 5 から

## Phase 5 で分かったこと

- **公式 FetchSource（pmtiles@4.5.0）の要点**: 送るヘッダは `Range` だけ（`If-Match` は preflight が要るので送らない）。
  先頭 read の 416 は `Content-Range: bytes */size` を見て全長で取り直す。200 で `Content-Length` が要求より大きければ
  Byte Serving 非対応として中断。ETag が変わったら `cache: "reload"` で読み直す。
  本実装は ETag の変化で**止める**（読み直すと既に読んだ directory と新しいファイルが混ざった Trace になるため）
- **単一範囲の `Range` は CORS safelisted request header**（`bytes=N-M` の形に限る）なので preflight が起きない。
  pmtiles.io（GitHub Pages）は OPTIONS に 405 を返すが、ブラウザからは読める
- **CORS で見えるヘッダ**: 別オリジンでは safelisted（`Content-Length` / `Content-Type` / `Cache-Control` など）と
  `Access-Control-Expose-Headers` のものしか JS から読めない。実測（2026-09-23）:

  | ホスト | Expose-Headers | 別オリジンから Content-Range |
  |---|---|---|
  | `r2-public.protomaps.com` | `ETag` | 読めない |
  | GitHub Pages（pmtiles.io・本サイト） | なし | 読めない（同一オリジンの本サイトからは読める） |

  206 には Content-Range が必ず付く（RFC 9110）ので、206 なのに null なら「CORS で隠されている」と言い切れる
- **Archive Size の補い方**: Content-Range が読めないときだけ HEAD を送り、Content-Length（safelisted）を使う。
  Read Trace には `size-probe`（0 byte）として別枠で残し、「PMTiles として読んだ量」には数えない
- **HEAD の Content-Length は圧縮後の長さのことがある**: ブラウザは Fetch 仕様に従い、`Range` 付きの request にだけ
  `Accept-Encoding: identity` を付ける。HEAD には付かないので、GitHub Pages は gzip 後の長さ
  （`leaf_z8`: 実物 588,612 B → HEAD 74,037 B）を返す。別オリジンでは Content-Encoding も読めないので、
  **Header の section の終端より短い HEAD 長は捨てる**（`minimumArchiveSize`）。
  長い場合も別オリジンでは「無圧縮であることは未確認」と表示する
- 同じ理由で、GitHub Pages に `Accept-Encoding: gzip` 付きで Range を送ると、gzip 後のストリームに対する Range が返る
  （`Content-Range: bytes */74037`）。ブラウザは identity を付けるので実害は無いが、curl で試すときは注意
- **fetch の失敗理由**: ブラウザは CORS 拒否もネットワーク断も `TypeError: Failed to fetch` にする。
  失敗後に `mode: "no-cors"` の HEAD を 1 回送り、opaque 応答が返れば「サーバには届くが CORS で拒否」、
  それも失敗すれば「接続できない」と切り分ける。https のページから http の URL（localhost を除く）は mixed content として先に判定する
- 大きな archive での実測（cold, 1 タイル）:
  - `terrarium_z9`（28.4 GiB）の z0: 16,384（先頭）+ 10,082（leaf）+ 106,274（tile）byte。metadata 681 byte を含めて約 133 KB = 0.00044 %
  - `overture-pois`（4.34 GiB）の z14 中心タイル: 16,384 + 7,948（leaf）+ 387,205（tile）byte
  - Local と HTTP で read の並び（offset / length / 目的）は完全に同じ（テストで確認）。違うのは HTTP の観測情報だけ

## Phase 6 で分かったこと

- **MapLibre GL JS 6.11.1（2026-09 時点の latest）**: custom protocol は `addProtocol(name, (params, abortController) => Promise<{ data }>)`。
  main thread で登録すれば worker からのタイル要求も main thread に回ってくるので、自前の `PmtilesArchive`（と TracingByteSource）をそのまま使える。
  vector source は `encoding: "mlt"` で MLT を描ける（`TileEncoding = "mlt" | "mvt"`）
- **公式 Protocol（pmtiles@4.5.0 の `tilev4`）の欠損タイルの返し方**: vector（MVT / MLT）は空の `Uint8Array`、raster は `data: null`。
  MapLibre の raster source は `data` が null のタイルを「中身の無い透明なタイル」として描く（型定義には無いが実装がそう扱う）。
  自前の `loadTileForMap` は公式 Protocol と bytes 単位で一致することをテストで確認（zcta / terrarium / MLT / leaf_z8）
- **公式 SharedPromiseCache は読んでいる最中の directory の Promise を共有する**（同じ leaf を同時に何度も読まない）。
  地図は同じ leaf の範囲のタイルを一度に何十枚も要求するので、自前実装にも読み途中の leaf の共有を入れた。
  公式は参照数を数えて全員が中断したときだけ leaf の read を止めるが、本実装は leaf の read を中断しない（中断するのは tile data の read だけ）
- **タイルの z の決まり方**: MapLibre は `z = floor(地図ズーム + log2(512 / tileSize))`（raster は round）。
  PMTiles の Header にはタイルのピクセルサイズが無いので、vector・raster とも `tileSize: 512` にして「地図ズーム ≒ タイルの z」にしている。
  maxZoom を超えると maxZoom のタイルを引き伸ばす（overzoom）。画面を覆うタイルは `map.coveringTiles()` で MapLibre 自身と同じ並びを得られる。
  傾き（pitch）があると画面の奥ほど低いズームのタイルが混ざるので、回転・傾きは無効にしている
- **MapLibre 6 の worker**: 既定では自分の `import.meta.url` から `maplibre-gl-worker.mjs` を探すが、Vite の依存事前バンドルで位置がずれて読めない。
  `maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url` で Vite にバンドルさせ、`setWorkerUrl()` で渡す
- **attribution は HTML として描かれる**: metadata の `attribution` はファイル由来の文字列なので、タグを落として escape してから渡す
- **leaf の担当区間を地図上の面にする**: TileID の連続区間は、ズームごとに高々 6z 個程度の整列ブロック（2^k × 2^k の正方形）に分解できる（`hilbertRangeBlocks`）。
  Hilbert 曲線が「大きい象限から順に辿る」ことの裏返しで、leaf が地図上でひとかたまりの領域になる理由そのもの
- 実測: MLT fixture は root に entry が無いので、地図の z0 要求（2 回）は Root を引くだけで「無い」と分かり、tile の read は 0 回
