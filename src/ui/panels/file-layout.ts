import { compressionName } from "../../core/pmtiles/enums";
import { FIRST_READ_SIZE, type Header, type SectionName } from "../../core/pmtiles/header";
import type { LayoutSegment } from "../../core/pmtiles/layout";
import type { Controller } from "../controller";
import { entryTarget } from "../directory-util";
import { h, replaceChildren } from "../dom";
import { hexOffset, num, percent, rangeText, size } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import type { ReadRecord } from "../../core/source/tracing-byte-source";
import { traceReadIds } from "../trace-reads";
import { PURPOSE_LABEL } from "../text/read-purpose";
import { FIELD_INFO, SECTION_LABEL } from "../text/header-fields";

const ISSUE_TEXT = {
  overlap: "section が重なっています",
  "beyond-eof": "section がファイル末尾を超えています",
  "root-outside-first-read": "Root Directory が先頭 16 KiB に収まっていません（spec 違反）",
} as const;

/**
 * ファイル全体を 1 本の byte 列として描く。
 *
 * 実寸の帯だけだと 127 byte の Header は数 GB のファイルでは見えなくなるため、
 * 「先頭 16 KiB の拡大図」を並べ、公式クライアントが最初に読む範囲を明示する。
 */
export function mountFileLayout(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  store.subscribe((s, prev) => {
    if (s.layout !== prev.layout || s.selection !== prev.selection || s.hex !== prev.hex || s.reads !== prev.reads || s.trace !== prev.trace) render(s);
  });

  function render(s: AppState) {
    const { layout, archive } = s;
    if (!layout || !archive) {
      replaceChildren(el, h("p", { class: "empty" }, "Header の offset / length から、各領域のファイル上の物理位置を描きます。"));
      return;
    }
    const h0 = archive.header;
    const fileSize = layout.fileSize ?? lastEnd(layout.segments);
    const selName = selectedSection(s);
    const firstReadLen = archive.firstRead.bytes.length;

    const segEl = (seg: LayoutSegment, total: number, clipEnd?: number) => {
      const end = Math.min(seg.offset + seg.length, clipEnd ?? Infinity);
      const len = end - seg.offset;
      if (len <= 0) return null;
      const isSection = seg.kind === "section";
      const name = isSection ? seg.name : undefined;
      return h(
        "div",
        {
          class: `seg ${isSection ? `sec-${name}` : "gap"}${name && name === selName ? " selected" : ""}`,
          style: `flex-grow:${len / total}`,
          title: `${isSection ? SECTION_LABEL[name!] : "隙間"}\n${rangeText(seg.offset, seg.length)}\n${size(seg.length)}`,
          onclick: name ? () => ctl.selectSection(name) : undefined,
        },
        h("span", {}, isSection ? SECTION_LABEL[name!] : ""),
      );
    };

    // Hex Viewer が今どこを見ているかを帯の上に重ねる（論理 ↔ 物理 の対応を常に見せるため）
    const hex = s.hex;
    const hexMarker = (total: number, clip?: number) => {
      if (!hex || hex.bytes.length === 0) return null;
      const start = hex.baseOffset;
      const end = Math.min(start + hex.bytes.length, clip ?? Infinity);
      if (end <= start) return null;
      return h("div", {
        class: "hex-marker",
        style: `left:${(start / total) * 100}%;width:max(2px, ${((end - start) / total) * 100}%)`,
        title: `Hex Viewer 表示中: ${rangeText(start, end - start)}`,
      });
    };

    // 選択中の entry が指す先（Tile Data または Leaf Directory）。Offset / Length が「どこを指すか」を物理位置で見せる
    const sel = s.selection;
    const target =
      sel?.kind === "dir-entry"
        ? entryTarget(sel.dir.decoded.entries[sel.index]!, h0)
        : sel?.kind === "tile-data"
          ? { section: "tileData" as const, offset: sel.offset, length: sel.length }
          : undefined;
    const targetMarker = (total: number, clip?: number) => {
      if (!target) return null;
      const end = Math.min(target.offset + target.length, clip ?? Infinity);
      if (end <= target.offset) return null;
      return h("div", {
        class: "target-marker",
        style: `left:${(target.offset / total) * 100}%;width:max(3px, ${((end - target.offset) / total) * 100}%)`,
        title: `選択中の entry が指す範囲: ${rangeText(target.offset, target.length)}`,
      });
    };

    // Read Trace の全 read を帯の下のトラックに並べる。今の Trace（今の段まで）で使った read だけ濃く描く
    const inTrace = traceReadIds(s.trace);
    const reads = s.reads.filter((r) => !r.error && r.receivedLength > 0);
    const readTrack = (total: number, clip?: number) =>
      h(
        "div",
        { class: "read-track" },
        reads.map((r) => {
          const end = Math.min(r.offset + r.receivedLength, clip ?? Infinity);
          if (end <= r.offset) return null;
          return h("div", {
            class: `read-mark p-${r.purpose}${inTrace.has(r.id) ? " in-trace" : ""}`,
            style: `left:${(r.offset / total) * 100}%;width:max(3px, ${((end - r.offset) / total) * 100}%)`,
            title: `READ #${r.id} ${PURPOSE_LABEL[r.purpose]}${r.label ? ` (${r.label})` : ""}\n${rangeText(r.offset, r.receivedLength)}（${size(r.receivedLength)}）`,
          });
        }),
      );

    const zoomTotal = FIRST_READ_SIZE;
    replaceChildren(
      el,
      h("div", { class: "bar-label" }, h("span", {}, "0"), h("span", {}, `ファイル全体（実寸） ${size(fileSize)}`), h("span", {}, `EOF ${num(fileSize)}`)),
      h("div", { class: "bar-wrap" }, h("div", { class: "bar" }, layout.segments.map((seg) => segEl(seg, fileSize))), hexMarker(fileSize), targetMarker(fileSize)),
      readTrack(fileSize),
      h(
        "div",
        { class: "bar-label" },
        h("span", {}, "0"),
        h("span", {}, "先頭 16 KiB の拡大図"),
        h("span", {}, num(zoomTotal - 1)),
      ),
      h(
        "div",
        { class: "bar-wrap" },
        h("div", { class: "bar zoom" }, layout.segments.map((seg) => segEl(seg, zoomTotal, zoomTotal)), fileSize < zoomTotal ? h("div", { class: "seg eof", style: `flex-grow:${(zoomTotal - fileSize) / zoomTotal}` }, h("span", {}, "EOF 以降")) : null),
        hexMarker(zoomTotal, zoomTotal),
        targetMarker(zoomTotal, zoomTotal),
      ),
      readTrack(zoomTotal, zoomTotal),

      h(
        "div",
        { class: "first-read" },
        h("div", { class: "bracket", style: `width:${(Math.min(firstReadLen, zoomTotal) / zoomTotal) * 100}%` }),
        h(
          "span",
          {},
          `READ #${archive.firstRead.readId ?? "?"}: bytes 0–${firstReadLen - 1} をまとめて取得 → Header と Root Directory が 1 回の read で揃う`,
          firstReadLen < zoomTotal ? `（ファイルが 16 KiB 未満なので ${num(firstReadLen)} byte で EOF）` : "",
        ),
      ),
      target
        ? h(
            "p",
            { class: "target-note" },
            h("span", { class: "target-swatch" }),
            `${sel?.kind === "tile-data" ? "Range Read で読んだ tile" : "選択中の entry"} → ${SECTION_LABEL[target.section]} 内 bytes ${rangeText(target.offset, target.length)}（${size(target.length)}）`,
          )
        : null,
      reads.length ? readLegend(reads, inTrace, !!s.trace) : null,
      layout.issues.length ? h("ul", { class: "issues" }, layout.issues.map((i) => h("li", {}, `${ISSUE_TEXT[i.code]}: ${i.sections.map((n) => SECTION_LABEL[n]).join(", ")}`))) : null,
      sectionTable(layout.segments, fileSize, h0, selName, ctl),
    );
  }
}

/** read トラックの凡例。実際に現れた目的だけを出す（凡例が長くなりすぎないように） */
function readLegend(reads: ReadRecord[], inTrace: Set<number>, tracing: boolean) {
  const purposes = [...new Set(reads.map((r) => r.purpose))];
  const traced = reads.filter((r) => inTrace.has(r.id));
  const tracedBytes = traced.reduce((a, r) => a + r.receivedLength, 0);
  return h(
    "div",
    { class: "read-legend" },
    h("span", { class: "dim" }, "帯の下のトラック = 実際に read した範囲:"),
    purposes.map((p) => h("span", {}, h("span", { class: `read-swatch p-${p}` }), PURPOSE_LABEL[p])),
    tracing
      ? h("span", { class: "dim" }, `濃い印 = 今の Trace の今の段までに使った read（${traced.length} 回, 計 ${size(tracedBytes)}）。薄い印 = それ以外の read`)
      : null,
  );
}

function sectionTable(segments: LayoutSegment[], fileSize: number, header: Header, selName: SectionName | undefined, ctl: Controller) {
  const comp = (seg: LayoutSegment) => {
    if (seg.kind !== "section") return "—";
    if (seg.name === "tileData") return `${compressionName(header.tileCompression)}（Tile Compression）`;
    if (seg.name === "header") return "なし";
    return `${compressionName(header.internalCompression)}（Internal）`;
  };
  return h(
    "table",
    { class: "layout-table" },
    h("thead", {}, h("tr", {}, ["領域", "Offset", "Length", "End (含む)", "割合", "圧縮"].map((t) => h("th", {}, t)))),
    h(
      "tbody",
      {},
      segments.map((seg) => {
        const name = seg.kind === "section" ? seg.name : undefined;
        return h(
          "tr",
          {
            class: `${name && name === selName ? "selected" : ""}${name ? "" : " gap-row"}`,
            onclick: name ? () => ctl.selectSection(name) : undefined,
          },
          h("td", {}, h("span", { class: `swatch ${name ? `sec-${name}` : "gap"}` }), name ? SECTION_LABEL[name] : "隙間"),
          h("td", { class: "mono", title: hexOffset(seg.offset, 10) }, num(seg.offset)),
          h("td", { class: "mono" }, num(seg.length), h("span", { class: "dim" }, ` (${size(seg.length)})`)),
          h("td", { class: "mono" }, seg.length > 0 ? num(seg.offset + seg.length - 1) : "—"),
          h("td", { class: "mono" }, percent(seg.length / fileSize)),
          h("td", {}, comp(seg)),
        );
      }),
    ),
  );
}

function selectedSection(s: AppState): SectionName | undefined {
  const sel = s.selection;
  if (sel?.kind === "section") return sel.name;
  // directory（や entry）を選んでいる間は、その directory 自身が置かれている section を光らせる
  if (sel?.kind === "directory" || sel?.kind === "dir-entry") return sel.dir.kind === "root" ? "rootDirectory" : "leafDirectories";
  if (sel?.kind === "tile-data") return "tileData";
  if (sel?.kind === "header-field") {
    // offset/length 系の field を選んだら、その field が指す section を光らせる
    // それ以外の field は Header 自身の一部なので Header を光らせる
    return FIELD_INFO[sel.key].section ?? "header";
  }
  return undefined;
}

function lastEnd(segments: LayoutSegment[]): number {
  return segments.reduce((m, s) => Math.max(m, s.offset + s.length), 0);
}
