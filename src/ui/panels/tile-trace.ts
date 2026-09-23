import type { PmtilesArchive, TileLookup, TileRead } from "../../core/pmtiles/archive";
import { Compression, compressionName } from "../../core/pmtiles/enums";
import { MAX_ZOOM, tileIdToZxy } from "../../core/pmtiles/tileid";
import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { num, percent, rangeText, size } from "../format";
import { sizeBytes } from "../archive-size";
import type { AppState, TraceView } from "../state";
import type { Store } from "../store";
import { traceBudget } from "../trace-reads";
import { buildTraceSteps, isPhysicalStep, stepTitle, type UiTraceStep } from "../trace-steps";
import { sniff } from "../../tile-inspector/raw/sniff";

/**
 * Tile Trace: z/x/y から Tile Entry を経て、Range Read → Tile Decompression → Tile Payload までを段ごとに追う。
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
    if (s.archive !== prev.archive || s.trace !== prev.trace || s.traceLoading !== prev.traceLoading || s.traceError !== prev.traceError || s.tracePlaying !== prev.tracePlaying || s.archiveSize !== prev.archiveSize) render(s);
  });

  function render(s: AppState) {
    if (!s.archive) {
      replaceChildren(el, h("p", { class: "empty" }, "z/x/y を指定すると、Hilbert position → TileID → Root / Leaf の探索 → Tile Entry → Range Read → 解凍 → Payload を 1 段ずつ追えます。"));
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
      t ? traceView(s.archive, t, !!s.tracePlaying, ctl, readCtx(s)) : h("p", { class: "note" }, "Hilbert Viewer のマスをクリックしても始められます。"),
    );
    if (!el.contains(form)) replaceChildren(el, form, view);
  }
}

/** Physical Read の段の説明に使う「どう読んだか」。Archive Size と、HTTP なら実際の request */
interface ReadCtx {
  total: number | undefined;
  reads: AppState["reads"];
}

function readCtx(s: AppState): ReadCtx {
  return { total: sizeBytes(s.archiveSize), reads: s.reads };
}

function traceView(archive: PmtilesArchive, t: TraceView, playing: boolean, ctl: Controller, rc: ReadCtx) {
  const { lookup, step: current } = t;
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
            { class: `trace-step ${i === current ? "current" : i < current ? "done" : "todo"} k-${s.kind}${isPhysicalStep(s) ? " k-physical" : ""}`, onclick: () => ctl.traceStep(i) },
            h("b", {}, stepTitle(s, lookup)),
            h("span", {}, stepOutput(s, lookup, t.tile)),
          ),
        ),
      ),
    ),
    stepDetail(archive, steps[current]!, t, rc),
  );
}

/** 段のチップに出す短い出力値 */
function stepOutput(s: UiTraceStep, lookup: TileLookup, tile: TileRead | undefined): string {
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
    // 未読の段は「まだ I/O していない」ことが分かる表記にする
    case "range-read":
      return tile ? `READ #${tile.readId ?? "?"} · ${size(tile.raw.length)}` : "未読（進むと読む）";
    case "tile-decompress":
      return tile ? (tile.payload ? `${compressionName(tile.compression)} → ${size(tile.payload.length)}` : "解凍できない") : "—";
    case "payload":
      return tile ? sniff(tile.payload ?? tile.raw).kind : "—";
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

function stepDetail(archive: PmtilesArchive, s: UiTraceStep, t: TraceView, rc: ReadCtx) {
  const { lookup, tile } = t;
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
            ? `以前 READ #${d.readId ?? "?"} で${rc.reads.find((r) => r.id === d.readId)?.initiator === "map" ? "地図描画のために" : ""}読んだ leaf を再利用。追加の I/O なし`
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
          h("p", { class: "dim" }, "Tile Addressing（どこにあるか）はここまで。まだ tile data は 1 byte も読んでいない。File Layout の枠がこの範囲を示している。Next で Range Read の段に進むと、この範囲を実際に読む（Physical Read）。"),
        );
      }
      if (r.status === "error") return box("エラー", h("p", { class: "error" }, r.message));
      return box(
        r.status === "out-of-zoom" ? "ズーム範囲外" : "タイルは存在しない",
        h("p", {}, r.status === "out-of-zoom" ? "この archive はこのズームのタイルを持たない。" : "directory に該当する entry が無い。海など中身の無いタイルは書き込まれないことが多い。"),
      );
    }
    case "range-read": {
      const r = lookup.result;
      if (r.status !== "found") return null;
      if (!tile) return box("Range Read", h("p", { class: "note" }, "読み込み中…"));
      return box(
        "Range Read: Tile Entry が指す範囲だけを読む",
        io(`ByteSource.read(offset = ${num(tile.fileOffset)}, length = ${num(tile.length)})`, `READ #${tile.readId ?? "?"} → ${num(tile.raw.length)} byte 受信`),
        h(
          "p",
          {},
          `ローカルファイルなら File.slice(${num(tile.fileOffset)}, ${num(tile.fileOffset + tile.length)})、HTTP なら「Range: bytes=${tile.fileOffset}-${tile.fileOffset + tile.length - 1}」のリクエスト 1 回に相当する。ファイルの他の部分には触れない。`,
        ),
        httpLine(rc.reads.find((r) => r.id === tile.readId)),
        budgetTable(archive, t, tile, rc.total),
        h("p", { class: "dim" }, "ここで得たのはファイル上の bytes そのもの（Tile Compression 適用後）。File Layout / Hex Viewer / Read Trace がこの read を示している。"),
      );
    }
    case "tile-decompress": {
      if (!tile) return box("Tile Decompression", h("p", { class: "note" }, "tile を読み込み中…"));
      const c = tile.compression;
      const name = compressionName(c);
      return box(
        "Tile Decompression: Header の Tile Compression に従って展開",
        io(`${num(tile.raw.length)} byte（Tile Compression = ${name}）`, tile.payload ? `${num(tile.payload.length)} byte` : "解凍できない"),
        tile.decompressError ? h("p", { class: "error" }, tile.decompressError) : null,
        tile.decompressError ? h("p", {}, "解凍できなくてもファイル上の bytes は残っているので、Tile Payload パネルでは Raw Inspector として生 bytes を表示する。") : null,
        c === Compression.None
          ? h("p", {}, "none なので何もしない。ファイル上の bytes がそのまま Payload になる。")
          : c === Compression.Unknown
            ? h("p", {}, "unknown(0) は「方式が宣言されていない」という意味。公式実装と同じく無圧縮とみなしてそのまま通している。")
            : tile.payload
              ? h("p", {}, `${name} を展開して ${num(tile.raw.length)} → ${num(tile.payload.length)} byte（${ratioText(tile.raw.length, tile.payload.length)}）。`)
              : null,
        h(
          "p",
          { class: "dim" },
          `Internal Compression（${compressionName(archive.header.internalCompression)}: directory と metadata 用）とは別の設定。directory の展開は Root / Leaf search の段で済んでおり、ここで使うのは Tile Compression だけ。`,
        ),
      );
    }
    case "payload": {
      if (!tile) return box("Tile Payload", h("p", { class: "note" }, "tile を読み込み中…"));
      const bytes = tile.payload ?? tile.raw;
      const sn = sniff(bytes);
      return box(
        "Tile Payload: PMTiles の役目はここまで",
        io(tile.payload ? "解凍後の bytes" : "解凍できなかったので raw bytes", `${num(bytes.length)} byte · 先頭から推定: ${sn.kind}`),
        h("p", {}, `推定の根拠: ${sn.reason}。Header の宣言と中身の比較は Tile Payload パネルで確認できる。`),
        budgetTable(archive, t, tile, rc.total),
        h("p", { class: "dim" }, "この bytes を MVT / Raster などの Content Inspector に渡す。Content Inspector は bytes だけを受け取り、PMTiles の offset や directory は知らない。"),
      );
    }
  }
}

/** 1 タイルのために読んだ量の内訳。巨大なファイルのごく一部しか読んでいないことを数字で見せる */
function budgetTable(archive: PmtilesArchive, t: TraceView, tile: TileRead, total: number | undefined) {
  const rows = traceBudget(archive, t, tile);
  const cold = rows.reduce((a, r) => a + r.bytes, 0);
  const fresh = rows.filter((r) => r.how === "read").reduce((a, r) => a + r.bytes, 0);
  const HOW = { open: "archive を開いたときの read を共有", read: "この Trace で読んだ", cache: "以前の read を再利用（今回 0 byte）" } as const;
  return h(
    "table",
    { class: "budget" },
    h("thead", {}, h("tr", {}, ["このタイルのために必要な read", "READ", "byte", ""].map((x) => h("th", {}, x)))),
    h(
      "tbody",
      {},
      rows.map((r) => h("tr", { class: r.how === "cache" ? "dim" : "" }, h("td", {}, r.label), h("td", { class: "mono" }, r.readId !== undefined ? `#${r.readId}` : "—"), h("td", { class: "mono" }, num(r.bytes)), h("td", { class: "dim" }, HOW[r.how]))),
      h("tr", { class: "sum" }, h("td", {}, "合計（何も持っていない状態から 1 タイル取る場合）"), h("td", {}), h("td", { class: "mono" }, num(cold)), h("td", { class: "dim" }, total ? `archive 全体 ${size(total)} の ${percent(cold / total)}` : "")),
      h("tr", { class: "sum" }, h("td", {}, "この Trace で新たに発生した I/O"), h("td", {}), h("td", { class: "mono" }, num(fresh)), h("td", {})),
    ),
  );
}

/** HTTP で開いている場合は、実際に送った request と受けた response を 1 行で見せる（詳細は Read Trace） */
function httpLine(rec: AppState["reads"][number] | undefined) {
  const ex = rec?.http?.exchanges.at(-1);
  if (!ex) return null;
  const cr = ex.headers["content-range"];
  return h(
    "pre",
    { class: "mono http-line" },
    `${ex.method} ${rec!.http!.url}\nRange: ${ex.requestRange}\n→ ${ex.status} ${ex.statusText}${cr ? `\nContent-Range: ${cr}` : ex.responseType === "cors" ? "\nContent-Range: （CORS で Expose されておらず JS からは読めない）" : ""}`,
  );
}

function ratioText(from: number, to: number): string {
  return from === 0 ? "—" : `${(to / from).toFixed(2)} 倍`;
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
