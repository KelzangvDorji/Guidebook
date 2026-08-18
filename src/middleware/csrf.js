const crypto = require('node:crypto');

const CSRF_COOKIE = 'csrf_token';
const SECRET = process.env.CSRF_SECRET;
if (!SECRET || SECRET.length < 16) {
  throw new Error('CSRF_SECRET is missing or too short. Set a strong value in .env');
}

function sign(value) {
  return crypto.createHmac('sha256', SECRET).update(value).digest('base64url');
}

// Issues a readable (non-httpOnly) CSRF cookie the frontend echoes back in a
// header or hidden field on state-changing requests (double-submit pattern).
function ensureCsrfCookie(req, res, next) {
  let raw = req.cookies[CSRF_COOKIE];
  if (!raw || !raw.includes('.')) {
    raw = crypto.randomBytes(24).toString('base64url');
    const cookieVal = `${raw}.${sign(raw)}`;
    res.cookie(CSRF_COOKIE, cookieVal, {
      httpOnly: false,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    });
    req.csrfToken = cookieVal;
  } else {
    req.csrfToken = raw;
  }
  next();
}

function verifyCsrf(req, res, next) {
  const cookieVal = req.cookies[CSRF_COOKIE];
  const headerVal = req.get('x-csrf-token') || req.body?._csrf;
  if (!cookieVal || !headerVal || cookieVal !== headerVal) {
    return res.status(403).json({ error: 'Invalid or missing CSRF token' });
  }
  const [raw, mac] = cookieVal.split('.');
  if (!raw || !mac || sign(raw) !== mac) {
    return res.status(403).json({ error: 'Invalid CSRF token' });
  }
  next();
}

module.exports = { ensureCsrfCookie, verifyCsrf, CSRF_COOKIE };
