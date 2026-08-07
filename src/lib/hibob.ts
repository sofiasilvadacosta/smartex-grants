// Reading people, pay and time off from HiBob.
//
// Written defensively on purpose. The API could not be reached from where this
// was developed, so rather than assume a response shape, every field is pulled
// out by looking for it among several plausible names and the raw keys of the
// first record are reported back. The preview screen shows what was found before
// anything is written, which is also the right way to run a first sync.

const BASE_URL = process.env.HIBOB_BASE_URL ?? "https://api.hibob.com/v1";

export class HibobError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "HibobError";
  }
}

/**
 * HiBob service users authenticate with HTTP Basic (id + token); older
 * integrations use a bearer token. Which one is in use is decided by which
 * variables are set, so neither has to be guessed at.
 */
function authorization(): string {
  const serviceUserId = process.env.HIBOB_SERVICE_USER_ID;
  const token = process.env.HIBOB_API_TOKEN;
  if (!token) {
    throw new HibobError(
      "HIBOB_API_TOKEN não está definida. Criar um service user no HiBob " +
        "(Settings → Integrations → Service users) e guardar o token nas Environment " +
        "Variables do Vercel.",
    );
  }
  if (serviceUserId) {
    return `Basic ${Buffer.from(`${serviceUserId}:${token}`).toString("base64")}`;
  }
  return `Bearer ${token}`;
}

export function isConfigured(): boolean {
  return Boolean(process.env.HIBOB_API_TOKEN);
}

async function request(path: string, init?: RequestInit): Promise<unknown> {
  const url = `${BASE_URL}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        authorization: authorization(),
        ...init?.headers,
      },
      // A sync must not hang a page render.
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new HibobError(
      `Não foi possível contactar o HiBob (${url}): ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const body = await response.text();
  if (!response.ok) {
    throw new HibobError(
      `O HiBob respondeu ${response.status} a ${path}.` +
        (response.status === 401 || response.status === 403
          ? " O token não é válido ou o service user não tem permissão para este recurso."
          : ""),
      response.status,
      body.slice(0, 500),
    );
  }
  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new HibobError(`O HiBob devolveu algo que não é JSON em ${path}.`, response.status, body.slice(0, 500));
  }
}

type Row = Record<string, unknown>;

function isRow(value: unknown): value is Row {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The list inside a response, whatever the wrapper calls it. */
function listOf(payload: unknown): Row[] {
  if (Array.isArray(payload)) return payload.filter(isRow);
  if (!isRow(payload)) return [];
  for (const key of ["employees", "values", "items", "results", "data", "requests"]) {
    const candidate = payload[key];
    if (Array.isArray(candidate)) return candidate.filter(isRow);
  }
  return [];
}

/** Reads a value by dotted path, so nested shapes work without guessing depth. */
function at(row: Row, path: string): unknown {
  let current: unknown = row;
  for (const part of path.split(".")) {
    if (!isRow(current)) return undefined;
    current = current[part];
  }
  return current;
}

function firstString(row: Row, paths: readonly string[]): string | null {
  for (const path of paths) {
    const value = at(row, path);
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number") return String(value);
  }
  return null;
}

function firstNumber(row: Row, paths: readonly string[]): number | null {
  for (const path of paths) {
    const value = at(row, path);
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Number(value.replace(",", "."));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

/** "YYYY-MM-DD" or an ISO timestamp, reduced to the date. */
function firstDate(row: Row, paths: readonly string[]): string | null {
  const raw = firstString(row, paths);
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(raw);
  return match ? match[1] : null;
}

export interface HibobPerson {
  hibobId: string;
  fullName: string | null;
  email: string | null;
  title: string | null;
  department: string | null;
  startDate: string | null;
  endDate: string | null;
  active: boolean;
}

export interface HibobSalary {
  hibobId: string;
  effectiveDate: string | null;
  amount: number | null;
  currency: string | null;
  /** "Annual", "Monthly"… — decides how the figure relates to the funder's RBM. */
  payPeriod: string | null;
}

export interface HibobTimeOff {
  hibobId: string;
  startDate: string | null;
  endDate: string | null;
  /** Working days, as HiBob counts them. */
  days: number | null;
  policyType: string | null;
  status: string | null;
}

export interface HibobProbe<T> {
  rows: T[];
  /** Field names on the first raw record, so an unmapped shape can be seen. */
  sampleKeys: string[];
  /** The first raw record, trimmed, for the same reason. */
  sample: Row | null;
  total: number;
}

function probe<T>(payload: unknown, map: (row: Row) => T | null): HibobProbe<T> {
  const raw = listOf(payload);
  const rows: T[] = [];
  for (const row of raw) {
    const mapped = map(row);
    if (mapped) rows.push(mapped);
  }
  return {
    rows,
    sampleKeys: raw[0] ? Object.keys(raw[0]).sort() : [],
    sample: raw[0] ?? null,
    total: raw.length,
  };
}

export async function fetchPeople(): Promise<HibobProbe<HibobPerson>> {
  // The documented search endpoint; humanReadable makes lookup fields come back
  // as their labels rather than ids.
  const payload = await request("/people/search", {
    method: "POST",
    body: JSON.stringify({ showInactive: true, humanReadable: "REPLACE" }),
  });
  return probe(payload, (row) => {
    const hibobId = firstString(row, ["id", "employeeId", "internal.id"]);
    if (!hibobId) return null;
    const endDate = firstDate(row, [
      "internal.terminationDate",
      "work.terminationDate",
      "terminationDate",
    ]);
    return {
      hibobId,
      fullName: firstString(row, ["displayName", "fullName", "personal.name.fullName", "name"]),
      email: firstString(row, ["email", "work.email", "personal.email"]),
      title: firstString(row, ["work.title", "work.reportsTo.title", "title", "jobTitle"]),
      department: firstString(row, ["work.department", "department"]),
      startDate: firstDate(row, ["work.startDate", "startDate", "internal.hireDate"]),
      endDate,
      // A leaving date in the past is the only reliable signal; HiBob's own
      // status field is named differently across accounts.
      active:
        endDate === null || endDate > new Date().toISOString().slice(0, 10),
    };
  });
}

export async function fetchSalaries(hibobId: string): Promise<HibobProbe<HibobSalary>> {
  const payload = await request(`/people/${encodeURIComponent(hibobId)}/salaries`);
  return probe(payload, (row) => ({
    hibobId,
    effectiveDate: firstDate(row, ["effectiveDate", "startDate", "date"]),
    amount: firstNumber(row, ["base.value", "payment.value", "value", "amount", "base"]),
    currency: firstString(row, ["base.currency", "payment.currency", "currency"]),
    payPeriod: firstString(row, ["payPeriod", "base.payPeriod", "paymentPeriod", "period"]),
  }));
}

export async function fetchTimeOff(from: string, to: string): Promise<HibobProbe<HibobTimeOff>> {
  const payload = await request(
    `/timeoff/requests/changes?since=${encodeURIComponent(from)}&until=${encodeURIComponent(to)}`,
  );
  return probe(payload, (row) => {
    const hibobId = firstString(row, ["employeeId", "employee.id", "id"]);
    if (!hibobId) return null;
    return {
      hibobId,
      startDate: firstDate(row, ["startDate", "start", "from"]),
      endDate: firstDate(row, ["endDate", "end", "to"]),
      days: firstNumber(row, ["totalDuration", "duration", "days", "dailyHours"]),
      policyType: firstString(row, ["policyTypeDisplayName", "policyType", "type"]),
      status: firstString(row, ["status", "requestStatus"]),
    };
  });
}
