import type { LookupStep } from "../../core/pmtiles/archive";
import type { SearchStep } from "../../core/pmtiles/lookup";
import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { num } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { buildTraceSteps, directoryStepAt } from "../trace-steps";

type DirStep = Extract<LookupStep, { kind: "directory" }>;

/** 候補の前後に何 entry 見せるか。target が「どの 2 つの entry の間に落ちたか」が分かれば足りる */
const NEIGHBORS = 3;

/**
 * Tile Trace の今の段で行っている binary search を再生する。
 *
 * 公式 findTile は「target 以下で最大の tileId を持つ entry」を探し、その entry だけで判定する。
 * 表示もこの 2 段（探索 → 判定）に分け、判定が entry の RunLength だけで決まることを見せる。
 */
export function mountSearchViewer(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  store.subscribe((s, prev) => {
    if (s.trace !== prev.trace || s.archive !== prev.archive) render(s);
  });

  function render(s: AppState) {
    const t = s.trace;
    if (!s.archive || !t) {
      replaceChildren(el, h("p", { class: "empty" }, "Tile Trace を実行すると、TileID から Directory Entry を探す binary search の過程をここに表示します。"));
      return;
    }
    const steps = buildTraceSteps(t.lookup);
    const cur = steps[t.step]!;
    const ds = directoryStepAt(steps, t.step);
    if (!ds) {
      const firstDir = steps.findIndex((x) => x.kind === "directory");
      replaceChildren(
        el,
        h(
          "p",
          { class: "empty" },
          firstDir < 0
            ? "この Trace は directory を探索する前に終わりました（ズーム範囲外）。"
            : "まだ directory を探索する前の段です。",
        ),
        firstDir >= 0 ? h("button", { onclick: () => ctl.traceStep(firstDir) }, "Root search の段へ ▸") : null,
      );
      return;
    }
    const allDirSteps = steps.flatMap((x, i) => (x.kind === "directory" ? [{ i, step: x.step }] : []));
    replaceChildren(
      el,
      // Root / Leaf どちらの探索かを切り替えられるようにする（Trace の段を移動するのと同じ）
      allDirSteps.length > 1
        ? h(
            "div",
            { class: "seg-tabs" },
            allDirSteps.map((d) =>
              h(
                "button",
                { class: d.i === ds.index ? "on" : "", onclick: () => ctl.traceStep(d.i) },
                d.step.directory.kind === "root" ? "Root" : `Leaf（深さ ${d.step.depth}）`,
              ),
            ),
          )
        : null,
      cur.kind !== "directory" ? h("p", { class: "note" }, "（結果の段なので、最後に行った探索を表示しています）") : null,
      searchView(ds.step),
    );
  }
}

function searchView(step: DirStep) {
  const { search, directory } = step;
  const entries = directory.decoded.entries;
  const n = entries.length;
  const where = directory.kind === "root" ? "Root Directory" : `Leaf Directory（深さ ${step.depth}）`;
  const obtained =
    step.obtainedBy === "first-read"
      ? `先頭 16 KiB の READ #${directory.readId ?? "?"} に含まれていた → 追加の I/O なし`
      : step.obtainedBy === "cache"
        ? `以前 READ #${directory.readId ?? "?"} で読んだものを再利用 → 追加の I/O なし`
        : `この探索のために READ #${directory.readId ?? "?"} で読んだ`;

  return h(
    "div",
    { class: "search" },
    h(
      "dl",
      { class: "addr-dl" },
      h("dt", {}, "探す TileID"),
      h("dd", { class: "mono strong" }, num(search.target)),
      h("dt", {}, "探す場所"),
      h("dd", {}, `${where} · ${num(n)} entries（TileID 昇順）`),
      h("dt", {}, "取得"),
      h("dd", {}, obtained),
    ),
    h("h3", {}, "1. binary search", h("span", { class: "dim" }, `target 以下で最大の TileID を持つ entry を探す · ${search.steps.length} 回の比較（${num(n)} entries なら最大 ${Math.ceil(Math.log2(n + 1))} 回）`)),
    n === 0 ? h("p", { class: "note" }, "entry が 0 個なので探索できません。") : stepsTable(search.steps, n, search.target),
    h("h3", {}, "2. 候補 entry の前後"),
    neighborhood(step),
    h("h3", {}, "3. 判定"),
    judgement(step),
  );
}

function stepsTable(steps: SearchStep[], n: number, target: number) {
  return h(
    "table",
    { class: "search-steps" },
    h("thead", {}, h("tr", {}, ["#", "探索範囲 [low, high]", "mid", "entries[mid].TileID", "比較", "次の範囲"].map((x) => h("th", {}, x)))),
    h(
      "tbody",
      {},
      steps.map((s, i) => {
        const next =
          s.comparison === "target-greater" ? `low = ${s.mid + 1}` : s.comparison === "target-less" ? `high = ${s.mid - 1}` : "一致 → 終了";
        const cmp =
          s.comparison === "target-greater"
            ? `${num(target)} > ${num(s.midTileId)}`
            : s.comparison === "target-less"
              ? `${num(target)} < ${num(s.midTileId)}`
              : `${num(target)} = ${num(s.midTileId)}`;
        return h(
          "tr",
          {},
          h("td", { class: "mono dim" }, i + 1),
          h(
            "td",
            {},
            h("div", { class: "mono" }, `[${num(s.low)}, ${num(s.high)}]`, h("span", { class: "dim" }, ` 残り ${num(s.high - s.low + 1)}`)),
            rangeBar(s, n),
          ),
          h("td", { class: "mono" }, num(s.mid)),
          h("td", { class: "mono" }, num(s.midTileId)),
          h("td", { class: `mono cmp-${s.comparison}` }, cmp),
          h("td", { class: "mono dim" }, next),
        );
      }),
    ),
  );
}

/** entries 全体を 1 本の帯にし、探索範囲と mid の位置を描く。範囲が毎回半分になることを目で見せる */
function rangeBar(s: SearchStep, n: number) {
  const pct = (i: number) => (i / n) * 100;
  return h(
    "div",
    { class: "range-bar" },
    h("div", { class: "range-live", style: `left:${pct(s.low)}%;width:max(2px, ${pct(s.high - s.low + 1)}%)` }),
    h("div", { class: "range-mid", style: `left:${pct(s.mid + 0.5)}%` }),
  );
}

function neighborhood(step: DirStep) {
  const { search, directory } = step;
  const entries = directory.decoded.entries;
  const c = search.candidateIndex ?? -1;
  // before-first のときは先頭の手前に target を置く
  const from = Math.max(0, c - NEIGHBORS);
  const to = Math.min(entries.length - 1, Math.max(c, 0) + NEIGHBORS);
  const rows: HTMLElement[] = [];
  const targetRow = h(
    "tr",
    { class: "target-row" },
    h("td", {}, ""),
    h("td", { class: "mono", colspan: 4 }, `▶ target ${num(search.target)} はここに落ちる`),
  );
  if (c < 0) rows.push(targetRow);
  for (let i = from; i <= to; i++) {
    const e = entries[i]!;
    const range = e.runLength > 0 ? `${num(e.tileId)}〜${num(e.tileId + e.runLength - 1)}` : `${num(e.tileId)}〜（次の entry の手前まで）`;
    rows.push(
      h(
        "tr",
        { class: `${i === c ? "selected" : ""}${e.runLength === 0 ? " leaf-row" : ""}` },
        h("td", { class: "mono dim" }, `#${num(i)}`),
        h("td", { class: "mono" }, num(e.tileId)),
        h("td", { class: "mono" }, e.runLength),
        h("td", { class: "mono" }, e.runLength === 0 ? "leaf" : e.runLength > 1 ? `tile ×${num(e.runLength)}` : "tile"),
        h("td", { class: "mono dim" }, range),
      ),
    );
    // 完全一致なら target は entry 自身の行。そうでなければ候補の直後に落ちる
    if (i === c && search.outcome !== "exact-tile" && search.outcome !== "exact-leaf") rows.push(targetRow);
  }
  return h(
    "table",
    { class: "search-neigh" },
    h("thead", {}, h("tr", {}, ["#", "TileID", "RunLength", "種類", "担当する TileID"].map((x) => h("th", {}, x)))),
    h("tbody", {}, rows),
  );
}

function judgement(step: DirStep) {
  const { search, directory } = step;
  const c = search.candidateIndex;
  if (c === undefined) {
    return h(
      "div",
      { class: "judge" },
      h("div", { class: "rule on" }, `target ${num(search.target)} は先頭 entry の TileID ${num(directory.decoded.entries[0]?.tileId ?? 0)} より小さい → 候補なし → タイルは存在しない`),
    );
  }
  const e = directory.decoded.entries[c]!;
  const d = search.target - e.tileId;
  const o = search.outcome;
  const isLeaf = e.runLength === 0;
  const hit = !isLeaf && d < e.runLength;
  return h(
    "div",
    { class: "judge" },
    h("div", { class: "mono" }, `候補 entry #${num(c)}: TileID ${num(e.tileId)} / RunLength ${e.runLength} / Offset ${num(e.offset)} / Length ${num(e.length)}`),
    h(
      "div",
      { class: `rule${isLeaf ? " on" : ""}` },
      h("b", {}, "RunLength == 0"),
      ` → Leaf Directory。その leaf の中を同じ TileID で探し直す`,
      isLeaf ? h("span", { class: "verdict" }, ` ← 該当（RunLength = 0）`) : null,
    ),
    h(
      "div",
      { class: `rule${hit ? " on" : ""}` },
      h("b", {}, "target − TileID < RunLength"),
      " → tile hit",
      !isLeaf ? h("span", { class: "mono" }, `（${num(search.target)} − ${num(e.tileId)} = ${num(d)} ${hit ? "<" : "≥"} ${e.runLength}）`) : null,
      hit ? h("span", { class: "verdict" }, ` ← 該当${e.runLength > 1 ? `（run の ${d + 1} 番目。run 内のタイルはすべて同じ bytes を共有）` : ""}`) : null,
    ),
    h(
      "div",
      { class: `rule${o === "outside-run" ? " on" : ""}` },
      h("b", {}, "それ以外"),
      " → not found（候補の run が target まで届いていない）",
      o === "outside-run" ? h("span", { class: "verdict" }, " ← 該当") : null,
    ),
    isLeaf
      ? h("p", { class: "note" }, "leaf entry は終端を持たないので範囲チェックをしない（担当は次の entry の TileID の手前まで）。公式 findTile も同じ。")
      : null,
  );
}
