import { zigzag } from "../protobuf/reader";
import { GeomType } from "./decode";

/**
 * MVT geometry の command integer 列を座標に展開する（spec 4.3）。
 *
 *   CommandInteger   = (id & 0x7) | (count << 3)
 *   ParameterInteger = zigzag(差分)
 *
 * 座標は「前の点からの差分」で、cursor は MoveTo をまたいでも引き継がれる（part ごとに原点へ戻らない）。
 * ClosePath は cursor を動かさず、始点へ戻る線を引くだけ。
 * 座標系は tile 座標（左上が原点、y は下向き、0..extent が tile の内側）。
 */

export const Command = { MoveTo: 1, LineTo: 2, ClosePath: 7 } as const;
const COMMAND_NAMES: Record<number, string> = { 1: "MoveTo", 2: "LineTo", 7: "ClosePath" };

export type Point = [number, number];

export interface GeomCommand {
  id: number;
  name: string;
  count: number;
  /** geometry 配列の中での CommandInteger の位置（UI で integer 列と対応付けるため） */
  at: number;
  /** 各パラメータの差分（zigzag を戻したもの）と、足し込んだ後の絶対座標 */
  params: { dx: number; dy: number; x: number; y: number }[];
}

export interface GeomPart {
  points: Point[];
  /** ClosePath で閉じた ring か */
  closed: boolean;
  /** polygon の ring のときだけ: surveyor's formula の面積（tile 座標のまま。y 下向きなので正 = 画面上で時計回り） */
  area?: number;
  role?: "exterior" | "interior";
}

export interface DecodedGeometry {
  type: number;
  commands: GeomCommand[];
  parts: GeomPart[];
  /**
   * polygon のとき: part の index を polygon ごとにまとめたもの（先頭が exterior、続くのがその interior）。
   * spec 4.3.4.4: exterior ring の後に、次の exterior ring までの interior ring が続く
   */
  polygons: number[][];
  issues: string[];
  /** [minX, minY, maxX, maxY]（点が無ければ undefined） */
  bbox?: [number, number, number, number];
}

export function decodeGeometry(ints: readonly number[], type: number): DecodedGeometry {
  const out: DecodedGeometry = { type, commands: [], parts: [], polygons: [], issues: [] };
  let x = 0;
  let y = 0;
  let current: GeomPart | undefined;
  let i = 0;
  while (i < ints.length) {
    const ci = ints[i]!;
    const id = ci & 0x7;
    const count = ci >>> 3;
    const cmd: GeomCommand = { id, name: COMMAND_NAMES[id] ?? `不明(${id})`, count, at: i, params: [] };
    out.commands.push(cmd);
    i++;
    if (id === Command.MoveTo || id === Command.LineTo) {
      if (count === 0) out.issues.push(`${cmd.name} の count が 0（integer #${cmd.at}）`);
      if (i + count * 2 > ints.length) {
        out.issues.push(`${cmd.name} × ${count} のパラメータが足りない（integer #${cmd.at}）`);
        break;
      }
      for (let k = 0; k < count; k++) {
        const dx = zigzag(ints[i++]!);
        const dy = zigzag(ints[i++]!);
        x += dx;
        y += dy;
        cmd.params.push({ dx, dy, x, y });
        // Point は 1 回の MoveTo に複数点を並べられる（MultiPoint）。点ごとに part を分ける
        if (id === Command.MoveTo) {
          current = { points: [], closed: false };
          out.parts.push(current);
        }
        if (!current) {
          out.issues.push(`MoveTo の前に LineTo がある（integer #${cmd.at}）`);
          current = { points: [], closed: false };
          out.parts.push(current);
        }
        current.points.push([x, y]);
      }
    } else if (id === Command.ClosePath) {
      if (count !== 1) out.issues.push(`ClosePath の count が ${count}（spec: 1 でなければならない）`);
      if (!current) out.issues.push(`MoveTo の前に ClosePath がある（integer #${cmd.at}）`);
      else current.closed = true;
    } else {
      out.issues.push(`未知の command id ${id}（integer #${cmd.at}）`);
      break;
    }
  }
  validate(out);
  if (type === GeomType.Polygon) classifyRings(out);
  out.bbox = bbox(out.parts);
  return out;
}

/** geometry type ごとの command の並びの規則（spec 4.3.4.2〜4.3.4.4） */
function validate(g: DecodedGeometry) {
  const names = g.commands.map((c) => c.id);
  if (g.type === GeomType.Point) {
    if (names.length !== 1 || names[0] !== Command.MoveTo) g.issues.push("POINT は MoveTo 1 つだけで表す（spec 4.3.4.2）");
  } else if (g.type === GeomType.LineString) {
    for (let k = 0; k < g.commands.length; k += 2) {
      const m = g.commands[k];
      const l = g.commands[k + 1];
      if (m?.id !== Command.MoveTo || m.count !== 1 || l?.id !== Command.LineTo) {
        g.issues.push("LINESTRING は MoveTo(1) → LineTo(1 以上) の繰り返し（spec 4.3.4.3）");
        break;
      }
    }
  } else if (g.type === GeomType.Polygon) {
    for (let k = 0; k < g.commands.length; k += 3) {
      const [m, l, c] = [g.commands[k], g.commands[k + 1], g.commands[k + 2]];
      if (m?.id !== Command.MoveTo || m.count !== 1 || l?.id !== Command.LineTo || l.count < 2 || c?.id !== Command.ClosePath) {
        g.issues.push("POLYGON の ring は MoveTo(1) → LineTo(2 以上) → ClosePath の繰り返し（spec 4.3.4.4）");
        break;
      }
    }
  }
}

/**
 * ring を面積の符号で exterior / interior に分け、polygon ごとにまとめる。
 * spec 4.3.4.4: surveyor's formula の面積が正なら exterior、負なら interior（tile 座標の y 下向きで、exterior は時計回りに見える）。
 */
function classifyRings(g: DecodedGeometry) {
  let polygon: number[] | undefined;
  g.parts.forEach((part, idx) => {
    const a = ringArea(part.points);
    part.area = a;
    if (a === 0) {
      g.issues.push(`ring #${idx} の面積が 0（spec: 面積 0 の ring は不正）`);
      return;
    }
    part.role = a > 0 ? "exterior" : "interior";
    if (part.role === "exterior") {
      polygon = [idx];
      g.polygons.push(polygon);
    } else if (!polygon) {
      g.issues.push(`ring #${idx} は interior だが、先行する exterior ring が無い`);
    } else {
      polygon.push(idx);
    }
  });
}

/** surveyor's (shoelace) formula。始点への戻りは ClosePath が表すので、点列の末尾から先頭への辺も足す */
export function ringArea(pts: readonly Point[]): number {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const [x1, y1] = pts[i]!;
    const [x2, y2] = pts[(i + 1) % pts.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function bbox(parts: GeomPart[]): [number, number, number, number] | undefined {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of parts) {
    for (const [x, y] of p.points) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return minX === Infinity ? undefined : [minX, minY, maxX, maxY];
}

/** 頂点数（ClosePath で戻る始点は数えない） */
export function vertexCount(g: DecodedGeometry): number {
  return g.parts.reduce((a, p) => a + p.points.length, 0);
}
