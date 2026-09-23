import type { ReadRecord } from "../../core/source/tracing-byte-source";
import type { HttpExchange } from "../../core/source/types";
import type { ArchiveSize } from "../archive-size";
import { h, replaceChildren } from "../dom";
import { num, percent, rangeText, size } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { PURPOSE_LABEL } from "../text/read-purpose";
import { traceReadIds } from "../trace-reads";

/** CORS safelisted response header。別オリジンでもこれらは必ず JS から読める */
const SAFELISTED = new Set(["cache-control", "content-language", "content-length", "content-type", "expires", "last-modified", "pragma"]);

/**
 * TracingByteSource が記録したすべての read を並べる（Range Trace）。
 * 「PMTiles を読むのに必要だった read」と「Viewer が見せるために読んだ read」を分けて集計し、
 * 読んだ割合を過大に見せないようにする。HTTP の場合は各 read の request / response も開いて見られる。
 */
export function mountReadLog(el: HTMLElement, store: Store<AppState>) {
  /** 詳細を開いている READ 番号。パネル内だけの表示状態なので store には入れない */
  const open = new Set<number>();
  /**
   * 地図描画の read を表に出すか。地図はパンのたびに数十の read を起こすので、既定では隠して集計だけ見せる
   * （Tile Trace の数行が埋もれないように）。
   */
  let showMap = false;

  store.subscribe((s, prev) => {
    if (s.source !== prev.source) {
      open.clear();
      // 最初の read（先頭 16 KiB）の request は教材として一番見てほしいので、HTTP なら最初から開いておく
      if (s.sourceDesc?.kind === "http") open.add(1);
    }
    if (s.reads !== prev.reads || s.source !== prev.source || s.trace !== prev.trace || s.archiveSize !== prev.archiveSize || s.sizeProbing !== prev.sizeProbing) render(s);
  });

  function render(s: AppState) {
    if (!s.source) {
      replaceChildren(el, h("p", { class: "empty" }, "ByteSource への read をすべて記録します。"));
      return;
    }
    const total = s.archiveSize && s.archiveSize.origin !== "unknown" ? s.archiveSize.bytes : undefined;
    // 今の Trace で使った read の行に印を付け、File Layout の濃い印と対応させる
    const inTrace = traceReadIds(s.trace);
    const needed = sum(s.reads.filter((r) => r.purpose !== "viewer-inspect" && r.purpose !== "size-probe"));
    const inspect = sum(s.reads.filter((r) => r.purpose === "viewer-inspect"));
    const mapReads = s.reads.filter((r) => r.initiator === "map");
    const mapBytes = sum(mapReads);
    const rows = showMap ? s.reads : s.reads.filter((r) => r.initiator !== "map");
    const isHttp = s.sourceDesc?.kind === "http";
    const requests = s.reads.reduce((a, r) => a + (r.http?.exchanges.length ?? 0), 0);
    const toggle = (id: number) => {
      if (open.has(id)) open.delete(id);
      else open.add(id);
      render(store.get());
    };

    replaceChildren(
      el,
      h(
        "div",
        { class: "stats" },
        stat("Source", isHttp ? "HTTP Range" : "Local File", isHttp ? "fetch + Range ヘッダ" : "Blob.slice()"),
        stat("Archive Size", total !== undefined ? size(total) : s.sizeProbing ? "調査中…" : "不明", sizeNote(s.archiveSize)),
        stat("Actually Read", size(needed), `${num(needed)} B（PMTiles として必要だった分）`),
        stat("Read Ratio", total ? percent(needed / total) : "—", total ? "Archive Size に対する割合" : "Archive Size が分からないので出せない"),
        stat("Viewer 表示用の追加 read", size(inspect), `${num(inspect)} B`),
        mapReads.length ? stat("うち地図描画", size(mapBytes), `${num(mapReads.length)} 回（leaf + tile）`) : null,
        isHttp ? stat("HTTP request", num(requests), "416 の取り直し・HEAD・診断を含む") : null,
      ),
      s.archiveSize?.origin === "unknown" ? h("p", { class: "note" }, `Archive Size が分からない理由: ${s.archiveSize.reason}`) : null,
      mapReads.length
        ? h(
            "label",
            { class: "map-toggle" },
            (() => {
              const cb = h("input", {
                type: "checkbox",
                onchange: (ev: Event) => {
                  showMap = (ev.target as HTMLInputElement).checked;
                  render(store.get());
                },
              });
              cb.checked = showMap;
              return cb;
            })(),
            ` 地図描画の read ${num(mapReads.length)} 件を表に出す`,
            h("span", { class: "dim" }, "（集計には常に含む）"),
          )
        : null,
      h(
        "table",
        { class: "read-table" },
        h("thead", {}, h("tr", {}, ["#", "目的", "範囲 (bytes)", "要求", "受信", isHttp ? "HTTP" : null, "時間"].filter((t) => t !== null).map((t) => h("th", {}, t)))),
        h(
          "tbody",
          {},
          rows.flatMap((r) => {
            const aborted = r.errorKind === "aborted";
            const cls = `${r.purpose === "viewer-inspect" || r.purpose === "size-probe" || aborted ? "dim" : r.error ? "error" : ""}${inTrace.has(r.id) ? " in-trace" : ""}${r.http ? " clickable" : ""}`;
            const row = h(
              "tr",
              { class: cls, onclick: r.http ? () => toggle(r.id) : undefined, title: r.http ? "クリックで HTTP のやり取りを開く / 閉じる" : undefined },
              h("td", { class: "mono" }, r.http ? `${open.has(r.id) ? "▾" : "▸"} #${r.id}` : `#${r.id}`),
              h("td", {}, r.initiator === "map" ? h("span", { class: "read-swatch map", title: "地図描画" }) : null, PURPOSE_LABEL[r.purpose], r.label ? h("span", { class: "dim" }, ` ${r.label}`) : null),
              h("td", { class: "mono" }, r.purpose === "size-probe" ? "—（HEAD）" : rangeText(r.offset, r.requestedLength)),
              h("td", { class: "mono" }, num(r.requestedLength)),
              h(
                "td",
                { class: "mono" },
                r.error ? h("span", {}, aborted ? "中断" : "失敗") : num(r.receivedLength),
                // 先頭 16 KiB 要求が小さいファイルで EOF に当たったケースを明示する
                r.receivedLength < r.requestedLength && !r.error ? h("span", { class: "dim" }, "（EOF）") : null,
              ),
              isHttp ? h("td", { class: "mono" }, statusChain(r)) : null,
              h("td", { class: "mono dim" }, `${r.durationMs.toFixed(1)} ms`),
            );
            if (!r.http || !open.has(r.id)) return [row];
            return [row, h("tr", { class: "http-detail" }, h("td", { colspan: 7 }, httpDetail(r)))];
          }),
        ),
      ),
    );
  }
}

function sizeNote(s: ArchiveSize | undefined): string {
  if (!s) return "";
  switch (s.origin) {
    case "file":
      return "File.size";
    case "content-range":
      return "206 応答の Content-Range: …/全体長 から";
    case "full-body":
      return "200 応答の本文（ファイル全体）の長さ";
    case "head":
      return s.exact ? "HEAD の Content-Length から" : "HEAD の Content-Length から（別オリジンのため無圧縮かは未確認）";
    case "unknown":
      return "下の理由を参照";
  }
}

/** 1 つの read に何回の request が掛かったかを "416 → 206" のように並べる */
function statusChain(r: ReadRecord): string {
  if (!r.http) return "";
  return r.http.exchanges.map((e) => (e.mode === "no-cors" ? `${e.responseType === "opaque" ? "opaque" : "失敗"}(診断)` : e.status || "失敗")).join(" → ");
}

function httpDetail(r: ReadRecord) {
  const http = r.http!;
  return h(
    "div",
    { class: "http-box" },
    h("div", { class: "mono dim" }, http.url),
    r.error ? h("p", { class: "error" }, `${r.errorKind ? `[${r.errorKind}] ` : ""}${r.error}`) : null,
    http.exchanges.map((e, i) => exchangeView(e, i, http.exchanges.length)),
  );
}

function exchangeView(e: HttpExchange, i: number, n: number) {
  const reqLines = [`${e.method} ${e.requestRange ? `Range: ${e.requestRange}` : "（Range なし）"}`, `mode: ${e.mode}`];
  const failed = e.responseType === "error";
  return h(
    "div",
    { class: "exchange" },
    h("small", { class: "dim" }, n > 1 ? `request ${i + 1} / ${n}${e.mode === "no-cors" ? "（失敗の原因を切り分ける診断）" : ""}` : "request"),
    h("pre", { class: "mono" }, reqLines.join("\n")),
    h(
      "small",
      { class: "dim" },
      failed ? "response: なし（fetch が TypeError で失敗。ブラウザは理由を JS に教えない）" : `response: ${e.status} ${e.statusText} · type=${e.responseType}${responseTypeNote(e.responseType)}`,
    ),
    failed || e.responseType === "opaque" ? null : headerTable(e),
  );
}

function responseTypeNote(t: ResponseType): string {
  if (t === "cors") return "（別オリジン: safelisted と Expose されたヘッダだけが読める）";
  if (t === "basic") return "（同一オリジン: すべてのヘッダが読める）";
  if (t === "opaque") return "（no-cors: status もヘッダも読めない。届いたことだけが分かる）";
  return "";
}

function headerTable(e: HttpExchange) {
  return h(
    "table",
    { class: "header-table" },
    h(
      "tbody",
      {},
      Object.entries(e.headers).map(([k, v]) =>
        h(
          "tr",
          { class: v === null ? "dim" : "" },
          h("td", { class: "mono" }, k),
          h("td", { class: "mono" }, v ?? hiddenReason(k, e)),
          h("td", { class: "dim" }, SAFELISTED.has(k) ? "safelisted" : ""),
        ),
      ),
    ),
  );
}

/**
 * ヘッダが null だった理由の説明。JS からは「無い」と「隠されている」を区別できないが、
 * 206 には Content-Range が必ず付く（RFC 9110 §15.3.7）ので、その場合だけは「隠されている」と言い切れる。
 */
function hiddenReason(k: string, e: HttpExchange): string {
  if (e.responseType !== "cors") return "（応答に無い）";
  if (k === "content-range" && e.status === 206) return "（読めない: 206 には必ず付くので、CORS で Expose されていない）";
  if (SAFELISTED.has(k)) return "（応答に無い）";
  return "（読めない: 応答に無いか、CORS で Expose されていない）";
}

function stat(label: string, value: string, sub: string) {
  return h("div", { class: "stat" }, h("small", {}, label), h("b", {}, value), h("span", { class: "dim" }, sub));
}

function sum(rs: ReadRecord[]): number {
  return rs.reduce((a, r) => a + r.receivedLength, 0);
}
