import { extractText, getDocumentProxy } from "unpdf";

// PDF → text. White-text detection in PDFs is not implemented (PRD Step 2: "where
// feasible"); the injection scan still runs on everything extracted.
export async function parsePdf(buffer: Buffer | Uint8Array): Promise<string> {
  const pdf = await getDocumentProxy(new Uint8Array(buffer));
  const { text } = await extractText(pdf, { mergePages: false });
  return text.join("\n").trim();
}
