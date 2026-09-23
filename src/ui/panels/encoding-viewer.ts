import type { DirectoryRecord } from "../../core/pmtiles/archive";
import { encodeOffset, summarizeOffsets, type Entry } from "../../core/pmtiles/directory";
import { compressionName } from "../../core/pmtiles/enums";
import type { Spanned } from "../../core/pmtiles/span";
import { encodeVarint } from "../../core/pmtiles/varint";
import { entryAtByte, type Controller } from "../controller";
import { isPlainDirectory } from "../directory-util";
import { h, replaceChildren } from "../dom";
import { hexByte, hexBytes, hexOffset, num, percent, rangeText, size } from "../format";
import type { AppState, DirColumn } from "../state";
import type { Store } from "../store";

const COLUMNS: { key: DirColumn; label: string }[] = [
  { key: "tileId", label: "TileID" },
  { key: "runLength", label: "RunLength" },
  { key: "length", label: "Length" },
  { key: "offset", label: "Offset" },
];

/**
 * 比較用に仮定する「固定長の行形式」の 1 entry の大きさ。
 * PMTiles にこの形式は存在しない。TileID / Offset を u64、Length / RunLength を u32 とした場合の目安で、
 * 列指向 + varint + 圧縮がどれだけ効いているかを実寸で比べるための基準線として置く。
 */
const NAIVE_ROW_BYTES = 8 + 4 + 4 + 8;

/** 列表現の窓に並べる entry 数（選択 entry の前後）。列 = 配列であることが見える程度の幅にする */
const WINDOW_RADIUS = 3;

/**
 * Directory の bytes がどう作られているかを段階表示する (spec §4.3)。
 *
 * Logical Entries → 列表現 → 差分 / offset 符号化 → varint → 解凍後 bytes → (Internal Compression) → ファイル上の bytes
 *
 * 解凍後バッファ上の位置は decoder が記録した span をそのまま使い、encoder の結果（encodeVarint）とは突き合わせ表示に留める。
 * 表示が「こう符号化されるはず」ではなく「実際にこの bytes だった」になるようにするため。
 */
export function mountEncodingViewer(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  store.subscribe((s, prev) => {
    if (s.dirView?.dir !== prev.dirView?.dir || s.selection !== prev.selection || s.archive !== prev.archive) render(s);
  });

  function render(s: AppState) {
    const dir = s.dirView?.dir;
    if (!s.archive || !dir) {
      replaceChildren(el, h("p", { class: "empty" }, "Directory が bytes へどう符号化されているかを段階表示します。"));
      return;
    }
    const entries = dir.decoded.entries;
    const sel = s.selection?.kind === "dir-entry" && s.selection.dir === dir ? s.selection : undefined;
    const index = sel?.index ?? 0;
    const column = sel?.column ?? "tileId";
    const comp = compressionName(s.archive.header.internalCompression);

    replaceChildren(
      el,
      pipeline(dir, comp),
      h("h3", {}, "1. 列指向レイアウト"),
      h(
        "p",
        { class: "note" },
        "Directory は entry を 1 行ずつ並べるのではなく、entry 数の後に TileID 列 → RunLength 列 → Length 列 → Offset 列の順で同じ種類の値をまとめて並べる。似た値が隣り合うので、差分や 0 がそろい圧縮が効きやすい。",
      ),
      columnBar(dir),
      entries.length ? columnStats(dir) : null,
      sizeComparison(dir, comp),
      entries.length ? offsetSummary(entries) : null,
      entries.length
        ? [
            h("h3", {}, `2. Entry #${index} の符号化`, sel ? null : h("span", { class: "dim" }, "（Directory の表や下の bytes から entry を選べます）")),
            stageTable(dir, index, column, ctl),
            h("h3", {}, "3. 列表現（前後の entry と並べる）"),
            columnWindow(dir, index, column, ctl),
            h("h3", {}, `4. varint の分解: Entry #${index} の ${COLUMNS.find((c) => c.key === column)!.label} 列`),
            varintBreakdown(spanOf(dir, index, column), dir.decompressed),
          ]
        : h("p", { class: "note" }, "entry が 0 個なので、entry 数の varint だけで directory が終わっています。"),
      h("h3", {}, "5. 解凍後の bytes"),
      decodedHex(dir, sel ? index : undefined, sel?.column, ctl),
    );
  }
}

function spanOf(dir: DirectoryRecord, i: number, col: DirColumn): Spanned<number> {
  const enc = dir.decoded.encoding;
  return { tileId: enc.tileIdDeltas, runLength: enc.runLengths, length: enc.lengths, offset: enc.offsets }[col][i]!;
}

function pipeline(dir: DirectoryRecord, comp: string) {
  const plain = isPlainDirectory(dir);
  return h(
    "div",
    { class: "pipeline" },
    h("div", { class: "step" }, h("b", {}, `READ #${dir.readId ?? "?"}`), h("span", {}, `file ${rangeText(dir.fileOffset, dir.compressedLength)}`)),
    h("span", { class: "arrow" }, "→"),
    h("div", { class: "step" }, h("b", {}, plain ? `${comp}（解凍なし）` : `${comp} を解凍`), h("span", {}, `${size(dir.compressedLength)} → ${size(dir.decompressed.length)}`)),
    h("span", { class: "arrow" }, "→"),
    h("div", { class: "step" }, h("b", {}, "varint を順に読む"), h("span", {}, `${num(dir.decoded.encoding.count.value)} entries × 4 列`)),
    h("span", { class: "arrow" }, "→"),
    h("div", { class: "step" }, h("b", {}, "差分・offset を戻す"), h("span", {}, "Logical Entries")),
  );
}

function columnBar(dir: DirectoryRecord) {
  const c = dir.decoded.encoding.columns;
  const total = dir.decompressed.length || 1;
  const parts = [
    { key: "count", label: "count", span: c.count },
    { key: "tileId", label: "TileID Δ", span: c.tileIds },
    { key: "runLength", label: "RunLength", span: c.runLengths },
    { key: "length", label: "Length", span: c.lengths },
    { key: "offset", label: "Offset", span: c.offsets },
  ];
  return h(
    "div",
    {},
    h("div", { class: "bar-label" }, h("span", {}, "0"), h("span", {}, `解凍後バッファ ${num(dir.decompressed.length)} byte`), h("span", {}, num(dir.decompressed.length))),
    h(
      "div",
      { class: "bar col-bar" },
      parts.map((p) =>
        h(
          "div",
          { class: `seg col-${p.key}`, style: `flex-grow:${p.span.length / total}`, title: `${p.label}\n解凍後 ${rangeText(p.span.offset, p.span.length)}\n${num(p.span.length)} byte` },
          h("span", {}, `${p.label} ${num(p.span.length)}B`),
        ),
      ),
    ),
  );
}

/** 列ごとの byte 数と「最頻値」。Offset 列の 0 や TileID Δ の 1 のように、同じ値が大半を占めることを数字で見せる */
function columnStats(dir: DirectoryRecord) {
  const enc = dir.decoded.encoding;
  const c = enc.columns;
  const rows = [
    { key: "tileId", label: "TileID Δ", list: enc.tileIdDeltas, span: c.tileIds },
    { key: "runLength", label: "RunLength", list: enc.runLengths, span: c.runLengths },
    { key: "length", label: "Length", list: enc.lengths, span: c.lengths },
    { key: "offset", label: "Offset 符号値", list: enc.offsets, span: c.offsets },
  ];
  return h(
    "table",
    { class: "col-stats" },
    h("thead", {}, h("tr", {}, ["列", "bytes", "1 値あたり", "1 byte で済んだ値", "最頻値"].map((t) => h("th", {}, t)))),
    h(
      "tbody",
      {},
      rows.map((r) => {
        const n = r.list.length;
        const oneByte = r.list.filter((v) => v.length === 1).length;
        const [mode, freq] = mostCommon(r.list.map((v) => v.value));
        return h(
          "tr",
          {},
          h("td", {}, h("span", { class: `swatch col-${r.key}` }), r.label),
          h("td", { class: "mono" }, num(r.span.length)),
          h("td", { class: "mono" }, `${(r.span.length / n).toFixed(2)} B`),
          h("td", { class: "mono" }, `${num(oneByte)} / ${num(n)}`, h("span", { class: "dim" }, ` (${percent(oneByte / n)})`)),
          h("td", { class: "mono" }, num(mode), h("span", { class: "dim" }, ` × ${num(freq)} (${percent(freq / n)})`)),
        );
      }),
    ),
  );
}

function mostCommon(values: number[]): [number, number] {
  const m = new Map<number, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  let best: [number, number] = [0, 0];
  for (const kv of m) if (kv[1] > best[1]) best = kv;
  return best;
}

function sizeComparison(dir: DirectoryRecord, comp: string) {
  const n = dir.decoded.entries.length;
  const rows = [
    { label: `（仮定）固定長の行形式 ${NAIVE_ROW_BYTES} B × ${num(n)}`, bytes: NAIVE_ROW_BYTES * n, cls: "naive" },
    { label: "列指向 + 差分 + varint（解凍後）", bytes: dir.decompressed.length, cls: "varint" },
    { label: `+ Internal Compression (${comp}) = ファイル上`, bytes: dir.compressedLength, cls: "stored" },
  ];
  const max = Math.max(...rows.map((r) => r.bytes), 1);
  return h(
    "div",
    { class: "size-cmp" },
    rows.map((r) =>
      h(
        "div",
        { class: "size-row" },
        h("span", { class: "size-label" }, r.label),
        h("span", { class: "size-track" }, h("span", { class: `size-fill ${r.cls}`, style: `width:max(2px, ${(r.bytes / max) * 100}%)` })),
        h("span", { class: "mono" }, `${num(r.bytes)} B`, n ? h("span", { class: "dim" }, ` (${(r.bytes / n).toFixed(2)} B/entry)`) : null),
      ),
    ),
  );
}

function offsetSummary(entries: readonly Entry[]) {
  const s = summarizeOffsets(entries);
  const n = entries.length;
  const item = (label: string, v: number, desc: string) =>
    h("li", {}, h("b", { class: "mono" }, num(v)), ` ${label}`, h("span", { class: "dim" }, ` (${percent(v / n)}) — ${desc}`));
  return h(
    "div",
    { class: "offset-sum" },
    h("div", { class: "counts-title" }, "Offset 列の内訳"),
    h(
      "ul",
      {},
      item("contiguous → 0", s.contiguous, "直前 entry の offset + length の直後に続く"),
      item("先頭 → offset + 1", s.first, "直前が無いので必ず明示"),
      s.backward ? item("後方参照 → offset + 1", s.backward, "dedup: 既に書かれた同じ内容の bytes を再利用") : null,
      s.resume ? item("再開 → offset + 1", s.resume, "dedup の直後。直前 entry の直後ではなく、書き込み済み末尾から続く") : null,
      s.forward ? item("前方ジャンプ → offset + 1", s.forward, "書き込み済み末尾より先へ飛ぶ（TileID 順に並んでいない / 隙間がある）") : null,
    ),
  );
}

/** 選択 entry について、4 列それぞれの「論理値 → 規則 → 符号値 → varint → 位置」を並べる */
function stageTable(dir: DirectoryRecord, i: number, selCol: DirColumn, ctl: Controller) {
  const entries = dir.decoded.entries;
  const e = entries[i]!;
  const prev = i > 0 ? entries[i - 1] : undefined;
  const plain = isPlainDirectory(dir);
  const off = encodeOffset(entries, i);
  // explicit になった理由を summarizeOffsets と同じ基準で言い分けるため、ここまでの書き込み済み末尾を求める
  let highWater = 0;
  for (let k = 0; k < i; k++) highWater = Math.max(highWater, entries[k]!.offset + entries[k]!.length);
  const why = off.expected === undefined ? "" : e.offset < off.expected ? "後方参照 = dedup" : e.offset === highWater ? `dedup の後、書き込み済み末尾 ${num(highWater)} から再開` : "前へ飛ぶ";

  const rule: Record<DirColumn, (Node | string)[]> = {
    tileId: prev ? [`直前 entry の TileID ${num(prev.tileId)} との差`, h("br"), `${num(e.tileId)} − ${num(prev.tileId)}`] : ["先頭 entry は 0 からの差 = TileID そのもの"],
    runLength: ["そのまま"],
    length: ["そのまま"],
    offset:
      off.mode === "contiguous"
        ? [`直前の offset ${num(prev!.offset)} + length ${num(prev!.length)} = ${num(off.expected!)}`, h("br"), "と一致 → contiguous なので 0"]
        : off.expected === undefined
          ? ["先頭 entry → offset + 1"]
          : [`期待値 ${num(off.expected)} と不一致`, h("br"), `（${why}）→ offset + 1`],
  };
  const logical: Record<DirColumn, number> = { tileId: e.tileId, runLength: e.runLength, length: e.length, offset: e.offset };

  const cell = (col: DirColumn, content: (Node | string | null)[] | Node | string) =>
    h("td", { class: `col-cell${col === selCol ? " on" : ""}`, onclick: () => ctl.selectDirEntry(dir, i, col) }, content);

  const row = (label: string, f: (col: DirColumn, sp: Spanned<number>) => (Node | string | null)[] | Node | string) =>
    h(
      "tr",
      {},
      h("th", {}, label),
      COLUMNS.map((c) => cell(c.key, f(c.key, spanOf(dir, i, c.key)))),
    );

  return h(
    "table",
    { class: "stage-table" },
    h("thead", {}, h("tr", {}, h("th", {}, "段階"), COLUMNS.map((c) => h("th", { class: `col-head col-${c.key}` }, c.label)))),
    h(
      "tbody",
      {},
      row("① 論理値", (c) => h("span", { class: "mono" }, num(logical[c]))),
      row("② 符号化規則", (c) => rule[c]),
      row("③ 符号値", (c, sp) => h("b", { class: "mono" }, num(sp.value))),
      row("④ varint", (_c, sp) => h("span", { class: "mono" }, hexBytes(dir.decompressed.subarray(sp.offset, sp.offset + sp.length)), h("span", { class: "dim" }, ` (${sp.length} B)`))),
      row("⑤ 解凍後の位置", (_c, sp) => h("span", { class: "mono" }, rangeText(sp.offset, sp.length))),
      row("⑥ ファイル上の位置", (_c, sp) =>
        plain ? h("span", { class: "mono" }, hexOffset(dir.fileOffset + sp.offset)) : h("span", { class: "dim" }, "圧縮されているため 1 対 1 に対応しない"),
      ),
    ),
  );
}

/** 列を「横に」並べる。同じ列の値がメモリ上でも隣り合うことを、行と列を入れ替えた表で見せる */
function columnWindow(dir: DirectoryRecord, index: number, selCol: DirColumn, ctl: Controller) {
  const entries = dir.decoded.entries;
  const enc = dir.decoded.encoding;
  const lo = Math.max(0, index - WINDOW_RADIUS);
  const hi = Math.min(entries.length, index + WINDOW_RADIUS + 1);
  const idx = Array.from({ length: hi - lo }, (_, k) => lo + k);
  const lists: Record<DirColumn, Spanned<number>[]> = { tileId: enc.tileIdDeltas, runLength: enc.runLengths, length: enc.lengths, offset: enc.offsets };
  const logicalRow = (label: string, f: (e: Entry) => number) =>
    h("tr", { class: "logical" }, h("th", {}, label), idx.map((i) => h("td", { class: `mono${i === index ? " cur" : ""}` }, num(f(entries[i]!)))));
  return h(
    "div",
    { class: "hscroll" },
    h(
      "table",
      { class: "col-window" },
      h("thead", {}, h("tr", {}, h("th", {}, ""), idx.map((i) => h("th", { class: i === index ? "cur" : "" }, `#${i}`)))),
      h(
        "tbody",
        {},
        logicalRow("TileID（論理）", (e) => e.tileId),
        COLUMNS.map((c) =>
          h(
            "tr",
            { class: c.key === selCol ? "on" : "" },
            h("th", {}, h("span", { class: `swatch col-${c.key}` }), c.key === "tileId" ? "TileID Δ 列" : c.key === "offset" ? "Offset 符号値列" : `${c.label} 列`),
            idx.map((i) =>
              h(
                "td",
                { class: `mono${i === index ? " cur" : ""}${c.key === "offset" && lists.offset[i]!.value === 0 ? " zero" : ""}`, onclick: () => ctl.selectDirEntry(dir, i, c.key) },
                num(lists[c.key][i]!.value),
              ),
            ),
          ),
        ),
        logicalRow("Offset（論理）", (e) => e.offset),
      ),
    ),
    h("p", { class: "dim small" }, `${lo > 0 ? "… " : ""}#${lo}–#${hi - 1}${hi < entries.length ? " …" : ""}。Offset 符号値の 0 は「直前の直後に続く」の意味。`),
  );
}

/**
 * varint 1 つを byte ごとに分解する。
 * 各 byte の最上位 bit は「続きがあるか」、残り 7 bit が値の一部で、下位の組から順に 128 倍ずつ積み上がる。
 */
function varintBreakdown(sp: Spanned<number>, buf: Uint8Array) {
  const bytes = Array.from(buf.subarray(sp.offset, sp.offset + sp.length));
  // decoder が読んだ bytes と encoder の出力が一致することも示す（符号化が一意であることの確認）
  const reencoded = Array.from(encodeVarint(sp.value));
  const same = reencoded.length === bytes.length && reencoded.every((b, i) => b === bytes[i]);
  return h(
    "div",
    { class: "varint" },
    h(
      "table",
      {},
      h("thead", {}, h("tr", {}, ["byte", "hex", "bit (続き | 7bit 値)", "7bit 値", "重み", "寄与"].map((t) => h("th", {}, t)))),
      h(
        "tbody",
        {},
        bytes.map((b, k) => {
          const payload = b & 0x7f;
          const weight = 128 ** k;
          const bits = b.toString(2).padStart(8, "0");
          return h(
            "tr",
            {},
            h("td", { class: "mono dim" }, k),
            h("td", { class: "mono" }, hexByte(b)),
            h("td", { class: "mono" }, h("span", { class: b & 0x80 ? "cont" : "stop", title: b & 0x80 ? "1 = 次の byte に続く" : "0 = この byte で終わり" }, bits[0]), " ", bits.slice(1)),
            h("td", { class: "mono" }, payload),
            h("td", { class: "mono dim" }, k === 0 ? "× 1" : `× 128^${k}`),
            h("td", { class: "mono" }, num(payload * weight)),
          );
        }),
      ),
    ),
    h(
      "p",
      { class: "mono" },
      bytes.map((b, k) => `${b & 0x7f}${k ? `×128^${k}` : ""}`).join(" + "),
      ` = `,
      h("b", {}, num(sp.value)),
    ),
    same ? null : h("p", { class: "error" }, `この値を最短で符号化すると ${hexBytes(Uint8Array.from(reencoded))} になり、実際の bytes と一致しません（冗長な varint）。`),
  );
}

/** 解凍後バッファ全体を列ごとの色で描く。選択 entry の 4 つの varint が離れた場所にあることが一目で分かる */
function decodedHex(dir: DirectoryRecord, index: number | undefined, column: DirColumn | undefined, ctl: Controller) {
  const buf = dir.decompressed;
  const enc = dir.decoded.encoding;
  const cls: string[] = new Array(buf.length).fill("gap");
  const mark = (sp: { offset: number; length: number }, c: string) => {
    for (let k = sp.offset; k < sp.offset + sp.length; k++) cls[k] = c;
  };
  mark(enc.count, "col-count");
  enc.tileIdDeltas.forEach((sp, i) => mark(sp, `col-tileId f${i % 2}`));
  enc.runLengths.forEach((sp, i) => mark(sp, `col-runLength f${i % 2}`));
  enc.lengths.forEach((sp, i) => mark(sp, `col-length f${i % 2}`));
  enc.offsets.forEach((sp, i) => mark(sp, `col-offset f${i % 2}`));
  if (index !== undefined) {
    for (const c of COLUMNS) {
      const sp = spanOf(dir, index, c.key);
      for (let k = sp.offset; k < sp.offset + sp.length; k++) cls[k] += column === undefined || column === c.key ? " sel" : " sel-weak";
    }
  }
  const rows: HTMLElement[] = [];
  for (let r = 0; r < buf.length; r += 16) {
    const cells: HTMLElement[] = [];
    for (let i = r; i < Math.min(r + 16, buf.length); i++) {
      cells.push(h("span", { class: `b ${cls[i]}`, "data-p": i }, hexByte(buf[i]!)));
      if (i - r === 7) cells.push(h("span", { class: "mid" }, " "));
    }
    rows.push(h("div", { class: "row" }, h("span", { class: "addr" }, hexOffset(r, 6)), h("span", { class: "hex" }, cells)));
  }
  const scroller = h("div", { class: "hex-scroll dec-hex" }, rows);
  scroller.addEventListener("click", (ev) => {
    const p = (ev.target as HTMLElement).dataset?.["p"];
    if (p === undefined) return;
    const hit = entryAtByte(dir, Number(p));
    if (hit) ctl.selectDirEntry(dir, hit.index, hit.column);
  });
  // 選択 varint を見える位置へ。描画直後はまだ DOM に入っていないので次のフレームで行う
  if (index !== undefined) {
    requestAnimationFrame(() => {
      const first = scroller.querySelector<HTMLElement>(".b.sel");
      if (first) scroller.scrollTop = first.parentElement!.parentElement!.offsetTop - scroller.clientHeight / 3;
    });
  }
  return h(
    "div",
    {},
    h(
      "p",
      { class: "note" },
      isPlainDirectory(dir)
        ? "Internal Compression = none なので、この bytes はファイル上の bytes と同一です（Hex Viewer と同じ並び）。"
        : "Internal Compression を解凍した後の bytes（ファイル上には圧縮された形でしか存在しない）。位置は解凍後バッファの先頭からの相対値。",
    ),
    scroller,
  );
}
