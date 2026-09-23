import "./ui/styles.css";
import { Controller } from "./ui/controller";
import { mountDirectoryViewer } from "./ui/panels/directory-viewer";
import { mountEncodingViewer } from "./ui/panels/encoding-viewer";
import { mountFileLayout } from "./ui/panels/file-layout";
import { mountHeaderInspector } from "./ui/panels/header-inspector";
import { mountHexViewer } from "./ui/panels/hex-viewer";
import { mountHilbertViewer } from "./ui/panels/hilbert-viewer";
import { mountMetadataViewer } from "./ui/panels/metadata-viewer";
import { mountOpenError, mountOpener } from "./ui/panels/opener";
import { mountReadLog } from "./ui/panels/read-log";
import { mountSearchViewer } from "./ui/panels/search-viewer";
import { mountTilePayload } from "./ui/panels/tile-payload";
import { mountTileTrace } from "./ui/panels/tile-trace";
import { initialState, type AppState } from "./ui/state";
import { createStore } from "./ui/store";

const store = createStore<AppState>(initialState);
const ctl = new Controller(store);

const body = (id: string) => document.querySelector<HTMLElement>(`#${id} .body`)!;
mountOpener(document.getElementById("opener")!, store, ctl);
mountOpenError(document.getElementById("open-error")!, store);
mountFileLayout(body("p-layout"), store, ctl);
mountTileTrace(body("p-trace"), store, ctl);
mountTilePayload(body("p-payload"), store, ctl);
mountHilbertViewer(body("p-hilbert"), store, ctl);
mountSearchViewer(body("p-search"), store, ctl);
mountHeaderInspector(body("p-header"), store, ctl);
mountHexViewer(body("p-hex"), store, ctl);
mountDirectoryViewer(body("p-dir"), store, ctl);
mountEncodingViewer(body("p-enc"), store, ctl);
mountMetadataViewer(body("p-meta"), store, ctl);
mountReadLog(body("p-reads"), store);

// 各パネルに空状態を描かせるため、初期状態を一度流す
store.set({});

/**
 * ?url=<archive> で開く archive を指定できるようにする（リンクを共有すれば同じ archive の Trace を再現できる）。
 * ローカルファイルは URL で表せないので、開いたら ?url= を外す。
 */
store.subscribe((s, prev) => {
  if (s.sourceDesc === prev.sourceDesc) return;
  const q = new URLSearchParams(location.search);
  if (s.sourceDesc?.kind === "http") q.set("url", s.sourceDesc.url);
  else q.delete("url");
  const search = q.toString();
  history.replaceState(null, "", `${location.pathname}${search ? `?${search}` : ""}${location.hash}`);
});
const initialUrl = new URLSearchParams(location.search).get("url");
if (initialUrl) void ctl.openUrl(initialUrl);

// 開発時にコンソールから状態を覗けるようにする（教材として内部を触って確かめられるように）
if (import.meta.env.DEV) Object.assign(globalThis, { pmtilesViewer: { store, ctl } });
