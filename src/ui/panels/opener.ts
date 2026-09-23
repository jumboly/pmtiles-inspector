import type { Controller } from "../controller";
import { h, replaceChildren } from "../dom";
import { size } from "../format";
import type { AppState } from "../state";
import type { Store } from "../store";

/** fixtures/ を Vite の publicDir として配信している。教材としてすぐ試せるように同梱サンプルを並べる */
const SAMPLES = [
  { file: "leaf_z8.pmtiles", label: "Leaf あり (合成, z0-8)" },
  { file: "zcta_z3.pmtiles", label: "MVT (US ZCTA, z0-3)" },
  { file: "terrarium_z2.pmtiles", label: "Terrarium PNG (z0-2)" },
  { file: "test_fixture_1.pmtiles", label: "公式 fixture 1" },
  { file: "test_fixture_mlt.pmtiles", label: "公式 MLT fixture (空)" },
];

export function mountOpener(el: HTMLElement, store: Store<AppState>, ctl: Controller) {
  const input = h("input", { type: "file", accept: ".pmtiles", hidden: true }) as HTMLInputElement;
  input.addEventListener("change", () => {
    const f = input.files?.[0];
    if (f) void ctl.openFile(f, f.name);
    input.value = "";
  });

  const status = h("span", { class: "status" });
  const select = h(
    "select",
    {
      onchange: async (ev: Event) => {
        const sel = ev.target as HTMLSelectElement;
        const file = sel.value;
        sel.value = "";
        if (!file) return;
        // サンプルは小さいので丸ごと取得して File として扱う。
        // 読み取り自体は LocalFileSource が slice 単位で行うので、Read Trace の見え方はローカルファイルと同じ
        const resp = await fetch(`${import.meta.env.BASE_URL}${file}`);
        if (!resp.ok) {
          store.set({ status: "error", error: `サンプルを取得できません: HTTP ${resp.status}` });
          return;
        }
        void ctl.openFile(await resp.blob(), file);
      },
    },
    h("option", { value: "" }, "サンプルを開く…"),
    SAMPLES.map((s) => h("option", { value: s.file }, s.label)),
  );

  replaceChildren(el, h("button", { class: "primary", onclick: () => input.click() }, "ローカルの .pmtiles を開く"), select, input, status);

  // ページ全体へのドロップで開けるようにする（ファイル選択ダイアログを経由しない方が試しやすい）
  document.addEventListener("dragover", (e) => e.preventDefault());
  document.addEventListener("drop", (e) => {
    e.preventDefault();
    const f = e.dataTransfer?.files[0];
    if (f) void ctl.openFile(f, f.name);
  });

  store.subscribe((s) => {
    const name = s.source?.key;
    const total = s.source?.size();
    status.className = `status ${s.status}`;
    status.textContent =
      s.status === "loading"
        ? `${name} を開いています…`
        : s.status === "error"
          ? `エラー: ${s.error}`
          : s.status === "ready"
            ? `${name}（${total !== undefined ? size(total) : "サイズ不明"}）`
            : "ファイルをドロップしても開けます";
  });
  status.textContent = "ファイルをドロップしても開けます";
}
