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
  /**
   * Archive Size を知るための HEAD（0 byte）。CORS で Content-Range が読めないときだけ Viewer が送る。
   * 公式実装には無い request なので、PMTiles に必要な read とは分けて数える。
   */
  | "size-probe"
  | "other";

export interface ReadContext {
  purpose?: ReadPurpose;
  /** 人間向けの補足ラベル（例: "leaf for tileId 1234"）。表示用だが parser の判断には使わない。 */
  label?: string;
  signal?: AbortSignal;
}

/** 1 回の HTTP のやり取り。1 つの read が複数回の request になることがある（416 からの取り直し、失敗時の診断） */
export interface HttpExchange {
  method: "GET" | "HEAD";
  /** no-cors は失敗の原因を切り分ける診断 request だけで使う（応答は opaque で中身もヘッダも読めない） */
  mode: "cors" | "no-cors";
  /** 送った Range ヘッダ。HEAD では送らない */
  requestRange?: string;
  /** opaque 応答（no-cors）では 0 になる */
  status: number;
  statusText: string;
  /**
   * basic = 同一オリジン（全ヘッダが読める） / cors = 別オリジン（safelisted と Expose されたものしか読めない） /
   * opaque = no-cors
   */
  responseType: ResponseType;
  /**
   * 観測対象ヘッダの値。null は「応答に無い」か「CORS で JS に公開されていない」のどちらか。
   * ブラウザの JS からはこの 2 つを区別できないので、推測で埋めずに null のまま残す。
   */
  headers: Record<string, string | null>;
}

/** HTTP 固有の観測情報。Local の場合は undefined。 */
export interface HttpReadInfo {
  url: string;
  /** 発生順。最後が read の結果を決めた request */
  exchanges: HttpExchange[];
}

/**
 * read が失敗したときに Source が付けられる観測情報。
 * TracingByteSource は Source の種類を知らずに、失敗した read にも HTTP のやり取りを残せる。
 */
export interface ObservedReadError extends Error {
  readonly kind?: string;
  readonly http?: HttpReadInfo;
}

/**
 * HEAD で得たサイズの候補。採用するかは呼び出し側が Header と突き合わせて決める
 * （HEAD には Range が付かないため、サーバが gzip した後の長さを返すことがある）。
 */
export interface SizeProbe {
  contentLength?: number;
  /** 別オリジンでは公開されていない限り null（圧縮されていないことを確認できない） */
  contentEncoding: string | null;
  crossOrigin: boolean;
  http?: HttpReadInfo;
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
  /** read だけではサイズが分からない Source（CORS 越しの HTTP）が、追加の request でサイズを調べる */
  probeSize?(ctx?: ReadContext): Promise<SizeProbe>;
}
