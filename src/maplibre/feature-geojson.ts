import type { Feature, MultiLineString, MultiPoint, MultiPolygon, Position } from "geojson";
import { GeomType } from "../tile-inspector/mvt/decode";
import type { DecodedGeometry, Point } from "../tile-inspector/mvt/geometry";
import { tilePointToLngLat, type TileXYZ } from "./tile-geometry";

/**
 * decode した MVT geometry（tile 座標）を、地図に重ねる GeoJSON（経緯度）にする。
 *
 * MVT Inspector は「どのタイルの feature か」を知らない（bytes だけで動く）ので、z/x/y と extent を与えて地図上の位置に写すのは adapter のこの層。
 * MapLibre が描いた feature を取り出すのではなく、自前で decode した座標から描き直すので、
 * 地図上の強調表示は「Inspector が読んだ geometry」そのものになる（MapLibre の解釈とずれていれば見て分かる）。
 */
export function featureGeoJson(g: DecodedGeometry, tile: TileXYZ, extent: number): Feature<MultiPoint | MultiLineString | MultiPolygon> | undefined {
  const pos = ([x, y]: Point): Position => tilePointToLngLat(tile, x / extent, y / extent);
  if (!g.parts.length) return undefined;
  if (g.type === GeomType.Point) {
    return { type: "Feature", properties: {}, geometry: { type: "MultiPoint", coordinates: g.parts.flatMap((p) => p.points.map(pos)) } };
  }
  if (g.type === GeomType.LineString) {
    return { type: "Feature", properties: {}, geometry: { type: "MultiLineString", coordinates: g.parts.map((p) => p.points.map(pos)) } };
  }
  if (g.type === GeomType.Polygon) {
    // GeoJSON の ring は始点を末尾に繰り返して閉じる（MVT は ClosePath で表すので点列には含まれない）
    const ring = (i: number) => {
      const pts = g.parts[i]!.points.map(pos);
      return [...pts, pts[0]!];
    };
    const polygons = g.polygons.map((poly) => poly.map(ring));
    return polygons.length ? { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: polygons } } : undefined;
  }
  return undefined;
}
