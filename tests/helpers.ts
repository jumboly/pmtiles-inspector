import { openAsBlob } from "node:fs";
import { fileURLToPath } from "node:url";
import { FileSource, type Source } from "pmtiles";
import type { PmtilesArchive } from "../src/core/pmtiles/archive";
import { LocalFileSource } from "../src/core/source/local-file-source";

export const FIXTURES = {
  fixture1: "test_fixture_1.pmtiles",
  fixture2: "test_fixture_2.pmtiles",
  mlt: "test_fixture_mlt.pmtiles",
  /** tippecanoe 由来の MVT (gzip tile)。z0-3 を pmtiles extract で切り出したもの */
  zcta: "zcta_z3.pmtiles",
  /** terrarium PNG。z0-2 を pmtiles extract で切り出したもの */
  terrarium: "terrarium_z2.pmtiles",
  /** 公式 Go writer で生成した leaf directory / run-length / dedup 入り fixture */
  leaf: "leaf_z8.pmtiles",
  /** leaf_z8 の Internal Compression を none にしたもの（scripts/make-uncompressed-fixture.py） */
  leafNoComp: "leaf_z8_nocomp.pmtiles",
} as const;

export function fixturePath(name: string): string {
  return fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url));
}

/**
 * openAsBlob はファイルを丸ごとメモリに載せず、slice 時に必要な範囲だけ読む。
 * ブラウザの File と同じ振る舞いになるので、テストでも LocalFileSource を実物のまま使える。
 */
export async function ourSource(name: string): Promise<LocalFileSource> {
  return new LocalFileSource(await openAsBlob(fixturePath(name)), name);
}

export async function officialSource(name: string): Promise<Source> {
  const blob = await openAsBlob(fixturePath(name));
  return new FileSource(new File([blob], name));
}

/** 全ディレクトリ（root + すべての leaf）を自前実装で列挙する */
export async function allDirectories(archive: PmtilesArchive) {
  const dirs = [archive.root];
  for (let i = 0; i < dirs.length; i++) {
    for (const e of dirs[i]!.decoded.entries) {
      if (e.runLength === 0) dirs.push((await archive.readLeafDirectory(e)).record);
    }
  }
  return dirs;
}
