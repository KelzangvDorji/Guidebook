const express = require('express');
const crypto = require('node:crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db/db');
const { hashPassword, verifyPassword } = require('../utils/password');
const { createSession, revokeSession } = require('../utils/auth');
const { AUTH_COOKIE, requireAuth } = require('../middleware/auth');
const { verifyCsrf } = require('../middleware/csrf');
const { isEmail, isBhutanPhone, normalizeIdentifier, isStrongPassword, cleanText } = require('../utils/validate');
const googleAuth = require('../utils/googleAuth');
const { sendMail } = require('../utils/mailer');
const sheetsSync = require('../utils/sheetsSync');

const router = express.Router();

const STATE_COOKIE = 'google_oauth_state';
const NEXT_COOKIE = 'google_oauth_next';

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please try again later.' },
});

function setAuthCookie(res, token) {
  res.cookie(AUTH_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: '/',
  });
}

router.get('/register', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('register', { title: 'Create Account', error: null, form: {} });
});

router.post('/register', authLimiter, verifyCsrf, async (req, res) => {
  const name = cleanText(req.body.name, 120);
  const identifier = normalizeIdentifier(req.body.identifier);
  const password = req.body.password || '';
  let requestedRole = cleanText(req.body.role, 20);

  const errors = [];
  if (!name) errors.push('Name is required.');
  const email = isEmail(identifier) ? identifier : null;
  const phone = !email && isBhutanPhone(identifier) ? identifier.replace(/\s+/g, '') : null;
  if (!email && !phone) errors.push('Enter a valid email address or Bhutanese mobile number.');
  if (!isStrongPassword(password)) errors.push('Password must be at least 8 characters.');

  // Security-critical: the client may submit role=admin, but admin access is
  // never granted from user-controlled input. Only 'user' and 'author' are
  // honored here; admin accounts are promoted directly in the database by an
  // operator (see scripts/create-admin.js).
  if (!['user', 'author'].includes(requestedRole)) requestedRole = 'user';

  if (errors.length) {
    return res.status(400).render('register', { title: 'Create Account', error: errors.join(' '), form: { name, identifier, role: requestedRole } });
  }

  const existing = await db.get(
    'SELECT id FROM users WHERE (email IS NOT NULL AND email = ?) OR (phone IS NOT NULL AND phone = ?)',
    [email, phone]
  );
  if (existing) {
    return res.status(400).render('register', { title: 'Create Account', error: 'An account with that email or mobile number already exists.', form: { name, identifier, role: requestedRole } });
  }

  // Everyone starts as a Reader in the database - picking "Author" here only
  // fast-tracks them to the same admin-approval request Google sign-ups go
  // through (see /auth/choose-role), it never grants the role directly.
  const passwordHash = hashPassword(password);
  const info = await db.run(
    'INSERT INTO users (name, email, phone, password_hash, role) VALUES (?, ?, ?, ?, ?)',
    [name, email, phone, passwordHash, 'user']
  );

  sheetsSync.syncUser({ id: info.lastInsertRowid, name, email, phone, role: 'user' }, 'email/password');

  const { token } = await createSession(info.lastInsertRowid);
  setAuthCookie(res, token);
  res.redirect(requestedRole === 'author' ? '/auth/choose-role' : '/');
});

router.get('/login', (req, res) => {
  if (req.user) return res.redirect('/');
  res.render('login', { title: 'Log In', error: null, next: req.query.next || '' });
});

router.post('/login', authLimiter, verifyCsrf, async (req, res) => {
  const identifier = normalizeIdentifier(req.body.identifier);
  const password = req.body.password || '';
  const nextUrl = typeof req.body.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '';

  const user = await db.get(
    'SELECT * FROM users WHERE email = ? OR phone = ?',
    [identifier, identifier.replace(/\s+/g, '')]
  );

  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(400).render('login', { title: 'Log In', error: 'Invalid credentials.', next: nextUrl });
  }

  const { token } = await createSession(user.id);
  setAuthCookie(res, token);
  res.redirect(nextUrl || (user.role === 'admin' ? '/admin/dashboard' : user.role === 'author' ? '/author/dashboard' : '/'));
});

router.post('/logout', verifyCsrf, async (req, res) => {
  if (req.sessionJti) await revokeSession(req.sessionJti);
  res.clearCookie(AUTH_COOKIE, { path: '/' });
  res.redirect('/');
});

// --- Google Sign-In -------------------------------------------------------
// Authorization Code flow, implemented with plain fetch() - no OAuth library.
// A random `state` is round-tripped through a short-lived httpOnly cookie so
// the callback can confirm the code really belongs to a flow this browser
// started (standard OAuth CSRF protection), not one an attacker initiated.

router.get('/auth/google', authLimiter, (req, res) => {
  if (!googleAuth.isConfigured()) {
    return res.status(404).render('error', { title: 'Not available', message: 'Google Sign-In is not configured on this server.' });
  }
  const state = crypto.randomBytes(24).toString('base64url');
  const nextUrl = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '';

  res.cookie(STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 5 * 60 * 1000, path: '/' });
  res.cookie(NEXT_COOKIE, nextUrl, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 5 * 60 * 1000, path: '/' });

  res.redirect(googleAuth.buildAuthUrl(state));
});

router.get('/auth/google/callback', authLimiter, async (req, res) => {
  const clearOauthCookies = () => {
    res.clearCookie(STATE_COOKIE, { path: '/' });
    res.clearCookie(NEXT_COOKIE, { path: '/' });
  };

  if (!googleAuth.isConfigured()) {
    return res.status(404).render('error', { title: 'Not available', message: 'Google Sign-In is not configured on this server.' });
  }

  const { code, state, error: googleError } = req.query;
  const expectedState = req.cookies[STATE_COOKIE];
  const nextUrl = req.cookies[NEXT_COOKIE] || '';
  clearOauthCookies();

  if (googleError || !code || !state || !expectedState || state !== expectedState) {
    return res.status(400).render('login', { title: 'Log In', error: 'Google sign-in could not be verified. Please try again.', next: nextUrl });
  }

  try {
    const tokens = await googleAuth.exchangeCodeForTokens(String(code));
    const profile = await googleAuth.fetchUserInfo(tokens.access_token);

    if (!profile.sub || !profile.email) {
      throw new Error('Incomplete Google profile response');
    }

    let user = await db.get('SELECT * FROM users WHERE google_id = ?', [profile.sub]);
    let isNewAccount = false;

    if (!user) {
      // Only link to an existing password account when Google has actually
      // verified the email - otherwise someone could claim an unverified
      // address that belongs to an existing account.
      const emailMatch = profile.email_verified
        ? await db.get('SELECT * FROM users WHERE email = ?', [profile.email.toLowerCase()])
        : null;

      if (emailMatch) {
        await db.run(
          `UPDATE users SET google_id = ?, avatar_url = COALESCE(avatar_url, ?), updated_at = datetime('now') WHERE id = ?`,
          [profile.sub, profile.picture || null, emailMatch.id]
        );
        user = await db.get('SELECT * FROM users WHERE id = ?', [emailMatch.id]);
      } else {
        // New account. Role is always 'user' here - Google only proves
        // identity, never authorization, and author/admin access is granted
        // the same way as everywhere else in this app (see requireRole /
        // scripts/create-admin.js).
        const randomPassword = crypto.randomBytes(32).toString('hex');
        const info = await db.run(
          'INSERT INTO users (name, email, password_hash, role, google_id, avatar_url) VALUES (?, ?, ?, ?, ?, ?)',
          [profile.name || profile.email.split('@')[0], profile.email.toLowerCase(), hashPassword(randomPassword), 'user', profile.sub, profile.picture || null]
        );
        user = await db.get('SELECT * FROM users WHERE id = ?', [info.lastInsertRowid]);
        isNewAccount = true;
        sheetsSync.syncUser(user, 'google');
      }
    }

    const { token } = await createSession(user.id);
    setAuthCookie(res, token);

    if (isNewAccount) {
      return res.redirect('/auth/choose-role' + (nextUrl ? '?next=' + encodeURIComponent(nextUrl) : ''));
    }
    res.redirect(nextUrl || (user.role === 'admin' ? '/admin/dashboard' : user.role === 'author' ? '/author/dashboard' : '/'));
  } catch (e) {
    console.error('Google sign-in failed:', e);
    res.status(502).render('login', { title: 'Log In', error: 'Google sign-in failed. Please try again or use email/password.', next: nextUrl });
  }
});

// One-time prompt shown right after a brand-new Google account is created,
// since Google only proves identity - it never tells us whether someone
// wants to read or publish. Existing accounts never see this again because
// the callback above only redirects here when isNewAccount is true.
router.get('/auth/choose-role', requireAuth, (req, res) => {
  if (req.user.role !== 'user') return res.redirect('/');
  const nextUrl = typeof req.query.next === 'string' && req.query.next.startsWith('/') ? req.query.next : '';
  res.render('choose-role', { title: 'Choose your role', error: null, sent: false, form: {}, next: nextUrl });
});

router.post('/auth/choose-role', requireAuth, verifyCsrf, async (req, res) => {
  if (req.user.role !== 'user') return res.redirect('/');

  const role = req.body.role === 'author' ? 'author' : 'user';
  const nextUrl = typeof req.body.next === 'string' && req.body.next.startsWith('/') ? req.body.next : '';

  if (role === 'user') {
    return res.redirect(nextUrl || '/');
  }

  // Author access is never granted directly from user input - it stays
  // 'user' until an admin approves the request (see /admin/author-requests).
  const phone = cleanText(req.body.phone, 20);
  if (!isBhutanPhone(phone)) {
    return res.status(400).render('choose-role', {
      title: 'Choose your role', sent: false, next: nextUrl,
      error: 'Enter a valid Bhutanese mobile number so the admin can reach you.',
      form: { role, phone },
    });
  }

  const pending = await db.get(`SELECT id FROM author_requests WHERE user_id = ? AND status = 'pending'`, [req.user.id]);
  if (!pending) {
    const info = await db.run('INSERT INTO author_requests (user_id, phone) VALUES (?, ?)', [req.user.id, phone.replace(/\s+/g, '')]);
    sheetsSync.syncAuthorRequest({ id: info.lastInsertRowid, user_id: req.user.id, user_name: req.user.name, phone }, 'pending');

    // The author_requests row above is already saved regardless of whether
    // this notification email succeeds - never fail the user-facing request
    // over an SMTP hiccup (e.g. some hosts block outbound SMTP entirely).
    sendMail({
      to: process.env.FEEDBACK_TO_EMAIL,
      subject: `Bhutan Reads - New author request from ${req.user.name}`,
      text: `${req.user.name} (#${req.user.id}, ${req.user.email || 'no email'}) wants to become an author.\nContact number: ${phone}\n\nApprove or reject from the admin dashboard: Author Requests.`,
    }).catch((e) => console.error('Author request notification email failed:', e));
  }

  res.render('choose-role', { title: 'Choose your role', error: null, sent: true, form: {}, next: nextUrl });
});

module.exports = router;
