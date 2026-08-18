const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db/db');
const { requireRole } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { upload, persistUploadedFiles, PDF_DIR, COVER_DIR } = require('../middleware/upload');
const { cleanText, toPriceNu, toPositiveInt } = require('../utils/validate');
const { PDFParse } = require('pdf-parse');
const sheetsSync = require('../utils/sheetsSync');

const router = express.Router();
router.use('/author', requireRole('author'));

function getOwnBookOr404(req, res) {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(req.params.id);
  if (!book || book.owner_user_id !== req.user.id) {
    res.status(404).render('error', { title: 'Not found', message: 'Book not found.' });
    return null;
  }
  return book;
}

router.get('/author/dashboard', (req, res) => {
  const books = db.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM purchases p WHERE p.book_id = b.id AND p.payment_status='completed') AS sales_count,
      (SELECT COALESCE(SUM(p.amount),0) FROM purchases p WHERE p.book_id = b.id AND p.payment_status='completed') AS earnings
    FROM books b
    WHERE b.owner_user_id = ?
    ORDER BY b.created_at DESC
  `).all(req.user.id);

  const totals = books.reduce((acc, b) => ({
    sales: acc.sales + b.sales_count,
    earnings: acc.earnings + b.earnings,
  }), { sales: 0, earnings: 0 });

  res.render('author-dashboard', { title: 'Author Dashboard', books, totals, error: req.query.error || null });
});

router.get('/author/books/new', (req, res) => {
  res.render('author-book-form', { title: 'Add Book', book: null, error: null });
});

router.get('/author/books/:id/edit', (req, res) => {
  const book = getOwnBookOr404(req, res);
  if (!book) return;
  res.render('author-book-form', { title: 'Edit Book', book, error: null });
});

router.post('/author/books', verifyCsrf, (req, res, next) => {
  upload(req, res, async (err) => {
    if (err) return res.render('author-book-form', { title: 'Add Book', book: null, error: err.message });
    try {
      const title = cleanText(req.body.title, 200);
      const author_name = cleanText(req.body.author_name, 150);
      const description = cleanText(req.body.description, 5000);
      const category = cleanText(req.body.category, 60) || 'General';
      const price_nu = toPriceNu(req.body.price_nu);

      if (!title || !author_name || price_nu === null) {
        return res.render('author-book-form', { title: 'Add Book', book: null, error: 'Please fill in title, author name and a valid price.' });
      }
      if (!req.files?.pdf?.[0]) {
        return res.render('author-book-form', { title: 'Add Book', book: null, error: 'A PDF file is required.' });
      }

      const { pdfFilename, coverFilename } = await persistUploadedFiles(req.files);

      let page_count = toPositiveInt(req.body.page_count) || 0;
      try {
        const parser = new PDFParse({ data: fs.readFileSync(path.join(PDF_DIR, pdfFilename)) });
        const info = await parser.getInfo();
        if (!page_count) page_count = info.total || 0;
        await parser.destroy();
      } catch {
        // Fall back to whatever the author entered; metadata extraction is best-effort.
      }

      const info = db.prepare(`
        INSERT INTO books (title, author_name, owner_user_id, description, price_nu, category, page_count, cover_path, pdf_filename)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(title, author_name, req.user.id, description, price_nu, category, page_count, coverFilename || null, pdfFilename);

      sheetsSync.syncBook({ id: info.lastInsertRowid, title, author_name, category, price_nu, page_count, owner_user_id: req.user.id });

      res.redirect('/author/dashboard');
    } catch (e) {
      res.render('author-book-form', { title: 'Add Book', book: null, error: e.message });
    }
  });
});

router.post('/author/books/:id', verifyCsrf, (req, res) => {
  upload(req, res, async (err) => {
    const book = getOwnBookOr404(req, res);
    if (!book) return;
    if (err) return res.render('author-book-form', { title: 'Edit Book', book, error: err.message });

    try {
      const title = cleanText(req.body.title, 200) || book.title;
      const author_name = cleanText(req.body.author_name, 150) || book.author_name;
      const description = cleanText(req.body.description, 5000);
      const category = cleanText(req.body.category, 60) || book.category;
      const price_nu = toPriceNu(req.body.price_nu);
      const page_count = toPositiveInt(req.body.page_count);

      const { pdfFilename, coverFilename } = await persistUploadedFiles(req.files);

      db.prepare(`
        UPDATE books SET title=?, author_name=?, description=?, category=?,
          price_nu = COALESCE(?, price_nu),
          page_count = COALESCE(?, page_count),
          cover_path = COALESCE(?, cover_path),
          pdf_filename = COALESCE(?, pdf_filename),
          updated_at = datetime('now')
        WHERE id = ? AND owner_user_id = ?
      `).run(title, author_name, description, category, price_nu, page_count, coverFilename || null, pdfFilename || null, book.id, req.user.id);

      if (pdfFilename && book.pdf_filename) {
        const old = path.join(PDF_DIR, book.pdf_filename);
        if (old.startsWith(PDF_DIR) && fs.existsSync(old)) fs.unlinkSync(old);
      }
      if (coverFilename && book.cover_path) {
        const old = path.join(COVER_DIR, book.cover_path);
        if (old.startsWith(COVER_DIR) && fs.existsSync(old)) fs.unlinkSync(old);
      }

      res.redirect('/author/dashboard');
    } catch (e) {
      res.render('author-book-form', { title: 'Edit Book', book, error: e.message });
    }
  });
});

router.post('/author/books/:id/delete', verifyCsrf, (req, res) => {
  const book = getOwnBookOr404(req, res);
  if (!book) return;

  const hasSales = db.prepare(`SELECT COUNT(*) AS c FROM purchases WHERE book_id = ? AND payment_status='completed'`).get(book.id).c > 0;

  if (hasSales) {
    // Preserve purchase history and reader access for existing buyers -
    // unpublish instead of destroying the row.
    db.prepare(`UPDATE books SET status='hidden', updated_at=datetime('now') WHERE id = ? AND owner_user_id = ?`).run(book.id, req.user.id);
  } else {
    db.prepare('DELETE FROM books WHERE id = ? AND owner_user_id = ?').run(book.id, req.user.id);
    const pdfPath = path.join(PDF_DIR, book.pdf_filename);
    if (pdfPath.startsWith(PDF_DIR) && fs.existsSync(pdfPath)) fs.unlinkSync(pdfPath);
    if (book.cover_path) {
      const coverPath = path.join(COVER_DIR, book.cover_path);
      if (coverPath.startsWith(COVER_DIR) && fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
    }
  }
  res.redirect('/author/dashboard');
});

module.exports = router;
