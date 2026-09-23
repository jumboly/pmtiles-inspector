import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { FetchSource, PMTiles } from "pmtiles";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PmtilesArchive } from "../src/core/pmtiles/archive";
import { minimumArchiveSize } from "../src/core/pmtiles/layout";
import { HttpRangeError, HttpRangeSource, isMixedContent } from "../src/core/source/http-range-source";
import { TracingByteSource } from "../src/core/source/tracing-byte-source";
import { sizeFromProbe } from "../src/ui/archive-size";
import { FIXTURES, fixturePath, ourSource } from "./helpers";

/**
 * 振る舞いを path の先頭で切り替えるテスト用サーバ。実在するサーバで観測した挙動を再現する:
 * - /ok/       RFC 9110 どおり。EOF を跨ぐ Range は末尾で切り詰めて 206
 * - /strict416/ EOF を跨ぐ Range に 416 + `Content-Range: bytes * /size` を返す（公式 FetchSource が想定している挙動）
 * - /norange/  Range を無視して 200 で全体を返す（Byte Serving 非対応）
 * - /gzip/     Range には正しく 206 を返すが、HEAD には gzip 後の長さを返す（GitHub Pages で観測）
 * - /changing/ 2 回目以降の応答で ETag が変わる（読み取り中の更新）
 */
let server: Server;
let base: string;
let hits: { method: string; range?: string }[] = [];

beforeAll(async () => {
  let changingCount = 0;
  server = createServer((req, res) => {
    const [, mode, name] = new URL(req.url!, "http://x").pathname.split("/");
    hits.push({ method: req.method!, range: req.headers.range });
    let data: Buffer;
    try {
      data = readFileSync(fixturePath(name!));
    } catch {
      res.writeHead(404).end();
      return;
    }
    const etag = mode === "changing" ? `"v${changingCount++ === 0 ? 1 : 2}"` : '"fixed"';
    if (req.method === "HEAD") {
      const len = mode === "gzip" ? gzipSync(data).length : data.length;
      res.writeHead(200, { "content-length": len, etag, ...(mode === "gzip" ? { "content-encoding": "gzip" } : {}) }).end();
      return;
    }
    const m = req.headers.range?.match(/^bytes=(\d+)-(\d+)$/);
    if (mode === "norange" || !m) {
      res.writeHead(200, { "content-length": data.length, etag }).end(data);
      return;
    }
    const start = Number(m[1]);
    let end = Number(m[2]);
    if (start >= data.length || (mode === "strict416" && end >= data.length)) {
      res.writeHead(416, { "content-range": `bytes */${data.length}` }).end();
      return;
    }
    end = Math.min(end, data.length - 1);
    res
      .writeHead(206, { "content-range": `bytes ${start}-${end}/${data.length}`, "content-length": end - start + 1, etag, "accept-ranges": "bytes" })
      .end(data.subarray(start, end + 1));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const url = (mode: string, file: string) => `${base}/${mode}/${file}`;

describe("HttpRangeSource vs 公式 FetchSource", () => {
  it.each([FIXTURES.leaf, FIXTURES.zcta, FIXTURES.terrarium, FIXTURES.fixture1])("%s: header と tile が公式と一致する", async (file) => {
    const ours = await PmtilesArchive.open(new HttpRangeSource(url("ok", file)));
    const official = new PMTiles(new FetchSource(url("ok", file)));
    const oh = await official.getHeader();
    expect(ours.header.tileDataOffset).toBe(oh.tileDataOffset);
    expect(ours.header.maxZoom).toBe(oh.maxZoom);

    const z = ours.header.maxZoom;
    const n = 2 ** z;
    for (const [x, y] of [[0, 0], [n >> 1, n >> 1], [n - 1, n - 1]] as const) {
      const lookup = await ours.lookupTile(z, x, y);
      const theirs = await official.getZxy(z, x, y);
      if (lookup.result.status !== "found") {
        expect(theirs).toBeUndefined();
        continue;
      }
      const tile = await ours.readTileData(lookup.result);
      expect(tile.payload).toEqual(new Uint8Array(theirs!.data));
    }
  });

  it("Local と HTTP で read の並び（offset / length / 目的）は同じ。違うのは HTTP の観測情報だけ", async () => {
    const run = async (src: TracingByteSource) => {
      const a = await PmtilesArchive.open(src);
      await a.readMetadata();
      const l = await a.lookupTile(8, 200, 100);
      if (l.result.status === "found") await a.readTileData(l.result);
      return src.records;
    };
    const local = await run(new TracingByteSource(await ourSource(FIXTURES.leaf)));
    const http = await run(new TracingByteSource(new HttpRangeSource(url("ok", FIXTURES.leaf))));
    const shape = (rs: typeof local) => rs.map((r) => [r.purpose, r.offset, r.requestedLength, r.receivedLength]);
    expect(shape(http)).toEqual(shape(local));
    expect(local.every((r) => r.http === undefined)).toBe(true);
    expect(http[0]!.http!.exchanges).toMatchObject([
      { method: "GET", requestRange: "bytes=0-16383", status: 206, headers: { "content-range": `bytes 0-16383/${readFileSync(fixturePath(FIXTURES.leaf)).length}` } },
    ]);
  });
});

describe("HttpRangeSource: サーバの振る舞いごとの扱い", () => {
  it("206 の Content-Range から全体サイズが分かる", async () => {
    const src = new HttpRangeSource(url("ok", FIXTURES.leaf));
    expect(src.size()).toBeUndefined();
    await src.read(0, 16384);
    expect(src.size()).toBe(readFileSync(fixturePath(FIXTURES.leaf)).length);
    expect(src.sizeOrigin).toBe("content-range");
  });

  it("16 KiB 未満の archive: RFC どおりのサーバは切り詰めた 206 を返す（request は 1 回）", async () => {
    hits = [];
    const r = await new HttpRangeSource(url("ok", FIXTURES.fixture1)).read(0, 16384);
    expect(r.bytes.length).toBe(468);
    expect(r.http!.exchanges.map((e) => e.status)).toEqual([206]);
    expect(hits.length).toBe(1);
  });

  it("16 KiB 未満の archive: 416 を返すサーバには公式と同じく全長で取り直し、2 回のやり取りを両方残す", async () => {
    const r = await new HttpRangeSource(url("strict416", FIXTURES.fixture1)).read(0, 16384);
    expect(r.bytes).toEqual(new Uint8Array(readFileSync(fixturePath(FIXTURES.fixture1))));
    expect(r.http!.exchanges.map((e) => [e.requestRange, e.status])).toEqual([
      ["bytes=0-16383", 416],
      ["bytes=0-467", 206],
    ]);
  });

  it("Range を無視して 200 で全体を返すサーバは range-not-supported（全体のダウンロードを始めない）", async () => {
    const src = new TracingByteSource(new HttpRangeSource(url("norange", FIXTURES.leaf)));
    const err = await src.read(0, 16384).catch((e) => e);
    expect(err).toBeInstanceOf(HttpRangeError);
    expect(err.kind).toBe("range-not-supported");
    // 失敗した read も Read Trace に残り、200 を受けたことが分かる
    expect(src.records[0]).toMatchObject({ errorKind: "range-not-supported", receivedLength: 0 });
    expect(src.records[0]!.http!.exchanges[0]!.status).toBe(200);
  });

  it("要求より短い 200 は「ファイル全体」とみなして受け入れる（公式と同じ）", async () => {
    const src = new HttpRangeSource(url("norange", FIXTURES.fixture1));
    const r = await src.read(0, 16384);
    expect(r.bytes.length).toBe(468);
    expect(src.size()).toBe(468);
    expect(src.sizeOrigin).toBe("full-body");
  });

  it("404 は http-status", async () => {
    const err = await new HttpRangeSource(url("ok", "missing.pmtiles")).read(0, 16384).catch((e) => e);
    expect(err).toMatchObject({ kind: "http-status", status: 404 });
  });

  it("接続できない URL は network（no-cors の診断 request も届かない）", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", r));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    const err = await new HttpRangeSource(`http://127.0.0.1:${port}/x.pmtiles`).read(0, 16384).catch((e) => e);
    expect(err).toMatchObject({ kind: "network" });
    expect(err.http.exchanges.map((e: { method: string; mode: string }) => `${e.method}/${e.mode}`)).toEqual(["GET/cors", "HEAD/no-cors"]);
  });

  it("読み取り中に ETag が変わったら etag-changed で止める", async () => {
    const src = new HttpRangeSource(url("changing", FIXTURES.leaf));
    await src.read(0, 16384);
    await expect(src.read(16384, 100)).rejects.toMatchObject({ kind: "etag-changed" });
  });

  it("URL として解釈できない文字列は invalid-url", () => {
    expect(() => new HttpRangeSource("http://[bad")).toThrow(expect.objectContaining({ kind: "invalid-url" }));
  });
});

describe("Archive Size を HEAD で補う", () => {
  it("HEAD は size-probe として Read Trace に 0 byte で残る", async () => {
    const src = new TracingByteSource(new HttpRangeSource(url("ok", FIXTURES.leaf)));
    const probe = await src.probeSize();
    expect(probe.contentLength).toBe(readFileSync(fixturePath(FIXTURES.leaf)).length);
    expect(src.records).toMatchObject([{ purpose: "size-probe", requestedLength: 0, receivedLength: 0 }]);
    expect(src.records[0]!.http!.exchanges[0]).toMatchObject({ method: "HEAD", status: 200 });
  });

  it("gzip 後の長さを返す HEAD は、Header の section 終端より短いので採用しない", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    const probe = await new HttpRangeSource(url("gzip", FIXTURES.leaf)).probeSize();
    expect(probe.contentLength!).toBeLessThan(minimumArchiveSize(archive.header));
    // 同一オリジン相当（Node の fetch は type=basic）なので Content-Encoding が読め、それだけで弾ける
    expect(sizeFromProbe(archive.header, probe)).toMatchObject({ origin: "unknown" });
    // 別オリジンで Content-Encoding が読めない場合も、長さの下限で弾ける
    expect(sizeFromProbe(archive.header, { ...probe, contentEncoding: null, crossOrigin: true })).toMatchObject({ origin: "unknown" });
  });

  it("妥当な HEAD は採用する。別オリジンでは圧縮されていないことを確かめられないので exact=false", async () => {
    const archive = await PmtilesArchive.open(await ourSource(FIXTURES.leaf));
    const probe = await new HttpRangeSource(url("ok", FIXTURES.leaf)).probeSize();
    const n = readFileSync(fixturePath(FIXTURES.leaf)).length;
    expect(sizeFromProbe(archive.header, probe)).toEqual({ origin: "head", bytes: n, exact: true });
    expect(sizeFromProbe(archive.header, { ...probe, crossOrigin: true })).toEqual({ origin: "head", bytes: n, exact: false });
  });
});

describe("isMixedContent", () => {
  it.each([
    ["https://www.jumboly.jp/a/", "http://example.com/x.pmtiles", true],
    ["https://www.jumboly.jp/a/", "https://example.com/x.pmtiles", false],
    ["http://localhost:5173/", "http://example.com/x.pmtiles", false],
    // localhost は潜在的に信頼できる origin としてブラウザが許可する
    ["https://www.jumboly.jp/a/", "http://localhost:8080/x.pmtiles", false],
    ["https://www.jumboly.jp/a/", "http://127.0.0.1:8080/x.pmtiles", false],
  ])("%s → %s: %s", (page, target, expected) => {
    expect(isMixedContent(page, target)).toBe(expected);
  });
});
