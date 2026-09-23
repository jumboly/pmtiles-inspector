import { describe, expect, it } from "vitest";
import { PmtilesArchive } from "../src/core/pmtiles/archive";
import { inspectContent } from "../src/ui/content";
import { FIXTURES, ourSource } from "./helpers";

/** Viewer 側の「どの Inspector に渡すか」の判断。Header の宣言を優先し、中身と合わなければ Raw に落とす */
async function contentOf(fixture: string, z: number, x: number, y: number) {
  const archive = await PmtilesArchive.open(await ourSource(fixture));
  const lookup = await archive.lookupTile(z, x, y);
  if (lookup.result.status !== "found") throw new Error("タイルがあるはず");
  return inspectContent(archive.header.tileType, await archive.readTileData(lookup.result));
}

describe("inspectContent", () => {
  it("MVT（gzip 解凍後の Payload）→ MVT Inspector", async () => {
    const c = await contentOf(FIXTURES.zcta, 0, 0, 0);
    expect(c.kind).toBe("mvt");
    if (c.kind === "mvt") expect(c.mvt.layers.map((l) => l.name)).toEqual(["zcta"]);
  });

  it("PNG（terrarium）→ Raster Inspector", async () => {
    const c = await contentOf(FIXTURES.terrarium, 0, 0, 0);
    expect(c.kind).toBe("raster");
    if (c.kind === "raster") expect(c.mime).toBe("image/png");
  });

  it("png を名乗るが中身はテキスト（leaf_z8）→ Raw に fallback し、理由に食い違いを書く", async () => {
    const c = await contentOf(FIXTURES.leaf, 0, 0, 0);
    expect(c.kind).toBe("raw");
    expect(c.why).toMatch(/png.*text/);
  });
});
