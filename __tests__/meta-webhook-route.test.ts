import { createHmac } from "node:crypto";
import { resetConfigCache } from "@/lib/config";
import { GET, POST } from "@/app/api/meta-webhook/route";
import { processMetaPayload } from "@/lib/services/meta-intake";

jest.mock("@/lib/runtime", () => ({ getMetaIntakeDeps: () => ({}) }));
jest.mock("@/lib/services/meta-intake", () => ({ processMetaPayload: jest.fn(async () => ({ leadgens: 0, messages: 1, duplicates: 0 })) }));

const body = JSON.stringify({ object: "instagram", entry: [{ id: "IG", messaging: [{ sender: { id: "U1" }, message: { mid: "m1", text: "Привет" } }] }] });
const sign = (secret: string, raw = body) => "sha256=" + createHmac("sha256", secret).update(raw).digest("hex");
const post = (signature?: string) =>
  POST(new Request("https://x.test/api/meta-webhook", { method: "POST", body, headers: signature ? { "x-hub-signature-256": signature } : {} }));

beforeEach(() => {
  Object.assign(process.env, { META_VERIFY_TOKEN: "vt", META_APP_SECRET: "main-secret", INSTAGRAM_APP_SECRET: "ig-secret" });
  resetConfigCache();
  (processMetaPayload as jest.Mock).mockClear();
});

describe("/api/meta-webhook", () => {
  it("принимает событие, подписанное секретом приложения Instagram", async () => {
    expect((await post(sign("ig-secret"))).status).toBe(200);
    expect(processMetaPayload).toHaveBeenCalledTimes(1);
  });

  it("принимает событие, подписанное секретом основного приложения Meta", async () => {
    expect((await post(sign("main-secret"))).status).toBe(200);
  });

  it("отклоняет чужую подпись и запрос без подписи, ничего не обрабатывая", async () => {
    expect((await post(sign("other"))).status).toBe(403);
    expect((await post()).status).toBe(403);
    expect(processMetaPayload).not.toHaveBeenCalled();
  });

  it("работает, если задан только секрет Instagram", async () => {
    delete process.env.META_APP_SECRET;
    resetConfigCache();
    expect((await post(sign("ig-secret"))).status).toBe(200);
    expect((await post(sign("main-secret"))).status).toBe(403);
  });

  it("GET: рукопожатие отдаёт challenge только при верном verify token", async () => {
    const url = (t: string) => `https://x.test/api/meta-webhook?hub.mode=subscribe&hub.verify_token=${t}&hub.challenge=777`;
    const ok = await GET(new Request(url("vt")));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("777");
    expect((await GET(new Request(url("bad")))).status).toBe(403);
  });
});
