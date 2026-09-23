import { tileIdToZxy as officialTileIdToZxy, zxyToTileId as officialZxyToTileId } from "pmtiles";
import { describe, expect, it } from "vitest";
import { tileIdToZxy, zxyToTileId, zoomBase } from "../src/core/pmtiles/tileid";

describe("TileID", () => {
  it("spec §4.1 の表と一致する", () => {
    const table: [number, number, number, number][] = [
      [0, 0, 0, 0],
      [1, 0, 0, 1],
      [1, 0, 1, 2],
      [1, 1, 1, 3],
      [1, 1, 0, 4],
      [2, 0, 0, 5],
      [12, 3423, 1763, 19078479],
    ];
    for (const [z, x, y, id] of table) {
      expect(zxyToTileId(z, x, y).tileId).toBe(id);
      expect(tileIdToZxy(id)).toMatchObject({ z, x, y });
    }
  });

  it("z0..9 の全タイルで公式 zxyToTileId / tileIdToZxy と一致する", { timeout: 60_000 }, () => {
    for (let z = 0; z <= 9; z++) {
      const n = 1 << z;
      for (let x = 0; x < n; x++) {
        for (let y = 0; y < n; y++) {
          const a = zxyToTileId(z, x, y);
          expect(a.tileId).toBe(officialZxyToTileId(z, x, y));
          expect(a.tileId).toBe(a.zoomBase + a.hilbertIndex);
          const back = tileIdToZxy(a.tileId);
          expect([back.z, back.x, back.y]).toEqual(officialTileIdToZxy(a.tileId));
        }
      }
    }
  });

  it("z10..26 のランダムなタイルで公式と一致する", () => {
    for (let i = 0; i < 20000; i++) {
      const z = 10 + Math.floor(Math.random() * 17);
      const n = 2 ** z;
      const x = Math.floor(Math.random() * n);
      const y = Math.floor(Math.random() * n);
      const id = zxyToTileId(z, x, y).tileId;
      expect(id).toBe(officialZxyToTileId(z, x, y));
      expect(tileIdToZxy(id)).toMatchObject({ z, x, y });
    }
  });

  it("各ズームの境界: zoomBase(z) がそのズーム最初の TileID", () => {
    for (let z = 0; z <= 26; z++) {
      expect(tileIdToZxy(zoomBase(z))).toMatchObject({ z, hilbertIndex: 0 });
      if (z > 0) expect(tileIdToZxy(zoomBase(z) - 1).z).toBe(z - 1);
    }
  });

  it("範囲外の入力は例外", () => {
    expect(() => zxyToTileId(27, 0, 0)).toThrow();
    expect(() => zxyToTileId(2, 4, 0)).toThrow();
    expect(() => zxyToTileId(2, -1, 0)).toThrow();
  });
});
