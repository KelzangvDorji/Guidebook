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
async function createSession(userId) {
  const jti = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS).toISOString();
  await db.run(
    `INSERT INTO sessions (jti, user_id, expires_at) VALUES (?, ?, ?)`,
    [jti, userId, expiresAt]
  );
  const token = sign({ jti, uid: userId });
  return { token, expiresAt };
}

async function getSessionUser(token) {
  const payload = verify(token);
  if (!payload || !payload.jti || !payload.uid) return null;

  const session = await db.get('SELECT * FROM sessions WHERE jti = ?', [payload.jti]);
  if (!session || session.revoked) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) return null;
  if (session.user_id !== payload.uid) return null;

  const user = await db.get('SELECT * FROM users WHERE id = ?', [payload.uid]);
  if (!user) return null;
  return { user, jti: payload.jti };
}

async function revokeSession(jti) {
  if (!jti) return;
  await db.run('UPDATE sessions SET revoked = 1 WHERE jti = ?', [jti]);
}

async function revokeAllSessionsForUser(userId) {
  await db.run('UPDATE sessions SET revoked = 1 WHERE user_id = ?', [userId]);
}

module.exports = {
  createSession,
  getSessionUser,
  revokeSession,
  revokeAllSessionsForUser,
  SESSION_TTL_MS,
};
