/**
 * Tile Content Inspector 内の byte 範囲。offset は常に **inspector に渡した bytes（Tile Payload）の先頭からの相対位置**。
 *
 * PMTiles core の ByteSpan と同じ形だが、あえて import しない。
 * Tile Content Inspector を PMTiles から独立して（MapLibre Tile Inspector などとして）切り出せるようにするため。
 * Payload 上の位置をファイル上の位置へ写すのは、Payload をどう読んだかを知っている Viewer 側の仕事。
 */
export interface ByteSpan {
  offset: number;
  length: number;
}
