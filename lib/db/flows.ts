import type { LeadSource } from "@/lib/domain/catalog";
import { flowsCol, type FlowDoc, type FlowStep } from "./collections";

// Состояние пошагового диалога «➕ Добавить клиента» хранится в БД, а не в памяти:
// переживает перезапуск процесса и работает при нескольких инстансах.

export async function getFlow(userId: number): Promise<FlowDoc | null> {
  return (await flowsCol()).findOne({ userId });
}

export async function setFlow(userId: number, step: FlowStep, data: FlowDoc["data"]): Promise<void> {
  const col = await flowsCol();
  await col.updateOne({ userId }, { $set: { step, data, updatedAt: new Date() } }, { upsert: true });
}

export async function clearFlow(userId: number): Promise<void> {
  const col = await flowsCol();
  await col.deleteOne({ userId });
}

export type { LeadSource };
