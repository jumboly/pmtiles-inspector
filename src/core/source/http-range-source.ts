import type { ByteSource, HttpExchange, HttpReadInfo, ObservedReadError, ReadContext, ReadResult, SizeProbe } from "./types";

/**
 * Range 非対応・CORS などを UI 側で区別して説明できるよう、原因を種類で返す。
 * fetch の TypeError だけでは CORS とネットワーク断を区別できないので、診断 request で切り分ける。
 */
export type HttpRangeErrorKind =
  | "invalid-url"
  /** https のページから http の URL は読めない（ブラウザが request 自体を送らない） */
  | "mixed-content"
  /** サーバには届く（no-cors の HEAD は応答した）が、CORS の許可が無い */
  | "cors"
  /** no-cors でも届かない: DNS・オフライン・証明書・サーバ停止など */
  | "network"
  | "http-status"
  | "range-not-supported"
  | "etag-changed";

export class HttpRangeError extends Error implements ObservedReadError {
  constructor(
    readonly kind: HttpRangeErrorKind,
    message: string,
    readonly http?: HttpReadInfo,
  ) {
    super(message);
    this.name = "HttpRangeError";
  }

  get status(): number | undefined {
    return this.http?.exchanges.at(-1)?.status;
  }
}

/**
 * 観測用に保持するレスポンスヘッダ。
 * content-length / content-type / cache-control は CORS safelisted なので別オリジンでも読める。
 * それ以外は Access-Control-Expose-Headers に無いと読めない（null になる）。
 */
const OBSERVED_HEADERS = [
  "content-range",
  "content-length",
  "content-type",
  "content-encoding",
  "accept-ranges",
  "etag",
  "cache-control",
];

/** 応答の Content-Range を読めた / 200 の本文がファイル全体だった（HEAD の値は Viewer が判断するのでここには含めない） */
export type HttpSizeOrigin = "content-range" | "full-body";

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
 * 送るヘッダは Range だけにしている。単一範囲の Range は CORS safelisted なので preflight が起きない。
 *
 * 公式との差: ETag が変わったら公式は `cache: "reload"` で読み直すが、ここではエラーにして止める。
 * 読み直すと既に読んだ directory との整合が崩れ、Trace が別々のファイルの混ざったものになるため。
 */
export class HttpRangeSource implements ByteSource {
  readonly key: string;
  private totalSize: number | undefined;
  private totalSizeOrigin: HttpSizeOrigin | undefined;
  private etag: string | undefined;

  readonly url: string;

  constructor(
    url: string,
    private readonly init: { headers?: HeadersInit; credentials?: RequestCredentials } = {},
  ) {
    // 相対 URL もページ基準で絶対化しておく。Read Trace や共有リンクに出す URL を 1 つに揃えるため
    try {
      this.url = new URL(url, globalThis.location?.href).href;
    } catch {
      throw new HttpRangeError("invalid-url", `URL として解釈できません: ${url}`);
    }
    this.key = this.url;
  }

  size(): number | undefined {
    return this.totalSize;
  }

  /** size() が何から分かったか。CORS で Content-Range が読めないと undefined のまま */
  get sizeOrigin(): HttpSizeOrigin | undefined {
    return this.totalSizeOrigin;
  }

  async read(offset: number, length: number, ctx?: ReadContext): Promise<ReadResult> {
    const http: HttpReadInfo = { url: this.url, exchanges: [] };
    let requestRange = `bytes=${offset}-${offset + length - 1}`;
    let resp = await this.fetchRange(requestRange, http, ctx?.signal);

    if (offset === 0 && resp.status === 416) {
      const cr = resp.headers.get("content-range");
      const total = cr?.startsWith("bytes */") ? Number(cr.slice(8)) : NaN;
      if (!Number.isFinite(total)) {
        throw new HttpRangeError(
          "range-not-supported",
          "416 応答に Content-Range: bytes */<size> がありません（CORS で Content-Range が公開されていない可能性があります）",
          http,
        );
      }
      requestRange = `bytes=0-${total - 1}`;
      resp = await this.fetchRange(requestRange, http, ctx?.signal);
    }
    const ex = http.exchanges.at(-1)!;

    if (resp.status >= 300) {
      await resp.body?.cancel();
      throw new HttpRangeError("http-status", `HTTP ${resp.status} ${resp.statusText}`.trim(), http);
    }

    if (resp.status === 200) {
      const cl = resp.headers.get("content-length");
      if (!cl || Number(cl) > length) {
        await resp.body?.cancel();
        throw new HttpRangeError(
          "range-not-supported",
          "サーバが Range Request に 206 ではなく 200（全体）で応答しました。HTTP Byte Serving に対応していません。",
          http,
        );
      }
    }

    const etag = ex.headers["etag"]?.startsWith("W/") ? undefined : (ex.headers["etag"] ?? undefined);
    if (this.etag && etag && etag !== this.etag) {
      await resp.body?.cancel();
      throw new HttpRangeError(
        "etag-changed",
        `読み取り中にアーカイブが更新されました (ETag ${this.etag} → ${etag})。開き直してください。`,
        http,
      );
    }
    this.etag ??= etag;

    const bytes = new Uint8Array(await resp.arrayBuffer());
    if (this.totalSize === undefined) {
      const fromRange = parseTotalFromContentRange(ex.headers["content-range"]);
      if (fromRange !== undefined) {
        this.totalSize = fromRange;
        this.totalSizeOrigin = "content-range";
      } else if (resp.status === 200) {
        // 要求より短い 200 は「ファイル全体がそれだけ」という意味（上で長い 200 は弾いている）
        this.totalSize = bytes.length;
        this.totalSizeOrigin = "full-body";
      }
    }
    return { offset, requestedLength: length, bytes, http };
  }

  /**
   * HEAD で Content-Length を取る。Content-Length は CORS safelisted なので、Content-Range を隠すサーバでも読める。
   * ただし HEAD には Range が付かない = ブラウザが Accept-Encoding: identity を付けないので、
   * gzip するサーバ（GitHub Pages など）は圧縮後の長さを返す。採用の判断は呼び出し側に任せる。
   */
  async probeSize(ctx?: ReadContext): Promise<SizeProbe> {
    const http: HttpReadInfo = { url: this.url, exchanges: [] };
    let resp: Response;
    try {
      resp = await fetch(this.url, { method: "HEAD", headers: this.init.headers, credentials: this.init.credentials, signal: ctx?.signal });
    } catch (e) {
      if (isAbort(e)) throw e;
      return { contentEncoding: null, crossOrigin: true, http };
    }
    const ex = exchangeOf("HEAD", "cors", undefined, resp);
    http.exchanges.push(ex);
    const cl = ex.headers["content-length"];
    return {
      contentLength: resp.ok && cl !== null && cl !== undefined ? Number(cl) : undefined,
      contentEncoding: ex.headers["content-encoding"] ?? null,
      crossOrigin: resp.type === "cors",
      http,
    };
  }

  private async fetchRange(range: string, http: HttpReadInfo, signal?: AbortSignal): Promise<Response> {
    const headers = new Headers(this.init.headers);
    headers.set("range", range);
    let resp: Response;
    try {
      resp = await fetch(this.url, { headers, credentials: this.init.credentials, signal });
    } catch (e) {
      if (isAbort(e)) throw e;
      throw await this.diagnose(e, range, http, signal);
    }
    http.exchanges.push(exchangeOf("GET", "cors", range, resp));
    return resp;
  }

  /**
   * fetch の失敗理由を切り分ける。ブラウザは CORS 拒否もネットワーク断も同じ TypeError にするため、
   * no-cors の HEAD を 1 回送り、「サーバまでは届くか」だけを確かめる（opaque 応答なので中身は読めない）。
   */
  private async diagnose(e: unknown, range: string, http: HttpReadInfo, signal?: AbortSignal): Promise<HttpRangeError> {
    http.exchanges.push({ method: "GET", mode: "cors", requestRange: range, status: 0, statusText: "(fetch failed)", responseType: "error", headers: {} });
    const detail = e instanceof Error ? e.message : String(e);
    const page = globalThis.location?.href;
    if (page && isMixedContent(page, this.url)) {
      return new HttpRangeError("mixed-content", `https のページから http の URL は読めません（mixed content としてブラウザが遮断）: ${detail}`, http);
    }
    try {
      const probe = await fetch(this.url, { method: "HEAD", mode: "no-cors", credentials: this.init.credentials, signal });
      http.exchanges.push(exchangeOf("HEAD", "no-cors", undefined, probe));
      return new HttpRangeError("cors", `サーバには届きますが、CORS で読み取りが許可されていません: ${detail}`, http);
    } catch (e2) {
      if (isAbort(e2)) throw e2;
      http.exchanges.push({ method: "HEAD", mode: "no-cors", status: 0, statusText: "(fetch failed)", responseType: "error", headers: {} });
      return new HttpRangeError("network", `サーバに接続できません（DNS・オフライン・証明書・サーバ停止など）: ${detail}`, http);
    }
  }
}

/**
 * https のページから http の URL を読もうとしているか。
 * localhost / 127.0.0.1 は「潜在的に信頼できる origin」としてブラウザが許可するので除く。
 */
export function isMixedContent(pageUrl: string, targetUrl: string): boolean {
  const page = new URL(pageUrl);
  const target = new URL(targetUrl, pageUrl);
  if (page.protocol !== "https:" || target.protocol !== "http:") return false;
  const host = target.hostname;
  return !(host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]");
}

function exchangeOf(method: HttpExchange["method"], mode: HttpExchange["mode"], requestRange: string | undefined, resp: Response): HttpExchange {
  const headers: Record<string, string | null> = {};
  // opaque 応答はヘッダが 1 つも読めないので、null を並べて誤解させない
  if (resp.type !== "opaque") for (const h of OBSERVED_HEADERS) headers[h] = resp.headers.get(h);
  return { method, mode, requestRange, status: resp.status, statusText: resp.statusText, responseType: resp.type, headers };
}

function parseTotalFromContentRange(v: string | null | undefined): number | undefined {
  const m = v?.match(/\/(\d+)$/);
  return m ? Number(m[1]) : undefined;
}

function isAbort(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}
