import { PmtilesArchive, type DirectoryRecord } from "../core/pmtiles/archive";
import { HEADER_LAYOUT, type HeaderKey, type SectionName } from "../core/pmtiles/header";
import { computeLayout } from "../core/pmtiles/layout";
import { LocalFileSource } from "../core/source/local-file-source";
import { TracingByteSource } from "../core/source/tracing-byte-source";
import type { ByteSource } from "../core/source/types";
import { isPlainDirectory } from "./directory-util";
import type { AppState, DirColumn, DirView, HexWindow } from "./state";
import type { Store } from "./store";

/** Hex Viewer が 1 度に読む量。巨大 section を開いても全体を読まないための上限 */
export const HEX_PAGE_SIZE = 4096;
/** Directory Viewer の 1 ページの entry 数。leaf は 4096 entry 程度になるので全行は描かない */
export const DIR_PAGE_SIZE = 200;

/**
 * ユーザ操作を store の変更に変換する唯一の場所。
 * パネルは controller を呼ぶだけで、I/O も他パネルの更新も直接は行わない。
 */
export class Controller {
  private openSeq = 0;

  constructor(private readonly store: Store<AppState>) {}

  openFile(file: Blob, name: string) {
    return this.open(new LocalFileSource(file, name));
  }

  async open(inner: ByteSource) {
    const seq = ++this.openSeq;
    const source = new TracingByteSource(inner);
    this.store.set({
      status: "loading",
      error: undefined,
      source,
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
    });
    // read が起きるたびに Range Trace を更新する。後から別ファイルを開いたら古い通知は捨てる
    source.subscribe(() => {
      if (seq === this.openSeq) this.store.set({ reads: [...source.records] });
    });

    try {
      const archive = await PmtilesArchive.open(source);
      if (seq !== this.openSeq) return;
      const layout = computeLayout(archive.header, source.size());
      this.store.set({
        status: "ready",
        archive,
        layout,
        hex: { baseOffset: 0, bytes: archive.firstRead.bytes, origin: "first-read" },
        // root は先頭 16 KiB に含まれていて読み終わっているので、開いた時点で見せる（追加 I/O なし）
        dirView: { dir: archive.root, trail: [], page: 0 },
      });
    } catch (e) {
      if (seq === this.openSeq) this.store.set({ status: "error", error: message(e) });
      return;
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

/**
 * directory の bytes（ファイル上のもの = 圧縮後）を Hex の窓にする。
 * 既に読んだ bytes を見せるだけなので、Read Trace に表示用の read は増えない。
 */
function dirHex(dir: DirectoryRecord): HexWindow {
  return { baseOffset: dir.fileOffset, bytes: dir.compressed, origin: "directory", dir };
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

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
