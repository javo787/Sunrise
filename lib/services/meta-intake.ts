import { normalizePhone } from "@/lib/domain/phone";
import { claimEvent, deleteFailure, listRecentFailures, recordFailure, releaseEvent } from "@/lib/db/events";
import type { IntakeResult, NewLeadInput } from "@/lib/db/leads";
import { fetchLeadgen, mapLeadFields, parseMetaPayload, type MetaLead } from "@/lib/integrations/meta";
import { createLogger } from "@/lib/logger";
import type { Batcher } from "./batcher";
import type { InboundMessage } from "./sales-bot";

const log = createLogger("meta-intake");

export const META_LEADGEN_FAILURE = "meta_leadgen";

export interface MetaIntakeDeps {
  registerLead: (input: NewLeadInput) => Promise<IntakeResult>;
  batcher: Pick<Batcher<InboundMessage>, "push">;
  fetchLead?: (leadgenId: string) => Promise<MetaLead>;
}

export type LeadgenOutcome = "created" | "duplicate" | "skipped_no_phone" | "failed";

/**
 * Лид-форма Meta → лид. Если Graph API недоступен, событие сохраняется в журнал сбоев и
 * повторяется cron-задачей: лид из рекламы — самое дорогое, что можно потерять.
 */
export async function processLeadgen(leadgenId: string, deps: MetaIntakeDeps, opts: { isRetry?: boolean } = {}): Promise<LeadgenOutcome> {
  const key = `meta:lead:${leadgenId}`;
  if (!(await claimEvent(key))) return "duplicate";

  try {
    const lead = await (deps.fetchLead ?? fetchLeadgen)(leadgenId);
    const mapped = mapLeadFields(lead);
    const phone = normalizePhone(mapped.phone);
    if (!phone) {
      log.warn("в анкете нет корректного телефона — лид пропущен", { leadgenId, rawPhone: mapped.phone });
      await recordFailure("meta_lead_no_phone", { leadgenId, name: mapped.name, rawPhone: mapped.phone, notes: mapped.notes }, "нет корректного телефона");
      return "skipped_no_phone";
    }
    const res = await deps.registerLead({
      name: mapped.name,
      phone,
      source: mapped.source,
      channel: "meta_form",
      summary: mapped.notes ? `Анкета: ${mapped.notes}` : undefined,
      externalId: leadgenId,
    });
    return res.kind;
  } catch (err) {
    await releaseEvent(key).catch(() => undefined);
    // при повторе исходная запись сбоя остаётся как есть — окно в 24 часа считается от первого сбоя
    if (!opts.isRetry) await recordFailure(META_LEADGEN_FAILURE, { leadgenId }, err);
    log.error("не удалось обработать лид-форму — будет повтор", { leadgenId, message: err instanceof Error ? err.message : String(err) });
    return "failed";
  }
}

export async function processMetaPayload(body: unknown, deps: MetaIntakeDeps): Promise<{ leadgens: number; messages: number; duplicates: number }> {
  const parsed = parseMetaPayload(body);
  const stats = { leadgens: 0, messages: 0, duplicates: 0 };

  for (const ev of parsed.leadgens) {
    const outcome = await processLeadgen(ev.leadgenId, deps);
    if (outcome === "duplicate") stats.duplicates++;
    else stats.leadgens++;
  }

  for (const m of parsed.messages) {
    if (m.isEcho || !m.text?.trim()) continue; // свои ответы и вложения без текста
    if (!(await claimEvent(`meta:msg:${m.mid}`))) {
      stats.duplicates++;
      continue;
    }
    deps.batcher.push(`instagram:${m.senderId}`, { channel: "instagram", contactId: m.senderId, replyTo: m.senderId, text: m.text });
    stats.messages++;
  }
  return stats;
}

/** Cron: повтор лид-форм, которые не удалось получить из Graph API (за последние 24 часа). */
export async function retryFailedLeadgens(deps: MetaIntakeDeps, now: Date = new Date()): Promise<{ retried: number; recovered: number }> {
  const failures = await listRecentFailures(META_LEADGEN_FAILURE, new Date(now.getTime() - 24 * 3_600_000));
  let recovered = 0;
  for (const f of failures) {
    const leadgenId = (f.payload as { leadgenId?: string } | null)?.leadgenId;
    if (!leadgenId) {
      await deleteFailure(f._id);
      continue;
    }
    const outcome = await processLeadgen(leadgenId, deps, { isRetry: true });
    if (outcome !== "failed") {
      recovered++;
      await deleteFailure(f._id);
    }
  }
  return { retried: failures.length, recovered };
}
