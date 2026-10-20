import { isManagerSheet, type ManagerSheet } from "@/lib/domain/catalog";
import { managersCol, type Manager } from "./collections";

export async function upsertManager(input: {
  telegramId: number;
  name: string;
  sheetName: ManagerSheet;
  username?: string;
}): Promise<void> {
  if (!isManagerSheet(input.sheetName)) throw new Error(`Нет листа «${input.sheetName}» в таблице`);
  const col = await managersCol();

  // Один лист — один менеджер: иначе строки двух людей перемешаются на одном листе.
  const holder = await col.findOne({ sheetName: input.sheetName, active: true, telegramId: { $ne: input.telegramId } });
  if (holder) throw new Error(`Лист «${input.sheetName}» уже занят: ${holder.name}`);

  await col.updateOne(
    { telegramId: input.telegramId },
    {
      $set: { name: input.name, sheetName: input.sheetName, active: true, ...(input.username ? { username: input.username } : {}) },
      $setOnInsert: { createdAt: new Date() },
    },
    { upsert: true }
  );
}

/** Менеджер деактивируется, а не удаляется: история захватов остаётся в лидах. */
export async function deactivateManager(telegramId: number): Promise<boolean> {
  const col = await managersCol();
  const res = await col.updateOne({ telegramId, active: true }, { $set: { active: false } });
  return res.modifiedCount > 0;
}

export async function getActiveManager(telegramId: number): Promise<Manager | null> {
  const col = await managersCol();
  return col.findOne({ telegramId, active: true });
}

export async function listActiveManagers(): Promise<Manager[]> {
  const col = await managersCol();
  return col.find({ active: true }).sort({ sheetName: 1 }).toArray();
}
