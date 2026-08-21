# Bhutan Reads — Complete Guide

A lightweight, production-ready digital reading & guidebook platform, built around the 3 PDFs already in this project (`PDFs/`). This guide describes the app exactly as it exists in this folder (`D:\Users\Version0.5`) — real routes, real files, real commands.

---

## 1. What was built

**Stack:** Node.js + Express 5, server-rendered EJS templates, [Turso](https://turso.tech) (hosted, SQLite-compatible via `@libsql/client`) for the database, Backblaze B2 (S3-compatible object storage) for uploaded PDFs/covers, minimal client-side JS (a handful of small vanilla scripts — no framework, no bundler, no build step). The database and file storage are both hosted rather than local disk so the app runs on platforms with no persistent filesystem (e.g. Render's free tier) — see §13.

**Catalog (real books, not placeholders):**

| Book | Author | Pages | Price |
|---|---|---|---|
| Alice's Adventures in Wonderland | Lewis Carroll | 60 | Nu. 150 |
| Romeo and Juliet | William Shakespeare | 106 | Nu. 180 |
| The Time Machine | H. G. Wells | 62 | Nu. 160 |

Metadata was extracted from the PDFs at seed time (`scripts/seed.js`, using `pdf-parse`/`pdfjs-dist`) and covers come from `Images/*.png`, converted to `.webp`. The committed originals still live under `storage/covers/` in the repo, but at runtime both PDFs and covers are served from Backblaze B2, not local disk (see §5).

**Dependencies installed** (see `package.json`): `express`, `ejs`, `bcryptjs`, `cookie-parser`, `dotenv`, `express-rate-limit`, `helmet`, `multer`, `nodemailer`, `pdf-lib`, `pdf-parse`, `pdfjs-dist`, `sharp`, `@libsql/client`, `@aws-sdk/client-s3`. No ORM, no session store package (sessions are signed tokens in an httpOnly cookie, checked against a `sessions` table on every request), no CSS/JS framework.

---

## 2. The visitor → purchase → reading flow

1. **Landing page** (`/`) — hero built on `Images/LandingPageBackgroundPicture.png`, a "Best selling right now" carousel (one book at a time, auto-advances every 1.5s, pauses on hover/keyboard focus, respects `prefers-reduced-motion`, clickable dots) populated from real completed-purchase counts (`bestSellers()` in `src/routes/pages.js`), and three value props.
2. **Library** (`/library`) — full catalog grid with category filter chips.
3. **Book detail** (`/books/:id`) — title, author, price in Nu., description, category, page count, cover, optional preview, and a **Buy & Read** button.
4. **Payment modal** (`public/js/payment.js` + `/api/payments/*`) — clicking Buy & Read calls `POST /api/payments/create`, which reads the price from the database (never the browser) and creates a `pending` purchase row with a generated reference ID. In dev/test mode (`PAYMENT_PROVIDER=dev-test`, active whenever `PAYMENT_SECRET_KEY` is blank) the modal shows a **"TEST"** badge and a "Simulate Payment" step that calls `POST /api/payments/confirm` — only the server flips the row to `completed`. When a real provider is wired in later, `/confirm` is meant to be replaced by a signature-verified webhook; the frontend contract doesn't change.
5. Every completed purchase fires an email to `FEEDBACK_TO_EMAIL` (buyer name/contact, book, amount, transaction ref, order ID, status, timestamp) — see `src/routes/payments.js`.
6. **My Library** (`/my-library`) — every book with a completed purchase for the logged-in user.
7. **Protected reader** (`/read/:bookId`) — canvas-rendered via pdf.js, watermarked per-viewer, with capture-detection blanking (see §5).
8. **Query & Feedback** (`/feedback`) — email + message, saved to DB and emailed to `FEEDBACK_TO_EMAIL`.

---

## 3. Roles & permissions

Registration only ever offers **Reader** or **Author**. There is no Admin option anywhere in the UI, and the server whitelists `['user','author']` on every signup regardless of what's submitted (`src/routes/auth.js`). `role` is read fresh from the database on every request (`src/middleware/auth.js`) — never trusted from a cookie payload.

- **User** — browse, buy, My Library, protected reader for owned books, Query & Feedback.
- **Author** — everything a User can, plus `/author/dashboard`: upload PDF + cover, set title/author/description/price/category, edit/delete **their own** books only (enforced server-side, not just hidden in the UI), see their own sales/earnings.
- **Admin** — `/admin/dashboard`: totals (users, authors, books, purchases, sales, earnings, pending author requests), recent transactions, latest buyers, popular books, a 30-day sales chart, plus full user/book/transaction/author-request/feedback management.

**Becoming an Author is an approval flow, not a checkbox:**
1. A reader (via email/password signup or a brand-new Google account) picks "Author" and is prompted for a Bhutanese contact number.
2. This creates a row in `author_requests` (status `pending`) and emails `FEEDBACK_TO_EMAIL` — the user sees "Request sent" and stays a Reader.
3. An Admin reviews it at `/admin/author-requests` and clicks Approve/Reject. Approve sets `role='author'` in the database immediately — no re-login needed, since role is re-checked from the DB on every request.

**The only way to create an Admin** is `npm run create-admin` (`scripts/create-admin.js`), which reads credentials from environment/prompt and writes directly to the database. There is no UI path to Admin, ever.

---

## 4. Database structure

Hosted on Turso (SQLite-compatible), schema in `src/db/db.js`, created automatically on first server boot (`db.init()`, idempotent):

- **`users`**: id, name, email (unique, nullable), phone (unique, nullable), password_hash, role (`user`/`author`/`admin`), google_id, avatar_url, timestamps.
- **`books`**: id, title, author_name, owner_user_id, description, price_nu, category, page_count, cover_path, pdf_filename (private storage reference, not a URL), preview_pages, status (`active`/`hidden`), timestamps.
- **`purchases`**: id, user_id, book_id, amount, currency, transaction_ref (unique), payment_provider, payment_status (`pending`/`completed`/`failed`), created_at, completed_at.
- **`feedback`**: id, user_id (nullable), email, message, status (`new`/`read`), created_at.
- **`author_requests`**: id, user_id, phone, status (`pending`/`approved`/`rejected`), timestamps.
- **`sessions`** / **`reader_tokens`** / **`preview_tokens`**: session and short-lived signed-token bookkeeping (see §5).

Price, role, ownership, and payment status are always read from these tables server-side — never accepted from the client.

---

## 5. PDF storage & the protected reader

- Original PDFs live in a **private** Backblaze B2 bucket under randomly-generated UUID keys, uploaded/fetched via `src/utils/storage.js`. There is no public URL for a PDF ever — every read goes through `GET /api/reader/:bookId/stream`, which proxies the bytes from the bucket after verifying ownership; the bucket itself is never reachable directly.
- Reading requires: a valid session (`requireAuth`) **and** a fresh, single-use, short-lived token minted by `POST /api/reader/:bookId/token` — which itself re-verifies ownership server-side before issuing anything (`src/utils/readerToken.js`, `src/routes/reader.js`). The token is consumed by `GET /api/reader/:bookId/stream`, which streams bytes with `Cache-Control: no-store` and never reveals the underlying storage path.
- The reader (`src/views/reader.ejs` + `public/js/reader.js`) renders pages into `<canvas>` via `pdfjs-dist`, disables right-click/context menu, and burns a **tiled, semi-transparent watermark** (name + email/phone + purchase ID) directly into the rendered canvas pixels — not a removable overlay `<div>`.
- **Capture-detection shield**: listens for `PrintScreen` keydown, window `blur` (catches the OS snip/record UI taking focus, including Win+Shift+S), and `visibilitychange`, and immediately blacks out the document (`#readerShield`) for a few seconds when triggered.
- **Honest limitation** (also shown to users): this is a browser-level deterrent, not a guarantee. OS-level screenshot tools, a phone camera, or a browser running outside its normal focus/visibility events can still capture pixels — nothing in a web page can fully prevent that. The per-user watermark exists specifically so any leaked copy is traceable back to the purchaser. A future native Android/iOS app could add OS-level screenshot-blocking APIs unavailable to a web page.
- Optional public preview (`/books/:id/preview`) is truncated server-side to `preview_pages` before the file ever leaves storage, so it can't be used to read the full book.

---

## 6. Security measures already in place

- **Password hashing**: bcryptjs.
- **CSRF**: a token issued per-session (`src/middleware/csrf.js`), required on every state-changing form/POST (`_csrf` field), checked server-side.
- **RBAC**: `requireAuth` / `requireRole('admin')` middleware, DB-sourced role on every request — verified in testing that a non-admin gets `403` on `/admin/dashboard`.
- **IDOR protection**: reading a book you haven't purchased returns `403` (verified); an author can only edit/delete their own books (owner check in `src/routes/author.js`); a user's `/my-library` and payment endpoints are always scoped to `req.user.id` from the session, never a client-supplied user id.
- **Price/role/payment integrity**: price comes from `books.price_nu` in `/api/payments/create`; payment completion only happens server-side in `/api/payments/confirm`; role is never accepted from a signup/login payload.
- **Headers**: `helmet` with a strict CSP (`default-src 'self'`, no inline scripts, `frameAncestors 'none'` on the reader), rate limiting globally and specifically on `/login`, `/register`, `/auth/google`, `/feedback`, and preview/reader token endpoints.
- **Uploads** (`src/middleware/upload.js`): author PDF/cover uploads are validated by MIME/extension, size-capped, and written under randomly generated filenames — never the user-supplied name — preventing path traversal and unsafe filenames.
- **Google Sign-In CSRF**: OAuth `state` round-tripped through a short-lived httpOnly cookie, verified on callback.

---

## 7. Password visibility toggle & Google Sign-In

- Login and register forms have an eye-icon button next to the password field (`.pw-toggle` in `public/js/main.js`) that toggles the input between `type="password"` and `type="text"` — no page reload, no dependency.
- "Continue with Google" appears on both `/login` and `/register` whenever `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are set (auto-hidden otherwise). Implemented with plain `fetch()`/OAuth Authorization Code flow in `src/utils/googleAuth.js` + `src/routes/auth.js` — no OAuth library dependency. A brand-new Google account is sent to `/auth/choose-role` once, to pick Reader vs. request Author access (see §3).

---

## 8. Site-wide design

- Single font family end-to-end: **Manrope** (self-hosted variable woff2 at `public/fonts/manrope-variable.woff2`, weights 400–800), no external font host, keeps the strict `font-src 'self'` CSP.
- A "scroll to top" arrow (`#backToTop` in the footer partial) appears once you scroll past ~420px, sits fixed in the bottom-right corner, and has a small continuous up/down bounce animation (disabled under `prefers-reduced-motion`).
- Bhutanese visual identity: maroon/gold/indigo palette, circular motif "cover" placeholders for books without an uploaded cover, refined rather than literal — no heavy iconography.
- Fully responsive: nav collapses to a toggle menu under 860px, book/value grids reflow to single-column, dashboards stack their sidebar nav horizontally on mobile.

---

## 9. Exact commands

```bash
# from D:\Users\Version0.5
npm install            # already run — installs the 12 dependencies above
npm run seed            # (re)populates the 3 books from PDFs/ + Images/ — only needed on a fresh DB
npm run create-admin    # promotes/creates the one Admin account, reads from env or interactive prompt
npm start                # node server.js — runs at http://localhost:3000
```

The dev server was started and verified during this session (`node server.js`, PID bound to port 3000) — you can open `http://localhost:3000` right now.

---

## 10. Required `.env` variables

Already configured in `.env` (see `.env.example` for a blank template):

```
PORT=3000
NODE_ENV=development
BASE_URL=http://localhost:3000

AUTH_SECRET=...           # session token signing secret
CSRF_SECRET=...           # CSRF token signing secret

GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REDIRECT_URI=       # blank = falls back to BASE_URL/auth/google/callback

BREVO_API_KEY=...
BREVO_SENDER_EMAIL=...      # must be a verified sender in your Brevo account
BREVO_SENDER_NAME="Bhutan Reads"
FEEDBACK_TO_EMAIL=kelzangdorji461@gmail.com

PAYMENT_PROVIDER=dev-test
PAYMENT_SECRET_KEY=        # blank = dev/test payment flow active
```

If the Brevo vars are blank, `sendMail()` (`src/utils/mailer.js`) logs the would-be email to the console instead of sending it — safe for local development without credentials. Email is sent over Brevo's HTTPS API rather than SMTP specifically because several free hosts (Render's free tier included) block outbound SMTP ports entirely to fight spam abuse; plain HTTPS is never blocked, so this keeps notification email working without needing a paid instance.

---

## 11. How to test the application

Verified in this session:

- ✅ Server boots cleanly, landing page returns 200.
- ✅ Registration → session cookie set → protected pages accessible.
- ✅ Full purchase flow: `POST /api/payments/create` (price from DB) → `POST /api/payments/confirm` (dev-test mode) → book appears in `/my-library`.
- ✅ Reader access: owned book → `200`; not-owned book → `403`.
- ✅ Admin dashboard as a non-admin user → `403`.
- ✅ Direct request to a private PDF's storage path → `404` (never publicly exposed).
- ✅ Unauthenticated request to `/my-library` → `302` redirect to login.
- ✅ Existing DB carried real prior-session data: an approved Admin account and two approved Author accounts, proving the author-approval workflow had already been exercised end-to-end.
- ✅ Password show/hide toggle and back-to-top button render on the actual pages (checked via HTML output).
- ✅ Manrope is the only font loaded site-wide (`--font` and `--font-heading` both resolve to it; unused Poppins font-face rules removed).

To test manually in a browser: visit `http://localhost:3000`, register a Reader, buy a book (Simulate Payment in the dev modal), open it in My Library, try navigating directly to `/read/2` (a book you didn't buy) to confirm it's blocked, then log in as the existing Admin (`karmaseday9@gmail.com` — password known only to you/the prior session) to see the dashboard.

---

## 12. How to add another book

Authors: log in as an approved Author → `/author/dashboard` → "Add Book" → upload PDF + cover, fill title/description/price/category/page count (auto-detected from the PDF where possible, editable if wrong).

Admins can do the same for any author via `/admin/books`, and can hide/unhide or delete any book (delete is blocked and auto-converted to "hidden" if the book already has completed sales, to preserve purchase history integrity).

---

## 13. Deployment notes

This app has no local persistent-disk dependency — the database (Turso) and file storage (any S3-compatible provider) are both hosted, so it can run on platforms without a writable filesystem, like Render's free web service tier.

- Set `NODE_ENV=production` and a real `BASE_URL` (this flips secure cookies on and enables HSTS via helmet's defaults).
- Create a Turso database and an S3-compatible object storage bucket (PDFs and cover images are both proxied through the server — `src/routes/reader.js` and `src/routes/pages.js` — so they can share a single private bucket; point `STORAGE_BUCKET` and `STORAGE_COVERS_BUCKET` at the same name if your provider's free tier only allows one bucket, e.g. Filebase). Fill in the `TURSO_*` and `STORAGE_*` variables in `.env.example`.
- `render.yaml` at the repo root defines the Render service (free plan, no disk block needed). Set all `sync: false` secrets in Render's dashboard rather than committing them.
- First deploy: the server creates its schema automatically on boot (`db.init()`). Run `npm run seed` once against the new database/buckets to populate the sample catalog, `npm run migrate-to-turso` if you have existing local `data/app.db` + `storage/` content to carry over (see that script's comments), then `npm run create-admin <email>`.
- Point the Google OAuth client's authorized redirect URI at `<your-domain>/auth/google/callback`.
- Swap `PAYMENT_SECRET_KEY` in for a real provider and replace `/api/payments/confirm`'s dev-test branch with that provider's signature-verified webhook handler — the rest of the payment code (price lookup, purchase row, ownership grant, notification email) does not need to change.
- Email (`src/utils/mailer.js`) goes over Brevo's HTTPS API, not SMTP, specifically so it keeps working on hosts that block outbound SMTP (Render's free tier included) — fill in `BREVO_*`; if left unconfigured, emails are logged to the console instead of sent.
- `data/`, `storage/pdfs/`, and `.env` should never be committed — check `.gitignore` before pushing to any remote. (`storage/covers/` **is** committed — those are the seed catalog's pre-optimized cover images, uploaded to the bucket by `scripts/seed.js`.)

---

## 14. Google Sheets activity mirror (optional)

Every new **user, book, completed purchase, feedback submission, and author request/decision** can also be appended as a row to a Google Sheet, live, as it happens — purely a human-readable export for you to browse/filter/share. Turso stays the app's real source of truth; the Sheet is one-way and append-only (it does not update existing rows, e.g. a book edited later won't update its Sheet row — it's an activity log, not a live-synced table).

Implemented in `src/utils/sheetsSync.js` using a Google service account and plain `fetch()` calls to the Sheets REST API — no new npm dependency, same pattern as the existing Google Sign-In integration. It auto-creates five tabs (`Users`, `Books`, `Purchases`, `Feedback`, `Author Requests`) with header rows the first time it successfully connects. Every sync call is fire-and-forget: if it fails or isn't configured, the app request that triggered it is completely unaffected (same as the purchase-notification email).

**To turn it on, you need to do the following in Google Cloud Console** (I can't create these credentials for you — they require your own Google account):

1. Go to [console.cloud.google.com](https://console.cloud.google.com), pick the same project used for Google Sign-In (or any project).
2. **APIs & Services → Library** → enable **Google Sheets API**.
3. **APIs & Services → Credentials → Create Credentials → Service Account**. Give it any name (e.g. "bhutan-reads-sheets"). No roles/permissions needed at the project level.
4. Open the new service account → **Keys → Add Key → Create new key → JSON**. This downloads a JSON file containing `client_email` and `private_key`.
5. Create a new Google Sheet (or use an existing one) in your own Google Drive. Click **Share**, and share it with the service account's `client_email` (looks like `xxx@xxx.iam.gserviceaccount.com`) as **Editor**.
6. Copy the spreadsheet ID from its URL: `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`.
7. Fill in `.env`:
   ```
   GOOGLE_SHEETS_SPREADSHEET_ID=<the ID from step 6>
   GOOGLE_SHEETS_CLIENT_EMAIL=<client_email from the JSON key>
   GOOGLE_SHEETS_PRIVATE_KEY="<private_key from the JSON key, keep the \n sequences literal>"
   ```
   The private key in the downloaded JSON already contains `\n` escape sequences — paste it into `.env` exactly as-is, wrapped in quotes.
8. Restart the server (`npm start`). The five tabs are created automatically the first time any synced action happens (e.g. register a test account or submit feedback).

Leave any of the three variables blank to keep this feature off — nothing else changes; the rest of the app behaves exactly as before.

---

## 15. What's fully implemented vs. what needs production credentials

**Fully implemented, tested, working today:** registration/login (with password show/hide), Google Sign-In, author-approval workflow with admin dashboard approve/reject, RBAC across all three roles, book catalog from the 3 real PDFs, best-seller carousel from real sales data, dev/test payment flow with server-side verification, protected reader with per-user watermarking and capture-detection blanking, private PDF storage with zero public URLs, admin dashboard with live stats/charts, Query & Feedback with DB persistence, Manrope site-wide typography, back-to-top control, one-way Google Sheets activity mirror (code complete; auto-disabled until you supply your own service-account credentials).

**Needs your own production configuration before going live:** a real payment provider's API keys (currently dev-test mode, clearly labeled as such in the UI), a Brevo account + API key + verified sender for email notifications, your own Google OAuth redirect URI once deployed to a real domain, and — if you want it — the Google Sheets service account from section 14 above.
