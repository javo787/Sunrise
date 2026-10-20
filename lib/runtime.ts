import { Bot } from "grammy";
import { coreConfig, isConfigured, mailConfig, sheetsConfig, telegramConfig } from "@/lib/config";
import { claimEvent } from "@/lib/db/events";
import { fetchMediaBase64 } from "@/lib/evolution";
import { getLlmClient } from "@/lib/integrations/llm";
import { sendReportMail } from "@/lib/integrations/mail";
import { createLogger } from "@/lib/logger";
import { Batcher } from "@/lib/services/batcher";
import { sendViaChannel } from "@/lib/services/channels";
import { registerLead, type PipelineDeps } from "@/lib/services/lead-pipeline";
import { sendReport, type ReportDeps, type ReportKind } from "@/lib/services/reports";
import { handleInboundBatch, type InboundMessage, type SalesBotDeps } from "@/lib/services/sales-bot";
import { syncLeadToSheet } from "@/lib/services/sheet-sync";
import { registerHandlers } from "@/lib/telegram/bot";
import { createTelegramGateway } from "@/lib/telegram/gateway";
import type { MetaIntakeDeps } from "@/lib/services/meta-intake";
import type { WhatsAppIntakeDeps } from "@/lib/services/whatsapp-intake";

// Сборка зависимостей для боевого режима (ленивая, один раз на процесс). Здесь же единственное
// место, где модули соединяются с настоящими Telegram, Google, Meta и ИИ.

const log = createLogger("runtime");

interface Runtime {
  bot: Bot;
  pipeline: PipelineDeps;
}

let runtime: Runtime | undefined;
let batcher: Batcher<InboundMessage> | undefined;

function init(): Runtime {
  if (runtime) return runtime;
  const tg = telegramConfig();
  const core = coreConfig();

  const bot = new Bot(tg.TELEGRAM_BOT_TOKEN);
  const gateway = createTelegramGateway(bot.api, tg.TELEGRAM_MANAGERS_CHAT_ID, core.TIMEZONE);
  const pipeline: PipelineDeps = {
    gateway,
    adminIds: tg.TELEGRAM_ADMIN_IDS,
    escalationMinutes: core.ESCALATION_MINUTES,
    syncSheet: async (lead) => {
      if (!isConfigured(sheetsConfig)) {
        log.warn("Google Sheets не настроен — запись в таблицу отложена");
        return;
      }
      return syncLeadToSheet(lead);
    },
  };

  registerHandlers(bot, {
    pipeline,
    manualAssign: core.MANUAL_LEADS_ASSIGN,
    sendReportTo: async (kind, chatId) => {
      await sendReport(kind, new Date(), getReportDeps({ chatId, email: false }), { force: true });
    },
  });

  runtime = { bot, pipeline };
  return runtime;
}

export const getBot = (): Bot => init().bot;
export const getPipelineDeps = (): PipelineDeps => init().pipeline;

export function getReportDeps(opts: { chatId?: number; email?: boolean } = {}): ReportDeps {
  const tg = telegramConfig();
  const target = opts.chatId ?? tg.TELEGRAM_REPORT_CHAT_ID ?? tg.TELEGRAM_MANAGERS_CHAT_ID;
  const gateway = getPipelineDeps().gateway;
  return {
    tz: coreConfig().TIMEZONE,
    sendTelegram: (html) => gateway.sendTo(target, html),
    sendEmail: opts.email !== false && isConfigured(mailConfig) ? sendReportMail : undefined,
  };
}

function salesBotDeps(): SalesBotDeps {
  return {
    llm: getLlmClient(),
    sendBubbles: sendViaChannel,
    registerLead: (input) => registerLead(getPipelineDeps(), input),
    maxUserTurns: coreConfig().AI_MAX_USER_TURNS,
  };
}

export function getInboundBatcher(): Batcher<InboundMessage> {
  if (!batcher) {
    batcher = new Batcher<InboundMessage>({
      debounceMs: coreConfig().BATCH_DEBOUNCE_MS,
      onFlush: async (_key, items) => {
        await handleInboundBatch(salesBotDeps(), items);
      },
      onError: (key, err) => log.error("обработка пачки сообщений клиента завершилась ошибкой", { key, message: err instanceof Error ? err.message : String(err) }),
    });
  }
  return batcher;
}

export function getWhatsAppIntakeDeps(): WhatsAppIntakeDeps {
  return {
    batcher: getInboundBatcher(),
    claimEvent: (key) => claimEvent(key),
    supportsAudio: getLlmClient().supportsAudio,
    fetchAudio: (key) => fetchMediaBase64(key),
  };
}

export function getMetaIntakeDeps(): MetaIntakeDeps {
  return {
    batcher: getInboundBatcher(),
    registerLead: (input) => registerLead(getPipelineDeps(), input),
  };
}

export type { ReportKind };
