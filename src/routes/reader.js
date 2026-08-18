const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const rateLimit = require('express-rate-limit');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { issueReaderToken, consumeReaderToken, issuePreviewToken, consumePreviewToken } = require('../utils/readerToken');
const { buildPreviewBuffer } = require('../utils/previewPdf');
const { PDF_DIR } = require('../middleware/upload');

const router = express.Router();

const previewLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

function getOwnedBookOr403(req, res) {
  const bookId = Number(req.params.bookId);
  if (!Number.isInteger(bookId)) {
    res.status(400);
    return null;
  }
  const book = db.prepare(`SELECT * FROM books WHERE id = ? AND status = 'active'`).get(bookId);
  if (!book) {
    res.status(404);
    return null;
  }
  const purchase = db.prepare(
    `SELECT * FROM purchases WHERE user_id = ? AND book_id = ? AND payment_status = 'completed' ORDER BY id DESC LIMIT 1`
  ).get(req.user.id, bookId);
  if (!purchase) {
    res.status(403);
    return null;
  }
  return { book, purchase };
}

// Reader page: requires auth + server-verified ownership. Never links to the
// underlying storage path - the page only knows the book id.
router.get('/read/:bookId', requireAuth, (req, res) => {
  const found = getOwnedBookOr403(req, res);
  if (!found) {
    if (res.statusCode === 403) return res.status(403).render('error', { title: 'Not purchased', message: 'You need to buy this book before you can read it.' });
    return res.status(res.statusCode).render('error', { title: 'Not found', message: 'This book could not be found.' });
  }
  const { book } = found;
  res.set('X-Frame-Options', 'DENY');
  res.render('reader', {
    title: `Reading: ${book.title}`,
    book: { id: book.id, title: book.title, author_name: book.author_name, page_count: book.page_count },
    mode: 'full',
  });
});

// Public preview: no purchase required, but the server truncates the file to
// only the first `preview_pages` pages before it ever leaves storage, so
// this can never be used to read the full book for free.
router.get('/books/:id/preview', (req, res) => {
  const bookId = Number(req.params.id);
  const book = db.prepare(`SELECT * FROM books WHERE id = ? AND status = 'active'`).get(bookId);
  if (!book || book.preview_pages < 1) {
    return res.status(404).render('error', { title: 'No preview available', message: 'This book does not have a preview.' });
  }
  res.set('X-Frame-Options', 'DENY');
  res.render('reader', {
    title: `Preview: ${book.title}`,
    book: { id: book.id, title: book.title, author_name: book.author_name, page_count: book.preview_pages },
    mode: 'preview',
  });
});

router.post('/api/preview/:bookId/token', previewLimiter, (req, res) => {
  const bookId = Number(req.params.bookId);
  const book = db.prepare(`SELECT id, preview_pages FROM books WHERE id = ? AND status = 'active'`).get(bookId);
  if (!book || book.preview_pages < 1) return res.status(404).json({ error: 'No preview available' });
  const token = issuePreviewToken(book.id);
  res.json({ token });
});

router.get('/api/preview/:bookId/stream', previewLimiter, async (req, res) => {
  const bookId = Number(req.params.bookId);
  const token = String(req.query.token || '');
  if (!Number.isInteger(bookId) || !consumePreviewToken(token, bookId)) {
    return res.status(403).json({ error: 'Invalid or expired preview token' });
  }
  const book = db.prepare(`SELECT pdf_filename, preview_pages FROM books WHERE id = ?`).get(bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(PDF_DIR, book.pdf_filename);
  if (!filePath.startsWith(PDF_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  try {
    const preview = await buildPreviewBuffer(filePath, book.preview_pages);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="preview.pdf"',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache',
      'X-Content-Type-Options': 'nosniff',
    });
    res.send(preview);
  } catch (e) {
    res.status(500).json({ error: 'Could not generate preview' });
  }
});

// Mints a short-lived, single-use, user+book-bound token used once to fetch
// the PDF bytes for rendering. Re-verifies ownership server-side every time.
router.post('/api/reader/:bookId/token', requireAuth, (req, res) => {
  const found = getOwnedBookOr403(req, res);
  if (!found) return res.status(res.statusCode).json({ error: 'Not authorized for this book' });
  const token = issueReaderToken(req.user.id, found.book.id, found.purchase.id);
  res.json({ token, watermark: { name: req.user.name, contact: req.user.email || req.user.phone, purchaseId: found.purchase.id } });
});

// Streams the private PDF bytes. Requires a valid session AND a fresh
// single-use token scoped to this exact user+book - the storage path itself
// is never exposed to the client.
router.get('/api/reader/:bookId/stream', requireAuth, (req, res) => {
  const bookId = Number(req.params.bookId);
  const token = String(req.query.token || '');
  if (!Number.isInteger(bookId) || !consumeReaderToken(token, req.user.id, bookId)) {
    return res.status(403).json({ error: 'Invalid or expired reader token' });
  }
  const book = db.prepare(`SELECT pdf_filename FROM books WHERE id = ?`).get(bookId);
  if (!book) return res.status(404).json({ error: 'Not found' });

  const filePath = path.join(PDF_DIR, book.pdf_filename);
  if (!filePath.startsWith(PDF_DIR) || !fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Not found' });
  }

  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': 'inline; filename="document.pdf"',
    'Cache-Control': 'no-store, no-cache, must-revalidate, private',
    Pragma: 'no-cache',
    'X-Content-Type-Options': 'nosniff',
  });
  fs.createReadStream(filePath).pipe(res);
});

module.exports = router;
