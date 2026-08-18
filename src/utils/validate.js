const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Bhutanese mobile numbers: 8 digits, starting 17 (mobile) per common ranges.
const BHUTAN_PHONE_RE = /^(\+975)?[1-9][0-9]{7}$/;

function isEmail(v) {
  return typeof v === 'string' && v.length <= 254 && EMAIL_RE.test(v.trim());
}

function isBhutanPhone(v) {
  return typeof v === 'string' && BHUTAN_PHONE_RE.test(v.trim().replace(/\s+/g, ''));
}

function normalizeIdentifier(v) {
  if (typeof v !== 'string') return '';
  return v.trim().toLowerCase();
}

function isStrongPassword(v) {
  return typeof v === 'string' && v.length >= 8 && v.length <= 200;
}

function cleanText(v, maxLen = 5000) {
  if (typeof v !== 'string') return '';
  return v.trim().slice(0, maxLen);
}

function toPriceNu(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || n > 100000) return null;
  return Math.round(n * 100) / 100;
}

function toPositiveInt(v, max = 1000000) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > max) return null;
  return n;
}

module.exports = {
  isEmail,
  isBhutanPhone,
  normalizeIdentifier,
  isStrongPassword,
  cleanText,
  toPriceNu,
  toPositiveInt,
};
