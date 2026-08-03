import { existsSync, readFileSync } from "node:fs";

// The portal's per-technician "Movimentos de despesa" tables, transcribed from
// the payment-request screens. They carry the one field the exported "Pessoal"
// table omits: the activity each movement was imputed to. The movement id is
// the same id the exported table uses, so the two join exactly.
//
// Only the movement rows are parsed; the technician headers are kept in the
// file so the transcription can be checked against the screen it came from.
const MOVEMENT_LINE = /^(\d+)\t(\d{4}-\d{2})\t(\d+)\t[\d,]+\t([\d.,]+)\s*$/;

export interface MovementActivity {
  activity: string;
  yearMonth: string;
  amount: number;
}

function parseAmount(text: string): number {
  return Number(text.replace(/\./g, "").replace(",", "."));
}

export function readMovementActivities(path: string): Map<string, MovementActivity> | null {
  if (!existsSync(path)) return null;

  const byMovement = new Map<string, MovementActivity>();
  const lines = readFileSync(path, "utf8").split(/\r?\n/);

  for (const [index, line] of lines.entries()) {
    const match = MOVEMENT_LINE.exec(line);
    if (!match) continue;
    const [, movementId, yearMonth, activity, amountText] = match;
    // A repeated id would mean the transcription duplicated a block; silently
    // keeping one of the two would corrupt the activity split.
    if (byMovement.has(movementId)) {
      throw new Error(
        `${path}:${index + 1}: movimento ${movementId} aparece mais do que uma vez`,
      );
    }
    byMovement.set(movementId, { activity, yearMonth, amount: parseAmount(amountText) });
  }

  if (byMovement.size === 0) return null;
  return byMovement;
}
