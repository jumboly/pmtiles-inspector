import type { PmtilesArchive, TileRead } from "../core/pmtiles/archive";
import type { TraceView } from "./state";
import { buildTraceSteps, isPhysicalStep } from "./trace-steps";

/**
 * 今の Trace が「今の段まで」に使った READ 番号。
 * File Layout と Read Trace で、全 read のうちどれがこのタイルのためのものかを強調するのに使う。
 * 段に合わせて増えるので、Next を押すたびに「ここでこの read が効いた」が見える。
 */
export function traceReadIds(trace: TraceView | undefined): Set<number> {
  const ids = new Set<number>();
  if (!trace) return ids;
  const steps = buildTraceSteps(trace.lookup);
  for (const s of steps.slice(0, trace.step + 1)) {
    if (s.kind === "directory" && s.step.directory.readId !== undefined) ids.add(s.step.directory.readId);
    if (isPhysicalStep(s) && trace.tile?.readId !== undefined) ids.add(trace.tile.readId);
  }
  return ids;
}

export interface BudgetRow {
  label: string;
  readId?: number;
  bytes: number;
  /**
   * open = archive を開いたときの read を共有（タイルごとには発生しない） /
   * read = この Trace で I/O した / cache = 以前の read を再利用（この Trace では 0 byte）
   */
  how: "open" | "read" | "cache";
}

/**
 * 1 タイルを得るために必要だった read の内訳。
 * 「cold（何も持っていない状態）なら何 byte 要るか」と「この Trace で実際に増えた I/O」を分けて示すため、
 * cache で済んだ leaf も元の read のサイズ付きで行に残す。
 */
export function traceBudget(archive: PmtilesArchive, trace: TraceView, tile: TileRead | undefined): BudgetRow[] {
  const rows: BudgetRow[] = [];
  for (const s of trace.lookup.steps) {
    if (s.kind !== "directory") continue;
    const d = s.directory;
    if (d.kind === "root") {
      rows.push(
        s.obtainedBy === "first-read"
          ? { label: "Header + Root Directory（先頭 16 KiB）", readId: archive.firstRead.readId, bytes: archive.firstRead.bytes.length, how: "open" }
          : { label: "Root Directory（16 KiB の外: spec 違反）", readId: d.readId, bytes: d.compressedLength, how: "open" },
      );
    } else {
      rows.push({ label: `Leaf Directory（深さ ${s.depth}）`, readId: d.readId, bytes: d.compressedLength, how: s.obtainedBy === "cache" ? "cache" : "read" });
    }
  }
  if (tile) rows.push({ label: "Tile Data", readId: tile.readId, bytes: tile.raw.length, how: "read" });
  return rows;
}
