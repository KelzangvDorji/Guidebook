const { createClient } = require('@libsql/client');

if (!process.env.TURSO_DATABASE_URL) {
  throw new Error('TURSO_DATABASE_URL is missing. Set it in .env (see .env.example).');
}

const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

async function get(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows[0] ?? null;
}

async function all(sql, args = []) {
  const result = await client.execute({ sql, args });
  return result.rows;
}

async function run(sql, args = []) {
  const result = await client.execute({ sql, args });
  return { lastInsertRowid: Number(result.lastInsertRowid), changes: result.rowsAffected };
}

// Statements run together as one atomic unit (all commit or none do).
async function batch(statements) {
  return client.batch(statements.map((s) => (typeof s === 'string' ? s : { sql: s.sql, args: s.args || [] })));
}

let initialized = false;

// Idempotent (CREATE TABLE/INDEX IF NOT EXISTS), safe to call on every boot -
// including every post-idle cold start on a free-tier host. Not run at
// module-load time since that would require top-level await in a CommonJS
// file; call this once from server.js (and from any script that talks to a
// possibly-fresh database) before issuing other queries.
async function init() {
  if (initialized) return;

  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE,
      phone TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user','author','admin')) DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      author_name TEXT NOT NULL,
      owner_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      description TEXT NOT NULL DEFAULT '',
      price_nu REAL NOT NULL DEFAULT 0,
      category TEXT NOT NULL DEFAULT 'General',
      page_count INTEGER NOT NULL DEFAULT 0,
      cover_path TEXT,
      pdf_filename TEXT NOT NULL,
      preview_pages INTEGER NOT NULL DEFAULT 5,
      status TEXT NOT NULL CHECK (status IN ('active','hidden')) DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      amount REAL NOT NULL,
      currency TEXT NOT NULL DEFAULT 'Nu.',
      transaction_ref TEXT NOT NULL UNIQUE,
      payment_provider TEXT NOT NULL DEFAULT 'dev-test',
      payment_status TEXT NOT NULL CHECK (payment_status IN ('pending','completed','failed')) DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      email TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('new','read')) DEFAULT 'new',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      jti TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS reader_tokens (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      purchase_id INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS preview_tokens (
      token TEXT PRIMARY KEY,
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS author_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      phone TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','approved','rejected')) DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      decided_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_purchases_user ON purchases(user_id);
    CREATE INDEX IF NOT EXISTS idx_purchases_book ON purchases(book_id);
    CREATE INDEX IF NOT EXISTS idx_books_owner ON books(owner_user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_author_requests_user ON author_requests(user_id);
    CREATE INDEX IF NOT EXISTS idx_author_requests_status ON author_requests(status);
  `);

  // Lightweight migration: add Google Sign-In columns to a users table that
  // may already exist from before this feature (checks the live schema
  // rather than assuming a version).
  const userColumns = (await all("PRAGMA table_info(users)")).map((c) => c.name);
  if (!userColumns.includes('google_id')) {
    await client.execute('ALTER TABLE users ADD COLUMN google_id TEXT');
    await client.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id) WHERE google_id IS NOT NULL');
  }
  if (!userColumns.includes('avatar_url')) {
    await client.execute('ALTER TABLE users ADD COLUMN avatar_url TEXT');
  }

  initialized = true;
}

module.exports = { get, all, run, batch, init };
