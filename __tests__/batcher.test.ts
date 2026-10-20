import { Batcher } from "@/lib/services/batcher";

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

const tick = (ms: number) => jest.advanceTimersByTimeAsync(ms);

describe("Batcher", () => {
  it("склеивает сообщения в пределах окна и обрабатывает пачку один раз", async () => {
    const onFlush = jest.fn(async () => undefined);
    const b = new Batcher<string>({ debounceMs: 1000, onFlush });
    b.push("a", "1");
    await tick(600);
    b.push("a", "2");
    await tick(600);
    expect(onFlush).not.toHaveBeenCalled(); // окно сдвинулось
    await tick(500);
    expect(onFlush).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledWith("a", ["1", "2"]);
  });

  it("разные ключи обрабатываются независимо", async () => {
    const onFlush = jest.fn(async () => undefined);
    const b = new Batcher<string>({ debounceMs: 100, onFlush });
    b.push("a", "x");
    b.push("b", "y");
    await tick(150);
    expect(onFlush).toHaveBeenCalledWith("a", ["x"]);
    expect(onFlush).toHaveBeenCalledWith("b", ["y"]);
  });

  it("пачки одного ключа не пересекаются: вторая ждёт окончания первой", async () => {
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const b = new Batcher<string>({
      debounceMs: 100,
      onFlush: async (_k, items) => {
        order.push(`start:${items[0]}`);
        if (items[0] === "first") await gate;
        order.push(`end:${items[0]}`);
      },
    });
    b.push("a", "first");
    await tick(150);
    b.push("a", "second");
    await tick(150);
    expect(order).toEqual(["start:first"]); // вторая пачка ждёт
    release();
    await tick(0);
    expect(order).toEqual(["start:first", "end:first", "start:second", "end:second"]);
  });

  it("ошибка обработки не ломает очередь и уходит в onError", async () => {
    const onError = jest.fn();
    const onFlush = jest.fn(async (_k: string, items: string[]) => {
      if (items[0] === "bad") throw new Error("boom");
    });
    const b = new Batcher<string>({ debounceMs: 50, onFlush, onError });
    b.push("a", "bad");
    await tick(60);
    b.push("a", "good");
    await tick(60);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onFlush).toHaveBeenCalledTimes(2);
  });

  it("maxWait: непрерывный поток сообщений не откладывает ответ бесконечно", async () => {
    const onFlush = jest.fn(async () => undefined);
    const b = new Batcher<string>({ debounceMs: 1000, maxWaitMs: 2500, onFlush });
    for (let i = 0; i < 6; i++) {
      b.push("a", String(i));
      await tick(600);
    }
    expect(onFlush).toHaveBeenCalledTimes(1);
  });

  it("drain обрабатывает накопленное немедленно", async () => {
    const onFlush = jest.fn(async () => undefined);
    const b = new Batcher<string>({ debounceMs: 60_000, onFlush });
    b.push("a", "x");
    await b.drain();
    expect(onFlush).toHaveBeenCalledWith("a", ["x"]);
    expect(b.pendingKeys).toBe(0);
  });
});
