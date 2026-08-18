const crypto = require('node:crypto');
const db = require('../db/db');

const TTL_MS = 90 * 1000; // short-lived: reader page mints a fresh one as needed

function issueReaderToken(userId, bookId, purchaseId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO reader_tokens (token, user_id, book_id, purchase_id, expires_at) VALUES (?, ?, ?, ?, ?)`
  ).run(token, userId, bookId, purchaseId, expiresAt);
  return token;
}

// Single-use, short-lived, bound to the exact user+book. Even if a URL
// leaks, it stops working within seconds and cannot be replayed.
function consumeReaderToken(token, userId, bookId) {
  const row = db.prepare('SELECT * FROM reader_tokens WHERE token = ?').get(token);
  if (!row) return false;
  if (row.used) return false;
  if (row.user_id !== userId || row.book_id !== bookId) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  db.prepare('UPDATE reader_tokens SET used = 1 WHERE token = ?').run(token);
  return true;
}

function issuePreviewToken(bookId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO preview_tokens (token, book_id, expires_at) VALUES (?, ?, ?)`
  ).run(token, bookId, expiresAt);
  return token;
}

function consumePreviewToken(token, bookId) {
  const row = db.prepare('SELECT * FROM preview_tokens WHERE token = ?').get(token);
  if (!row) return false;
  if (row.used) return false;
  if (row.book_id !== bookId) return false;
  if (new Date(row.expires_at).getTime() < Date.now()) return false;
  db.prepare('UPDATE preview_tokens SET used = 1 WHERE token = ?').run(token);
  return true;
}

module.exports = { issueReaderToken, consumeReaderToken, issuePreviewToken, consumePreviewToken };
