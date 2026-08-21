const { getSessionUser } = require('../utils/auth');

const AUTH_COOKIE = 'auth_token';

// Attaches req.user (safe subset) on every request if a valid session cookie
// is present. Never trusts anything from the client except the opaque token.
async function attachUser(req, res, next) {
  const token = req.cookies[AUTH_COOKIE];
  const session = token ? await getSessionUser(token) : null;
  if (session) {
    const { password_hash, ...safeUser } = session.user;
    req.user = safeUser;
    req.sessionJti = session.jti;
  } else {
    req.user = null;
  }
  res.locals.user = req.user;
  next();
}

// API routes always get a JSON status code - only page (HTML) routes get an
// HTML redirect/error page. Decided by path prefix, not the Accept header:
// fetch() calls typically send "Accept: */*", which would otherwise satisfy
// req.accepts('html') and silently redirect a JSON caller to a login page.
function isApiPath(req) {
  return req.path.startsWith('/api/');
}

function requireAuth(req, res, next) {
  if (!req.user) {
    if (isApiPath(req)) return res.status(401).json({ error: 'Authentication required' });
    return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  }
  next();
}

// Server-side role check. The role in the DB (set at registration, or
// promoted via secure admin tooling) is the only source of truth - never the
// client's request.
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      if (isApiPath(req)) return res.status(401).json({ error: 'Authentication required' });
      return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    }
    if (!roles.includes(req.user.role)) {
      if (isApiPath(req)) return res.status(403).json({ error: 'Forbidden' });
      return res.status(403).render('error', { title: 'Forbidden', message: 'You do not have permission to view this page.' });
    }
    next();
  };
}

module.exports = { attachUser, requireAuth, requireRole, AUTH_COOKIE };
