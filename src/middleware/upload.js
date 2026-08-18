const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const multer = require('multer');
const sharp = require('sharp');

const PDF_DIR = path.join(__dirname, '..', '..', 'storage', 'pdfs');
const COVER_DIR = path.join(__dirname, '..', '..', 'storage', 'covers');
for (const dir of [PDF_DIR, COVER_DIR]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const MAX_PDF_BYTES = 60 * 1024 * 1024; // 60MB
const MAX_COVER_BYTES = 6 * 1024 * 1024; // 6MB

// Memory storage: we inspect magic bytes and only write to disk with a
// server-generated filename after validation passes. Never trust the
// client-supplied filename or Content-Type header alone.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_BYTES, files: 2 },
  fileFilter(req, file, cb) {
    if (file.fieldname === 'pdf' && file.mimetype === 'application/pdf') return cb(null, true);
    if (file.fieldname === 'cover' && ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      return cb(null, true);
    }
    cb(new Error('Unsupported file type'));
  },
}).fields([
  { name: 'pdf', maxCount: 1 },
  { name: 'cover', maxCount: 1 },
]);

function looksLikePdf(buf) {
  return buf.length > 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-';
}

function detectImageType(buf) {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

const COVER_MAX_WIDTH = 640; // covers only ever display as thumbnails/poster art, never full-size
const COVER_QUALITY = 82;

// Validates magic bytes and writes files under server-generated, non-guessable
// names so uploaded content can never be used for path traversal or to
// overwrite arbitrary files. Cover images are re-encoded to a size- and
// format-appropriate WebP (instead of stored verbatim) so a multi-megabyte
// upload doesn't get shipped to every visitor browsing the catalog.
async function persistUploadedFiles(files) {
  const result = {};

  const pdfFile = files?.pdf?.[0];
  if (pdfFile) {
    if (pdfFile.size > MAX_PDF_BYTES) throw new Error('PDF file is too large');
    if (!looksLikePdf(pdfFile.buffer)) throw new Error('File does not look like a valid PDF');
    const name = `${crypto.randomUUID()}.pdf`;
    fs.writeFileSync(path.join(PDF_DIR, name), pdfFile.buffer);
    result.pdfFilename = name;
  }

  const coverFile = files?.cover?.[0];
  if (coverFile) {
    if (coverFile.size > MAX_COVER_BYTES) throw new Error('Cover image is too large');
    if (!detectImageType(coverFile.buffer)) throw new Error('Cover image format not recognized');

    let optimized;
    try {
      optimized = await sharp(coverFile.buffer)
        .resize({ width: COVER_MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: COVER_QUALITY })
        .toBuffer();
    } catch {
      throw new Error('Cover image could not be processed - the file may be corrupted');
    }

    const name = `${crypto.randomUUID()}.webp`;
    fs.writeFileSync(path.join(COVER_DIR, name), optimized);
    result.coverFilename = name;
  }

  return result;
}

module.exports = { upload, persistUploadedFiles, PDF_DIR, COVER_DIR };
