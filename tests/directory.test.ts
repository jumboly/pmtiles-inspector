import { describe, expect, it } from "vitest";
import { PmtilesArchive } from "../src/core/pmtiles/archive";
import { decodeDirectory, encodeDirectory, summarizeOffsets, type Entry } from "../src/core/pmtiles/directory";
import { Compression } from "../src/core/pmtiles/enums";
import { allDirectories, FIXTURES, ourSource } from "./helpers";

const ARCHIVES = [FIXTURES.fixture1, FIXTURES.fixture2, FIXTURES.mlt, FIXTURES.zcta, FIXTURES.terrarium, FIXTURES.leaf, FIXTURES.leafNoComp];

describe("encodeDirectory: 公式 writer の出力を byte 単位で再現できる", () => {
  for (const name of ARCHIVES) {
    it(name, async () => {
      const archive = await PmtilesArchive.open(await ourSource(name));
      for (const d of await allDirectories(archive)) {
        // decode → encode で解凍後 bytes と完全一致すれば、符号化規則（列順・差分・offset の 0/+1）の理解が writer と同じ
        expect(encodeDirectory(d.decoded.entries)).toEqual(d.decompressed);
      }
    });
  }
});

/** leaf の個数 = 各 leaf の先頭 entry の数 */
const da = (a: PmtilesArchive) => a.root.decoded.entries.filter((e) => e.runLength === 0).length;

describe("offset encoding", () => {
  const e = (tileId: number, offset: number, length: number, runLength = 1): Entry => ({ tileId, offset, length, runLength });

  it("連続なら 0、先頭と非連続は offset + 1", () => {
    const entries = [e(1000, 0, 250), e(1003, 250, 10), e(1004, 0, 250), e(1012, 260, 5), e(1013, 300, 5)];
    const enc = decodeDirectory(encodeDirectory(entries)).encoding;
    expect(enc.tileIdDeltas.map((v) => v.value)).toEqual([1000, 3, 1, 8, 1]);
    expect(enc.offsets.map((v) => [v.value, v.mode])).toEqual([
      [1, "explicit"],
      [0, "contiguous"],
      [1, "explicit"], // 後方参照（dedup）
      [261, "explicit"], // dedup の後、書き込み済み末尾 (260) から再開。直前の直後 (250) ではないので明示
      [301, "explicit"], // 265 を飛ばして 300 へ（隙間）
    ]);
    expect(summarizeOffsets(entries)).toEqual({ contiguous: 1, first: 1, backward: 1, resume: 1, forward: 1 });
  });

  it("clustered な leaf fixture では、explicit は先頭・dedup の後方参照・その直後の再開だけ", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    const h = archive.header;
    const total = { contiguous: 0, first: 0, backward: 0, resume: 0, forward: 0 };
    for (const d of await allDirectories(archive)) {
      if (d.kind === "root") continue;
      const s = summarizeOffsets(d.decoded.entries);
      for (const k of Object.keys(total) as (keyof typeof total)[]) total[k] += s[k];
    }
    expect(total.forward).toBe(0);
    // 後方参照の数 = Tile Entries − Tile Contents（dedup で実体を共有した entry 数）
    expect(total.backward).toBe(h.numTileEntries - h.numTileContents);
    // 後方参照のたびに、次の新しい content は書き込み済み末尾から再開する
    expect(total.resume).toBe(total.backward);
    expect(total.first).toBe(da(archive));
    expect(total.contiguous + total.first + total.backward + total.resume).toBe(h.numTileEntries);
  });
});

describe("無圧縮 fixture", () => {
  it("leaf_z8 と同じ entries を持ち、directory の bytes がファイル上にそのまま現れる", async () => {
    const [a, b] = await Promise.all([PmtilesArchive.open(await ourSource(FIXTURES.leaf)), PmtilesArchive.open(await ourSource(FIXTURES.leafNoComp))]);
    expect(b.header.internalCompression).toBe(Compression.None);
    const [da, db] = await Promise.all([allDirectories(a), allDirectories(b)]);
    expect(db.length).toBe(da.length);
    for (let i = 1; i < da.length; i++) {
      // leaf は再符号化せず解凍しただけなので、解凍後 bytes も一致する
      expect(db[i]!.decompressed).toEqual(da[i]!.decompressed);
      expect(db[i]!.compressed).toEqual(db[i]!.decompressed);
    }
  });
});
