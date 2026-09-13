// Admin-only fetch wrapper — deliberately separate from api.js's apiFetch.
// Uses its own token (padmora_admin_token) and its own login endpoint
// (/api/admin-auth/login), so an admin session and a customer session never
// share storage or credentials, even in the same browser. Reuses API_BASE
// and the loader-bar helpers from api.js (loaded first on every admin page).

function getAdminToken() {
  return localStorage.getItem('padmora_admin_token');
}
function setAdminToken(token) {
  localStorage.setItem('padmora_admin_token', token);
}
function clearAdminToken() {
  localStorage.removeItem('padmora_admin_token');
  localStorage.removeItem('padmora_admin_user');
}
function getStoredAdmin() {
  try { return JSON.parse(localStorage.getItem('padmora_admin_user')); } catch { return null; }
}
function setStoredAdmin(admin) {
  localStorage.setItem('padmora_admin_user', JSON.stringify(admin));
}
function isAdminLoggedIn() {
  return !!getAdminToken();
}

async function adminApiFetch(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getAdminToken();
  if (token) headers['Authorization'] = 'Bearer ' + token;

  _startLoading();
  try {
    const res = await fetch(API_BASE + path, { ...options, headers });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }

    if (!res.ok) {
      if (res.status === 401) { clearAdminToken(); window.location.href = '/admin-login'; }
      throw new Error(data.message || 'Something went wrong. Please try again.');
    }
    return data;
  } finally {
    _endLoading();
  }
}

// For endpoints that return a file (CSV export, backup download) rather than
// JSON — adminApiFetch always expects JSON, so this is the separate path
// that still attaches the admin's Authorization header (a plain <a href>
// can't set custom headers, which is why this fetches the blob itself and
// triggers the save via a synthetic, immediately-revoked object URL).
async function adminDownloadFile(path, suggestedName) {
  const token = getAdminToken();
  const res = await fetch(API_BASE + path, { headers: token ? { Authorization: 'Bearer ' + token } : {} });
  if (!res.ok) {
    let msg = 'Download failed.';
    try { const data = await res.json(); msg = data.message || msg; } catch { /* no JSON body */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const cd = res.headers.get('Content-Disposition') || '';
  const match = cd.match(/filename="?([^"]+)"?/);
  const filename = match ? match[1] : (suggestedName || 'download');
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

async function adminLogout() {
  const ok = await showConfirmDialog(
    'You\'ll need to log in again to manage the store.',
    { title: 'Log out of the admin dashboard?', confirmLabel: 'Log Out', danger: true }
  );
  if (!ok) return;
  clearAdminToken();
  window.location.href = '/admin-login';
}

function requireAdminLogin() {
  if (!isAdminLoggedIn()) {
    window.location.href = '/admin-login';
    return false;
  }
  return true;
}
