/**
 * PMTiles v3 spec (v3.6 時点, 2026-09 確認) の enum。
 * 値は spec §3.2 Tile Type / §3.3 Compression に一致させている。
 *
 * number のまま扱い、名前は lookup で引く。未知の値でも parser を失敗させず
 * 「未知の値 0x07」として表示できるようにするため（将来の spec 拡張への耐性）。
 */

export const Compression = {
  Unknown: 0,
  None: 1,
  Gzip: 2,
  Brotli: 3,
  Zstd: 4,
} as const;
export type Compression = number;

export const TileType = {
  Unknown: 0,
  Mvt: 1,
  Png: 2,
  Jpeg: 3,
  Webp: 4,
  Avif: 5,
  /** MapLibre Vector Tile (spec v3.5 で追加) */
  Mlt: 6,
} as const;
export type TileType = number;

const COMPRESSION_NAMES: Record<number, string> = {
  0: "unknown",
  1: "none",
  2: "gzip",
  3: "brotli",
  4: "zstd",
};

const TILE_TYPE_NAMES: Record<number, string> = {
  0: "unknown/other",
  1: "mvt",
  2: "png",
  3: "jpeg",
  4: "webp",
  5: "avif",
  6: "mlt",
};

export function compressionName(c: number): string {
  return COMPRESSION_NAMES[c] ?? `undefined(0x${c.toString(16).padStart(2, "0")})`;
}

export function tileTypeName(t: number): string {
  return TILE_TYPE_NAMES[t] ?? `undefined(0x${t.toString(16).padStart(2, "0")})`;
}
