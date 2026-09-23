import { readVarint as officialReadVarint } from "pmtiles";
import { describe, expect, it } from "vitest";
import { encodeVarint, readVarint } from "../src/core/pmtiles/varint";

describe("varint", () => {
  const samples = [0, 1, 127, 128, 300, 16383, 16384, 2 ** 31 - 1, 2 ** 31, 2 ** 32, 2 ** 35 + 7, Number.MAX_SAFE_INTEGER];
  for (let i = 0; i < 2000; i++) samples.push(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER));

  it("encode → decode が往復し、公式 readVarint と同じ値・同じ消費 byte 数になる", () => {
    for (const v of samples) {
      const bytes = encodeVarint(v);
      const ours = readVarint(bytes, 0);
      const p = { buf: bytes, pos: 0 };
      const official = officialReadVarint(p);
      expect(ours.value).toBe(v);
      expect(official).toBe(v);
      expect(ours.length).toBe(p.pos);
      expect(ours.length).toBe(bytes.length);
    }
  });

  it("protobuf ドキュメントの例 300 = AC 02", () => {
    expect([...encodeVarint(300)]).toEqual([0xac, 0x02]);
    expect(readVarint(Uint8Array.from([0xac, 0x02]), 0)).toEqual({ value: 300, offset: 0, length: 2 });
  });

  it("途切れた varint は例外", () => {
    expect(() => readVarint(Uint8Array.from([0x80, 0x80]), 0)).toThrow(RangeError);
  });

  it("2^53 を超える値は丸めずに例外（公式は黙って丸める）", () => {
    // 2^53 + 1 = 0x20000000000001
    const bytes = Uint8Array.from([0x81, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x10]);
    expect(() => readVarint(bytes, 0)).toThrow(/MAX_SAFE_INTEGER/);
  });
});
