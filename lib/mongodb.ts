import { MongoClient, type Db } from "mongodb";

// Один долгоживущий Node-процесс (Render/VPS), а не serverless: клиент кэшируется
// на уровне модуля. В dev Next.js перезагружает модули — храним промис на global.
// Таймауты заданы явно: по умолчанию драйвер ждёт выбор сервера 30 с на КАЖДЫЙ вызов,
// и при сбое Atlas один вебхук мог зависнуть на минуты. 5 с — компромисс: хватает на «холодный» старт
// кластера, но укладывается в окно ответа Telegram.

declare global {
  // eslint-disable-next-line no-var
  var _sunriseMongoPromise: Promise<MongoClient> | undefined;
}

let clientPromise: Promise<MongoClient> | undefined;

function connect(): Promise<MongoClient> {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI не задан — см. .env.example");
  return new MongoClient(uri, { serverSelectionTimeoutMS: 5000, connectTimeoutMS: 5000 }).connect();
}

function getClientPromise(): Promise<MongoClient> {
  const dev = process.env.NODE_ENV === "development";
  const current = dev ? global._sunriseMongoPromise : clientPromise;
  if (current) return current;

  // Упавшее подключение нельзя оставлять в кэше — иначе все следующие вызовы получат тот же отказ.
  const created = connect().catch((err) => {
    if (dev) global._sunriseMongoPromise = undefined;
    else clientPromise = undefined;
    throw err;
  });
  if (dev) global._sunriseMongoPromise = created;
  else clientPromise = created;
  return created;
}

export async function getDb(): Promise<Db> {
  const client = await getClientPromise();
  // Имя базы задаём явно — иначе легко попасть в "test", если забыли указать её в URI.
  return client.db(process.env.MONGODB_DB || "sunrise");
}
