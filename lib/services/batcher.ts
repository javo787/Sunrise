// Склейка сообщений клиента в пачку: люди пишут несколько коротких реплик подряд, и на
// каждую отвечать отдельно — значит отвечать невпопад. Таймер сбрасывается новым сообщением
// (debounce), но не дольше maxWaitMs. Пачки одного ключа обрабатываются строго по очереди.
//
// Состояние в памяти процесса: рассчитано на один долгоживущий Node-процесс (Render/VPS).

export interface BatcherOptions<T> {
  debounceMs: number;
  maxWaitMs?: number;
  onFlush: (key: string, items: T[]) => Promise<void>;
  onError?: (key: string, err: unknown) => void;
}

interface Buffer<T> {
  items: T[];
  timer?: ReturnType<typeof setTimeout>;
  firstAt: number;
}

export class Batcher<T> {
  private buffers = new Map<string, Buffer<T>>();
  private chains = new Map<string, Promise<void>>();

  constructor(private readonly opts: BatcherOptions<T>) {}

  push(key: string, item: T): void {
    const now = Date.now();
    const buf = this.buffers.get(key) ?? { items: [], firstAt: now };
    buf.items.push(item);
    if (buf.timer) clearTimeout(buf.timer);

    const maxWait = this.opts.maxWaitMs ?? 30_000;
    const delay = Math.max(0, Math.min(this.opts.debounceMs, buf.firstAt + maxWait - now));
    buf.timer = setTimeout(() => this.flush(key), delay);
    buf.timer.unref?.();
    this.buffers.set(key, buf);
  }

  private flush(key: string): void {
    const buf = this.buffers.get(key);
    if (!buf) return;
    this.buffers.delete(key);
    if (buf.timer) clearTimeout(buf.timer);

    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev
      .then(() => this.opts.onFlush(key, buf.items))
      .catch((err) => this.opts.onError?.(key, err))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
  }

  /** Немедленно обработать всё накопленное и дождаться завершения (остановка сервиса, тесты). */
  async drain(): Promise<void> {
    for (const key of [...this.buffers.keys()]) this.flush(key);
    await Promise.all([...this.chains.values()]);
  }

  get pendingKeys(): number {
    return this.buffers.size;
  }
}
