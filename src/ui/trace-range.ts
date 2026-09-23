import { entryTileIdRange } from "../core/pmtiles/lookup";
import type { AppState } from "./state";
import { buildTraceSteps, directoryStepAt } from "./trace-steps";

/**
 * 今の Trace 段が注目している TileID の区間。
 * - z/x/y 〜 TileID の段: そのタイル 1 つ
 * - directory 探索の段: 候補 entry が担当する区間（leaf なら leaf 全体、tile なら run）
 * - Tile Entry 以降の段: 最後に見つけた tile entry の run
 */
export function traceRange(s: AppState): { start: number; end: number } | undefined {
  const t = s.trace;
  if (!t) return undefined;
  const steps = buildTraceSteps(t.lookup);
  const cur = steps[t.step];
  if (!cur) return undefined;
  // directory に入る前の段だけがタイル 1 つ。探索以降（Physical Read の段を含む）は最後に辿った entry の担当区間を見せ続ける
  if (cur.kind === "zxy" || cur.kind === "hilbert" || cur.kind === "tileid" || cur.kind === "zoom-check") {
    return { start: t.lookup.address.tileId, end: t.lookup.address.tileId + 1 };
  }
  const ds = directoryStepAt(steps, t.step);
  if (!ds) return undefined;
  // 親 directory から受け継いだ上限。leaf の最後の entry の担当範囲を正しく閉じるため、root から順に絞り込む
  let upper = Infinity;
  for (const s2 of steps.slice(0, ds.index + 1)) {
    if (s2.kind !== "directory") continue;
    const ci = s2.step.search.candidateIndex;
    if (ci === undefined) return undefined;
    const r = entryTileIdRange(s2.step.directory.decoded.entries, ci, upper);
    if (s2 === steps[ds.index]) return s2.step.search.outcome === "outside-run" ? undefined : r;
    upper = r.end;
  }
  return undefined;
}
