import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { size } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";
import { HTTP_ERROR_TEXT } from "../text/http-errors";

/** fixtures/ を Vite の publicDir として配信している。教材としてすぐ試せるように同梱サンプルを並べる */
const SAMPLES = [
  { file: "leaf_z8.pmtiles", label: "Leaf あり (合成, z0-8)" },
  { file: "leaf_z8_nocomp.pmtiles", label: "Leaf あり・Directory 無圧縮 (合成, z0-8)" },
  { file: "zcta_z3.pmtiles", label: "MVT (US ZCTA, z0-3)" },
  { file: "terrarium_z2.pmtiles", label: "Terrarium PNG (z0-2)" },
  { file: "test_fixture_1.pmtiles", label: "公式 fixture 1" },
  { file: "test_fixture_mlt.pmtiles", label: "公式 MLT fixture (空)" },
];

/**
 * 「巨大な単一ファイルのごく一部しか読まない」を体験するためのリモートサンプル。
 * Protomaps が公開している R2 上のサンプルで、Range と CORS に対応している
 * （ただし Content-Range は Expose されていないので、サイズは HEAD で補う）。
 */
const REMOTE_SAMPLES = [
  { url: "https://r2-public.protomaps.com/protomaps-sample-datasets/terrarium_z9.pmtiles", label: "Terrarium PNG 全球 z0-9 (28.4 GiB)" },
  { url: "https://r2-public.protomaps.com/protomaps-sample-datasets/overture-pois.pmtiles", label: "Overture POI MVT z0-14 (4.34 GiB)" },
  // 道路・建物・水域など geometry の種類が揃った MVT。Content Inspector で LineString / 穴あき Polygon を見るため（pmtiles.io = GitHub Pages なので CORS 可）
  { url: "https://pmtiles.io/protomaps(vector)ODbL_firenze.pmtiles", label: "Protomaps basemap Firenze MVT z0-15 (6.3 MiB)" },
];

/** select の value に「どう開くか」を埋め込む。同じファイルを Local と HTTP で開き比べられるようにするため */
type Choice = `file:${string}` | `http:${string}`;

export function mountOpener(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  const input = h("input", { type: "file", accept: ".pmtiles", hidden: true }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) void ctl.openFile(f, f.name);
    input.value = "";
  });

  const urlInput = h("input", { type: "url", class: "url-input mono", placeholder: "https://…/archive.pmtiles", spellcheck: "false" }) as HTMLInputElement;
  const urlForm = h(
    "form",
    {
      class: "url-form",
      onsubmit: (ev: Event) => {
        ev.preventDefault();
        const u = urlInput.value.trim();
        if (u) void ctl.openUrl(u);
      },
    },
    urlInput,
    h("button", { type: "submit" }, "URL を開く"),
  );

  const status = h("span", { class: "status" });
  const select = h(
    "select",
    {
      onchange: async (ev: Event) => {
        const sel = ev.target as HTMLSelectElement;
        const choice = sel.value as Choice | "";
        sel.value = "";
        if (choice.startsWith("http:")) {
          void ctl.openUrl(choice.slice(5));
        } else if (choice.startsWith("file:")) {
          await openSampleAsFile(choice.slice(5));
        }
      },
    },
    h("option", { value: "" }, "サンプルを開く…"),
    h("optgroup", { label: "同梱サンプル: File として（Blob.slice）" }, SAMPLES.map((s) => h("option", { value: `file:${s.file}` }, s.label))),
    h(
      "optgroup",
      { label: "同梱サンプル: HTTP Range Request で" },
      SAMPLES.map((s) => h("option", { value: `http:${sampleUrl(s.file)}` }, `${s.label} · HTTP`)),
    ),
    h("optgroup", { label: "リモート: Protomaps のサンプル" }, REMOTE_SAMPLES.map((s) => h("option", { value: `http:${s.url}` }, s.label))),
  );

  async function openSampleAsFile(file: string) {
    // File として開くときは丸ごと取得して Blob にする（サンプルは小さい）。
    // 読み取り自体は LocalFileSource が slice 単位で行うので、Read Trace の見え方はローカルファイルと同じ
    const resp = await fetch(sampleUrl(file));
    if (!resp.ok) {
      store.set({ status: "error", error: `サンプルを取得できません: HTTP ${resp.status}`, errorKind: undefined });
      return;
    }
    void ctl.openFile(await resp.blob(), file);
  }

  replaceChildren(el, h("button", { class: "primary", onclick: () => input.click() }, "ローカルの .pmtiles を開く"), urlForm, select, input, status);

  // ページ全体へのドロップで開けるようにする（ファイル選択ダイアログを経由しない方が試しやすい）
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (f) void ctl.openFile(f, f.name);
  });

  store.subscribe((s, prev) => {
    // 開いている URL を入力欄にも出す（プリセットや ?url= で開いたときに、何を読んでいるか分かるように）
    if (s.sourceDesc !== prev.sourceDesc) urlInput.value = s.sourceDesc?.kind === "http" ? s.sourceDesc.url : "";
    const name = s.sourceDesc?.kind === "http" ? shortUrl(s.sourceDesc.url) : s.source?.key;
    const via = s.sourceDesc?.kind === "http" ? "HTTP Range" : "File";
    const total = s.archiveSize && s.archiveSize.origin !== "unknown" ? size(s.archiveSize.bytes) : s.sizeProbing ? "サイズ調査中…" : "サイズ不明";
    status.className = `status ${s.status}`;
    status.textContent =
      s.status === "loading"
        ? `${name} を開いています（${via}）…`
        : s.status === "error"
          ? `エラー: ${s.errorKind ? HTTP_ERROR_TEXT[s.errorKind]?.title ?? s.error : s.error}`
          : s.status === "ready"
            ? `${name}（${via} · ${total}）`
            : "ファイルをドロップしても開けます";
  });
  status.textContent = "ファイルをドロップしても開けます";
}

/** BASE_URL は相対 ("./") なので、ページの URL を基準に絶対化する（共有リンクに載せても意味が変わらないように） */
function sampleUrl(file: string): string {
  return new URL(`${import.meta.env.BASE_URL}${file}`, location.href).href;
}

function shortUrl(u: string): string {
  try {
    const url = new URL(u);
    return `${url.host}/…/${url.pathname.split("/").pop()}`;
  } catch {
    return u;
  }
}

/**
 * 開くのに失敗したときの説明。fetch の失敗はブラウザ上では原因が見えにくいので、
 * 種類ごとに「何が起きたか・どう確かめるか」を出し、手元で再現できる curl も添える。
 */
export function mountOpenError(el: HTMLElement, store: Store<AppState>) {
  store.subscribe((s, prev) => {
    if (s.status === prev.status && s.error === prev.error) return;
    if (s.status !== "error") {
      el.hidden = true;
      replaceChildren(el);
      return;
    }
    const text = s.errorKind ? HTTP_ERROR_TEXT[s.errorKind] : undefined;
    const url = s.sourceDesc?.kind === "http" ? s.sourceDesc.url : undefined;
    el.hidden = false;
    replaceChildren(
      el,
      h("b", {}, text?.title ?? "開けませんでした"),
      // 見出しと同じ文言の繰り返しになるので、ブラウザ由来の詳細は控えめに出す
      h("p", { class: "mono dim" }, s.error ?? ""),
      text ? h("p", {}, text.explain) : null,
      text?.checks.length ? h("ul", {}, text.checks.map((c) => h("li", {}, c))) : null,
      url && text?.curl
        ? h(
            "div",
            {},
            h("small", { class: "dim" }, "手元で同じ request を再現する（Origin はこのページ）:"),
            h("pre", { class: "mono" }, `curl -s -o /dev/null -D - \\\n  -H 'Origin: ${location.origin}' \\\n  -H 'Range: bytes=0-16383' \\\n  '${url}'`),
          )
        : null,
      h("p", { class: "dim" }, "失敗した request も Read Trace に残っています（HTTP のやり取りの詳細を開けます）。"),
    );
  });
}
