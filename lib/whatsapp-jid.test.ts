import { resolveWhatsAppJid } from "./whatsapp-jid";

describe("resolveWhatsAppJid", () => {
  it("обычный номер: берёт цифры до @", () => {
    expect(resolveWhatsAppJid({ remoteJid: "992931234567@s.whatsapp.net" })).toEqual({
      kind: "phone",
      phone: "992931234567",
    });
  });

  it("старый формат @c.us тоже считается номером", () => {
    expect(resolveWhatsAppJid({ remoteJid: "992931234567@c.us" })).toEqual({
      kind: "phone",
      phone: "992931234567",
    });
  });

  it("JID устройства с :NN — суффикс устройства отбрасывается", () => {
    expect(resolveWhatsAppJid({ remoteJid: "992931234567:12@s.whatsapp.net" })).toEqual({
      kind: "phone",
      phone: "992931234567",
    });
  });

  it("@lid + remoteJidAlt: настоящий номер берётся из Alt, а не 15 цифр LID", () => {
    expect(
      resolveWhatsAppJid({
        remoteJid: "103899771998284@lid",
        remoteJidAlt: "992931234567@s.whatsapp.net",
      })
    ).toEqual({ kind: "phone", phone: "992931234567" });
  });

  it("@lid + senderPn: номер берётся из senderPn", () => {
    expect(
      resolveWhatsAppJid({
        remoteJid: "103899771998284@lid",
        senderPn: "992931234567@s.whatsapp.net",
      })
    ).toEqual({ kind: "phone", phone: "992931234567" });
  });

  it("@lid без номера: НЕ выдаёт LID за телефон, возвращает kind=lid с полным JID", () => {
    expect(resolveWhatsAppJid({ remoteJid: "103899771998284@lid" })).toEqual({
      kind: "lid",
      replyTo: "103899771998284@lid",
    });
  });

  it("обычный номер + Alt=LID: остаётся номер из remoteJid", () => {
    expect(
      resolveWhatsAppJid({
        remoteJid: "992931234567@s.whatsapp.net",
        remoteJidAlt: "103899771998284@lid",
      })
    ).toEqual({ kind: "phone", phone: "992931234567" });
  });

  it("группа пропускается", () => {
    expect(resolveWhatsAppJid({ remoteJid: "120363025246125486@g.us" })).toEqual({
      kind: "ignore",
      reason: "group",
    });
  });

  it("статусы и рассылки пропускаются", () => {
    expect(resolveWhatsAppJid({ remoteJid: "status@broadcast" })).toEqual({
      kind: "ignore",
      reason: "broadcast",
    });
  });

  it("пустой или мусорный JID пропускается, а не превращается в 'номер'", () => {
    expect(resolveWhatsAppJid({})).toEqual({ kind: "ignore", reason: "unknown" });
    expect(resolveWhatsAppJid({ remoteJid: "abc@s.whatsapp.net" })).toEqual({
      kind: "ignore",
      reason: "unknown",
    });
    expect(resolveWhatsAppJid({ remoteJid: "12345" })).toEqual({
      kind: "ignore",
      reason: "unknown",
    });
  });
});
