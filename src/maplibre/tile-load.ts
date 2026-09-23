import type { PmtilesArchive } from "../core/pmtiles/archive";
import { TileType } from "../core/pmtiles/enums";

export interface MapTileResult {
  bytes: Uint8Array | null;
  /** archive にタイルがあったか。無いタイルは directory を引くだけで分かり、tile data の read は起きない */
  found: boolean;
}

/**
 * MapLibre が要求した 1 タイルを、自前の PmtilesArchive で取り出す（公式 Protocol の tilev4 に相当）。
 *
 * MapLibre に依存しない純粋な関数にしておき、公式 getZxy との比較テストを node で回せるようにする。
 * read には initiator "map" を付けるので、地図描画のための read は Read Trace 上で Tile Trace の read と区別できる。
 *
 * 見つからないタイルの返し方は公式 Protocol に合わせる:
 * vector（MVT / MLT）は空の bytes（= feature 0 個のタイル）、raster は null（= そのタイルは描かない）。
 */
export async function loadTileForMap(archive: PmtilesArchive, z: number, x: number, y: number, signal?: AbortSignal): Promise<MapTileResult> {
  const lookup = await archive.lookupTile(z, x, y, { initiator: "map" });
  signal?.throwIfAborted();
  const r = lookup.result;
  if (r.status === "error") throw new Error(r.message);
  if (r.status !== "found") return { bytes: isVector(archive.header.tileType) ? new Uint8Array() : null, found: false };

  const tile = await archive.readTileData(r, `map ${z}/${x}/${y}`, { initiator: "map", signal });
  // MapLibre は解凍済みの bytes を期待する。解凍できないタイルを raw のまま渡すと壊れたタイルとして描かれるので、失敗として返す
  if (!tile.payload) throw new Error(tile.decompressError ?? "Tile Compression を展開できませんでした");
  return { bytes: tile.payload, found: true };
}

export function isVector(tileType: number): boolean {
  return tileType === TileType.Mvt || tileType === TileType.Mlt;
}
