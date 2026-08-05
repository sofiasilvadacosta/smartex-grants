/**
 * Resolving the many ways the source files write a person's name to one person.
 *
 * Shared by every importer that has to attribute work: the staffing plan writes
 * "Antonio Rocha", the timesheets "Ewerton Hiroshi Haji", the staff sheet
 * "Hiroshi Haji". Each rule is only trusted when it lands on exactly one person —
 * attributing hours or cost to the wrong person is worse than leaving a gap, and
 * the gap is always reported.
 */

const NAME_NOISE = new Set(["de", "da", "do", "dos", "das", "e"]);

export function normalizeName(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function nameWords(text: string): string[] {
  return normalizeName(text)
    .split(" ")
    .filter((word) => word.length > 1 && !NAME_NOISE.has(word));
}

export interface NamedPerson {
  id: string;
  name: string;
}

export type NameResolution =
  | { personId: string }
  | { personId: null; reason: string };

export function resolvePersonByName(
  raw: string,
  people: readonly NamedPerson[],
): NameResolution {
  const target = normalizeName(raw);
  if (!target) return { personId: null, reason: "nome vazio" };

  const rules: ((candidate: NamedPerson) => boolean)[] = [
    // Exactly the same name, accents and case aside.
    (candidate) => normalizeName(candidate.name) === target,
    // A first name or a nickname: one is the start of the other.
    (candidate) =>
      normalizeName(candidate.name).startsWith(target) ||
      target.startsWith(normalizeName(candidate.name)),
    // "Ricardo Jorge Gonçalves" against "Ricardo Gonçalves".
    (candidate) => {
      const a = nameWords(candidate.name);
      const b = nameWords(raw);
      return a.length >= 2 && b.length >= 2 && a[0] === b[0] && a.at(-1) === b.at(-1);
    },
    // "Hiroshi Haji" inside "Ewerton Hiroshi Haji": every word of the shorter
    // name present in the longer, in any position.
    (candidate) => {
      const a = nameWords(candidate.name);
      const b = nameWords(raw);
      if (a.length < 2 || b.length < 2) return false;
      const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
      return shorter.every((word) => longer.includes(word));
    },
  ];

  for (const rule of rules) {
    const matches = people.filter(rule);
    if (matches.length === 1) return { personId: matches[0].id };
    if (matches.length > 1) {
      return {
        personId: null,
        reason: `"${raw}" corresponde a ${matches.length} pessoas (${matches
          .map((m) => m.name)
          .join(", ")}) — demasiado ambíguo para atribuir`,
      };
    }
  }
  return { personId: null, reason: `"${raw}" não corresponde a nenhuma pessoa` };
}
