import type { Entry } from "./directory";

/** binary search の 1 反復。Directory Search Viewer で midpoint の移動を再生するための記録 */
export interface SearchStep {
  low: number;
  high: number;
  mid: number;
  midTileId: number;
  /** target と entries[mid].tileId の比較結果 */
  comparison: "target-greater" | "target-less" | "equal";
}

/**
 * 探索の結論。公式 findTile の分岐と 1 対 1 に対応させている。
 * - exact-tile     : TileID が完全一致し、その entry は tile を指す
 * - exact-leaf     : TileID が完全一致し、その entry は leaf directory を指す (runLength=0)
 * - leaf           : 一致なし。直前の候補が leaf を指すので、その leaf の中を探しに行く
 * - run-hit        : 一致なし。直前の候補の run (tileId .. tileId+runLength-1) の範囲内
 * - outside-run    : 一致なし。直前の候補の run の範囲外 → タイルは存在しない
 * - before-first   : target が先頭 entry より小さい → 存在しない
 */
export type SearchOutcome = "exact-tile" | "exact-leaf" | "leaf" | "run-hit" | "outside-run" | "before-first";

export interface SearchTrace {
  target: number;
  steps: SearchStep[];
  /** 探索終了時に候補として調べた entry の index（before-first の場合は無し） */
  candidateIndex?: number;
  outcome: SearchOutcome;
  /** 見つかった entry（tile か leaf）。存在しない場合 undefined */
  entry?: Entry;
}

/**
 * Directory から TileID を探す（公式 findTile の再現 + 過程の記録）。
 *
 * binary search で「target 以下で最大の tileId を持つ entry」を求め、その entry について
 * leaf か / run の範囲内か を判定する。
 * 注意: leaf entry の場合は範囲チェックをしない（leaf の担当範囲は「次の entry の tileId まで」であり、
 * entry 自体は終端を持たないため）。これは公式実装と同じ。
 */
export function findTileTraced(entries: readonly Entry[], target: number): SearchTrace {
  const steps: SearchStep[] = [];
  let low = 0;
  let high = entries.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const e = entries[mid]!;
    const cmp = target - e.tileId;
    if (cmp > 0) {
      steps.push({ low, high, mid, midTileId: e.tileId, comparison: "target-greater" });
      low = mid + 1;
    } else if (cmp < 0) {
      steps.push({ low, high, mid, midTileId: e.tileId, comparison: "target-less" });
      high = mid - 1;
    } else {
      steps.push({ low, high, mid, midTileId: e.tileId, comparison: "equal" });
      return {
        target,
        steps,
        candidateIndex: mid,
        outcome: e.runLength === 0 ? "exact-leaf" : "exact-tile",
        entry: e,
      };
    }
  }

  // ループを抜けた時点で high は「target より小さい最大の tileId を持つ entry」の index
  if (high < 0) return { target, steps, outcome: "before-first" };
  const c = entries[high]!;
  if (c.runLength === 0) {
    return { target, steps, candidateIndex: high, outcome: "leaf", entry: c };
  }
  if (target - c.tileId < c.runLength) {
    return { target, steps, candidateIndex: high, outcome: "run-hit", entry: c };
  }
  return { target, steps, candidateIndex: high, outcome: "outside-run" };
}
