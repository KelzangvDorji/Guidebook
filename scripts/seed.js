// Populates the catalog from the 3 PDFs already present in /PDFs.
// Safe to re-run: skips any title that has already been seeded.
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { PDFParse } = require('pdf-parse');
const db = require('../src/db/db');
const { PDF_DIR, COVER_DIR } = require('../src/middleware/upload');

const SOURCE_DIR = path.join(__dirname, '..', 'PDFs');

// Hand-written jacket copy + category/price, since these details are not
// embedded in the PDFs themselves. Everything else (title, author, page
// count) is read directly from each PDF's metadata. `cover` points at a
// pre-optimized WebP already sitting in storage/covers/ (see
// scripts/process-covers.js for how the originals in Images/ were resized).
const CATALOG_META = {
  'alice-adventures-in-wonderland.pdf': {
    description: "Alice tumbles down a rabbit hole into a world of riddles, talking creatures, and a tyrannical Queen of Hearts. Lewis Carroll's timeless nonsense classic remains one of the most inventive works in English literature.",
    category: 'Classic Fiction',
    price_nu: 150,
    cover: 'alice-adventures-in-wonderland.webp',
  },
  'romeo-and-juliet.pdf': {
    description: "Two young lovers from feuding houses in Verona defy their families in Shakespeare's most enduring tragedy of love and fate.",
    category: 'Drama',
    price_nu: 180,
    cover: 'romeo-and-juliet.webp',
  },
  'the-time-machine.pdf': {
    description: 'A Victorian inventor builds a machine that carries him far into the future, into a world split between the gentle Eloi and the monstrous Morlocks. H. G. Wells\' foundational work of science fiction.',
    category: 'Science Fiction',
    price_nu: 160,
    cover: 'the-time-machine.webp',
  },
};

async function seed() {
  const files = fs.readdirSync(SOURCE_DIR).filter((f) => f.toLowerCase().endsWith('.pdf'));
  if (!fs.existsSync(PDF_DIR)) fs.mkdirSync(PDF_DIR, { recursive: true });

  for (const file of files) {
    const meta = CATALOG_META[file];
    if (!meta) {
      console.warn(`No catalog metadata configured for ${file}, skipping.`);
      continue;
    }

    const buf = fs.readFileSync(path.join(SOURCE_DIR, file));
    const parser = new PDFParse({ data: buf });
    const info = await parser.getInfo();
    await parser.destroy();

    const title = (info.info?.Title || file.replace(/\.pdf$/i, '')).trim();
    const authorName = (info.info?.Author || 'Unknown').trim();
    const pageCount = info.total || 0;

    const coverPath = meta.cover && fs.existsSync(path.join(COVER_DIR, meta.cover)) ? meta.cover : null;

    const existing = db.prepare('SELECT id, cover_path FROM books WHERE title = ?').get(title);
    if (existing) {
      // Backfill a cover onto an already-seeded row (e.g. covers were added
      // after the initial seed run) without touching anything else about it.
      if (coverPath && existing.cover_path !== coverPath) {
        db.prepare(`UPDATE books SET cover_path = ?, updated_at = datetime('now') WHERE id = ?`).run(coverPath, existing.id);
        console.log(`Added cover to already-seeded book: ${title}`);
      } else {
        console.log(`Already seeded: ${title}`);
      }
      continue;
    }

    const storedName = `${crypto.randomUUID()}.pdf`;
    fs.writeFileSync(path.join(PDF_DIR, storedName), buf);

    db.prepare(`
      INSERT INTO books (title, author_name, owner_user_id, description, price_nu, category, page_count, cover_path, pdf_filename, preview_pages)
      VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `).run(title, authorName, meta.description, meta.price_nu, meta.category, pageCount, coverPath, storedName, Math.min(5, pageCount));

    console.log(`Seeded: ${title} by ${authorName} (${pageCount} pages)${coverPath ? ' with cover' : ''}`);
  }

  console.log('Seeding complete.');
}

seed().catch((e) => {
  console.error('Seed failed:', e);
  process.exit(1);
});
