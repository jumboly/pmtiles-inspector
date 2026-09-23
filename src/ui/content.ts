import type { TileRead } from "../core/pmtiles/archive";
import { TileType, tileTypeName } from "../core/pmtiles/enums";
import { inspectMvt, type MvtTile } from "../tile-inspector/mvt/decode";
import { cachedGeometry } from "../tile-inspector/mvt/hit-test";
import { inspectRaster, type RasterFormat, type RasterInfo } from "../tile-inspector/raster/inspect";
import { sniff, type SniffKind } from "../tile-inspector/raw/sniff";

/**
 * Tile Payload をどの Content Inspector に渡すかを決め、結果を持つ。
 *
 * inspector（tile-inspector/）は bytes しか受け取らないので、「Header がこの Tile Type を宣言している」
 * 「中身の magic はこう見える」という PMTiles 側の事情を突き合わせるのは Viewer のこの層の役目。
 * 選び方は Header の宣言を優先する（解凍と同じく、推定で方式を変えない）。宣言が unknown のときだけ中身から推定する。
 */
export type ContentResult =
  | { kind: "mvt"; mvt: MvtTile; geometry: ReturnType<typeof cachedGeometry>; why: string; bytes: Uint8Array }
  | { kind: "raster"; info: RasterInfo; mime: string; why: string; bytes: Uint8Array }
  | { kind: "raw"; why: string; bytes: Uint8Array; payload: boolean };

const RASTER: Partial<Record<number, RasterFormat>> = {
  [TileType.Png]: "png",
  [TileType.Jpeg]: "jpeg",
  [TileType.Webp]: "webp",
  [TileType.Avif]: "avif",
};
const MIME: Record<RasterFormat, string> = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp", avif: "image/avif" };

export function inspectContent(tileType: number, tile: TileRead): ContentResult {
  const bytes = tile.payload;
  if (!bytes) return { kind: "raw", why: `Tile Decompression に失敗したので、ファイル上の bytes をそのまま見せる（${tile.decompressError ?? ""}）`, bytes: tile.raw, payload: false };
  const declared = tileTypeName(tileType);
  const sn = sniff(bytes);

  let target: "mvt" | RasterFormat | undefined;
  let why: string;
  if (tileType === TileType.Unknown) {
    target = sn.kind === "mvt-like" ? "mvt" : isRaster(sn.kind) ? sn.kind : undefined;
    why = `Header の Tile Type が unknown なので、中身の先頭 bytes（${sn.kind}）から選んだ`;
  } else if (tileType === TileType.Mvt) {
    target = "mvt";
    why = `Header の Tile Type = ${declared}`;
  } else if (RASTER[tileType]) {
    target = RASTER[tileType];
    why = `Header の Tile Type = ${declared}`;
  } else if (tileType === TileType.Mlt) {
    return { kind: "raw", why: "Tile Type = mlt。MLT の Inspector は Phase 8 で扱う（MVT との構造比較として）", bytes, payload: true };
  } else {
    return { kind: "raw", why: `Tile Type ${tileType} は spec に無い値`, bytes, payload: true };
  }
  if (!target) return { kind: "raw", why: `${why}が、対応する Inspector が無い`, bytes, payload: true };

  if (target === "mvt") {
    const mvt = inspectMvt(bytes);
    // layer が 1 つも読めなければ MVT ではなかったとみなす（読めた layer があれば、壊れていても MVT Inspector で見せる）
    if (!mvt.layers.length && (mvt.error || bytes.length)) {
      return { kind: "raw", why: `${why}だが、MVT として読めない（${mvt.error?.message ?? "layer が無い"}。先頭 bytes は ${sn.kind} に見える）`, bytes, payload: true };
    }
    return { kind: "mvt", mvt, geometry: cachedGeometry(), why, bytes };
  }
  // 宣言と中身の形式が違えば header の解析は無意味なので Raw に落とす（leaf_z8 は png を名乗る text）
  if (sn.kind !== target) return { kind: "raw", why: `${why}だが、先頭 bytes は ${sn.kind} に見える（${sn.reason}）`, bytes, payload: true };
  return { kind: "raster", info: inspectRaster(bytes, target), mime: MIME[target], why, bytes };
}

function isRaster(k: SniffKind): k is RasterFormat {
  return k === "png" || k === "jpeg" || k === "webp" || k === "avif";
}

export function contentSummary(c: ContentResult): string {
  if (c.kind === "mvt") {
    const features = c.mvt.layers.reduce((a, l) => a + l.features.length, 0);
    return `MVT · ${c.mvt.layers.length} layer · ${features} feature`;
  }
  if (c.kind === "raster") return `${c.info.format.toUpperCase()} ${c.info.width ?? "?"}×${c.info.height ?? "?"}`;
  return "Raw";
}
