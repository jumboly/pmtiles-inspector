import type { MetadataRecord, PmtilesArchive } from "../core/pmtiles/archive";
import type { HeaderKey, SectionName } from "../core/pmtiles/header";
import type { FileLayout } from "../core/pmtiles/layout";
import type { ReadRecord, TracingByteSource } from "../core/source/tracing-byte-source";

/** 何が選ばれているか。パネル間連動はすべてこの値の変化で起こる */
export type Selection =
  | { kind: "header-field"; key: HeaderKey }
  | { kind: "section"; name: SectionName };

/** Hex Viewer が今表示しているファイル上の窓 */
export interface HexWindow {
  /** ファイル先頭からの絶対 offset */
  baseOffset: number;
  bytes: Uint8Array;
  /** 窓の出どころ（先頭 16 KiB の read を再利用しているのか、表示のために読んだのか） */
  origin: "first-read" | "viewer-inspect";
  /** section を表示している場合、その section 全体の範囲（ページ送りの上限に使う） */
  section?: { name: SectionName; offset: number; length: number };
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
}

export const initialState: AppState = { status: "idle", reads: [] };
