import { ApiError, GoogleGenAI, ThinkingLevel } from "@google/genai";
import { z } from "zod";

// The only module that talks to Gemini. Every call: JSON response schema, pinned model
// from GEMINI_MODEL, explicit thinking level, fixed temperature and seed.
//
// Temperature: Google's Gemini 3 guidance is to keep the default 1.0; lower values
// "may lead to unexpected behavior, such as looping". Run-to-run variance is handled
// by the 3-run median (PRD Step 6).
export const GEMINI_TEMPERATURE = 1.0;
export const GEMINI_SEED = 20261231;

export type Thinking = "low" | "medium" | "high";
const THINKING: Record<Thinking, ThinkingLevel> = {
  low: ThinkingLevel.LOW,
  medium: ThinkingLevel.MEDIUM,
  high: ThinkingLevel.HIGH,
};

/** 429 / 5xx / network: the caller should requeue with backoff. */
export class TransientGeminiError extends Error {}
/** Output still invalid after the allowed retries (PRD: 2 retries → invalid_output). */
export class InvalidOutputError extends Error {}

let client: GoogleGenAI | null = null;
function gemini(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

export function modelId(): string {
  const id = process.env.GEMINI_MODEL;
  if (!id) throw new Error("GEMINI_MODEL is not set");
  if (/-(preview|latest|exp)\b/.test(id)) throw new Error(`GEMINI_MODEL must be a stable pinned ID, got ${id}`);
  return id;
}

export type CallMeta = { model: string; thinking: Thinking; temperature: number; seed: number; attempts: number };

export async function generateJson<T>(opts: {
  system: string;
  user: string;
  schema: z.ZodType<T>;
  thinking: Thinking;
  retries?: number;
}): Promise<{ data: T; meta: CallMeta }> {
  const model = modelId();
  const retries = opts.retries ?? 2;
  const jsonSchema = z.toJSONSchema(opts.schema, { target: "draft-2020-12" });
  let lastProblem = "";
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    let text: string | undefined;
    try {
      const res = await gemini().models.generateContent({
        model,
        contents: [{ role: "user", parts: [{ text: opts.user }] }],
        config: {
          systemInstruction: opts.system,
          responseMimeType: "application/json",
          responseJsonSchema: jsonSchema,
          temperature: GEMINI_TEMPERATURE,
          seed: GEMINI_SEED,
          thinkingConfig: { thinkingLevel: THINKING[opts.thinking] },
        },
      });
      text = res.text;
    } catch (err) {
      if (isTransient(err)) throw new TransientGeminiError(describe(err));
      throw err;
    }
    try {
      const parsed = opts.schema.safeParse(JSON.parse(text ?? ""));
      if (parsed.success) {
        return {
          data: parsed.data,
          meta: { model, thinking: opts.thinking, temperature: GEMINI_TEMPERATURE, seed: GEMINI_SEED, attempts: attempt },
        };
      }
      lastProblem = parsed.error.issues
        .slice(0, 3)
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
    } catch {
      lastProblem = "response was not JSON";
    }
  }
  throw new InvalidOutputError(lastProblem);
}

function isTransient(err: unknown): boolean {
  if (err instanceof ApiError) return err.status === 429 || err.status === 408 || err.status >= 500;
  // fetch/network failures surface as TypeError or AbortError
  return err instanceof TypeError || (err instanceof Error && err.name === "AbortError");
}

// Error text only: never the prompt, never CV content.
function describe(err: unknown): string {
  if (err instanceof ApiError) return `Gemini HTTP ${err.status}`;
  return err instanceof Error ? err.name : "unknown error";
}
