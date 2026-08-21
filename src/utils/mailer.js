// Sends mail via Brevo's HTTPS API rather than SMTP. Several free hosting
// tiers (Render included) block outbound SMTP ports entirely to fight spam,
// but plain HTTPS is never blocked, so this keeps notification email working
// without needing a paid instance.
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function isConfigured() {
  return Boolean(process.env.BREVO_API_KEY && process.env.BREVO_SENDER_EMAIL);
}

async function sendMail({ to, subject, text, replyTo }) {
  if (!isConfigured()) {
    // Safe local fallback: never fail the request, never expose credentials,
    // just log what would have been sent so it can be inspected.
    console.warn(`[mailer] Brevo not configured - logging instead of sending:\nTo: ${to}\nReplyTo: ${replyTo || ''}\nSubject: ${subject}\n\n${text}\n`);
    return { delivered: false };
  }

  const res = await fetch(BREVO_API_URL, {
    method: 'POST',
    headers: {
      'api-key': process.env.BREVO_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      sender: { email: process.env.BREVO_SENDER_EMAIL, name: process.env.BREVO_SENDER_NAME || 'Bhutan Reads' },
      to: [{ email: to }],
      subject,
      textContent: text,
      ...(replyTo ? { replyTo: { email: replyTo } } : {}),
    }),
  });

  if (!res.ok) {
    throw new Error(`Brevo send failed (${res.status}): ${await res.text()}`);
  }
  return { delivered: true };
}

module.exports = { sendMail, isConfigured };
