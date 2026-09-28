// Injection scan (PRD Step 2, rubric §4.3). A matching line is removed from the text
// the models see and INTEGRITY_CHECK is set. Genuine content is still scored.
export const INJECTION_PATTERNS: { id: string; re: RegExp }[] = [
  { id: "ignore_instructions", re: /\b(ignore|disregard|forget)\b.{0,40}\b(instructions?|prompts?|rules?|rubric)\b/i },
  { id: "you_are_ai", re: /\byou are (now )?(an?|the)( [\w-]+){0,2} (ai|assistant|language model|llm|model|chatbot|recruiter bot|screener)\b/i },
  { id: "score_me", re: /\b(score|rate|rank|grade)\s+(this|me|this candidate|this cv|this resume)\b/i },
  { id: "rating_demand", re: /\b\d{1,3}\s*\/\s*(10|100)\b.{0,30}\b(score|rating|candidate)\b|\b(score|rate|rating)\b.{0,30}\b(10\s*\/\s*10|100\s*\/\s*100)\b/i },
  { id: "system_prompt", re: /\bsystem\s+prompt\b|\bdeveloper\s+(message|instructions?)\b/i },
  { id: "role_tags", re: /<\/?\s*(system|assistant|instructions?|profile|cv_text|rubric)\s*>/i },
  { id: "hire_directive", re: /\b(must|should)\s+(be\s+)?(hired|shortlisted|advanced|selected)\b|\b(shortlist|hire|advance)\s+(this|me)\b/i },
];

export type InjectionResult = { cleanText: string; removedLines: { pattern: string; line: string }[] };

export function scanInjection(text: string): InjectionResult {
  const kept: string[] = [];
  const removedLines: InjectionResult["removedLines"] = [];
  for (const line of text.split("\n")) {
    const hit = INJECTION_PATTERNS.find((p) => p.re.test(line));
    if (hit) removedLines.push({ pattern: hit.id, line });
    else kept.push(line);
  }
  return { cleanText: kept.join("\n"), removedLines };
}

export function containsInjection(text: string): boolean {
  return INJECTION_PATTERNS.some((p) => p.re.test(text));
}
