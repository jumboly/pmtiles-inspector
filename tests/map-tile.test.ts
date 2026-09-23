import { PMTiles, Protocol } from "pmtiles";
import { describe, expect, it } from "vitest";
import { PmtilesArchive } from "../src/core/pmtiles/archive";
import { TracingByteSource } from "../src/core/source/tracing-byte-source";
import type { ByteSource } from "../src/core/source/types";
import { lngLatToTile, tileBounds, tileCenter } from "../src/maplibre/tile-geometry";
import { loadTileForMap } from "../src/maplibre/tile-load";
import { FIXTURES, officialSource, ourSource } from "./helpers";

/** 公式 Protocol（MapLibre 用）に 1 タイル要求する。URL の key は FileSource.getKey() = ファイル名 */
async function officialTile(protocol: Protocol, name: string, z: number, x: number, y: number): Promise<Uint8Array | null> {
  const r = await protocol.tilev4({ url: `pmtiles://${name}/${z}/${x}/${y}`, type: "arrayBuffer" } as never, new AbortController());
  return r.data === null ? null : new Uint8Array(r.data as ArrayBuffer);
}

describe("loadTileForMap（地図用のタイル取得）vs 公式 Protocol", () => {
  for (const name of [FIXTURES.zcta, FIXTURES.terrarium, FIXTURES.mlt, FIXTURES.leaf]) {
    it(`${name}: minZoom..maxZoom+1 の全タイルで公式 Protocol と同じ bytes（欠損の返し方も含む）を返す`, async () => {
      const archive = await PmtilesArchive.open(await ourSource(name));
      const protocol = new Protocol();
      protocol.add(new PMTiles(await officialSource(name)));
      const h = archive.header;
      // leaf_z8 は z8 に 65536 タイルあるので、z ごとに先頭の一部だけ見る（leaf を跨ぐよう x を粗く飛ばす）
      for (let z = h.minZoom; z <= Math.min(h.maxZoom + 1, 8); z++) {
        const n = 2 ** z;
        const stride = n > 16 ? Math.ceil(n / 16) : 1;
        for (let x = 0; x < n; x += stride) {
          for (let y = 0; y < n; y += stride) {
            // maxZoom+1 は MapLibre が要求しない（overzoom する）ズームだが、要求された場合の振る舞いも一致させておく
            expect((await loadTileForMap(archive, z, x, y)).bytes, `${z}/${x}/${y}`).toEqual(await officialTile(protocol, name, z, x, y));
          }
        }
      }
    }, 60_000);
  }

  it("地図の read は initiator = map として記録され、Tile Trace（viewer）の read と区別できる", async () => {
    const src = new TracingByteSource(await ourSource(FIXTURES.leaf));
    const archive = await PmtilesArchive.open(src);
    expect((await loadTileForMap(archive, 8, 200, 100)).found).toBe(true);
    expect(src.records.map((r) => [r.purpose, r.initiator])).toEqual([
      ["header+root", "viewer"],
      ["leaf-directory", "map"],
      ["tile-data", "map"],
    ]);
    // 地図が読んだ leaf を、後の Tile Trace は cache として使う（同じキャッシュを共有している）
    const lookup = await archive.lookupTile(8, 200, 101);
    expect(lookup.steps.at(-1)).toMatchObject({ kind: "directory", obtainedBy: "cache" });
    expect(src.records.length).toBe(3);
  });

  it("archive に無いタイルは directory を引くだけで分かり、tile の read は起きない", async () => {
    const src = new TracingByteSource(await ourSource(FIXTURES.zcta));
    const archive = await PmtilesArchive.open(src);
    // zcta は米国だけなので、z3 の南半球のタイルは無い
    const r = await loadTileForMap(archive, 3, 4, 6);
    expect(r).toEqual({ bytes: new Uint8Array(), found: false });
    expect(src.records.map((x) => x.purpose)).toEqual(["header+root"]);
  });

  it("同じ leaf のタイルを同時に何枚要求しても、leaf の read は 1 回だけ（公式 SharedPromiseCache と同じ）", async () => {
    const src = new TracingByteSource(await ourSource(FIXTURES.leaf));
    const archive = await PmtilesArchive.open(src);
    await Promise.all(Array.from({ length: 8 }, (_, i) => loadTileForMap(archive, 8, 200 + (i % 2), 100 + Math.floor(i / 2))));
    expect(src.records.filter((r) => r.purpose === "leaf-directory").length).toBe(1);
    expect(src.records.filter((r) => r.purpose === "tile-data").length).toBe(8);
  });

  it("tile の read の最中に中断されると、その read は errorKind = aborted として残る", async () => {
    const inner = await ourSource(FIXTURES.zcta);
    const ac = new AbortController();
    // MapLibre がパンで不要になった要求を中断するのと同じ状況を、tile の read が始まった瞬間の中断で作る
    const aborting: ByteSource = {
      key: inner.key,
      size: () => inner.size(),
      read(offset, length, ctx) {
        if (ctx?.purpose === "tile-data") ac.abort();
        return inner.read(offset, length, ctx);
      },
    };
    const src = new TracingByteSource(aborting);
    const archive = await PmtilesArchive.open(src);
    await expect(loadTileForMap(archive, 0, 0, 0, ac.signal)).rejects.toThrow();
    expect(src.records.at(-1)).toMatchObject({ purpose: "tile-data", initiator: "map", errorKind: "aborted" });
  });
});

describe("tile-geometry", () => {
  it("z0 のタイルは Web Mercator の全域（±180°, ±85.0511°）", () => {
    const [w, s, e, n] = tileBounds(0, 0, 0);
    expect([w, e]).toEqual([-180, 180]);
    expect(n).toBeCloseTo(85.0511287798, 8);
    expect(s).toBeCloseTo(-85.0511287798, 8);
  });

  it("タイルの中心の経緯度からは同じタイルが引ける（z0〜z14 の数点）", () => {
    for (const [z, x, y] of [
      [0, 0, 0],
      [3, 2, 5],
      [8, 200, 100],
      [14, 14552, 6451],
    ] as const) {
      const [lng, lat] = tileCenter({ z, x, y });
      expect(lngLatToTile(lng, lat, z)).toEqual({ z, x, y });
      // 世界の複製（経度 +360°）上でクリックしても同じタイル
      expect(lngLatToTile(lng + 360, lat, z)).toEqual({ z, x, y });
    }
  });
});
