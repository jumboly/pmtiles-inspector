import type { ByteSource, ReadContext, ReadPurpose, ReadResult, HttpReadInfo } from "./types";

export interface ReadRecord {
  /** 1 始まりの通し番号。UI 上の "READ #n" に対応する。 */
  id: number;
  offset: number;
  requestedLength: number;
  /** 実際に受け取った byte 数（EOF で短くなる場合がある） */
  receivedLength: number;
  purpose: ReadPurpose;
  label?: string;
  startedAt: number;
  durationMs: number;
  http?: HttpReadInfo;
  error?: string;
}

type Listener = (record: ReadRecord) => void;

/**
 * 任意の ByteSource を包み、すべての read を記録する。
 *
 * trace を後付けにせず Source 層で取るのは、parser やキャッシュの実装に関係なく
 * 「実際に I/O が発生したか」を真実として記録したいから（キャッシュヒットは read にならない）。
 */
export class TracingByteSource implements ByteSource {
  readonly records: ReadRecord[] = [];
  private nextId = 1;
  private listeners = new Set<Listener>();

  constructor(readonly inner: ByteSource) {}

  get key(): string {
    return this.inner.key;
  }

  size(): number | undefined {
    return this.inner.size();
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 実際に読んだ総 byte 数（重複 read も数える。帯域として実際に消費した量を示したいため） */
  totalBytesRead(): number {
    return this.records.reduce((sum, r) => sum + r.receivedLength, 0);
  }

  async read(offset: number, length: number, ctx?: ReadContext): Promise<ReadResult> {
    const id = this.nextId++;
    const startedAt = now();
    const base = {
      id,
      offset,
      requestedLength: length,
      purpose: ctx?.purpose ?? "other",
      label: ctx?.label,
      startedAt,
    } as const;
    try {
      const result = await this.inner.read(offset, length, ctx);
      this.push({
        ...base,
        receivedLength: result.bytes.length,
        durationMs: now() - startedAt,
        http: result.http,
      });
      return { ...result, readId: id };
    } catch (e) {
      this.push({
        ...base,
        receivedLength: 0,
        durationMs: now() - startedAt,
        error: e instanceof Error ? e.message : String(e),
      });
      throw e;
    }
  }

  private push(record: ReadRecord) {
    this.records.push(record);
    for (const l of this.listeners) l(record);
  }
}

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}
