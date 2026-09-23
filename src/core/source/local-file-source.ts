import type { ByteSource, ReadContext, ReadResult } from "./types";

/**
 * File / Blob を slice 単位で読む ByteSource。
 *
 * 全体を arrayBuffer() しないのは、数 GB のローカルファイルでも
 * 「必要な範囲だけ読む」という PMTiles の設計をそのまま体験できるようにするため。
 */
export class LocalFileSource implements ByteSource {
  readonly key: string;

  constructor(private readonly blob: Blob, name?: string) {
    this.key = name ?? (blob instanceof File ? blob.name : "blob");
  }

  size(): number {
    return this.blob.size;
  }

  async read(offset: number, length: number, ctx?: ReadContext): Promise<ReadResult> {
    ctx?.signal?.throwIfAborted();
    const buf = await this.blob.slice(offset, offset + length).arrayBuffer();
    return { offset, requestedLength: length, bytes: new Uint8Array(buf) };
  }
}
