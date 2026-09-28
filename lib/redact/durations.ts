// Raw CV dates → month indexes. Dates never reach a model: the redacted profile only
// carries durations and order (rubric §4.1). "Present" means the as-of date: the upload
// date for live CVs, the join date for calibration CVs.

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};

export type MonthIndex = number; // year * 12 + month (0-based)

export function toMonthIndex(d: Date): MonthIndex {
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
}

const PRESENT = /^(present|current|now|till date|to date|ongoing|today)$/i;

/** Parses "Jan 2022", "January 2022", "01/2022", "2022-01", "2022". Year-only: Jan for starts, Dec for ends. */
export function parseRawDate(raw: string | null | undefined, kind: "start" | "end", asOf: Date): MonthIndex | null {
  if (!raw) return null;
  const s = raw.trim().replace(/[.,]/g, " ").replace(/\s+/g, " ");
  if (PRESENT.test(s)) return toMonthIndex(asOf);
  let m = /^([a-z]{3,9})\s*'?(\d{2}|\d{4})$/i.exec(s);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 4).toLowerCase()] ?? MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon === undefined) return null;
    return fullYear(m[2]) * 12 + mon;
  }
  m = /^(\d{1,2})\s*[/\-]\s*(\d{4})$/.exec(s);
  if (m && +m[1] >= 1 && +m[1] <= 12) return +m[2] * 12 + (+m[1] - 1);
  m = /^(\d{4})\s*[/\-]\s*(\d{1,2})$/.exec(s);
  if (m && +m[2] >= 1 && +m[2] <= 12) return +m[1] * 12 + (+m[2] - 1);
  m = /^(\d{4})$/.exec(s);
  if (m) return +m[1] * 12 + (kind === "start" ? 0 : 11);
  return null;
}

function fullYear(y: string): number {
  return y.length === 2 ? 2000 + +y : +y;
}

/** Inclusive month span, or null if either end is unparseable or the range is inverted. */
export function roleSpan(startRaw: string | null, endRaw: string | null, asOf: Date) {
  const start = parseRawDate(startRaw, "start", asOf);
  const end = parseRawDate(endRaw ?? "present", "end", asOf);
  if (start === null || end === null || end < start) return null;
  return { start, end, months: end - start + 1 };
}

export function formatDuration(months: number | null): string {
  if (months === null) return "duration unknown";
  const y = Math.floor(months / 12);
  const m = months % 12;
  if (y === 0) return `${m}m`;
  if (m === 0) return `${y}y`;
  return `${y}y ${m}m`;
}
