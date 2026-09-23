/**
 * z/x/y ↔ TileID (spec §4.1)。
 *
 * TileID = (そのズームより前の全タイル数) + (そのズーム内での Hilbert 曲線上の位置)
 *
 * 「ズーム内の Hilbert index」と「Global TileID」を UI で混同させないため、
 * 変換結果は両者を分けて返す。
 */

/** number で正確に扱える上限。公式実装も同じく z=26 で打ち切っている（4^27/3 > 2^53 になるため）。 */
export const MAX_ZOOM = 26;

export interface TileAddress {
  z: number;
  x: number;
  y: number;
  /** z より前のズームに含まれるタイル総数 = (4^z - 1) / 3。ズーム z の TileID はここから始まる */
  zoomBase: number;
  /** ズーム z の 2^z × 2^z グリッド内での Hilbert 曲線上の位置 (0 .. 4^z - 1) */
  hilbertIndex: number;
  tileId: number;
}

export function zoomBase(z: number): number {
  // 4^0 + 4^1 + ... + 4^(z-1) = (4^z - 1) / 3 。ビットシフトは 32bit で溢れるため累乗で計算する
  return (4 ** z - 1) / 3;
}

/**
 * Hilbert 曲線の xy → d 変換 (Wikipedia "Hilbert curve" の xy2d と同じ手順)。
 *
 * 大きい象限から順に「どの象限にいるか」を決め、その象限内の座標系に回転・反転して次の桁へ進む。
 * 公式実装は rx/ry をビットマスク値のまま扱うが、ここでは 0/1 に正規化して手順を読みやすくしている。
 */
export function hilbertXyToIndex(z: number, x: number, y: number): number {
  const n = 2 ** z;
  let d = 0;
  let tx = x;
  let ty = y;
  for (let s = n / 2; s >= 1; s /= 2) {
    const rx = (tx & s) > 0 ? 1 : 0;
    const ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    [tx, ty] = rotate(n, tx, ty, rx, ry);
  }
  return d;
}

/** Hilbert 曲線の d → xy 変換 (Wikipedia の d2xy) */
export function hilbertIndexToXy(z: number, d: number): [number, number] {
  const n = 2 ** z;
  let t = d;
  let x = 0;
  let y = 0;
  for (let s = 1; s < n; s *= 2) {
    const rx = 1 & Math.floor(t / 2);
    const ry = 1 & (t ^ rx);
    [x, y] = rotate(s, x, y, rx, ry);
    x += s * rx;
    y += s * ry;
    t = Math.floor(t / 4);
  }
  return [x, y];
}

function rotate(n: number, x: number, y: number, rx: number, ry: number): [number, number] {
  if (ry === 0) {
    if (rx === 1) {
      x = n - 1 - x;
      y = n - 1 - y;
    }
    return [y, x];
  }
  return [x, y];
}

export function zxyToTileId(z: number, x: number, y: number): TileAddress {
  assertZoom(z);
  const n = 2 ** z;
  if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= n || y >= n) {
    throw new RangeError(`z=${z} では x, y は 0..${n - 1} の整数です (x=${x}, y=${y})`);
  }
  const base = zoomBase(z);
  const hilbertIndex = hilbertXyToIndex(z, x, y);
  return { z, x, y, zoomBase: base, hilbertIndex, tileId: base + hilbertIndex };
}

export function tileIdToZxy(tileId: number): TileAddress {
  if (!Number.isSafeInteger(tileId) || tileId < 0) {
    throw new RangeError(`不正な TileID です: ${tileId}`);
  }
  // zoomBase(z) <= tileId < zoomBase(z+1) となる z を探す。高々 27 回なので線形探索で十分かつ読みやすい
  let z = 0;
  while (z < MAX_ZOOM && zoomBase(z + 1) <= tileId) z++;
  if (zoomBase(z + 1) <= tileId) {
    throw new RangeError(`TileID ${tileId} は z=${MAX_ZOOM} を超えています`);
  }
  const base = zoomBase(z);
  const hilbertIndex = tileId - base;
  const [x, y] = hilbertIndexToXy(z, hilbertIndex);
  return { z, x, y, zoomBase: base, hilbertIndex, tileId };
}

function assertZoom(z: number) {
  if (!Number.isInteger(z) || z < 0 || z > MAX_ZOOM) {
    throw new RangeError(`z は 0..${MAX_ZOOM} の整数です (z=${z})`);
  }
}
