// Next.js вызывает register() один раз при старте сервера. Весь Node-специфичный код вынесен
// в instrumentation-node.ts и подключается только под проверкой рантайма — иначе Next пытается
// собрать его и для edge-рантайма, где нет http/https/net.
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./instrumentation-node");
  }
}
