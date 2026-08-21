const express = require('express');
const crypto = require('node:crypto');
const db = require('../db/db');
const { requireAuth } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { sendMail } = require('../utils/mailer');
const sheetsSync = require('../utils/sheetsSync');

const router = express.Router();

const PROVIDER = process.env.PAYMENT_PROVIDER || 'dev-test';
const isDevProvider = !process.env.PAYMENT_SECRET_KEY;

// Step 1: start a purchase. The price is always read from the database -
// nothing about cost is ever accepted from the client.
router.post('/create', requireAuth, verifyCsrf, async (req, res) => {
  const bookId = Number(req.body.bookId);
  if (!Number.isInteger(bookId)) return res.status(400).json({ error: 'Invalid book' });

  const book = await db.get(`SELECT id, title, price_nu FROM books WHERE id = ? AND status = 'active'`, [bookId]);
  if (!book) return res.status(404).json({ error: 'Book not found' });

  const alreadyOwned = await db.get(
    `SELECT id FROM purchases WHERE user_id = ? AND book_id = ? AND payment_status = 'completed' LIMIT 1`,
    [req.user.id, book.id]
  );
  if (alreadyOwned) return res.status(409).json({ error: 'You already own this book', alreadyOwned: true });

  const ref = `BR-${Date.now().toString(36).toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const info = await db.run(`
    INSERT INTO purchases (user_id, book_id, amount, currency, transaction_ref, payment_provider, payment_status)
    VALUES (?, ?, ?, 'Nu.', ?, ?, 'pending')
  `, [req.user.id, book.id, book.price_nu, ref, PROVIDER]);

  res.json({
    purchaseId: info.lastInsertRowid,
    amount: book.price_nu,
    currency: 'Nu.',
    reference: ref,
    bookTitle: book.title,
    devMode: isDevProvider,
  });
});

// Step 2: confirm payment. In the dev/test flow this endpoint plays the role
// of a verified provider callback (simulated locally, clearly separated from
// any real transaction). When PAYMENT_SECRET_KEY is configured for a real
// provider, this handler should be replaced by a signature-verified webhook
// that calls the same completePurchase() logic - the frontend/API contract
// does not need to change.
router.post('/confirm', requireAuth, verifyCsrf, async (req, res) => {
  const purchaseId = Number(req.body.purchaseId);
  if (!Number.isInteger(purchaseId)) return res.status(400).json({ error: 'Invalid purchase' });

  const purchase = await db.get('SELECT * FROM purchases WHERE id = ?', [purchaseId]);
  if (!purchase || purchase.user_id !== req.user.id) {
    return res.status(404).json({ error: 'Purchase not found' });
  }

  if (purchase.payment_status === 'completed') {
    return res.json({ status: 'completed', purchaseId: purchase.id });
  }

  if (!isDevProvider) {
    // Real providers must be confirmed via their own verified webhook, never
    // by a client-initiated call like this one.
    return res.status(400).json({ error: 'This deployment uses a live payment provider; confirmation must come from the provider webhook.' });
  }

  await db.run(
    `UPDATE purchases SET payment_status = 'completed', completed_at = datetime('now') WHERE id = ?`,
    [purchase.id]
  );

  res.json({ status: 'completed', purchaseId: purchase.id });

  // Fire-and-forget purchase notification - never blocks or fails the
  // response the buyer is waiting on; sendMail() already falls back to a
  // console log when SMTP isn't configured, so this is safe in dev too.
  const completed = await db.get(
    `SELECT p.*, u.name AS user_name, u.email AS user_email, u.phone AS user_phone, b.title AS book_title
     FROM purchases p JOIN users u ON u.id = p.user_id JOIN books b ON b.id = p.book_id WHERE p.id = ?`,
    [purchase.id]
  );
  sendMail({
    to: process.env.FEEDBACK_TO_EMAIL,
    subject: `Bhutan Reads - New purchase: ${completed.book_title}`,
    text: [
      `A purchase was completed on Bhutan Reads.`,
      ``,
      `Customer: ${completed.user_name} (${completed.user_email || completed.user_phone || 'no contact on file'})`,
      `Book: ${completed.book_title}`,
      `Amount paid: ${completed.currency} ${completed.amount}`,
      `Transaction / reference ID: ${completed.transaction_ref}`,
      `Order ID: ${completed.id}`,
      `Payment status: ${completed.payment_status}`,
      `Date/time: ${completed.completed_at}`,
    ].join('\n'),
  }).catch((e) => console.error('Purchase notification email failed:', e));

  sheetsSync.syncPurchase({
    id: completed.id,
    buyer_name: completed.user_name,
    buyer_contact: completed.user_email || completed.user_phone,
    book_title: completed.book_title,
    amount: `${completed.currency} ${completed.amount}`,
    transaction_ref: completed.transaction_ref,
    payment_status: completed.payment_status,
    completed_at: completed.completed_at,
  });
});

module.exports = router;
