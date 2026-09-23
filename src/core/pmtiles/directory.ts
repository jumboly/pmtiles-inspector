import type { ByteSpan, Spanned } from "./span";
import { encodeVarint, readVarint } from "./varint";

export interface Entry {
  tileId: number;
  /** tile entry なら tile data section 先頭から、leaf entry なら leaf directories section 先頭からの相対 offset */
  offset: number;
  length: number;
  /** 0 = leaf directory を指す entry。1 以上 = 連続する runLength 個の TileID が同じ tile content を指す */
  runLength: number;
}

/**
 * offset 列の 1 要素がどう符号化されていたか (spec §4.2 Offsets)。
 * - "contiguous": 符号値 0。直前 entry の offset+length の直後に続いている
 * - "explicit"  : 符号値 offset+1。先頭 entry、または連続していない（dedup で前方を参照する等）
 */
export type OffsetMode = "contiguous" | "explicit";

export interface EncodedOffset extends Spanned<number> {
  mode: OffsetMode;
}

/**
 * Directory Encoding Viewer 用に、解凍後バッファ上のどこに何が入っていたかをすべて保持する。
 * 列指向（TileID 列 → RunLength 列 → Length 列 → Offset 列）であることがそのまま構造に現れる。
 */
export interface DirectoryEncoding {
  count: Spanned<number>;
  /** TileID の差分値（先頭は 0 からの差分 = TileID そのもの） */
  tileIdDeltas: Spanned<number>[];
  runLengths: Spanned<number>[];
  lengths: Spanned<number>[];
  offsets: EncodedOffset[];
  /** 各列が解凍後バッファ上で占める範囲 */
  columns: Record<"count" | "tileIds" | "runLengths" | "lengths" | "offsets", ByteSpan>;
  /** 解凍後バッファの長さ。columns の合計と一致しなければ末尾にゴミがある */
  decodedLength: number;
}

/**
 * spec 違反だが読み進められるもの。例外にせず記録するのは、Viewer 上で「どこが規約外か」を見せたいため。
 * - empty-directory      : entry 数 0 (spec §4.2 MUST > 0)。公式実装は root では許容し、leaf では例外にする
 * - first-offset-zero    : 先頭 entry の offset 符号値が 0（offset = -1 になる）
 * - zero-length          : length が 0 の entry (spec §4.1 MUST > 0)
 */
export type DirectoryIssue =
  | { code: "empty-directory" }
  | { code: "first-offset-zero" }
  | { code: "zero-length"; index: number };

export interface DecodedDirectory {
  entries: Entry[];
  encoding: DirectoryEncoding;
  issues: DirectoryIssue[];
}

/**
 * 解凍済みの directory bytes を decode する (spec §4.3 / Appendix A.2)。
 *
 * 公式 deserializeIndex と同じ順序・同じ規則で読むが、各 varint の位置も返す。
 * 解凍は呼び出し側の責務にしている。Tile Trace で
 * 「Range Read → Internal Decompression → Directory Decode」を別ステップとして見せるため。
 */
export function decodeDirectory(buf: Uint8Array): DecodedDirectory {
  let pos = 0;
  const next = () => {
    const v = readVarint(buf, pos);
    pos += v.length;
    return v;
  };
  const columnFrom = (start: number): ByteSpan => ({ offset: start, length: pos - start });

  const issues: DirectoryIssue[] = [];
  const count = next();
  const n = count.value;
  if (n === 0) issues.push({ code: "empty-directory" });
  const columns = { count: columnFrom(0) } as DirectoryEncoding["columns"];

  let start = pos;
  const tileIdDeltas: Spanned<number>[] = [];
  const entries: Entry[] = [];
  let lastId = 0;
  for (let i = 0; i < n; i++) {
    const d = next();
    tileIdDeltas.push(d);
    lastId += d.value;
    entries.push({ tileId: lastId, offset: 0, length: 0, runLength: 0 });
  }
  columns.tileIds = columnFrom(start);

  start = pos;
  const runLengths: Spanned<number>[] = [];
  for (let i = 0; i < n; i++) {
    const v = next();
    runLengths.push(v);
    entries[i]!.runLength = v.value;
  }
  columns.runLengths = columnFrom(start);

  start = pos;
  const lengths: Spanned<number>[] = [];
  for (let i = 0; i < n; i++) {
    const v = next();
    lengths.push(v);
    entries[i]!.length = v.value;
    if (v.value === 0) issues.push({ code: "zero-length", index: i });
  }
  columns.lengths = columnFrom(start);

  start = pos;
  const offsets: EncodedOffset[] = [];
  for (let i = 0; i < n; i++) {
    const v = next();
    const e = entries[i]!;
    if (v.value === 0 && i > 0) {
      const prev = entries[i - 1]!;
      e.offset = prev.offset + prev.length;
      offsets.push({ ...v, mode: "contiguous" });
    } else {
      // 先頭 entry の符号値 0 は offset = -1 となり不正だが、公式同様そのまま読んで issue として記録する
      if (v.value === 0) issues.push({ code: "first-offset-zero" });
      e.offset = v.value - 1;
      offsets.push({ ...v, mode: "explicit" });
    }
  }
  columns.offsets = columnFrom(start);

  return {
    entries,
    encoding: { count, tileIdDeltas, runLengths, lengths, offsets, columns, decodedLength: buf.length },
    issues,
  };
}

/**
 * entries を spec §4.3 の規則で directory bytes（圧縮前）に符号化する。
 *
 * reader には不要だが、2 つの目的で持つ:
 * - 公式 writer が作った bytes と一致するかを確かめ、「符号化規則を正しく理解しているか」をテストする
 * - Directory Encoding Viewer で「行 → 列 → 差分 → varint」の各段階を同じ規則から示す
 */
export function encodeDirectory(entries: readonly Entry[]): Uint8Array {
  const out: number[] = [];
  const put = (v: number) => out.push(...encodeVarint(v));
  put(entries.length);
  let lastId = 0;
  for (const e of entries) {
    put(e.tileId - lastId);
    lastId = e.tileId;
  }
  for (const e of entries) put(e.runLength);
  for (const e of entries) put(e.length);
  entries.forEach((e, i) => put(encodeOffset(entries, i).value));
  return Uint8Array.from(out);
}

/** i 番目の entry の offset 符号値。直前 entry の直後に続いていれば 0、それ以外は offset + 1 */
export function encodeOffset(entries: readonly Entry[], i: number): { value: number; mode: OffsetMode; expected?: number } {
  const e = entries[i]!;
  if (i > 0) {
    const prev = entries[i - 1]!;
    const expected = prev.offset + prev.length;
    return e.offset === expected ? { value: 0, mode: "contiguous", expected } : { value: e.offset + 1, mode: "explicit", expected };
  }
  return { value: e.offset + 1, mode: "explicit" };
}

/**
 * explicit になった offset の理由別件数。
 * - backward: 既出 content の再利用（dedup）で前方を指す
 * - resume  : dedup の直後、それまでに書かれた末尾（high-water mark）から再開する。
 *             直前 entry（= 参照先の古い content）の直後ではないので 0 にできず explicit になる
 * - forward : high-water mark より先へ飛ぶ。tile data が TileID 順に並んでいない（clustered でない）か、隙間がある
 * clustered なアーカイブなら forward は 0 になる。
 */
export interface OffsetSummary {
  contiguous: number;
  first: number;
  backward: number;
  resume: number;
  forward: number;
}

export function summarizeOffsets(entries: readonly Entry[]): OffsetSummary {
  const s: OffsetSummary = { contiguous: 0, first: 0, backward: 0, resume: 0, forward: 0 };
  let highWater = 0;
  entries.forEach((e, i) => {
    const enc = encodeOffset(entries, i);
    if (enc.mode === "contiguous") s.contiguous++;
    else if (enc.expected === undefined) s.first++;
    else if (e.offset < enc.expected) s.backward++;
    else if (e.offset === highWater) s.resume++;
    else s.forward++;
    highWater = Math.max(highWater, e.offset + e.length);
  });
  return s;
}
