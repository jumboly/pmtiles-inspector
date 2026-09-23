import type { Feature, MultiPolygon, Polygon } from "geojson";
import type { TileBlock } from "../core/pmtiles/tileid";

/**
 * z/x/y ↔ 経緯度（Web Mercator, XYZ 方式: y = 0 が北端）。
 * PMTiles の TileID は z/x/y の世界で閉じているので、地図との橋渡しはこの adapter 側だけで行う（core には入れない）。
 */

export interface TileXYZ {
  z: number;
  x: number;
  y: number;
}

/** Web Mercator が表せる緯度の上限。タイル y = 0 の北端がちょうどここになる */
const MAX_LAT = 85.0511287798066;

function lon(x: number, z: number): number {
  return (x / 2 ** z) * 360 - 180;
}

function lat(y: number, z: number): number {
  const n = Math.PI * (1 - (2 * y) / 2 ** z);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

/** タイル（またはブロック）の [west, south, east, north]。wrap は MapLibre の世界の複製の番号（±360° ずつずらす） */
export function tileBounds(z: number, x: number, y: number, size = 1, wrap = 0): [number, number, number, number] {
  return [lon(x, z) + wrap * 360, lat(y + size, z), lon(x + size, z) + wrap * 360, lat(y, z)];
}

export function tileCenter(t: TileXYZ): [number, number] {
  // 緯度方向は Mercator 上の中点にする（経緯度の算術平均だと高緯度でタイルの中心からずれる）
  return [lon(t.x + 0.5, t.z), lat(t.y + 0.5, t.z)];
}

/** 経緯度を含むズーム z のタイル。経度は世界の複製を跨いでいても 0..2^z-1 に折り返す */
export function lngLatToTile(lng: number, latitude: number, z: number): TileXYZ {
  const n = 2 ** z;
  const wrapped = ((((lng + 180) % 360) + 360) % 360) / 360;
  const la = Math.max(-MAX_LAT, Math.min(MAX_LAT, latitude));
  const r = (la * Math.PI) / 180;
  const fy = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
  return { z, x: Math.min(n - 1, Math.floor(wrapped * n)), y: Math.max(0, Math.min(n - 1, Math.floor(fy * n))) };
}

type Ring = [number, number][];

/** 矩形の外周。Mercator では経線・緯線が直線なので 4 隅で足りる */
export function rectRing([w, s, e, n]: [number, number, number, number]): Ring {
  return [
    [w, n],
    [e, n],
    [e, s],
    [w, s],
    [w, n],
  ];
}

export function tilePolygon(t: TileXYZ): Feature<Polygon> {
  return { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [rectRing(tileBounds(t.z, t.x, t.y))] } };
}

/** 整列ブロックの並び（= TileID の連続区間）を 1 つの MultiPolygon にする */
export function blocksPolygon(blocks: TileBlock[]): Feature<MultiPolygon> {
  return {
    type: "Feature",
    properties: {},
    geometry: { type: "MultiPolygon", coordinates: blocks.map((b) => [rectRing(tileBounds(b.z, b.x0, b.y0, b.size))]) },
  };
}
