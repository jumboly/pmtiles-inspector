import type { PmtilesArchive, TileLookup } from "../../core/pmtiles/archive";
import { MAX_ZOOM, tileIdToZxy } from "../../core/pmtiles/tileid";
import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { num, rangeText, size } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { buildTraceSteps, stepTitle, type UiTraceStep } from "../trace-steps";

/**
 * Tile Trace: z/x/y から Tile Entry までを段ごとに追う。
 *
 * 各段で「入力 → 出力」と「どの bytes / どの READ を使ったか」を示す。
 * 段を動かすと controller が selection を更新し、Hilbert / Directory Search / Directory / File Layout が連動する。
 */
export function mountTileTrace(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  const form = h("form", { class: "trace-form" });
  const zIn = numInput("z", 0, MAX_ZOOM);
  const xIn = numInput("x", 0);
  const yIn = numInput("y", 0);
  const idIn = numInput("TileID", 0);
  const view = h("div", {});

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void ctl.traceTile(Number(zIn.value), Number(xIn.value), Number(yIn.value));
  });
  const fromTileId = () => {
    try {
      const a = tileIdToZxy(Number(idIn.value));
      void ctl.traceTile(a.z, a.x, a.y);
    } catch (e) {
      store.set({ traceError: e instanceof Error ? e.message : String(e) });
    }
  };
  replaceChildren(
    form,
    h("label", {}, "z ", zIn),
    h("label", {}, "x ", xIn),
    h("label", {}, "y ", yIn),
    h("button", { type: "submit", class: "primary" }, "Trace"),
    h("span", { class: "dim" }, "または"),
    h("label", {}, "TileID ", idIn),
    h("button", { type: "button", onclick: fromTileId }, "TileID から"),
    h("button", { type: "button", onclick: () => randomExisting(store.get(), ctl) }, "存在するタイルをランダムに"),
  );

  store.subscribe((s, prev) => {
    if (s.archive !== prev.archive || s.trace !== prev.trace || s.traceLoading !== prev.traceLoading || s.traceError !== prev.traceError || s.tracePlaying !== prev.tracePlaying) render(s);
  });

  function render(s: AppState) {
    if (!s.archive) {
      replaceChildren(el, h("p", { class: "empty" }, "z/x/y を指定すると、Hilbert position → TileID → Root / Leaf の探索 → Tile Entry までを 1 段ずつ追えます。"));
      return;
    }
    const t = s.trace;
    if (t) {
      // 入力欄は「今 Trace しているタイル」に合わせる（Hilbert Viewer のクリックから始めた場合も値が見えるように）
      zIn.value = String(t.lookup.address.z);
      xIn.value = String(t.lookup.address.x);
      yIn.value = String(t.lookup.address.y);
      idIn.value = String(t.lookup.address.tileId);
    }
    replaceChildren(
      view,
      s.traceLoading ? h("p", { class: "note" }, s.traceLoading) : null,
      s.traceError ? h("p", { class: "error" }, s.traceError) : null,
      t ? traceView(s.archive, t.lookup, t.step, !!s.tracePlaying, ctl) : h("p", { class: "note" }, "Hilbert Viewer のマスをクリックしても始められます。"),
    );
    if (!el.contains(form)) replaceChildren(el, form, view);
  }
}

function traceView(archive: PmtilesArchive, lookup: TileLookup, current: number, playing: boolean, ctl: Controller) {
  const steps = buildTraceSteps(lookup);
  const last = steps.length - 1;
  return h(
    "div",
    {},
    h(
      "div",
      { class: "trace-nav" },
      h("button", { onclick: () => ctl.traceStep(current - 1), disabled: current === 0 }, "◀ Previous"),
      h("button", { onclick: () => ctl.traceStep(current + 1), disabled: current === last }, "Next ▶"),
      playing ? h("button", { onclick: () => ctl.stopTrace() }, "■ Stop") : h("button", { onclick: () => ctl.playTrace() }, "▶ Auto（最初から）"),
      h("span", { class: "dim mono" }, `${current + 1} / ${steps.length}`),
    ),
    h(
      "ol",
      { class: "trace-steps" },
      steps.map((s, i) =>
        h(
          "li",
          {},
          i > 0 ? h("span", { class: "arrow" }, "→") : null,
          h(
            "button",
            { class: `trace-step ${i === current ? "current" : i < current ? "done" : "todo"} k-${s.kind}`, onclick: () => ctl.traceStep(i) },
            h("b", {}, stepTitle(s, lookup)),
            h("span", {}, stepOutput(s, lookup)),
          ),
        ),
      ),
    ),
    stepDetail(archive, steps[current]!, lookup),
  );
}

/** 段のチップに出す短い出力値 */
function stepOutput(s: UiTraceStep, lookup: TileLookup): string {
  const a = lookup.address;
  switch (s.kind) {
    case "zxy":
      return `${a.z}/${a.x}/${a.y}`;
    case "hilbert":
      return `d = ${num(a.hilbertIndex)}`;
    case "tileid":
      return num(a.tileId);
    case "zoom-check":
      return s.step.inRange ? `${s.step.minZoom}〜${s.step.maxZoom} 内` : "範囲外";
    case "directory": {
      const r = s.step.search;
      return r.candidateIndex === undefined ? "候補なし" : `entry #${num(r.candidateIndex)} · ${OUTCOME_SHORT[r.outcome]}`;
    }
    case "result": {
      const r = lookup.result;
      return r.status === "found" ? `${size(r.length)} @ ${num(r.fileOffset)}` : RESULT_SHORT[r.status];
    }
  }
}

const OUTCOME_SHORT = {
  "exact-tile": "tile hit",
  "run-hit": "tile hit",
  "exact-leaf": "→ leaf",
  leaf: "→ leaf",
  "outside-run": "not found",
  "before-first": "not found",
} as const;

const RESULT_SHORT = { "not-found": "タイル無し", "out-of-zoom": "ズーム範囲外", error: "エラー" } as const;

function stepDetail(archive: PmtilesArchive, s: UiTraceStep, lookup: TileLookup) {
  const a = lookup.address;
  const hd = archive.header;
  const box = (title: string, ...body: (HTMLElement | string | null)[]) => h("div", { class: "trace-detail" }, h("div", { class: "tree-title" }, title), ...body);
  const io = (input: string, output: string) => h("div", { class: "io mono" }, h("span", {}, input), h("span", { class: "arrow" }, "⇒"), h("b", {}, output));

  switch (s.kind) {
    case "zxy":
      return box(
        "入力: タイル座標",
        io("z / x / y", `${a.z} / ${a.x} / ${a.y}`),
        h("p", {}, `ズーム z = ${a.z} の世界は ${num(2 ** a.z)} × ${num(2 ** a.z)} のタイルに分かれる。x は西 → 東、y は北 → 南（y = 0 が北端）。`),
        h("p", { class: "dim" }, "ファイルはまだ一切参照していない。ここから TileID を計算するまでは純粋な計算だけ。"),
      );
    case "hilbert":
      return box(
        "Hilbert position（ズーム内の順番）",
        io(`xy2d(z=${a.z}, x=${a.x}, y=${a.y})`, `d = ${num(a.hilbertIndex)}`),
        h("p", {}, `ズーム ${a.z} の ${num(4 ** a.z)} マスを Hilbert 曲線で一筆書きしたときの順番。ズームごとに 0 から数え直す値なので、これだけでは TileID ではない。`),
        h("p", { class: "dim" }, "Hilbert 曲線は近いマスを近い順番で通るので、地理的に近いタイルは d も近くなりやすい（Hilbert Viewer の曲線を参照）。"),
      );
    case "tileid":
      return box(
        "Global TileID（全ズーム通しの番号）",
        io(`zoomBase(${a.z}) + d = (4^${a.z} − 1) / 3 + ${num(a.hilbertIndex)}`, `${num(a.zoomBase)} + ${num(a.hilbertIndex)} = ${num(a.tileId)}`),
        h("p", {}, `zoomBase(${a.z}) = ${num(a.zoomBase)} は z0〜z${a.z - 1} のタイル総数。z0 → z1 → … と全ズームのタイルを 1 本の数直線に並べ、ズーム ${a.z} の区間の中で d 番目、という番号になる。`),
        h("p", { class: "dim" }, "Directory の entry はこの TileID の昇順に並んでいるので、次の段から binary search で探せる。"),
      );
    case "zoom-check":
      return box(
        "Zoom 範囲の確認",
        io(`Header の Min Zoom ${s.step.minZoom} ≤ z ${a.z} ≤ Max Zoom ${s.step.maxZoom}`, s.step.inRange ? "範囲内 → 探索へ" : "範囲外 → ここで終了"),
        h("p", { class: "dim" }, "公式実装と同じく、範囲外なら directory を見ずに終える（無駄な read を避けるため）。"),
      );
    case "directory": {
      const d = s.step.directory;
      const r = s.step.search;
      const obtained =
        s.step.obtainedBy === "first-read"
          ? `先頭 16 KiB（READ #${d.readId ?? "?"}）に含まれていた Root を使う。追加の I/O なし`
          : s.step.obtainedBy === "cache"
            ? `以前 READ #${d.readId ?? "?"} で読んだ leaf を再利用。追加の I/O なし`
            : `leaf を READ #${d.readId ?? "?"} で読んだ: bytes ${rangeText(d.fileOffset, d.compressedLength)}（${size(d.compressedLength)}）→ Internal Decompression → ${size(d.decompressed.length)} → decode`;
      const e = r.entry;
      return box(
        d.kind === "root" ? "Root Directory を探索" : `Leaf Directory を探索（深さ ${s.step.depth}）`,
        io(`TileID ${num(r.target)} を ${num(d.decoded.entries.length)} entries から binary search（${r.steps.length} 回比較）`, r.candidateIndex === undefined ? "候補なし" : `entry #${num(r.candidateIndex)}`),
        h("p", {}, obtained),
        h(
          "p",
          {},
          r.outcome === "exact-leaf" || r.outcome === "leaf"
            ? `候補は RunLength = 0 の leaf entry。Offset ${num(e!.offset)} / Length ${num(e!.length)} は Leaf Directories 内の位置（ファイル上 ${rangeText(hd.leafDirectoriesOffset + e!.offset, e!.length)}）。次はこの leaf を探す。`
            : r.outcome === "exact-tile" || r.outcome === "run-hit"
              ? `候補は tile entry で、target は run（${num(e!.tileId)}〜${num(e!.tileId + e!.runLength - 1)}）の中 → hit。`
              : r.outcome === "outside-run"
                ? "候補の tile entry の run が target まで届いていない → タイルは存在しない。"
                : "target が先頭 entry より前 → タイルは存在しない。",
        ),
        h("p", { class: "dim" }, "探索の過程は Directory Search パネル、この directory の entry 一覧は Directory パネルで確認できる。"),
      );
    }
    case "result": {
      const r = lookup.result;
      if (r.status === "found") {
        const e = r.entry;
        return box(
          "Tile Entry が見つかった",
          io(
            `TileID ${num(e.tileId)} / RunLength ${e.runLength} / Offset ${num(e.offset)} / Length ${num(e.length)}`,
            `ファイル上 bytes ${rangeText(r.fileOffset, r.length)}`,
          ),
          h("p", {}, `Offset は Tile Data section 起点の相対値なので、Tile Data Offset ${num(hd.tileDataOffset)} + ${num(e.offset)} = ${num(r.fileOffset)}。ここから ${num(r.length)} byte（${size(r.length)}）がこのタイルの bytes。`),
          e.runLength > 1 ? h("p", {}, `RunLength = ${e.runLength} なので、TileID ${num(e.tileId)}〜${num(e.tileId + e.runLength - 1)} の ${e.runLength} タイルがこの同じ bytes を共有している。`) : null,
          h("p", { class: "dim" }, "Tile Addressing はここまで。この範囲を実際に読み、Tile Compression を展開するのが次の段階（Physical Read）で、まだ tile data は読んでいない。File Layout の枠がこの範囲を示している。"),
        );
      }
      if (r.status === "error") return box("エラー", h("p", { class: "error" }, r.message));
      return box(
        r.status === "out-of-zoom" ? "ズーム範囲外" : "タイルは存在しない",
        h("p", {}, r.status === "out-of-zoom" ? "この archive はこのズームのタイルを持たない。" : "directory に該当する entry が無い。海など中身の無いタイルは書き込まれないことが多い。"),
      );
    }
  }
}

/** 読み込み済みの directory の tile entry から 1 つ選ぶ。未読 leaf を開かせずに「存在する」と保証できる範囲で選ぶ */
function randomExisting(s: AppState, ctl: Controller) {
  const archive = s.archive;
  if (!archive) return;
  const dirs = [archive.root];
  for (let i = 0; i < dirs.length; i++) {
    for (const e of dirs[i]!.decoded.entries) {
      if (e.runLength !== 0) continue;
      const leaf = archive.peekLeafDirectory(e);
      if (leaf) dirs.push(leaf);
    }
  }
  const tiles = dirs.flatMap((d) => d.decoded.entries.filter((e) => e.runLength > 0));
  const leafEntries = dirs.flatMap((d) => d.decoded.entries.filter((e) => e.runLength === 0 && !archive.peekLeafDirectory(e)));
  // 読み込み済みの tile entry が無ければ、未読 leaf の先頭 TileID を選ぶ（leaf の先頭は必ずその leaf 内の最初の entry）
  const pick = tiles.length ? tiles[Math.floor(Math.random() * tiles.length)]! : leafEntries[Math.floor(Math.random() * leafEntries.length)];
  if (!pick) return;
  const id = pick.runLength > 0 ? pick.tileId + Math.floor(Math.random() * pick.runLength) : pick.tileId;
  const a = tileIdToZxy(id);
  void ctl.traceTile(a.z, a.x, a.y);
}

function numInput(name: string, min: number, max?: number) {
  return h("input", { type: "number", class: "mono", name, min, max, step: 1, value: 0, required: true });
}
