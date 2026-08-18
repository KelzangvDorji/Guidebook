const crypto = require('node:crypto');
const db = require('../db/db');

const SECRET = process.env.AUTH_SECRET;
if (!SECRET || SECRET.length < 16) {
  throw new Error('AUTH_SECRET is missing or too short. Set a strong value in .env');
}

const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const macBuf = Buffer.from(mac);
  const expBuf = Buffer.from(expected);
  if (macBuf.length !== expBuf.length || !crypto.timingSafeEqual(macBuf, expBuf)) return null;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

// Creates a signed, revocable auth token backed by a DB session row.
function createSession(userId) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  db.prepare(
    `INSERT INTO sessions (jti, user_id, expires_at) VALUES (?, ?, ?)`
  ).run(jti, userId, expiresAt);
  const token = sign({ jti, uid: userId });
  return { token, expiresAt };
}

function getSessionUser(token) {
  const payload = verify(token);
  if (!payload || !payload.jti || !payload.uid) return null;

  const session = db
    .prepare('SELECT * FROM sessions WHERE jti = ?')
    .get(payload.jti);
  if (!session || session.revoked) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  if (session.user_id !== payload.uid) return null;

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid);
  if (!user) return null;
  return { user, jti: payload.jti };
}

function revokeSession(jti) {
  if (!jti) return;
  db.prepare('UPDATE sessions SET revoked = 1 WHERE jti = ?').run(jti);
}

function revokeAllSessionsForUser(userId) {
  db.prepare('UPDATE sessions SET revoked = 1 WHERE user_id = ?').run(userId);
}

module.exports = {
  createSession,
  getSessionUser,
  revokeSession,
  revokeAllSessionsForUser,
  SESSION_TTL_MS,
};
