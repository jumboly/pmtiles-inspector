import { FIRST_READ_SIZE, sectionsOf, type Header, type SectionName } from "./header";

export type LayoutSegment =
  | { kind: "section"; name: SectionName; offset: number; length: number }
  /** どの section にも属さない隙間。writer によっては padding などで生じ得る */
  | { kind: "gap"; offset: number; length: number };

export interface LayoutIssue {
  code: "overlap" | "beyond-eof" | "root-outside-first-read";
  sections: SectionName[];
}

export interface FileLayout {
  /** offset 順。長さ 0 の section も位置情報として含める */
  segments: LayoutSegment[];
  fileSize?: number;
  issues: LayoutIssue[];
}

/**
 * Header の offset/length だけから物理配置を組み立てる。
 *
 * spec は header 以外の順序を決めていないので、並び順は必ず offset から求める。
 * 隙間・重なり・EOF 超えも「そういうファイルだ」と見せるために segment / issue として残す。
 */
export function computeLayout(h: Header, fileSize?: number): FileLayout {
  const sections = sectionsOf(h);
  const segments: LayoutSegment[] = [];
  const issues: LayoutIssue[] = [];
  let cursor = 0;
  let prev: SectionName | undefined;
  for (const s of sections) {
    if (s.offset > cursor) segments.push({ kind: "gap", offset: cursor, length: s.offset - cursor });
    if (s.offset < cursor && s.length > 0 && prev) issues.push({ code: "overlap", sections: [prev, s.name] });
    segments.push({ kind: "section", name: s.name, offset: s.offset, length: s.length });
    if (fileSize !== undefined && s.offset + s.length > fileSize) issues.push({ code: "beyond-eof", sections: [s.name] });
    if (s.length > 0 && s.offset + s.length > cursor) {
      cursor = s.offset + s.length;
      prev = s.name;
    }
  }
  if (fileSize !== undefined && fileSize > cursor) {
    segments.push({ kind: "gap", offset: cursor, length: fileSize - cursor });
  }
  if (h.rootDirectoryOffset + h.rootDirectoryLength > FIRST_READ_SIZE) {
    issues.push({ code: "root-outside-first-read", sections: ["rootDirectory"] });
  }
  return { segments, fileSize, issues };
}
