import JSZip from "jszip";

// DOCX → text in one pass over the WordprocessingML, so visible and hidden text are
// split by the same code. A run is hidden if it has <w:vanish/> or a white/near-white
// font colour (PRD Step 2). Headers and footers are included: names often sit there.

export type DocxText = { visibleText: string; hiddenText: string[] };

const PARTS = /^word\/(document|header\d*|footer\d*)\.xml$/;

export async function parseDocx(buffer: Buffer | Uint8Array): Promise<DocxText> {
  const zip = await JSZip.loadAsync(buffer);
  const names = Object.keys(zip.files)
    .filter((n) => PARTS.test(n))
    .sort((a, b) => partOrder(a) - partOrder(b));
  const visible: string[] = [];
  const hidden: string[] = [];
  for (const name of names) {
    const xml = await zip.file(name)!.async("string");
    const part = walkXml(xml);
    if (part.visibleText.trim()) visible.push(part.visibleText);
    hidden.push(...part.hiddenText);
  }
  return { visibleText: visible.join("\n").trim(), hiddenText: hidden };
}

// Headers first, then the body, then footers: the reading order of a printed page.
function partOrder(name: string): number {
  if (name.includes("header")) return 0;
  if (name.includes("document")) return 1;
  return 2;
}

export function isNearWhite(hex: string): boolean {
  if (!/^[0-9a-f]{6}$/i.test(hex)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r >= 0xf0 && g >= 0xf0 && b >= 0xf0;
}

// Sequential tag scan. Only the tags that matter are tracked; everything else is skipped.
const TAG = /<(\/?)w:(p|r|rPr|t|tab|br|cr|vanish|color)\b([^>]*?)(\/?)>|([^<]+)/g;

export function walkXml(xml: string): DocxText {
  let out = "";
  let hiddenRun = "";
  const hiddenText: string[] = [];
  let inRun = false;
  let inRunProps = false;
  let inText = false;
  let runHidden = false;

  const flushHidden = () => {
    if (hiddenRun.trim()) hiddenText.push(hiddenRun.trim());
    hiddenRun = "";
  };

  for (const m of xml.matchAll(TAG)) {
    const [, closing, tag, attrs, selfClosing, textNode] = m;
    if (textNode !== undefined) {
      if (inText) {
        const text = decodeEntities(textNode);
        if (runHidden) hiddenRun += text;
        else out += text;
      }
      continue;
    }
    const open = !closing;
    switch (tag) {
      case "p":
        if (!open || selfClosing) {
          out += "\n";
          flushHidden();
        }
        break;
      case "r":
        if (open && !selfClosing) {
          inRun = true;
          runHidden = false;
        } else {
          inRun = false;
          runHidden = false;
        }
        break;
      case "rPr":
        inRunProps = open && !selfClosing && inRun;
        break;
      case "vanish":
        if (inRunProps && open && !/w:val="(0|false|off)"/.test(attrs)) runHidden = true;
        break;
      case "color": {
        const val = /w:val="([^"]+)"/.exec(attrs)?.[1];
        if (inRunProps && open && val && isNearWhite(val)) runHidden = true;
        break;
      }
      case "t":
        inText = open && !selfClosing;
        break;
      case "tab":
        if (inRun && open) {
          if (runHidden) hiddenRun += "\t";
          else out += "\t";
        }
        break;
      case "br":
      case "cr":
        if (inRun && open) {
          if (runHidden) hiddenRun += " ";
          else out += "\n";
        }
        break;
    }
  }
  flushHidden();
  return { visibleText: out.replace(/\n{3,}/g, "\n\n"), hiddenText };
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
