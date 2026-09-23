import { findTile, PMTiles, SharedPromiseCache } from "pmtiles";
import { describe, expect, it } from "vitest";
import { PmtilesArchive } from "../src/core/pmtiles/archive";
import type { Entry } from "../src/core/pmtiles/directory";
import { entryTileIdRange, findTileTraced, floorEntryIndex } from "../src/core/pmtiles/lookup";
import { tileIdToZxy } from "../src/core/pmtiles/tileid";
import { TracingByteSource } from "../src/core/source/tracing-byte-source";
import { allDirectories, FIXTURES, officialSource, ourSource } from "./helpers";

const ARCHIVES = [FIXTURES.fixture1, FIXTURES.fixture2, FIXTURES.mlt, FIXTURES.zcta, FIXTURES.terrarium, FIXTURES.leaf, FIXTURES.leafNoComp];

describe("Directory decode vs 公式 getDirectory", () => {
  for (const name of ARCHIVES) {
    it(name, async () => {
      const archive = await PmtilesArchive.open(await ourSource(name));
      const src = await officialSource(name);
      const cache = new SharedPromiseCache();
      const officialHeader = await cache.getHeader(src);
      for (const d of await allDirectories(archive)) {
        const official = await cache.getDirectory(src, d.fileOffset, d.compressedLength, officialHeader);
        expect(d.decoded.entries).toEqual(official);
        // encoding の各列の span が解凍後バッファをちょうど覆っていること（末尾のゴミや読み残しが無い）
        const c = d.decoded.encoding.columns;
        expect(c.offsets.offset + c.offsets.length).toBe(d.decompressed.length);
      }
    });
  }
});

describe("findTileTraced vs 公式 findTile", () => {
  it("leaf fixture の全ディレクトリで、存在する/しない TileID を含む全範囲を比較", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    for (const d of await allDirectories(archive)) {
      const entries = d.decoded.entries;
      const first = entries[0]!.tileId;
      const last = entries.at(-1)!;
      for (let t = Math.max(0, first - 3); t <= last.tileId + Math.max(last.runLength, 1) + 3; t++) {
        const ours = findTileTraced(entries, t);
        expect(ours.entry ?? null).toEqual(findTile(entries as Entry[], t));
      }
    }
  });

  it("floorEntryIndex は findTileTraced の候補と一致し、entryTileIdRange は findTile の hit 範囲と一致する", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    for (const d of await allDirectories(archive)) {
      const entries = d.decoded.entries;
      const last = entries.at(-1)!;
      for (let t = Math.max(0, entries[0]!.tileId - 2); t <= last.tileId + Math.max(last.runLength, 1) + 2; t++) {
        const i = floorEntryIndex(entries, t);
        expect(i).toBe(findTileTraced(entries, t).candidateIndex ?? -1);
        if (i >= 0 && entries[i]!.runLength > 0) {
          const r = entryTileIdRange(entries, i);
          expect(t >= r.start && t < r.end).toBe(findTile(entries as Entry[], t) !== null);
        }
      }
    }
  });

  it("探索過程が binary search として正しい（毎回範囲が縮む）", () => {
    const entries: Entry[] = [100000, 110000, 120000, 123000, 123450, 124000, 130000].map((tileId, i) => ({
      tileId,
      offset: i * 10,
      length: 10,
      runLength: 1,
    }));
    const tr = findTileTraced(entries, 123456);
    expect(tr.steps.map((s) => s.mid)).toEqual([3, 5, 4]);
    expect(tr.outcome).toBe("outside-run");
    expect(tr.candidateIndex).toBe(4);
  });
});

describe("traceTile vs 公式 getZxy", () => {
  for (const name of [FIXTURES.fixture1, FIXTURES.mlt, FIXTURES.zcta, FIXTURES.terrarium, FIXTURES.leaf, FIXTURES.leafNoComp]) {
    it(`${name}: minZoom..maxZoom の全タイル + 範囲外 TileID`, async () => {
      const archive = await PmtilesArchive.open(await ourSource(name));
      const official = new PMTiles(await officialSource(name));
      const h = archive.header;
      const maxId = (4 ** (h.maxZoom + 1) - 1) / 3;
      for (let id = 0; id < maxId; id++) {
        const { z, x, y } = tileIdToZxy(id);
        const [ours, theirs] = await Promise.all([archive.traceTile(z, x, y), official.getZxy(z, x, y)]);
        if (!theirs) {
          expect(ours.result.status === "not-found" || ours.result.status === "out-of-zoom").toBe(true);
        } else {
          expect(ours.result.status).toBe("found");
          if (ours.result.status === "found") {
            expect(ours.result.payload).toEqual(new Uint8Array(theirs.data));
          }
        }
      }
    }, 120_000);
  }
});

describe("lookupTile", () => {
  it("leaf fixture: Tile Entry まで辿り、tile data は読まない。entry は公式 getZxy の有無と一致する", async () => {
    const src = new TracingByteSource(await ourSource(FIXTURES.leaf));
    const archive = await PmtilesArchive.open(src);
    const official = new PMTiles(await officialSource(FIXTURES.leaf));
    for (const [z, x, y] of [[8, 200, 100], [6, 0, 5], [3, 1, 1], [0, 0, 0], [8, 0, 0]] as const) {
      const [l, t] = await Promise.all([archive.lookupTile(z, x, y), official.getZxy(z, x, y)]);
      expect(l.result.status === "found").toBe(!!t);
      if (l.result.status === "found") {
        expect(l.result.fileOffset).toBe(archive.header.tileDataOffset + l.result.entry.offset);
        expect(l.result.length).toBe(l.result.entry.length);
      }
    }
    expect(src.records.some((r) => r.purpose === "tile-data")).toBe(false);
  });
});

describe("Read trace", () => {
  it("leaf を経由する lookup: 16 KiB → leaf → tile、隣接タイルでは leaf を再利用", async () => {
    const src = new TracingByteSource(await ourSource(FIXTURES.leaf));
    const archive = await PmtilesArchive.open(src);
    expect(src.records[0]).toMatchObject({ offset: 0, requestedLength: 16384, purpose: "header+root" });

    const t1 = await archive.traceTile(8, 200, 100);
    expect(t1.result.status).toBe("found");
    const dirSteps = t1.steps.filter((s) => s.kind === "directory");
    expect(dirSteps.map((s) => s.directory.kind)).toEqual(["root", "leaf"]);
    expect(src.records.map((r) => r.purpose)).toEqual(["header+root", "leaf-directory", "tile-data"]);

    const readsBefore = src.records.length;
    const t2 = await archive.traceTile(8, 200, 101);
    const leafStep = t2.steps.find((s) => s.kind === "directory" && s.depth === 1);
    expect(leafStep && leafStep.kind === "directory" && leafStep.obtainedBy).toBe("cache");
    expect(src.records.length - readsBefore).toBe(1); // tile だけ

    // tile-read ステップの READ 番号が Range Trace の記録と一致する
    const tileStep = t2.steps.find((s) => s.kind === "tile-read");
    expect(tileStep && tileStep.kind === "tile-read" && tileStep.readId).toBe(src.records.at(-1)!.id);
  });

  it("RunLength > 1 の run の中のタイルは run 先頭 entry で hit する", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    // 西半球 z6 以上は同一内容 "ocean" なので Go writer は run-length にまとめているはず
    let found = false;
    for (let y = 0; y < 64 && !found; y++) {
      const tr = await archive.traceTile(6, 0, y);
      const last = tr.steps.filter((s) => s.kind === "directory").at(-1);
      if (last?.kind === "directory" && last.search.outcome === "run-hit") {
        found = true;
        expect(tr.result.status === "found" && new TextDecoder().decode(tr.result.payload)).toBe("ocean");
      }
    }
    expect(found).toBe(true);
  });

  it("Addressed Tiles ≠ Tile Entries ≠ Tile Contents を header と directory から確認", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    const tiles = (await allDirectories(archive)).flatMap((d) => d.decoded.entries.filter((e) => e.runLength > 0));
    const h = archive.header;
    expect(tiles.length).toBe(h.numTileEntries);
    expect(tiles.reduce((s, e) => s + e.runLength, 0)).toBe(h.numAddressedTiles);
    expect(new Set(tiles.map((e) => e.offset)).size).toBe(h.numTileContents);
    expect(new Set([h.numAddressedTiles, h.numTileEntries, h.numTileContents]).size).toBe(3);
  });
});


describe("spec 違反の許容", () => {
  it("公式 MLT fixture は root の entry 数が 0（公式実装同様に開けて、issue として記録される）", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.mlt));
    expect(archive.root.decoded.issues).toEqual([{ code: "empty-directory" }]);
    const tr = await archive.traceTile(0, 0, 0);
    expect(tr.result.status).toBe("not-found");
  });
});
