import { tileIdToZxy as officialTileIdToZxy, zxyToTileId as officialZxyToTileId } from "pmtiles";
import { describe, expect, it } from "vitest";
import { alignedBlock, hilbertRangeBlocks, hilbertXyToIndex, tileIdRangeBlocks, tileIdToZxy, zxyToTileId, zoomBase } from "../src/core/pmtiles/tileid";

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

  it("整列ブロック内の TileID は連続区間になる（Hilbert の局所性）", () => {
    for (let z = 1; z <= 7; z++) {
      for (let k = 0; k <= z; k++) {
        const n = 2 ** z;
        const size = 2 ** k;
        for (let bx = 0; bx < n; bx += size) {
          for (let by = 0; by < n; by += size) {
            const blk = alignedBlock(z, bx, by, k);
            const ids: number[] = [];
            for (let x = bx; x < bx + size; x++) for (let y = by; y < by + size; y++) ids.push(zxyToTileId(z, x, y).tileId);
            ids.sort((a, b) => a - b);
            expect(ids[0]).toBe(blk.firstTileId);
            expect(ids.at(-1)).toBe(blk.lastTileId);
            expect(ids.at(-1)! - ids[0]!).toBe(ids.length - 1);
          }
        }
      }
    }
  });
});

describe("hilbertRangeBlocks / tileIdRangeBlocks", () => {
  /** ブロックが覆うタイルの Hilbert index をすべて列挙する（分解が区間とぴったり一致するかを総当たりで確かめる） */
  const covered = (blocks: ReturnType<typeof hilbertRangeBlocks>) =>
    blocks.flatMap((b) => Array.from({ length: b.size * b.size }, (_, n) => hilbertXyToIndex(b.z, b.x0 + (n % b.size), b.y0 + Math.floor(n / b.size))));

  it("任意の区間を、重なりも漏れもなく整列ブロックで覆う（z=0..5 の全区間の一部を総当たり）", () => {
    for (let z = 0; z <= 5; z++) {
      const total = 4 ** z;
      const step = Math.max(1, Math.floor(total / 37));
      for (let a = 0; a < total; a += step) {
        for (let b = a + 1; b <= total; b += step) {
          const idx = covered(hilbertRangeBlocks(z, a, b)).sort((p, q) => p - q);
          expect(idx).toEqual(Array.from({ length: b - a }, (_, n) => a + n));
        }
      }
    }
  });

  it("整列した区間はブロック 1 つになり、ブロック数はズームに対して小さく抑えられる", () => {
    expect(hilbertRangeBlocks(4, 0, 256)).toEqual([{ z: 4, x0: 0, y0: 0, size: 16 }]);
    const block = alignedBlock(10, 300, 700, 3);
    const h0 = block.firstTileId - zoomBase(10);
    expect(hilbertRangeBlocks(10, h0, h0 + 64)).toEqual([{ z: 10, x0: block.x0, y0: block.y0, size: 8 }]);
    expect(hilbertRangeBlocks(14, 12345, 9876543).length).toBeLessThanOrEqual(6 * 14);
  });

  it("TileID の区間はズームで切り出してから分解する（別ズームにはみ出た部分は含めない）", () => {
    // z1 の後半 2 タイル + z2 全体 + z3 の先頭 1 タイル
    const start = zoomBase(1) + 2;
    const end = zoomBase(3) + 1;
    expect(covered(tileIdRangeBlocks(1, start, end)).sort()).toEqual([2, 3]);
    expect(tileIdRangeBlocks(2, start, end)).toEqual([{ z: 2, x0: 0, y0: 0, size: 4 }]);
    expect(covered(tileIdRangeBlocks(3, start, end))).toEqual([0]);
    expect(tileIdRangeBlocks(4, start, end)).toEqual([]);
  });
});
