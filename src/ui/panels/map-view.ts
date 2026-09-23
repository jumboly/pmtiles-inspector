import type { PmtilesArchive } from "../../core/pmtiles/archive";
import { tileIdRangeBlocks, type TileBlock } from "../../core/pmtiles/tileid";
import type { ReadRecord } from "../../core/source/tracing-byte-source";
import type { InspectorMap, InspectorMapColors, MapViewInfo } from "../../maplibre/inspector-map";
import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { num, size } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { traceRange } from "../trace-range";

/**
 * 地図パネル。地図をクリックすると、その位置で地図が実際に要求しているタイルの z/x/y から Tile Trace を始める。
 *
 * MapLibre は重い（数百 KB）ので、archive を開くまで読み込まない（Phase 1〜5 の機能だけ使う人を待たせないため）。
 * 地図の描画も自前の PmtilesArchive を通すので、パン・ズームで起きた read は Read Trace と File Layout に「地図描画」として現れる。
 */
export function mountMapView(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  const canvas = h("div", { class: "map-canvas" });
  const info = h("div", { class: "map-info" });
  const readsLine = h("div", { class: "map-reads" });
  const noteEl = h("p", { class: "note" });
  const errorEl = h("p", { class: "error" });
  let map: InspectorMap | undefined;
  let loading: Promise<InspectorMap> | undefined;
  /** 地図に今載っている archive。metadata を待ってから載せるので store の archive とは一時的にずれる */
  let shown: PmtilesArchive | undefined;
  let view: MapViewInfo | undefined;
  /** 今の archive の source がタイル z を round で決めるか（raster）、floor で決めるか（vector） */
  let roundZoom = false;
  /** 地図が要求したタイルの内訳。archive を開き直したら数え直す */
  let requested = { found: 0, missing: 0 };
  let tileErrors = 0;
  let lastTileError = "";
  let seq = 0;

  const ensureMap = () =>
    (loading ??= import("../../maplibre/inspector-map").then(({ InspectorMap }) => {
      replaceChildren(el, info, h("div", { class: "map-wrap" }, canvas), readsLine, noteEl, errorEl);
      map = new InspectorMap(canvas, {
        colors: colors(el),
        onTileClick: (t) => void ctl.traceTile(t.z, t.x, t.y),
        onTileHover: (t) => ctl.setHoverTile(t ? { ...t, from: "map" } : undefined),
        onView: (v) => {
          view = v;
          renderInfo(store.get());
        },
        onTileRequest: (o) => {
          if (o === "error") return;
          requested[o]++;
          renderReads(store.get().reads);
        },
        onTileError: (m) => {
          tileErrors++;
          lastTileError = m;
          renderErrors();
        },
      });
      return map;
    }));

  // canvas の地図は CSS 変数の変化を自動では拾わないので、テーマが変わったら色を渡し直す
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => void map?.setColors(colors(el)));

  store.subscribe((s, prev) => {
    // metadata が揃う（または読めないと分かる）まで待つ。vector の layer 名は metadata の vector_layers にしか無いため
    const metaSettled = s.metadata !== undefined || s.metadataError !== undefined;
    if (s.archive !== shown && (!s.archive || metaSettled)) void showArchive(s);
    if (s.trace !== prev.trace || s.archive !== prev.archive) void updateSelection(s, s.trace?.lookup !== prev.trace?.lookup);
    if (s.hoverTile !== prev.hoverTile) void map?.setHover(s.hoverTile?.from === "hilbert" ? s.hoverTile : undefined);
    if (s.reads !== prev.reads) renderReads(s.reads);
  });
  renderEmpty();

  async function showArchive(s: AppState) {
    const my = ++seq;
    shown = s.archive;
    requested = { found: 0, missing: 0 };
    tileErrors = 0;
    renderErrors();
    if (!s.archive) {
      if (map) await map.setArchive(undefined, undefined);
      else renderEmpty();
      return;
    }
    const m = await ensureMap();
    if (my !== seq) return;
    const style = await m.setArchive(s.archive, s.metadata?.json);
    if (my !== seq) return;
    roundZoom = style?.roundZoom ?? false;
    noteEl.textContent = style?.note ?? "";
    noteEl.hidden = !style?.note;
    renderReads(store.get().reads);
    await updateSelection(store.get(), true);
  }

  async function updateSelection(s: AppState, moved: boolean) {
    if (!map || s.archive !== shown) return;
    const a = s.trace?.lookup.address;
    await map.setSelection(a, regionBlocks(s));
    // 別のタイルを Trace し始めたときだけ地図を動かす。Next / Previous のたびに動くと見ている場所を見失う
    if (a && moved) await map.showTile(a);
  }

  function renderEmpty() {
    replaceChildren(
      el,
      h(
        "p",
        { class: "empty" },
        "archive を開くと地図に描き、タイル境界と z/x/y を重ねます。地図をクリックすると、そのタイルの Tile Trace（TileID → Root / Leaf → Range Read）を始めます。",
      ),
    );
  }

  function renderInfo(s: AppState) {
    if (!view || !s.archive) {
      info.textContent = "";
      return;
    }
    const hz = s.archive.header;
    const zText =
      view.tileZ === undefined
        ? `このズームでは地図はタイルを要求しない（Min Zoom ${hz.minZoom} 未満）`
        : `地図が要求するタイル z = ${view.tileZ}（${roundZoom ? "raster は round" : "vector は floor"}(${view.mapZoom.toFixed(2)})${view.overzoomed ? `。Max Zoom ${hz.maxZoom} を超えたので z${hz.maxZoom} のタイルを引き伸ばして描画` : ""}）· 画面を覆うタイル ${num(view.tiles)} 枚`;
    replaceChildren(
      info,
      h("span", { class: "mono" }, `地図ズーム ${view.mapZoom.toFixed(2)}`),
      h("span", {}, zText),
      h("span", { class: "dim" }, "クリック = そのタイルを Trace"),
    );
  }

  /** 地図描画のために読んだ量。Tile Trace の 1 タイル分と比べて、地図 1 画面ぶんで何をどれだけ読んだかを見せる */
  function renderReads(reads: ReadRecord[]) {
    if (!shown) {
      readsLine.textContent = "";
      return;
    }
    const mine = reads.filter((r) => r.initiator === "map");
    const ok = mine.filter((r) => !r.error);
    const tiles = ok.filter((r) => r.purpose === "tile-data");
    const leaves = ok.filter((r) => r.purpose === "leaf-directory");
    const aborted = mine.filter((r) => r.errorKind === "aborted").length;
    const bytes = ok.reduce((a, r) => a + r.receivedLength, 0);
    const req = requested.found + requested.missing;
    replaceChildren(
      readsLine,
      h("span", { class: "read-swatch map" }),
      `地図が要求したタイル ${num(req)} 枚`,
      // 無いタイルは directory を引くだけで分かるので tile data の read は起きない。「要求数 ≠ read 数」の理由
      requested.missing ? h("span", { class: "dim" }, `（うち archive に無い ${num(requested.missing)} 枚は directory だけで分かり tile の read なし）`) : null,
      ` → read: tile ${num(tiles.length)} 回 + leaf ${num(leaves.length)} 回 = 計 ${size(bytes)}`,
      aborted ? h("span", { class: "dim" }, `（パンで不要になり中断 ${num(aborted)} 回）`) : null,
      h("span", { class: "dim" }, " · Root は先頭 16 KiB を共有、leaf は Tile Trace と同じキャッシュを共有"),
    );
  }

  function renderErrors() {
    errorEl.hidden = tileErrors === 0;
    // 失敗の多くは「Header の Tile Type と中身が食い違う」「解凍できない」など archive 側の事情。中身は Tile Trace → Tile Payload で確かめられる
    errorEl.textContent = tileErrors
      ? `地図用のタイル取得・描画に ${num(tileErrors)} 回失敗（最後: ${lastTileError}）。そのタイルを Trace すると Tile Payload で中身を確認できます`
      : "";
  }
}

/**
 * 今の Trace 段が注目している TileID 区間を、Trace 中のタイルのズームで地図上の面にする。
 * leaf の担当区間は Hilbert 曲線に沿った連続区間なので、整列ブロック（正方形）の少数の並びに分解できる。
 */
function regionBlocks(s: AppState): TileBlock[] {
  const a = s.trace?.lookup.address;
  const r = traceRange(s);
  if (!a || !r || r.end - r.start <= 1) return [];
  return tileIdRangeBlocks(a.z, r.start, r.end);
}

function colors(el: HTMLElement): InspectorMapColors {
  const css = getComputedStyle(el);
  const v = (n: string) => css.getPropertyValue(n).trim();
  return {
    selected: v("--sel"),
    hover: v("--text"),
    region: v("--c-target"),
    grid: v("--dim"),
    text: v("--text"),
    halo: v("--panel"),
    palette: [1, 2, 3, 4].map((i) => v(`--c-region-${i}`)),
    basemap: { background: v("--map-water"), land: v("--map-land"), border: v("--map-border"), label: v("--map-label") },
  };
}
