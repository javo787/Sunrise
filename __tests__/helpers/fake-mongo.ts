/* eslint-disable @typescript-eslint/no-explicit-any */
// Минимальная in-memory замена MongoDB для юнит-тестов (mongod в CI/песочнице нет).
// Условия фильтров считает библиотека mingo; операторы обновления ($set/$setOnInsert/
// $inc/$unset), upsert и уникальные индексы реализованы здесь. Каждый метод коллекции
// выполняется синхронно целиком, то есть так же атомарно, как один запрос к MongoDB —
// тест гонки проверяет правильность фильтров (status: 'pending'), а не сам MongoDB.
import { ObjectId } from "mongodb";
import { Query } from "mingo";

type Doc = Record<string, any>;

function clone<T>(v: T): T {
  if (v instanceof ObjectId) return new ObjectId(v.toHexString()) as any;
  if (v instanceof Date) return new Date(v.getTime()) as any;
  if (Array.isArray(v)) return v.map(clone) as any;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, clone(x)])) as any;
  return v;
}

// Для сопоставления: ObjectId → строка, Date → число
function norm(v: any): any {
  if (v instanceof ObjectId) return `oid:${v.toHexString()}`;
  if (v instanceof Date) return v.getTime();
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x)]));
  return v;
}

const getPath = (o: Doc, path: string) => path.split(".").reduce<any>((acc, k) => (acc == null ? undefined : acc[k]), o);
function setPath(o: Doc, path: string, value: any) {
  const parts = path.split(".");
  let cur = o;
  for (const p of parts.slice(0, -1)) {
    if (cur[p] == null || typeof cur[p] !== "object") cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}
function unsetPath(o: Doc, path: string) {
  const parts = path.split(".");
  let cur: any = o;
  for (const p of parts.slice(0, -1)) {
    cur = cur?.[p];
    if (cur == null) return;
  }
  delete cur[parts[parts.length - 1]];
}

function applyUpdate(doc: Doc, update: Doc, inserting: boolean) {
  for (const [k, v] of Object.entries(update.$set ?? {})) setPath(doc, k, clone(v));
  if (inserting) for (const [k, v] of Object.entries(update.$setOnInsert ?? {})) setPath(doc, k, clone(v));
  for (const [k, v] of Object.entries(update.$inc ?? {})) setPath(doc, k, (getPath(doc, k) ?? 0) + (v as number));
  for (const k of Object.keys(update.$unset ?? {})) unsetPath(doc, k);
}

function dupError() {
  return Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
}

export class FakeCollection {
  docs: Doc[] = [];
  private uniques: string[][] = [];

  async createIndex(spec: Record<string, number>, opts?: { unique?: boolean }) {
    if (opts?.unique) this.uniques.push(Object.keys(spec));
    return "idx";
  }

  private matches(doc: Doc, filter: Doc) {
    return new Query(norm(filter)).test(norm(doc));
  }

  private checkUnique(candidate: Doc, ignore?: Doc) {
    for (const keys of this.uniques) {
      const vals = keys.map((k) => getPath(candidate, k));
      if (vals.some((v) => v === undefined)) continue;
      const clash = this.docs.some(
        (d) => d !== ignore && keys.every((k, i) => JSON.stringify(norm(getPath(d, k))) === JSON.stringify(norm(vals[i])))
      );
      if (clash) throw dupError();
    }
  }

  async insertOne(doc: Doc) {
    const stored = clone(doc);
    stored._id ??= new ObjectId();
    this.checkUnique(stored);
    this.docs.push(stored);
    return { insertedId: stored._id, acknowledged: true };
  }

  async findOne(filter: Doc = {}) {
    const d = this.docs.find((x) => this.matches(x, filter));
    return d ? clone(d) : null;
  }

  find(filter: Doc = {}) {
    let rows = this.docs.filter((x) => this.matches(x, filter));
    const cursor = {
      sort: (spec: Record<string, 1 | -1>) => {
        const [[key, dir]] = Object.entries(spec);
        rows = [...rows].sort((a, b) => {
          const av = norm(getPath(a, key));
          const bv = norm(getPath(b, key));
          return (av > bv ? 1 : av < bv ? -1 : 0) * dir;
        });
        return cursor;
      },
      limit: (n: number) => {
        rows = rows.slice(0, n);
        return cursor;
      },
      toArray: async () => rows.map(clone),
    };
    return cursor;
  }

  async countDocuments(filter: Doc = {}) {
    return this.docs.filter((x) => this.matches(x, filter)).length;
  }

  async deleteOne(filter: Doc) {
    const i = this.docs.findIndex((x) => this.matches(x, filter));
    if (i >= 0) this.docs.splice(i, 1);
    return { deletedCount: i >= 0 ? 1 : 0 };
  }

  async updateOne(filter: Doc, update: Doc, opts?: { upsert?: boolean }) {
    const found = this.docs.find((x) => this.matches(x, filter));
    if (found) {
      applyUpdate(found, update, false);
      return { matchedCount: 1, modifiedCount: 1, upsertedId: null };
    }
    if (!opts?.upsert) return { matchedCount: 0, modifiedCount: 0, upsertedId: null };

    const base: Doc = {};
    for (const [k, v] of Object.entries(filter)) {
      const isOperator = v && typeof v === "object" && !(v instanceof ObjectId) && !(v instanceof Date) && Object.keys(v).some((x) => x.startsWith("$"));
      if (!k.startsWith("$") && !isOperator) setPath(base, k, clone(v));
    }
    applyUpdate(base, update, true);
    base._id ??= new ObjectId();
    this.checkUnique(base);
    this.docs.push(base);
    return { matchedCount: 0, modifiedCount: 0, upsertedId: base._id };
  }

  async findOneAndUpdate(filter: Doc, update: Doc, opts?: { returnDocument?: "before" | "after" }) {
    const found = this.docs.find((x) => this.matches(x, filter));
    if (!found) return null;
    const before = clone(found);
    applyUpdate(found, update, false);
    return opts?.returnDocument === "after" ? clone(found) : before;
  }
}

export class FakeDb {
  private cols = new Map<string, FakeCollection>();
  collection(name: string): FakeCollection {
    if (!this.cols.has(name)) this.cols.set(name, new FakeCollection());
    return this.cols.get(name)!;
  }
}
