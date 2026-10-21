import { getLead } from "@/lib/db/leads";
import type { Session } from "@/lib/db/collections";
import { renderClientMessage } from "@/lib/telegram/cards";
import type { TelegramGateway } from "@/lib/telegram/gateway";
import type { InboundMessage } from "./sales-bot";

export type RelayResult = "dm" | "group" | "none";

/**
 * После передачи лида бот клиенту не отвечает — отвечает менеджер. Чтобы дописанные клиентом
 * сообщения не потерялись, пересылаем их закрепившему менеджеру в личку; пока лид ещё никем не
 * забран — в тред карточки в группе (без телефона).
 */
export async function relayClientMessage(deps: { gateway: TelegramGateway }, session: Pick<Session, "leadId">, batch: InboundMessage[]): Promise<RelayResult> {
  if (!session.leadId) return "none";
  const texts = batch.map((m) => m.text || (m.audio ? "[голосовое сообщение]" : "")).filter(Boolean);
  if (texts.length === 0) return "none";

  const lead = await getLead(session.leadId.toHexString());
  if (!lead) return "none";
  const channel = batch[0].channel;

  if (lead.claim) {
    const delivered = await deps.gateway.sendDm(lead.claim.managerId, renderClientMessage(lead, texts, channel, true));
    return delivered ? "dm" : "none";
  }
  if (lead.card) {
    await deps.gateway.sendGroupHtml(renderClientMessage(lead, texts, channel, false), lead.card.messageId);
    return "group";
  }
  return "none";
}
