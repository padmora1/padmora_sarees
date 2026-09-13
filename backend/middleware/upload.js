// Real local file storage for variant media — no cloud dependency for this
// dev/single-server setup. Files land in backend/uploads and are served
// statically at /uploads/<filename> (wired up in server.js).
const fs = require('fs');
const path = require('path');
const multer = require('multer');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const ALLOWED = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif',
  'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov'
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = ALLOWED[file.mimetype] || path.extname(file.originalname) || '';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB — enough for a short vertical reel
  fileFilter: (req, file, cb) => {
    if (!ALLOWED[file.mimetype]) return cb(new Error('Unsupported file type. Use JPG, PNG, WEBP, GIF, MP4, WEBM, or MOV.'));
    cb(null, true);
  }
});

// Customer-facing evidence photos on a return request — images only (no
// point letting a shopper upload a video here), capped smaller than the
// admin media uploader since these are phone snapshots, not product shoots.
const IMAGE_ONLY = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const returnPhotoStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = IMAGE_ONLY[file.mimetype] || path.extname(file.originalname) || '';
    cb(null, `return-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
  }
});
const uploadReturnPhotos = multer({
  storage: returnPhotoStorage,
  limits: { fileSize: 8 * 1024 * 1024, files: 5 }, // 8MB each, up to 5 photos
  fileFilter: (req, file, cb) => {
    if (!IMAGE_ONLY[file.mimetype]) return cb(new Error('Photos only — use JPG, PNG, or WEBP.'));
    cb(null, true);
  }
});

module.exports = { upload, uploadReturnPhotos, UPLOAD_DIR };
