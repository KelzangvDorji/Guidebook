const crypto = require('node:crypto');

// One-way activity mirror: every row this module writes is appended after
// the real write to SQLite has already succeeded (src/db/db.js remains the
// single source of truth for permissions/prices/ownership/payment status -
// see GUIDE.md section 6). This never blocks or fails the caller's request;
// every function below is meant to be called fire-and-forget, same pattern
// as sendMail() in mailer.js.

const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_SPREADSHEET_ID;
const CLIENT_EMAIL = process.env.GOOGLE_SHEETS_CLIENT_EMAIL;
// Service account keys are typically pasted into .env with literal "\n"
// sequences (real newlines break most .env parsers) - restore them here.
const PRIVATE_KEY = (process.env.GOOGLE_SHEETS_PRIVATE_KEY || '').replace(/\\n/g, '\n');

function isConfigured() {
  return Boolean(SPREADSHEET_ID && CLIENT_EMAIL && PRIVATE_KEY);
}

const TABS = {
  Users: ['Timestamp', 'User ID', 'Name', 'Email', 'Phone', 'Role', 'Signup Method'],
  Books: ['Timestamp', 'Book ID', 'Title', 'Author', 'Category', 'Price (Nu.)', 'Pages', 'Owner Author ID'],
  Purchases: ['Timestamp', 'Purchase ID', 'Buyer', 'Buyer Contact', 'Book', 'Amount (Nu.)', 'Transaction Ref', 'Payment Status', 'Completed At'],
  Feedback: ['Timestamp', 'Feedback ID', 'From Email', 'User ID', 'Message'],
  'Author Requests': ['Timestamp', 'Request ID', 'User ID', 'User Name', 'Phone', 'Status'],
};

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let cachedToken = null; // { accessToken, expiresAt }

async function getAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 30_000) return cachedToken.accessToken;

  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(JSON.stringify({
    iss: CLIENT_EMAIL,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const signingInput = `${header}.${claims}`;
  const signature = crypto.createSign('RSA-SHA256').update(signingInput).sign(PRIVATE_KEY, 'base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${signingInput}.${signature}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Google token exchange failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  cachedToken = { accessToken: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
  return cachedToken.accessToken;
}

async function sheetsFetch(path, options = {}) {
  const token = await getAccessToken();
  const res = await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${SPREADSHEET_ID}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`Sheets API ${path} failed: ${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

let initPromise = null;

// Creates any missing tab (with its header row) the first time this process
// needs it. Safe to call repeatedly - subsequent calls reuse the same
// in-flight/completed promise instead of re-checking the spreadsheet.
function ensureInitialized() {
  if (!initPromise) {
    initPromise = (async () => {
      const meta = await sheetsFetch('?fields=sheets.properties.title');
      const existing = new Set((meta.sheets || []).map((s) => s.properties.title));
      const missing = Object.keys(TABS).filter((name) => !existing.has(name));

      if (missing.length) {
        await sheetsFetch(':batchUpdate', {
          method: 'POST',
          body: JSON.stringify({ requests: missing.map((title) => ({ addSheet: { properties: { title } } })) }),
        });
      }
      for (const title of missing) {
        await sheetsFetch(`/values/${encodeURIComponent(title)}!A1:append?valueInputOption=RAW`, {
          method: 'POST',
          body: JSON.stringify({ values: [TABS[title]] }),
        });
      }
    })().catch((e) => {
      initPromise = null; // allow a retry on the next call instead of caching a permanent failure
      throw e;
    });
  }
  return initPromise;
}

async function appendRow(tabName, row) {
  if (!isConfigured()) return;
  try {
    await ensureInitialized();
    await sheetsFetch(`/values/${encodeURIComponent(tabName)}!A1:append?valueInputOption=RAW`, {
      method: 'POST',
      body: JSON.stringify({ values: [row] }),
    });
  } catch (e) {
    console.error(`Google Sheets sync (${tabName}) failed:`, e.message);
  }
}

const nowIso = () => new Date().toISOString();

module.exports = {
  isConfigured,
  syncUser: (u, signupMethod) => appendRow('Users', [nowIso(), u.id, u.name, u.email || '', u.phone || '', u.role, signupMethod]),
  syncBook: (b) => appendRow('Books', [nowIso(), b.id, b.title, b.author_name, b.category, b.price_nu, b.page_count, b.owner_user_id || '']),
  syncPurchase: (p) => appendRow('Purchases', [nowIso(), p.id, p.buyer_name, p.buyer_contact || '', p.book_title, p.amount, p.transaction_ref, p.payment_status, p.completed_at || '']),
  syncFeedback: (f) => appendRow('Feedback', [nowIso(), f.id, f.email, f.user_id || '', f.message]),
  syncAuthorRequest: (r, status) => appendRow('Author Requests', [nowIso(), r.id, r.user_id, r.user_name || '', r.phone, status]),
};
