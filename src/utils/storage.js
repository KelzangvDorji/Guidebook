const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
} = require('@aws-sdk/client-s3');

// B2 (and S3 in general) only supports public/private at the whole-bucket
// level, not per-object or per-prefix - so PDFs (must stay private, always
// proxied through reader.js) and covers (public-read, non-sensitive) live in
// two separate buckets sharing one account/credentials.
const PDF_BUCKET = process.env.STORAGE_BUCKET;
const COVER_BUCKET = process.env.STORAGE_COVERS_BUCKET;

let client = null;
function getClient() {
  if (!client) {
    client = new S3Client({
      endpoint: `https://${process.env.STORAGE_ENDPOINT}`,
      region: process.env.STORAGE_REGION,
      forcePathStyle: true,
      credentials: {
        accessKeyId: process.env.STORAGE_ACCESS_KEY_ID,
        secretAccessKey: process.env.STORAGE_SECRET_ACCESS_KEY,
      },
    });
  }
  return client;
}

async function putObject(bucket, key, buffer, { contentType, cacheControl } = {}) {
  await getClient().send(new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: cacheControl,
  }));
}

// Returns a Readable stream - use for potentially large files (PDFs) so the
// whole object never has to sit in memory at once.
async function getObjectStream(bucket, key) {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  return result.Body;
}

async function getObjectBuffer(bucket, key) {
  const result = await getClient().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const chunks = [];
  for await (const chunk of result.Body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function deleteObject(bucket, key) {
  await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

async function objectExists(bucket, key) {
  try {
    await getClient().send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PDF_BUCKET,
  COVER_BUCKET,
  putObject,
  getObjectStream,
  getObjectBuffer,
  deleteObject,
  objectExists,
};
