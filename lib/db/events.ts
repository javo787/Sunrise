import { eventsCol, failedEventsCol, isDuplicateKeyError, reportLogCol } from "./collections";

/**
 * Дедупликация вебхуков: Meta, Evolution и Telegram повторяют доставку при таймауте.
 * true — событие новое и его нужно обработать; false — уже видели.
 */
export async function claimEvent(key: string, now: Date = new Date()): Promise<boolean> {
  const col = await eventsCol();
  try {
    await col.insertOne({ key, createdAt: now });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

/** Снять отметку, если обработка упала до реальной работы — чтобы ретрай вебхука не был проигнорирован. */
export async function releaseEvent(key: string): Promise<void> {
  const col = await eventsCol();
  await col.deleteOne({ key });
}

export async function recordFailure(kind: string, payload: unknown, error: unknown): Promise<void> {
  try {
    const col = await failedEventsCol();
    await col.insertOne({
      kind,
      payload,
      error: error instanceof Error ? error.message : String(error),
      createdAt: new Date(),
    });
  } catch {
    // журнал сбоев не должен ронять обработку
  }
}

/** Идемпотентность отчётов: при нескольких инстансах отчёт за период уйдёт один раз. */
export async function claimReportSlot(kind: "daily" | "monthly", period: string): Promise<boolean> {
  const col = await reportLogCol();
  try {
    await col.insertOne({ kind, period, createdAt: new Date() });
    return true;
  } catch (err) {
    if (isDuplicateKeyError(err)) return false;
    throw err;
  }
}

export async function releaseReportSlot(kind: "daily" | "monthly", period: string): Promise<void> {
  const col = await reportLogCol();
  await col.deleteOne({ kind, period });
}

// ---------------------------------------------------------------- журнал сбоев с повтором (Meta leadgen)

export async function listRecentFailures(kind: string, since: Date, limit = 20) {
  const col = await failedEventsCol();
  return col.find({ kind, createdAt: { $gte: since } }).sort({ createdAt: 1 }).limit(limit).toArray();
}

export async function deleteFailure(id: import("mongodb").ObjectId): Promise<void> {
  const col = await failedEventsCol();
  await col.deleteOne({ _id: id });
}
