import type { Header } from "../../core/pmtiles/header";
import type { TileRead } from "../../core/pmtiles/archive";
import { Compression, compressionName, TileType, tileTypeName } from "../../core/pmtiles/enums";
import type { ByteSpan } from "../../tile-inspector/span";
import { sniff, type SniffKind, type SniffResult } from "../../tile-inspector/raw/sniff";
import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { hexByte, hexOffset, num, rangeText, size } from "../format";
import type { AppState, TraceView } from "../state";
import type { Store } from "../store";
import { buildTraceSteps, type PhysicalStepKind } from "../trace-steps";

/** 1 列に描く byte 数の初期値。tile は数百 KB になり得るので、全体ではなく先頭から少しずつ見せる */
const DUMP_INITIAL = 256;
const DUMP_MAX = 16384;

/**
 * Tile Payload: Range Read で読んだ「ファイル上の bytes」と、解凍後の「Payload」を並べる。
 *
 * Hex Viewer は offset = ファイル上の位置 という前提で作られているので、ファイルに存在しない
 * 解凍後の bytes はここで扱う。Phase 7 の Content Inspector はこのパネルの Payload 側に接続する。
 */
export function mountTilePayload(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  let limit = DUMP_INITIAL;
  let shownTile: TileRead | undefined;

  store.subscribe((s, prev) => {
    if (s.trace !== prev.trace || s.archive !== prev.archive) render(s);
  });
  let shownFocus: ByteSpan | undefined;

  function render(s: AppState) {
    const t = s.trace;
    if (!s.archive || !t) {
      replaceChildren(el, h("p", { class: "empty" }, "Tile Trace で Range Read の段まで進むと、読んだ tile の bytes と解凍後の Payload をここに並べます。"));
      return;
    }
    const steps = buildTraceSteps(t.lookup);
    const rangeStep = steps.findIndex((x) => x.kind === "range-read");
    if (rangeStep < 0) {
      replaceChildren(el, h("p", { class: "empty" }, "この Trace は Tile Entry に届かなかったので、読む tile がありません。"));
      return;
    }
    const tile = t.tile;
    if (!tile) {
      replaceChildren(
        el,
        h("p", { class: "empty" }, "Tile Entry は見つかっていますが、まだ tile data を読んでいません。"),
        h("button", { onclick: () => ctl.traceStep(rangeStep) }, "Range Read の段へ進んで読む ▸"),
      );
      return;
    }
    if (tile !== shownTile) {
      shownTile = tile;
      limit = DUMP_INITIAL;
    }
    const cur = steps[t.step]?.kind;
    const focus: PhysicalStepKind | undefined = cur === "range-read" || cur === "tile-decompress" || cur === "payload" || cur === "content" ? cur : undefined;
    const mark = contentSpan(t);
    // 選んだ feature が変わったら dump の表示量を戻す（強調位置から少しだけ見せる）
    if (mark?.offset !== shownFocus?.offset || mark?.length !== shownFocus?.length) {
      shownFocus = mark;
      limit = DUMP_INITIAL;
    }
    const more = () => {
      limit = Math.min(limit * 4, DUMP_MAX);
      render(store.get());
    };
    replaceChildren(el, payloadView(s.archive.header, tile, focus, limit, more, mark));
  }
}

/** Content Inspector で選んでいる feature（無ければ layer）の Payload 上の範囲 */
function contentSpan(t: TraceView): ContentMark | undefined {
  const c = t.content;
  const { layer: li, feature: fi } = t.contentSel;
  if (c?.kind !== "mvt" || li === undefined) return undefined;
  const layer = c.mvt.layers[li];
  const f = fi !== undefined ? layer?.features[fi] : undefined;
  if (f) return { ...f.span, label: `${layer!.name} #${f.index}` };
  return layer ? { ...layer.span, label: `layer ${layer.name}` } : undefined;
}

interface ContentMark extends ByteSpan {
  label: string;
}

function payloadView(header: Header, tile: TileRead, focus: PhysicalStepKind | undefined, limit: number, more: () => void, mark: ContentMark | undefined) {
  const rawSniff = sniff(tile.raw);
  const payload = tile.payload;
  const paySniff = payload ? sniff(payload) : undefined;
  const same = payload === tile.raw;
  const longest = Math.max(tile.raw.length, payload?.length ?? 0);

  return h(
    "div",
    {},
    h(
      "div",
      { class: "pipeline" },
      h("div", { class: `step${focus === "range-read" ? " focus" : ""}` }, h("b", {}, "ファイル上の bytes"), h("span", {}, `${rangeText(tile.fileOffset, tile.length)}`), h("span", {}, `${num(tile.raw.length)} B（READ #${tile.readId ?? "?"}）`)),
      h("span", { class: "arrow" }, "→"),
      h("div", { class: `step${focus === "tile-decompress" ? " focus" : ""}` }, h("b", {}, "Tile Decompression"), h("span", {}, `Tile Compression = ${compressionName(tile.compression)}`), h("span", {}, payload ? (same ? "無変換" : "展開") : "失敗")),
      h("span", { class: "arrow" }, "→"),
      h("div", { class: `step${focus === "payload" ? " focus" : ""}` }, h("b", {}, "Tile Payload"), h("span", {}, payload ? `${num(payload.length)} B` : "—"), h("span", {}, `Tile Type = ${tileTypeName(header.tileType)}`)),
      h("span", { class: "arrow" }, "→"),
      h("div", { class: `step${focus === "content" ? " focus" : ""}` }, h("b", {}, "Content Inspector"), h("span", {}, "MVT / Raster / Raw"), h("span", {}, mark ? `強調: ${mark.label}` : "下のパネル")),
    ),
    tile.decompressError
      ? h("p", { class: "error" }, `解凍できませんでした: ${tile.decompressError}。Raw Inspector として、ファイル上の bytes だけを表示します。`)
      : null,
    h(
      "div",
      { class: "payload-cols" },
      column(
        "ファイル上の bytes（Tile Compression 適用後）",
        focus === "range-read",
        tile.raw,
        tile.fileOffset,
        rawSniff,
        compressionVerdict(tile.compression, rawSniff),
        limit,
        // 無圧縮なら Payload = ファイル上の bytes なので、feature の位置をこちらの列で示せる
        same ? mark : undefined,
      ),
      payload && !same
        ? column("Tile Payload（解凍後）", focus === "tile-decompress" || focus === "payload" || focus === "content", payload, undefined, paySniff!, tileTypeVerdict(header.tileType, paySniff!), limit, mark)
        : payload
          ? h(
              "div",
              { class: `payload-col${focus === "payload" || focus === "tile-decompress" ? " focus" : ""}` },
              h("div", { class: "tree-title" }, "Tile Payload（解凍後）"),
              h("p", {}, `Tile Compression = ${compressionName(tile.compression)} なので、左と同じ bytes がそのまま Payload になる。`),
              verdictEl(tileTypeVerdict(header.tileType, paySniff!), paySniff!),
            )
          : null,
    ),
    limit < Math.min(longest, DUMP_MAX) ? h("button", { onclick: more }, `もっと表示（${num(Math.min(limit * 4, DUMP_MAX))} byte まで）`) : null,
    longest > DUMP_MAX && limit >= DUMP_MAX ? h("p", { class: "note" }, `表示は先頭 ${num(DUMP_MAX)} byte までです。`) : null,
  );
}

interface Verdict {
  level: "ok" | "warn" | "na";
  text: string;
}

/**
 * Header の Tile Compression 宣言と、ファイル上の bytes の magic を突き合わせる。
 * 解凍は宣言だけに従う（推定で方式を変えない）ので、食い違いは「解凍が失敗する / 二重に圧縮されている」の手がかりとして見せる。
 */
function compressionVerdict(c: number, sn: SniffResult): Verdict {
  const declared = compressionName(c);
  if (c === Compression.Brotli) return { level: "na", text: `宣言は brotli。brotli の stream には magic bytes が無いので、bytes からは確認できない` };
  const expected: SniffKind | undefined = c === Compression.Gzip ? "gzip" : c === Compression.Zstd ? "zstd" : undefined;
  if (expected) {
    return sn.kind === expected
      ? { level: "ok", text: `宣言 ${declared} と magic が一致` }
      : { level: "warn", text: `宣言は ${declared} だが、bytes は ${sn.kind} に見える` };
  }
  // none / unknown なのに圧縮形式の magic がある = 実際には圧縮されている（Viewer は宣言どおり展開しない）
  if (sn.kind === "gzip" || sn.kind === "zstd") return { level: "warn", text: `宣言は ${declared} だが、bytes は ${sn.kind} の magic で始まる（宣言どおり展開していない）` };
  return { level: "ok", text: `宣言 ${declared}: 圧縮形式の magic は無い` };
}

const TYPE_EXPECT: Partial<Record<number, SniffKind>> = {
  [TileType.Mvt]: "mvt-like",
  [TileType.Png]: "png",
  [TileType.Jpeg]: "jpeg",
  [TileType.Webp]: "webp",
  [TileType.Avif]: "avif",
};

function tileTypeVerdict(t: number, sn: SniffResult): Verdict {
  const declared = tileTypeName(t);
  const expected = TYPE_EXPECT[t];
  if (!expected) {
    return { level: "na", text: t === TileType.Mlt ? "宣言は mlt。MLT は判定規則を実装していない（Phase 8）" : `宣言は ${declared}。対応する magic が無いので確認できない` };
  }
  return sn.kind === expected
    ? { level: "ok", text: `宣言 Tile Type ${declared} と一致` }
    : { level: "warn", text: `宣言 Tile Type は ${declared} だが、bytes は ${sn.kind} に見える。Content Inspector は Raw に fallback することになる` };
}

function verdictEl(v: Verdict, sn: SniffResult) {
  return h(
    "div",
    { class: `verdict v-${v.level}` },
    h("div", {}, h("b", {}, `推定: ${sn.kind}`), h("span", { class: "dim" }, ` — ${sn.reason}`)),
    h("div", {}, v.level === "ok" ? "✓ " : v.level === "warn" ? "⚠ " : "– ", v.text),
  );
}

/**
 * 1 列分: 見出し・推定結果・hex dump。
 * fileBase を持つ列（ファイル上の bytes）は address をファイル上の offset で、持たない列（Payload）は
 * Payload 先頭からの相対位置で描く。解凍後の bytes はファイル上のどこにも存在しないことを address の書式で区別するため。
 */
function column(title: string, focus: boolean, bytes: Uint8Array, fileBase: number | undefined, sn: SniffResult, v: Verdict, limit: number, mark?: ContentMark) {
  return h(
    "div",
    { class: `payload-col${focus ? " focus" : ""}` },
    h("div", { class: "tree-title" }, title, h("span", { class: "dim" }, ` ${num(bytes.length)} B（${size(bytes.length)}）`)),
    verdictEl(v, sn),
    mark ? h("div", { class: "dim small" }, `強調: ${mark.label}（Payload 上 +${num(mark.offset)} から ${num(mark.length)} B）`) : null,
    dump(bytes, fileBase, limit, sn.evidence, mark),
    sn.kind === "text" ? h("pre", { class: "text-preview" }, new TextDecoder().decode(bytes.subarray(0, 400)) + (bytes.length > 400 ? " …" : "")) : null,
  );
}

function dump(bytes: Uint8Array, fileBase: number | undefined, limit: number, evidence: ByteSpan | undefined, mark?: ByteSpan) {
  // 強調する範囲があれば、その 2 行手前から見せる（数百 KB の Payload の奥にある feature まで「もっと表示」を押させないため）
  const start = mark ? Math.max(0, Math.floor(mark.offset / 16) * 16 - 32) : 0;
  const n = Math.min(bytes.length, start + limit);
  const rows: HTMLElement[] = [];
  if (start > 0) rows.push(h("div", { class: "dim small" }, `… 先頭 ${num(start)} byte は省略`));
  for (let r = start; r < n; r += 16) {
    const cells: HTMLElement[] = [];
    const chars: string[] = [];
    for (let i = r; i < Math.min(r + 16, n); i++) {
      const b = bytes[i]!;
      const ev = evidence && i >= evidence.offset && i < evidence.offset + evidence.length;
      const mk = mark && i >= mark.offset && i < mark.offset + mark.length;
      cells.push(h("span", { class: `b${ev ? " ev" : ""}${mk ? " mk" : ""}` }, hexByte(b)));
      if (i - r === 7) cells.push(h("span", { class: "mid" }, " "));
      chars.push(b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·");
    }
    const addr = fileBase !== undefined ? hexOffset(fileBase + r) : `+${hexOffset(r, 6)}`;
    rows.push(h("div", { class: "row" }, h("span", { class: "addr" }, addr), h("span", { class: "hex" }, cells), h("span", { class: "ascii" }, chars.join(""))));
  }
  return h(
    "div",
    { class: "payload-dump" },
    h("div", { class: "dim small" }, fileBase !== undefined ? "address = ファイル上の offset" : "address = Payload 先頭からの位置（解凍後の bytes はファイル上には存在しない）"),
    rows,
    n < bytes.length ? h("div", { class: "dim small" }, `… 残り ${num(bytes.length - n)} byte`) : null,
  );
}
