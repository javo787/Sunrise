import type { ObjectId } from "mongodb";
import { sessionsCol, type Session, type SessionMessage, type SessionState } from "./collections";

export const MAX_SESSION_MESSAGES = 30;

export async function getOrCreateSession(
  channel: "whatsapp" | "instagram",
  contactId: string,
  replyTo: string,
  now: Date = new Date()
): Promise<Session> {
  const col = await sessionsCol();
  await col.updateOne(
    { channel, contactId },
    {
      $set: { replyTo, updatedAt: now },
      $setOnInsert: { messages: [], state: { userTurns: 0 }, handedOff: false, createdAt: now },
    },
    { upsert: true }
  );
  const session = await col.findOne({ channel, contactId });
  if (!session) throw new Error("Сессия диалога не найдена после upsert");
  return session;
}

export async function saveSession(
  id: ObjectId,
  patch: { messages: SessionMessage[]; state: SessionState; handedOff?: boolean; leadId?: ObjectId },
  now: Date = new Date()
): Promise<void> {
  const col = await sessionsCol();
  await col.updateOne(
    { _id: id },
    {
      $set: {
        messages: patch.messages.slice(-MAX_SESSION_MESSAGES),
        state: patch.state,
        updatedAt: now,
        ...(patch.handedOff !== undefined ? { handedOff: patch.handedOff } : {}),
        ...(patch.leadId ? { leadId: patch.leadId } : {}),
      },
    }
  );
}
