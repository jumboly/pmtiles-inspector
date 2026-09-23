import { PmtilesArchive, type DirectoryRecord, type TileLookup, type TileRead } from "../core/pmtiles/archive";
import { HEADER_LAYOUT, type HeaderKey, type SectionName } from "../core/pmtiles/header";
import { computeLayout } from "../core/pmtiles/layout";
import { HttpRangeSource } from "../core/source/http-range-source";
import { LocalFileSource } from "../core/source/local-file-source";
import { TracingByteSource } from "../core/source/tracing-byte-source";
import type { ByteSource } from "../core/source/types";
import { isPlainDirectory } from "./directory-util";
import { buildTraceSteps, isPhysicalStep } from "./trace-steps";
import { sizeBytes, sizeFromProbe, type ArchiveSize } from "./archive-size";
import type { AppState, DirColumn, DirView, HexWindow, HoverTile, SourceDesc } from "./state";
import type { Store } from "./store";

/** Hex Viewer が 1 度に読む量。巨大 section を開いても全体を読まないための上限 */
export const HEX_PAGE_SIZE = 4096;
/** Directory Viewer の 1 ページの entry 数。leaf は 4096 entry 程度になるので全行は描かない */
export const DIR_PAGE_SIZE = 200;
/** Auto 再生の 1 段あたりの時間。各パネルの連動を目で追える程度に遅くする */
const TRACE_AUTO_INTERVAL_MS = 1200;
/**
 * Hilbert Viewer が 1 画面に描くのは最大 2^8 × 2^8 マス。
 * これより高いズームでは、選択タイルを含む整列ブロック（= TileID が連続する区間）だけを描く。
 */
export const HILBERT_MAX_WINDOW_ZOOM = 8;
/** Hilbert 曲線を既定で重ねる上限。これより細かいと線が面を塗りつぶして grid が読めなくなる */
const CURVE_DEFAULT_MAX_ZOOM = 6;

/**
 * ユーザ操作を store の変更に変換する唯一の場所。
 * パネルは controller を呼ぶだけで、I/O も他パネルの更新も直接は行わない。
 */
export class Controller {
  private openSeq = 0;
  private traceSeq = 0;
  private playTimer: ReturnType<typeof setInterval> | undefined;
  /** 読み込み中の tile の lookup。Auto 再生などで同じ tile の read を二重に発行しないため */
  private tileLoading: TileLookup | undefined;

  constructor(private readonly store: Store<AppState>) {}

  openFile(file: Blob, name: string) {
    return this.open(new LocalFileSource(file, name), { kind: "local", name });
  }

  /** URL の archive を HTTP Range Request で開く。LocalFileSource と同じ ByteSource の口に差し替えるだけで、parser は変わらない */
  openUrl(url: string) {
    let inner: HttpRangeSource;
    try {
      inner = new HttpRangeSource(url);
    } catch (e) {
      ++this.openSeq;
      this.store.set({ status: "error", error: message(e), errorKind: kindOf(e), sourceDesc: { kind: "http", url } });
      return Promise.resolve();
    }
    return this.open(inner, { kind: "http", url: inner.url });
  }

  async open(inner: ByteSource, sourceDesc: SourceDesc) {
    const seq = ++this.openSeq;
    this.stopTrace();
    const source = new TracingByteSource(inner);
    this.store.set({
      status: "loading",
      error: undefined,
      errorKind: undefined,
      sourceDesc,
      source,
      archiveSize: undefined,
      sizeProbing: undefined,
      archive: undefined,
      layout: undefined,
      metadata: undefined,
      metadataError: undefined,
      reads: [],
      selection: undefined,
      hex: undefined,
      dirView: undefined,
      dirLoading: undefined,
      dirError: undefined,
      trace: undefined,
      traceLoading: undefined,
      traceError: undefined,
      hoverTile: undefined,
    });
    // read が起きるたびに Range Trace を更新する。後から別ファイルを開いたら古い通知は捨てる
    source.subscribe(() => {
      if (seq === this.openSeq) this.store.set({ reads: [...source.records] });
    });

    try {
      const archive = await PmtilesArchive.open(source);
      if (seq !== this.openSeq) return;
      const archiveSize = knownSize(inner);
      this.store.set({
        status: "ready",
        archive,
        archiveSize,
        sizeProbing: archiveSize.origin === "unknown" && source.canProbeSize,
        layout: computeLayout(archive.header, sizeBytes(archiveSize)),
        hex: { baseOffset: 0, bytes: archive.firstRead.bytes, origin: "first-read" },
        // root は先頭 16 KiB に含まれていて読み終わっているので、開いた時点で見せる（追加 I/O なし）
        dirView: { dir: archive.root, trail: [], page: 0 },
        // leaf の分割は最大ズーム付近で最もよく見えるので、描ける範囲で最大のズームから始める
        ...hilbertZoomPatch(Math.min(archive.header.maxZoom, HILBERT_MAX_WINDOW_ZOOM)),
      });
    } catch (e) {
      if (seq === this.openSeq) this.store.set({ status: "error", error: message(e), errorKind: kindOf(e) });
      return;
    }

    // CORS で Content-Range が読めなかったときだけ HEAD でサイズを調べる（Viewer が「読んだ割合」を出すため。公式は送らない）
    if (this.store.get().sizeProbing) {
      const archive = this.store.get().archive!;
      let archiveSize: ArchiveSize;
      try {
        archiveSize = sizeFromProbe(archive.header, await source.probeSize({ label: "Archive Size を調べる" }));
      } catch (e) {
        archiveSize = { origin: "unknown", reason: `HEAD に失敗しました: ${message(e)}` };
      }
      if (seq !== this.openSeq) return;
      this.store.set({ archiveSize, sizeProbing: false, layout: computeLayout(archive.header, sizeBytes(archiveSize)) });
    }

    // Metadata は tile 取得には不要だが、Phase 1 の教材として開いた時点で読む（READ として記録される）
    try {
      const metadata = await this.store.get().archive!.readMetadata();
      if (seq === this.openSeq) this.store.set({ metadata });
    } catch (e) {
      if (seq === this.openSeq) this.store.set({ metadataError: message(e) });
    }
  }

  selectHeaderField(key: HeaderKey) {
    const archive = this.store.get().archive;
    if (!archive) return;
    // header は必ず先頭 16 KiB の read に含まれるので、追加の I/O は発生しない
    this.store.set({
      selection: { kind: "header-field", key },
      hex: { baseOffset: 0, bytes: archive.firstRead.bytes, origin: "first-read" },
    });
  }

  async selectSection(name: SectionName) {
    const { archive, layout } = this.store.get();
    if (!archive || !layout) return;
    const seg = layout.segments.find((s) => s.kind === "section" && s.name === name);
    if (!seg) return;
    const section = { name, offset: seg.offset, length: seg.length };
    this.store.set({ selection: { kind: "section", name } });
    await this.showHex(section.offset, section);
  }

  /** Directory Viewer で directory 自体を選ぶ。Hex には手元の bytes を出す（再 read しない） */
  openDirectory(view: Omit<DirView, "page">) {
    this.store.set({
      dirView: { ...view, page: 0 },
      dirError: undefined,
      selection: { kind: "directory", dir: view.dir },
      hex: dirHex(view.dir),
    });
  }

  /**
   * leaf entry の先を読んで開く。
   * Tile Trace と同じ archive のキャッシュを通すので、ここで読んだ leaf は後の lookup で「cache」になる
   * （ブラウザ上の実際のクライアントが leaf をキャッシュするのと同じ振る舞い）。
   */
  /** trail の末尾が「開きたい leaf を指す親 directory と entry index」 */
  async expandLeaf(trail: DirView["trail"]) {
    const archive = this.store.get().archive;
    const last = trail.at(-1);
    if (!archive || !last) return;
    const entry = last.dir.decoded.entries[last.index];
    if (!entry || entry.runLength !== 0) return;
    this.store.set({ dirLoading: `leaf (tileId ${entry.tileId}〜) を読み込み中…`, dirError: undefined });
    try {
      const { record } = await archive.readLeafDirectory(entry, "Directory Viewer で展開");
      if (this.store.get().archive !== archive) return;
      this.store.set({ dirLoading: undefined });
      this.openDirectory({ dir: record, trail });
    } catch (e) {
      this.store.set({ dirLoading: undefined, dirError: message(e) });
    }
  }

  dirPage(page: number) {
    const v = this.store.get().dirView;
    if (!v) return;
    const pages = Math.max(1, Math.ceil(v.dir.decoded.entries.length / DIR_PAGE_SIZE));
    this.store.set({ dirView: { ...v, page: Math.min(Math.max(page, 0), pages - 1) } });
  }

  /** entry を選ぶ。表のページも entry が見える位置に合わせる（Hex / Encoding からの逆方向選択に備えて） */
  selectDirEntry(dir: DirectoryRecord, index: number, column?: DirColumn) {
    const { dirView, hex } = this.store.get();
    if (!dirView) return;
    const view = dirView.dir === dir ? dirView : { dir, trail: [], page: 0 };
    this.store.set({
      dirView: { ...view, page: Math.floor(index / DIR_PAGE_SIZE) },
      selection: { kind: "dir-entry", dir, index, column },
      hex: hex?.dir === dir ? hex : dirHex(dir),
    });
  }

  /** Hex Viewer 上の byte をクリックしたとき、その byte が属する論理要素を選ぶ（逆方向の連動） */
  selectByte(offset: number) {
    const hex = this.store.get().hex;
    // 無圧縮 directory ならファイル上の byte = varint の byte なので、entry まで逆引きできる
    if (hex?.dir && isPlainDirectory(hex.dir)) {
      const hit = entryAtByte(hex.dir, offset - hex.dir.fileOffset);
      if (hit) {
        this.selectDirEntry(hex.dir, hit.index, hit.column);
        return;
      }
    }
    const field = HEADER_LAYOUT.find((f) => offset >= f.offset && offset < f.offset + f.length);
    if (field) {
      this.selectHeaderField(field.key);
      return;
    }
    const seg = this.store
      .get()
      .layout?.segments.find((s) => s.kind === "section" && s.length > 0 && offset >= s.offset && offset < s.offset + s.length);
    // Hex の窓は動かさない。クリックした位置を見ている最中に表示が飛ぶと迷子になるため
    if (seg?.kind === "section") this.store.set({ selection: { kind: "section", name: seg.name } });
  }

  /**
   * z/x/y から Tile Entry までを辿る。
   * 探索に必要な leaf は読む（Read Trace に残る）が、tile data は読まない。
   * tile data は Range Read の段に進んだときに初めて読む（Tile Addressing と Physical Read を別の段階として見せるため）。
   */
  async traceTile(z: number, x: number, y: number) {
    const archive = this.store.get().archive;
    if (!archive) return;
    const seq = ++this.traceSeq;
    this.stopTrace();
    this.store.set({ traceLoading: `${z}/${x}/${y} を探索中…`, traceError: undefined });
    try {
      const lookup = await archive.lookupTile(z, x, y);
      if (seq !== this.traceSeq || this.store.get().archive !== archive) return;
      // Tile Entry（または探索の結論）の段で止める。その先の Physical Read は Next で進んだときに I/O する
      const stop = buildTraceSteps(lookup).findIndex((s) => s.kind === "result");
      const zoomPatch = z === this.store.get().hilbertZoom ? {} : hilbertZoomPatch(z);
      this.store.set({ trace: { lookup, step: stop }, traceLoading: undefined, ...zoomPatch });
      this.traceStep(stop);
    } catch (e) {
      // z/x/y の範囲外など、lookup を始める前の入力エラー
      if (seq === this.traceSeq) this.store.set({ traceLoading: undefined, traceError: message(e) });
    }
  }

  /**
   * Trace の段を移動し、その段に関係する directory / entry を他パネルでも選択状態にする。
   * 既存の selection の仕組みに乗せることで、Directory・Encoding・Hex・File Layout が追加実装なしで連動する。
   */
  traceStep(index: number) {
    const trace = this.store.get().trace;
    if (!trace) return;
    const steps = buildTraceSteps(trace.lookup);
    const step = Math.min(Math.max(index, 0), steps.length - 1);
    const patch: Partial<AppState> = { trace: { ...trace, step } };

    // この段までに通った directory の連なり（Directory Viewer のパンくず = trail になる）
    const trail: DirView["trail"] = [];
    let current: { dir: DirectoryRecord; index?: number } | undefined;
    for (const s of steps.slice(0, step + 1)) {
      if (s.kind !== "directory") continue;
      if (current?.index !== undefined) trail.push({ dir: current.dir, index: current.index });
      current = { dir: s.step.directory, index: s.step.search.candidateIndex };
    }
    if (current) {
      const { dir, index: i } = current;
      patch.dirView = { dir, trail, page: i !== undefined ? Math.floor(i / DIR_PAGE_SIZE) : 0 };
      patch.selection = i !== undefined ? { kind: "dir-entry", dir, index: i } : { kind: "directory", dir };
      patch.hex = dirHex(dir);
      patch.dirError = undefined;
    } else {
      // directory に入る前の段（z/x/y → TileID の計算）では、まだファイル上のどこも指していないことを見せる
      patch.selection = undefined;
    }

    // Physical Read の段: Directory 側は最後の leaf entry を開いたまま、Hex と選択は「読んだ tile の bytes」に移す
    if (isPhysicalStep(steps[step])) {
      if (trace.tile) {
        patch.selection = { kind: "tile-data", offset: trace.tile.fileOffset, length: trace.tile.length };
        patch.hex = tileHex(trace.tile);
      } else {
        this.store.set(patch);
        void this.loadTile(trace.lookup);
        return;
      }
    }
    this.store.set(patch);
  }

  /** Range Read の段で実際に tile を読む。読み終えたら今の段を描き直して各パネルを連動させる */
  private async loadTile(lookup: TileLookup) {
    const archive = this.store.get().archive;
    const r = lookup.result;
    if (!archive || r.status !== "found" || this.tileLoading === lookup) return;
    this.tileLoading = lookup;
    this.store.set({ traceLoading: "Tile Entry が指す範囲を読み込み中…", traceError: undefined });
    try {
      const a = lookup.address;
      const tile = await archive.readTileData(r, `tile ${a.z}/${a.x}/${a.y}`);
      const t = this.store.get().trace;
      // 読んでいる間に別のタイルを Trace し直していたら結果は捨てる（Read Trace には記録として残る）
      if (t?.lookup !== lookup) return;
      this.store.set({ trace: { ...t, tile }, traceLoading: undefined });
      this.traceStep(t.step);
    } catch (e) {
      if (this.store.get().trace?.lookup === lookup) this.store.set({ traceLoading: undefined, traceError: message(e) });
    } finally {
      if (this.tileLoading === lookup) this.tileLoading = undefined;
    }
  }

  /** 先頭の段から自動で進める。最後の段に着いたら止まる */
  playTrace() {
    const trace = this.store.get().trace;
    if (!trace) return;
    this.stopTrace();
    const last = buildTraceSteps(trace.lookup).length - 1;
    this.traceStep(0);
    this.store.set({ tracePlaying: true });
    this.playTimer = setInterval(() => {
      const t = this.store.get().trace;
      if (!t || t.step >= last) {
        this.stopTrace();
        return;
      }
      // tile の read を待っている間は進めない。読む前に「解凍」の段へ進むと順序が逆に見えるため
      if (this.tileLoading) return;
      this.traceStep(t.step + 1);
    }, TRACE_AUTO_INTERVAL_MS);
  }

  stopTrace() {
    if (this.playTimer !== undefined) clearInterval(this.playTimer);
    this.playTimer = undefined;
    if (this.store.get().tracePlaying) this.store.set({ tracePlaying: false });
  }

  setHilbertZoom(z: number) {
    this.store.set(hilbertZoomPatch(z));
  }

  setHoverTile(t: HoverTile | undefined) {
    const cur = this.store.get().hoverTile;
    // mousemove は同じマスの上でも連続で来るので、変わったときだけ流す（全パネルの購読者を無駄に起こさない）
    if (cur?.z === t?.z && cur?.x === t?.x && cur?.y === t?.y && cur?.from === t?.from) return;
    this.store.set({ hoverTile: t });
  }

  setHilbertCurve(on: boolean) {
    this.store.set({ hilbertCurve: on });
  }

  /**
   * section 内をページ送りする。
   * 先頭 16 KiB に掛かる部分は手元の first read をそのまま見せ、その先だけを追加で読む。
   */
  async hexPage(direction: 1 | -1) {
    const { hex, archive } = this.store.get();
    if (!hex?.section || !archive) return;
    const firstLen = archive.firstRead.bytes.length;
    const sec = hex.section;
    const secEnd = sec.offset + sec.length;
    let start: number;
    if (direction === 1) {
      start = hex.origin === "first-read" ? Math.max(firstLen, sec.offset) : hex.baseOffset + HEX_PAGE_SIZE;
      if (start >= secEnd) return;
    } else {
      if (hex.origin === "first-read") return;
      start = Math.max(hex.baseOffset - HEX_PAGE_SIZE, sec.offset);
      if (start >= hex.baseOffset) return;
    }
    await this.showHex(start, sec);
  }

  private async showHex(start: number, section: NonNullable<HexWindow["section"]>) {
    const { archive, source } = this.store.get();
    if (!archive || !source) return;
    const first = archive.firstRead.bytes;

    if (start < first.length || section.length === 0) {
      // すでに手元にある先頭 16 KiB の中なら読み直さない（Range Trace に不要な read を増やさない）
      this.store.set({ hex: { baseOffset: 0, bytes: first, origin: "first-read", section } });
      return;
    }
    const end = Math.min(start + HEX_PAGE_SIZE, section.offset + section.length);
    const r = await source.read(start, end - start, { purpose: "viewer-inspect", label: `hex: ${section.name}` });
    this.store.set({ hex: { baseOffset: start, bytes: r.bytes, origin: "viewer-inspect", section } });
  }
}

/** ズームを変えたら曲線の表示も既定に戻す。低ズームで消したまま高ズームへ行く等の迷いを減らすため */
function hilbertZoomPatch(z: number): Pick<AppState, "hilbertZoom" | "hilbertCurve"> {
  return { hilbertZoom: z, hilbertCurve: z <= CURVE_DEFAULT_MAX_ZOOM };
}

/**
 * directory の bytes（ファイル上のもの = 圧縮後）を Hex の窓にする。
 * 既に読んだ bytes を見せるだけなので、Read Trace に表示用の read は増えない。
 */
function dirHex(dir: DirectoryRecord): HexWindow {
  return { baseOffset: dir.fileOffset, bytes: dir.compressed, origin: "directory", dir };
}

/**
 * 読んだ tile の bytes（ファイル上 = 圧縮後）を Hex の窓にする。
 * tile は数百 KB になり得るので、Hex Viewer には先頭だけを渡す（全体は Tile Payload パネルで扱う）。
 */
function tileHex(tile: TileRead): HexWindow {
  const truncated = tile.raw.length > HEX_PAGE_SIZE;
  return {
    baseOffset: tile.fileOffset,
    bytes: truncated ? tile.raw.subarray(0, HEX_PAGE_SIZE) : tile.raw,
    origin: "tile",
    truncatedFrom: truncated ? tile.raw.length : undefined,
  };
}

/**
 * 解凍後バッファ上の位置から、それがどの entry のどの列の varint かを求める。
 * 列ごとに varint は位置順に並んでいるので二分探索で引ける。
 */
export function entryAtByte(dir: DirectoryRecord, pos: number): { index: number; column: DirColumn } | undefined {
  const enc = dir.decoded.encoding;
  const cols: [DirColumn, { offset: number; length: number }[]][] = [
    ["tileId", enc.tileIdDeltas],
    ["runLength", enc.runLengths],
    ["length", enc.lengths],
    ["offset", enc.offsets],
  ];
  for (const [column, spans] of cols) {
    let lo = 0;
    let hi = spans.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const sp = spans[mid]!;
      if (pos < sp.offset) hi = mid - 1;
      else if (pos >= sp.offset + sp.length) lo = mid + 1;
      else return { index: mid, column };
    }
  }
  return undefined;
}

/** read の時点で分かっている Archive Size。HTTP で分からなければ理由を付けて unknown にする */
function knownSize(inner: ByteSource): ArchiveSize {
  const n = inner.size();
  if (inner instanceof HttpRangeSource) {
    if (n !== undefined && inner.sizeOrigin) return { origin: inner.sizeOrigin, bytes: n };
    return { origin: "unknown", reason: "応答の Content-Range を JS から読めませんでした（CORS の Access-Control-Expose-Headers に含まれていない）" };
  }
  return n !== undefined ? { origin: "file", bytes: n } : { origin: "unknown", reason: "Source がサイズを返しませんでした" };
}

function kindOf(e: unknown): string | undefined {
  const k = (e as { kind?: unknown } | undefined)?.kind;
  return typeof k === "string" ? k : undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
