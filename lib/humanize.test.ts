import {
  capBubbles,
  containsArabicScript,
  dropDuplicateBubbles,
  interBubblePauseMs,
  isNearDuplicate,
  limitExclamations,
  MAX_BUBBLES,
  parseModelReply,
  readDelayMs,
  sanitizeBubble,
  similarity,
  splitIntoBubbles,
  splitLongBubbles,
  typingDelayMs,
} from "./humanize";

describe("parseModelReply", () => {
  it("разбирает структурированный ответ на пузыри и handoff", () => {
    const raw = JSON.stringify({
      language: "tg",
      messages: ["Ҳуҷҷатҳоро дидам, ташаккур.", "Ҳозир ба духтурон мефиристам."],
      handoff: true,
    });
    expect(parseModelReply(raw)).toEqual({
      language: "tg",
      messages: ["Ҳуҷҷатҳоро дидам, ташаккур.", "Ҳозир ба духтурон мефиристам."],
      handoff: true,
      structured: true,
    });
  });

  it("переживает ```json-обёртку", () => {
    const raw = '```json\n{"language":"ru","messages":["Здравствуйте!"],"handoff":false}\n```';
    const r = parseModelReply(raw);
    expect(r.structured).toBe(true);
    expect(r.messages).toEqual(["Здравствуйте!"]);
  });

  it("выкидывает пустые и нестроковые элементы, не падает на мусоре", () => {
    const raw = JSON.stringify({ language: "klingon", messages: ["  ", 5, null, "Ок"], handoff: "yes" });
    const r = parseModelReply(raw);
    expect(r.messages).toEqual(["Ок"]);
    expect(r.language).toBeUndefined();
    expect(r.handoff).toBe(false);
  });

  it("не-JSON откатывается на разбивку обычного текста", () => {
    const r = parseModelReply("Первая мысль.\nВторая мысль, подлиннее, чтобы не склеилась с первой строкой.");
    expect(r.structured).toBe(false);
    expect(r.handoff).toBe(false);
    expect(r.messages.length).toBeGreaterThanOrEqual(1);
  });

  it("пустой JSON даёт пустой список сообщений, а не выдуманный текст", () => {
    expect(parseModelReply('{"language":"ru","messages":[],"handoff":true}').messages).toEqual([]);
    expect(parseModelReply("").messages).toEqual([]);
  });

  it("ограничивает число пузырей, не теряя хвост", () => {
    const messages = ["a", "b", "c", "d", "e", "f"];
    const r = parseModelReply(JSON.stringify({ language: "ru", messages, handoff: false }));
    expect(r.messages).toHaveLength(MAX_BUBBLES);
    expect(r.messages[MAX_BUBBLES - 1]).toBe("d\ne\nf");
  });
});

describe("sanitizeBubble", () => {
  it("превращает markdown в WhatsApp-форматирование и убирает списки", () => {
    expect(sanitizeBubble("**Важно**: пришлите МРТ")).toBe("*Важно*: пришлите МРТ");
    expect(sanitizeBubble("# Заголовок\nТекст")).toBe("Заголовок\nТекст");
    expect(sanitizeBubble("- МРТ\n- анализы\n1. выписка")).toBe("МРТ\nанализы\nвыписка");
  });

  it("не трогает обычное WhatsApp-выделение и цифры внутри текста", () => {
    expect(sanitizeBubble("*срочно* нужен МРТ за 2024 год")).toBe("*срочно* нужен МРТ за 2024 год");
  });
});

describe("splitIntoBubbles / capBubbles", () => {
  it("склеивает совсем короткие соседние строки", () => {
    expect(splitIntoBubbles("Да.\nХорошо.")).toEqual(["Да.\nХорошо."]);
  });

  it("не режет на пузыри больше лимита", () => {
    const text = Array.from({ length: 10 }, (_, i) => `Достаточно длинная отдельная мысль номер ${i} — для пузыря.`).join("\n");
    expect(splitIntoBubbles(text).length).toBeLessThanOrEqual(MAX_BUBBLES);
    expect(capBubbles(["1", "2"])).toEqual(["1", "2"]);
  });
});

describe("дубли", () => {
  const prev = "Спасибо, документы получил. Переведу их и передам индийским врачам — как только будет ответ, сразу напишу вам.";

  it("точный повтор и повтор с другой пунктуацией — дубль", () => {
    expect(isNearDuplicate(prev, [prev])).toBe(true);
    expect(isNearDuplicate(prev.replace(/[.,—]/g, "").toUpperCase(), [prev])).toBe(true);
  });

  it("лёгкая перестановка слов — всё ещё дубль", () => {
    const variant = "Документы получил, спасибо. Переведу их и передам врачам в Индии — как только будет ответ, сразу напишу вам.";
    expect(isNearDuplicate(variant, [prev])).toBe(true);
  });

  it("другая мысль — не дубль", () => {
    expect(isNearDuplicate("Подскажите, проводилось ли уже какое-то лечение по этому диагнозу?", [prev])).toBe(false);
  });

  it("короткие реплики вроде «Рахмат!» дублем не считаются", () => {
    expect(isNearDuplicate("Раҳмат!", ["Раҳмат!"])).toBe(true); // равны целиком
    expect(isNearDuplicate("Раҳмат, ҳозир менависам", ["Раҳмат!"])).toBe(false);
  });

  it("dropDuplicateBubbles выкидывает повтор прошлого и повтор внутри ответа", () => {
    const { kept, dropped } = dropDuplicateBubbles(
      ["Какой у вас диагноз по заключению врача?", prev, "Какой у вас диагноз по заключению врача?"],
      [prev]
    );
    expect(kept).toEqual(["Какой у вас диагноз по заключению врача?"]);
    expect(dropped).toHaveLength(2);
  });

  it("similarity: 1 для одинаковых, ~0 для разных, симметрична", () => {
    expect(similarity("Привет, как дела", "привет как дела")).toBe(1);
    expect(similarity("abc def", "xyz uvw")).toBeLessThan(0.2);
    expect(similarity(prev, "Какой диагноз?")).toBeCloseTo(similarity("Какой диагноз?", prev), 10);
  });
});

describe("typingDelayMs", () => {
  it("растёт с длиной и укладывается в границы", () => {
    const mid = () => 0.5; // jitter = 1.0
    expect(typingDelayMs("Да", mid)).toBe(900);
    expect(typingDelayMs("x".repeat(100), mid)).toBe(4100);
    expect(typingDelayMs("x".repeat(1000), () => 1)).toBe(7000);
    expect(typingDelayMs("x".repeat(100), mid)).toBeGreaterThan(typingDelayMs("x".repeat(40), mid));
  });

  it("добавляет разброс ±20%", () => {
    const base = 600 + 100 * 35;
    expect(typingDelayMs("x".repeat(100), () => 0)).toBe(Math.round(base * 0.8));
    expect(typingDelayMs("x".repeat(100), () => 1)).toBe(Math.round(base * 1.2));
  });
});

describe("interBubblePauseMs", () => {
  it("шлюз ответил сразу (delay проигнорирован) — досыпаем время набора + пауза на «прочтение»", () => {
    expect(interBubblePauseMs(3000, 30, () => 0)).toBe(3000 - 30 + 700);
    expect(interBubblePauseMs(3000, 30, () => 1)).toBe(3000 - 30 + 1800);
  });

  it("шлюз сам честно ждал время набора — остаётся только короткая пауза", () => {
    expect(interBubblePauseMs(3000, 3000, () => 0)).toBe(700);
    expect(interBubblePauseMs(3000, 3400, () => 1)).toBe(1800);
  });

  it("никогда не отрицательная и не короче минимальной паузы", () => {
    expect(interBubblePauseMs(0, 0, () => 0)).toBe(700);
    expect(interBubblePauseMs(900, -500, () => 0)).toBe(900 + 700);
    for (let i = 0; i < 50; i++) {
      expect(interBubblePauseMs(2000, 5000)).toBeGreaterThanOrEqual(700);
    }
  });
});

describe("containsArabicScript", () => {
  it("находит арабскую и персидскую графику, в том числе внутри смешанного текста", () => {
    expect(containsArabicScript("سلام")).toBe(true);
    expect(containsArabicScript("ممنون، مدارک را دیدم")).toBe(true);
    expect(containsArabicScript("Салом, ташаккур سلام")).toBe(true);
    expect(containsArabicScript("ﷲ")).toBe(true); // лигатура из Presentation Forms-A
    expect(containsArabicScript("ﺍ")).toBe(true); // Presentation Forms-B
  });

  it("не трогает кириллицу (в том числе таджикскую), латиницу, цифры и эмодзи", () => {
    expect(containsArabicScript("Ҳуҷҷатҳоро дидам, ташаккур, ғамхорӣ ва қуввату ӯ")).toBe(false);
    expect(containsArabicScript("Rahmat, hujjatlarni oldim")).toBe(false);
    expect(containsArabicScript("Здравствуйте! МРТ за 2024 год 🙏")).toBe(false);
    expect(containsArabicScript("")).toBe(false);
  });
});

describe("readDelayMs", () => {
  it("лежит в диапазоне 400–1200 мс и растёт с rand", () => {
    expect(readDelayMs(() => 0)).toBe(400);
    expect(readDelayMs(() => 1)).toBe(1200);
    expect(readDelayMs(() => 0.5)).toBe(800);
  });

  it("при любом rand не выходит за границы", () => {
    for (let i = 0; i < 50; i++) {
      const ms = readDelayMs();
      expect(ms).toBeGreaterThanOrEqual(400);
      expect(ms).toBeLessThanOrEqual(1200);
    }
  });
});

describe("splitLongBubbles", () => {
  const s1 = "Документы получил, передал врачам на разбор и оценку вашего случая.";
  const s2 =
    "Обычно ответ клиники приходит в течение двух-трёх рабочих дней после отправки. Это стандартный срок для такого типа обращений.";
  const s3 = "Как только придёт заключение, я сразу напишу вам и объясню, какие шаги дальше.";

  it("не трогает короткие пузыри", () => {
    expect(splitLongBubbles(["Салом.", "Хорошо, жду."])).toEqual(["Салом.", "Хорошо, жду."]);
  });

  it("режет «стену текста» по границам предложений, ничего не теряя", () => {
    const wall = `${s1} ${s2} ${s3}`;
    expect(wall.length).toBeGreaterThan(240);
    const out = splitLongBubbles([wall]);
    expect(out.length).toBe(2);
    expect(out.every((b) => b.length <= 240)).toBe(true);
    expect(out.join(" ")).toBe(wall);
  });

  it("предложение длиннее лимита остаётся целым — посреди фразы не рубим", () => {
    const long = "слово ".repeat(60).trim() + ".";
    expect(splitLongBubbles([long])).toEqual([long]);
  });

  it("не превышает MAX_BUBBLES: когда места нет, пузырь остаётся длинным", () => {
    const wall = `${s1} ${s2} ${s3}`;
    const out = splitLongBubbles([wall, wall, wall, wall]);
    expect(out.length).toBeLessThanOrEqual(MAX_BUBBLES);
    expect(out.join(" ")).toBe([wall, wall, wall, wall].join(" "));
  });

  it("parseModelReply применяет разбивку к структурированному ответу", () => {
    const wall = `${s1} ${s2} ${s3}`;
    const r = parseModelReply(JSON.stringify({ language: "ru", messages: [wall], handoff: false }));
    expect(r.messages.length).toBe(2);
  });
});

describe("limitExclamations", () => {
  it("оставляет только первый «!» за весь ответ, остальные — точки", () => {
    expect(limitExclamations(["Здравствуйте! Рад помочь!", "Отлично! Жду документы!"])).toEqual([
      "Здравствуйте! Рад помочь.",
      "Отлично. Жду документы.",
    ]);
  });

  it("сворачивает «!!!» и «?!», не оставляя странных сочетаний", () => {
    expect(limitExclamations(["Что?! Правда!!!"])).toEqual(["Что? Правда."]);
  });

  it("ответ без «!» и пустой список не меняются", () => {
    expect(limitExclamations(["Хорошо, жду."])).toEqual(["Хорошо, жду."]);
    expect(limitExclamations([])).toEqual([]);
  });

  it("parseModelReply применяет ограничение", () => {
    const r = parseModelReply(
      JSON.stringify({ language: "ru", messages: ["Салом! Ташаккур!", "Ҳамааш хуб!"], handoff: false })
    );
    expect(r.messages.join(" ").match(/!/g)).toHaveLength(1);
  });
});

