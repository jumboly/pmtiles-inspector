# PMTiles Internals Viewer

PMTiles v3 の内部構造を「使う」ためではなく「理解する」ための Viewer です。
Header・File Layout・Root / Leaf Directory・Directory Encoding（列指向 / 差分 / varint）を、
生 bytes と論理値を対応付けながら確認できます。
Tile Trace では z/x/y → Hilbert position → TileID → Root / Leaf の binary search → Tile Entry → Range Read → Tile Decompression → Tile Payload を 1 段ずつ追えます。
読んだ範囲は File Layout 上に、1 タイルのために読んだ量の内訳は Tile Trace に表示されます。

Map（MapLibre GL JS）には archive の中身とタイル境界・z/x/y を重ね、クリックしたタイルから Tile Trace を始められます。
地図描画のタイル取得も公式ライブラリではなく自前の archive 実装を通すので、パン・ズームで起きた read は Read Trace と File Layout に「地図描画」として現れます。
Trace の段に合わせて、候補の leaf が担当する TileID 区間を地図上の面として表示し、地図と Hilbert Viewer の間でカーソル位置も連動します。
背景地図には [MapLibre demotiles](https://demotiles.maplibre.org/) を使っています。

Tile Payload の先は Content Inspector（PMTiles とは独立に bytes だけを受け取る）に渡します。
MVT は自前の protobuf reader で layer / feature / properties / geometry（command integer → MoveTo / LineTo / ClosePath → tile 座標、ring の外周 / 穴）まで decode し、
各値が Payload のどの byte から来たかを保持します。地図をクリックすると、その地点の feature を選んで地図・tile プレビュー・Payload の dump で強調します。
Raster（PNG / JPEG / WebP / AVIF）は header から寸法を読み、ブラウザが decode した画像と突き合わせます。どちらにも当てはまらない tile は Raw Inspector に fallback します。

ローカルファイル（`Blob.slice`）のほか、URL の archive を HTTP Range Request で開けます。
Read Trace では各 read の request（Range ヘッダ）と response（status・ヘッダ・CORS で読めなかったヘッダ）を確認でき、
CORS / Range 非対応 / mixed content などで開けなかった場合は原因と確認方法を表示します。
`?url=<archive の URL>` を付けたリンクで、開く archive を指定できます
（例: [Terrarium 全球 28.4 GiB](https://www.jumboly.jp/pmtiles-inspector/?url=https%3A%2F%2Fr2-public.protomaps.com%2Fprotomaps-sample-datasets%2Fterrarium_z9.pmtiles)）。

公開版: https://www.jumboly.jp/pmtiles-inspector/

## 開発

```sh
npm ci
npm run dev    # http://localhost:5173
npm test       # 公式 pmtiles JS 実装・@mapbox/vector-tile を Reference Oracle とした比較テスト
npm run build
```

main に push すると GitHub Actions がテスト・ビルドを行い、GitHub Pages にデプロイします。

仕様確認の記録と公式実装との差は [docs/spec-notes.md](docs/spec-notes.md) にあります。

## サンプルデータの出典

`fixtures/` のファイルはテストと画面のサンプルを兼ねています。

| ファイル | 出典 |
|---|---|
| `terrarium_z2.pmtiles` | Protomaps のサンプル `terrarium_z9.pmtiles`（Mapzen / Tilezen Terrain Tiles）の z0-2 を切り出したもの。下記の帰属表示が必要 |
| `zcta_z3.pmtiles` | U.S. Census Bureau, 2018 Cartographic Boundary Files（`cb_2018_us_zcta510_500k`）を元にした Protomaps のサンプルの z0-3 を切り出したもの |
| `test_fixture_*.pmtiles`, `invalid*.pmtiles` | [protomaps/PMTiles](https://github.com/protomaps/PMTiles) の `js/test/data` より。`test_fixture_mlt` の metadata には © OpenStreetMap contributors / © Overture Maps Foundation の帰属表示が含まれる |
| `leaf_z8.pmtiles`, `leaf_z8_nocomp.pmtiles` | `scripts/` で生成した合成データ |

`tests/data/images/` は Raster Inspector のテスト用に `scripts/make-image-samples.py` で生成した 37 × 23 の画像です。

リモートのサンプル（`r2-public.protomaps.com` の `terrarium_z9.pmtiles` / `overture-pois.pmtiles`、`pmtiles.io` の Firenze）は同梱せず、
画面から HTTP Range Request で読みます。Terrarium は上記と同じ Terrain Tiles、Overture POI は Overture Maps Foundation の Places データ、
Firenze は © OpenStreetMap contributors（ODbL）の Protomaps basemap です。

### Terrain Tiles の帰属表示

[tilezen/joerd docs/attribution.md](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) の "Required attribution":

```
* ArcticDEM terrain data DEM(s) were created from DigitalGlobe, Inc., imagery and
  funded under National Science Foundation awards 1043681, 1559691, and 1542736;
* Australia terrain data © Commonwealth of Australia (Geoscience Australia) 2017;
* Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM)
  Österreich;
* Canada terrain data contains information licensed under the Open Government
  Licence – Canada;
* Europe terrain data produced using Copernicus data and information funded by the
  European Union - EU-DEM layers;
* Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration
* Mexico terrain data source: INEGI, Continental relief, 2016;
* New Zealand terrain data Copyright 2011 Crown copyright (c) Land Information New
  Zealand and the New Zealand Government (All rights reserved);
* Norway terrain data © Kartverket;
* United Kingdom terrain data © Environment Agency copyright and/or database right
  2015. All rights reserved;
* United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data
  courtesy of the U.S. Geological Survey.
```
