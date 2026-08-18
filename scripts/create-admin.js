// Promotes an existing registered user to the admin role directly in the
// database. This is the ONLY way to create an admin account - registration
// always ignores a client-submitted role=admin. Run manually by an operator
// who already has server/database access.
//
// Usage: node scripts/create-admin.js user@example.com
require('dotenv').config();
const db = require('../src/db/db');

const identifier = process.argv[2];
if (!identifier) {
  console.error('Usage: node scripts/create-admin.js <email-or-phone>');
  process.exit(1);
}

const user = db.prepare('SELECT * FROM users WHERE email = ? OR phone = ?').get(identifier, identifier);
if (!user) {
  console.error(`No user found with email/phone "${identifier}". They must register an account first.`);
  process.exit(1);
}

db.prepare(`UPDATE users SET role = 'admin', updated_at = datetime('now') WHERE id = ?`).run(user.id);
console.log(`${user.name} (${identifier}) is now an admin.`);
