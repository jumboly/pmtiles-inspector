import type { DirectoryRecord, MetadataRecord, PmtilesArchive, TileLookup } from "../core/pmtiles/archive";
import type { HeaderKey, SectionName } from "../core/pmtiles/header";
import type { FileLayout } from "../core/pmtiles/layout";
import type { ReadRecord, TracingByteSource } from "../core/source/tracing-byte-source";

/** 何が選ばれているか。パネル間連動はすべてこの値の変化で起こる */
export type Selection =
  | { kind: "header-field"; key: HeaderKey }
  | { kind: "section"; name: SectionName }
  | { kind: "directory"; dir: DirectoryRecord }
  /** column を持つのは Encoding Viewer で特定の列の varint を選んだとき */
  | { kind: "dir-entry"; dir: DirectoryRecord; index: number; column?: DirColumn };

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
   * directory = すでに読んである directory の bytes をそのまま見せている（追加 I/O なし）
   */
  origin: "first-read" | "viewer-inspect" | "directory";
  /** origin = directory のとき、どの directory か */
  dir?: DirectoryRecord;
  /** section を表示している場合、その section 全体の範囲（ページ送りの上限に使う） */
  section?: { name: SectionName; offset: number; length: number };
}

/** Tile Trace の結果と、いま何段目を見ているか。Previous / Next はこの step を動かすだけ */
export interface TraceView {
  lookup: TileLookup;
  /** buildTraceSteps(lookup) の index */
  step: number;
}

export interface AppState {
  status: "idle" | "loading" | "ready" | "error";
  error?: string;
  source?: TracingByteSource;
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
  /** Hilbert 曲線を重ねるか。高ズームでは線が密になりすぎて grid が読めなくなるため切り替え可能にする */
  hilbertCurve: boolean;
}

export const initialState: AppState = { status: "idle", reads: [], hilbertZoom: 0, hilbertCurve: true };
