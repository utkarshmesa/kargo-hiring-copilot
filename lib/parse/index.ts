import { parseDocx } from "./docx";
import { parsePdf } from "./pdf";
import { containsInjection, scanInjection } from "./injection";

// Step 2: parse and guard. Everything here is code; no model has seen the CV yet.
export const MIN_WORDS = 150;

export type ParsedCv = {
  /** Visible text with injection lines removed: the only text the Extractor sees. */
  text: string;
  wordCount: number;
  hiddenText: string[];
  injectionLines: { pattern: string; line: string }[];
  integrityCheck: boolean;
  unparseable: boolean;
};

export type FileKind = "docx" | "pdf";

export function detectKind(buffer: Uint8Array): FileKind | null {
  if (buffer[0] === 0x50 && buffer[1] === 0x4b) return "docx"; // "PK" zip
  if (buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46) return "pdf"; // "%PDF"
  return null;
}

export async function parseCv(buffer: Uint8Array): Promise<ParsedCv> {
  const kind = detectKind(buffer);
  if (!kind) return empty();
  let visible = "";
  let hidden: string[] = [];
  try {
    if (kind === "docx") {
      const r = await parseDocx(buffer);
      visible = r.visibleText;
      hidden = r.hiddenText;
    } else {
      visible = await parsePdf(buffer);
    }
  } catch {
    return empty();
  }
  const { cleanText, removedLines } = scanInjection(visible);
  const hiddenInjection = hidden.some(containsInjection);
  const wordCount = countWords(cleanText);
  return {
    text: cleanText,
    wordCount,
    hiddenText: hidden,
    injectionLines: removedLines,
    integrityCheck: hidden.length > 0 || removedLines.length > 0 || hiddenInjection,
    unparseable: wordCount < MIN_WORDS,
  };
}

export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

function empty(): ParsedCv {
  return { text: "", wordCount: 0, hiddenText: [], injectionLines: [], integrityCheck: false, unparseable: true };
}
