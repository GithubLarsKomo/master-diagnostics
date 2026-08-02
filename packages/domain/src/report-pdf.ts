import type { ReportDocument } from './report-document';

function escapePdfText(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
}

function latin1Bytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    bytes[index] = code <= 0xff ? code : 0x3f;
  }
  return bytes;
}

function byteLength(value: string): number {
  return latin1Bytes(value).length;
}

function wrapText(value: string, maxLength = 84): readonly string[] {
  const words = value.trim().split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length <= maxLength) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    current = word;
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

function textCommand(text: string, x: number, y: number, size: number): string {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${escapePdfText(text)}) Tj ET`;
}

function buildContent(document: ReportDocument): string {
  const commands: string[] = [];
  let y = 800;
  commands.push(textCommand(document.title, 54, y, 18));
  y -= 32;

  for (const section of document.sections) {
    commands.push(textCommand(section.heading, 54, y, 13));
    y -= 20;
    for (const entry of section.fields) {
      for (const line of wrapText(`${entry.label}: ${entry.value}`)) {
        commands.push(textCommand(line, 64, y, 10));
        y -= 14;
      }
    }
    y -= 10;
  }

  y = Math.max(y - 8, 72);
  for (const line of wrapText(document.disclaimer, 76)) {
    commands.push(textCommand(line, 54, y, 8));
    y -= 11;
  }

  return `${commands.join('\n')}\n`;
}

/** Renders the language-specific report document as a deterministic one-page PDF 1.4 byte stream. */
export function renderReportPdf(document: ReportDocument): Uint8Array {
  const content = buildContent(document);
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    `<< /Length ${byteLength(content)} >>\nstream\n${content}endstream`,
  ];

  let pdf = '%PDF-1.4\n%âãÏÓ\n';
  const offsets: number[] = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }

  const xrefOffset = byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (const offset of offsets.slice(1)) {
    pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return latin1Bytes(pdf);
}
