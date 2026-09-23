import "./ui/styles.css";
import { Controller } from "./ui/controller";
import { mountFileLayout } from "./ui/panels/file-layout";
import { mountHeaderInspector } from "./ui/panels/header-inspector";
import { mountHexViewer } from "./ui/panels/hex-viewer";
import { mountMetadataViewer } from "./ui/panels/metadata-viewer";
import { mountOpener } from "./ui/panels/opener";
import { mountReadLog } from "./ui/panels/read-log";
import { initialState, type AppState } from "./ui/state";
import { createStore } from "./ui/store";

const store = createStore<AppState>(initialState);
const ctl = new Controller(store);

const body = (id: string) => document.querySelector<HTMLElement>(`#${id} .body`)!;
mountOpener(document.getElementById("opener")!, store, ctl);
mountFileLayout(body("p-layout"), store, ctl);
mountHeaderInspector(body("p-header"), store, ctl);
mountHexViewer(body("p-hex"), store, ctl);
mountMetadataViewer(body("p-meta"), store, ctl);
mountReadLog(body("p-reads"), store);

// 各パネルに空状態を描かせるため、初期状態を一度流す
store.set({});

// 開発時にコンソールから状態を覗けるようにする（教材として内部を触って確かめられるように）
if (import.meta.env.DEV) Object.assign(globalThis, { pmtilesViewer: { store, ctl } });
