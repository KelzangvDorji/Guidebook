const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/db');
const { requireRole } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { revokeAllSessionsForUser } = require('../utils/auth');
const { PDF_DIR, COVER_DIR } = require('../middleware/upload');
const sheetsSync = require('../utils/sheetsSync');

const router = express.Router();
router.use('/admin', requireRole('admin'));

router.get('/admin/dashboard', (req, res) => {
  const totalUsers = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='user'`).get().c;
  const totalAuthors = db.prepare(`SELECT COUNT(*) c FROM users WHERE role='author'`).get().c;
  const totalBooks = db.prepare(`SELECT COUNT(*) c FROM books`).get().c;
  const totalPurchases = db.prepare(`SELECT COUNT(*) c FROM purchases WHERE payment_status='completed'`).get().c;
  const totalSales = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM purchases WHERE payment_status='completed'`).get().s;
  const pendingAuthorRequests = db.prepare(`SELECT COUNT(*) c FROM author_requests WHERE status='pending'`).get().c;

  const recentTransactions = db.prepare(`
    SELECT p.*, u.name AS buyer_name, u.email AS buyer_email, b.title AS book_title
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    JOIN books b ON b.id = p.book_id
    ORDER BY p.created_at DESC
    LIMIT 10
  `).all();

  const latestBuyers = db.prepare(`
    SELECT u.id, u.name, u.email, u.phone, MAX(p.created_at) AS last_purchase
    FROM purchases p JOIN users u ON u.id = p.user_id
    WHERE p.payment_status='completed'
    GROUP BY u.id ORDER BY last_purchase DESC LIMIT 8
  `).all();

  const popularBooks = db.prepare(`
    SELECT b.id, b.title, b.author_name, COUNT(p.id) AS sales_count, COALESCE(SUM(p.amount),0) AS revenue
    FROM books b JOIN purchases p ON p.book_id = b.id AND p.payment_status='completed'
    GROUP BY b.id ORDER BY sales_count DESC LIMIT 8
  `).all();

  const salesByDay = db.prepare(`
    SELECT date(created_at) AS day, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
    FROM purchases WHERE payment_status='completed' AND created_at >= datetime('now','-30 days')
    GROUP BY day ORDER BY day ASC
  `).all();

  res.render('admin-dashboard', {
    title: 'Admin Dashboard',
    stats: { totalUsers, totalAuthors, totalBooks, totalPurchases, totalSales, pendingAuthorRequests },
    recentTransactions, latestBuyers, popularBooks, salesByDay,
  });
});

router.get('/admin/users', (req, res) => {
  const users = db.prepare(`SELECT id, name, email, phone, role, created_at FROM users ORDER BY created_at DESC`).all();
  res.render('admin-users', { title: 'Manage Users', users, currentUserId: req.user.id });
});

router.post('/admin/users/:id/role', verifyCsrf, (req, res) => {
  const targetId = Number(req.params.id);
  const role = req.body.role;
  if (!['user', 'author', 'admin'].includes(role)) return res.status(400).render('error', { title: 'Invalid role', message: 'Unknown role.' });
  if (targetId === req.user.id) return res.status(400).render('error', { title: 'Not allowed', message: 'You cannot change your own role.' });

  db.prepare(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`).run(role, targetId);
  revokeAllSessionsForUser(targetId); // force re-login so the new role takes effect immediately, not via stale session
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/delete', verifyCsrf, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) return res.status(400).render('error', { title: 'Not allowed', message: 'You cannot delete your own account.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(targetId);
  res.redirect('/admin/users');
});

router.get('/admin/books', (req, res) => {
  const books = db.prepare(`
    SELECT b.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM purchases p WHERE p.book_id=b.id AND p.payment_status='completed') AS sales_count
    FROM books b LEFT JOIN users u ON u.id = b.owner_user_id
    ORDER BY b.created_at DESC
  `).all();
  res.render('admin-books', { title: 'Manage Books', books });
});

router.post('/admin/books/:id/status', verifyCsrf, (req, res) => {
  const status = req.body.status === 'hidden' ? 'hidden' : 'active';
  db.prepare(`UPDATE books SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, req.params.id);
  res.redirect('/admin/books');
});

router.post('/admin/books/:id/delete', verifyCsrf, (req, res) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book) return res.redirect('/admin/books');
  const hasSales = db.prepare(`SELECT COUNT(*) c FROM purchases WHERE book_id=? AND payment_status='completed'`).get(book.id).c > 0;
  if (hasSales) {
    db.prepare(`UPDATE books SET status='hidden', updated_at=datetime('now') WHERE id = ?`).run(book.id);
  } else {
    db.prepare('DELETE FROM books WHERE id = ?').run(book.id);
    const pdfPath = path.join(PDF_DIR, book.pdf_filename);
    if (pdfPath.startsWith(PDF_DIR) && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    if (book.cover_path) {
      const coverPath = path.join(COVER_DIR, book.cover_path);
      if (coverPath.startsWith(COVER_DIR) && fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    }
  }
  res.redirect('/admin/books');
});

router.get('/admin/transactions', (req, res) => {
  const transactions = db.prepare(`
    SELECT p.*, u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone, b.title AS book_title
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    JOIN books b ON b.id = p.book_id
    ORDER BY p.created_at DESC
  `).all();
  res.render('admin-transactions', { title: 'Transactions', transactions });
});

router.get('/admin/author-requests', (req, res) => {
  const requests = db.prepare(`
    SELECT r.*, u.name AS user_name, u.email AS user_email
    FROM author_requests r JOIN users u ON u.id = r.user_id
    ORDER BY (r.status = 'pending') DESC, r.created_at DESC
  `).all();
  res.render('admin-author-requests', { title: 'Author Requests', requests });
});

router.post('/admin/author-requests/:id/approve', verifyCsrf, (req, res) => {
  const request = db.prepare(`SELECT r.*, u.name AS user_name FROM author_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?`).get(req.params.id);
  if (!request || request.status !== 'pending') return res.redirect('/admin/author-requests');

  db.prepare(`UPDATE author_requests SET status = 'approved', decided_at = datetime('now') WHERE id = ?`).run(request.id);
  db.prepare(`UPDATE users SET role = 'author', updated_at = datetime('now') WHERE id = ?`).run(request.user_id);
  sheetsSync.syncAuthorRequest(request, 'approved');
  res.redirect('/admin/author-requests');
});

router.post('/admin/author-requests/:id/reject', verifyCsrf, (req, res) => {
  const request = db.prepare(`SELECT r.*, u.name AS user_name FROM author_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.status = 'pending'`).get(req.params.id);
  if (!request) return res.redirect('/admin/author-requests');

  db.prepare(`UPDATE author_requests SET status = 'rejected', decided_at = datetime('now') WHERE id = ?`).run(request.id);
  sheetsSync.syncAuthorRequest(request, 'rejected');
  res.redirect('/admin/author-requests');
});

router.get('/admin/feedback', (req, res) => {
  const items = db.prepare(`SELECT * FROM feedback ORDER BY created_at DESC`).all();
  res.render('admin-feedback', { title: 'Feedback', items });
});

router.post('/admin/feedback/:id/read', verifyCsrf, (req, res) => {
  db.prepare(`UPDATE feedback SET status='read' WHERE id = ?`).run(req.params.id);
  res.redirect('/admin/feedback');
});

module.exports = router;
