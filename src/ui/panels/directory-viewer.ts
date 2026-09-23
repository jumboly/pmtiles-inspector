import type { DirectoryRecord, PmtilesArchive } from "../../core/pmtiles/archive";
import type { DirectoryIssue, Entry } from "../../core/pmtiles/directory";
import { compressionName } from "../../core/pmtiles/enums";
import { tileIdToZxy } from "../../core/pmtiles/tileid";
import { DIR_PAGE_SIZE, type Controller } from "../controller";
import { entryTarget } from "../directory-util";
import { h, replaceChildren } from "../dom";
import { num, rangeText, size } from "../format";
import type { AppState, DirView } from "../state";
import type { Store } from "../store";

const ISSUE_TEXT: Record<DirectoryIssue["code"], string> = {
  "empty-directory": "entry が 0 個です（spec §4.2 は 1 個以上を要求）",
  "first-offset-zero": "先頭 entry の Offset 符号値が 0 です（offset = −1 になり不正）",
  "zero-length": "Length が 0 の entry があります（spec §4.1 は 1 以上を要求）",
};

/**
 * Root / Leaf の論理構造と、各 directory の entry 一覧を示す。
 *
 * ツリーには directory（= leaf を指す entry）だけを出し、tile entry は件数にまとめる。
 * leaf 1 つに数千の tile entry があるため、全部をツリーにすると「階層」が見えなくなるから。
 */
export function mountDirectoryViewer(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  store.subscribe((s, prev) => {
    if (s.dirView !== prev.dirView || s.selection !== prev.selection || s.dirLoading !== prev.dirLoading || s.dirError !== prev.dirError || s.archive !== prev.archive) render(s);
  });

  function render(s: AppState) {
    const { archive, dirView } = s;
    if (!archive || !dirView) {
      replaceChildren(el, h("p", { class: "empty" }, "Root Directory と、そこから辿れる Leaf Directory の entry を表示します。"));
      return;
    }
    replaceChildren(
      el,
      h(
        "div",
        { class: "dir-layout" },
        h("div", { class: "dir-tree" }, h("div", { class: "tree-title" }, "Directory の階層"), treeNode(archive, archive.root, [], dirView, ctl)),
        h(
          "div",
          { class: "dir-main" },
          s.dirLoading ? h("p", { class: "note" }, s.dirLoading) : null,
          s.dirError ? h("p", { class: "error" }, `Leaf を読めませんでした: ${s.dirError}`) : null,
          summary(archive, dirView),
          runLengthLegend(),
          entryTable(archive, dirView, s, ctl),
        ),
      ),
    );
    el.querySelector("tr.selected")?.scrollIntoView({ block: "nearest" });
  }
}

function treeNode(archive: PmtilesArchive, dir: DirectoryRecord, trail: DirView["trail"], view: DirView, ctl: Controller): HTMLElement {
  const entries = dir.decoded.entries;
  const tileCount = entries.filter((e) => e.runLength > 0).length;
  const current = view.dir === dir;
  const children: HTMLElement[] = [];
  entries.forEach((e, i) => {
    if (e.runLength !== 0) return;
    const childTrail = [...trail, { dir, index: i }];
    const loaded = archive.peekLeafDirectory(e);
    const next = entries[i + 1];
    const range = next ? `TileID ${num(e.tileId)}–${num(next.tileId - 1)}` : `TileID ${num(e.tileId)}〜`;
    children.push(
      loaded
        ? treeNode(archive, loaded, childTrail, view, ctl)
        : h(
            "li",
            {},
            h(
              "button",
              { class: "tree-item unloaded", title: `未読。クリックで ${size(e.length)} を read して開きます`, onclick: () => ctl.expandLeaf(childTrail) },
              `▸ Leaf (entry #${i}) `,
              h("span", { class: "dim" }, `${range} · 未読`),
            ),
          ),
    );
  });
  const parent = trail.at(-1);
  const label =
    dir.kind === "root"
      ? "Root Directory"
      : `Leaf (entry #${parent!.index})`;
  const tileId = parent ? parent.dir.decoded.entries[parent.index]!.tileId : undefined;
  return h(
    dir.kind === "root" ? "ul" : "li",
    { class: dir.kind === "root" ? "tree" : "" },
    h(
      dir.kind === "root" ? "li" : "div",
      {},
      h(
        "button",
        { class: `tree-item${current ? " current" : ""}`, onclick: () => ctl.openDirectory({ dir, trail }) },
        `${children.length ? "▾" : "•"} ${label} `,
        h("span", { class: "dim" }, `${tileId !== undefined ? `TileID ${num(tileId)}〜 · ` : ""}${num(entries.length)} entries`),
      ),
      h("ul", {}, children, tileCount ? h("li", { class: "dim tree-tiles" }, `tile entry ×${num(tileCount)}`) : null),
    ),
  );
}

function summary(archive: PmtilesArchive, view: DirView) {
  const { dir, trail } = view;
  const entries = dir.decoded.entries;
  const leafCount = entries.filter((e) => e.runLength === 0).length;
  const addressed = entries.reduce((a, e) => a + e.runLength, 0);
  const obtained =
    dir.kind === "root"
      ? archive.rootOutsideFirstRead
        ? `READ #${dir.readId ?? "?"}（先頭 16 KiB の外にあったため別 read）`
        : `READ #${dir.readId ?? "?"}（先頭 16 KiB に含まれていた）`
      : `READ #${dir.readId ?? "?"}`;
  return h(
    "div",
    { class: "dir-summary" },
    h(
      "div",
      { class: "crumbs" },
      [...trail.map((t) => t.dir), dir].flatMap((d, i, all) => [
        i > 0 ? h("span", { class: "dim" }, " › ") : null,
        h("span", { class: i === all.length - 1 ? "" : "dim" }, d.kind === "root" ? "Root" : `Leaf (entry #${trail[i - 1]!.index})`),
      ]),
    ),
    h(
      "dl",
      {},
      kv("ファイル上の位置", `${rangeText(dir.fileOffset, dir.compressedLength)}`),
      kv("取得", obtained),
      kv("Internal Compression", `${compressionName(archive.header.internalCompression)}: ${size(dir.compressedLength)} → 解凍後 ${size(dir.decompressed.length)}`),
      kv("entries", `${num(entries.length)}（tile entry ${num(entries.length - leafCount)} / leaf entry ${num(leafCount)}）`),
      kv("Σ RunLength", `${num(addressed)} タイル分を指す${leafCount ? "（leaf の先は含まない）" : ""}`),
    ),
    dir.decoded.issues.length
      ? h("ul", { class: "issues" }, dir.decoded.issues.map((i) => h("li", {}, ISSUE_TEXT[i.code], i.code === "zero-length" ? `（entry #${i.index}）` : "")))
      : null,
  );
}

function kv(k: string, v: string) {
  return [h("dt", {}, k), h("dd", { class: "mono" }, v)];
}

function runLengthLegend() {
  return h(
    "div",
    { class: "legend" },
    h("div", {}, h("b", {}, "RunLength = 0"), " → Offset / Length は ", h("span", { class: "chip sec-leafDirectories" }, "Leaf Directories"), " 内の位置。探索はその leaf に続く"),
    h(
      "div",
      {},
      h("b", {}, "RunLength ≥ 1"),
      " → Offset / Length は ",
      h("span", { class: "chip sec-tileData" }, "Tile Data"),
      " 内の位置。TileID から RunLength 個の連続したタイルが同じ bytes を共有する",
    ),
  );
}

function entryTable(archive: PmtilesArchive, view: DirView, s: AppState, ctl: Controller) {
  const { dir, page } = view;
  const entries = dir.decoded.entries;
  const pages = Math.max(1, Math.ceil(entries.length / DIR_PAGE_SIZE));
  const from = page * DIR_PAGE_SIZE;
  const rows = entries.slice(from, from + DIR_PAGE_SIZE);
  const sel = s.selection?.kind === "dir-entry" && s.selection.dir === dir ? s.selection.index : undefined;

  const pager =
    pages > 1
      ? h(
          "div",
          { class: "pager" },
          h("button", { onclick: () => ctl.dirPage(page - 1), disabled: page === 0 }, "◀"),
          h("span", { class: "mono" }, ` #${num(from)}–${num(Math.min(from + DIR_PAGE_SIZE, entries.length) - 1)} / ${num(entries.length)} `),
          h("button", { onclick: () => ctl.dirPage(page + 1), disabled: page >= pages - 1 }, "▶"),
        )
      : null;

  return h(
    "div",
    {},
    pager,
    h(
      "table",
      { class: "dir-table" },
      h("thead", {}, h("tr", {}, ["#", "TileID", "z/x/y", "RunLength", "指す先", "Offset", "Length", "ファイル上の範囲"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        rows.map((e, k) => {
          const i = from + k;
          const t = entryTarget(e, archive.header);
          return h(
            "tr",
            { class: `${i === sel ? "selected" : ""}${e.runLength === 0 ? " leaf-row" : ""}`, onclick: () => ctl.selectDirEntry(dir, i) },
            h("td", { class: "mono dim" }, i),
            h("td", { class: "mono" }, num(e.tileId)),
            h("td", { class: "mono" }, zxyText(e)),
            h("td", { class: "mono" }, e.runLength),
            h(
              "td",
              {},
              e.runLength === 0
                ? h(
                    "button",
                    {
                      class: "link-btn",
                      onclick: (ev: Event) => {
                        ev.stopPropagation();
                        void ctl.expandLeaf([...view.trail, { dir, index: i }]);
                      },
                    },
                    "Leaf を開く ▸",
                  )
                : e.runLength > 1
                  ? `tile ×${num(e.runLength)}`
                  : "tile",
            ),
            h("td", { class: "mono" }, num(e.offset)),
            h("td", { class: "mono" }, num(e.length)),
            h("td", { class: "mono dim" }, h("span", { class: `swatch sec-${t.section}` }), rangeText(t.offset, t.length)),
          );
        }),
      ),
    ),
    pager,
  );
}

/** run の場合は先頭と末尾の z/x/y を示す（TileID が連続でも z/x/y は Hilbert 順なので飛び飛びに見える） */
function zxyText(e: Entry): string {
  const a = tileIdToZxy(e.tileId);
  const first = `${a.z}/${a.x}/${a.y}`;
  if (e.runLength <= 1) return first;
  const b = tileIdToZxy(e.tileId + e.runLength - 1);
  return `${first} … ${b.z}/${b.x}/${b.y}`;
}
