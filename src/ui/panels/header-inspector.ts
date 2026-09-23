import { HEADER_LAYOUT, HEADER_SIZE, type Header, type HeaderKey } from "../../core/pmtiles/header";
import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { hexBytes, hexOffset, num } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { FIELD_INFO, SECTION_LABEL, interpret } from "../text/header-fields";

/**
 * Header の各 field を「ファイル上の位置 / 生 bytes / 値 / 意味」の 4 つを並べて示す。
 * 論理値だけを見せると、それが 127 byte のどこから来たかが分からなくなるため。
 */
export function mountHeaderInspector(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  store.subscribe((s, prev) => {
    if (s.archive !== prev.archive || s.selection !== prev.selection) render(s);
  });

  function render(s: AppState) {
    const archive = s.archive;
    if (!archive) {
      replaceChildren(el, h("p", { class: "empty" }, "ファイルを開くと Header（先頭 127 byte）を解析して表示します。"));
      return;
    }
    const { header, spans } = archive.parsedHeader;
    const bytes = archive.firstRead.bytes;
    const sel = s.selection;

    const rows: HTMLElement[] = [];
    let group = "";
    for (const f of HEADER_LAYOUT) {
      const info = FIELD_INFO[f.key];
      if (info.group !== group) {
        group = info.group;
        rows.push(h("tr", { class: "group" }, h("th", { colspan: 4 }, group)));
      }
      const span = spans[f.key];
      const selected =
        (sel?.kind === "header-field" && sel.key === f.key) || (sel?.kind === "section" && sel.name === info.section);
      rows.push(
        h(
          "tr",
          {
            class: `field${selected ? " selected" : ""}`,
            title: info.desc,
            onclick: () => ctl.selectHeaderField(f.key),
          },
          h("td", { class: "mono dim" }, `${hexOffset(span.offset, 2)}`, h("span", { class: "len" }, ` ${span.length}B`)),
          h("td", {}, info.label, info.section ? h("span", { class: `chip sec-${info.section}` }, SECTION_LABEL[info.section]) : null),
          h("td", { class: "mono raw" }, hexBytes(bytes.subarray(span.offset, span.offset + span.length), 8)),
          h("td", { class: "value" }, interpretCell(f.key, header)),
        ),
      );
    }

    const selectedKey = sel?.kind === "header-field" ? sel.key : undefined;
    replaceChildren(
      el,
      h(
        "p",
        { class: "note" },
        `Header は常にファイル先頭の ${HEADER_SIZE} byte。行をクリックすると Hex Viewer の該当 byte が光ります。`,
      ),
      h("table", { class: "header-table" }, h("thead", {}, h("tr", {}, h("th", {}, "位置"), h("th", {}, "Field"), h("th", {}, "Raw bytes (LE)"), h("th", {}, "値"))), h("tbody", {}, rows)),
      selectedKey ? h("div", { class: "field-desc" }, h("strong", {}, FIELD_INFO[selectedKey].label), " — ", FIELD_INFO[selectedKey].desc) : null,
      countsNote(header.numAddressedTiles, header.numTileEntries, header.numTileContents),
    );
    el.querySelector("tr.selected")?.scrollIntoView({ block: "nearest" });
  }
}

function interpretCell(key: HeaderKey, header: Header) {
  const v = header[key];
  const meaning = interpret(key, header);
  // 意味が値そのものと同じなら二重に書かない
  return typeof v === "number" && meaning !== num(v)
    ? [h("span", { class: "mono" }, num(v)), h("span", { class: "meaning" }, meaning)]
    : [h("span", { class: "mono" }, meaning)];
}

/** Addressed / Entries / Contents がなぜ一致しないのかを、このファイルの実数で示す */
function countsNote(addressed: number, entries: number, contents: number) {
  if (addressed === 0 && entries === 0 && contents === 0) {
    return h("div", { class: "note" }, "件数 3 項目はすべて 0（= 不明、または空のアーカイブ）です。");
  }
  return h(
    "div",
    { class: "counts" },
    h("div", { class: "counts-title" }, "件数 3 項目の関係"),
    h(
      "div",
      { class: "counts-row" },
      h("div", {}, h("b", {}, num(addressed)), h("small", {}, "Addressed Tiles"), h("em", {}, "z/x/y で引けるタイル数")),
      h("div", { class: "op" }, relation(addressed, entries)),
      h("div", {}, h("b", {}, num(entries)), h("small", {}, "Tile Entries"), h("em", {}, "連続する同一タイルを RunLength で 1 つに")),
      h("div", { class: "op" }, relation(entries, contents)),
      h("div", {}, h("b", {}, num(contents)), h("small", {}, "Tile Contents"), h("em", {}, "重複排除後の実体の数")),
    ),
    addressed >= entries && entries >= contents && contents > 0
      ? h(
          "p",
          { class: "dim" },
          `RunLength でまとめたことで entry は ${num(addressed - entries)} 個少なく、重複排除で実体は更に ${num(entries - contents)} 個少なくなっています。`,
        )
      : null,
  );
}

/** 大小関係は spec で保証されていない（参照されない blob を持つ writer もあり得る）ので、実値から記号を決める */
function relation(a: number, b: number): string {
  return a > b ? ">" : a < b ? "<" : "=";
}
