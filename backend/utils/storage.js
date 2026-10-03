// Permanent file storage for everything admins and customers upload (product photos, collection
// and hero images, reel videos, return-request photos).
//
// Files used to be written to backend/uploads on the web server's own disk. That broke twice over on
// Hostinger: the admin site and the storefront are separate Node apps with separate disks (a photo
// uploaded in admin simply didn't exist on the storefront), and every redeploy wipes untracked
// folders, so older uploads vanished too. They now live in a public Supabase Storage bucket that every
// server — and every future deploy — reads from, and the database stores the full public URL.
//
// Old rows that still hold a relative "/uploads/<file>" path keep working wherever that file
// happens to exist; nothing here rewrites them.
const fs = require('fs');
const path = require('path');
const { supabase } = require('./db');

const BUCKET = 'uploads';
const EXT = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
};

function publicBase() {
  return `${String(process.env.SUPABASE_URL || '').replace(/\/$/, '')}/storage/v1/object/public/${BUCKET}/`;
}

function newName(file, prefix) {
  const ext = EXT[file.mimetype] || path.extname(file.originalname || '') || '';
  return `${prefix || ''}${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
}

// Stores one multer memory file and returns the public URL to save in the database.
async function saveUpload(file, prefix) {
  const name = newName(file, prefix);
  const { error } = await supabase.storage.from(BUCKET).upload(name, file.buffer, {
    contentType: file.mimetype,
    cacheControl: '31536000', // the name is unique per upload, so browsers can cache it for a year
    upsert: false
  });
  if (error) throw new Error('Storage upload failed: ' + error.message);
  return publicBase() + name;
}

// True for a URL this server handed out for a customer's return photo (new storage URL or the old local path).
function isReturnPhotoUrl(u) {
  if (typeof u !== 'string') return false;
  if (/^\/uploads\/return-[\w.-]+$/.test(u)) return true;
  const base = publicBase();
  return u.startsWith(base + 'return-') && /^[\w.-]+$/.test(u.slice(base.length));
}

// Best-effort delete of a file we stored — never lets a missing file turn a successful
// database change into an error.
async function removeUpload(url) {
  try {
    if (typeof url !== 'string' || !url) return;
    const base = publicBase();
    if (url.startsWith(base)) {
      await supabase.storage.from(BUCKET).remove([decodeURIComponent(url.slice(base.length))]);
    } else if (url.startsWith('/uploads/')) {
      const file = path.join(__dirname, '..', 'uploads', path.basename(url));
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  } catch (_) { /* ignore */ }
}

module.exports = { saveUpload, removeUpload, isReturnPhotoUrl, publicBase, BUCKET };
