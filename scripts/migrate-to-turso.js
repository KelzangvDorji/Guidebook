// One-time migration of the existing local data/app.db (node:sqlite) into
// Turso, and the existing local storage/pdfs + storage/covers files into the
// configured object storage bucket. Run manually once, after `db.init()` has
// been run against the new Turso database (e.g. via `npm start` once, or
// `node scripts/seed.js`).
//
// Usage: node scripts/migrate-to-turso.js
require('dotenv').config();
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = require('../src/db/db');
const storage = require('../src/utils/storage');
const { PDF_BUCKET, COVER_BUCKET } = storage;

const LOCAL_DB_PATH = path.join(__dirname, '..', 'data', 'app.db');
const LOCAL_PDF_DIR = path.join(__dirname, '..', 'storage', 'pdfs');
const LOCAL_COVER_DIR = path.join(__dirname, '..', 'storage', 'covers');

// Order matters: parents before children, so foreign keys resolve as rows
// land in Turso. sessions/reader_tokens/preview_tokens are intentionally
// skipped - they're short-lived by design, safe to start empty.
const TABLES = [
  {
    name: 'users',
    columns: ['id', 'name', 'email', 'phone', 'password_hash', 'role', 'created_at', 'updated_at', 'google_id', 'avatar_url'],
  },
  {
    name: 'books',
    columns: ['id', 'title', 'author_name', 'owner_user_id', 'description', 'price_nu', 'category', 'page_count', 'cover_path', 'pdf_filename', 'preview_pages', 'status', 'created_at', 'updated_at'],
  },
  {
    name: 'purchases',
    columns: ['id', 'user_id', 'book_id', 'amount', 'currency', 'transaction_ref', 'payment_provider', 'payment_status', 'created_at', 'completed_at'],
  },
  {
    name: 'feedback',
    columns: ['id', 'user_id', 'email', 'message', 'status', 'created_at'],
  },
  {
    name: 'author_requests',
    columns: ['id', 'user_id', 'phone', 'status', 'created_at', 'decided_at'],
  },
];

async function migrateTables(local) {
  for (const table of TABLES) {
    const rows = local.prepare(`SELECT * FROM ${table.name}`).all();
    if (!rows.length) {
      console.log(`${table.name}: nothing to migrate.`);
      continue;
    }

    const placeholders = table.columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${table.name} (${table.columns.join(', ')}) VALUES (${placeholders})`;

    const statements = rows.map((row) => ({
      sql,
      args: table.columns.map((c) => (row[c] === undefined ? null : row[c])),
    }));

    // Chunk to keep individual batch calls reasonably sized.
    const CHUNK = 50;
    for (let i = 0; i < statements.length; i += CHUNK) {
      await db.batch(statements.slice(i, i + CHUNK));
    }
    console.log(`${table.name}: migrated ${rows.length} row(s).`);
  }
}

async function migrateFiles(local) {
  const books = local.prepare('SELECT pdf_filename, cover_path FROM books').all();

  for (const book of books) {
    const pdfPath = path.join(LOCAL_PDF_DIR, book.pdf_filename);
    if (fs.existsSync(pdfPath)) {
      if (!(await storage.objectExists(PDF_BUCKET, book.pdf_filename))) {
        await storage.putObject(PDF_BUCKET, book.pdf_filename, fs.readFileSync(pdfPath), { contentType: 'application/pdf' });
        console.log(`Uploaded PDF: ${book.pdf_filename}`);
      }
    } else {
      console.warn(`Missing local PDF for ${book.pdf_filename}, skipped.`);
    }

    if (book.cover_path) {
      const coverPath = path.join(LOCAL_COVER_DIR, book.cover_path);
      if (fs.existsSync(coverPath)) {
        if (!(await storage.objectExists(COVER_BUCKET, book.cover_path))) {
          await storage.putObject(COVER_BUCKET, book.cover_path, fs.readFileSync(coverPath), {
            contentType: 'image/webp',
            cacheControl: 'public, max-age=31536000, immutable',
          });
          console.log(`Uploaded cover: ${book.cover_path}`);
        }
      } else {
        console.warn(`Missing local cover for ${book.cover_path}, skipped.`);
      }
    }
  }
}

async function main() {
  if (!fs.existsSync(LOCAL_DB_PATH)) {
    console.error(`No local database found at ${LOCAL_DB_PATH} - nothing to migrate.`);
    process.exit(1);
  }

  await db.init();

  const local = new DatabaseSync(LOCAL_DB_PATH, { readOnly: true });
  try {
    await migrateTables(local);
    await migrateFiles(local);
  } finally {
    local.close();
  }

  console.log('Migration complete.');
}

main().catch((e) => {
  console.error('Migration failed:', e);
  process.exit(1);
});
