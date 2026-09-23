import { HEADER_LAYOUT } from "../../core/pmtiles/header";
import type { ByteSpan } from "../../core/pmtiles/span";
import { HEX_PAGE_SIZE, type Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { hexByte, hexOffset, num, rangeText } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { FIELD_INFO, SECTION_LABEL } from "../text/header-fields";

interface Tint {
  start: number;
  end: number;
  cls: string;
  title: string;
}

/**
 * ファイルの生 bytes を 16 byte/行で表示する。
 *
 * 色は File Layout と同じ section 色を使い、Header 内は field ごとに濃淡を交互にして境界を見せる。
 * 窓（どこを表示するか）の再描画と、選択ハイライトの更新を分けているのは、
 * 16 KiB = 16384 個の span を選択のたびに作り直さないため。
 */
export function mountHexViewer(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  let spans: HTMLElement[] = [];
  let asciiSpans: HTMLElement[] = [];
  let base = 0;
  let scroller: HTMLElement | undefined;
  let lit: number[] = [];

  store.subscribe((s, prev) => {
    if (s.hex !== prev.hex || s.layout !== prev.layout) renderWindow(s);
    if (s.hex !== prev.hex || s.selection !== prev.selection) renderSelection(s);
  });

  function renderWindow(s: AppState) {
    const { hex, layout, archive } = s;
    spans = [];
    asciiSpans = [];
    lit = [];
    if (!hex || !layout || !archive) {
      replaceChildren(el, h("p", { class: "empty" }, "ファイルの生 bytes をここに表示します。"));
      return;
    }
    base = hex.baseOffset;
    const tints: Tint[] = [];
    HEADER_LAYOUT.forEach((f, i) =>
      tints.push({ start: f.offset, end: f.offset + f.length, cls: `sec-header f${i % 2}`, title: FIELD_INFO[f.key].label }),
    );
    for (const seg of layout.segments) {
      if (seg.kind === "section" && seg.name !== "header" && seg.length > 0) {
        tints.push({ start: seg.offset, end: seg.offset + seg.length, cls: `sec-${seg.name}`, title: SECTION_LABEL[seg.name] });
      }
    }
    const tintAt = (abs: number) => tints.find((t) => abs >= t.start && abs < t.end);

    const rows: HTMLElement[] = [];
    for (let r = 0; r < hex.bytes.length; r += 16) {
      const hexCells: HTMLElement[] = [];
      const asciiCells: HTMLElement[] = [];
      for (let i = r; i < Math.min(r + 16, hex.bytes.length); i++) {
        const abs = base + i;
        const b = hex.bytes[i]!;
        const t = tintAt(abs);
        const attrs = { class: `b ${t?.cls ?? "gap"}`, "data-o": abs, title: `${t?.title ?? "隙間"}\noffset ${num(abs)} (${hexOffset(abs)})\n0x${hexByte(b)} = ${b}` };
        const cell = h("span", attrs, hexByte(b));
        const ch = h("span", attrs, b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : "·");
        hexCells.push(cell);
        asciiCells.push(ch);
        spans.push(cell);
        asciiSpans.push(ch);
        if (i - r === 7) hexCells.push(h("span", { class: "mid" }, " "));
      }
      rows.push(h("div", { class: "row" }, h("span", { class: "addr" }, hexOffset(base + r)), h("span", { class: "hex" }, hexCells), h("span", { class: "ascii" }, asciiCells)));
    }

    scroller = h("div", { class: "hex-scroll" }, rows);
    // 行ごとにリスナを付けず委譲する（数万要素に個別リスナを付けないため）
    scroller.addEventListener("click", (ev) => {
      const o = (ev.target as HTMLElement).dataset?.["o"];
      if (o !== undefined) ctl.selectByte(Number(o));
    });

    const sec = hex.section;
    const secEnd = sec ? sec.offset + sec.length : 0;
    // 先頭 16 KiB を超えて続く section か、追加 read で見ている section ならページ送りできる
    const canPage = sec && (hex.origin === "viewer-inspect" || secEnd > hex.bytes.length);
    replaceChildren(
      el,
      h(
        "div",
        { class: "hex-head" },
        h("span", { class: `badge ${hex.origin}` }, hex.origin === "first-read" ? "先頭 16 KiB の read を再利用（追加 I/O なし）" : "表示のために追加で read"),
        h("span", { class: "mono" }, hex.bytes.length ? rangeText(base, hex.bytes.length) : "0 byte"),
        sec ? h("span", { class: "dim" }, `${SECTION_LABEL[sec.name]}: 全 ${num(sec.length)} byte`) : null,
        canPage
          ? h(
              "span",
              { class: "pager" },
              h("button", { onclick: () => ctl.hexPage(-1), disabled: hex.origin === "first-read" }, "◀ 前へ"),
              h("button", { onclick: () => ctl.hexPage(1), disabled: base + hex.bytes.length >= secEnd }, `次の ${HEX_PAGE_SIZE / 1024} KiB を読む ▶`),
            )
          : null,
      ),
      sec && sec.length === 0 ? h("p", { class: "note" }, `${SECTION_LABEL[sec.name]} は長さ 0（このファイルには存在しない）です。`) : null,
      scroller,
    );
  }

  function renderSelection(s: AppState) {
    for (const i of lit) {
      spans[i]?.classList.remove("sel");
      asciiSpans[i]?.classList.remove("sel");
    }
    lit = [];
    const range = selectedRange(s);
    if (!range || !scroller) return;
    const from = Math.max(range.offset, base) - base;
    const to = Math.min(range.offset + range.length, base + spans.length) - base;
    for (let i = from; i < to; i++) {
      spans[i]!.classList.add("sel");
      asciiSpans[i]!.classList.add("sel");
      lit.push(i);
    }
    const first = spans[from];
    if (first && from < to) {
      const row = first.parentElement!.parentElement!;
      scroller.scrollTop = row.offsetTop - scroller.clientHeight / 3;
    }
  }
}

function selectedRange(s: AppState): ByteSpan | undefined {
  const sel = s.selection;
  if (!sel || !s.archive || !s.layout) return undefined;
  if (sel.kind === "header-field") return s.archive.parsedHeader.spans[sel.key];
  const seg = s.layout.segments.find((g) => g.kind === "section" && g.name === sel.name);
  return seg ? { offset: seg.offset, length: seg.length } : undefined;
}
