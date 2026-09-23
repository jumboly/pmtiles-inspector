import type { Header } from "../core/pmtiles/header";
import { minimumArchiveSize } from "../core/pmtiles/layout";
import type { SizeProbe } from "../core/source/types";

/**
 * Archive Size と、それが何から分かったか。
 * 「読んだ割合」の分母になる値なので、出どころと確からしさを必ず一緒に見せる。
 */
export type ArchiveSize =
  | { origin: "file"; bytes: number }
  | { origin: "content-range"; bytes: number }
  | { origin: "full-body"; bytes: number }
  /** exact = 同一オリジンで Content-Encoding が無いことまで確認できた */
  | { origin: "head"; bytes: number; exact: boolean }
  | { origin: "unknown"; reason: string };

/**
 * HEAD の Content-Length を Archive Size として採用してよいか判断する。
 *
 * HEAD には Range が付かないので、ブラウザは Accept-Encoding: identity を付けない。
 * そのため gzip するサーバ（GitHub Pages など）は圧縮後の長さを返す。
 * 別オリジンでは Content-Encoding も読めないので、Header が宣言する section の終端より短ければ
 * 「元のファイルの長さではない」と判断して捨てる（長い場合は圧縮後である可能性を否定できないので exact=false）。
 */
export function sizeFromProbe(header: Header, probe: SizeProbe): ArchiveSize {
  const n = probe.contentLength;
  if (n === undefined || !Number.isFinite(n)) {
    return { origin: "unknown", reason: "HEAD の応答に Content-Length がありませんでした" };
  }
  if (probe.contentEncoding && probe.contentEncoding !== "identity") {
    return { origin: "unknown", reason: `HEAD の Content-Length (${n}) は Content-Encoding: ${probe.contentEncoding} の圧縮後の長さなので使えません` };
  }
  const min = minimumArchiveSize(header);
  if (n < min) {
    return {
      origin: "unknown",
      reason: `HEAD の Content-Length (${n}) が Header の宣言する section の終端 (${min}) より短いので、圧縮後の長さとみなして使いません`,
    };
  }
  return { origin: "head", bytes: n, exact: !probe.crossOrigin };
}

export function sizeBytes(s: ArchiveSize | undefined): number | undefined {
  return s && s.origin !== "unknown" ? s.bytes : undefined;
}
