import type { DirectoryRecord, PmtilesArchive } from "../core/pmtiles/archive";
import { floorEntryIndex } from "../core/pmtiles/lookup";

/**
 * Hilbert Viewer の 1 マスが「どの directory の担当か」。
 *
 * - tile      : tile entry の run の範囲内 → タイルがある
 * - miss      : 読み込み済みの leaf の担当範囲内だが、tile entry が無い → タイルは無い
 * - unloaded  : 担当する leaf は分かるが、まだ読んでいない → 有無は未確認
 * - none      : root の段階で候補が無い / root の tile entry の範囲外 → タイルは無い
 *
 * I/O はしない（読み込み済みの leaf だけを peek する）。数万マスを一度に分類するため、
 * 「未読なら未読のまま見せる」ことで、leaf を読まないと分からない情報があることも伝える。
 */
export interface TileClass {
  state: "tile" | "miss" | "unloaded" | "none";
  /** root → leaf → … と辿った entry の連なり。tooltip で「Root entry #3 → Leaf entry #120」と示すのに使う */
  path: { dir: DirectoryRecord; index: number }[];
  /** 色分けの単位。root の leaf entry の何番目の leaf か（root の tile entry なら -1） */
  region: number;
}

const MAX_DEPTH = 4;

export function classifyTile(archive: PmtilesArchive, tileId: number, leafOrdinal: Map<number, number>): TileClass {
  const path: TileClass["path"] = [];
  let dir = archive.root;
  for (let depth = 0; depth < MAX_DEPTH; depth++) {
    const entries = dir.decoded.entries;
    const i = floorEntryIndex(entries, tileId);
    if (i < 0) return { state: depth === 0 ? "none" : "miss", path, region: regionOf(path, leafOrdinal) };
    path.push({ dir, index: i });
    const e = entries[i]!;
    if (e.runLength > 0) {
      const state = tileId - e.tileId < e.runLength ? "tile" : depth === 0 ? "none" : "miss";
      return { state, path, region: regionOf(path, leafOrdinal) };
    }
    const leaf = archive.peekLeafDirectory(e);
    if (!leaf) return { state: "unloaded", path, region: regionOf(path, leafOrdinal) };
    dir = leaf;
  }
  return { state: "unloaded", path, region: regionOf(path, leafOrdinal) };
}

/** root の entry index → 何番目の leaf entry か。色を leaf の並び順で固定するため（entry index だと飛び飛びになる） */
export function rootLeafOrdinals(archive: PmtilesArchive): Map<number, number> {
  const m = new Map<number, number>();
  archive.root.decoded.entries.forEach((e, i) => {
    if (e.runLength === 0) m.set(i, m.size);
  });
  return m;
}

function regionOf(path: TileClass["path"], leafOrdinal: Map<number, number>): number {
  const first = path[0];
  if (!first) return -1;
  return leafOrdinal.get(first.index) ?? -1;
}
