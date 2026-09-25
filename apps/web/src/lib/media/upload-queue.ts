import { UploadFailure, type UploadTransport } from './upload-transport';

export type UploadStatus =
  'queued' | 'compressing' | 'uploading' | 'confirming' | 'done' | 'failed';

export interface UploadItem {
  readonly id: string;
  /** The picked file, kept for its preview and in case compression must rerun. */
  readonly file: Blob;
  readonly status: UploadStatus;
  /** 0–1 while uploading. */
  readonly progress: number;
  readonly attempts: number;
  readonly errorCode?: string | undefined;
  readonly mediaId?: string;
  readonly compressed?: Blob;
}

export interface UploadQueueOptions {
  transport: UploadTransport;
  compress: (file: Blob) => Promise<Blob>;
  maxItems?: number;
  concurrency?: number;
  /** Waits before the 2nd, 3rd and 4th attempt; then the item fails. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

export const DEFAULT_MAX_ITEMS = 10;
const DEFAULT_CONCURRENCY = 2;
export const DEFAULT_RETRY_DELAYS_MS = [2_000, 6_000, 20_000] as const;

/**
 * The photos being prepared for one post — the web twin of the mobile app's
 * UploadQueue, minus persistence (a closed tab takes its File handles with it):
 *
 *  - compress → hash → presign → PUT to storage with progress → confirm;
 *  - two at a time; the rest wait their turn;
 *  - retryable failures (network, timeout, 5xx, rate limit) back off and try
 *    again; a refused file fails at once and can be retried by hand;
 *  - reorder and remove at any time; removing aborts that item's upload. The
 *    server sweeps uploads that are never attached, so nothing is undone.
 *
 * Framework-free, with `subscribe`/`getSnapshot` for useSyncExternalStore.
 */
export class UploadQueue {
  readonly maxItems: number;
  private readonly concurrency: number;
  private readonly retryDelaysMs: readonly number[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly newId: () => string;

  private items: readonly UploadItem[] = [];
  private readonly listeners = new Set<() => void>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly running = new Set<string>();
  private disposed = false;

  constructor(private readonly options: UploadQueueOptions) {
    this.maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.newId = options.newId ?? (() => crypto.randomUUID());
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): readonly UploadItem[] => this.items;

  get remainingSlots(): number {
    return Math.max(0, this.maxItems - this.items.length);
  }

  /** Confirmed media ids in the user's order — the first is the cover. */
  get mediaIds(): string[] {
    return this.items.flatMap((i) => (i.status === 'done' && i.mediaId ? [i.mediaId] : []));
  }

  get isComplete(): boolean {
    return this.items.length > 0 && this.items.every((i) => i.status === 'done');
  }

  /** Adds files up to the limit; returns how many were taken. */
  add(files: readonly Blob[]): number {
    const taken = files.slice(0, this.remainingSlots);
    this.set([
      ...this.items,
      ...taken.map((file) => ({
        id: this.newId(),
        file,
        status: 'queued' as const,
        progress: 0,
        attempts: 0,
      })),
    ]);
    this.pump();
    return taken.length;
  }

  remove(id: string): void {
    this.controllers.get(id)?.abort();
    this.set(this.items.filter((i) => i.id !== id));
    this.pump();
  }

  /** Moves an item so it ends up at `to`. */
  reorder(from: number, to: number): void {
    if (from === to || from < 0 || to < 0 || from >= this.items.length || to >= this.items.length) {
      return;
    }
    const items = [...this.items];
    const [item] = items.splice(from, 1);
    items.splice(to, 0, item!);
    this.set(items);
  }

  retry(id: string): void {
    if (this.find(id)?.status !== 'failed') return;
    this.update(id, { status: 'queued', attempts: 0, progress: 0, errorCode: undefined });
    this.pump();
  }

  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers.values()) controller.abort();
    this.listeners.clear();
  }

  private pump(): void {
    if (this.disposed) return;
    for (const item of this.items) {
      if (this.running.size >= this.concurrency) break;
      if (item.status === 'queued' && !this.running.has(item.id)) {
        this.running.add(item.id);
        void this.run(item.id).finally(() => {
          this.running.delete(item.id);
          this.pump();
        });
      }
    }
  }

  private async run(id: string): Promise<void> {
    while (!this.disposed && this.find(id)) {
      try {
        await this.attempt(id);
        return;
      } catch (error) {
        const item = this.find(id);
        if (!item) return;
        const failure =
          error instanceof UploadFailure ? error : new UploadFailure('compression', false);
        if (failure.code === 'cancelled') return;
        const attempts = item.attempts + 1;
        const retry = failure.retryable && attempts <= this.retryDelaysMs.length;
        this.update(id, {
          attempts,
          status: retry ? 'queued' : 'failed',
          errorCode: failure.code,
          progress: 0,
        });
        if (!retry) return;
        await this.sleep(this.retryDelaysMs[attempts - 1]!);
      }
    }
  }

  private async attempt(id: string): Promise<void> {
    let item = this.find(id)!;
    if (!item.compressed) {
      this.update(id, { status: 'compressing' });
      const compressed = await this.options.compress(item.file);
      if (!this.find(id)) return;
      this.update(id, { compressed });
      item = this.find(id)!;
    }
    const body = item.compressed!;

    this.update(id, { status: 'uploading', progress: 0 });
    const target = await this.options.transport.presign({
      byteSize: body.size,
      sha256: await sha256Hex(body),
      contentType: body.type,
    });
    if (!this.find(id)) return;

    const controller = new AbortController();
    this.controllers.set(id, controller);
    try {
      await this.options.transport.put(
        target,
        body,
        (progress) => this.update(id, { progress }),
        controller.signal,
      );
    } finally {
      this.controllers.delete(id);
    }
    if (!this.find(id)) return;

    this.update(id, { status: 'confirming', progress: 1 });
    await this.options.transport.confirm(target.mediaId);
    this.update(id, { status: 'done', mediaId: target.mediaId, errorCode: undefined });
  }

  private find(id: string): UploadItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  private update(id: string, change: Partial<UploadItem>): void {
    if (!this.find(id)) return;
    this.set(this.items.map((i) => (i.id === id ? { ...i, ...change } : i)));
  }

  private set(items: readonly UploadItem[]): void {
    this.items = items;
    for (const listener of this.listeners) listener();
  }
}

export async function sha256Hex(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}
