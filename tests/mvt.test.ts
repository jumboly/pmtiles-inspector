import { VectorTile } from "@mapbox/vector-tile";
import { PbfReader, PbfWriter } from "pbf";
import { describe, expect, it } from "vitest";
import { PmtilesArchive } from "../src/core/pmtiles/archive";
import { tileIdToZxy } from "../src/core/pmtiles/tileid";
import { featureProperties, GeomType, inspectMvt, type MvtTile } from "../src/tile-inspector/mvt/decode";
import { decodeGeometry } from "../src/tile-inspector/mvt/geometry";
import { hitTest } from "../src/tile-inspector/mvt/hit-test";
import { allDirectories, FIXTURES, ourSource } from "./helpers";

/** zigzag + command integer で geometry を組み立てる（spec 4.3 の式そのまま。テストの入力を読める形で書くため） */
const cmd = (id: number, count: number) => (id & 0x7) | (count << 3);
const zz = (n: number) => (n << 1) ^ (n >> 31);
function path(points: [number, number][], close: boolean): number[] {
  const out: number[] = [];
  let cx = 0;
  let cy = 0;
  points.forEach(([x, y], i) => {
    if (i === 0) out.push(cmd(1, 1));
    else if (i === 1) out.push(cmd(2, points.length - 1));
    out.push(zz(x - cx), zz(y - cy));
    cx = x;
    cy = y;
  });
  if (close) out.push(cmd(7, 1));
  return out;
}

/**
 * 公式 pbf の writer で MVT を組み立てる。自前 decoder の入力を自前の encoder で作らないため
 * （field 番号と wire type は vector_tile.proto どおりに書く）。
 */
interface SynthFeature {
  id?: number;
  type: number;
  tags: number[];
  geometry: number[];
  /** tags を packed でなく VARINT の繰り返しで書く（protobuf の parser は両方を受け付ける必要がある） */
  unpackedTags?: boolean;
}
interface SynthLayer {
  name: string;
  extent?: number;
  keys: string[];
  values: ((w: PbfWriter) => void)[];
  features: SynthFeature[];
}
function buildTile(layers: SynthLayer[]): Uint8Array {
  const w = new PbfWriter();
  for (const l of layers) {
    w.writeMessage(3, (layer: SynthLayer, lw: PbfWriter) => {
      lw.writeVarintField(15, 2);
      lw.writeStringField(1, layer.name);
      for (const f of layer.features) {
        lw.writeMessage(2, (ft: SynthFeature, fw: PbfWriter) => {
          if (ft.id !== undefined) fw.writeVarintField(1, ft.id);
          if (ft.unpackedTags) for (const t of ft.tags) fw.writeVarintField(2, t);
          else fw.writePackedVarint(2, ft.tags);
          fw.writeVarintField(3, ft.type);
          fw.writePackedVarint(4, ft.geometry);
        }, f);
      }
      for (const k of layer.keys) lw.writeStringField(3, k);
      for (const v of layer.values) lw.writeMessage(4, (_: unknown, vw: PbfWriter) => v(vw), undefined);
      if (layer.extent !== undefined) lw.writeVarintField(5, layer.extent);
    }, l);
  }
  return w.finish();
}

/** 自前 decoder の結果を、公式 @mapbox/vector-tile の結果と同じ形（properties / 頂点列）にして比べる */
function compareWithOfficial(bytes: Uint8Array, ours: MvtTile) {
  const vt = new VectorTile(new PbfReader(bytes));
  expect(ours.error).toBeUndefined();
  expect(ours.layers.map((l) => l.name).sort()).toEqual(Object.keys(vt.layers).sort());
  for (const layer of ours.layers) {
    const off = vt.layers[layer.name]!;
    expect(layer.version).toBe(off.version);
    expect(layer.extent).toBe(off.extent);
    expect(layer.features.length).toBe(off.length);
    // feature ごとに expect すると数千 feature × 頂点で遅いので、layer 単位で 1 回だけ比べる
    const ours: unknown[] = [];
    const official: unknown[] = [];
    layer.features.forEach((f, i) => {
      const of = off.feature(i);
      const props = Object.fromEntries(featureProperties(layer, f).map((p) => [p.key, typeof p.value?.value === "bigint" ? Number(p.value.value) : p.value?.value]));
      // 公式は ClosePath で始点の複製を ring の末尾に足す。自前は「閉じている」という印だけ持つので、比べる前に揃える
      const g = decodeGeometry(f.geometry, f.type);
      const ourRings = g.parts.map((p) => (p.closed ? [...p.points, p.points[0]!] : p.points));
      const offRings = of.loadGeometry().map((r) => r.map((pt) => [pt.x, pt.y]));
      // 公式は MultiPoint を 1 つの点列として返し、自前は点ごとに part を分けるので、点は平らにして比べる
      ours.push([f.type, f.id, props, f.type === GeomType.Point ? ourRings.flat() : ourRings]);
      official.push([of.type, of.id, of.properties, f.type === GeomType.Point ? offRings.flat() : offRings]);
    });
    expect(ours).toEqual(official);
  }
}

describe("inspectMvt vs 公式 @mapbox/vector-tile", () => {
  it("zcta_z3 の全タイル: layer / feature / properties / geometry が一致する", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.zcta));
    let tiles = 0;
    for (const dir of await allDirectories(archive)) {
      for (const e of dir.decoded.entries) {
        if (e.runLength === 0) continue;
        const { z, x, y } = tileIdToZxy(e.tileId);
        const lookup = await archive.lookupTile(z, x, y);
        if (lookup.result.status !== "found") throw new Error("entry があるはず");
        const tile = await archive.readTileData(lookup.result);
        compareWithOfficial(tile.payload!, inspectMvt(tile.payload!));
        tiles++;
      }
    }
    // zcta_z3 は z0-3 の 18 タイル（run-length 無し）
    expect(tiles).toBe(18);
  }, 60_000);

  it("合成タイル: 7 種の Value 型・id の有無・packed でない tags・Multi geometry・穴あき polygon", () => {
    const bytes = buildTile([
      {
        name: "mixed",
        extent: 4096,
        keys: ["s", "f", "d", "i", "u", "si", "b", "neg"],
        values: [
          (w) => w.writeStringField(1, "日本語"),
          (w) => w.writeFloatField(2, 1.5),
          (w) => w.writeDoubleField(3, Math.PI),
          (w) => w.writeVarintField(4, 42),
          (w) => w.writeVarintField(5, 2 ** 40),
          (w) => w.writeSVarintField(6, -7),
          (w) => w.writeBooleanField(7, true),
          // int64 の負数は 64bit の 2 の補数として 10 byte の varint になる
          (w) => w.writeVarintField(4, -3),
        ],
        features: [
          { id: 0, type: GeomType.Point, tags: [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7], geometry: [cmd(1, 2), zz(5), zz(7), zz(-2), zz(-5)] },
          { type: GeomType.LineString, tags: [0, 0], geometry: [...path([[2, 2], [2, 10], [10, 10]], false), ...relative(path([[1, 1], [3, 5]], false), [10, 10], [1, 1])] },
          {
            id: 123456789,
            type: GeomType.Polygon,
            tags: [],
            // 外周（時計回り = 面積正）+ 穴（反時計回り = 面積負）、さらに 2 つ目の polygon
            geometry: [
              ...path([[0, 0], [100, 0], [100, 100], [0, 100]], true),
              ...relative(path([[20, 20], [20, 80], [80, 80], [80, 20]], true), [0, 100], [20, 20]),
              ...relative(path([[200, 200], [300, 200], [300, 300]], true), [80, 20], [200, 200]),
            ],
          },
        ],
      },
    ]);
    const ours = inspectMvt(bytes);
    compareWithOfficial(bytes, ours);
    const layer = ours.layers[0]!;
    expect(layer.values.map((v) => v.type)).toEqual(["string", "float", "double", "int", "uint", "sint", "bool", "int"]);
    expect(layer.values[7]!.value).toBe(-3);
    // id = 0 を書いた feature と、id を書かなかった feature を区別する
    expect(layer.features[0]!.id).toBe(0);
    expect(layer.features[1]!.id).toBeUndefined();
    const poly = decodeGeometry(layer.features[2]!.geometry, GeomType.Polygon);
    expect(poly.parts.map((p) => p.role)).toEqual(["exterior", "interior", "exterior"]);
    expect(poly.polygons).toEqual([[0, 1], [2]]);
    expect(poly.issues).toEqual([]);
  });

  it("packed でない tags も読む（公式 @mapbox/vector-tile は packed だと決め打ちして読むので、ここは自前だけで確かめる）", () => {
    const bytes = buildTile([
      { name: "a", keys: ["k", "k2"], values: [(w) => w.writeStringField(1, "v"), (w) => w.writeBooleanField(7, false)], features: [{ type: 1, tags: [0, 0, 1, 1], unpackedTags: true, geometry: [9, 50, 34] }] },
    ]);
    const layer = inspectMvt(bytes).layers[0]!;
    expect(featureProperties(layer, layer.features[0]!).map((p) => [p.key, p.value?.value])).toEqual([["k", "v"], ["k2", false]]);
  });
});

/** path() は原点からの差分で書くので、前の part の最後の点（cursor）からの差分に直す */
function relative(ints: number[], cursor: [number, number], first: [number, number]): number[] {
  const out = [...ints];
  out[1] = zz(first[0] - cursor[0]);
  out[2] = zz(first[1] - cursor[1]);
  return out;
}

describe("decodeGeometry（spec 4.3.5 の例）", () => {
  it("Point: [9, 50, 34] → (25, 17)", () => {
    const g = decodeGeometry([9, 50, 34], GeomType.Point);
    expect(g.parts.map((p) => p.points)).toEqual([[[25, 17]]]);
    expect(g.commands[0]).toMatchObject({ name: "MoveTo", count: 1, params: [{ dx: 25, dy: 17, x: 25, y: 17 }] });
  });

  it("MultiPoint: [17, 10, 14, 3, 9] → (5, 7), (3, 2)。2 点目は 1 点目からの差分", () => {
    const g = decodeGeometry([17, 10, 14, 3, 9], GeomType.Point);
    expect(g.parts.map((p) => p.points[0])).toEqual([[5, 7], [3, 2]]);
  });

  it("LineString: [9, 4, 4, 18, 0, 16, 16, 0] → (2,2) (2,10) (10,10)", () => {
    const g = decodeGeometry([9, 4, 4, 18, 0, 16, 16, 0], GeomType.LineString);
    expect(g.parts[0]!.points).toEqual([[2, 2], [2, 10], [10, 10]]);
    expect(g.issues).toEqual([]);
  });

  it("Polygon: [9, 6, 12, 18, 10, 12, 24, 44, 15] → (3,6) (8,12) (20,34) で閉じた exterior", () => {
    const g = decodeGeometry([9, 6, 12, 18, 10, 12, 24, 44, 15], GeomType.Polygon);
    expect(g.parts[0]).toMatchObject({ points: [[3, 6], [8, 12], [20, 34]], closed: true, role: "exterior" });
  });

  it("規則違反は issues に残し、読めるところまで展開する", () => {
    expect(decodeGeometry([9, 50], GeomType.Point).issues[0]).toMatch(/パラメータが足りない/);
    expect(decodeGeometry([17, 2, 2, 2, 2], GeomType.LineString).issues[0]).toMatch(/LINESTRING/);
    // 反時計回りだけの ring = 先行する exterior の無い interior
    expect(decodeGeometry(path([[0, 0], [0, 10], [10, 10], [10, 0]], true), GeomType.Polygon).issues[0]).toMatch(/exterior ring が無い/);
  });
});

describe("inspectMvt の byte 範囲と壊れた入力", () => {
  it("layer / feature / value の span は Payload 上の実際の bytes を指す", () => {
    const bytes = buildTile([{ name: "a", keys: ["k"], values: [(w) => w.writeStringField(1, "v")], features: [{ type: 1, tags: [0, 0], geometry: [9, 50, 34] }] }]);
    const layer = inspectMvt(bytes).layers[0]!;
    expect(layer.span).toEqual({ offset: 0, length: bytes.length });
    const f = layer.features[0]!;
    // feature の geometry field は tag(0x22) + length(3) + [9, 50, 34]
    expect(Array.from(bytes.subarray(f.fieldSpans.geometry!.offset, f.fieldSpans.geometry!.offset + f.fieldSpans.geometry!.length))).toEqual([0x22, 3, 9, 50, 34]);
    const v = layer.values[0]!;
    expect(new TextDecoder().decode(bytes.subarray(v.valueSpan!.offset, v.valueSpan!.offset + v.valueSpan!.length))).toBe("v");
    expect(layer.issues).toContain("extent が無い（既定値 4096 を使った）");
  });

  it("途中で切れた tile は、切れる前の layer まで返して error を記録する", () => {
    const one = buildTile([{ name: "a", keys: [], values: [], features: [{ type: 1, tags: [], geometry: [9, 50, 34] }] }]);
    const two = buildTile([
      { name: "a", keys: [], values: [], features: [{ type: 1, tags: [], geometry: [9, 50, 34] }] },
      { name: "b", keys: [], values: [], features: [{ type: 1, tags: [], geometry: [9, 50, 34] }] },
    ]);
    const cut = inspectMvt(two.subarray(0, one.length + 4));
    expect(cut.layers.map((l) => l.name)).toEqual(["a"]);
    expect(cut.error?.message).toMatch(/message の終わりを越える/);
  });

  it("MVT でない bytes（PNG）は error になり layer は 0 個", () => {
    const t = inspectMvt(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(t.layers).toEqual([]);
    expect(t.error ?? t.issues.length).toBeTruthy();
  });
});

describe("hitTest", () => {
  const bytes = buildTile([
    {
      name: "l",
      extent: 100,
      keys: [],
      values: [],
      features: [
        { type: GeomType.Polygon, tags: [], geometry: path([[0, 0], [100, 0], [100, 100], [0, 100]], true) },
        { type: GeomType.Polygon, tags: [], geometry: path([[40, 40], [60, 40], [60, 60], [40, 60]], true) },
        { type: GeomType.LineString, tags: [], geometry: path([[0, 50], [100, 50]], false) },
      ],
    },
  ]);
  const tile = inspectMvt(bytes);

  it("点 → 線 → 面（小さい順）の順に返す", () => {
    expect(hitTest(tile, 0.5, 0.505, 0.01).map((h) => h.feature)).toEqual([2, 1, 0]);
  });

  it("tolerance の外の線には当たらない。面は内側なら距離 0", () => {
    const hits = hitTest(tile, 0.2, 0.2, 0.01);
    expect(hits.map((h) => [h.feature, h.distance])).toEqual([[0, 0]]);
  });
});
