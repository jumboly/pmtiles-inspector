import type { ByteSource } from "../source/types";
import { decompress } from "./compression";
import { decodeDirectory, type DecodedDirectory, type Entry } from "./directory";
import { FIRST_READ_SIZE, HEADER_SIZE, parseHeader, type Header, type ParsedHeader } from "./header";
import { findTileTraced, type SearchTrace } from "./lookup";
import { zxyToTileId, type TileAddress } from "./tileid";

/**
 * 公式 getZxyAttempt と同じく、root を含めて最大 4 階層まで辿る。
 * spec は 2 階層以上の leaf を「推奨しない」だけで禁止していないため、公式の上限に合わせる。
 */
const MAX_DIRECTORY_DEPTH = 4;

export interface DirectoryRecord {
  kind: "root" | "leaf";
  /** ファイル先頭からの絶対 offset（leaf の場合は leafDirectoriesOffset + entry.offset） */
  fileOffset: number;
  /** 圧縮後（= ファイル上）の長さ */
  compressedLength: number;
  compressed: Uint8Array;
  /** Internal Compression を解凍した bytes。DirectoryEncoding の span はこのバッファ上の位置 */
  decompressed: Uint8Array;
  decoded: DecodedDirectory;
  /** このディレクトリを取得した READ 番号。root は先頭 16 KiB の read を共有する */
  readId?: number;
}

export interface MetadataRecord {
  fileOffset: number;
  compressed: Uint8Array;
  decompressed: Uint8Array;
  /** JSON として解釈できなかった場合は undefined（raw bytes は残るので Raw 表示はできる） */
  json?: unknown;
  jsonError?: string;
  readId?: number;
}

/**
 * Tile Trace の 1 ステップ。
 *
 * 説明文は持たせない（parser に表示ロジックを入れないため）。
 * 各ステップは「入力・出力・関与した bytes・READ 番号」を型付きで持ち、文章化は UI が行う。
 */
export type TraceStep =
  | { kind: "address"; address: TileAddress }
  | { kind: "zoom-check"; z: number; minZoom: number; maxZoom: number; inRange: boolean }
  | {
      kind: "directory";
      depth: number;
      directory: DirectoryRecord;
      /** read = 今回 I/O した / cache = 以前読んだものを再利用した / first-read = 先頭 16 KiB に含まれていた */
      obtainedBy: "read" | "cache" | "first-read";
      search: SearchTrace;
    }
  | {
      kind: "tile-read";
      entry: Entry;
      /** tileDataOffset + entry.offset */
      fileOffset: number;
      length: number;
      readId?: number;
      bytes: Uint8Array;
    }
  | {
      kind: "tile-decompress";
      compression: number;
      inputLength: number;
      outputLength?: number;
      error?: string;
    };

export type TraceResult =
  | { status: "found"; entry: Entry; raw: Uint8Array; payload?: Uint8Array }
  | { status: "not-found" }
  | { status: "out-of-zoom" }
  | { status: "error"; message: string };

export interface TileTrace {
  address: TileAddress;
  steps: TraceStep[];
  result: TraceResult;
}

/**
 * PMTiles アーカイブ読み取りの中核。
 *
 * 公式 PMTiles クラスと同じ手順（先頭 16 KiB → root → leaf → tile）で読むが、
 * 途中経過をすべて TileTrace として返す点が異なる。
 */
export class PmtilesArchive {
  private dirCache = new Map<string, DirectoryRecord>();

  private constructor(
    readonly source: ByteSource,
    /** 先頭 read で得た bytes（最大 16 KiB）。Hex Viewer と "First Read" 可視化に使う */
    readonly firstRead: { bytes: Uint8Array; readId?: number },
    readonly parsedHeader: ParsedHeader,
    readonly root: DirectoryRecord,
    /** root が先頭 16 KiB に収まっていなかった（spec 違反） */
    readonly rootOutsideFirstRead: boolean,
  ) {}

  get header(): Header {
    return this.parsedHeader.header;
  }

  static async open(source: ByteSource): Promise<PmtilesArchive> {
    // 公式実装と同じく、header と root を 1 回の read でまとめて取る（spec §2 の 16 KiB 制約はこのため）
    const first = await source.read(0, FIRST_READ_SIZE, { purpose: "header+root" });
    const parsed = parseHeader(first.bytes.subarray(0, HEADER_SIZE));
    const h = parsed.header;

    const rootEnd = h.rootDirectoryOffset + h.rootDirectoryLength;
    const inFirst = rootEnd <= first.bytes.length;
    let compressed: Uint8Array;
    let readId = first.readId;
    if (inFirst) {
      compressed = first.bytes.slice(h.rootDirectoryOffset, rootEnd);
    } else {
      // spec 違反だが読めるなら読む。どこが規約外かを Viewer で示すため失敗にはしない
      const r = await source.read(h.rootDirectoryOffset, h.rootDirectoryLength, { purpose: "root-directory" });
      compressed = r.bytes;
      readId = r.readId;
    }
    const decompressed = await decompress(compressed, h.internalCompression);
    const root: DirectoryRecord = {
      kind: "root",
      fileOffset: h.rootDirectoryOffset,
      compressedLength: h.rootDirectoryLength,
      compressed,
      decompressed,
      decoded: decodeDirectory(decompressed),
      readId,
    };
    return new PmtilesArchive(source, { bytes: first.bytes, readId: first.readId }, parsed, root, !inFirst);
  }

  async readMetadata(): Promise<MetadataRecord> {
    const h = this.header;
    const r = await this.source.read(h.metadataOffset, h.metadataLength, { purpose: "metadata" });
    const decompressed = await decompress(r.bytes, h.internalCompression);
    const rec: MetadataRecord = {
      fileOffset: h.metadataOffset,
      compressed: r.bytes,
      decompressed,
      readId: r.readId,
    };
    try {
      rec.json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(decompressed));
    } catch (e) {
      rec.jsonError = e instanceof Error ? e.message : String(e);
    }
    return rec;
  }

  /** すでに読んである leaf を I/O なしで返す。Directory Viewer がツリーの「展開済み」を判定するのに使う */
  peekLeafDirectory(entry: Entry): DirectoryRecord | undefined {
    return this.dirCache.get(this.leafKey(entry));
  }

  private leafKey(entry: Entry): string {
    return `${this.header.leafDirectoriesOffset + entry.offset}:${entry.length}`;
  }

  /** leaf directory を読む。一度読んだものは再利用し、Trace 上で「cache」と分かるようにする */
  async readLeafDirectory(entry: Entry, label?: string): Promise<{ record: DirectoryRecord; cached: boolean }> {
    const h = this.header;
    const fileOffset = h.leafDirectoriesOffset + entry.offset;
    const key = this.leafKey(entry);
    const hit = this.dirCache.get(key);
    if (hit) return { record: hit, cached: true };

    const r = await this.source.read(fileOffset, entry.length, {
      purpose: "leaf-directory",
      label: label ?? `leaf @ tileId ${entry.tileId}`,
    });
    const decompressed = await decompress(r.bytes, h.internalCompression);
    const decoded = decodeDirectory(decompressed);
    // 公式 getDirectory と同じく、空の leaf は致命的エラーにする（root の空は許容し issue として残る）
    if (decoded.entries.length === 0) {
      throw new Error(`leaf directory (file offset ${fileOffset}) の entry 数が 0 です`);
    }
    const record: DirectoryRecord = {
      kind: "leaf",
      fileOffset,
      compressedLength: entry.length,
      compressed: r.bytes,
      decompressed,
      decoded,
      readId: r.readId,
    };
    this.dirCache.set(key, record);
    return { record, cached: false };
  }

  /** z/x/y を起点に、Root → Leaf → Tile の全過程を記録しながらタイルを取得する */
  async traceTile(z: number, x: number, y: number): Promise<TileTrace> {
    const address = zxyToTileId(z, x, y);
    const steps: TraceStep[] = [{ kind: "address", address }];
    const done = (result: TraceResult): TileTrace => ({ address, steps, result });

    const h = this.header;
    const inRange = z >= h.minZoom && z <= h.maxZoom;
    steps.push({ kind: "zoom-check", z, minZoom: h.minZoom, maxZoom: h.maxZoom, inRange });
    // 公式実装はズーム範囲外なら directory を見ずに終える。無駄な read を避けるための早期打ち切り
    if (!inRange) return done({ status: "out-of-zoom" });

    try {
      let dir = this.root;
      let obtainedBy: "read" | "cache" | "first-read" = this.rootOutsideFirstRead ? "read" : "first-read";
      for (let depth = 0; depth < MAX_DIRECTORY_DEPTH; depth++) {
        const search = findTileTraced(dir.decoded.entries, address.tileId);
        steps.push({ kind: "directory", depth, directory: dir, obtainedBy, search });
        const entry = search.entry;
        if (!entry) return done({ status: "not-found" });

        if (entry.runLength > 0) {
          return done(await this.readTile(entry, steps));
        }
        const leaf = await this.readLeafDirectory(entry);
        dir = leaf.record;
        obtainedBy = leaf.cached ? "cache" : "read";
      }
      return done({ status: "error", message: `directory の深さが上限 ${MAX_DIRECTORY_DEPTH} を超えました` });
    } catch (e) {
      return done({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  private async readTile(entry: Entry, steps: TraceStep[]): Promise<TraceResult> {
    const h = this.header;
    const fileOffset = h.tileDataOffset + entry.offset;
    const r = await this.source.read(fileOffset, entry.length, {
      purpose: "tile-data",
      label: `tile entry ${entry.tileId}`,
    });
    steps.push({ kind: "tile-read", entry, fileOffset, length: entry.length, readId: r.readId, bytes: r.bytes });
    try {
      const payload = await decompress(r.bytes, h.tileCompression);
      steps.push({
        kind: "tile-decompress",
        compression: h.tileCompression,
        inputLength: r.bytes.length,
        outputLength: payload.length,
      });
      return { status: "found", entry, raw: r.bytes, payload };
    } catch (e) {
      // 解凍できなくても raw bytes は返す。Raw Inspector で中身を確認できるようにするため
      steps.push({
        kind: "tile-decompress",
        compression: h.tileCompression,
        inputLength: r.bytes.length,
        error: e instanceof Error ? e.message : String(e),
      });
      return { status: "found", entry, raw: r.bytes };
    }
  }
}
