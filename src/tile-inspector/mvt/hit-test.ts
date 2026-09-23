import { GeomType, type MvtTile } from "./decode";
import { decodeGeometry, type DecodedGeometry, type Point } from "./geometry";

/**
 * tile 座標上の 1 点に当たる feature を探す。
 *
 * MapLibre の queryRenderedFeatures を使わないのは、MVT の feature には id が無いことが多く、
 * MapLibre の結果を「この tile の何番目の feature か」に 1 対 1 で戻せないため。
 * 自前で decode した geometry に対して判定すれば、答えは常に (layer index, feature index) になる。
 */
export interface FeatureHit {
  layer: number;
  feature: number;
  type: number;
  /** 点・線は点までの距離、面は内側なら 0（tile 座標の単位） */
  distance: number;
  /** 面の広さ。重なった面では小さい方（= より具体的な方）を先に出すため */
  area: number;
}

/**
 * tolerance は tile 座標の単位（layer の extent が違えば layer ごとに換算する必要があるので、tile の幅に対する割合で受け取る）。
 * 返す順は 点 → 線 → 面（面は小さい順）。細い線や点は面の上に描かれていて、クリックした人が狙っていたのはそちらの方が多いため。
 */
export function hitTest(tile: MvtTile, fx: number, fy: number, toleranceFrac: number, geometryOf = cachedGeometry()): FeatureHit[] {
  const hits: FeatureHit[] = [];
  for (const layer of tile.layers) {
    const px = fx * layer.extent;
    const py = fy * layer.extent;
    const tol = toleranceFrac * layer.extent;
    for (const f of layer.features) {
      const g = geometryOf(layer.index, f.index, f.geometry, f.type);
      const bb = g.bbox;
      if (!bb || px < bb[0] - tol || px > bb[2] + tol || py < bb[1] - tol || py > bb[3] + tol) continue;
      const d = distanceTo(g, [px, py]);
      if (d > tol) continue;
      hits.push({ layer: layer.index, feature: f.index, type: f.type, distance: d, area: f.type === GeomType.Polygon ? polygonArea(g) : 0 });
    }
  }
  // 点を内側に含む面があるなら、輪郭が近いだけの隣の面は候補から外す（行政区画のような面の敷き詰めで候補が十数個に膨らむため）。
  // 輪郭の近くでも当てるのは、どの面の内側でもない地点（細い面の外側など）で狙いやすくするためだけ
  const inside = hits.some((x) => x.type === GeomType.Polygon && x.distance === 0);
  const kept = inside ? hits.filter((x) => x.type !== GeomType.Polygon || x.distance === 0) : hits;
  const rank = (t: number) => (t === GeomType.Point ? 0 : t === GeomType.LineString ? 1 : 2);
  return kept.sort((a, b) => rank(a.type) - rank(b.type) || a.distance - b.distance || a.area - b.area);
}

/** 同じ tile に何度も当たり判定をするので、decode した geometry を feature ごとに覚えておく */
export function cachedGeometry() {
  const cache = new Map<string, DecodedGeometry>();
  return (layer: number, feature: number, ints: readonly number[], type: number) => {
    const key = `${layer}/${feature}`;
    let g = cache.get(key);
    if (!g) cache.set(key, (g = decodeGeometry(ints, type)));
    return g;
  };
}

function distanceTo(g: DecodedGeometry, p: Point): number {
  if (g.type === GeomType.Polygon) {
    for (const poly of g.polygons) {
      const [ext, ...holes] = poly.map((i) => g.parts[i]!.points);
      if (ext && inRing(ext, p) && !holes.some((h) => inRing(h, p))) return 0;
    }
    // 外側でも輪郭の近くなら当てる（細い面を狙いやすくする）
    return Math.min(...g.parts.map((part) => pathDistance(part.points, p, true)));
  }
  if (g.type === GeomType.LineString) return Math.min(Infinity, ...g.parts.map((part) => pathDistance(part.points, p, false)));
  return Math.min(Infinity, ...g.parts.flatMap((part) => part.points.map(([x, y]) => Math.hypot(x - p[0], y - p[1]))));
}

/** even-odd の点包含判定 */
function inRing(ring: readonly Point[], [px, py]: Point): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pathDistance(pts: readonly Point[], p: Point, closed: boolean): number {
  if (pts.length === 1) return Math.hypot(pts[0]![0] - p[0], pts[0]![1] - p[1]);
  let d = Infinity;
  const n = closed ? pts.length : pts.length - 1;
  for (let i = 0; i < n; i++) d = Math.min(d, segDistance(pts[i]!, pts[(i + 1) % pts.length]!, p));
  return d;
}

function segDistance([ax, ay]: Point, [bx, by]: Point, [px, py]: Point): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(ax + t * dx - px, ay + t * dy - py);
}

function polygonArea(g: DecodedGeometry): number {
  return g.parts.reduce((a, p) => a + (p.area ?? 0), 0);
}
