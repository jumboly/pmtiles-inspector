import type { ByteSpan } from "../span";

/**
 * raster tile の header から寸法を読む。画素は decode しない（preview はブラウザの decoder に任せる）。
 *
 * ブラウザの decode 結果（naturalWidth など）だけでなく自前で header を読むのは、
 * 「幅と高さが bytes のどこに書いてあるか」を示し、ブラウザの結果と突き合わせるため。
 * PMTiles の型は受け取らない（bytes だけで動く）。
 */
export type RasterFormat = "png" | "jpeg" | "webp" | "avif";

export interface RasterField {
  label: string;
  value: string | number;
  span: ByteSpan;
}

export interface RasterInfo {
  format: RasterFormat;
  width?: number;
  height?: number;
  /** 寸法を読んだ bytes（width と height が別の場所にある形式もあるので配列） */
  sizeSpans: ByteSpan[];
  /** 寸法以外に読んだ header の項目（bit depth・圧縮方式など） */
  fields: RasterField[];
  /** 形式の中の下位形式（例: WebP の VP8 / VP8L / VP8X、JPEG の baseline / progressive） */
  variant?: string;
  issues: string[];
}

export function inspectRaster(bytes: Uint8Array, format: RasterFormat): RasterInfo {
  const info: RasterInfo = { format, sizeSpans: [], fields: [], issues: [] };
  try {
    if (format === "png") png(bytes, info);
    else if (format === "jpeg") jpeg(bytes, info);
    else if (format === "webp") webp(bytes, info);
    else avif(bytes, info);
  } catch (e) {
    info.issues.push(e instanceof RangeError ? "header が途中で切れている" : e instanceof Error ? e.message : String(e));
  }
  if (info.width === undefined && !info.issues.length) info.issues.push("寸法を記した header が見つからない");
  return info;
}

const be16 = (b: Uint8Array, i: number) => need(b, i + 2) && (b[i]! << 8) | b[i + 1]!;
const be32 = (b: Uint8Array, i: number) => need(b, i + 4) && ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0;
const le16 = (b: Uint8Array, i: number) => need(b, i + 2) && b[i]! | (b[i + 1]! << 8);
const le24 = (b: Uint8Array, i: number) => need(b, i + 3) && b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16);
const le32 = (b: Uint8Array, i: number) => need(b, i + 4) && (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0;
const ascii = (b: Uint8Array, i: number, n: number) => (need(b, i + n) ? String.fromCharCode(...b.subarray(i, i + n)) : "");

function need(b: Uint8Array, end: number): number {
  if (end > b.length) throw new RangeError("truncated");
  return 1;
}

/**
 * PNG: 8 byte の signature の直後に必ず IHDR chunk が来る（PNG spec 5.6）。
 * chunk = length(4, BE) + type(4) + data + CRC(4)。IHDR の data は width(4) height(4) bit depth color type …
 */
function png(b: Uint8Array, info: RasterInfo) {
  if (ascii(b, 12, 4) !== "IHDR") throw new Error("signature の直後が IHDR chunk でない");
  info.width = be32(b, 16);
  info.height = be32(b, 20);
  info.sizeSpans.push({ offset: 16, length: 4 }, { offset: 20, length: 4 });
  const colorTypes: Record<number, string> = { 0: "Grayscale", 2: "Truecolor (RGB)", 3: "Indexed", 4: "Grayscale + alpha", 6: "Truecolor + alpha (RGBA)" };
  info.fields.push(
    { label: "Bit depth", value: b[24]!, span: { offset: 24, length: 1 } },
    { label: "Color type", value: `${b[25]} = ${colorTypes[b[25]!] ?? "不明"}`, span: { offset: 25, length: 1 } },
    { label: "Interlace", value: b[28] === 1 ? "1 = Adam7" : `${b[28]} = なし`, span: { offset: 28, length: 1 } },
  );
}

/**
 * JPEG: SOI(FFD8) の後に marker segment（FF xx + length(2, BE, length 自身を含む)）が並ぶ。
 * 寸法は SOF (Start Of Frame) segment にある: precision(1) height(2) width(2) components(1)。
 * SOF の種類（C0 = baseline, C2 = progressive …）が符号化方式を表す（ITU-T T.81 B.2.2）。
 */
function jpeg(b: Uint8Array, info: RasterInfo) {
  const SOF_NAMES: Record<number, string> = {
    0xc0: "Baseline DCT",
    0xc1: "Extended sequential DCT",
    0xc2: "Progressive DCT",
    0xc3: "Lossless",
    0xc5: "Differential sequential DCT",
    0xc6: "Differential progressive DCT",
    0xc7: "Differential lossless",
    0xc9: "Extended sequential DCT (arithmetic)",
    0xca: "Progressive DCT (arithmetic)",
    0xcb: "Lossless (arithmetic)",
    0xcd: "Differential sequential DCT (arithmetic)",
    0xce: "Differential progressive DCT (arithmetic)",
    0xcf: "Differential lossless (arithmetic)",
  };
  let p = 2;
  while (p + 4 <= b.length) {
    if (b[p] !== 0xff) throw new Error(`+${p}: marker（FF xx）があるべき位置に ${b[p]!.toString(16)} がある`);
    const m = b[p + 1]!;
    // FF の連続は fill bytes
    if (m === 0xff) {
      p++;
      continue;
    }
    // length を持たない marker（TEM, RSTn）
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      p += 2;
      continue;
    }
    const len = be16(b, p + 2);
    const name = SOF_NAMES[m];
    if (name) {
      info.variant = `SOF${(m - 0xc0).toString(16).toUpperCase()} = ${name}`;
      info.height = be16(b, p + 5);
      info.width = be16(b, p + 7);
      info.sizeSpans.push({ offset: p + 7, length: 2 }, { offset: p + 5, length: 2 });
      info.fields.push(
        { label: "SOF marker", value: `FF ${m.toString(16).toUpperCase()}`, span: { offset: p, length: 2 } },
        { label: "Sample precision", value: `${b[p + 4]} bit`, span: { offset: p + 4, length: 1 } },
        { label: "Components", value: b[p + 9]!, span: { offset: p + 9, length: 1 } },
      );
      return;
    }
    // SOS の後はエントロピー符号化データなので、SOF はもう現れない
    if (m === 0xda) throw new Error("SOF より前に SOS（画像データの開始）が来た");
    p += 2 + len;
  }
}

/**
 * WebP: RIFF container（'RIFF' size 'WEBP'）の最初の chunk で形式が決まる（RFC 9649）。
 * - 'VP8 ' = lossy: VP8 key frame header（RFC 6386 9.1）: frame tag(3) + start code 9D 01 2A + width(14bit)+scale(2bit) + height 同様
 * - 'VP8L' = lossless: signature 0x2F の後の 28 bit に (width-1)(14bit) (height-1)(14bit)
 * - 'VP8X' = extended（alpha・animation 等）: flags(1) reserved(3) の後に canvas の (width-1)(24bit LE) (height-1)(24bit LE)
 */
function webp(b: Uint8Array, info: RasterInfo) {
  const fourcc = ascii(b, 12, 4);
  const data = 20;
  info.fields.push({ label: "最初の chunk", value: `'${fourcc}'`, span: { offset: 12, length: 4 } });
  if (fourcc === "VP8 ") {
    info.variant = "VP8 (lossy)";
    if (b[data + 3] !== 0x9d || b[data + 4] !== 0x01 || b[data + 5] !== 0x2a) throw new Error("VP8 key frame の start code (9D 01 2A) が無い");
    const w = le16(b, data + 6);
    const hgt = le16(b, data + 8);
    info.width = w & 0x3fff;
    info.height = hgt & 0x3fff;
    info.sizeSpans.push({ offset: data + 6, length: 2 }, { offset: data + 8, length: 2 });
    if (w >> 14 || hgt >> 14) info.fields.push({ label: "Scale", value: `${w >> 14} / ${hgt >> 14}`, span: { offset: data + 6, length: 4 } });
  } else if (fourcc === "VP8L") {
    info.variant = "VP8L (lossless)";
    if (b[data] !== 0x2f) throw new Error("VP8L の signature (0x2F) が無い");
    const bits = le32(b, data + 1);
    info.width = (bits & 0x3fff) + 1;
    info.height = ((bits >>> 14) & 0x3fff) + 1;
    info.sizeSpans.push({ offset: data + 1, length: 4 });
    info.fields.push({ label: "Alpha is used", value: (bits >>> 28) & 1 ? "1" : "0", span: { offset: data + 4, length: 1 } });
  } else if (fourcc === "VP8X") {
    info.variant = "VP8X (extended)";
    const flags = b[data]!;
    const names = [
      [0x20, "ICC"],
      [0x10, "Alpha"],
      [0x08, "EXIF"],
      [0x04, "XMP"],
      [0x02, "Animation"],
    ] as const;
    info.fields.push({ label: "Flags", value: names.filter(([bit]) => flags & bit).map(([, n]) => n).join(", ") || "なし", span: { offset: data, length: 1 } });
    info.width = le24(b, data + 4) + 1;
    info.height = le24(b, data + 7) + 1;
    info.sizeSpans.push({ offset: data + 4, length: 3 }, { offset: data + 7, length: 3 });
  } else {
    throw new Error(`未知の WebP chunk '${fourcc}'`);
  }
}

/**
 * AVIF: ISOBMFF の box の入れ子。寸法は meta → iprp → ipco の中の property にある（ISO/IEC 23008-12 HEIF）。
 * - 'ispe'（Image Spatial Extents）: FullBox + image_width(4) + image_height(4) = **符号化された**画像の寸法
 * - 'clap'（Clean Aperture）: 表示する範囲を切り抜く。AV1 は寸法を偶数に揃えて符号化することがあり、奇数の寸法はここで表す
 * - 'irot'（Image Rotation）: 90° 単位の回転。90° / 270° なら幅と高さが入れ替わる
 * HEIF は clap → irot の順に適用する。どの property が主画像のものかは pitm（主 item の id）と ipma（item → property index）で決まる。
 */
function avif(b: Uint8Array, info: RasterInfo) {
  const top = boxes(b, 0, b.length);
  const ftyp = top.find((x) => x.type === "ftyp");
  if (ftyp) info.fields.push({ label: "Major brand", value: `'${ascii(b, ftyp.body, 4)}'`, span: { offset: ftyp.body, length: 4 } });
  const meta = top.find((x) => x.type === "meta");
  if (!meta) throw new Error("meta box が無い");
  // meta は FullBox なので、子の box は version/flags の 4 byte の後から始まる
  const metaKids = boxes(b, meta.body + 4, meta.end);
  const iprp = boxes(b, ...span(metaKids.find((x) => x.type === "iprp")));
  const ipco = iprp.find((x) => x.type === "ipco");
  if (!ipco) throw new Error("iprp / ipco box が無い");
  const props = boxes(b, ipco.body, ipco.end);

  const pitm = metaKids.find((x) => x.type === "pitm");
  const primary = pitm ? (b[pitm.body]! === 0 ? be16(b, pitm.body + 4) : be32(b, pitm.body + 4)) : undefined;
  if (primary !== undefined && pitm) info.fields.push({ label: "Primary item (pitm)", value: primary, span: { offset: pitm.body + 4, length: b[pitm.body] === 0 ? 2 : 4 } });
  const ipma = iprp.find((x) => x.type === "ipma");
  const assoc = primary !== undefined && ipma ? ipmaAssociations(b, ipma, primary) : [];
  // property index は 1 始まり。主画像に結び付いたものが無ければ（pitm / ipma が無い不完全なファイル）先頭のものを使う
  const pick = (type: string) => props.find((p, i) => p.type === type && assoc.includes(i + 1)) ?? (assoc.length ? undefined : props.find((p) => p.type === type));

  const ispe = pick("ispe");
  if (!ispe) throw new Error("主画像の ispe property が無い");
  let w = be32(b, ispe.body + 4);
  let hgt = be32(b, ispe.body + 8);
  info.fields.push({ label: "ispe（符号化サイズ）", value: `${w} × ${hgt}`, span: { offset: ispe.body + 4, length: 8 } });
  info.sizeSpans.push({ offset: ispe.body + 4, length: 8 });
  const steps = ["ispe"];

  const clap = pick("clap");
  if (clap) {
    // clap は FullBox ではない。幅・高さは分数（N / D）で書く
    const cw = be32(b, clap.body) / be32(b, clap.body + 4);
    const ch = be32(b, clap.body + 8) / be32(b, clap.body + 12);
    info.fields.push({ label: "clap（切り抜き後）", value: `${cw} × ${ch}`, span: { offset: clap.body, length: 16 } });
    info.sizeSpans.push({ offset: clap.body, length: 16 });
    w = cw;
    hgt = ch;
    steps.push("clap");
  }
  const irot = pick("irot");
  if (irot) {
    const angle = (b[irot.body]! & 0x3) * 90;
    info.fields.push({ label: "irot（反時計回り）", value: `${angle}°`, span: { offset: irot.body, length: 1 } });
    if (angle === 90 || angle === 270) [w, hgt] = [hgt, w];
    steps.push("irot");
  }
  info.width = w;
  info.height = hgt;
  info.variant = `表示寸法 = ${steps.join(" → ")}`;
}

interface Box {
  type: string;
  start: number;
  /** header の後（中身の先頭） */
  body: number;
  end: number;
}

function span(bx: Box | undefined): [number, number] {
  return bx ? [bx.body, bx.end] : [0, 0];
}

/** box = size(4, BE) + type(4)。size = 1 なら直後に 64bit の largesize、0 なら親の終わりまで */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = be32(b, p);
    const type = ascii(b, p + 4, 4);
    let body = p + 8;
    if (size === 1) {
      size = be32(b, p + 8) * 2 ** 32 + be32(b, p + 12);
      body = p + 16;
    } else if (size === 0) {
      size = end - p;
    }
    if (size < body - p || p + size > end) throw new Error(`box '${type}'（+${p}）の size が不正`);
    out.push({ type, start: p, body, end: p + size });
    p += size;
  }
  return out;
}

/** ipma（FullBox）から item_id に結び付いた property index（1 始まり）を返す */
function ipmaAssociations(b: Uint8Array, ipma: Box, itemId: number): number[] {
  const version = b[ipma.body]!;
  // ISOBMFF は big-endian。FullBox の flags は version の後の 24bit
  const flags = (b[ipma.body + 1]! << 16) | (b[ipma.body + 2]! << 8) | b[ipma.body + 3]!;
  let p = ipma.body + 4;
  const count = be32(b, p);
  p += 4;
  for (let i = 0; i < count; i++) {
    const id = version < 1 ? be16(b, p) : be32(b, p);
    p += version < 1 ? 2 : 4;
    const n = b[p++]!;
    const idx: number[] = [];
    for (let k = 0; k < n; k++) {
      // flags & 1 なら property index は 15bit（先頭 bit は essential フラグ）、そうでなければ 7bit
      if (flags & 1) {
        idx.push(be16(b, p) & 0x7fff);
        p += 2;
      } else {
        idx.push(b[p++]! & 0x7f);
      }
    }
    if (id === itemId) return idx;
  }
  return [];
}
