// Redirects a visitor to the login page if they try to reach a page that
// requires an account (cart, wishlist, account, checkout).
function requireLogin() {
  if (!isLoggedIn()) {
    // Clean URLs now, so the current address (e.g. "/checkout", with
    // whatever query string it already had) is exactly the right thing to
    // send back as-is — no filename to reconstruct.
    const here = window.location.pathname + window.location.search || '/';
    window.location.href = '/login?redirect=' + encodeURIComponent(here);
    return false;
  }
  return true;
}
