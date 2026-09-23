import { addProtocol } from "maplibre-gl";
import type { PmtilesArchive } from "../core/pmtiles/archive";
import { loadTileForMap } from "./tile-load";

/**
 * MapLibre のタイル要求を自前の PmtilesArchive に繋ぐ custom protocol。
 *
 * 公式 pmtiles の Protocol を使わないのは、地図描画の read も TracingByteSource を通して記録し、
 * Tile Trace と同じ leaf キャッシュを共有させるため（地図で読んだ leaf を Trace が「cache」として使う様子が見える）。
 * URL は pmtiles-inspector://<登録番号>/{z}/{x}/{y}。archive を開き直すたびに番号を変え、古い要求が新しい archive に混ざらないようにする。
 */
export const PROTOCOL = "pmtiles-inspector";

/** 地図が要求した 1 タイルの結末。read が起きない要求（archive に無いタイル）も数えられるよう、read とは別に通知する */
export type MapTileOutcome = "found" | "missing" | "error";

const archives = new Map<string, { archive: PmtilesArchive; onTile?: (outcome: MapTileOutcome) => void }>();
let nextId = 1;
let registered = false;

export function registerArchive(archive: PmtilesArchive, onTile?: (outcome: MapTileOutcome) => void): { id: string; tilesUrl: string } {
  if (!registered) {
    addProtocol(PROTOCOL, async (params, abortController) => {
      const m = params.url.match(/^pmtiles-inspector:\/\/([^/]+)\/(\d+)\/(\d+)\/(\d+)$/);
      if (!m) throw new Error(`不正なタイル URL: ${params.url}`);
      const reg = archives.get(m[1]!);
      if (!reg) throw new Error("この archive はもう閉じられています");
      let r;
      try {
        r = await loadTileForMap(reg.archive, Number(m[2]), Number(m[3]), Number(m[4]), abortController.signal);
      } catch (e) {
        if ((e as { name?: string })?.name !== "AbortError") reg.onTile?.("error");
        throw e;
      }
      reg.onTile?.(r.found ? "found" : "missing");
      // MapLibre は ArrayBuffer を期待する。null（raster の欠損）は MapLibre 側で透明なタイルとして扱われる（型定義には無いが実装がそう扱う）
      return { data: (r.bytes ? toArrayBuffer(r.bytes) : null) as ArrayBuffer };
    });
    registered = true;
  }
  const id = String(nextId++);
  archives.set(id, { archive, onTile });
  return { id, tilesUrl: `${PROTOCOL}://${id}/{z}/{x}/{y}` };
}

export function unregisterArchive(id: string) {
  archives.delete(id);
}

/**
 * 常に複製して渡す。MapLibre は ArrayBuffer を worker へ transfer（元を detach）するので、
 * Viewer 側がまだ持っている bytes（Compression = none では payload = raw）を渡すと壊れるため。
 * subarray の場合に前後の無関係な bytes を渡さないためでもある。
 */
function toArrayBuffer(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer;
}
