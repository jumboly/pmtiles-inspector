import { readFileSync } from "node:fs";
import { bytesToHeader } from "pmtiles";
import { describe, expect, it } from "vitest";
import { HEADER_LAYOUT, HEADER_SIZE, parseHeader, sectionsOf } from "../src/core/pmtiles/header";
import { FIXTURES, fixturePath } from "./helpers";

function headerBytes(name: string): Uint8Array {
  return new Uint8Array(readFileSync(fixturePath(name)).subarray(0, HEADER_SIZE));
}

describe("Header parser vs 公式 bytesToHeader", () => {
  for (const name of Object.values(FIXTURES)) {
    it(name, () => {
      const bytes = headerBytes(name);
      const { header: ours } = parseHeader(bytes);
      const o = bytesToHeader(bytes.slice().buffer);
      expect(ours).toEqual({
        magic: "PMTiles",
        specVersion: o.specVersion,
        rootDirectoryOffset: o.rootDirectoryOffset,
        rootDirectoryLength: o.rootDirectoryLength,
        // 公式は jsonMetadata*/leafDirectory* という名前。spec の用語 (Metadata / Leaf Directories) に合わせて改名している
        metadataOffset: o.jsonMetadataOffset,
        metadataLength: o.jsonMetadataLength,
        leafDirectoriesOffset: o.leafDirectoryOffset,
        leafDirectoriesLength: o.leafDirectoryLength,
        tileDataOffset: o.tileDataOffset,
        tileDataLength: o.tileDataLength,
        numAddressedTiles: o.numAddressedTiles,
        numTileEntries: o.numTileEntries,
        numTileContents: o.numTileContents,
        // 公式は boolean に潰すが、ここでは生の byte 値を保持する
        clustered: o.clustered ? 1 : 0,
        internalCompression: o.internalCompression,
        tileCompression: o.tileCompression,
        tileType: o.tileType,
        minZoom: o.minZoom,
        maxZoom: o.maxZoom,
        minLon: o.minLon,
        minLat: o.minLat,
        maxLon: o.maxLon,
        maxLat: o.maxLat,
        centerZoom: o.centerZoom,
        centerLon: o.centerLon,
        centerLat: o.centerLat,
      });
    });
  }

  it("HEADER_LAYOUT は 0..126 を隙間なく重複なく覆う", () => {
    let pos = 0;
    for (const f of HEADER_LAYOUT) {
      expect(f.offset).toBe(pos);
      pos += f.length;
    }
    expect(pos).toBe(HEADER_SIZE);
  });

  it("spans は各 field の byte 位置を返す", () => {
    const { spans } = parseHeader(headerBytes(FIXTURES.leaf));
    expect(spans.rootDirectoryOffset).toEqual({ offset: 8, length: 8 });
    expect(spans.centerLat).toEqual({ offset: 123, length: 4 });
  });

  it("invalid.pmtiles は magic 不一致で拒否", () => {
    const bytes = new Uint8Array(readFileSync(fixturePath("invalid.pmtiles")));
    expect(() => parseHeader(bytes)).toThrow();
  });

  it("invalid_v4.pmtiles は version で拒否", () => {
    expect(() => parseHeader(headerBytes("invalid_v4.pmtiles"))).toThrow(/version 4/);
  });

  it("sectionsOf は offset 順に並べる", () => {
    const { header } = parseHeader(headerBytes(FIXTURES.leaf));
    const secs = sectionsOf(header);
    for (let i = 1; i < secs.length; i++) expect(secs[i]!.offset).toBeGreaterThanOrEqual(secs[i - 1]!.offset);
  });
});
