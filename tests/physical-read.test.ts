import { PMTiles } from "pmtiles";
import { describe, expect, it } from "vitest";
import { PmtilesArchive } from "../src/core/pmtiles/archive";
import { Compression } from "../src/core/pmtiles/enums";
import { TracingByteSource } from "../src/core/source/tracing-byte-source";
import { sniff } from "../src/tile-inspector/raw/sniff";
import { buildTraceSteps } from "../src/ui/trace-steps";
import { FIXTURES, officialSource, ourSource } from "./helpers";

describe("readTileData (Physical Read)", () => {
  it("lookup の後で読むと、read は 16 KiB → leaf → tile の順になり、payload は公式 getZxy と一致する", async () => {
    const src = new TracingByteSource(await ourSource(FIXTURES.leaf));
    const archive = await PmtilesArchive.open(src);
    const official = new PMTiles(await officialSource(FIXTURES.leaf));

    const lookup = await archive.lookupTile(8, 200, 100);
    expect(src.records.map((r) => r.purpose)).toEqual(["header+root", "leaf-directory"]);
    if (lookup.result.status !== "found") throw new Error("fixture にタイルがあるはず");

    const tile = await archive.readTileData(lookup.result);
    const rec = src.records.at(-1)!;
    expect(rec).toMatchObject({ purpose: "tile-data", offset: lookup.result.fileOffset, requestedLength: lookup.result.length });
    expect(tile.readId).toBe(rec.id);
    expect(tile.raw.length).toBe(lookup.result.length);
    expect(tile.payload).toEqual(new Uint8Array((await official.getZxy(8, 200, 100))!.data));
  });

  it("tile はキャッシュしない: 同じタイルを 2 回読めば read も 2 回（公式実装と同じ）", async () => {
    const src = new TracingByteSource(await ourSource(FIXTURES.zcta));
    const archive = await PmtilesArchive.open(src);
    const lookup = await archive.lookupTile(0, 0, 0);
    if (lookup.result.status !== "found") throw new Error("z0 はあるはず");
    await archive.readTileData(lookup.result);
    await archive.readTileData(lookup.result);
    expect(src.records.filter((r) => r.purpose === "tile-data").length).toBe(2);
  });

  it("gzip tile: raw は gzip の magic、payload は MVT の layers tag で始まる", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.zcta));
    expect(archive.header.tileCompression).toBe(Compression.Gzip);
    const lookup = await archive.lookupTile(0, 0, 0);
    if (lookup.result.status !== "found") throw new Error("z0 はあるはず");
    const tile = await archive.readTileData(lookup.result);
    expect(sniff(tile.raw).kind).toBe("gzip");
    expect(sniff(tile.payload!).kind).toBe("mvt-like");
    expect(tile.payload!.length).toBeGreaterThan(tile.raw.length);
  });

  it("Tile Compression = none: payload は raw と同じバッファ（無変換）", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.terrarium));
    const lookup = await archive.lookupTile(1, 1, 0);
    if (lookup.result.status !== "found") throw new Error("z1 はあるはず");
    const tile = await archive.readTileData(lookup.result);
    expect(tile.payload).toBe(tile.raw);
    expect(sniff(tile.payload!).kind).toBe("png");
  });

  it("leaf_z8 は Tile Type = png を名乗るが中身はテキスト（宣言と中身の食い違いの例）", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    const lookup = await archive.lookupTile(8, 200, 100);
    if (lookup.result.status !== "found") throw new Error("fixture にタイルがあるはず");
    const tile = await archive.readTileData(lookup.result);
    expect(sniff(tile.payload!).kind).toBe("text");
  });
});

describe("sniff", () => {
  const b = (...xs: (number | string)[]) => new Uint8Array(xs.flatMap((x) => (typeof x === "string" ? Array.from(x, (c) => c.charCodeAt(0)) : [x])));
  it.each([
    ["gzip", b(0x1f, 0x8b, 8, 0), { offset: 0, length: 2 }],
    ["zstd", b(0x28, 0xb5, 0x2f, 0xfd, 0), { offset: 0, length: 4 }],
    ["png", b(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a, 0), { offset: 0, length: 8 }],
    ["jpeg", b(0xff, 0xd8, 0xff, 0xe0), { offset: 0, length: 3 }],
    ["webp", b("RIFF", 0, 0, 0, 0, "WEBPVP8 "), { offset: 0, length: 12 }],
    ["avif", b(0, 0, 0, 0x1c, "ftypavif"), { offset: 4, length: 8 }],
    ["mvt-like", b(0x1a, 0x05), { offset: 0, length: 1 }],
  ] as const)("%s", (kind, bytes, evidence) => {
    expect(sniff(bytes)).toMatchObject({ kind, evidence });
  });
  it("text / empty / unknown", () => {
    expect(sniff(b("tile 8/1/2")).kind).toBe("text");
    expect(sniff(new Uint8Array()).kind).toBe("empty");
    expect(sniff(b(0x00, 0x01, 0x02)).kind).toBe("unknown");
  });
});

describe("Tile Trace の段構成", () => {
  it("found なら Tile Entry の後に Range Read → Decompression → Payload が続き、not-found なら付かない", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    const found = await archive.lookupTile(8, 200, 100);
    expect(buildTraceSteps(found).map((s) => s.kind).slice(-4)).toEqual(["result", "range-read", "tile-decompress", "payload"]);
    const out = await archive.lookupTile(9, 0, 0);
    expect(buildTraceSteps(out).at(-1)!.kind).toBe("result");
  });
});
