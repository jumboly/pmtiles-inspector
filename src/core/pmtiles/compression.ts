import { Compression, compressionName } from "./enums";

export class UnsupportedCompressionError extends Error {
  override name = "UnsupportedCompressionError";
  constructor(readonly compression: number, detail?: string) {
    super(`${compressionName(compression)} の解凍に対応していません${detail ? `: ${detail}` : ""}`);
  }
}

/** Web 標準 DecompressionStream の format 名。PMTiles enum とは名前も値も別物なので明示的に写像する。 */
const STREAM_FORMAT: Partial<Record<number, string>> = {
  [Compression.Gzip]: "gzip",
  [Compression.Brotli]: "brotli",
  [Compression.Zstd]: "zstd",
};

/**
 * PMTiles の Compression enum に従って解凍する。
 *
 * 外部ライブラリではなくブラウザ標準の DecompressionStream を使う。
 * 対応 format はブラウザごとに異なる（2026-09 時点で gzip は全主要ブラウザ、brotli/zstd は実装差あり）ため、
 * 事前に決め打ちせず、生成に失敗したら UnsupportedCompressionError として呼び出し側に知らせる。
 * 呼び出し側はそれを受けて Raw Inspector に fallback できる。
 *
 * Unknown(0) を「無圧縮扱い」にするのは公式実装と同じ挙動。spec 上は「未指定の方式」なので、
 * UI では「無圧縮とみなして読んだ」ことを明示する必要がある。
 */
export async function decompress(bytes: Uint8Array, compression: number): Promise<Uint8Array> {
  if (compression === Compression.None || compression === Compression.Unknown) {
    return bytes;
  }
  const format = STREAM_FORMAT[compression];
  if (!format) throw new UnsupportedCompressionError(compression);

  let stream: DecompressionStream;
  try {
    stream = new DecompressionStream(format as CompressionFormat);
  } catch (e) {
    throw new UnsupportedCompressionError(
      compression,
      `この実行環境の DecompressionStream が "${format}" を受け付けません`,
    );
  }
  const out = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}
