import type { PmtilesArchive } from "../../core/pmtiles/archive";
import { entryTileIdRange } from "../../core/pmtiles/lookup";
import { alignedBlock, hilbertXyToIndex, MAX_ZOOM, zoomBase } from "../../core/pmtiles/tileid";
import { HILBERT_MAX_WINDOW_ZOOM, type Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { num } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { classifyTile, rootLeafOrdinals, type TileClass } from "../tile-class";
import { buildTraceSteps, directoryStepAt } from "../trace-steps";

/** canvas の論理サイズ（CSS px）。2^8 マスで 1 マス 2px になる */
const CANVAS_PX = 512;
/** 担当 directory の色の数。隣り合う leaf を見分けられれば足りるので、検証済みの 4 色を順に使う */
const REGION_COLORS = 4;

interface Grid {
  z: number;
  /** 描いている窓（ズーム z の整列ブロック） */
  block: ReturnType<typeof alignedBlock>;
  /** 窓内のマス（行優先: index = (y - y0) * size + (x - x0)） */
  tileIds: Float64Array;
  classes: TileClass[];
  /** 窓内で Hilbert 順に並べたマスの index（曲線を描く順） */
  order: Uint32Array;
  inZoomRange: boolean;
}

/**
 * ズーム z のタイル grid に Hilbert 曲線を重ね、各マスを担当 directory で色分けする。
 *
 * 色分けの狙い: leaf は「連続する TileID の区間」を受け持つので、Hilbert 曲線の性質により
 * 地図上ではひとかたまりの領域になる。TileID の近さ ↔ 地理的な近さ を面として見せる。
 */
export function mountHilbertViewer(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  const canvas = h("canvas", { class: "hilbert-canvas" });
  const base = document.createElement("canvas");
  const info = h("div", { class: "hilbert-info" });
  const controls = h("div", { class: "hilbert-controls" });
  let grid: Grid | undefined;
  let gridKey = "";
  let hover: { x: number; y: number } | undefined;

  canvas.addEventListener("mousemove", (ev) => {
    const cell = cellAt(ev);
    if (cell?.x !== hover?.x || cell?.y !== hover?.y) {
      hover = cell;
      drawOverlay(store.get());
      renderInfo(store.get());
    }
  });
  canvas.addEventListener("mouseleave", () => {
    hover = undefined;
    drawOverlay(store.get());
    renderInfo(store.get());
  });
  canvas.addEventListener("click", (ev) => {
    const cell = cellAt(ev);
    if (cell && grid) void ctl.traceTile(grid.z, cell.x, cell.y);
  });
  // テーマが変わったら色を読み直して描き直す（canvas は CSS 変数の変化を自動では反映しない）
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    gridKey = "";
    render(store.get());
  });

  store.subscribe((s, prev) => {
    if (
      s.archive !== prev.archive ||
      s.hilbertZoom !== prev.hilbertZoom ||
      s.hilbertCurve !== prev.hilbertCurve ||
      s.trace !== prev.trace ||
      // leaf が読まれると「未読」だったマスの分類が変わる。Directory Viewer で展開した場合は trace が変わらないので、read も合図にする
      s.reads.length !== prev.reads.length ||
      s.dirView !== prev.dirView
    )
      render(s);
  });

  function render(s: AppState) {
    const { archive } = s;
    if (!archive) {
      grid = undefined;
      gridKey = "";
      replaceChildren(el, h("p", { class: "empty" }, "ズームごとのタイル grid に Hilbert 曲線を重ね、z/x/y・Hilbert index・TileID の関係を示します。"));
      return;
    }
    const z = s.hilbertZoom;
    const k = Math.min(z, HILBERT_MAX_WINDOW_ZOOM);
    const focus = focusTile(s, z);
    const block = alignedBlock(z, focus.x, focus.y, k);
    const key = [z, block.x0, block.y0, s.hilbertCurve, archive.loadedLeafCount].join(":");
    if (!grid || gridKey !== key || grid.z !== z) {
      grid = buildGrid(archive, z, block);
      gridKey = key;
      drawBase(s);
    }
    renderControls(s);
    drawOverlay(s);
    renderInfo(s);
    if (!el.contains(canvas)) replaceChildren(el, controls, h("div", { class: "hilbert-layout" }, h("div", { class: "hilbert-canvas-wrap" }, canvas), info));
  }

  function renderControls(s: AppState) {
    const archive = s.archive!;
    const hz = archive.header;
    // 描画できるズームは tileid の上限まで。ただし archive にタイルが無いズームは既定の選択肢から外しすぎないよう、少し先まで出す
    const maxZ = Math.min(MAX_ZOOM, Math.max(hz.maxZoom + 1, 4));
    const zSel = h(
      "select",
      { onchange: (ev: Event) => ctl.setHilbertZoom(Number((ev.target as HTMLSelectElement).value)) },
      Array.from({ length: maxZ + 1 }, (_, z) => {
        const o = h("option", { value: z }, `z = ${z}${z < hz.minZoom || z > hz.maxZoom ? "（範囲外）" : ""}`);
        o.selected = z === s.hilbertZoom;
        return o;
      }),
    );
    const n = 2 ** s.hilbertZoom;
    const curve = h("input", { type: "checkbox", onchange: (ev: Event) => ctl.setHilbertCurve((ev.target as HTMLInputElement).checked) });
    curve.checked = s.hilbertCurve;
    replaceChildren(
      controls,
      h("label", {}, "ズーム ", zSel),
      h("span", { class: "dim mono" }, `${num(n)} × ${num(n)} = ${num(n * n)} タイル`),
      h("label", {}, curve, " Hilbert 曲線を重ねる"),
      grid && !grid.inZoomRange
        ? h("span", { class: "note-inline" }, `z = ${s.hilbertZoom} は Header の Min/Max Zoom（${hz.minZoom}〜${hz.maxZoom}）の範囲外。この archive はこのズームのタイルを持たないので塗りはない（TileID の計算は可能）`)
        : null,
      grid && grid.block.size < n
        ? h(
            "span",
            { class: "note-inline" },
            `全体は描けないので、${s.trace ? "選択タイル" : "左上"}を含む ${grid.block.size}×${grid.block.size} の整列ブロック（x ${num(grid.block.x0)}〜, y ${num(grid.block.y0)}〜）だけを表示。この中の TileID は ${num(grid.block.firstTileId)}〜${num(grid.block.lastTileId)} の連続区間`,
          )
        : null,
    );
  }

  function drawBase(s: AppState) {
    const g = grid!;
    const dpr = Math.max(1, Math.round(globalThis.devicePixelRatio || 1));
    for (const c of [canvas, base]) {
      c.width = CANVAS_PX * dpr;
      c.height = CANVAS_PX * dpr;
    }
    canvas.style.aspectRatio = "1";
    const ctx = base.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(el);
    const col = (name: string) => css.getPropertyValue(name).trim();
    const regions = Array.from({ length: REGION_COLORS }, (_, i) => col(`--c-region-${i + 1}`));
    const rootTile = col("--c-tile");
    const surface = col("--panel");
    const line = col("--line");
    const ink = col("--text");

    const size = g.block.size;
    const cell = CANVAS_PX / size;
    ctx.fillStyle = surface;
    ctx.fillRect(0, 0, CANVAS_PX, CANVAS_PX);

    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        const c = g.classes[j * size + i]!;
        if (!g.inZoomRange || c.state === "none") continue;
        ctx.fillStyle = c.region < 0 ? rootTile : regions[c.region % REGION_COLORS]!;
        // 濃さで状態を表す: タイルあり = 濃い / 未読 leaf = 中間 / leaf 内に無い = ごく薄い（担当範囲だけは見える）
        ctx.globalAlpha = c.state === "tile" ? 0.85 : c.state === "unloaded" ? 0.35 : 0.1;
        ctx.fillRect(i * cell, j * cell, cell, cell);
      }
    }
    ctx.globalAlpha = 1;

    // マス目。細かすぎると面が罫線で埋まるので、1 マスが十分大きいときだけ引く
    if (cell >= 6) {
      ctx.strokeStyle = line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 0; i <= size; i++) {
        const p = Math.round(i * cell) + 0.5;
        ctx.moveTo(p, 0);
        ctx.lineTo(p, CANVAS_PX);
        ctx.moveTo(0, p);
        ctx.lineTo(CANVAS_PX, p);
      }
      ctx.stroke();
    }

    // 担当 directory の境界。色だけに頼らず（色覚特性・隣接色の近さ対策）境界線でも leaf の区切りを示す
    if (g.inZoomRange && cell >= 2) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = cell >= 6 ? 2 : 1;
      ctx.beginPath();
      const regionAt = (i: number, j: number) => {
        const c = g.classes[j * size + i]!;
        return c.state === "none" ? -2 : c.region;
      };
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          const r = regionAt(i, j);
          if (i + 1 < size && regionAt(i + 1, j) !== r) {
            ctx.moveTo((i + 1) * cell, j * cell);
            ctx.lineTo((i + 1) * cell, (j + 1) * cell);
          }
          if (j + 1 < size && regionAt(i, j + 1) !== r) {
            ctx.moveTo(i * cell, (j + 1) * cell);
            ctx.lineTo((i + 1) * cell, (j + 1) * cell);
          }
        }
      }
      ctx.globalAlpha = 0.55;
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    if (s.hilbertCurve) {
      ctx.strokeStyle = ink;
      ctx.lineWidth = size <= 16 ? 2 : 1;
      ctx.globalAlpha = size <= 64 ? 0.7 : 0.35;
      ctx.beginPath();
      g.order.forEach((idx, n) => {
        const cx = ((idx % size) + 0.5) * cell;
        const cy = (Math.floor(idx / size) + 0.5) * cell;
        if (n === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      });
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 始点を示す。曲線がどこから始まるか分からないと「順番」として読めない
      if (size <= 64) {
        const first = g.order[0]!;
        ctx.fillStyle = ink;
        ctx.beginPath();
        ctx.arc(((first % size) + 0.5) * cell, (Math.floor(first / size) + 0.5) * cell, Math.max(3, cell / 6), 0, Math.PI * 2);
        ctx.fill();
      }
    }
  }

  function drawOverlay(s: AppState) {
    if (!grid) return;
    const g = grid;
    const ctx = canvas.getContext("2d")!;
    const dpr = canvas.width / CANVAS_PX;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const css = getComputedStyle(el);
    const size = g.block.size;
    const cell = CANVAS_PX / size;

    // 今の Trace 段が指している TileID の区間（候補 entry の担当範囲）を重ねる。
    // 塗りだけだと下の leaf の色と混ざって別の色に見えるので、薄い塗り + 区間の輪郭線で示す
    const range = traceRange(s);
    if (range) {
      const target = css.getPropertyValue("--c-target").trim();
      const inside = (i: number, j: number) => {
        if (i < 0 || j < 0 || i >= size || j >= size) return false;
        const t = g.tileIds[j * size + i]!;
        return t >= range.start && t < range.end;
      };
      ctx.fillStyle = target;
      ctx.globalAlpha = 0.2;
      for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) if (inside(i, j)) ctx.fillRect(i * cell, j * cell, cell, cell);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = target;
      ctx.lineWidth = 2.5;
      ctx.beginPath();
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          if (!inside(i, j)) continue;
          if (!inside(i - 1, j)) (ctx.moveTo(i * cell, j * cell), ctx.lineTo(i * cell, (j + 1) * cell));
          if (!inside(i + 1, j)) (ctx.moveTo((i + 1) * cell, j * cell), ctx.lineTo((i + 1) * cell, (j + 1) * cell));
          if (!inside(i, j - 1)) (ctx.moveTo(i * cell, j * cell), ctx.lineTo((i + 1) * cell, j * cell));
          if (!inside(i, j + 1)) (ctx.moveTo(i * cell, (j + 1) * cell), ctx.lineTo((i + 1) * cell, (j + 1) * cell));
        }
      }
      ctx.stroke();
    }

    const outline = (x: number, y: number, color: string, w: number) => {
      const i = x - g.block.x0;
      const j = y - g.block.y0;
      if (i < 0 || j < 0 || i >= size || j >= size) return;
      // 高ズームでは 1 マスが 2px しかないので、枠は最低 12px 四方にして見失わないようにする
      const box = Math.max(cell, 12);
      const off = (box - cell) / 2;
      ctx.strokeStyle = color;
      ctx.lineWidth = w;
      ctx.strokeRect(i * cell - off, j * cell - off, box, box);
    };
    const a = s.trace?.lookup.address;
    if (a && a.z === g.z) outline(a.x, a.y, css.getPropertyValue("--sel").trim(), 3);
    if (hover) outline(hover.x, hover.y, css.getPropertyValue("--text").trim(), 2);
  }

  function renderInfo(s: AppState) {
    const archive = s.archive;
    if (!archive || !grid) return;
    const g = grid;
    const a = s.trace?.lookup.address;
    const target = hover ?? (a && a.z === g.z ? { x: a.x, y: a.y } : undefined);
    const z = g.z;
    const title = hover ? "カーソル位置" : "Trace 中のタイル";
    let detail: HTMLElement;
    if (!target) {
      detail = h("p", { class: "dim" }, "マスにカーソルを載せると z/x/y・Hilbert index・TileID を、クリックするとそのタイルの Tile Trace を表示します。");
    } else {
      const d = hilbertXyToIndex(z, target.x, target.y);
      const zb = zoomBase(z);
      const n = g.tileIds.length ? (target.y - g.block.y0) * g.block.size + (target.x - g.block.x0) : -1;
      const cls = g.classes[n];
      detail = h(
        "div",
        {},
        h("div", { class: "tree-title" }, title),
        h(
          "dl",
          { class: "addr-dl" },
          h("dt", {}, "z / x / y"),
          h("dd", { class: "mono" }, `${z} / ${target.x} / ${target.y}`),
          h("dt", {}, "ズーム内 Hilbert index"),
          h("dd", { class: "mono" }, `d = ${num(d)}`, h("span", { class: "dim" }, `（z=${z} の 0〜${num(4 ** z - 1)} の中で）`)),
          h("dt", {}, "zoomBase(z)"),
          h("dd", { class: "mono" }, `(4^${z} − 1) / 3 = ${num(zb)}`, h("span", { class: "dim" }, `（z0〜${z - 1} のタイル総数）`)),
          h("dt", {}, "Global TileID"),
          h("dd", { class: "mono strong" }, `${num(zb)} + ${num(d)} = ${num(zb + d)}`),
          h("dt", {}, "担当"),
          h("dd", {}, g.inZoomRange ? classText(cls) : `z=${z} は Min/Max Zoom（${archive.header.minZoom}〜${archive.header.maxZoom}）の範囲外`),
        ),
      );
    }
    replaceChildren(info, detail, legend(archive));
  }

  function cellAt(ev: MouseEvent): { x: number; y: number } | undefined {
    if (!grid) return undefined;
    const r = canvas.getBoundingClientRect();
    const size = grid.block.size;
    const i = Math.floor(((ev.clientX - r.left) / r.width) * size);
    const j = Math.floor(((ev.clientY - r.top) / r.height) * size);
    if (i < 0 || j < 0 || i >= size || j >= size) return undefined;
    return { x: grid.block.x0 + i, y: grid.block.y0 + j };
  }
}

function buildGrid(archive: PmtilesArchive, z: number, block: ReturnType<typeof alignedBlock>): Grid {
  const size = block.size;
  const tileIds = new Float64Array(size * size);
  const classes: TileClass[] = new Array(size * size);
  const order = new Uint32Array(size * size);
  const ordinals = rootLeafOrdinals(archive);
  const base = zoomBase(z);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const n = j * size + i;
      const t = base + hilbertXyToIndex(z, block.x0 + i, block.y0 + j);
      tileIds[n] = t;
      classes[n] = classifyTile(archive, t, ordinals);
      // 整列ブロック内の TileID は連続区間なので、先頭との差がそのまま曲線上の順番になる
      order[t - block.firstTileId] = n;
    }
  }
  const hz = archive.header;
  return { z, block, tileIds, classes, order, inZoomRange: z >= hz.minZoom && z <= hz.maxZoom };
}

/** 窓の基準にするタイル。Trace 中ならそのタイル（別ズームならそのズームへ投影した位置） */
function focusTile(s: AppState, z: number): { x: number; y: number } {
  const a = s.trace?.lookup.address;
  if (!a) return { x: 0, y: 0 };
  const scale = 2 ** (z - a.z);
  return { x: Math.floor(a.x * scale), y: Math.floor(a.y * scale) };
}

/**
 * 今の Trace 段が注目している TileID の区間。
 * - z/x/y 〜 TileID の段: そのタイル 1 つ
 * - directory 探索の段: 候補 entry が担当する区間（leaf なら leaf 全体、tile なら run）
 */
function traceRange(s: AppState): { start: number; end: number } | undefined {
  const t = s.trace;
  if (!t) return undefined;
  const steps = buildTraceSteps(t.lookup);
  const cur = steps[t.step];
  if (!cur) return undefined;
  if (cur.kind !== "directory" && cur.kind !== "result") return { start: t.lookup.address.tileId, end: t.lookup.address.tileId + 1 };
  const ds = directoryStepAt(steps, t.step);
  if (!ds) return undefined;
  // 親 directory から受け継いだ上限。leaf の最後の entry の担当範囲を正しく閉じるため、root から順に絞り込む
  let upper = Infinity;
  for (const s2 of steps.slice(0, ds.index + 1)) {
    if (s2.kind !== "directory") continue;
    const ci = s2.step.search.candidateIndex;
    if (ci === undefined) return undefined;
    const r = entryTileIdRange(s2.step.directory.decoded.entries, ci, upper);
    if (s2 === steps[ds.index]) return s2.step.search.outcome === "outside-run" ? undefined : r;
    upper = r.end;
  }
  return undefined;
}

function classText(c: TileClass | undefined): string {
  if (!c) return "—";
  const parts = c.path.map((p, i) => `${i === 0 ? "Root" : "Leaf"} entry #${num(p.index)}`);
  const via = parts.join(" → ");
  switch (c.state) {
    case "tile":
      return `${via} → タイルあり`;
    case "miss":
      return `${via} の担当範囲だが tile entry が無い → タイル無し`;
    case "unloaded":
      return `${via} が指す leaf（未読）の担当範囲。有無は leaf を読むまで分からない`;
    case "none":
      return c.path.length ? `${via} の run の範囲外 → タイル無し` : "Root の先頭 entry より前 → タイル無し";
  }
}

function legend(archive: PmtilesArchive) {
  const leafCount = archive.root.decoded.entries.filter((e) => e.runLength === 0).length;
  return h(
    "div",
    { class: "hilbert-legend" },
    h("div", { class: "tree-title" }, "色の意味"),
    h("div", {}, h("span", { class: "swatch", style: "background:var(--c-tile)" }), "Root の tile entry が直接指すタイル"),
    leafCount
      ? h(
          "div",
          {},
          Array.from({ length: Math.min(REGION_COLORS, leafCount) }, (_, i) => h("span", { class: "swatch", style: `background:var(--c-region-${i + 1})` })),
          `Leaf ごとの担当範囲（Root の leaf entry ${num(leafCount)} 個を順に 4 色で塗り分け、境界に線）`,
        )
      : h("div", { class: "dim" }, "この archive には leaf directory がありません（Root だけで全タイルを指す）"),
    leafCount ? h("div", { class: "dim" }, "濃い = タイルあり / 中間 = leaf 未読で有無不明 / ごく薄い = leaf 内に entry が無い") : null,
    h("div", {}, h("span", { class: "swatch", style: "background:var(--c-target);opacity:.6" }), "Tile Trace の今の段が注目している TileID の区間"),
    h("div", { class: "dim" }, "x は西 → 東、y は北 → 南（y = 0 が北端）。黒丸が曲線の始点"),
  );
}
