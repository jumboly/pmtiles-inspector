import type { DirectoryRecord, MetadataRecord, PmtilesArchive, TileLookup, TileRead } from "../core/pmtiles/archive";
import type { HeaderKey, SectionName } from "../core/pmtiles/header";
import type { FileLayout } from "../core/pmtiles/layout";
import type { ReadRecord, TracingByteSource } from "../core/source/tracing-byte-source";
import type { FeatureHit } from "../tile-inspector/mvt/hit-test";
import type { ArchiveSize } from "./archive-size";
import type { ContentResult } from "./content";

/** 何を開いているか。Local と HTTP で「同じ archive をどう読んだか」を見比べられるよう区別して持つ */
export type SourceDesc = { kind: "local"; name: string } | { kind: "http"; url: string };

/** 何が選ばれているか。パネル間連動はすべてこの値の変化で起こる */
export type Selection =
  | { kind: "header-field"; key: HeaderKey }
  | { kind: "section"; name: SectionName }
  | { kind: "directory"; dir: DirectoryRecord }
  /** column を持つのは Encoding Viewer で特定の列の varint を選んだとき */
  | { kind: "dir-entry"; dir: DirectoryRecord; index: number; column?: DirColumn }
  /** Physical Read で実際に読んだ tile の bytes（ファイル上の範囲） */
  | { kind: "tile-data"; offset: number; length: number };

/** Directory の 4 つの列。bytes 上もこの順に並ぶ (spec §4.3) */
export type DirColumn = "tileId" | "runLength" | "length" | "offset";

/** Directory Viewer が今開いている directory と、そこに至る親の連なり（root → leaf → …） */
export interface DirView {
  dir: DirectoryRecord;
  /** 親 directory と、その中でこの directory を指していた entry の index */
  trail: { dir: DirectoryRecord; index: number }[];
  /** entries 表のページ番号（leaf は数千 entry あるため全行は描かない） */
  page: number;
}

/** Hex Viewer が今表示しているファイル上の窓 */
export interface HexWindow {
  /** ファイル先頭からの絶対 offset */
  baseOffset: number;
  bytes: Uint8Array;
  /**
   * 窓の出どころ。
   * first-read = 先頭 16 KiB の read を再利用 / viewer-inspect = 表示のために読んだ /
   * directory = すでに読んである directory の bytes をそのまま見せている（追加 I/O なし） /
   * tile = Tile Trace の Range Read で読んだ tile の bytes をそのまま見せている（追加 I/O なし）
   */
  origin: "first-read" | "viewer-inspect" | "directory" | "tile";
  /** origin = directory のとき、どの directory か */
  dir?: DirectoryRecord;
  /** section を表示している場合、その section 全体の範囲（ページ送りの上限に使う） */
  section?: { name: SectionName; offset: number; length: number };
  /** bytes が元の長さから切り詰められている場合の元の長さ（tile は数百 KB になり得るので先頭だけ描く） */
  truncatedFrom?: number;
}

/** Tile Trace の結果と、いま何段目を見ているか。Previous / Next はこの step を動かすだけ */
export interface TraceView {
  lookup: TileLookup;
  /** buildTraceSteps(lookup) の index */
  step: number;
  /**
   * Range Read の段に入ったときに読んだ tile。段に入るまでは undefined（まだ I/O していない）。
   * 一度読んだら保持し、段を戻って進み直しても再 read しない（Read Trace に同じ read を重ねないため）。
   */
  tile?: TileRead;
  /** tile を読んだ時点で Content Inspector に掛けた結果（Payload から作るので tile と同時に決まる） */
  content?: ContentResult;
  /**
   * 地図をクリックして始めた Trace の、クリック地点（tile 内の位置）。
   * Trace は Tile Entry で止まるので、tile を読んだ時点でこの地点の feature を選ぶために覚えておく。
   */
  pick?: TilePick;
  contentSel: ContentSel;
}

/** tile 内の位置。tile の幅を 1 とした割合で持つ（layer ごとに extent が違うので、座標にするのは layer ごと） */
export interface TilePick {
  fx: number;
  fy: number;
  /** 当たり判定の許容距離（tile の幅に対する割合。地図の画面上で数 px 相当） */
  tolerance: number;
}

/** Content Inspector で今見ているもの */
export interface ContentSel {
  layer?: number;
  /** layer 内の feature index */
  feature?: number;
  /** feature 一覧のページ番号（数千 feature の layer があるため全行は描かない） */
  page: number;
  /** 最後の当たり判定の候補（点 → 線 → 面の順）。重なった feature を選び直せるようにする */
  hits?: FeatureHit[];
  /** 当たり判定の結果の説明（何も無かった等） */
  pickNote?: string;
}

/**
 * いまカーソルが載っているタイル。地図と Hilbert Viewer の間で「同じタイルが両方でどこにあるか」を見せるために共有する。
 * from はカーソルの持ち主。持ち主の側は自前でカーソルを描いているので、相手側だけが枠を描く。
 */
export interface HoverTile {
  z: number;
  x: number;
  y: number;
  from: "map" | "hilbert";
}

export interface AppState {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  /** 失敗の種類（HTTP なら cors / network / range-not-supported など）。種類ごとに説明と確認方法を出し分ける */
  errorKind?: string;
  sourceDesc?: SourceDesc;
  source?: TracingByteSource;
  /** 「読んだ割合」の分母。HTTP では開いた後で分かる（または分からない）ので source.size() とは別に持つ */
  archiveSize?: ArchiveSize;
  /** HEAD でサイズを調べている最中 */
  sizeProbing?: boolean;
  archive?: PmtilesArchive;
  layout?: FileLayout;
  metadata?: MetadataRecord;
  metadataError?: string;
  reads: ReadRecord[];
  selection?: Selection;
  hex?: HexWindow;
  dirView?: DirView;
  /** leaf を読み込み中・失敗したときの表示用 */
  dirLoading?: string;
  dirError?: string;
  trace?: TraceView;
  traceLoading?: string;
  traceError?: string;
  /** Auto 再生中か */
  tracePlaying?: boolean;
  /** Hilbert Viewer が描いているズーム */
  hilbertZoom: number;
  hoverTile?: HoverTile;
  /** Hilbert 曲線を重ねるか。高ズームでは線が密になりすぎて grid が読めなくなるため切り替え可能にする */
  hilbertCurve: boolean;
}

export const initialState: AppState = { status: "idle", reads: [], hilbertZoom: 0, hilbertCurve: true };
