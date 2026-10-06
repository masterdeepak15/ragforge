import PDFDocument from 'pdfkit';

/** Builds a real single-page PDF containing `text` (generated with pdfkit). */
export function buildPdf(text: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument();
    const parts: Buffer[] = [];
    doc.on('data', (c: Buffer) => parts.push(c));
    doc.on('end', () => resolve(Buffer.concat(parts)));
    doc.on('error', reject);
    doc.text(text);
    doc.end();
  });
}
