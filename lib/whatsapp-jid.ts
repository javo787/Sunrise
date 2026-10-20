// Разбор идентификатора собеседника из вебхука Evolution API.
//
// Раньше номер брался как "всё до @" из remoteJid. Это ломается, когда
// WhatsApp присылает вместо номера скрытый идентификатор "<цифры>@lid"
// (для WhatsApp Business это происходит почти всегда — см. issue #1872 в
// репозитории Evolution API): 15 цифр LID принимались за телефон, заводился
// "лид" с несуществующим номером, а ответ пациенту падал с 400
// "exists: false" — то есть бот молча переставал отвечать.
//
// Настоящий номер в таких случаях приходит в соседнем поле
// key.remoteJidAlt (форк Baileys у Evolution) или senderPn.

export type JidResolution =
  // Настоящий номер телефона (только цифры) — заводим/находим лид по нему.
  | { kind: "phone"; phone: string }
  // Скрытый идентификатор без номера: "<цифры>@lid". Номера нет, но в
  // некоторых версиях Evolution на такой JID всё же можно писать — поэтому
  // сохраняем его целиком и пробуем ответить; если не выйдет, сработает
  // общая защита от недоставленных ответов (пауза ИИ + пометка).
  | { kind: "lid"; replyTo: string }
  // Не личная переписка с пациентом (группа, рассылка, статус) — пропускаем.
  | { kind: "ignore"; reason: "group" | "broadcast" | "unknown" };

export interface JidSources {
  remoteJid?: string;
  remoteJidAlt?: string;
  senderPn?: string;
}

const PHONE_SUFFIXES = ["@s.whatsapp.net", "@c.us"];

// "992931234567@s.whatsapp.net" -> "992931234567"
// "992931234567:12@s.whatsapp.net" (JID устройства) -> "992931234567"
// "103899771998284@lid" -> null (это не номер)
function phoneFromJid(jid: string | undefined): string | null {
  if (!jid) return null;
  const at = jid.indexOf("@");
  if (at < 0) return null;
  if (!PHONE_SUFFIXES.includes(jid.slice(at))) return null;
  const id = jid.slice(0, at).split(":")[0];
  return /^\d{5,20}$/.test(id) ? id : null;
}

export function resolveWhatsAppJid(src: JidSources): JidResolution {
  const remote = src.remoteJid ?? "";

  if (remote.endsWith("@g.us")) return { kind: "ignore", reason: "group" };
  if (remote.endsWith("@broadcast") || remote.endsWith("@newsletter")) {
    return { kind: "ignore", reason: "broadcast" };
  }

  // Альтернативные поля первыми: когда remoteJid — LID, номер лежит именно в них.
  const phone = phoneFromJid(src.remoteJidAlt) ?? phoneFromJid(src.senderPn) ?? phoneFromJid(remote);
  if (phone) return { kind: "phone", phone };

  if (remote.endsWith("@lid")) {
    const id = remote.slice(0, -"@lid".length).split(":")[0];
    if (/^\d+$/.test(id)) return { kind: "lid", replyTo: `${id}@lid` };
  }

  return { kind: "ignore", reason: "unknown" };
}
