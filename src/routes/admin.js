const express = require('express');
const db = require('../db/db');
const { requireRole } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { revokeAllSessionsForUser } = require('../utils/auth');
const { PDF_BUCKET, COVER_BUCKET } = require('../middleware/upload');
const sheetsSync = require('../utils/sheetsSync');
const storage = require('../utils/storage');

const router = express.Router();
router.use('/admin', requireRole('admin'));

router.get('/admin/dashboard', async (req, res) => {
  const totalUsers = (await db.get(`SELECT COUNT(*) c FROM users WHERE role='user'`)).c;
  const totalAuthors = (await db.get(`SELECT COUNT(*) c FROM users WHERE role='author'`)).c;
  const totalBooks = (await db.get(`SELECT COUNT(*) c FROM books`)).c;
  const totalPurchases = (await db.get(`SELECT COUNT(*) c FROM purchases WHERE payment_status='completed'`)).c;
  const totalSales = (await db.get(`SELECT COALESCE(SUM(amount),0) s FROM purchases WHERE payment_status='completed'`)).s;
  const pendingAuthorRequests = (await db.get(`SELECT COUNT(*) c FROM author_requests WHERE status='pending'`)).c;

  const recentTransactions = await db.all(`
    SELECT p.*, u.name AS buyer_name, u.email AS buyer_email, b.title AS book_title
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    JOIN books b ON b.id = p.book_id
    ORDER BY p.created_at DESC
    LIMIT 10
  `);

  const latestBuyers = await db.all(`
    SELECT u.id, u.name, u.email, u.phone, MAX(p.created_at) AS last_purchase
    FROM purchases p JOIN users u ON u.id = p.user_id
    WHERE p.payment_status='completed'
    GROUP BY u.id ORDER BY last_purchase DESC LIMIT 8
  `);

  const popularBooks = await db.all(`
    SELECT b.id, b.title, b.author_name, COUNT(p.id) AS sales_count, COALESCE(SUM(p.amount),0) AS revenue
    FROM books b JOIN purchases p ON p.book_id = b.id AND p.payment_status='completed'
    GROUP BY b.id ORDER BY sales_count DESC LIMIT 8
  `);

  const salesByDay = await db.all(`
    SELECT date(created_at) AS day, COUNT(*) AS count, COALESCE(SUM(amount),0) AS total
    FROM purchases WHERE payment_status='completed' AND created_at >= datetime('now','-30 days')
    GROUP BY day ORDER BY day ASC
  `);

  res.render('admin-dashboard', {
    title: 'Admin Dashboard',
    stats: { totalUsers, totalAuthors, totalBooks, totalPurchases, totalSales, pendingAuthorRequests },
    recentTransactions, latestBuyers, popularBooks, salesByDay,
  });
});

router.get('/admin/users', async (req, res) => {
  const users = await db.all(`SELECT id, name, email, phone, role, created_at FROM users ORDER BY created_at DESC`);
  res.render('admin-users', { title: 'Manage Users', users, currentUserId: req.user.id });
});

router.post('/admin/users/:id/role', verifyCsrf, async (req, res) => {
  const targetId = Number(req.params.id);
  const role = req.body.role;
  if (!['user', 'author', 'admin'].includes(role)) return res.status(400).render('error', { title: 'Invalid role', message: 'Unknown role.' });
  if (targetId === req.user.id) return res.status(400).render('error', { title: 'Not allowed', message: 'You cannot change your own role.' });

  await db.run(`UPDATE users SET role = ?, updated_at = datetime('now') WHERE id = ?`, [role, targetId]);
  await revokeAllSessionsForUser(targetId); // force re-login so the new role takes effect immediately, not via stale session
  res.redirect('/admin/users');
});

router.post('/admin/users/:id/delete', verifyCsrf, async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.user.id) return res.status(400).render('error', { title: 'Not allowed', message: 'You cannot delete your own account.' });
  await db.run('DELETE FROM users WHERE id = ?', [targetId]);
  res.redirect('/admin/users');
});

router.get('/admin/books', async (req, res) => {
  const books = await db.all(`
    SELECT b.*, u.name AS owner_name,
      (SELECT COUNT(*) FROM purchases p WHERE p.book_id=b.id AND p.payment_status='completed') AS sales_count
    FROM books b LEFT JOIN users u ON u.id = b.owner_user_id
    ORDER BY b.created_at DESC
  `);
  res.render('admin-books', { title: 'Manage Books', books });
});

router.post('/admin/books/:id/status', verifyCsrf, async (req, res) => {
  const status = req.body.status === 'hidden' ? 'hidden' : 'active';
  await db.run(`UPDATE books SET status = ?, updated_at = datetime('now') WHERE id = ?`, [status, req.params.id]);
  res.redirect('/admin/books');
});

router.post('/admin/books/:id/delete', verifyCsrf, async (req, res) => {
  const book = await db.get('SELECT * FROM books WHERE id = ?', [req.params.id]);
  if (!book) return res.redirect('/admin/books');
  const hasSales = (await db.get(`SELECT COUNT(*) c FROM purchases WHERE book_id=? AND payment_status='completed'`, [book.id])).c > 0;
  if (hasSales) {
    await db.run(`UPDATE books SET status='hidden', updated_at=datetime('now') WHERE id = ?`, [book.id]);
  } else {
    await db.run('DELETE FROM books WHERE id = ?', [book.id]);
    await storage.deleteObject(PDF_BUCKET, book.pdf_filename);
    if (book.cover_path) {
      await storage.deleteObject(COVER_BUCKET, book.cover_path);
    }
  }
  res.redirect('/admin/books');
});

router.get('/admin/transactions', async (req, res) => {
  const transactions = await db.all(`
    SELECT p.*, u.name AS buyer_name, u.email AS buyer_email, u.phone AS buyer_phone, b.title AS book_title
    FROM purchases p
    JOIN users u ON u.id = p.user_id
    JOIN books b ON b.id = p.book_id
    ORDER BY p.created_at DESC
  `);
  res.render('admin-transactions', { title: 'Transactions', transactions });
});

router.get('/admin/author-requests', async (req, res) => {
  const requests = await db.all(`
    SELECT r.*, u.name AS user_name, u.email AS user_email
    FROM author_requests r JOIN users u ON u.id = r.user_id
    ORDER BY (r.status = 'pending') DESC, r.created_at DESC
  `);
  res.render('admin-author-requests', { title: 'Author Requests', requests });
});

router.post('/admin/author-requests/:id/approve', verifyCsrf, async (req, res) => {
  const request = await db.get(`SELECT r.*, u.name AS user_name FROM author_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?`, [req.params.id]);
  if (!request || request.status !== 'pending') return res.redirect('/admin/author-requests');

  // Both updates commit atomically - a request should never end up marked
  // "approved" while the user's role failed to change.
  await db.batch([
    { sql: `UPDATE author_requests SET status = 'approved', decided_at = datetime('now') WHERE id = ?`, args: [request.id] },
    { sql: `UPDATE users SET role = 'author', updated_at = datetime('now') WHERE id = ?`, args: [request.user_id] },
  ]);
  sheetsSync.syncAuthorRequest(request, 'approved');
  res.redirect('/admin/author-requests');
});

router.post('/admin/author-requests/:id/reject', verifyCsrf, async (req, res) => {
  const request = await db.get(`SELECT r.*, u.name AS user_name FROM author_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ? AND r.status = 'pending'`, [req.params.id]);
  if (!request) return res.redirect('/admin/author-requests');

  await db.run(`UPDATE author_requests SET status = 'rejected', decided_at = datetime('now') WHERE id = ?`, [request.id]);
  sheetsSync.syncAuthorRequest(request, 'rejected');
  res.redirect('/admin/author-requests');
});

router.get('/admin/feedback', async (req, res) => {
  const items = await db.all(`SELECT * FROM feedback ORDER BY created_at DESC`);
  res.render('admin-feedback', { title: 'Feedback', items });
});

router.post('/admin/feedback/:id/read', verifyCsrf, async (req, res) => {
  await db.run(`UPDATE feedback SET status='read' WHERE id = ?`, [req.params.id]);
  res.redirect('/admin/feedback');
});

module.exports = router;
