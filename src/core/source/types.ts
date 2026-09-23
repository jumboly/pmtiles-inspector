/**
 * ByteSource 抽象。
 *
 * parser が fetch() や File.slice() を直接呼ばないのは、
 * 「どの処理が、ファイルのどこを、何 byte 読んだか」を 1 か所で観測するため。
 * TracingByteSource で包めば、Local でも HTTP でも同じ形で read trace が取れる。
 */

/** read の目的。Tile Trace と Range Trace を結び付けるために呼び出し側が付与する。 */
export type ReadPurpose =
  | "header+root"
  | "root-directory"
  | "metadata"
  | "leaf-directory"
  | "tile-data"
  /**
   * Viewer が表示のために読んだもの（Hex Viewer で任意の範囲を見る等）。
   * PMTiles の仕組み上必要な read と混ぜると「実際に読んだ量」を過大に見せてしまうため区別する。
   */
  | "viewer-inspect"
  | "other";

export interface ReadContext {
  purpose?: ReadPurpose;
  /** 人間向けの補足ラベル（例: "leaf for tileId 1234"）。表示用だが parser の判断には使わない。 */
  label?: string;
  signal?: AbortSignal;
}

/** HTTP 固有の観測情報。Local の場合は undefined。 */
export interface HttpReadInfo {
  url: string;
  requestRange: string;
  status: number;
  /** Range 可視化・トラブルシュートに必要なものだけ保持する */
  headers: Record<string, string>;
}

export interface ReadResult {
  /** 要求した offset。 */
  offset: number;
  /** 要求した length。 */
  requestedLength: number;
  /**
   * 実際に得られた bytes。EOF を跨いだ要求では requestedLength より短くなる。
   * PMTiles 公式実装は先頭 16 KiB を無条件に要求するため、小さいアーカイブではこれが普通に起こる。
   */
  bytes: Uint8Array;
  http?: HttpReadInfo;
  /** TracingByteSource を通した場合の READ 番号。Tile Trace の各ステップと Range Trace を結び付ける */
  readId?: number;
}

export interface ByteSource {
  /** 表示・キャッシュキー用の識別子 */
  readonly key: string;
  read(offset: number, length: number, ctx?: ReadContext): Promise<ReadResult>;
  /**
   * 全体サイズ。Local は即座に分かるが、HTTP は Content-Range を読むまで分からないので undefined を許す。
   * 「全体のうち何 % 読んだか」の表示に使う。
   */
  size(): number | undefined;
}
