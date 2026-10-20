// HTTP-вызов с таймаутом и повтором при сетевых сбоях, 429 и 5xx (экспоненциальная пауза + джиттер).
// Остальные ответы (включая 4xx) возвращаются как есть — их разбирает вызывающий код.

export interface RetryOptions {
  timeoutMs?: number;
  attempts?: number;
  baseDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function fetchWithRetry(url: string, init: RequestInit = {}, opts: RetryOptions = {}): Promise<Response> {
  const { timeoutMs = 10_000, attempts = 3, baseDelayMs = 500, sleep = defaultSleep } = opts;
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const isLast = attempt === attempts;
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if ((res.status === 429 || res.status >= 500) && !isLast) {
        await res.text().catch(() => undefined); // освободить соединение
        await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (isLast) break;
      await sleep(baseDelayMs * 2 ** (attempt - 1) + Math.random() * 100);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
