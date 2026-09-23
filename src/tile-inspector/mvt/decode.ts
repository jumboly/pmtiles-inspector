import {
  appendUint32s,
  fieldDouble,
  fieldFloat,
  fieldString,
  fieldVarint,
  fieldVarintBig,
  PbError,
  readFields,
  readFieldsLenient,
  WireType,
  zigzagBig,
  type PbField,
} from "../protobuf/reader";
import type { ByteSpan } from "../span";

/**
 * MVT (Mapbox Vector Tile 2.1) の decoder。
 *
 * 入力は Tile Payload の bytes だけで、PMTiles の offset や entry は一切知らない（inspectMvt(bytes) だけで動く）。
 * 値と一緒に「Payload のどの byte から来たか」を残し、壊れた tile でも読めたところまで返す（例外で全体を捨てない）。
 * geometry はここでは command integer の列のまま持ち、座標への展開は geometry.ts で feature ごとに行う
 * （数千 feature の tile を開くたびに全座標を作らないため）。
 *
 * https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */

/** vector_tile.proto の field 番号 */
const TILE_LAYERS = 3;
const LAYER = { name: 1, features: 2, keys: 3, values: 4, extent: 5, version: 15 } as const;
const FEATURE = { id: 1, tags: 2, type: 3, geometry: 4 } as const;
const VALUE = { string: 1, float: 2, double: 3, int: 4, uint: 5, sint: 6, bool: 7 } as const;

export const GeomType = { Unknown: 0, Point: 1, LineString: 2, Polygon: 3 } as const;
export const GEOM_TYPE_NAMES: Record<number, string> = { 0: "UNKNOWN", 1: "POINT", 2: "LINESTRING", 3: "POLYGON" };

/** spec 4.1: extent の既定値 */
const DEFAULT_EXTENT = 4096;

export type MvtValueType = "string" | "float" | "double" | "int" | "uint" | "sint" | "bool" | "unknown";

export interface MvtValue {
  type: MvtValueType;
  /** 64bit 整数（int / uint / sint）は精度を落とさないよう、2^53 を超えるときだけ bigint にする */
  value: string | number | bigint | boolean | undefined;
  /** Value message 全体（layer の values の 1 要素の tag から） */
  span: ByteSpan;
  /** 実際に値を持っていた field の値の bytes */
  valueSpan?: ByteSpan;
}

export interface MvtFeature {
  index: number;
  /** id field が無ければ undefined（spec 上の既定値 0 と「無い」を区別する） */
  id?: number | bigint;
  type: number;
  /** keys / values への index の対の並び（[k0, v0, k1, v1, …]） */
  tags: number[];
  /** command integer の列（CommandInteger と ParameterInteger が混ざったまま） */
  geometry: number[];
  span: ByteSpan;
  fieldSpans: { id?: ByteSpan; tags?: ByteSpan; type?: ByteSpan; geometry?: ByteSpan };
  issues: string[];
}

export interface MvtLayer {
  index: number;
  name: string;
  version: number;
  /** version field が無かった（proto の既定値 1 を使った） */
  versionDefaulted: boolean;
  extent: number;
  extentDefaulted: boolean;
  keys: string[];
  values: MvtValue[];
  features: MvtFeature[];
  /** layers field 全体（tag から） */
  span: ByteSpan;
  /** 種類ごとの bytes の合計。「この layer の bytes の大半は geometry」などを見せるため */
  bytes: { features: number; geometry: number; tags: number; keys: number; values: number };
  issues: string[];
}

export interface MvtTile {
  layers: MvtLayer[];
  /** layers 以外の top-level field（extensions など） */
  unknownFields: PbField[];
  /** 読めなくなった位置。そこまでに読めた layer は layers に残る */
  error?: { message: string; offset: number };
  issues: string[];
}

export function inspectMvt(bytes: Uint8Array): MvtTile {
  const tile: MvtTile = { layers: [], unknownFields: [], issues: [] };
  // 途中で壊れていても、壊れる前までの layer は読みたい
  const { fields, error } = readFieldsLenient(bytes);
  if (error) tile.error = toError(error);
  for (const f of fields) {
    if (f.field !== TILE_LAYERS) {
      tile.unknownFields.push(f);
      continue;
    }
    if (f.wireType !== WireType.Len) {
      tile.issues.push(`layers field が LEN でない（wire type ${f.wireType}, +${f.tag.offset}）`);
      continue;
    }
    try {
      tile.layers.push(decodeLayer(bytes, f, tile.layers.length));
    } catch (e) {
      tile.error ??= toError(e);
      break;
    }
  }
  // spec 4.1: 同じ tile 内で layer name は一意でなければならない
  const seen = new Set<string>();
  for (const l of tile.layers) {
    if (seen.has(l.name)) tile.issues.push(`layer name "${l.name}" が重複している（spec 4.1 違反）`);
    seen.add(l.name);
  }
  return tile;
}

function decodeLayer(buf: Uint8Array, lf: PbField, index: number): MvtLayer {
  const layer: MvtLayer = {
    index,
    name: "",
    version: 1,
    versionDefaulted: true,
    extent: DEFAULT_EXTENT,
    extentDefaulted: true,
    keys: [],
    values: [],
    features: [],
    span: lf.span,
    bytes: { features: 0, geometry: 0, tags: 0, keys: 0, values: 0 },
    issues: [],
  };
  let hasName = false;
  const featureFields: PbField[] = [];
  for (const f of readFields(buf, lf.value.offset, lf.value.offset + lf.value.length)) {
    switch (f.field) {
      case LAYER.name:
        layer.name = fieldString(buf, f);
        hasName = true;
        break;
      case LAYER.version:
        layer.version = fieldVarint(buf, f);
        layer.versionDefaulted = false;
        break;
      case LAYER.extent:
        layer.extent = fieldVarint(buf, f);
        layer.extentDefaulted = false;
        break;
      case LAYER.keys:
        layer.keys.push(fieldString(buf, f));
        layer.bytes.keys += f.span.length;
        break;
      case LAYER.values:
        layer.values.push(decodeValue(buf, f, layer.issues));
        layer.bytes.values += f.span.length;
        break;
      case LAYER.features:
        // features は keys / values より前に並んでいてもよい（field の順序は自由）。tags の範囲検査は全部読んでから行う
        featureFields.push(f);
        layer.bytes.features += f.span.length;
        break;
      default:
        layer.issues.push(`未知の field ${f.field}（+${f.tag.offset}）`);
    }
  }
  if (!hasName) layer.issues.push("name が無い（spec 4.1: 必須）");
  // spec 4.1: 「version を最初に読んで、その version 用の実装を選ぶ」。このデコーダは 2 を前提に書いている
  if (layer.version !== 2) layer.issues.push(`version ${layer.version}: このデコーダは version 2（spec 2.x）として読んでいる`);
  if (layer.extentDefaulted) layer.issues.push(`extent が無い（既定値 ${DEFAULT_EXTENT} を使った）`);

  for (const f of featureFields) {
    let feat: MvtFeature;
    try {
      feat = decodeFeature(buf, f, layer.features.length);
    } catch (e) {
      // 1 feature が壊れていても layer の残りは読む。壊れた feature は index を詰めずに空の feature として残す（index = 並び順を保つため）
      feat = { index: layer.features.length, type: GeomType.Unknown, tags: [], geometry: [], span: f.span, fieldSpans: {}, issues: [`decode できない: ${toError(e).message}`] };
    }
    layer.bytes.geometry += feat.fieldSpans.geometry?.length ?? 0;
    layer.bytes.tags += feat.fieldSpans.tags?.length ?? 0;
    checkTags(feat, layer);
    layer.features.push(feat);
  }
  return layer;
}

function decodeFeature(buf: Uint8Array, ff: PbField, index: number): MvtFeature {
  const feat: MvtFeature = { index, type: GeomType.Unknown, tags: [], geometry: [], span: ff.span, fieldSpans: {}, issues: [] };
  for (const f of readFields(buf, ff.value.offset, ff.value.offset + ff.value.length)) {
    switch (f.field) {
      case FEATURE.id: {
        const v = fieldVarintBig(buf, f);
        feat.id = v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
        feat.fieldSpans.id = f.span;
        break;
      }
      case FEATURE.tags:
        appendUint32s(buf, f, feat.tags);
        feat.fieldSpans.tags = merge(feat.fieldSpans.tags, f.span);
        break;
      case FEATURE.type:
        feat.type = fieldVarint(buf, f);
        feat.fieldSpans.type = f.span;
        break;
      case FEATURE.geometry:
        appendUint32s(buf, f, feat.geometry);
        feat.fieldSpans.geometry = merge(feat.fieldSpans.geometry, f.span);
        break;
      default:
        feat.issues.push(`未知の field ${f.field}（+${f.tag.offset}）`);
    }
  }
  if (feat.type === GeomType.Unknown) feat.issues.push("geometry type が UNKNOWN（spec 4.3.4: decoder は無視してよい）");
  else if (!(feat.type in GEOM_TYPE_NAMES)) feat.issues.push(`geometry type ${feat.type} は spec に無い`);
  if (!feat.geometry.length) feat.issues.push("geometry が空");
  return feat;
}

/** spec 4.4: tags は key / value の index の対で、どちらも layer の keys / values の範囲内でなければならない */
function checkTags(feat: MvtFeature, layer: MvtLayer) {
  if (feat.tags.length % 2 !== 0) feat.issues.push("tags の数が奇数（key と value の対になっていない）");
  for (let i = 0; i + 1 < feat.tags.length; i += 2) {
    if (feat.tags[i]! >= layer.keys.length) feat.issues.push(`tags[${i}] = ${feat.tags[i]}: keys の範囲外`);
    if (feat.tags[i + 1]! >= layer.values.length) feat.issues.push(`tags[${i + 1}] = ${feat.tags[i + 1]}: values の範囲外`);
  }
}

function decodeValue(buf: Uint8Array, vf: PbField, issues: string[]): MvtValue {
  const fields = readFields(buf, vf.value.offset, vf.value.offset + vf.value.length);
  // spec 4.1: Value はちょうど 1 つの値を持たなければならない
  if (fields.length !== 1) issues.push(`Value（+${vf.tag.offset}）の field が ${fields.length} 個（ちょうど 1 個であるべき）`);
  const f = fields.at(-1);
  const base = { span: vf.span, valueSpan: f?.value };
  if (!f) return { type: "unknown", value: undefined, ...base };
  switch (f.field) {
    case VALUE.string:
      return { type: "string", value: fieldString(buf, f), ...base };
    case VALUE.float:
      return { type: "float", value: fieldFloat(buf, f), ...base };
    case VALUE.double:
      return { type: "double", value: fieldDouble(buf, f), ...base };
    case VALUE.int:
      // int64 は負数を 2 の補数の 64bit として varint にする（だから負数は常に 10 byte になる。sint が別にある理由）
      return { type: "int", value: safe(BigInt.asIntN(64, fieldVarintBig(buf, f))), ...base };
    case VALUE.uint:
      return { type: "uint", value: safe(fieldVarintBig(buf, f)), ...base };
    case VALUE.sint:
      return { type: "sint", value: safe(zigzagBig(fieldVarintBig(buf, f))), ...base };
    case VALUE.bool:
      return { type: "bool", value: fieldVarint(buf, f) !== 0, ...base };
    default:
      return { type: "unknown", value: undefined, ...base };
  }
}

function safe(v: bigint): number | bigint {
  return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
}

/** packed でない repeated field は複数回現れ得るので、範囲は最初から最後までをまとめて持つ */
function merge(a: ByteSpan | undefined, b: ByteSpan): ByteSpan {
  if (!a) return b;
  const start = Math.min(a.offset, b.offset);
  return { offset: start, length: Math.max(a.offset + a.length, b.offset + b.length) - start };
}

export interface MvtProperty {
  keyIndex: number;
  valueIndex: number;
  key?: string;
  value?: MvtValue;
}

/** feature の tags を keys / values で引いて property の並びにする（範囲外の index は undefined のまま返す） */
export function featureProperties(layer: MvtLayer, feat: MvtFeature): MvtProperty[] {
  const out: MvtProperty[] = [];
  for (let i = 0; i + 1 < feat.tags.length; i += 2) {
    const keyIndex = feat.tags[i]!;
    const valueIndex = feat.tags[i + 1]!;
    out.push({ keyIndex, valueIndex, key: layer.keys[keyIndex], value: layer.values[valueIndex] });
  }
  return out;
}

function toError(e: unknown): { message: string; offset: number } {
  return e instanceof PbError ? { message: e.message, offset: e.offset } : { message: e instanceof Error ? e.message : String(e), offset: -1 };
}
