import { Bot, InlineKeyboard, Keyboard, type Context } from "grammy";
import { MANUAL_SOURCES, type LeadSource } from "@/lib/domain/catalog";
import { normalizePhone } from "@/lib/domain/phone";
import { claimEvent } from "@/lib/db/events";
import { clearFlow, getFlow, setFlow } from "@/lib/db/flows";
import { deactivateManager, getActiveManager, listActiveManagers, upsertManager } from "@/lib/db/managers";
import { createLogger } from "@/lib/logger";
import { fallbackContactAlert, handleClaim, registerLead, type PipelineDeps } from "@/lib/services/lead-pipeline";
import type { ReportKind } from "@/lib/services/reports";
import { CLAIM_PREFIX, esc, NOOP_DATA } from "./cards";

const log = createLogger("telegram-bot");

export const ADD_CLIENT_BUTTON = "➕ Добавить клиента";
const mainKeyboard = new Keyboard().text(ADD_CLIENT_BUTTON).resized().persistent();

export interface BotDeps {
  pipeline: PipelineDeps;
  manualAssign: "self" | "pool";
  /** Разовая отправка отчёта по команде руководителя */
  sendReportTo: (kind: ReportKind, chatId: number) => Promise<void>;
}

const cancelKeyboard = () => new InlineKeyboard().text("✖️ Отмена", "flow:cancel");

export function registerHandlers(bot: Bot, deps: BotDeps): void {
  const { adminIds } = deps.pipeline;
  const isAdmin = (ctx: Context) => Boolean(ctx.from && adminIds.includes(ctx.from.id));
  const isPrivate = (ctx: Context) => ctx.chat?.type === "private";

  // Telegram повторяет доставку при таймауте — каждое обновление обрабатываем один раз.
  bot.use(async (ctx, next) => {
    if (!(await claimEvent(`tg:${ctx.update.update_id}`))) return;
    await next();
  });

  // ------------------------------------------------------------ служебные команды

  bot.command("start", async (ctx) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    const manager = await getActiveManager(ctx.from.id);
    if (manager) {
      await ctx.reply(
        `Здравствуйте, ${manager.name}! Вы подключены к листу «${manager.sheetName}».\nКнопка внизу — ручной ввод клиента (звонок, Somon.tj, баннер, визит в офис).`,
        { reply_markup: mainKeyboard }
      );
    } else {
      await ctx.reply(`Ваш Telegram ID: ${ctx.from.id}\nПередайте его руководителю — он подключит вас к команде.`);
    }
    if (isAdmin(ctx)) {
      await ctx.reply("Команды руководителя:\n/managers — список\n/addmanager <id> <Менеджер N> <имя>\n/removemanager <id>\n/report day|month — отчёт сейчас");
    }
  });

  bot.command("whoami", async (ctx) => {
    if (ctx.from) await ctx.reply(`Ваш Telegram ID: ${ctx.from.id}\nID этого чата: ${ctx.chat.id}`);
  });

  bot.command("managers", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const list = await listActiveManagers();
    await ctx.reply(list.length ? list.map((m) => `${m.sheetName}: ${m.name} (id ${m.telegramId})`).join("\n") : "Менеджеры не подключены. Используйте /addmanager.");
  });

  bot.command("addmanager", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const m = String(ctx.match).trim().match(/^(\d{5,15})\s+менеджер\s*([1-9])\s+(.{2,60})$/iu);
    if (!m) {
      await ctx.reply("Формат: /addmanager <telegram id> <Менеджер N> <имя>\nНапример: /addmanager 123456789 Менеджер 1 Алиса Каримова");
      return;
    }
    try {
      await upsertManager({ telegramId: Number(m[1]), name: m[3].trim(), sheetName: `Менеджер ${m[2]}` as never });
      await ctx.reply(`✅ Подключён: ${m[3].trim()} → лист «Менеджер ${m[2]}».\nПопросите менеджера нажать /start у бота в личке — иначе контакты лидов не придут.`);
    } catch (err) {
      await ctx.reply(`Не удалось: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  bot.command("removemanager", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const id = Number(String(ctx.match).trim());
    if (!Number.isInteger(id)) return void (await ctx.reply("Формат: /removemanager <telegram id>"));
    await ctx.reply((await deactivateManager(id)) ? "Менеджер отключён." : "Активный менеджер с таким ID не найден.");
  });

  bot.command("report", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const arg = String(ctx.match).trim().toLowerCase();
    const kind: ReportKind = arg === "month" || arg === "месяц" ? "monthly" : "daily";
    try {
      await deps.sendReportTo(kind, ctx.chat.id);
    } catch (err) {
      await ctx.reply(`Не удалось собрать отчёт: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // ------------------------------------------------------------ Shark Tank

  bot.callbackQuery(new RegExp(`^${CLAIM_PREFIX}(.+)$`), async (ctx) => {
    const outcome = await handleClaim(deps.pipeline, ctx.match[1], { id: ctx.from.id });
    switch (outcome.kind) {
      case "won":
        await ctx.answerCallbackQuery(
          outcome.dmDelivered
            ? { text: "✅ Лид ваш! Контакт отправил вам в личные сообщения." }
            : { text: fallbackContactAlert(outcome.lead), show_alert: true }
        );
        break;
      case "lost":
        await ctx.answerCallbackQuery({ text: outcome.winnerName ? `Уже забрал: ${outcome.winnerName}` : "Лид уже забрали", show_alert: true });
        break;
      case "not_manager":
        await ctx.answerCallbackQuery({ text: "Вы не подключены как менеджер. Обратитесь к руководителю.", show_alert: true });
        break;
      default:
        await ctx.answerCallbackQuery({ text: "Лид не найден", show_alert: true });
    }
  });

  bot.callbackQuery(NOOP_DATA, (ctx) => ctx.answerCallbackQuery({ text: "Этот лид уже закреплён за менеджером." }));

  // ------------------------------------------------------------ ручной ввод клиента

  const startFlow = async (ctx: Context) => {
    if (!isPrivate(ctx) || !ctx.from) return;
    const manager = await getActiveManager(ctx.from.id);
    if (!manager) return void (await ctx.reply("Сначала руководитель должен подключить вас как менеджера. Ваш ID: " + ctx.from.id));
    await setFlow(ctx.from.id, "name", {});
    await ctx.reply("Как зовут клиента?", { reply_markup: cancelKeyboard() });
  };
  bot.hears(ADD_CLIENT_BUTTON, startFlow);

  bot.command("cancel", async (ctx) => {
    if (!ctx.from) return;
    await clearFlow(ctx.from.id);
    await ctx.reply("Отменено.", { reply_markup: mainKeyboard });
  });

  bot.callbackQuery("flow:cancel", async (ctx) => {
    await clearFlow(ctx.from.id);
    await ctx.answerCallbackQuery();
    await ctx.reply("Отменено.", { reply_markup: mainKeyboard });
  });

  bot.callbackQuery(/^flow:src:(\d+)$/, async (ctx) => {
    const flow = await getFlow(ctx.from.id);
    const source = MANUAL_SOURCES[Number(ctx.match[1])];
    if (!flow || flow.step !== "source" || !source) return void (await ctx.answerCallbackQuery({ text: "Сессия устарела — начните заново", show_alert: true }));
    await setFlow(ctx.from.id, "note", { ...flow.data, source });
    await ctx.answerCallbackQuery();
    await ctx.reply(`Источник: ${source}\nКомментарий по клиенту (этаж, бюджет, пожелания) или нажмите «Пропустить».`, {
      reply_markup: new InlineKeyboard().text("Пропустить", "flow:skip").text("✖️ Отмена", "flow:cancel"),
    });
  });

  bot.callbackQuery("flow:skip", async (ctx) => {
    await ctx.answerCallbackQuery();
    await finishFlow(ctx, undefined);
  });

  async function finishFlow(ctx: Context, note: string | undefined) {
    const from = ctx.from;
    if (!from) return;
    const flow = await getFlow(from.id);
    const manager = await getActiveManager(from.id);
    if (!flow || flow.step !== "note" || !flow.data.name || !flow.data.phone || !flow.data.source || !manager) {
      return void (await ctx.reply("Сессия устарела — начните заново кнопкой «➕ Добавить клиента».", { reply_markup: mainKeyboard }));
    }
    await clearFlow(from.id);

    try {
      const self = deps.manualAssign === "self";
      const res = await registerLead(deps.pipeline, {
        name: flow.data.name,
        phone: flow.data.phone,
        source: flow.data.source as LeadSource,
        channel: "manual",
        summary: note?.slice(0, 300),
        claimBy: self ? { telegramId: manager.telegramId, name: manager.name, sheetName: manager.sheetName } : undefined,
      });
      if (res.kind === "duplicate") {
        const owner = res.lead.claim ? `закреплён за ${res.lead.claim.managerName}` : "ждёт менеджера в группе";
        await ctx.reply(`Клиент с этим номером уже в базе (${res.lead.source}), ${owner}. Новую запись не создавал.`, { reply_markup: mainKeyboard });
      } else {
        await ctx.reply(
          self ? `✅ Клиент добавлен и закреплён за вами. Запись попадёт в лист «${manager.sheetName}».` : "✅ Клиент добавлен и отправлен в общую группу.",
          { reply_markup: mainKeyboard }
        );
      }
    } catch (err) {
      log.error("ручной ввод клиента не удался", { message: err instanceof Error ? err.message : String(err) });
      await ctx.reply(`Не удалось добавить клиента: ${err instanceof Error ? err.message : String(err)}`, { reply_markup: mainKeyboard });
    }
  }

  bot.on("message:text", async (ctx, next) => {
    const text = ctx.message.text.trim();
    if (!isPrivate(ctx) || text.startsWith("/")) return next();
    const flow = await getFlow(ctx.from.id);
    if (!flow) return next();

    if (flow.step === "name") {
      if (text.length < 2 || text.length > 80) return void (await ctx.reply("Введите имя клиента (2–80 символов)."));
      await setFlow(ctx.from.id, "phone", { name: text });
      return void (await ctx.reply("Номер телефона клиента? (например, +992 93 123 45 67)", { reply_markup: cancelKeyboard() }));
    }
    if (flow.step === "phone") {
      const phone = normalizePhone(text);
      if (!phone) return void (await ctx.reply("Не похоже на номер телефона. Пример: +992 93 123 45 67"));
      await setFlow(ctx.from.id, "source", { ...flow.data, phone });
      const kb = new InlineKeyboard();
      MANUAL_SOURCES.forEach((s, i) => kb.text(s, `flow:src:${i}`).row());
      kb.text("✖️ Отмена", "flow:cancel");
      return void (await ctx.reply("Откуда клиент?", { reply_markup: kb }));
    }
    if (flow.step === "note") return finishFlow(ctx, text);
    return next();
  });

  bot.catch((err) => {
    log.error("ошибка обработчика Telegram", { updateId: err.ctx.update.update_id, message: err.error instanceof Error ? err.error.message : String(err.error) });
  });
}

export { esc };
