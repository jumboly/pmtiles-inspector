import { compressionName, tileTypeName } from "../../core/pmtiles/enums";
import type { Header, HeaderKey, SectionName } from "../../core/pmtiles/header";
import { num, size } from "../format";

/**
 * Header field の説明文。parser に表示用の文言を持たせないため UI 側に置く。
 * 内容は spec v3 §3.2 に基づく。
 */
export interface FieldInfo {
  label: string;
  group: string;
  desc: string;
  /** この field がどの section の位置・大きさを表しているか（File Layout と連動させる） */
  section?: SectionName;
}

export const FIELD_INFO: Record<HeaderKey, FieldInfo> = {
  magic: { label: "Magic Number", group: "識別", desc: "常に UTF-8 の 'PMTiles'（7 byte）。これで PMTiles ファイルかを判定する。" },
  specVersion: { label: "Version", group: "識別", desc: "仕様のバージョン。v3 では常に 3。" },
  rootDirectoryOffset: {
    label: "Root Directory Offset",
    group: "セクションの位置",
    desc: "Root Directory の先頭 byte の位置（ファイル先頭から）。Header + Root は先頭 16 KiB に収まる決まり。",
    section: "rootDirectory",
  },
  rootDirectoryLength: {
    label: "Root Directory Length",
    group: "セクションの位置",
    desc: "Root Directory の長さ（圧縮後の byte 数）。上限は 16384 − 127 = 16257 byte。",
    section: "rootDirectory",
  },
  metadataOffset: { label: "Metadata Offset", group: "セクションの位置", desc: "JSON Metadata の先頭位置。", section: "metadata" },
  metadataLength: { label: "Metadata Length", group: "セクションの位置", desc: "JSON Metadata の長さ（圧縮後）。", section: "metadata" },
  leafDirectoriesOffset: {
    label: "Leaf Directories Offset",
    group: "セクションの位置",
    desc: "Leaf Directory 群の先頭位置。Leaf entry の offset はここを起点に数える。",
    section: "leafDirectories",
  },
  leafDirectoriesLength: {
    label: "Leaf Directories Length",
    group: "セクションの位置",
    desc: "すべての Leaf Directory の合計長。0 なら Leaf は無く、Root だけで全タイルを指している。",
    section: "leafDirectories",
  },
  tileDataOffset: {
    label: "Tile Data Offset",
    group: "セクションの位置",
    desc: "Tile Data の先頭位置。Tile entry の offset はここを起点に数える。",
    section: "tileData",
  },
  tileDataLength: { label: "Tile Data Length", group: "セクションの位置", desc: "Tile Data 全体の長さ。", section: "tileData" },
  numAddressedTiles: {
    label: "Addressed Tiles",
    group: "件数",
    desc: "z/x/y で取り出せるタイルの総数（RunLength を展開した数）。0 は「不明」。",
  },
  numTileEntries: {
    label: "Tile Entries",
    group: "件数",
    desc: "RunLength > 0 の Directory Entry の数。連続する同一タイルは 1 entry にまとまるので Addressed 以下になる。0 は「不明」。",
  },
  numTileContents: {
    label: "Tile Contents",
    group: "件数",
    desc: "Tile Data にある実体（blob）の数。重複排除で複数 entry が同じ blob を指せるので Entries 以下になる。0 は「不明」。",
  },
  clustered: {
    label: "Clustered",
    group: "エンコーディング",
    desc: "Tile Data が TileID 順に並んでいるか。1 なら offset は連続（または重複排除で前方を参照）し、先頭タイルは offset 0。",
  },
  internalCompression: {
    label: "Internal Compression",
    group: "エンコーディング",
    desc: "Root / Leaf Directory と Metadata の圧縮方式。タイル本体の圧縮とは別。",
  },
  tileCompression: {
    label: "Tile Compression",
    group: "エンコーディング",
    desc: "タイル本体（Tile Payload）の圧縮方式。PNG など既に圧縮済みの形式では通常 none。",
  },
  tileType: { label: "Tile Type", group: "エンコーディング", desc: "タイルの中身の形式。Content Inspector の切り替えに使う。" },
  minZoom: { label: "Min Zoom", group: "ズームと範囲", desc: "含まれる最小ズーム。これ未満の z は Directory を見るまでもなく存在しない。" },
  maxZoom: { label: "Max Zoom", group: "ズームと範囲", desc: "含まれる最大ズーム。" },
  minLon: { label: "Min Longitude", group: "ズームと範囲", desc: "範囲の西端。int32 LE を 10^7 で割った値。" },
  minLat: { label: "Min Latitude", group: "ズームと範囲", desc: "範囲の南端。int32 LE / 10^7。" },
  maxLon: { label: "Max Longitude", group: "ズームと範囲", desc: "範囲の東端。int32 LE / 10^7。" },
  maxLat: { label: "Max Latitude", group: "ズームと範囲", desc: "範囲の北端。int32 LE / 10^7。" },
  centerZoom: { label: "Center Zoom", group: "ズームと範囲", desc: "初期表示用のズーム。" },
  centerLon: { label: "Center Longitude", group: "ズームと範囲", desc: "初期表示用の中心経度。" },
  centerLat: { label: "Center Latitude", group: "ズームと範囲", desc: "初期表示用の中心緯度。" },
};

export const SECTION_LABEL: Record<SectionName, string> = {
  header: "Header",
  rootDirectory: "Root Directory",
  metadata: "Metadata",
  leafDirectories: "Leaf Directories",
  tileData: "Tile Data",
};

/** 生の値を人が読める意味に変換する */
export function interpret(key: HeaderKey, h: Header): string {
  const v = h[key];
  switch (key) {
    case "magic":
      return `"${v}"`;
    case "clustered":
      return v === 1 ? "clustered" : v === 0 ? "not clustered" : `不正な値 ${v}`;
    case "internalCompression":
    case "tileCompression":
      return compressionName(v as number);
    case "tileType":
      return tileTypeName(v as number);
    case "rootDirectoryLength":
    case "metadataLength":
    case "leafDirectoriesLength":
    case "tileDataLength":
      return size(v as number);
    case "numAddressedTiles":
    case "numTileEntries":
    case "numTileContents":
      return v === 0 ? "不明" : num(v as number);
    case "minLon":
    case "maxLon":
    case "centerLon":
      return `${(v as number).toFixed(7)}°`;
    case "minLat":
    case "maxLat":
    case "centerLat":
      return `${(v as number).toFixed(7)}°`;
    default:
      return typeof v === "number" ? num(v) : String(v);
  }
}
