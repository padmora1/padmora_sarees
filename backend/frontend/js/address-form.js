// The address fields of checkout and of "My Account -> Addresses", behaving the same way in both:
//   State (every Indian state / union territory)  ->  City (only the cities of that state)  ->  Pincode (checked against the state)  ->  Phone.
// Needs js/api.js (apiFetch, isValidIndianMobile) and js/india-geo.js (window.INDIA_GEO), which only these two pages load.
//
// AddressForm.attach({ line1, state, city, pincode, phone })   (element ids)  ->  { set(values), get(), validate() }
//   validate() is async: it resolves { ok: true, address } or { ok: false, field, message } and has already marked the field and
//   scrolled / focused it. The server repeats every check, so this is for a clear message at the right field, not for security.
const AddressForm = (() => {
  const GEO = window.INDIA_GEO || { states: [], cities: {}, p3: {} };
  const pinChecks = new Map();   // "state|pin" -> Promise of the server's answer (a pincode is only ever asked about once)
  const asArray = v => (Array.isArray(v) ? v : [v]);

  function stateOptions(selected) {
    return '<option value="">Select state</option>' + GEO.states.map(s => `<option value="${s}"${s === selected ? ' selected' : ''}>${s}</option>`).join('');
  }
  function cityOptions(state, selected) {
    const list = (state && GEO.cities[state]) || [];
    if (!state) return '<option value="">Select state first</option>';
    return '<option value="">Select city</option>' + list.map(c => `<option value="${c}"${c === selected ? ' selected' : ''}>${c}</option>`).join('');
  }
  function errorSpan(input) {
    let el = input.parentElement.querySelector('.field-error');
    if (!el) { el = document.createElement('span'); el.className = 'field-error'; el.setAttribute('role', 'alert'); input.insertAdjacentElement('afterend', el); }
    return el;
  }
  function mark(input, message) {
    const el = errorSpan(input);
    el.textContent = message || '';
    input.classList.toggle('invalid', !!message);
    if (message) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
  }
  // quick, no-network check of a pincode against the chosen state (the first three digits tell the state)
  function localPinProblem(pin, state) {
    if (!/^[1-9]\d{5}$/.test(pin)) return 'Enter a valid 6-digit pincode.';
    const owners = GEO.p3[pin.slice(0, 3)];
    if (state && owners !== undefined && !asArray(owners).includes(GEO.states.indexOf(state))) {
      return `This pincode belongs to ${GEO.states[asArray(owners)[0]]}, not ${state}. Check the pincode or the state.`;
    }
    return null;
  }
  // the full check: instant local rules, then the server (which knows every pincode). A network failure never blocks the shopper;
  // the server checks again when the order is placed.
  function serverPinProblem(pin, state) {
    const key = state + '|' + pin;
    if (!pinChecks.has(key)) {
      pinChecks.set(key, apiFetch('/geo/pincode/' + pin + '?state=' + encodeURIComponent(state)).then(r => (r.ok ? null : r.message || 'This pincode does not exist. Please check it.')).catch(() => { pinChecks.delete(key); return null; }));
    }
    return pinChecks.get(key);
  }

  function attach(ids) {
    const el = {}; Object.keys(ids).forEach(k => { el[k] = document.getElementById(ids[k]); });
    el.state.innerHTML = stateOptions('');
    el.city.innerHTML = cityOptions('', '');
    el.pincode.setAttribute('inputmode', 'numeric'); el.pincode.setAttribute('maxlength', '6'); el.pincode.setAttribute('autocomplete', 'postal-code');
    el.phone.setAttribute('inputmode', 'tel'); el.phone.setAttribute('maxlength', '16'); el.phone.setAttribute('autocomplete', 'tel');
    el.state.setAttribute('autocomplete', 'address-level1'); el.city.setAttribute('autocomplete', 'address-level2'); el.line1.setAttribute('autocomplete', 'street-address');
    ['state', 'city', 'pincode', 'phone'].forEach(k => el[k].removeAttribute('placeholder'));   // no grey example text in these four
    ['state', 'city', 'pincode', 'phone', 'line1'].forEach(k => el[k].setAttribute('required', ''));

    el.state.addEventListener('change', () => {
      el.city.innerHTML = cityOptions(el.state.value, '');
      mark(el.state, ''); mark(el.city, '');
      if (el.pincode.value.length === 6) checkPin(false);
    });
    el.city.addEventListener('change', () => mark(el.city, ''));
    el.line1.addEventListener('input', () => { if (el.line1.value.trim().length >= 5) mark(el.line1, ''); });
    el.pincode.addEventListener('input', () => {
      const clean = el.pincode.value.replace(/\D/g, '').slice(0, 6);
      if (clean !== el.pincode.value) el.pincode.value = clean;
      mark(el.pincode, '');
      if (clean.length === 6) checkPin(false);
    });
    el.pincode.addEventListener('blur', () => { if (el.pincode.value) checkPin(true); });
    el.phone.addEventListener('input', () => {
      const clean = el.phone.value.replace(/[^\d+\s-]/g, '');
      if (clean !== el.phone.value) el.phone.value = clean;
      mark(el.phone, '');
    });
    el.phone.addEventListener('blur', () => { if (el.phone.value && !isValidIndianMobile(el.phone.value)) mark(el.phone, 'Enter a valid 10-digit mobile number (it starts with 6, 7, 8 or 9).'); });
    // a form reset (the account page's "Add a new address") starts from a clean state again
    const form = el.state.closest('form');
    if (form) form.addEventListener('reset', () => setTimeout(() => { el.state.innerHTML = stateOptions(''); el.city.innerHTML = cityOptions('', ''); Object.values(el).forEach(i => mark(i, '')); }, 0));

    let pinSeq = 0;
    async function checkPin(showFormatError) {
      const pin = el.pincode.value, state = el.state.value, my = ++pinSeq;
      if (pin.length < 6) { if (showFormatError) mark(el.pincode, 'Enter a valid 6-digit pincode.'); return false; }
      let problem = localPinProblem(pin, state);
      if (!problem && state) problem = await serverPinProblem(pin, state);
      if (my !== pinSeq) return !problem;   // typing went on: a newer check owns the message
      mark(el.pincode, problem || '');
      return !problem;
    }

    return {
      set(a) {
        a = a || {};
        const state = GEO.states.includes(a.state) ? a.state : '';
        el.state.innerHTML = stateOptions(state);
        el.city.innerHTML = cityOptions(state, a.city);
        el.line1.value = a.line1 || '';
        el.pincode.value = String(a.pincode || '').replace(/\D/g, '').slice(0, 6);
        el.phone.value = a.phone || '';
        Object.values(el).forEach(i => mark(i, ''));
      },
      get() { return { line1: el.line1.value.trim(), state: el.state.value, city: el.city.value, pincode: el.pincode.value.trim(), phone: el.phone.value.trim() }; },
      async validate() {
        const v = this.get();
        const fail = (field, message) => { mark(el[field], message); el[field].focus(); el[field].scrollIntoView({ block: 'center', behavior: 'smooth' }); return { ok: false, field, message }; };
        if (v.line1.length < 5) return fail('line1', 'Enter your full address: house number, street and area.');
        if (!v.state) return fail('state', 'Choose your state.');
        if (!v.city || !(GEO.cities[v.state] || []).includes(v.city)) return fail('city', `Choose your city from the list for ${v.state}.`);
        const local = localPinProblem(v.pincode, v.state);
        if (local) return fail('pincode', local);
        if (!isValidIndianMobile(v.phone)) return fail('phone', 'Enter a valid 10-digit mobile number (it starts with 6, 7, 8 or 9).');
        const remote = await serverPinProblem(v.pincode, v.state);
        if (remote) return fail('pincode', remote);
        return { ok: true, address: v };
      }
    };
  }
  return { attach, localPinProblem };
})();
