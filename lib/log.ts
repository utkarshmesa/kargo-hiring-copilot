// Console logging that can only carry IDs, statuses and counts — never CV text, names
// or contact details (PRD §8.3). Values are restricted to primitives.
type Safe = string | number | boolean | null | undefined;

export function log(event: string, fields: Record<string, Safe> = {}) {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields }));
}
