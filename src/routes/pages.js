const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { isEmail, cleanText } = require('../utils/validate');
const { sendMail } = require('../utils/mailer');
const sheetsSync = require('../utils/sheetsSync');
const rateLimit = require('express-rate-limit');
const storage = require('../utils/storage');
const { COVER_BUCKET } = require('../middleware/upload');

const router = express.Router();

// Covers are non-sensitive but still proxied (rather than served from a
// public bucket URL) since our storage provider's free tier only grants one
// bucket, shared with private PDFs - cover_path values are server-generated
// random filenames, so this stays safe to cache aggressively.
router.get('/covers/:filename', async (req, res) => {
  let stream;
  try {
    stream = await storage.getObjectStream(COVER_BUCKET, req.params.filename);
  } catch {
    return res.status(404).end();
  }
  res.set({
    'Content-Type': 'image/webp',
    'Cache-Control': 'public, max-age=31536000, immutable',
  });
  stream.pipe(res);
});

const BOOK_COLUMNS = [
  'id', 'title', 'author_name', 'description', 'price_nu', 'category',
  'page_count', 'cover_path', 'preview_pages', 'created_at',
];
const PUBLIC_BOOK_FIELDS = BOOK_COLUMNS.join(', ');
const PUBLIC_BOOK_FIELDS_B = BOOK_COLUMNS.map((c) => `b.${c}`).join(', ');

async function bestSellers(limit = 3) {
  const bySales = await db.all(`
    SELECT ${PUBLIC_BOOK_FIELDS_B},
           COUNT(p.id) AS sales_count
    FROM books b
    JOIN purchases p ON p.book_id = b.id AND p.payment_status = 'completed'
    WHERE b.status = 'active'
    GROUP BY b.id
    ORDER BY sales_count DESC, b.created_at DESC
    LIMIT ?
  `, [limit]);

  if (bySales.length >= limit) return bySales;

  // Not enough real sales yet - fill remaining slots with the newest active
  // catalog books (still real books, never placeholders) so the carousel
  // never looks empty before the first purchase happens.
  const excludeIds = bySales.map((b) => b.id);
  const placeholders = excludeIds.length ? excludeIds.map(() => '?').join(',') : null;
  const fillerSql = `
    SELECT ${PUBLIC_BOOK_FIELDS}, 0 AS sales_count FROM books
    WHERE status = 'active' ${placeholders ? `AND id NOT IN (${placeholders})` : ''}
    ORDER BY created_at DESC
    LIMIT ?
  `;
  const filler = await db.all(fillerSql, [...excludeIds, limit - bySales.length]);
  return [...bySales, ...filler];
}

router.get('/', async (req, res) => {
  const featured = await bestSellers(3);
  res.render('landing', { title: 'Bhutan Reads', featured });
});

router.get('/library', async (req, res) => {
  const category = cleanText(req.query.category, 60);
  let books;
  if (category) {
    books = await db.all(`SELECT ${PUBLIC_BOOK_FIELDS} FROM books WHERE status='active' AND category = ? ORDER BY created_at DESC`, [category]);
  } else {
    books = await db.all(`SELECT ${PUBLIC_BOOK_FIELDS} FROM books WHERE status='active' ORDER BY created_at DESC`);
  }
  const categories = (await db.all(`SELECT DISTINCT category FROM books WHERE status='active' ORDER BY category`)).map((r) => r.category);
  res.render('library', { title: 'Library', books, categories, activeCategory: category });
});

router.get('/books/:id', async (req, res) => {
  const book = await db.get(`SELECT ${PUBLIC_BOOK_FIELDS} FROM books WHERE id = ? AND status='active'`, [req.params.id]);
  if (!book) return res.status(404).render('error', { title: 'Not found', message: 'This book could not be found.' });

  let owned = false;
  if (req.user) {
    const purchase = await db.get(
      `SELECT id FROM purchases WHERE user_id = ? AND book_id = ? AND payment_status = 'completed' LIMIT 1`,
      [req.user.id, book.id]
    );
    owned = Boolean(purchase);
  }

  res.render('book-detail', { title: book.title, book, owned });
});

router.get('/my-library', requireAuth, async (req, res) => {
  const books = await db.all(`
    SELECT b.id, b.title, b.author_name, b.cover_path, b.category, MAX(p.created_at) as purchased_at
    FROM purchases p
    JOIN books b ON b.id = p.book_id
    WHERE p.user_id = ? AND p.payment_status = 'completed'
    GROUP BY b.id
    ORDER BY purchased_at DESC
  `, [req.user.id]);
  res.render('my-library', { title: 'My Library', books });
});

router.get('/feedback', (req, res) => {
  res.render('feedback', { title: 'Query & Feedback', error: null, sent: false });
});

const feedbackLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });

router.post('/feedback', feedbackLimiter, verifyCsrf, async (req, res) => {
  const email = cleanText(req.body.email, 254);
  const message = cleanText(req.body.message, 4000);

  if (!isEmail(email) || !message) {
    return res.status(400).render('feedback', { title: 'Query & Feedback', error: 'Please provide a valid email and a message.', sent: false });
  }

  const info = await db.run('INSERT INTO feedback (user_id, email, message) VALUES (?, ?, ?)', [
    req.user ? req.user.id : null,
    email,
    message,
  ]);

  sheetsSync.syncFeedback({ id: info.lastInsertRowid, email, user_id: req.user ? req.user.id : null, message });

  // The feedback row above is already saved regardless of whether this
  // notification email succeeds - never fail the user-facing request over
  // an SMTP hiccup (e.g. some hosts block outbound SMTP entirely).
  sendMail({
    to: process.env.FEEDBACK_TO_EMAIL,
    subject: `Bhutan Reads - Query & Feedback from ${email}`,
    text: `From: ${email}\nUser: ${req.user ? `${req.user.name} (#${req.user.id})` : 'Guest'}\n\n${message}`,
    replyTo: email,
  }).catch((e) => console.error('Feedback notification email failed:', e));

  res.render('feedback', { title: 'Query & Feedback', error: null, sent: true });
});

module.exports = router;
