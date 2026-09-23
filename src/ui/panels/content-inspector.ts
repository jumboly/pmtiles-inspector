import type { TileRead } from "../../core/pmtiles/archive";
import { Compression, compressionName } from "../../core/pmtiles/enums";
import { featureProperties, GEOM_TYPE_NAMES, GeomType, type MvtFeature, type MvtLayer, type MvtValue } from "../../tile-inspector/mvt/decode";
import { vertexCount, type DecodedGeometry } from "../../tile-inspector/mvt/geometry";
import { sniff } from "../../tile-inspector/raw/sniff";
import type { ByteSpan } from "../../tile-inspector/span";
import type { ContentResult } from "../content";
import { FEATURE_PAGE_SIZE, type Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { hexByte, hexOffset, num, size } from "../format";
import type { AppState, ContentSel, TraceView } from "../state";
import type { Store } from "../store";

/**
 * Content Inspector: Tile Payload を MVT / Raster / Raw として読んだ結果。
 *
 * ここに出る位置はすべて「Payload 先頭からの位置」。Payload がファイル上のどこに対応するかは Tile Compression 次第なので、
 * none のときだけファイル上の offset を併記する（gzip などでは Payload の bytes はファイル上に存在しない）。
 */
export function mountContentInspector(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  const preview = new TilePreview(ctl);
  store.subscribe((s, prev) => {
    if (s.trace !== prev.trace || s.archive !== prev.archive) render(s);
  });
  // canvas は CSS 変数の変化を拾わないので、テーマが変わったら描き直す
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    preview.invalidate();
    render(store.get());
  });

  function render(s: AppState) {
    const t = s.trace;
    if (!s.archive || !t?.tile || !t.content) {
      replaceChildren(
        el,
        h("p", { class: "empty" }, "Tile Trace で tile を読むと（Range Read の段まで進むと）、Payload を MVT / Raster / Raw の Inspector に掛けた結果をここに表示します。地図をクリックして始めた Trace では、その地点の feature を選びます。"),
      );
      return;
    }
    const c = t.content;
    replaceChildren(
      el,
      h(
        "div",
        { class: "content-head" },
        h("b", {}, c.kind === "mvt" ? "MVT Inspector" : c.kind === "raster" ? "Raster Inspector" : "Raw Inspector"),
        // Raw は本文で fallback の理由を詳しく書くので、見出しでは繰り返さない
        h("span", { class: "dim" }, c.kind === "raw" ? " ← fallback" : ` ← ${c.why}`),
        h("span", { class: "dim mono" }, ` · Payload ${num(c.bytes.length)} B`),
      ),
      c.kind === "mvt" ? mvtView(c, t, ctl, preview) : c.kind === "raster" ? rasterView(c, t.tile) : rawView(c),
    );
  }
}

type MvtContent = Extract<ContentResult, { kind: "mvt" }>;

function mvtView(c: MvtContent, t: TraceView, ctl: Controller, preview: TilePreview) {
  const { mvt } = c;
  const sel = t.contentSel;
  const layer = sel.layer !== undefined ? mvt.layers[sel.layer] : undefined;
  const feature = layer && sel.feature !== undefined ? layer.features[sel.feature] : undefined;
  const issues = [...mvt.issues, ...(mvt.error ? [`+${mvt.error.offset} で読めなくなった: ${mvt.error.message}（それより前の layer は表示している）`] : [])];
  return h(
    "div",
    {},
    payloadBar(c, sel, ctl),
    issues.length ? h("ul", { class: "issues" }, issues.map((i) => h("li", {}, i))) : null,
    layerTable(mvt.layers, sel.layer, c.bytes.length, ctl),
    layer
      ? h(
          "div",
          { class: "mvt-cols" },
          h("div", { class: "mvt-list" }, featureList(layer, sel, ctl)),
          h("div", { class: "mvt-side" }, preview.render(c, sel), hitsView(c, sel, ctl)),
        )
      : null,
    layer && feature ? featureDetail(c, layer, feature, t.tile!) : layer ? h("p", { class: "note" }, "feature を一覧・プレビュー・地図のいずれかで選ぶと、properties と geometry を表示します。") : null,
    layer ? dictionary(layer) : null,
  );
}

/**
 * Payload を 1 本の byte 列として描き、layer がどこを占めているかを示す。
 * File Layout と同じ見せ方にすることで、「PMTiles の中の tile」と「tile の中の layer」が入れ子になっていることを読み取れるようにする。
 */
function payloadBar(c: MvtContent, sel: ContentSel, ctl: Controller) {
  const total = Math.max(1, c.bytes.length);
  const layer = sel.layer !== undefined ? c.mvt.layers[sel.layer] : undefined;
  const feature = layer && sel.feature !== undefined ? layer.features[sel.feature] : undefined;
  const pct = (n: number) => `${(n / total) * 100}%`;
  return h(
    "div",
    { class: "payload-bar-wrap" },
    h(
      "div",
      { class: "payload-bar" },
      c.mvt.layers.map((l) =>
        h("button", {
          class: `seg${l.index === sel.layer ? " sel" : ""}`,
          style: `left:${pct(l.span.offset)};width:${pct(l.span.length)};--c:${layerColor(l.index)}`,
          title: `${l.name}: +${num(l.span.offset)}, ${num(l.span.length)} B`,
          onclick: () => ctl.selectContentLayer(l.index),
        }),
      ),
      feature ? h("div", { class: "mark", style: `left:${pct(feature.span.offset)};width:max(2px,${pct(feature.span.length)})`, title: `feature #${feature.index}` }) : null,
    ),
    h("div", { class: "payload-bar-axis dim mono" }, h("span", {}, "+0"), h("span", {}, `+${num(c.bytes.length)}（Payload の終わり）`)),
  );
}

function layerTable(layers: MvtLayer[], selected: number | undefined, total: number, ctl: Controller) {
  return h(
    "table",
    { class: "entries layers" },
    h(
      "thead",
      {},
      h("tr", {}, ["layer", "version", "extent", "features", "keys", "values", "bytes", "内 geometry"].map((x) => h("th", {}, x))),
    ),
    h(
      "tbody",
      {},
      layers.map((l) =>
        h(
          "tr",
          { class: l.index === selected ? "sel" : "", onclick: () => ctl.selectContentLayer(l.index) },
          h("td", {}, h("span", { class: "swatch", style: `--c:${layerColor(l.index)}` }), l.name || h("i", { class: "dim" }, "(名前なし)"), l.issues.length ? h("span", { class: "warn", title: l.issues.join("\n") }, " ⚠") : null),
          h("td", { class: "mono" }, String(l.version)),
          h("td", { class: "mono" }, `${num(l.extent)}${l.extentDefaulted ? "（既定）" : ""}`),
          h("td", { class: "mono" }, num(l.features.length)),
          h("td", { class: "mono" }, num(l.keys.length)),
          h("td", { class: "mono" }, num(l.values.length)),
          h("td", { class: "mono" }, `${size(l.span.length)}（${pctText(l.span.length, total)}）`),
          // 「タイルの bytes の大半は座標」が多くの tile で成り立つ。properties の辞書化（keys / values）が効いていることの裏返し
          h("td", { class: "mono" }, pctText(l.bytes.geometry, l.span.length)),
        ),
      ),
    ),
  );
}

function featureList(layer: MvtLayer, sel: ContentSel, ctl: Controller) {
  const pages = Math.max(1, Math.ceil(layer.features.length / FEATURE_PAGE_SIZE));
  const page = Math.min(sel.page, pages - 1);
  const rows = layer.features.slice(page * FEATURE_PAGE_SIZE, (page + 1) * FEATURE_PAGE_SIZE);
  return h(
    "div",
    {},
    h(
      "div",
      { class: "tree-title" },
      `${layer.name} の features`,
      h("span", { class: "dim" }, ` ${num(layer.features.length)} 個`),
      pages > 1
        ? h(
            "span",
            { class: "pager" },
            h("button", { disabled: page === 0, onclick: () => ctl.featurePage(page - 1) }, "◀"),
            h("span", { class: "mono" }, ` ${page + 1} / ${pages} `),
            h("button", { disabled: page >= pages - 1, onclick: () => ctl.featurePage(page + 1) }, "▶"),
          )
        : null,
    ),
    h(
      "div",
      { class: "feature-table-wrap" },
      h(
        "table",
        { class: "entries" },
        h("thead", {}, h("tr", {}, ["#", "id", "type", "props", "geometry ints", "bytes"].map((x) => h("th", {}, x)))),
        h(
          "tbody",
          {},
          rows.map((f) =>
            h(
              "tr",
              { class: f.index === sel.feature ? "sel" : "", onclick: () => ctl.selectFeature(layer.index, f.index) },
              h("td", { class: "mono" }, String(f.index)),
              h("td", { class: "mono" }, f.id === undefined ? h("span", { class: "dim" }, "—") : String(f.id)),
              h("td", {}, GEOM_TYPE_NAMES[f.type] ?? `? ${f.type}`, f.issues.length ? h("span", { class: "warn", title: f.issues.join("\n") }, " ⚠") : null),
              h("td", { class: "mono" }, String(f.tags.length / 2)),
              h("td", { class: "mono" }, num(f.geometry.length)),
              h("td", { class: "mono" }, num(f.span.length)),
            ),
          ),
        ),
      ),
    ),
  );
}

/** 当たり判定の候補。点・線・面が重なっている地点では、一番上のもの以外も選び直せるようにする */
function hitsView(c: MvtContent, sel: ContentSel, ctl: Controller) {
  if (!sel.hits) return null;
  if (!sel.hits.length) return h("p", { class: "note" }, sel.pickNote ?? "クリック地点には feature がありません");
  return h(
    "div",
    { class: "hits" },
    h("div", { class: "dim small" }, `クリック地点の候補 ${sel.hits.length} 個（点 → 線 → 面の順）`),
    h(
      "ol",
      {},
      sel.hits.slice(0, 12).map((hit) => {
        const l = c.mvt.layers[hit.layer]!;
        const on = hit.layer === sel.layer && hit.feature === sel.feature;
        return h(
          "li",
          {},
          h(
            "button",
            { class: on ? "link sel" : "link", onclick: () => ctl.selectFeature(hit.layer, hit.feature) },
            h("span", { class: "swatch", style: `--c:${layerColor(hit.layer)}` }),
            `${l.name} #${hit.feature} ${GEOM_TYPE_NAMES[hit.type] ?? ""}`,
          ),
        );
      }),
    ),
  );
}

function featureDetail(c: MvtContent, layer: MvtLayer, f: MvtFeature, tile: TileRead) {
  const g = c.geometry(layer.index, f.index, f.geometry, f.type);
  const props = featureProperties(layer, f);
  return h(
    "div",
    { class: "feature-detail" },
    h(
      "div",
      { class: "tree-title" },
      `${layer.name} #${f.index}`,
      h("span", { class: "dim" }, ` ${GEOM_TYPE_NAMES[f.type] ?? f.type}${f.id !== undefined ? ` · id ${f.id}` : " · id なし"}`),
    ),
    f.issues.length || g.issues.length ? h("ul", { class: "issues" }, [...f.issues, ...g.issues].map((i) => h("li", {}, i))) : null,
    h(
      "div",
      { class: "feature-cols" },
      h(
        "div",
        {},
        h("div", { class: "sub-title" }, `Properties（tags ${f.tags.length} 個 = key と value の index の対 ${f.tags.length / 2} 組）`),
        props.length
          ? h(
              "table",
              { class: "entries props" },
              h("thead", {}, h("tr", {}, ["key", "keys[i]", "value", "values[j]", "型"].map((x) => h("th", {}, x)))),
              h(
                "tbody",
                {},
                props.map((p) =>
                  h(
                    "tr",
                    {},
                    h("td", {}, p.key ?? h("span", { class: "warn" }, "範囲外")),
                    h("td", { class: "mono dim" }, String(p.keyIndex)),
                    h("td", { class: "mono" }, p.value ? valueText(p.value) : h("span", { class: "warn" }, "範囲外")),
                    h("td", { class: "mono dim" }, String(p.valueIndex)),
                    h("td", { class: "dim" }, p.value?.type ?? ""),
                  ),
                ),
              ),
            )
          : h("p", { class: "dim" }, "properties なし"),
        h(
          "p",
          { class: "dim small" },
          "feature は key / value の文字列を持たず、layer の keys / values 辞書への index だけを持つ。同じ値を持つ feature が多いほど、辞書化で bytes が減る。",
        ),
      ),
      h("div", {}, h("div", { class: "sub-title" }, "Geometry"), geometryView(g, f), bytesView(c, f, tile)),
    ),
  );
}

function geometryView(g: DecodedGeometry, f: MvtFeature) {
  const counts = new Map<string, number>();
  for (const cmd of g.commands) counts.set(cmd.name, (counts.get(cmd.name) ?? 0) + 1);
  const exterior = g.parts.filter((p) => p.role === "exterior").length;
  const interior = g.parts.filter((p) => p.role === "interior").length;
  const shown = g.commands.slice(0, 8);
  return h(
    "div",
    {},
    h(
      "dl",
      { class: "kv" },
      h("dt", {}, "integers"),
      h("dd", { class: "mono" }, `${num(f.geometry.length)} 個 → command ${num(g.commands.length)} 個（${[...counts].map(([k, v]) => `${k} ×${v}`).join(", ")}）`),
      h("dt", {}, "頂点"),
      h("dd", { class: "mono" }, `${num(vertexCount(g))} 個 / part ${num(g.parts.length)} 個`),
      f.type === GeomType.Polygon
        ? [h("dt", {}, "ring"), h("dd", {}, `exterior ${exterior} · interior（穴）${interior} → polygon ${g.polygons.length} 個`)]
        : null,
      g.bbox ? [h("dt", {}, "bbox"), h("dd", { class: "mono" }, `(${g.bbox[0]}, ${g.bbox[1]}) – (${g.bbox[2]}, ${g.bbox[3]})`)] : null,
    ),
    h("div", { class: "dim small" }, "先頭の command（CommandInteger = id | count << 3、座標は zigzag した差分）"),
    h(
      "ol",
      { class: "commands mono" },
      shown.map((cmd) =>
        h(
          "li",
          {},
          h("span", { class: "cmd-int" }, String(f.geometry[cmd.at])),
          ` = ${cmd.name} × ${cmd.count}`,
          cmd.params.length
            ? h(
                "span",
                { class: "dim" },
                ` : ${cmd.params
                  .slice(0, 3)
                  .map((p) => `Δ(${p.dx}, ${p.dy}) → (${p.x}, ${p.y})`)
                  .join("  ")}${cmd.params.length > 3 ? ` … 他 ${cmd.params.length - 3} 点` : ""}`,
              )
            : null,
        ),
      ),
      g.commands.length > shown.length ? h("li", { class: "dim" }, `… 他 ${num(g.commands.length - shown.length)} command（command 単位の表示は Phase 8）`) : null,
    ),
  );
}

/** feature が Payload のどこにあるか。Tile Compression = none のときだけファイル上の位置と一致する */
function bytesView(c: MvtContent, f: MvtFeature, tile: TileRead) {
  const plain = tile.compression === Compression.None || tile.payload === tile.raw;
  const rows: [string, ByteSpan | undefined][] = [
    ["feature 全体", f.span],
    ["id", f.fieldSpans.id],
    ["tags", f.fieldSpans.tags],
    ["type", f.fieldSpans.type],
    ["geometry", f.fieldSpans.geometry],
  ];
  return h(
    "div",
    {},
    h("div", { class: "sub-title" }, "Payload 内の位置"),
    h(
      "table",
      { class: "entries" },
      h("thead", {}, h("tr", {}, ["field", "Payload 上", "bytes", "先頭"].map((x) => h("th", {}, x)))),
      h(
        "tbody",
        {},
        rows
          .filter((r): r is [string, ByteSpan] => !!r[1])
          .map(([name, sp]) =>
            h(
              "tr",
              {},
              h("td", {}, name),
              h("td", { class: "mono" }, `+${hexOffset(sp.offset, 6)}`),
              h("td", { class: "mono" }, num(sp.length)),
              h("td", { class: "mono dim" }, Array.from(c.bytes.subarray(sp.offset, sp.offset + Math.min(sp.length, 8)), hexByte).join(" ") + (sp.length > 8 ? " …" : "")),
            ),
          ),
      ),
    ),
    h(
      "p",
      { class: "dim small" },
      plain
        ? `Tile Compression = none なので Payload = ファイル上の bytes。feature はファイル上の ${num(tile.fileOffset + f.span.offset)} – ${num(tile.fileOffset + f.span.offset + f.span.length - 1)} にある。`
        : `Tile Compression = ${compressionName(tile.compression)} なので、Payload 上の位置はファイル上の位置と対応しない（ファイルにあるのは圧縮後の ${num(tile.raw.length)} B で、この feature だけを Range Read で取り出すことはできない）。Tile Payload パネルの解凍後の dump で該当 bytes を強調している。`,
    ),
  );
}

function dictionary(layer: MvtLayer) {
  const LIMIT = 300;
  return h(
    "details",
    { class: "dict" },
    h("summary", {}, `${layer.name} の辞書: keys ${num(layer.keys.length)} 個（${size(layer.bytes.keys)}） / values ${num(layer.values.length)} 個（${size(layer.bytes.values)}）`),
    h(
      "div",
      { class: "dict-cols" },
      h("ol", { class: "mono", start: 0 }, layer.keys.slice(0, LIMIT).map((k) => h("li", {}, k))),
      h(
        "ol",
        { class: "mono", start: 0 },
        layer.values.slice(0, LIMIT).map((v) => h("li", {}, valueText(v), h("span", { class: "dim" }, ` ${v.type}`))),
      ),
    ),
    layer.keys.length > LIMIT || layer.values.length > LIMIT ? h("p", { class: "dim small" }, `先頭 ${LIMIT} 個まで表示`) : null,
  );
}

function valueText(v: MvtValue): string {
  if (typeof v.value === "string") return JSON.stringify(v.value);
  if (v.value === undefined) return "（値なし）";
  return String(v.value);
}

function pctText(part: number, whole: number): string {
  return whole ? `${((part / whole) * 100).toFixed(1)} %` : "—";
}

function layerColor(i: number): string {
  return `var(--c-region-${(i % 4) + 1})`;
}

/**
 * タイルを tile 座標のまま canvas に描く。地図に重ねる前の「Inspector が decode した形」そのもの。
 * 全 feature を描くのは重い（数千 polygon）ので、layer の下絵は layer が変わったときだけ描き、feature の強調だけを重ねる。
 */
class TilePreview {
  private readonly canvas = h("canvas", { class: "tile-preview", title: "クリックでその位置の feature を選ぶ" });
  private base?: { key: unknown; layer: number | undefined; image: HTMLCanvasElement };
  private current?: { c: MvtContent; sel: ContentSel };
  private static readonly CSS_SIZE = 320;

  constructor(private readonly ctl: Controller) {
    this.canvas.addEventListener("click", (ev) => this.onClick(ev));
  }

  invalidate() {
    this.base = undefined;
  }

  render(c: MvtContent, sel: ContentSel) {
    this.current = { c, sel };
    const dpr = devicePixelRatio || 1;
    const px = Math.round(TilePreview.CSS_SIZE * dpr);
    if (this.canvas.width !== px) {
      this.canvas.width = this.canvas.height = px;
      this.base = undefined;
    }
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    if (this.base?.key !== c || this.base.layer !== sel.layer) this.base = { key: c, layer: sel.layer, image: this.drawBase(c, sel.layer, px, v) };
    const ctx = this.canvas.getContext("2d")!;
    ctx.clearRect(0, 0, px, px);
    ctx.drawImage(this.base.image, 0, 0);
    const layer = sel.layer !== undefined ? c.mvt.layers[sel.layer] : undefined;
    const f = layer && sel.feature !== undefined ? layer.features[sel.feature] : undefined;
    if (layer && f) {
      const g = c.geometry(layer.index, f.index, f.geometry, f.type);
      drawGeometry(ctx, g, this.transform(layer.extent, px), v("--c-feature"), 1, 2.5 * dpr, true);
    }
    return h(
      "div",
      { class: "tile-preview-wrap" },
      this.canvas,
      h("div", { class: "dim small" }, `tile 座標（0 – extent、y は下向き）。点線 = タイルの境界、外側は buffer（隣のタイルとの継ぎ目のため、境界の外にも座標がある）`),
    );
  }

  /** 表示範囲はタイルの外側 1/16 まで。buffer に入った座標を見せつつ、タイルを大きく描くため */
  private transform(extent: number, px: number) {
    const pad = extent / 16;
    const scale = px / (extent + 2 * pad);
    return (x: number, y: number): [number, number] => [(x + pad) * scale, (y + pad) * scale];
  }

  private drawBase(c: MvtContent, selected: number | undefined, px: number, v: (n: string) => string): HTMLCanvasElement {
    const img = document.createElement("canvas");
    img.width = img.height = px;
    const ctx = img.getContext("2d")!;
    ctx.fillStyle = v("--bg");
    ctx.fillRect(0, 0, px, px);
    const dpr = devicePixelRatio || 1;
    // 選んでいない layer は薄く、選んだ layer を上に重ねる
    const order = [...c.mvt.layers].sort((a, b) => Number(a.index === selected) - Number(b.index === selected));
    for (const layer of order) {
      const tr = this.transform(layer.extent, px);
      const on = layer.index === selected;
      const color = v(`--c-region-${(layer.index % 4) + 1}`);
      for (const f of layer.features) drawGeometry(ctx, c.geometry(layer.index, f.index, f.geometry, f.type), tr, color, on ? 0.75 : 0.25, on ? 1 : 0.6, false, dpr);
    }
    const layer0 = c.mvt.layers[selected ?? 0];
    if (layer0) {
      const tr = this.transform(layer0.extent, px);
      const [x0, y0] = tr(0, 0);
      const [x1, y1] = tr(layer0.extent, layer0.extent);
      ctx.setLineDash([4 * dpr, 4 * dpr]);
      ctx.strokeStyle = v("--dim");
      ctx.lineWidth = dpr;
      ctx.strokeRect(x0, y0, x1 - x0, y1 - y0);
      ctx.setLineDash([]);
    }
    return img;
  }

  private onClick(ev: MouseEvent) {
    const cur = this.current;
    if (!cur) return;
    const layer = cur.c.mvt.layers[cur.sel.layer ?? 0];
    if (!layer) return;
    const r = this.canvas.getBoundingClientRect();
    // canvas 上の位置 → tile 座標 → タイル幅に対する割合（地図のクリックと同じ入力の形にそろえる）
    const pad = 1 / 16;
    const k = 1 + 2 * pad;
    const fx = ((ev.clientX - r.left) / r.width) * k - pad;
    const fy = ((ev.clientY - r.top) / r.height) * k - pad;
    this.ctl.pickFeature({ fx, fy, tolerance: (5 / r.width) * k });
  }
}

function drawGeometry(
  ctx: CanvasRenderingContext2D,
  g: DecodedGeometry,
  tr: (x: number, y: number) => [number, number],
  color: string,
  alpha: number,
  lineWidth: number,
  emphasis: boolean,
  dpr = devicePixelRatio || 1,
) {
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = lineWidth;
  if (g.type === GeomType.Point) {
    const r = (emphasis ? 5 : 2) * dpr;
    for (const p of g.parts) for (const [x, y] of p.points) {
      const [cx, cy] = tr(x, y);
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    const path = new Path2D();
    for (const part of g.parts) {
      part.points.forEach(([x, y], i) => {
        const [cx, cy] = tr(x, y);
        if (i === 0) path.moveTo(cx, cy);
        else path.lineTo(cx, cy);
      });
      if (part.closed) path.closePath();
    }
    if (g.type === GeomType.Polygon) {
      // 穴は exterior と逆回りなので、nonzero の塗りで自然に抜ける（MVT の巻き方向の規則が効いている）
      ctx.globalAlpha = alpha * (emphasis ? 0.35 : 0.3);
      ctx.fill(path, "nonzero");
      ctx.globalAlpha = alpha;
    }
    ctx.stroke(path);
  }
  ctx.globalAlpha = 1;
}

function rasterView(c: Extract<ContentResult, { kind: "raster" }>, tile: TileRead) {
  const { info } = c;
  // 寸法の field が info.fields に無い形式（PNG / JPEG / WebP）は、sizeSpans から表の行を作る
  const sizeRows = info.fields.some((f) => f.span.offset === info.sizeSpans[0]?.offset)
    ? []
    : // inspectRaster は 2 つに分かれている形式では width → height の順に積む
      info.sizeSpans.map((sp, i) => ({ label: info.sizeSpans.length === 2 ? (i === 0 ? "Width" : "Height") : "Width / Height", value: info.sizeSpans.length === 2 ? String(i === 0 ? info.width : info.height) : `${info.width} × ${info.height}`, span: sp }));
  const img = h("img", { class: "raster-preview", alt: "tile preview" });
  const decoded = h("span", { class: "dim" }, "ブラウザで decode 中…");
  const url = URL.createObjectURL(new Blob([c.bytes as BlobPart], { type: c.mime }));
  img.addEventListener("load", () => {
    const ok = img.naturalWidth === info.width && img.naturalHeight === info.height;
    replaceChildren(decoded, h("span", { class: ok ? "ok" : "warn" }, `${img.naturalWidth} × ${img.naturalHeight}`), ok ? " ✓ header の値と一致" : " ⚠ header の値と違う");
    URL.revokeObjectURL(url);
  });
  img.addEventListener("error", () => {
    replaceChildren(decoded, h("span", { class: "warn" }, `このブラウザは ${c.mime} を decode できない`));
    URL.revokeObjectURL(url);
  });
  img.src = url;
  return h(
    "div",
    { class: "raster-cols" },
    h(
      "div",
      {},
      h(
        "dl",
        { class: "kv" },
        h("dt", {}, "Format"),
        h("dd", {}, `${info.format.toUpperCase()}${info.variant ? ` · ${info.variant}` : ""}`),
        h("dt", {}, "Encoded size"),
        h("dd", { class: "mono" }, `${num(c.bytes.length)} B（${size(c.bytes.length)}）${tile.compression === Compression.None ? "" : ` · ファイル上は ${compressionName(tile.compression)} 後の ${num(tile.raw.length)} B`}`),
        h("dt", {}, "Width × Height（header）"),
        h("dd", { class: "mono" }, info.width !== undefined ? `${info.width} × ${info.height}` : "読めない"),
        h("dt", {}, "Width × Height（ブラウザ）"),
        h("dd", { class: "mono" }, decoded),
      ),
      info.issues.length ? h("ul", { class: "issues" }, info.issues.map((i) => h("li", {}, i))) : null,
      h("div", { class: "sub-title" }, "header のどの bytes から読んだか（Payload 先頭からの位置）"),
      h(
        "table",
        { class: "entries" },
        h("thead", {}, h("tr", {}, ["項目", "値", "Payload 上", "bytes"].map((x) => h("th", {}, x)))),
        h(
          "tbody",
          {},
          [...sizeRows, ...info.fields].map((f) => h("tr", {}, h("td", {}, f.label), h("td", { class: "mono" }, String(f.value)), spanCells(c.bytes, f.span))),
        ),
      ),
      h("p", { class: "dim small" }, "画素は decode していない。寸法は形式ごとの header（PNG の IHDR、JPEG の SOF、WebP の VP8 / VP8L / VP8X、AVIF の ispe / clap / irot）から読み、preview はブラウザの decoder に任せている。"),
    ),
    h("div", { class: "raster-preview-wrap" }, img),
  );
}

function spanCells(bytes: Uint8Array, sp: ByteSpan) {
  return [h("td", { class: "mono" }, `+${hexOffset(sp.offset, 6)}`), h("td", { class: "mono dim" }, Array.from(bytes.subarray(sp.offset, sp.offset + Math.min(sp.length, 16)), hexByte).join(" "))];
}

function rawView(c: Extract<ContentResult, { kind: "raw" }>) {
  const sn = sniff(c.bytes);
  return h(
    "div",
    {},
    h("p", {}, `Raw Inspector に fallback: ${c.why}`),
    h("p", { class: "dim" }, `先頭 bytes からの推定: ${sn.kind}（${sn.reason}）。bytes は Tile Payload パネルの dump で確認できる。`),
    sn.kind === "text" ? h("pre", { class: "text-preview" }, new TextDecoder().decode(c.bytes.subarray(0, 600))) : null,
  );
}
