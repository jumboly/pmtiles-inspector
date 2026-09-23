import { compressionName } from "../../core/pmtiles/enums";
import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { num, rangeText, size } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";

/**
 * JSON Metadata を「どこから何 byte 読み、どう解凍して、何になったか」の順に示す。
 * spec で意味が定められたキー（vector_layers, encoding など）は目立たせる。
 */
export function mountMetadataViewer(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  store.subscribe((s, prev) => {
    if (s.metadata !== prev.metadata || s.metadataError !== prev.metadataError || s.archive !== prev.archive || s.selection !== prev.selection) render(s);
  });

  function render(s: AppState) {
    const { archive, metadata, metadataError } = s;
    if (!archive) {
      replaceChildren(el, h("p", { class: "empty" }, "JSON Metadata を解凍して表示します。"));
      return;
    }
    const hd = archive.header;
    const selected = s.selection?.kind === "section" && s.selection.name === "metadata";
    el.classList.toggle("selected", selected);
    if (metadataError) {
      replaceChildren(el, h("p", { class: "error" }, `Metadata を読めませんでした: ${metadataError}`));
      return;
    }
    if (!metadata) {
      replaceChildren(el, h("p", { class: "empty" }, "読み込み中…"));
      return;
    }
    const json = metadata.json as Record<string, unknown> | undefined;
    const encoding = json && typeof json === "object" ? json["encoding"] : undefined;

    replaceChildren(
      el,
      h(
        "div",
        { class: "pipeline" },
        h("button", { class: "step link", onclick: () => ctl.selectSection("metadata") }, h("b", {}, `READ #${metadata.readId ?? "?"}`), h("span", {}, `bytes ${rangeText(metadata.fileOffset, metadata.compressed.length)}`)),
        h("span", { class: "arrow" }, "→"),
        h("div", { class: "step" }, h("b", {}, `${compressionName(hd.internalCompression)} を解凍`), h("span", {}, `${size(metadata.compressed.length)} → ${size(metadata.decompressed.length)}`)),
        h("span", { class: "arrow" }, "→"),
        h("div", { class: "step" }, h("b", {}, "UTF-8 JSON"), h("span", {}, json !== undefined ? `${num(Object.keys(json ?? {}).length)} keys` : "解析失敗")),
      ),
      metadata.jsonError ? h("p", { class: "error" }, `JSON として解釈できません: ${metadata.jsonError}`) : null,
      typeof encoding === "string"
        ? h("p", { class: "note" }, `encoding = "${encoding}"`, encoding === "terrarium" ? "：Raster タイルの RGB が標高を表す（elevation = R×256 + G + B/256 − 32768）。Terrain は Tile Type ではなく metadata で表される。" : "")
        : null,
      json !== undefined ? h("div", { class: "json" }, jsonTree(json, 0)) : null,
    );
  }
}

/** spec §5 で意味が定義されているキー。それ以外は writer 独自の情報 */
const SPEC_KEYS = new Set(["vector_layers", "name", "description", "attribution", "type", "version", "encoding"]);

function jsonTree(v: unknown, depth: number, key?: string): HTMLElement {
  const label = key !== undefined ? h("span", { class: `k${depth === 1 && SPEC_KEYS.has(key) ? " spec" : ""}` }, key, ": ") : null;
  if (v !== null && typeof v === "object") {
    const entries = Array.isArray(v) ? v.map((x, i) => [String(i), x] as const) : Object.entries(v);
    const summary = Array.isArray(v) ? `[${v.length}]` : `{${entries.length}}`;
    return h(
      "details",
      // 深い階層まで開くと tilestats などで巨大になるため、最上位だけ開いておく
      { open: depth < 1 },
      h("summary", {}, label, h("span", { class: "dim" }, summary)),
      h("div", { class: "children" }, entries.map(([k, x]) => jsonTree(x, depth + 1, k))),
    );
  }
  const text = typeof v === "string" ? JSON.stringify(v) : String(v);
  return h("div", { class: "leaf" }, label, h("span", { class: `v ${typeof v}` }, text.length > 300 ? text.slice(0, 300) + "…" : text));
}
