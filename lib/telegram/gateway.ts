import { InlineKeyboard, type Api } from "grammy";
import type { Lead } from "@/lib/db/collections";
import { createLogger } from "@/lib/logger";
import { claimedKeyboard, claimKeyboard, renderClaimedCard, renderLeadCard } from "./cards";

const log = createLogger("telegram");

/** Порт к Telegram: сервисы работают с ним, а не с grammY напрямую — это упрощает тесты. */
export interface TelegramGateway {
  sendCard(lead: Lead): Promise<{ chatId: number; messageId: number }>;
  markClaimed(card: { chatId: number; messageId: number }, lead: Lead): Promise<void>;
  /** false — доставить не удалось (менеджер не нажал /start у бота или заблокировал его) */
  sendDm(userId: number, html: string): Promise<boolean>;
  sendGroupHtml(html: string, replyToMessageId?: number): Promise<void>;
  sendTo(chatId: number, html: string): Promise<void>;
}

const noPreview = { is_disabled: true };

export function createTelegramGateway(api: Api, managersChatId: number, tz: string): TelegramGateway {
  return {
    async sendCard(lead) {
      const msg = await api.sendMessage(managersChatId, renderLeadCard(lead), {
        parse_mode: "HTML",
        reply_markup: claimKeyboard(lead._id.toHexString()),
        link_preview_options: noPreview,
      });
      return { chatId: msg.chat.id, messageId: msg.message_id };
    },

    async markClaimed(card, lead) {
      try {
        await api.editMessageText(card.chatId, card.messageId, renderClaimedCard(lead, tz), {
          parse_mode: "HTML",
          reply_markup: claimedKeyboard(lead.claim?.managerName ?? "менеджер"),
          link_preview_options: noPreview,
        });
      } catch (err) {
        // «message is not modified» при повторной правке — не ошибка
        if (!/not modified/i.test(err instanceof Error ? err.message : String(err))) throw err;
      }
    },

    async sendDm(userId, html) {
      try {
        await api.sendMessage(userId, html, { parse_mode: "HTML", link_preview_options: noPreview });
        return true;
      } catch (err) {
        log.warn("не удалось отправить личное сообщение менеджеру", { userId, message: err instanceof Error ? err.message : String(err) });
        return false;
      }
    },

    async sendGroupHtml(html, replyToMessageId) {
      await api.sendMessage(managersChatId, html, {
        parse_mode: "HTML",
        link_preview_options: noPreview,
        ...(replyToMessageId ? { reply_parameters: { message_id: replyToMessageId, allow_sending_without_reply: true } } : {}),
      });
    },

    async sendTo(chatId, html) {
      await api.sendMessage(chatId, html, { parse_mode: "HTML", link_preview_options: noPreview });
    },
  };
}

export { InlineKeyboard };
