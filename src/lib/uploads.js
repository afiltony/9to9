import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import multer from 'multer';
import { config } from '../config.js';
import { shrinkToFit } from './images.js';

/** Returns 'jpg' | 'png' from the file's magic bytes, or null. */
export function imageType(buf) {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/**
 * Multer middleware for multipart forms with image fields. Upload problems are recorded on
 * req.uploadError instead of failing the request, so the form can be re-shown with a message.
 */
export function imageUpload(fields, { maxBytes = config.maxUploadBytes } = {}) {
  const mw = multer({ storage: multer.memoryStorage(), limits: { fileSize: maxBytes, files: fields.length, fields: 200 } })
    .fields(fields.map((name) => ({ name, maxCount: 1 })));
  return (req, res, next) => mw(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      req.uploadError = err.code === 'LIMIT_FILE_SIZE'
        ? `The image is too large (max ${Math.round(maxBytes / 1024 / 1024)} MB).`
        : 'The upload could not be processed.';
      req.body ??= {};
      req.files ??= {};
      return next();
    }
    next(err);
  });
}

export function uploadedFile(req, field) {
  return req.files?.[field]?.[0] || null;
}

/**
 * Validates and stores an uploaded image under storage/<dir>/. Images larger than maxBytes are
 * shrunk automatically (re-encoded as JPEG) instead of being refused. Returns the relative path.
 */
export async function saveImage(file, dir, { maxBytes = config.maxPhotoBytes } = {}) {
  let type = imageType(file.buffer);
  if (!type) return { error: 'The image must be a JPG or PNG file.' };
  let data = file.buffer;
  if (data.length > maxBytes) {
    try {
      data = await shrinkToFit(data, maxBytes);
      type = 'jpg';
    } catch {
      return { error: 'The image could not be read. Please choose a different JPG or PNG file.' };
    }
  }
  const rel = `${dir}/${crypto.randomUUID()}.${type}`;
  await fs.mkdir(path.join(config.storageDir, dir), { recursive: true });
  await fs.writeFile(path.join(config.storageDir, rel), data);
  return { path: rel };
}

export async function removeStored(rel) {
  if (rel) await fs.unlink(path.join(config.storageDir, rel)).catch(() => {});
}
