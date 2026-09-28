// Whole weeks left until the offer target date (PRD §2: an offer before 31 December).
export function weeksLeft(targetIsoDate: string, now: Date = new Date()): number {
  const target = new Date(`${targetIsoDate}T23:59:59+05:30`);
  const ms = target.getTime() - now.getTime();
  return Math.max(0, Math.floor(ms / (7 * 24 * 3600 * 1000)));
}
