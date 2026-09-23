import type { ReadRecord } from "../../core/source/tracing-byte-source";
import { h, replaceChildren } from "../dom";
import { num, percent, rangeText, size } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { PURPOSE_LABEL } from "../text/read-purpose";
import { traceReadIds } from "../trace-reads";

/**
 * TracingByteSource が記録したすべての read を並べる（Range Trace の原型）。
 * 「PMTiles を読むのに必要だった read」と「Viewer が見せるために読んだ read」を分けて集計し、
 * 読んだ割合を過大に見せないようにする。
 */
export function mountReadLog(el: HTMLElement, store: Store<AppState>) {
  store.subscribe((s, prev) => {
    if (s.reads !== prev.reads || s.source !== prev.source || s.trace !== prev.trace) render(s);
  });

  function render(s: AppState) {
    if (!s.source) {
      replaceChildren(el, h("p", { class: "empty" }, "ByteSource への read をすべて記録します。"));
      return;
    }
    const total = s.source.size();
    // 今の Trace で使った read の行に印を付け、File Layout の濃い印と対応させる
    const inTrace = traceReadIds(s.trace);
    const needed = sum(s.reads.filter((r) => r.purpose !== "viewer-inspect"));
    const inspect = sum(s.reads.filter((r) => r.purpose === "viewer-inspect"));
    replaceChildren(
      el,
      h(
        "div",
        { class: "stats" },
        stat("Archive Size", total !== undefined ? size(total) : "不明", total !== undefined ? `${num(total)} B` : ""),
        stat("PMTiles として読んだ量", size(needed), `${num(needed)} B`),
        stat("読んだ割合", total ? percent(needed / total) : "—", "Viewer 表示用を除く"),
        stat("Viewer 表示用の追加 read", size(inspect), `${num(inspect)} B`),
      ),
      h(
        "table",
        { class: "read-table" },
        h("thead", {}, h("tr", {}, ["#", "目的", "範囲 (bytes)", "要求", "受信", "時間"].map((t) => h("th", {}, t)))),
        h(
          "tbody",
          {},
          s.reads.map((r) =>
            h(
              "tr",
              { class: `${r.purpose === "viewer-inspect" ? "dim" : r.error ? "error" : ""}${inTrace.has(r.id) ? " in-trace" : ""}` },
              h("td", { class: "mono" }, `#${r.id}`),
              h("td", {}, PURPOSE_LABEL[r.purpose], r.label ? h("span", { class: "dim" }, ` ${r.label}`) : null),
              h("td", { class: "mono" }, rangeText(r.offset, r.requestedLength)),
              h("td", { class: "mono" }, num(r.requestedLength)),
              h(
                "td",
                { class: "mono" },
                num(r.receivedLength),
                // 先頭 16 KiB 要求が小さいファイルで EOF に当たったケースを明示する
                r.receivedLength < r.requestedLength && !r.error ? h("span", { class: "dim" }, "（EOF）") : null,
              ),
              h("td", { class: "mono dim" }, `${r.durationMs.toFixed(1)} ms`),
            ),
          ),
        ),
      ),
    );
  }
}

function stat(label: string, value: string, sub: string) {
  return h("div", { class: "stat" }, h("small", {}, label), h("b", {}, value), h("span", { class: "dim" }, sub));
}

function sum(rs: ReadRecord[]): number {
  return rs.reduce((a, r) => a + r.receivedLength, 0);
}
