import type { ReadPurpose } from "../../core/source/types";

/** read の目的の表示名。Read Trace と File Layout の read トラックで同じ呼び名にするため 1 か所で持つ */
export const PURPOSE_LABEL: Record<ReadPurpose, string> = {
  "header+root": "Header + Root",
  "root-directory": "Root Directory",
  metadata: "Metadata",
  "leaf-directory": "Leaf Directory",
  "tile-data": "Tile Data",
  "viewer-inspect": "Viewer 表示用",
  other: "その他",
};
