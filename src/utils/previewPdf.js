const { PDFDocument } = require('pdf-lib');

// Builds a genuinely truncated PDF containing only the first N pages, so a
// "preview" response can never be used to reconstruct the full purchased
// book - unlike sending the full file and hiding pages client-side.
async function buildPreviewBuffer(pdfBuffer, pageCount) {
  const src = await PDFDocument.load(pdfBuffer);
  const total = src.getPageCount();
  const take = Math.max(1, Math.min(pageCount, total));

  const out = await PDFDocument.create();
  const indices = Array.from({ length: take }, (_, i) => i);
  const pages = await out.copyPages(src, indices);
  pages.forEach((p) => out.addPage(p));

  return Buffer.from(await out.save());
}

module.exports = { buildPreviewBuffer };
