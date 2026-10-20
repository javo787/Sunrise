import { markWhatsAppMessagesRead, sendWhatsAppText } from "@/lib/evolution";
import { interBubblePauseMs, readDelayMs, typingDelayMs } from "@/lib/humanize";
import { sendInstagramText } from "@/lib/integrations/meta";
import { newRequestId } from "@/lib/logger";
import type { Session } from "@/lib/db/collections";
import type { InboundMessage } from "./sales-bot";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Отправка ответа бота в канал клиента. WhatsApp: «прочитано» → пауза → «печатает…» →
 * сообщение; между пузырями выдерживаем паузу, как у живого человека (логика из meditour-crm).
 */
export async function sendViaChannel(session: Session, bubbles: string[], inbound: InboundMessage[]): Promise<void> {
  const requestId = newRequestId();

  if (session.channel === "instagram") {
    for (let i = 0; i < bubbles.length; i++) {
      await sendInstagramText(session.replyTo, bubbles[i]);
      if (i < bubbles.length - 1) await sleep(700 + Math.random() * 500);
    }
    return;
  }

  const keys = inbound.flatMap((m) => m.readKeys ?? []);
  if (keys.length > 0 && (await markWhatsAppMessagesRead(keys, requestId))) await sleep(readDelayMs());

  for (let i = 0; i < bubbles.length; i++) {
    const typing = typingDelayMs(bubbles[i]);
    const startedAt = Date.now();
    await sendWhatsAppText(session.replyTo, bubbles[i], requestId, { typingDelayMs: typing });
    if (i < bubbles.length - 1) await sleep(interBubblePauseMs(typing, Date.now() - startedAt));
  }
}
