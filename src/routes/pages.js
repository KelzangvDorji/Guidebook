const express = require('express');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { isEmail, cleanText } = require('../utils/validate');
const { sendMail } = require('../utils/mailer');
const sheetsSync = require('../utils/sheetsSync');
const rateLimit = require('express-rate-limit');

const router = express.Router();

const BOOK_COLUMNS = [
  'id', 'title', 'author_name', 'description', 'price_nu', 'category',
  'page_count', 'cover_path', 'preview_pages', 'created_at',
];
const PUBLIC_BOOK_FIELDS = BOOK_COLUMNS.join(', ');
const PUBLIC_BOOK_FIELDS_B = BOOK_COLUMNS.map((c) => `b.${c}`).join(', ');

function bestSellers(limit = 3) {
  const bySales = db.prepare(`
    SELECT ${PUBLIC_BOOK_FIELDS_B},
           COUNT(p.id) AS sales_count
    FROM books b
    JOIN purchases p ON p.book_id = b.id AND p.payment_status = 'completed'
    WHERE b.status = 'active'
    GROUP BY b.id
    ORDER BY sales_count DESC, b.created_at DESC
    LIMIT ?
  `).all(limit);

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
  const filler = db.prepare(fillerSql).all(...excludeIds, limit - bySales.length);
  return [...bySales, ...filler];
}

router.get('/', (req, res) => {
  const featured = bestSellers(3);
  res.render('landing', { title: 'Bhutan Reads', featured });
});

router.get('/library', (req, res) => {
  const category = cleanText(req.query.category, 60);
  let books;
  if (category) {
    books = db.prepare(`SELECT ${PUBLIC_BOOK_FIELDS} FROM books WHERE status='active' AND category = ? ORDER BY created_at DESC`).all(category);
  } else {
    books = db.prepare(`SELECT ${PUBLIC_BOOK_FIELDS} FROM books WHERE status='active' ORDER BY created_at DESC`).all();
  }
  const categories = db.prepare(`SELECT DISTINCT category FROM books WHERE status='active' ORDER BY category`).all().map((r) => r.category);
  res.render('library', { title: 'Library', books, categories, activeCategory: category });
});

router.get('/books/:id', (req, res) => {
  const book = db.prepare(`SELECT ${PUBLIC_BOOK_FIELDS} FROM books WHERE id = ? AND status='active'`).get(req.params.id);
  if (!book) return res.status(404).render('error', { title: 'Not found', message: 'This book could not be found.' });

  let owned = false;
  if (req.user) {
    const purchase = db.prepare(
      `SELECT id FROM purchases WHERE user_id = ? AND book_id = ? AND payment_status = 'completed' LIMIT 1`
    ).get(req.user.id, book.id);
    owned = Boolean(purchase);
  }

  res.render('book-detail', { title: book.title, book, owned });
});

router.get('/my-library', requireAuth, (req, res) => {
  const books = db.prepare(`
    SELECT b.id, b.title, b.author_name, b.cover_path, b.category, MAX(p.created_at) as purchased_at
    FROM purchases p
    JOIN books b ON b.id = p.book_id
    WHERE p.user_id = ? AND p.payment_status = 'completed'
    GROUP BY b.id
    ORDER BY purchased_at DESC
  `).all(req.user.id);
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

  const info = db.prepare('INSERT INTO feedback (user_id, email, message) VALUES (?, ?, ?)').run(
    req.user ? req.user.id : null,
    email,
    message
  );

  sheetsSync.syncFeedback({ id: info.lastInsertRowid, email, user_id: req.user ? req.user.id : null, message });

  await sendMail({
    to: process.env.FEEDBACK_TO_EMAIL,
    subject: `Bhutan Reads - Query & Feedback from ${email}`,
    text: `From: ${email}\nUser: ${req.user ? `${req.user.name} (#${req.user.id})` : 'Guest'}\n\n${message}`,
    replyTo: email,
  });

  res.render('feedback', { title: 'Query & Feedback', error: null, sent: true });
});

module.exports = router;
