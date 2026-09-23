import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HEADER_SIZE, parseHeader, type Header } from "../src/core/pmtiles/header";
import { computeLayout } from "../src/core/pmtiles/layout";
import { FIXTURES, fixturePath } from "./helpers";

function headerOf(name: string): Header {
  return parseHeader(new Uint8Array(readFileSync(fixturePath(name)).subarray(0, HEADER_SIZE))).header;
}

describe("computeLayout", () => {
  for (const name of [FIXTURES.zcta, FIXTURES.terrarium, FIXTURES.leaf]) {
    it(`${name}: section と gap がファイル全体を隙間なく覆い、問題が無い`, () => {
      const size = statSync(fixturePath(name)).size;
      const layout = computeLayout(headerOf(name), size);
      expect(layout.issues).toEqual([]);
      let cursor = 0;
      for (const s of layout.segments) {
        expect(s.offset).toBe(cursor);
        cursor += s.length;
      }
      expect(cursor).toBe(size);
    });
  }

  it("section の順序を仮定しない: metadata を末尾に移したら末尾に並ぶ", () => {
    const h = { ...headerOf(FIXTURES.leaf) };
    const end = h.tileDataOffset + h.tileDataLength;
    const layout = computeLayout({ ...h, metadataOffset: end }, end + h.metadataLength);
    const names = layout.segments.flatMap((s) => (s.kind === "section" ? [s.name] : []));
    expect(names.at(-1)).toBe("metadata");
    // 元の metadata の場所は隙間として現れる
    expect(layout.segments.some((s) => s.kind === "gap")).toBe(true);
  });

  it("EOF 超え・16 KiB 外の root を issue として報告する", () => {
    const h = headerOf(FIXTURES.leaf);
    const layout = computeLayout({ ...h, rootDirectoryOffset: 20000 }, 1000);
    const codes = layout.issues.map((i) => i.code);
    expect(codes).toContain("beyond-eof");
    expect(codes).toContain("root-outside-first-read");
  });
});
