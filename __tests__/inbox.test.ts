import { getDb } from "@/lib/mongodb";
import { resetIndexCacheForTests } from "@/lib/db/collections";
import { MAX_INBOX_ATTEMPTS, markInboxDone, RECOVER_AFTER_MS, recordInbound, recoverStaleInbox } from "@/lib/services/inbox";
import type { InboundMessage } from "@/lib/services/sales-bot";
import { FakeDb } from "./helpers/fake-mongo";

jest.mock("@/lib/mongodb", () => ({ getDb: jest.fn() }));

let db: FakeDb;
beforeEach(() => {
  db = new FakeDb();
  (getDb as jest.Mock).mockResolvedValue(db);
  resetIndexCacheForTests();
});

const T0 = new Date("2026-10-20T10:00:00Z");
const later = (ms: number) => new Date(T0.getTime() + ms);
const msg = (text: string, contactId = "992931234567", over: Partial<InboundMessage> = {}): InboundMessage => ({ channel: "whatsapp", contactId, replyTo: contactId, phone: contactId, name: "Алишер", text, ...over });
const inbox = () => db.collection("inbox").docs;

describe("recordInbound / markInboxDone", () => {
  it("сообщение пишется в очередь без аудио-данных; после обработки помечается done", async () => {
    const id = await recordInbound("whatsapp:992931234567", msg("", undefined, { audio: { base64: "AAAA", mimeType: "audio/ogg" }, readKeys: [{ id: "m1", remoteJid: "x" }] }), T0);
    expect(id).toBeDefined();
    expect(inbox()[0]).toMatchObject({ key: "whatsapp:992931234567", status: "queued", attempts: 0, message: { hadAudio: true, text: "" } });
    expect(JSON.stringify(inbox()[0])).not.toContain("AAAA");

    await markInboxDone([id, undefined, "not-an-id"]);
    expect(inbox()[0].status).toBe("done");
  });

  it("сбой БД не ломает приём: возвращается undefined", async () => {
    (getDb as jest.Mock).mockRejectedValue(new Error("mongo down"));
    expect(await recordInbound("k", msg("привет"))).toBeUndefined();
  });
});

describe("recoverStaleInbox", () => {
  it("добирает старые необработанные сообщения пачкой по клиенту в исходном порядке и помечает done", async () => {
    await recordInbound("whatsapp:A", msg("первое", "A"), T0);
    await recordInbound("whatsapp:B", msg("чужое", "B"), later(1000));
    await recordInbound("whatsapp:A", msg("второе", "A"), later(2000));
    const handle = jest.fn(async (_batch: InboundMessage[]) => undefined);

    const res = await recoverStaleInbox(handle, later(RECOVER_AFTER_MS + 10_000));
    expect(res).toEqual({ recovered: 3, failed: 0 });
    expect(handle).toHaveBeenCalledTimes(2);
    const batches = handle.mock.calls.map((c) => (c[0] as InboundMessage[]).map((m) => m.text));
    expect(batches).toContainEqual(["первое", "второе"]);
    expect(batches).toContainEqual(["чужое"]);
    expect(inbox().every((d) => d.status === "done")).toBe(true);
    expect((handle.mock.calls[0][0] as InboundMessage[])[0].inboxId).toBeDefined();
  });

  it("свежие сообщения (ещё в окне склейки) и уже обработанные не трогаются", async () => {
    const id = await recordInbound("whatsapp:A", msg("свежее", "A"), later(RECOVER_AFTER_MS - 1000));
    await recordInbound("whatsapp:B", msg("старое, но обработано", "B"), T0).then((i) => markInboxDone([i]));
    const handle = jest.fn(async (_batch: InboundMessage[]) => undefined);
    expect(await recoverStaleInbox(handle, later(RECOVER_AFTER_MS + 1000))).toEqual({ recovered: 0, failed: 0 });
    expect(handle).not.toHaveBeenCalled();
    expect(inbox().find((d) => d._id.toHexString() === id)?.status).toBe("queued");
  });

  it("голосовое без текста восстанавливается как пометка", async () => {
    await recordInbound("whatsapp:A", msg("", "A", { audio: { base64: "x", mimeType: "audio/ogg" } }), T0);
    const handle = jest.fn(async (_b: InboundMessage[]) => undefined);
    await recoverStaleInbox(handle, later(RECOVER_AFTER_MS + 1000));
    expect(handle.mock.calls[0][0][0].text).toBe("[голосовое сообщение]");
  });

  it("два инстанса одновременно: каждое сообщение обрабатывается один раз", async () => {
    await recordInbound("whatsapp:A", msg("привет", "A"), T0);
    const handle = jest.fn(async (_batch: InboundMessage[]) => undefined);
    const now = later(RECOVER_AFTER_MS + 1000);
    const [a, b] = await Promise.all([recoverStaleInbox(handle, now), recoverStaleInbox(handle, now)]);
    expect(a.recovered + b.recovered).toBe(1);
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("ошибка обработки возвращает сообщения в очередь; после лимита попыток они помечаются failed", async () => {
    await recordInbound("whatsapp:A", msg("привет", "A"), T0);
    const handle = jest.fn(async (_batch: InboundMessage[]): Promise<void> => { throw new Error("mongo down"); });

    for (let i = 1; i <= MAX_INBOX_ATTEMPTS; i++) {
      expect(await recoverStaleInbox(handle, later(RECOVER_AFTER_MS * (i + 1)))).toEqual({ recovered: 0, failed: 1 });
      expect(inbox()[0]).toMatchObject({ status: "queued", attempts: i });
    }
    expect(await recoverStaleInbox(handle, later(RECOVER_AFTER_MS * 20))).toEqual({ recovered: 0, failed: 0 });
    expect(inbox()[0].status).toBe("failed");
    expect(handle).toHaveBeenCalledTimes(MAX_INBOX_ATTEMPTS);
  });

  it("зависшая обработка (processing старше 10 минут) подхватывается заново", async () => {
    await recordInbound("whatsapp:A", msg("привет", "A"), T0);
    inbox()[0].status = "processing";
    inbox()[0].lockAt = T0;
    inbox()[0].attempts = 1;
    const handle = jest.fn(async (_batch: InboundMessage[]) => undefined);

    expect(await recoverStaleInbox(handle, later(5 * 60_000))).toEqual({ recovered: 0, failed: 0 }); // ещё обрабатывается
    expect(await recoverStaleInbox(handle, later(11 * 60_000))).toEqual({ recovered: 1, failed: 0 });
  });
});
