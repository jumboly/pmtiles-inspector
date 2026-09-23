import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PmtilesArchive } from "../src/core/pmtiles/archive";
import { inspectRaster, type RasterFormat } from "../src/tile-inspector/raster/inspect";
import { sniff } from "../src/tile-inspector/raw/sniff";
import { FIXTURES, ourSource } from "./helpers";

/** scripts/make-image-samples.py で外部 encoder（Pillow / cwebp / sips）が作った 37 × 23 の画像 */
const sample = (name: string) => new Uint8Array(readFileSync(new URL(`./data/images/${name}`, import.meta.url)));

describe("inspectRaster: header から寸法を読む", () => {
  const cases: [string, RasterFormat, RegExp | undefined][] = [
    ["rgb.png", "png", undefined],
    ["baseline.jpg", "jpeg", /Baseline/],
    ["progressive.jpg", "jpeg", /Progressive/],
    ["lossy.webp", "webp", /^VP8 /],
    ["lossless.webp", "webp", /^VP8L/],
    ["alpha.webp", "webp", /^VP8X/],
    ["rgb.avif", "avif", /clap/],
  ];
  it.each(cases)("%s → 37 × 23", (name, format, variant) => {
    const bytes = sample(name);
    // 形式の判定は sniff、寸法は inspectRaster と役割を分けている。両方が同じ形式を指すことも確かめる
    expect(sniff(bytes).kind).toBe(format);
    const info = inspectRaster(bytes, format);
    expect(info.issues).toEqual([]);
    expect([info.width, info.height]).toEqual([37, 23]);
    if (variant) expect(info.variant).toMatch(variant);
    for (const s of info.sizeSpans) expect(s.offset + s.length).toBeLessThanOrEqual(bytes.length);
  });

  it("AVIF: ispe は符号化サイズ（AV1 が偶数に揃えた 38 × 24）で、表示寸法は clap で切り抜いた 37 × 23", () => {
    const info = inspectRaster(sample("rgb.avif"), "avif");
    expect(info.fields.find((f) => f.label.startsWith("ispe"))?.value).toBe("38 × 24");
    expect(info.fields.find((f) => f.label.startsWith("clap"))?.value).toBe("37 × 23");
  });

  it("PNG の width / height の span は IHDR の data の先頭 8 byte", () => {
    const info = inspectRaster(sample("rgb.png"), "png");
    expect(info.sizeSpans).toEqual([{ offset: 16, length: 4 }, { offset: 20, length: 4 }]);
  });

  it("途中で切れた header は issues に残す（例外にしない）", () => {
    expect(inspectRaster(sample("rgb.png").subarray(0, 18), "png").issues).toEqual(["header が途中で切れている"]);
    expect(inspectRaster(sample("baseline.jpg").subarray(0, 40), "jpeg").width).toBeUndefined();
  });

  it("terrarium_z2 の tile（PNG, Tile Compression = none）", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.terrarium));
    const lookup = await archive.lookupTile(1, 1, 0);
    if (lookup.result.status !== "found") throw new Error("z1 はあるはず");
    const tile = await archive.readTileData(lookup.result);
    const info = inspectRaster(tile.payload!, "png");
    expect(info.issues).toEqual([]);
    expect(info.width).toBe(info.height);
    expect([256, 512]).toContain(info.width);
  });
});
