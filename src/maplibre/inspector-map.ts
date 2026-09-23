import { Map as MlMap, setWorkerUrl, type GeoJSONSource, type LayerSpecification, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import type { Feature, FeatureCollection } from "geojson";
import type { PmtilesArchive } from "../core/pmtiles/archive";
import { MAX_ZOOM, type TileBlock } from "../core/pmtiles/tileid";
import { ARCHIVE_SOURCE, archiveStyle, TILE_SIZE, type ArchiveStyle } from "./archive-style";
import { registerArchive, unregisterArchive, type MapTileOutcome } from "./protocol";
import { blocksPolygon, lngLatToTile, rectRing, tileBounds, tileCenter, tilePolygon, type TileXYZ } from "./tile-geometry";

/**
 * PMTiles Internals Viewer 用の地図。
 *
 * Viewer の store や UI を知らない独立したクラスにしてある（入力は archive とタイル座標、出力はコールバックだけ）。
 * 将来 MapLibre Tile Inspector として切り出すときに、この層と tile-overlay 系だけを持ち出せるようにするため。
 */

export interface InspectorMapColors {
  selected: string;
  hover: string;
  region: string;
  grid: string;
  text: string;
  halo: string;
  /** vector の source-layer ごとの色 */
  palette: string[];
  basemap: { background: string; land: string; border: string; label: string };
}

export interface MapViewInfo {
  mapZoom: number;
  /** 地図が今このソースに要求しているタイルの z（minZoom 未満ならソースはタイルを要求しないので undefined） */
  tileZ?: number;
  /** 画面を覆うタイルの枚数（世界の複製を含む） */
  tiles: number;
  /** maxZoom を超えて拡大している（maxZoom のタイルを引き伸ばして描いている） */
  overzoomed: boolean;
}

export interface InspectorMapOptions {
  colors: InspectorMapColors;
  onTileClick(t: TileXYZ): void;
  onTileHover(t: TileXYZ | undefined): void;
  onView(info: MapViewInfo): void;
  onTileError(message: string): void;
  /** 地図が archive に要求したタイル 1 枚ごとの結末（archive に無いタイルは read を起こさないので、read の記録とは別に数える） */
  onTileRequest?(outcome: MapTileOutcome): void;
}

/** 背景地図。国境と海岸線だけの軽いデモ用 style（API キー不要）。archive の中身が主役のまま、場所の手がかりにする */
const BASEMAP_STYLE_URL = "https://demotiles.maplibre.org/style.json";
/** 背景地図の中で archive のレイヤより上に残すもの（国境と地名は archive の raster に隠れると場所が分からなくなる） */
const BASEMAP_ABOVE = "countries-boundary";
const LABEL_FONT = ["Open Sans Semibold"];

// MapLibre 6 は自分の import.meta.url から worker の場所を求めるが、Vite が依存を事前バンドルするとその位置がずれて読めなくなる。
// worker を（依存する shared chunk ごと）Vite にバンドルさせ、その URL を明示的に渡す
setWorkerUrl(workerUrl);

const OVERLAY = {
  region: "pi-region",
  grid: "pi-grid",
  selected: "pi-selected",
  hover: "pi-hover",
} as const;

type PaintProp = Parameters<MlMap["setPaintProperty"]>[1];

const EMPTY: FeatureCollection = { type: "FeatureCollection", features: [] };

export class InspectorMap {
  /** 背景地図の style を読んでから作るので、ready を待つまでは未設定 */
  private map!: MlMap;
  private readonly ready: Promise<void>;
  private colors: InspectorMapColors;
  private current?: { archive: PmtilesArchive; regId: string; style: ArchiveStyle };
  private hasGlyphs = false;
  private hoverKey = "";
  private gridFrame = 0;

  constructor(container: HTMLElement, private readonly opts: InspectorMapOptions) {
    this.colors = opts.colors;
    this.ready = this.init(container);
  }

  private async init(container: HTMLElement) {
    const style = await loadBasemap(this.colors);
    this.hasGlyphs = !!style.glyphs;
    this.map = new MlMap({
      container,
      style,
      center: [0, 20],
      zoom: 0.3,
      // 回転・傾きを止める。傾けると画面の奥ほど低いズームのタイルが混ざり、「地図のズーム = タイルの z」の対応が崩れるため
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
      maxPitch: 0,
      attributionControl: { compact: true },
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    await new Promise<void>((res) => this.map.once("load", () => res()));
    this.addOverlay();

    const map = this.map;
    map.on("move", () => this.scheduleGrid());
    map.on("click", (e) => {
      const z = this.tileZoomAt();
      if (z !== undefined) this.opts.onTileClick(lngLatToTile(e.lngLat.lng, e.lngLat.lat, z));
    });
    map.on("mousemove", (e) => {
      const z = this.tileZoomAt();
      const t = z === undefined ? undefined : lngLatToTile(e.lngLat.lng, e.lngLat.lat, z);
      const key = t ? `${t.z}/${t.x}/${t.y}` : "";
      if (key === this.hoverKey) return;
      this.hoverKey = key;
      this.opts.onTileHover(t);
    });
    map.getCanvas().addEventListener("mouseleave", () => {
      this.hoverKey = "";
      this.opts.onTileHover(undefined);
    });
    map.on("error", (e) => {
      const { error: err, sourceId } = e as unknown as { error?: { name?: string; message: string }; sourceId?: string };
      // パンで不要になった要求の中断は失敗ではない
      if (sourceId === ARCHIVE_SOURCE && err && err.name !== "AbortError") this.opts.onTileError(err.message);
    });
  }

  /** archive を差し替える。metadata は vector の layer 名と attribution に使う */
  async setArchive(archive: PmtilesArchive | undefined, metadata: unknown): Promise<ArchiveStyle | undefined> {
    await this.ready;
    this.removeArchive();
    if (!archive) {
      this.scheduleGrid();
      return undefined;
    }
    const { id, tilesUrl } = registerArchive(archive, this.opts.onTileRequest);
    const style = archiveStyle(archive.header, metadata, tilesUrl, this.colors.palette);
    this.current = { archive, regId: id, style };
    if (style.source) {
      this.map.addSource(ARCHIVE_SOURCE, style.source);
      const before = this.map.getLayer(BASEMAP_ABOVE) ? BASEMAP_ABOVE : OVERLAY.region + "-fill";
      for (const l of style.layers) this.map.addLayer(l, before);
    }
    // Header の center / center zoom は「この archive を最初に見せる位置」として spec が定めたもの
    const h = archive.header;
    this.map.jumpTo({ center: [h.centerLon, h.centerLat], zoom: Math.min(h.centerZoom, h.maxZoom) + 0.3 });
    this.scheduleGrid();
    // 帰属表示は MapLibre が最初は開いた状態で出す。terrarium のように長い帰属表示だと地図を覆うので、描き終えたら畳む（ⓘ で開ける）
    this.map.once("idle", () => {
      const attrib = this.map.getContainer().querySelector(".maplibregl-ctrl-attrib.maplibregl-compact");
      attrib?.classList.remove("maplibregl-compact-show");
      attrib?.removeAttribute("open");
    });
    return style;
  }

  private removeArchive() {
    const cur = this.current;
    if (!cur) return;
    for (const l of cur.style.layers) if (this.map.getLayer(l.id)) this.map.removeLayer(l.id);
    if (this.map.getSource(ARCHIVE_SOURCE)) this.map.removeSource(ARCHIVE_SOURCE);
    unregisterArchive(cur.regId);
    this.current = undefined;
  }

  /** Tile Trace 中のタイルと、今の段が注目している TileID 区間（整列ブロックの並び） */
  async setSelection(tile: TileXYZ | undefined, region: TileBlock[]) {
    await this.ready;
    this.src(OVERLAY.selected).setData(tile ? { type: "FeatureCollection", features: [tilePolygon(tile)] } : EMPTY);
    this.src(OVERLAY.region).setData(region.length ? { type: "FeatureCollection", features: [blocksPolygon(region)] } : EMPTY);
  }

  /** Hilbert Viewer など、地図の外でカーソルが載っているタイル */
  async setHover(tile: TileXYZ | undefined) {
    await this.ready;
    this.src(OVERLAY.hover).setData(tile ? { type: "FeatureCollection", features: [tilePolygon(tile)] } : EMPTY);
  }

  /**
   * タイルが見える位置へ地図を動かす。すでに同じ z のタイルとして画面内に見えていれば動かさない
   * （地図をクリックして Trace したときに地図が勝手に動くと、どこをクリックしたか見失うため）。
   */
  async showTile(t: TileXYZ) {
    await this.ready;
    const center = tileCenter(t);
    if (this.tileZoomAt() === t.z && this.tileOnScreen(t)) return;
    // z + 0.3 なら vector（floor）でも raster（round）でも要求されるタイルの z がちょうど t.z になる
    this.map.easeTo({ center, zoom: Math.min(t.z + 0.3, 24), duration: 700 });
  }

  /** タイルの一部でも画面に見えているか。低ズームのタイルは画面より大きく、中心が画面外でもクリックできるため中心では判定しない */
  private tileOnScreen(t: TileXYZ): boolean {
    const v = this.map.getBounds();
    // 画面が経度 ±180° を越えて世界の複製を映していることがあるので、前後の複製とも比べる
    return [-1, 0, 1].some((wrap) => {
      const [w, s, e, n] = tileBounds(t.z, t.x, t.y, 1, wrap);
      return w < v.getEast() && e > v.getWest() && s < v.getNorth() && n > v.getSouth();
    });
  }

  async setColors(colors: InspectorMapColors) {
    this.colors = colors;
    await this.ready;
    for (const [layer, prop, value] of basemapPaint(colors)) if (this.map.getLayer(layer)) this.map.setPaintProperty(layer, prop as PaintProp, value);
    for (const l of overlayLayers(colors, this.hasGlyphs)) {
      for (const [k, v] of Object.entries((l as { paint?: Record<string, unknown> }).paint ?? {})) this.map.setPaintProperty(l.id, k as PaintProp, v as never);
    }
  }

  async destroy() {
    await this.ready;
    this.removeArchive();
    this.map.remove();
  }

  /**
   * 地図が今このソースに要求するタイルの z。MapLibre と同じ規則（tileSize 512 なら vector は floor、raster は round）で、
   * maxZoom を超えたら maxZoom のタイルを引き伸ばす（overzoom）。minZoom 未満ではタイルを要求しない。
   */
  private tileZoomAt(): number | undefined {
    const cur = this.current;
    if (!cur) return undefined;
    const h = cur.archive.header;
    const zoom = this.map.getZoom();
    const ideal = Math.max(0, (cur.style.roundZoom ? Math.round : Math.floor)(zoom));
    if (ideal < h.minZoom) return undefined;
    return Math.min(ideal, h.maxZoom, MAX_ZOOM);
  }

  private scheduleGrid() {
    if (this.gridFrame) return;
    this.gridFrame = requestAnimationFrame(() => {
      this.gridFrame = 0;
      this.updateGrid();
    });
  }

  /** 画面を覆うタイルの境界と z/x/y。MapLibre 自身の coveringTiles を使い、実際に要求されるタイルと同じ並びを描く */
  private updateGrid() {
    const cur = this.current;
    const mapZoom = this.map.getZoom();
    const z = this.tileZoomAt();
    if (!cur || z === undefined) {
      this.src(OVERLAY.grid).setData(EMPTY);
      this.opts.onView({ mapZoom, tiles: 0, overzoomed: false });
      return;
    }
    const h = cur.archive.header;
    const tiles = this.map.coveringTiles({ tileSize: TILE_SIZE, minzoom: h.minZoom, maxzoom: h.maxZoom, roundZoom: cur.style.roundZoom });
    const features: Feature[] = [];
    const v = this.map.getBounds();
    for (const t of tiles) {
      const { z: tz, x, y } = t.canonical;
      const [w, s, e, n] = tileBounds(tz, x, y, 1, t.wrap);
      features.push({ type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [rectRing([w, s, e, n])] } });
      // ラベルはタイルの「画面に見えている部分」の中央に置く。低ズームのタイルは画面より大きく、中心に置くと画面外に消えるため
      const lx = (Math.max(w, v.getWest()) + Math.min(e, v.getEast())) / 2;
      const ly = (Math.max(s, v.getSouth()) + Math.min(n, v.getNorth())) / 2;
      features.push({ type: "Feature", properties: { label: `${tz}/${x}/${y}` }, geometry: { type: "Point", coordinates: [lx, ly] } });
    }
    this.src(OVERLAY.grid).setData({ type: "FeatureCollection", features });
    this.opts.onView({ mapZoom, tileZ: z, tiles: tiles.length, overzoomed: mapZoom >= h.maxZoom + 1 });
  }

  private addOverlay() {
    for (const id of Object.values(OVERLAY)) this.map.addSource(id, { type: "geojson", data: EMPTY });
    for (const l of overlayLayers(this.colors, this.hasGlyphs)) this.map.addLayer(l);
  }

  private src(id: string): GeoJSONSource {
    return this.map.getSource(id) as GeoJSONSource;
  }
}

function overlayLayers(c: InspectorMapColors, glyphs: boolean): LayerSpecification[] {
  const layers: LayerSpecification[] = [
    { id: `${OVERLAY.region}-fill`, type: "fill", source: OVERLAY.region, paint: { "fill-color": c.region, "fill-opacity": 0.16 } },
    { id: `${OVERLAY.region}-line`, type: "line", source: OVERLAY.region, paint: { "line-color": c.region, "line-width": 2 } },
    { id: `${OVERLAY.grid}-line`, type: "line", source: OVERLAY.grid, filter: ["==", ["geometry-type"], "Polygon"], paint: { "line-color": c.grid, "line-width": 1, "line-opacity": 0.6 } },
    { id: `${OVERLAY.selected}-fill`, type: "fill", source: OVERLAY.selected, paint: { "fill-color": c.selected, "fill-opacity": 0.12 } },
    { id: `${OVERLAY.selected}-line`, type: "line", source: OVERLAY.selected, paint: { "line-color": c.selected, "line-width": 3 } },
    { id: `${OVERLAY.hover}-line`, type: "line", source: OVERLAY.hover, paint: { "line-color": c.hover, "line-width": 2, "line-dasharray": [2, 1] } },
  ];
  // 字形（glyphs）が取れないとき（背景地図の style を読めなかったとき）は z/x/y の文字だけ諦める
  if (glyphs) {
    layers.push({
      id: `${OVERLAY.grid}-label`,
      type: "symbol",
      source: OVERLAY.grid,
      filter: ["==", ["geometry-type"], "Point"],
      layout: { "text-field": ["get", "label"], "text-font": LABEL_FONT, "text-size": 12, "text-allow-overlap": true },
      paint: { "text-color": c.text, "text-halo-color": c.halo, "text-halo-width": 1.5 },
    });
  }
  return layers;
}

/** 背景地図の色を Viewer の配色に寄せる。demotiles の既定色は鮮やかで、archive の中身と見分けにくいため */
function basemapPaint(c: InspectorMapColors): [string, string, string][] {
  return [
    ["background", "background-color", c.basemap.background],
    ["countries-fill", "fill-color", c.basemap.land],
    ["countries-boundary", "line-color", c.basemap.border],
    ["coastline", "line-color", c.basemap.border],
    ["countries-label", "text-color", c.basemap.label],
    ["geolines", "line-color", c.basemap.border],
    ["geolines-label", "text-color", c.basemap.label],
    ["crimea-fill", "fill-color", c.basemap.land],
  ];
}

/**
 * 背景地図の style を読み、色を差し替えてから地図に渡す。
 * 読めない（オフラインなど）ときは背景色だけの style にする。背景が無くても archive とタイル境界は描ける。
 */
async function loadBasemap(colors: InspectorMapColors): Promise<StyleSpecification> {
  try {
    const res = await fetch(BASEMAP_STYLE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const style = (await res.json()) as StyleSpecification;
    for (const [layer, prop, value] of basemapPaint(colors)) {
      const l = style.layers.find((x) => x.id === layer) as { paint?: Record<string, unknown> } | undefined;
      if (l) l.paint = { ...l.paint, [prop]: value };
    }
    return style;
  } catch {
    return { version: 8, sources: {}, layers: [{ id: "background", type: "background", paint: { "background-color": colors.basemap.background } }] };
  }
}
