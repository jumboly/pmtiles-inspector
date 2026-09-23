import type { LookupStep, TileLookup } from "../core/pmtiles/archive";

/**
 * Tile Trace の画面上の 1 段。
 *
 * core の LookupStep は「計算の単位」で、address ステップ 1 つに Hilbert index と TileID の両方が入っている。
 * 画面では z/x/y → Hilbert position → Global TileID を別々の段として見せたいので、ここで段に展開する。
 */
export type UiTraceStep =
  | { kind: "zxy" }
  | { kind: "hilbert" }
  | { kind: "tileid" }
  | { kind: "zoom-check"; step: Extract<LookupStep, { kind: "zoom-check" }> }
  | { kind: "directory"; step: Extract<LookupStep, { kind: "directory" }> }
  | { kind: "result" };

export function buildTraceSteps(lookup: TileLookup): UiTraceStep[] {
  const out: UiTraceStep[] = [];
  for (const s of lookup.steps) {
    if (s.kind === "address") out.push({ kind: "zxy" }, { kind: "hilbert" }, { kind: "tileid" });
    else if (s.kind === "zoom-check") out.push({ kind: "zoom-check", step: s });
    else out.push({ kind: "directory", step: s });
  }
  out.push({ kind: "result" });
  return out;
}

export function stepTitle(s: UiTraceStep, lookup: TileLookup): string {
  switch (s.kind) {
    case "zxy":
      return "z / x / y";
    case "hilbert":
      return "Hilbert position";
    case "tileid":
      return "Global TileID";
    case "zoom-check":
      return "Zoom 範囲";
    case "directory":
      return s.step.directory.kind === "root" ? "Root search" : `Leaf search${s.step.depth > 1 ? ` (深さ ${s.step.depth})` : ""}`;
    case "result":
      return lookup.result.status === "found" ? "Tile Entry" : "結果";
  }
}

/**
 * 画面上の段 index に対応する directory ステップ。
 * directory 以外の段では、それまでに通った最後の directory（結果の段なら最後の探索）を返す。
 */
export function directoryStepAt(steps: UiTraceStep[], index: number) {
  for (let i = Math.min(index, steps.length - 1); i >= 0; i--) {
    const s = steps[i]!;
    if (s.kind === "directory") return { index: i, step: s.step };
  }
  return undefined;
}
