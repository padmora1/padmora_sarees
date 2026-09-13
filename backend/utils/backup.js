// Automated database backups. Supabase/Postgres has its own point-in-time
// recovery on the project side, but this keeps the same local, rotated
// safety net the SQLite version had — a logical (data-only) snapshot of
// every table, written as one timestamped JSON file to backend/data/backups/.
// Good enough to recover from "an admin deleted the wrong row" or "a bad
// migration" without needing dashboard access; pushing these files to
// off-server storage (S3, Backblaze, rclone to Drive, etc.) is the natural
// next step once the store has real cloud credentials to give it.
const fs = require('fs');
const path = require('path');
const { supabase } = require('./db');

const BACKUP_DIR = path.join(__dirname, '..', 'data', 'backups');
const MAX_BACKUPS = 30;

// Same table list/order as the original SQLite->Postgres export script —
// dependency order doesn't matter for a read-only snapshot, but keeping it
// consistent makes the file easy to eyeball.
const TABLES = [
  'users', 'products', 'product_variants', 'variant_media', 'inventory_history',
  'cart_items', 'cart_meta', 'wishlist_items',
  'orders', 'order_items', 'reviews', 'coupons', 'coupon_usage',
  'contact_messages', 'addresses',
  'fabrics', 'occasions', 'badges', 'collections', 'collection_products',
  'reel_items', 'faq_items', 'search_queries', 'settings',
  'admin_users', 'admin_activity_log', 'notifications_log',
  'prebook_requests', 'return_requests', 'return_request_items', 'return_request_photos',
  'pending_checkouts'
];

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      const stat = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, size: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function runBackup() {
  ensureBackupDir();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `padmora-${stamp}.json`);

  const snapshot = {};
  for (const table of TABLES) {
    const { data, error } = await supabase.from(table).select('*');
    if (error) throw new Error(`Backup failed reading "${table}": ${error.message}`);
    snapshot[table] = data;
  }
  fs.writeFileSync(dest, JSON.stringify({ takenAt: new Date().toISOString(), tables: snapshot }));

  // Rotate — keep the most recent MAX_BACKUPS, delete the rest.
  const existing = listBackups();
  existing.slice(MAX_BACKUPS).forEach(b => {
    try { fs.unlinkSync(path.join(BACKUP_DIR, b.file)); } catch { /* already gone */ }
  });

  return { file: path.basename(dest), createdAt: new Date().toISOString() };
}

module.exports = { runBackup, listBackups, BACKUP_DIR };
