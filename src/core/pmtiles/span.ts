/**
 * 「その値がどの byte から作られたか」を表す範囲。
 *
 * offset は常に **parser に渡したバッファの先頭からの相対位置**。
 * Header は file offset 0 から読むのでそのまま絶対位置になるが、
 * Directory は解凍後バッファ上の位置になる（圧縮後の file 上の位置とは対応しない）。
 * 絶対位置への写像は、どのバッファをどこから読んだかを知っている呼び出し側（Viewer）が行う。
 */
export interface ByteSpan {
  offset: number;
  length: number;
}

/** 値と、その値を構成した bytes の範囲の組 */
export interface Spanned<T> extends ByteSpan {
  value: T;
}
