import type { ByteSource, ReadContext, ReadResult } from "./types";

/** Range 非対応・CORS などを UI 側で区別して説明できるよう、原因を種類で返す。 */
export type HttpRangeErrorKind =
  | "network-or-cors"
  | "http-status"
  | "range-not-supported"
  | "etag-changed";

export class HttpRangeError extends Error {
  constructor(
    readonly kind: HttpRangeErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "HttpRangeError";
  }
}

/** 観測用に保持するレスポンスヘッダ。CORS では Access-Control-Expose-Headers に無いものは読めない。 */
const OBSERVED_HEADERS = [
  "content-range",
  "content-length",
  "content-type",
  "content-encoding",
  "accept-ranges",
  "etag",
  "cache-control",
];

/**
 * HTTP Range Request で読む ByteSource。
 *
 * 挙動は公式 FetchSource (pmtiles js/src/index.ts) の要点に合わせている:
 * - `Range: bytes=start-end`（end は inclusive なので offset+length-1）
 * - 先頭 read で 416 が返ったら（アーカイブが 16 KiB 未満）、Content-Range の全長で取り直す
 * - 200 で要求より大きい本文が来たら Range 非対応とみなして中断する
 *   （全体ダウンロードが始まってしまうのを防ぐため）
 * - 弱い ETag (W/) は同一性の保証にならないので無視する
 * If-Match を送らないのも公式と同じ理由: CORS preflight が必要になりブラウザキャッシュも効かなくなる。
 */
export class HttpRangeSource implements ByteSource {
  readonly key: string;
  private totalSize: number | undefined;
  private etag: string | undefined;

  constructor(
    readonly url: string,
    private readonly init: { headers?: HeadersInit; credentials?: RequestCredentials } = {},
  ) {
    this.key = url;
  }

  size(): number | undefined {
    return this.totalSize;
  }

  async read(offset: number, length: number, ctx?: ReadContext): Promise<ReadResult> {
    let requestRange = `bytes=${offset}-${offset + length - 1}`;
    let resp = await this.fetchRange(requestRange, ctx?.signal);

    if (offset === 0 && resp.status === 416) {
      const cr = resp.headers.get("content-range");
      const total = cr?.startsWith("bytes */") ? Number(cr.slice(8)) : NaN;
      if (!Number.isFinite(total)) {
        throw new HttpRangeError(
          "range-not-supported",
          "416 応答に Content-Range: bytes */<size> がありません（CORS で Content-Range が公開されていない可能性があります）",
          416,
        );
      }
      requestRange = `bytes=0-${total - 1}`;
      resp = await this.fetchRange(requestRange, ctx?.signal);
    }

    if (resp.status >= 300) {
      throw new HttpRangeError("http-status", `HTTP ${resp.status} ${resp.statusText}`, resp.status);
    }

    const headers: Record<string, string> = {};
    for (const h of OBSERVED_HEADERS) {
      const v = resp.headers.get(h);
      if (v !== null) headers[h] = v;
    }

    if (resp.status === 200) {
      const cl = resp.headers.get("content-length");
      if (!cl || Number(cl) > length) {
        await resp.body?.cancel();
        throw new HttpRangeError(
          "range-not-supported",
          "サーバが Range Request に 206 ではなく 200（全体）で応答しました。HTTP Byte Serving に対応していません。",
          200,
        );
      }
    }

    const size = parseTotalFromContentRange(headers["content-range"]);
    if (size !== undefined) this.totalSize = size;

    const etag = headers["etag"]?.startsWith("W/") ? undefined : headers["etag"];
    if (this.etag && etag && etag !== this.etag) {
      throw new HttpRangeError("etag-changed", `読み取り中にアーカイブが更新されました (ETag ${this.etag} → ${etag})`);
    }
    this.etag ??= etag;

    const bytes = new Uint8Array(await resp.arrayBuffer());
    return {
      offset,
      requestedLength: length,
      bytes,
      http: { url: this.url, requestRange, status: resp.status, headers },
    };
  }

  private async fetchRange(range: string, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(this.init.headers);
    headers.set("range", range);
    try {
      return await fetch(this.url, { headers, credentials: this.init.credentials, signal });
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") throw e;
      // ブラウザは CORS 失敗を TypeError としか返さないため、ネットワーク断と区別できない。
      throw new HttpRangeError(
        "network-or-cors",
        `fetch に失敗しました（CORS 設定またはネットワークを確認してください）: ${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

function parseTotalFromContentRange(v: string | undefined): number | undefined {
  const m = v?.match(/\/(\d+)$/);
  return m ? Number(m[1]) : undefined;
}
