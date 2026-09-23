import { PmtilesArchive } from "../core/pmtiles/archive";
import { HEADER_LAYOUT, type HeaderKey, type SectionName } from "../core/pmtiles/header";
import { computeLayout } from "../core/pmtiles/layout";
import { LocalFileSource } from "../core/source/local-file-source";
import { TracingByteSource } from "../core/source/tracing-byte-source";
import type { ByteSource } from "../core/source/types";
import type { AppState, HexWindow } from "./state";
import type { Store } from "./store";

/** Hex Viewer が 1 度に読む量。巨大 section を開いても全体を読まないための上限 */
export const HEX_PAGE_SIZE = 4096;

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

  /** Hex Viewer 上の byte をクリックしたとき、その byte が属する論理要素を選ぶ（逆方向の連動） */
  selectByte(offset: number) {
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

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
