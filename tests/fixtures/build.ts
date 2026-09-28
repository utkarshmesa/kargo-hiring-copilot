import JSZip from "jszip";
import { PDFDocument, StandardFonts } from "pdf-lib";

// Builds minimal but valid DOCX / PDF files for tests. A paragraph is either plain text
// or a list of runs, so hidden (<w:vanish/>) and white-font runs can be planted.
export type Run = { text: string; vanish?: boolean; color?: string };
export type Para = string | Run[];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function paraXml(p: Para): string {
  const runs = typeof p === "string" ? [{ text: p }] : p;
  const body = runs
    .map((r) => {
      const props = [r.vanish ? "<w:vanish/>" : "", r.color ? `<w:color w:val="${r.color}"/>` : ""].join("");
      return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(r.text)}</w:t></w:r>`;
    })
    .join("");
  return `<w:p>${body}</w:p>`;
}

export async function makeDocx(paras: Para[], opts: { header?: Para[]; footer?: Para[] } = {}): Promise<Uint8Array> {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const zip = new JSZip();
  const rels: string[] = [];
  const overrides: string[] = [];
  if (opts.header) {
    zip.file("word/header1.xml", `<?xml version="1.0" encoding="UTF-8"?><w:hdr ${W}>${opts.header.map(paraXml).join("")}</w:hdr>`);
    rels.push('<Relationship Id="rH" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>');
    overrides.push('<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>');
  }
  if (opts.footer) {
    zip.file("word/footer1.xml", `<?xml version="1.0" encoding="UTF-8"?><w:ftr ${W}>${opts.footer.map(paraXml).join("")}</w:ftr>`);
    rels.push('<Relationship Id="rF" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer" Target="footer1.xml"/>');
    overrides.push('<Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>');
  }
  const sect = `<w:sectPr>${opts.header ? '<w:headerReference w:type="default" r:id="rH"/>' : ""}${opts.footer ? '<w:footerReference w:type="default" r:id="rF"/>' : ""}</w:sectPr>`;
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${overrides.join("")}</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`,
  );
  zip.file("word/document.xml", `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${paras.map(paraXml).join("")}${sect}</w:body></w:document>`);
  return zip.generateAsync({ type: "uint8array" });
}

/** A text PDF, one line per entry, wrapped to fit the page. */
export async function makePdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = 10;
  let page = doc.addPage([595, 842]);
  let y = 800;
  const wrapped = lines.flatMap((line) => wrap(line, 95));
  for (const line of wrapped) {
    if (y < 40) {
      page = doc.addPage([595, 842]);
      y = 800;
    }
    page.drawText(line.replace(/[^\x20-\x7e]/g, "-"), { x: 40, y, size, font });
    y -= 14;
  }
  return doc.save();
}

function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const out: string[] = [];
  let cur = "";
  for (const word of line.split(" ")) {
    if ((cur + " " + word).trim().length > width) {
      out.push(cur.trim());
      cur = word;
    } else cur += " " + word;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
