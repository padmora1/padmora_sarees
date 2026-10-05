// Admin list tools: one search / date / sort / count / CSV bar shared by Orders, Returns, Reviews, Messages and Products.
// Nothing here talks to the server: each list fetches its rows as before and these helpers narrow, order and export what
// is already on screen, so every change appears instantly.
const AdminLists = (() => {
  // ---- searching ----------------------------------------------------------------------------------------------
  // "falguni bhanage"      -> rows that contain BOTH words (anywhere: name, email, order number, item...)
  // "falguni, ZR94787"     -> rows that match EITHER part (commas, semicolons or new lines separate the parts)
  function parseQuery(q) {
    return String(q || '').split(/[,;\n]+/)
      .map(part => part.trim().toLowerCase().split(/\s+/).filter(Boolean))
      .filter(words => words.length);
  }
  function matches(groups, haystack) {
    if (!groups.length) return true;
    const h = String(haystack || '').toLowerCase();
    return groups.some(words => words.every(w => h.includes(w)));
  }
  // Text with the searched words wrapped in <mark>, safe to put in HTML.
  function highlight(text, groups) {
    const raw = String(text == null ? '' : text);
    const words = [...new Set(groups.flat())].filter(w => w.length >= 2).sort((a, b) => b.length - a.length);
    if (!words.length) return escHTML(raw);
    const re = new RegExp('(' + words.map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'gi');
    return raw.split(re).map((part, i) => i % 2 ? '<mark>' + escHTML(part) + '</mark>' : escHTML(part)).join('');
  }

  // ---- dates --------------------------------------------------------------------------------------------------
  const pad = n => String(n).padStart(2, '0');
  const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  function presetRange(name) {
    const now = new Date(), today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const back = n => { const d = new Date(today); d.setDate(d.getDate() - n); return d; };
    if (name === 'today') return { from: ymd(today), to: ymd(today) };
    if (name === '7') return { from: ymd(back(6)), to: ymd(today) };
    if (name === '30') return { from: ymd(back(29)), to: ymd(today) };
    if (name === 'month') return { from: ymd(new Date(today.getFullYear(), today.getMonth(), 1)), to: ymd(today) };
    return { from: '', to: '' };
  }
  // from / to are YYYY-MM-DD in the admin's own time zone; both days are included.
  function inRange(iso, from, to) {
    if (!from && !to) return true;
    const t = new Date(iso).getTime();
    if (isNaN(t)) return false;
    if (from) { const [y, m, d] = from.split('-').map(Number); if (t < new Date(y, m - 1, d).getTime()) return false; }
    if (to) { const [y, m, d] = to.split('-').map(Number); if (t >= new Date(y, m - 1, d + 1).getTime()) return false; }
    return true;
  }
  const fmtDate = iso => { const d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const fmtDateTime = iso => { const d = new Date(iso); return isNaN(d) ? '' : fmtDate(iso) + ', ' + d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' }); };

  // ---- CSV ----------------------------------------------------------------------------------------------------
  const csvCell = v => { const s = String(v == null ? '' : v); return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  function downloadCsv(filename, header, rows) {
    const text = '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');   // BOM so Excel reads it as UTF-8
    const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---- the toolbar --------------------------------------------------------------------------------------------
  // cfg: { searchId, placeholder, noun, sorts: [{value,label}], onChange(), exportCsv(), extraHTML?, dateLabel? }
  function createTools(mount, cfg) {
    const state = { q: '', from: '', to: '', sort: cfg.sorts[0].value };
    const uid = cfg.searchId;
    mount.classList.add('list-tools');
    mount.innerHTML = `
      <div class="lt-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input type="search" id="${uid}" class="admin-input" placeholder="${escHTML(cfg.placeholder)}" autocomplete="off" aria-label="Search ${escHTML(cfg.noun)}">
        <button type="button" class="lt-clear" data-lt="clear-search" aria-label="Clear search" hidden>&times;</button>
      </div>
      <p class="lt-hint">Tip: type a name, e-mail or number. Separate several with commas to see all of them (for example <em>Falguni, ZR94787</em>).</p>
      <div class="lt-row">
        ${cfg.dateField === false ? '' : `
        <label>From <input type="date" class="admin-input" data-lt="from"></label>
        <label>To <input type="date" class="admin-input" data-lt="to"></label>
        <span class="lt-presets" role="group" aria-label="Quick date ranges">
          <button type="button" data-preset="today">Today</button><button type="button" data-preset="7">7 days</button><button type="button" data-preset="30">30 days</button><button type="button" data-preset="month">This month</button><button type="button" data-preset="all">All dates</button>
        </span>`}
        ${cfg.extraHTML || ''}
        <label>Sort <select class="admin-input" data-lt="sort">${cfg.sorts.map(s => `<option value="${s.value}">${escHTML(s.label)}</option>`).join('')}</select></label>
        ${cfg.exportCsv ? '<button type="button" class="btn btn-outline btn-sm lt-export" data-lt="export">Export CSV</button>' : ''}
      </div>
      <div class="lt-count" aria-live="polite"></div>`;

    const q = sel => mount.querySelector(sel);
    const input = q('#' + uid);
    const clearBtn = q('[data-lt="clear-search"]');
    const fromEl = q('[data-lt="from"]'), toEl = q('[data-lt="to"]'), sortEl = q('[data-lt="sort"]');

    // Reads the boxes into `state` (also used after a page sets a box's value by code).
    function sync() {
      state.q = input.value.trim();
      if (fromEl) { state.from = fromEl.value; state.to = toEl.value; }
      state.sort = sortEl.value;
      clearBtn.hidden = !input.value;
      mount.querySelectorAll('[data-preset]').forEach(b => {
        const r = presetRange(b.dataset.preset);
        b.classList.toggle('active', fromEl && r.from === state.from && r.to === state.to);
      });
    }
    let timer = null;
    const changed = (delay) => { sync(); clearTimeout(timer); timer = setTimeout(() => cfg.onChange(), delay); };
    input.addEventListener('input', () => changed(160));
    input.addEventListener('keydown', e => { if (e.key === 'Escape' && input.value) { input.value = ''; changed(0); } });
    clearBtn.addEventListener('click', () => { input.value = ''; changed(0); input.focus(); });
    if (fromEl) {
      fromEl.addEventListener('change', () => changed(0));
      toEl.addEventListener('change', () => changed(0));
      mount.querySelectorAll('[data-preset]').forEach(b => b.addEventListener('click', () => {
        const r = presetRange(b.dataset.preset); fromEl.value = r.from; toEl.value = r.to; changed(0);
      }));
    }
    sortEl.addEventListener('change', () => changed(0));
    const exp = q('[data-lt="export"]');
    if (exp) exp.addEventListener('click', () => { sync(); cfg.exportCsv(); });

    return {
      state, input, mount, sync,
      groups() { sync(); return parseQuery(state.q); },
      active() { sync(); return !!(state.q || state.from || state.to); },
      // "12 of 87 orders" plus a Clear filters link when something is narrowing the list
      setCount(shown, total) {
        const el = q('.lt-count');
        const narrowed = !!(state.q || state.from || state.to);
        el.innerHTML = `${shown === total ? `${total} ${cfg.noun}` : `<strong>${shown}</strong> of ${total} ${cfg.noun}`}` +
          (narrowed ? ` · <button type="button" class="lt-reset" data-lt="reset">Clear search &amp; dates</button>` : '');
        const r = el.querySelector('[data-lt="reset"]');
        if (r) r.addEventListener('click', () => { input.value = ''; if (fromEl) { fromEl.value = ''; toEl.value = ''; } changed(0); });
      }
    };
  }

  // Press "/" anywhere on an admin screen to jump to the search box of the list that is open.
  document.addEventListener('keydown', e => {
    if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target;
    if (t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable)) return;
    const box = Array.from(document.querySelectorAll('.list-tools .lt-search input')).find(i => i.offsetParent !== null);
    if (box) { e.preventDefault(); box.focus(); box.select(); }
  });

  // Today's date in the admin's own time zone (YYYY-MM-DD), for file names. toISOString() would give the UTC date, which is
  // yesterday's date for the first hours of the day in India.
  const today = () => ymd(new Date());
  return { createTools, parseQuery, matches, highlight, inRange, presetRange, fmtDate, fmtDateTime, downloadCsv, today };
})();
