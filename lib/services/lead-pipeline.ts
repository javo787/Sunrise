import type { Lead } from "@/lib/db/collections";
import {
  claimLead,
  clearEscalated,
  createLeadIfNew,
  findStaleForEscalation,
  listUnpublished,
  lockForPublish,
  markEscalated,
  markPublished,
  releasePublishLock,
  type IntakeResult,
  type NewLeadInput,
} from "@/lib/db/leads";
import { getActiveManager, listActiveManagers } from "@/lib/db/managers";
import { createLogger } from "@/lib/logger";
import { formatPhone } from "@/lib/domain/phone";
import { esc, renderContactDm, renderEscalation, renderRepeatContact, type Mention } from "@/lib/telegram/cards";
import type { TelegramGateway } from "@/lib/telegram/gateway";

const log = createLogger("pipeline");

export interface PipelineDeps {
  gateway: TelegramGateway;
  /** Запись закреплённого лида в Google Sheets (не должна бросать исключений наружу) */
  syncSheet: (lead: Lead) => Promise<unknown>;
  adminIds: number[];
  escalationMinutes: number;
}

// ---------------------------------------------------------------- публикация в группу

/** Отправляет карточку в группу менеджеров. При сбое Telegram лид остаётся неопубликованным — подхватит cron. */
export async function publishLead(gateway: TelegramGateway, lead: Lead): Promise<boolean> {
  const locked = await lockForPublish(lead._id);
  if (!locked) return false; // уже опубликован, закреплён или публикуется другим воркером
  try {
    const card = await gateway.sendCard(locked);
    await markPublished(locked._id, card);
    return true;
  } catch (err) {
    log.error("не удалось отправить карточку лида в группу — повторит cron", { leadId: locked._id.toHexString(), message: err instanceof Error ? err.message : String(err) });
    await releasePublishLock(locked._id).catch(() => undefined);
    return false;
  }
}

export async function publishPendingLeads(gateway: TelegramGateway): Promise<number> {
  let published = 0;
  for (const lead of await listUnpublished()) {
    if (await publishLead(gateway, lead)) published++;
  }
  return published;
}

// ---------------------------------------------------------------- приём лида

/**
 * Единая точка входа для всех источников. Дубликат (тот же телефон) нового лида не создаёт:
 * если клиента уже ведёт менеджер, ему приходит уведомление о повторном обращении.
 */
export async function registerLead(deps: PipelineDeps, input: NewLeadInput): Promise<IntakeResult> {
  const result = await createLeadIfNew(input);

  if (result.kind === "created") {
    if (result.lead.status === "claimed") void deps.syncSheet(result.lead);
    else await publishLead(deps.gateway, result.lead);
    return result;
  }

  const claim = result.lead.claim;
  if (claim) await deps.gateway.sendDm(claim.managerId, renderRepeatContact(result.lead)).catch(() => false);
  return result;
}

// ---------------------------------------------------------------- Shark Tank

export type ClaimOutcome =
  | { kind: "won"; lead: Lead; dmDelivered: boolean; sheetSync: Promise<void> }
  | { kind: "lost"; winnerName?: string }
  | { kind: "not_manager" }
  | { kind: "missing" };

export async function handleClaim(deps: PipelineDeps, leadId: string, from: { id: number }): Promise<ClaimOutcome> {
  const manager = await getActiveManager(from.id);
  if (!manager) return { kind: "not_manager" };

  const res = await claimLead(leadId, { telegramId: manager.telegramId, name: manager.name, sheetName: manager.sheetName });
  if (!res.ok) return res.reason === "missing" ? { kind: "missing" } : { kind: "lost", winnerName: res.lead.claim?.managerName };

  const lead = res.lead;
  // Контакт победителю и смена карточки в группе — параллельно; сбой одного не мешает другому.
  const [dm, edit] = await Promise.allSettled([
    deps.gateway.sendDm(manager.telegramId, renderContactDm(lead)),
    lead.card ? deps.gateway.markClaimed(lead.card, lead) : Promise.resolve(),
  ]);
  if (edit.status === "rejected") log.error("не удалось обновить карточку в группе", { leadId, message: String(edit.reason) });

  // Запись в таблицу не задерживает ответ на клик; сбои обрабатывает sheet-sync и cron-повтор.
  const sheetSync = Promise.resolve(deps.syncSheet(lead)).then(
    () => undefined,
    (err) => log.error("syncSheet завершился ошибкой", { leadId, message: String(err) })
  );

  return { kind: "won", lead, dmDelivered: dm.status === "fulfilled" && dm.value, sheetSync };
}

/** Краткий контакт для всплывающего окна, если личное сообщение доставить не удалось. */
export function fallbackContactAlert(lead: Lead): string {
  return `✅ Лид ваш!\n${lead.name.slice(0, 40)}: ${formatPhone(lead.phone)}\nНажмите /start у бота в личке — иначе контакты не придут.`;
}

// ---------------------------------------------------------------- эскалация

export async function resolveEscalationMentions(adminIds: number[]): Promise<Mention[]> {
  const managers = await listActiveManagers();
  const mentions: Mention[] = managers.map((m) => ({ id: m.telegramId, name: m.name }));
  for (const id of adminIds) if (!mentions.some((m) => m.id === id)) mentions.push({ id, name: "Руководитель" });
  return mentions;
}

/** Cron: карточки без владельца старше N минут — тегаем менеджеров и руководителя (один раз на лид). */
export async function escalateStaleLeads(deps: PipelineDeps, now: Date = new Date()): Promise<number> {
  const cutoff = new Date(now.getTime() - deps.escalationMinutes * 60_000);
  const stale = await findStaleForEscalation(cutoff);
  if (stale.length === 0) return 0;

  const mentions = await resolveEscalationMentions(deps.adminIds);
  let sent = 0;
  for (const lead of stale) {
    const marked = await markEscalated(lead._id, now); // атомарно: второй воркер получит null
    if (!marked) continue;
    const minutes = Math.max(deps.escalationMinutes, Math.round((now.getTime() - (marked.publishedAt ?? now).getTime()) / 60_000));
    try {
      await deps.gateway.sendGroupHtml(renderEscalation(marked, minutes, mentions), marked.card?.messageId);
      sent++;
    } catch (err) {
      await clearEscalated(lead._id).catch(() => undefined);
      log.error("не удалось отправить эскалацию — повторит cron", { leadId: lead._id.toHexString(), message: err instanceof Error ? err.message : String(err) });
    }
  }
  return sent;
}

export { esc };
