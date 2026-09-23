const nf = new Intl.NumberFormat("en-US");

export function num(n: number): string {
  return nf.format(n);
}

/** 人間向けサイズ。教材として正確な byte 数も併記できるよう、丸めた表記だけを返す */
export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KiB", "MiB", "GiB", "TiB"];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)} ${units[i]}`;
}

export function hexOffset(n: number, width = 8): string {
  return "0x" + n.toString(16).toUpperCase().padStart(width, "0");
}

export function hexByte(b: number): string {
  return b.toString(16).toUpperCase().padStart(2, "0");
}

export function hexBytes(bytes: Uint8Array, max = 16): string {
  const parts = Array.from(bytes.subarray(0, max), hexByte);
  return parts.join(" ") + (bytes.length > max ? " …" : "");
}

/** 極小の比率も桁を失わずに示す（30 GB 中 87 KB = 0.000286% のようなケース） */
export function percent(ratio: number): string {
  const p = ratio * 100;
  if (p === 0) return "0 %";
  // 99.95% 以上を "100.0 %" と丸めると「全部」に見えてしまうので、100% 未満であることを残す
  if (p >= 99.95 && p < 100) return "> 99.9 %";
  if (p >= 1) return `${p.toFixed(1)} %`;
  // toPrecision は 1e-7 未満で指数表記になり「どれだけ小さいか」が直感で読めないので、有効 3 桁の小数で書く
  return `${p.toFixed(-Math.floor(Math.log10(p)) + 2)} %`;
}

/** 閉区間 [start, end] 表記。HTTP Range ヘッダと同じく end を含む */
export function rangeText(offset: number, length: number): string {
  return length > 0 ? `${num(offset)} – ${num(offset + length - 1)}` : `${num(offset)}（長さ 0）`;
}
