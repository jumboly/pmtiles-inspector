import type { LayerSpecification, SourceSpecification } from "maplibre-gl";
import type { Header } from "../core/pmtiles/header";
import { TileType, tileTypeName } from "../core/pmtiles/enums";

/**
 * archive を MapLibre の source / layer に写す。
 *
 * タイルのピクセルサイズは PMTiles の Header に無い（spec に項目が無い）ので、vector・raster とも 512 として扱う。
 * こうすると「地図のズーム Z で要求されるタイルの z」が vector は floor(Z)、raster は round(Z) になり、
 * 地図のズームとタイルの z の対応が読みやすい（256px の raster は少しぼやけて見える）。
 */
export const TILE_SIZE = 512;

export interface ArchiveStyle {
  source?: SourceSpecification;
  layers: LayerSpecification[];
  /** 描けない・一部しか描けない理由（画面に出す） */
  note?: string;
  /** MapLibre がタイル z を決めるときの丸め方（raster は round、vector は floor） */
  roundZoom: boolean;
}

export const ARCHIVE_SOURCE = "archive";

export function archiveStyle(header: Header, metadata: unknown, tilesUrl: string, palette: string[]): ArchiveStyle {
  const base = {
    tiles: [tilesUrl],
    minzoom: header.minZoom,
    maxzoom: header.maxZoom,
    // bounds を渡すと MapLibre は範囲外のタイルを要求しない（公式 Protocol が返す TileJSON と同じ振る舞い）
    ...(validBounds(header) ? { bounds: [header.minLon, header.minLat, header.maxLon, header.maxLat] as [number, number, number, number] } : {}),
    tileSize: TILE_SIZE,
    attribution: attributionText(metadata),
  };
  const t = header.tileType;

  if (t === TileType.Png || t === TileType.Jpeg || t === TileType.Webp || t === TileType.Avif) {
    const terrarium = (metadata as { encoding?: unknown } | undefined)?.encoding === "terrarium";
    return {
      source: { type: "raster", ...base },
      layers: [{ id: "archive-raster", type: "raster", source: ARCHIVE_SOURCE, paint: { "raster-opacity": 0.85 } }],
      roundZoom: true,
      // terrarium は標高を RGB に詰めた画像。ここでは画像のまま見せる（標高への変換は Phase 8 の Terrain mode）
      note: terrarium ? "metadata の encoding = terrarium: 標高を RGB に符号化した画像をそのまま表示しています（色 = 符号化された標高）" : undefined,
    };
  }

  if (t === TileType.Mvt || t === TileType.Mlt) {
    const ids = vectorLayerIds(metadata);
    const source: SourceSpecification = { type: "vector", ...base, ...(t === TileType.Mlt ? { encoding: "mlt" as const } : {}) };
    if (!ids.length) {
      // source-layer 名が分からないと MapLibre の layer を作れない。タイルの中身から名前を拾うのは Content Inspector（Phase 7）の役目
      return { source, layers: [], roundZoom: false, note: "metadata に vector_layers が無いので、どの layer を描けばよいか分かりません（タイルは読むが描かない）" };
    }
    return { source, layers: ids.flatMap((id, i) => vectorLayers(id, palette[i % palette.length]!)), roundZoom: false };
  }

  return { layers: [], roundZoom: false, note: `Tile Type ${tileTypeName(t)} は地図に描けません（Tile Trace / Raw では読めます）` };
}

/** 1 つの source-layer を、面・線・点それぞれ最低限の見た目で描く（中身の意味は知らないので色だけで区別する） */
function vectorLayers(sourceLayer: string, color: string): LayerSpecification[] {
  const common = { source: ARCHIVE_SOURCE, "source-layer": sourceLayer } as const;
  const id = `archive-${sourceLayer}`;
  return [
    { id: `${id}-fill`, type: "fill", ...common, filter: ["==", ["geometry-type"], "Polygon"], paint: { "fill-color": color, "fill-opacity": 0.25 } },
    { id: `${id}-line`, type: "line", ...common, filter: ["!=", ["geometry-type"], "Point"], paint: { "line-color": color, "line-width": 1 } },
    {
      id: `${id}-circle`,
      type: "circle",
      ...common,
      filter: ["==", ["geometry-type"], "Point"],
      paint: { "circle-color": color, "circle-radius": 2.5, "circle-stroke-color": "#fff", "circle-stroke-width": 0.5 },
    },
  ];
}

function vectorLayerIds(metadata: unknown): string[] {
  const vl = (metadata as { vector_layers?: unknown } | undefined)?.vector_layers;
  if (!Array.isArray(vl)) return [];
  return vl.map((l) => (l as { id?: unknown })?.id).filter((id): id is string => typeof id === "string");
}

function validBounds(h: Header): boolean {
  return h.minLon < h.maxLon && h.minLat < h.maxLat && h.minLon >= -180 && h.maxLon <= 180 && h.minLat >= -90 && h.maxLat <= 90;
}

/**
 * metadata の attribution を文字列として渡す。
 * MapLibre は attribution を HTML として描くので、ファイル由来の文字列からタグを落とし、残った文字も escape する
 * （任意のファイルを開けるツールなので、metadata に仕込まれた HTML を実行させないため）。
 */
function attributionText(metadata: unknown): string | undefined {
  const a = (metadata as { attribution?: unknown } | undefined)?.attribution;
  if (typeof a !== "string" || !a.trim()) return undefined;
  const text = new DOMParser().parseFromString(a, "text/html").body.textContent ?? "";
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
