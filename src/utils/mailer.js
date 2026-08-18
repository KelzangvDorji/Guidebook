const fs = require('node:fs');
const path = require('node:path');
const nodemailer = require('nodemailer');

const OUTBOX_DIR = path.join(__dirname, '..', '..', 'storage', 'outbox');

function isConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

let transporter = null;
function getTransporter() {
  if (!isConfigured()) return null;
  if (!transporter) {
    const port = Number(process.env.SMTP_PORT) || 587;
    // Respect an explicit SMTP_SECURE if set; otherwise infer from the port
    // (465 = implicit TLS, 587/others = STARTTLS negotiated after connect).
    const secure = process.env.SMTP_SECURE !== undefined
      ? process.env.SMTP_SECURE === 'true'
      : port === 465;
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return transporter;
}

async function sendMail({ to, subject, text, replyTo }) {
  const t = getTransporter();
  if (!t) {
    // Safe local fallback: never fail the request, never expose credentials,
    // just persist what would have been sent so it can be inspected.
    if (!fs.existsSync(OUTBOX_DIR)) fs.mkdirSync(OUTBOX_DIR, { recursive: true });
    const file = path.join(OUTBOX_DIR, `${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    fs.writeFileSync(
      file,
      `To: ${to}\nReplyTo: ${replyTo || ''}\nSubject: ${subject}\n\n${text}\n`
    );
    return { delivered: false, outboxFile: file };
  }

  await t.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    replyTo,
  });
  return { delivered: true };
}

module.exports = { sendMail, isConfigured };
