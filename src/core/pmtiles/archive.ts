import type { ByteSource, ReadInitiator } from "../source/types";
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

/** z/x/y → Tile Entry までの手順（I/O は directory の read だけ。tile data は読まない） */
export type LookupStep = Extract<TraceStep, { kind: "address" | "zoom-check" | "directory" }>;

/**
 * lookup の結論。found の fileOffset / length は「これから読むべき範囲」であり、まだ読んでいない。
 * Tile Addressing（どこにあるか）と Physical Read（実際に読む）を別の段階として見せるために分けている。
 */
export type LookupResult =
  | { status: "found"; entry: Entry; fileOffset: number; length: number }
  | { status: "not-found" }
  | { status: "out-of-zoom" }
  | { status: "error"; message: string };

export interface TileLookup {
  address: TileAddress;
  steps: LookupStep[];
  result: LookupResult;
}

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
 * Physical Read の記録: Tile Entry が指す範囲を実際に読み、Tile Compression を展開した結果。
 * raw（ファイル上の bytes）と payload（解凍後）を両方残すのは、
 * 「ファイルに入っているのは圧縮後の bytes で、Content Inspector が見るのは解凍後」という区別を見せるため。
 */
export interface TileRead {
  entry: Entry;
  /** tileDataOffset + entry.offset */
  fileOffset: number;
  length: number;
  /** ファイル上の bytes（Tile Compression 適用後） */
  raw: Uint8Array;
  readId?: number;
  /** Header の Tile Compression。解凍はこの値だけを根拠に行う（中身の magic bytes からは推測しない） */
  compression: number;
  /** 解凍後の bytes。解凍できなかった場合は undefined（raw は残るので Raw Inspector で見られる） */
  payload?: Uint8Array;
  decompressError?: string;
}

/** archive の read に呼び出し側が添える情報。parser の判断には使わず、ByteSource の ReadContext にそのまま渡す */
export interface ArchiveReadOptions {
  initiator?: ReadInitiator;
  /**
   * tile data の read だけに渡す。leaf は複数の要求で共有されるので、1 つの要求の中断で leaf の read を止めない
   * （公式 SharedPromiseCache は参照数を数えて全員が中断したときだけ止めるが、ここでは共有 read を中断しない単純な形にしている）。
   */
  signal?: AbortSignal;
}

/**
 * PMTiles アーカイブ読み取りの中核。
 *
 * 公式 PMTiles クラスと同じ手順（先頭 16 KiB → root → leaf → tile）で読むが、
 * 途中経過をすべて TileTrace として返す点が異なる。
 */
export class PmtilesArchive {
  private dirCache = new Map<string, DirectoryRecord>();
  /**
   * 読んでいる最中の leaf。地図は同じ leaf の範囲にあるタイルを一度に何十枚も要求するので、
   * これが無いと同じ leaf を同時に何度も読んでしまう（公式 SharedPromiseCache も pending の Promise を共有する）。
   */
  private leafInflight = new Map<string, Promise<DirectoryRecord>>();

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

  /**
   * 読み込み済みの leaf の数。Viewer が「leaf が増えたので描き直す」を判定するのに使う。
   * read の通知（TracingByteSource）は leaf をキャッシュに入れる前に届くため、それでは代用できない。
   */
  get loadedLeafCount(): number {
    return this.dirCache.size;
  }

  /** すでに読んである leaf を I/O なしで返す。Directory Viewer がツリーの「展開済み」を判定するのに使う */
  peekLeafDirectory(entry: Entry): DirectoryRecord | undefined {
    return this.dirCache.get(this.leafKey(entry));
  }

  private leafKey(entry: Entry): string {
    return `${this.header.leafDirectoriesOffset + entry.offset}:${entry.length}`;
  }

  /** leaf directory を読む。一度読んだものは再利用し、Trace 上で「cache」と分かるようにする */
  /** cached = この呼び出しでは I/O していない（読み終えた leaf の再利用、または他の要求が読んでいる最中の read に相乗り） */
  async readLeafDirectory(entry: Entry, label?: string, opts?: ArchiveReadOptions): Promise<{ record: DirectoryRecord; cached: boolean }> {
    const key = this.leafKey(entry);
    const hit = this.dirCache.get(key);
    if (hit) return { record: hit, cached: true };
    const pending = this.leafInflight.get(key);
    if (pending) return { record: await pending, cached: true };

    const p = this.fetchLeafDirectory(entry, label, opts?.initiator);
    this.leafInflight.set(key, p);
    try {
      const record = await p;
      this.dirCache.set(key, record);
      return { record, cached: false };
    } finally {
      // 失敗した read は共有し続けない（次の要求で読み直せるように）
      this.leafInflight.delete(key);
    }
  }

  private async fetchLeafDirectory(entry: Entry, label: string | undefined, initiator: ReadInitiator | undefined): Promise<DirectoryRecord> {
    const h = this.header;
    const fileOffset = h.leafDirectoriesOffset + entry.offset;
    const r = await this.source.read(fileOffset, entry.length, {
      purpose: "leaf-directory",
      initiator,
      label: label ?? `leaf @ tileId ${entry.tileId}`,
    });
    const decompressed = await decompress(r.bytes, h.internalCompression);
    const decoded = decodeDirectory(decompressed);
    // 公式 getDirectory と同じく、空の leaf は致命的エラーにする（root の空は許容し issue として残る）
    if (decoded.entries.length === 0) {
      throw new Error(`leaf directory (file offset ${fileOffset}) の entry 数が 0 です`);
    }
    return {
      kind: "leaf",
      fileOffset,
      compressedLength: entry.length,
      compressed: r.bytes,
      decompressed,
      decoded,
      readId: r.readId,
    };
  }

  /**
   * z/x/y から Tile Entry を探す（Root → Leaf の探索まで）。
   * 必要な leaf directory は読む（探索に不可欠なため）が、tile data は読まない。
   */
  async lookupTile(z: number, x: number, y: number, opts?: ArchiveReadOptions): Promise<TileLookup> {
    const address = zxyToTileId(z, x, y);
    const steps: LookupStep[] = [{ kind: "address", address }];
    const done = (result: LookupResult): TileLookup => ({ address, steps, result });

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
          return done({ status: "found", entry, fileOffset: h.tileDataOffset + entry.offset, length: entry.length });
        }
        const leaf = await this.readLeafDirectory(entry, undefined, { initiator: opts?.initiator });
        dir = leaf.record;
        obtainedBy = leaf.cached ? "cache" : "read";
      }
      return done({ status: "error", message: `directory の深さが上限 ${MAX_DIRECTORY_DEPTH} を超えました` });
    } catch (e) {
      return done({ status: "error", message: e instanceof Error ? e.message : String(e) });
    }
  }

  /** z/x/y を起点に、Root → Leaf → Tile の全過程を記録しながらタイルを取得する（lookup + tile の read） */
  async traceTile(z: number, x: number, y: number): Promise<TileTrace> {
    const lookup = await this.lookupTile(z, x, y);
    const steps: TraceStep[] = [...lookup.steps];
    const r = lookup.result;
    if (r.status !== "found") return { address: lookup.address, steps, result: r };

    const t = await this.readTileData(r, `tile ${z}/${x}/${y}`);
    steps.push({ kind: "tile-read", entry: t.entry, fileOffset: t.fileOffset, length: t.length, readId: t.readId, bytes: t.raw });
    steps.push({
      kind: "tile-decompress",
      compression: t.compression,
      inputLength: t.raw.length,
      outputLength: t.payload?.length,
      error: t.decompressError,
    });
    return { address: lookup.address, steps, result: { status: "found", entry: t.entry, raw: t.raw, payload: t.payload } };
  }

  /**
   * Physical Read: lookup が見つけた範囲を読み、Tile Compression を展開する。
   *
   * tile はキャッシュしない。公式 PMTiles クラスも tile data はキャッシュせず（directory だけ）、
   * 同じタイルを再度読めば Read Trace にもう 1 回現れる、という実際のクライアントの挙動をそのまま見せるため。
   */
  async readTileData(found: Extract<LookupResult, { status: "found" }>, label?: string, opts?: ArchiveReadOptions): Promise<TileRead> {
    const { entry, fileOffset, length } = found;
    const compression = this.header.tileCompression;
    const r = await this.source.read(fileOffset, length, {
      purpose: "tile-data",
      initiator: opts?.initiator,
      signal: opts?.signal,
      label: label ?? `tile entry ${entry.tileId}`,
    });
    const base = { entry, fileOffset, length, raw: r.bytes, readId: r.readId, compression };
    try {
      return { ...base, payload: await decompress(r.bytes, compression) };
    } catch (e) {
      // 解凍できなくても raw bytes は返す。Raw Inspector で中身を確認できるようにするため
      return { ...base, decompressError: e instanceof Error ? e.message : String(e) };
    }
  }
}
