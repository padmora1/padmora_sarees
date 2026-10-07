// Admin product form helpers: (i) info tips, (ii) a "colour block" - name, shade, price, stock, low-stock alert and
// photos for one colour - used for the main colour and every extra colour of a new product, and for "add a colour"
// on an existing product.
//
// The shade is a pick from the shop's own colour list (SWATCHES in js/api.js), so what an admin chooses is exactly what
// the storefront can draw as the little colour dot and group under the Colour filter - no hand-typed keys.
const AdminColours = (function(){
  'use strict';
  const esc = v => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const cap = k => k.charAt(0).toUpperCase() + k.slice(1);
  const KEYS = () => Object.keys(typeof SWATCHES !== 'undefined' ? SWATCHES : {});   // SWATCHES is a top-level const in js/api.js
  // Words an admin is likely to use in a colour name, mapped to the nearest shade the shop knows.
  const WORDS = { mehendi:'green', olive:'green', bottle:'green', mint:'green', parrot:'green', lime:'green', navy:'blue', sky:'blue', royal:'blue', lavender:'purple', violet:'purple', lilac:'purple',
    peach:'pink', rose:'pink', coral:'pink', salmon:'pink', rani:'fuchsia', magenta:'fuchsia', rust:'orange', saffron:'orange', beige:'sand', khaki:'sand', turquoise:'teal', aqua:'teal',
    lemon:'yellow', haldi:'yellow', silver:'grey', charcoal:'grey', ash:'grey', copper:'brown', coffee:'brown', chocolate:'brown', off:'ivory', offwhite:'ivory', pearl:'ivory', madder:'red', crimson:'red', rani_pink:'fuchsia' };

  function tip(text){ return `<button type="button" class="info-tip" data-tip="${esc(text)}" aria-label="${esc(text)}">i</button>`; }

  // The shade the colour name points to ('' when it says nothing the shop recognises).
  function suggestShade(name){
    const keys = KEYS();
    const words = String(name || '').toLowerCase().split(/[^a-z]+/).filter(Boolean);
    // the first word that says something about colour wins ("Rani Pink" -> fuchsia, "Lemon Yellow" -> yellow)
    for(const w of words){ if(WORDS[w]) return WORDS[w]; if(keys.includes(w)) return w; }
    return '';
  }

  function shadeOptionsHTML(selected){
    const sel = String(selected || '').trim().toLowerCase();
    const keys = KEYS();
    const custom = sel && !keys.includes(sel) ? `<option value="${esc(sel)}" selected>${esc(cap(sel))} (custom)</option>` : '';
    return custom + keys.map(k => `<option value="${k}" ${k === sel ? 'selected' : ''}>${cap(k)}</option>`).join('');
  }
  const dotBg = key => (typeof swatchBg === 'function' ? swatchBg(key) : '#ccc');

  // ---- cost, Final CP and selling price ------------------------------------
  // The numbers come from Admin -> Settings (set by admin.html after it loads them). This is only the live preview: the server
  // works the same sums out again when the colour is saved, and what it works out is what gets stored.
  let CFG = null;
  const setConfig = c => { CFG = c || null; };
  const getConfig = () => CFG;
  const rup = n => '₹' + Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rup0 = n => '₹' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });

  // Same arithmetic as backend/utils/profit.js computePricing (whole paise, so no floating-point drift).
  const roundToTen = n => Math.max(10, Math.round(Math.round(Number(n) * 100) / 100 / 10) * 10);
  const sortedTiers = c => (c.marginTiers || []).map(t => ({ upTo: Number(t.upTo), margin: Number(t.margin) })).filter(t => Number.isFinite(t.upTo) && Number.isFinite(t.margin)).sort((a, b) => a.upTo - b.upTo);
  function marginFor(amount, c){
    let from = null;
    for(const t of sortedTiers(c)){
      if(amount <= t.upTo) return { pct: t.margin, upTo: t.upTo, from, above: false };
      from = t.upTo;
    }
    return { pct: Number(c.marginAbove), upTo: null, from, above: true };
  }
  function calc(buying, cfg){
    const cost = Number(buying), c = cfg || CFG;
    if(!c || !Number.isFinite(cost) || cost <= 0) return null;
    const baseCents = Math.round(cost * 100) + Math.round(c.shippingCost * 100);
    const gstCents = Math.round(baseCents * c.gstRate / 100);
    const finalCp = (baseCents + gstCents) / 100;
    const m = marginFor(c.marginBasis === 'cp' ? finalCp : Math.round(cost * 100) / 100, c);
    const exactPrice = Math.round(finalCp * (1 + m.pct / 100) * 100) / 100;
    return { shipping: c.shippingCost, gstAmount: gstCents / 100, finalCp, marginPct: m.pct, marginUpTo: m.upTo, marginFrom: m.from, marginAbove: m.above, marginBasis: c.marginBasis === 'cp' ? 'cp' : 'buying', exactPrice, sellingPrice: roundToTen(exactPrice) };
  }
  // "70% (buying price more than ₹1,000 and up to ₹10,000)" - says which rule was used
  function marginText(r){
    const what = r.marginBasis === 'cp' ? 'Final CP' : 'buying price';
    if(r.marginAbove) return r.marginPct + '% (' + (r.marginFrom == null ? 'every ' + what : what + ' above ' + rup0(r.marginFrom)) + ')';
    return r.marginPct + '% (' + what + ' ' + (r.marginFrom == null ? 'up to ' + rup0(r.marginUpTo) : 'more than ' + rup0(r.marginFrom) + ' and up to ' + rup0(r.marginUpTo)) + ')';
  }

  // attr: the data attribute the form reads its values from ("cb" in the new-colour block, "vf" in a saved colour's card).
  // opts: { attr, cost, price, sale, requireCost }
  function pricingHTML(opts){
    const o = opts || {}, a = o.attr || 'cb', c = CFG;
    if(!c) return '';
    const ro = 'readonly tabindex="-1" class="admin-input pf-ro" style="width:100%;"';
    return `
    <div class="pricing-group" data-pf-group>
      <div class="form-row-2">
        <div class="form-field"><label>Buying price (₹) ${tip('What you pay for this saree. The shipping and GST from Settings are added to it to get your Final CP, and the selling price is worked out from that.')}</label>
          <input type="number" class="admin-input" style="width:100%;" data-${a}="costPrice" data-pf="cost" min="0.01" step="0.01" placeholder="e.g. 3000" value="${o.cost != null ? esc(o.cost) : ''}"></div>
        <div class="form-field"><label>Shipping (₹) ${tip('Taken from Settings → Product pricing & profit. You cannot change it here.')}</label>
          <input type="text" ${ro} data-pf="ship" value="${rup(c.shippingCost)}"></div>
      </div>
      <div class="form-row-2">
        <div class="form-field"><label>GST <span data-pf="gstlabel">${esc(c.gstRate)}%</span> (₹) ${tip('GST on (buying price + shipping), at the rate in Settings. You cannot change it here.')}</label>
          <input type="text" ${ro} data-pf="gst" value="—"></div>
        <div class="form-field"><label>Final CP (₹) ${tip('Your total cost for one saree: (buying price + shipping) + GST.')}</label>
          <input type="text" ${ro} data-pf="cp" value="—"></div>
      </div>
      <div class="form-row-2">
        <div class="form-field"><label>Margin ${tip('Chosen automatically from the margin rules in Settings (they compare the ' + (c.marginBasis === 'cp' ? 'Final CP' : 'buying price') + '): the first rule it fits.')}</label>
          <input type="text" ${ro} data-pf="margin" value="—"></div>
        <div class="form-field"><label>Selling price (₹) ${tip('Final CP + the margin, exactly as calculated. The Final selling price below is this rounded to the nearest ₹10.')}</label>
          <input type="text" ${ro} data-pf="spx" value="—"></div>
      </div>
      <div class="form-field"><label><span data-pf="splabel">${o.sale ? 'Final actual price (₹) — before the sale' : 'Final selling price (₹)'}</span> ${tip('The selling price rounded to the nearest ₹10 (…5 to …9 goes up to the next ten, …1 to …4 goes down). This is the price shown on the product page' + (o.sale ? ' (for a Sale saree, the price before the % off)' : '') + ' and the price your profit is measured against. You can type a different price here.')}</label>
        <input type="number" class="admin-input pf-sp" style="width:100%;" data-${a}="price" data-pf="sp" ${o.sale ? 'data-sale-actual' : ''} min="1" step="1" value="${o.price != null ? esc(o.price) : ''}" ${o.requireCost || o.cost != null ? '' : ''}>
        <span class="pf-sphint" data-pf="sphint"></span></div>
      <p class="pf-profit" data-pf="profit"></p>
    </div>`;
  }

  // Keeps the read-only boxes in step with the buying price. getPct() gives the Sale % off (or '' when the saree is not on sale).
  // The Final selling price starts as the generated (rounded) price; typing in it makes it the admin's own price ("manual") until the
  // buying price changes or "Use the generated price" is pressed. opts.manual = a saved colour whose price was typed earlier.
  function wirePricing(root, opts){
    const o = opts || {};
    const q = k => root.querySelector(`[data-pf="${k}"]`);
    const cost = q('cost'), sp = q('sp');
    if(!cost || !sp) return { refresh(){}, setCost(){}, getCost(){ return ''; }, setSale(){}, isManual(){ return false; } };
    const st = { sale: !!o.sale, manual: !!o.manual };
    function hint(r){
      const h = q('sphint');
      if(!r || !st.manual){ h.innerHTML = r ? 'Generated automatically — you can type your own price instead.' : ''; return; }
      h.innerHTML = `Your own price. Generated would be ${rup0(r.sellingPrice)}. <button type="button" class="pf-reset" data-pf="reset">Use the generated price</button>`;
      h.querySelector('[data-pf="reset"]').addEventListener('click', () => { st.manual = false; refresh(true); });
    }
    function profitLine(r){
      const line = q('profit');
      const typed = Number(sp.value);
      if(!r || !(typed > 0)){ line.textContent = ''; line.className = 'pf-profit'; return; }
      const pct = o.getPct ? Number(o.getPct()) : 0;
      const sold = st.sale && pct > 0 && pct <= 90 ? Math.max(1, Math.round(typed * (100 - pct) / 100)) : typed;
      const gain = sold - r.finalCp, margin = r.finalCp ? gain / r.finalCp * 100 : 0;
      line.className = 'pf-profit' + (gain < 0 ? ' pf-loss' : '');
      line.textContent = gain < 0
        ? `At ${rup0(sold)} you would lose ${rup(-gain)} on every piece — the price is below your Final CP.`
        : `You earn ${rup(gain)} on each piece sold at ${rup0(sold)} (${margin.toFixed(0)}% on your cost).`;
    }
    function refresh(forceGenerated){
      const r = calc(cost.value);
      if(r){
        q('gst').value = rup(r.gstAmount); q('cp').value = rup(r.finalCp); q('margin').value = marginText(r); q('spx').value = rup(r.exactPrice);
        if(forceGenerated || !st.manual) sp.value = r.sellingPrice;
        sp.readOnly = false;
        hint(r); profitLine(r);
      }else{
        ['gst', 'cp', 'margin', 'spx'].forEach(k => { q(k).value = '—'; });
        q('profit').textContent = ''; q('sphint').innerHTML = '';
        st.manual = false;
        if(o.requireCost){ sp.value = ''; sp.readOnly = true; }
        else { sp.readOnly = false; }   // a colour priced by hand before buying prices existed keeps its typed price
      }
      if(o.onChange) o.onChange(r);
    }
    // a new buying price starts again from the generated price
    cost.addEventListener('input', () => { st.manual = false; refresh(true); });
    sp.addEventListener('input', () => {
      const r = calc(cost.value);
      if(r){ st.manual = Number(sp.value) !== r.sellingPrice; hint(r); profitLine(r); }
      if(o.onChange) o.onChange(r);
    });
    refresh();
    return {
      refresh: () => refresh(),
      setCost(v){ cost.value = v; st.manual = false; refresh(true); },
      getCost(){ return cost.value; },
      isManual(){ return st.manual; },
      setSale(on){
        st.sale = !!on;
        q('splabel').textContent = on ? 'Final actual price (₹) — before the sale' : 'Final selling price (₹)';
        if(on) sp.setAttribute('data-sale-actual', ''); else sp.removeAttribute('data-sale-actual');
        refresh();
      }
    };
  }

  // ---- one colour's fields -------------------------------------------------
  // opts: { title, removable, onSale, price, salePct, stock, low, colorName, shade }
  function blockHTML(opts){
    const o = opts || {};
    const sale = !!o.onSale;
    return `
    <div class="colour-block" data-colour-block>
      ${o.title ? `<div class="colour-block-head"><h4>${esc(o.title)}</h4>${o.removable ? '<button type="button" class="btn btn-sm" style="color:var(--maroon);" data-cb-remove>Remove this colour</button>' : ''}</div>` : ''}
      <div class="form-row-2">
        <div class="form-field"><label>Colour name ${tip('What customers see for this colour, for example “Mustard Yellow”. Write it normally — capital letters and spaces are fine.')}</label>
          <input type="text" class="admin-input" style="width:100%;" data-cb="colorName" maxlength="60" placeholder="e.g. Mustard Yellow" value="${esc(o.colorName || '')}"></div>
        <div class="form-field"><label>Colour shade ${tip('Picks the little round colour dot and the group this colour appears under in the shop’s Colour filter. Choose the closest shade — it is chosen for you from the colour name, and you can change it.')}</label>
          <div class="shade-pick"><span class="shade-dot" data-cb-dot style="background:${dotBg(o.shade || 'maroon')};"></span><select class="admin-input" data-cb="swatch">${shadeOptionsHTML(o.shade || 'maroon')}</select></div></div>
      </div>
      ${CFG ? pricingHTML({ attr: 'cb', cost: o.cost, price: o.price, sale, requireCost: true }) : `
      <div class="form-row-2">
        <div class="form-field"><label><span data-cb-pricelabel>${sale ? 'Actual price (₹)' : 'Price (₹)'}</span> ${tip('The price customers pay, in rupees. GST is already included — nothing is added on top. For a Sale saree, enter the actual (original) price and the % off below.')}</label>
          <input type="number" class="admin-input" style="width:100%;" data-cb="price" min="1" step="1" placeholder="e.g. 5999" value="${o.price != null ? esc(o.price) : ''}"></div>
      </div>`}
      <div class="form-row-2">
        <div class="form-field" data-cb-salefield style="${sale ? '' : 'display:none;'}"><label>Sale % off ${tip('How much cheaper the sale price is than the actual price. The sale price is worked out for you.')}</label>
          <input type="number" class="admin-input" style="width:100%;" data-cb="salePercent" min="1" max="90" placeholder="e.g. 20" value="${o.salePct != null ? esc(o.salePct) : ''}">
          <span class="sale-preview-line" data-cb-salepreview></span></div>
      </div>
      <div class="form-row-2">
        <div class="form-field"><label>Stock ${tip('How many pieces of this colour you have. Customers cannot order more than this, and it counts down as orders come in.')}</label>
          <input type="number" class="admin-input" style="width:100%;" data-cb="stock" min="0" step="1" value="${o.stock != null ? esc(o.stock) : '1'}"></div>
        <div class="form-field"><label>Low-stock alert at ${tip('When stock falls to this number (or below) the colour is marked “Low stock” in Admin and you get a low-stock alert, so you can restock in time.')}</label>
          <input type="number" class="admin-input" style="width:100%;" data-cb="lowStockThreshold" min="0" step="1" value="${o.low != null ? esc(o.low) : '2'}"></div>
      </div>
      <div class="form-field"><label>Photos of this colour ${tip('Add 2–3 clear photos (the first one is the main photo customers see first). You can add more, remove any, and change the main photo later.')}</label>
        <div class="variant-media-strip" data-cb-photos>
          <label class="upload-label" title="Add photos">+<input type="file" accept="image/*,video/*" multiple style="display:none;" data-cb-file></label>
        </div>
      </div>
    </div>`;
  }

  // Wires one colour block. Returns { read, setSale, el, files }.
  function wire(root, opts){
    const o = opts || {};
    const q = s => root.querySelector(s);
    const st = { files: [], shadeTouched: !!o.shadeTouched, priceTouched: false, pctTouched: false, sale: !!o.onSale, urls: [] };
    const name = q('[data-cb="colorName"]'), shade = q('[data-cb="swatch"]'), dot = q('[data-cb-dot]');
    const price = q('[data-cb="price"]'), pct = q('[data-cb="salePercent"]');
    const costInput = q('[data-cb="costPrice"]');
    let afterPricing = () => {};   // set below, once the sale preview exists
    const pricing = costInput ? wirePricing(root, { requireCost: true, sale: !!o.onSale, getPct: () => pct.value, onChange: () => afterPricing() }) : null;

    const paintDot = () => { dot.style.background = dotBg(shade.value); };
    shade.addEventListener('change', () => { st.shadeTouched = true; paintDot(); });
    name.addEventListener('input', () => {
      if(st.shadeTouched) return;
      const k = suggestShade(name.value);
      if(k && shade.value !== k){ shade.value = k; paintDot(); }
    });

    const salePreview = () => {
      const out = q('[data-cb-salepreview]'); if(!out) return;
      const a = Number(price.value), p = Number(pct.value);
      if(!st.sale || !(a > 0) || !(p > 0 && p <= 90)){ out.textContent = ''; return; }
      const sp = Math.max(1, Math.round(a * (100 - p) / 100));
      out.textContent = `Sale price ₹${sp.toLocaleString('en-IN')} — customers save ₹${(a - sp).toLocaleString('en-IN')}`;
    };
    afterPricing = salePreview;
    price.addEventListener('input', () => { st.priceTouched = true; salePreview(); if(o.onPriceInput) o.onPriceInput(price.value, 'price'); });
    if(costInput) costInput.addEventListener('input', () => { st.costTouched = true; salePreview(); if(o.onPriceInput) o.onPriceInput(costInput.value, 'cost'); });
    pct.addEventListener('input', () => { st.pctTouched = true; salePreview(); if(pricing) pricing.refresh(); if(o.onPriceInput) o.onPriceInput(pct.value, 'pct'); });
    price.addEventListener('change', salePreview);

    const strip = q('[data-cb-photos]'), fileInput = q('[data-cb-file]'), addBtn = strip.querySelector('.upload-label');
    const drawPhotos = () => {
      st.urls.forEach(u => URL.revokeObjectURL(u)); st.urls = [];
      strip.querySelectorAll('.media-thumb').forEach(n => n.remove());
      st.files.forEach((f, i) => {
        const u = URL.createObjectURL(f); st.urls.push(u);
        const d = document.createElement('div');
        d.className = 'media-thumb' + (i === 0 ? ' is-primary' : '');
        d.innerHTML = (f.type.startsWith('video') ? `<video src="${u}" muted preload="metadata"></video>` : `<img src="${u}" alt="">`) +
          `<div class="media-del" data-cb-del="${i}" title="Remove">×</div>` + (i === 0 ? '<div class="media-primary-btn" style="pointer-events:none;">Main</div>' : '');
        strip.insertBefore(d, addBtn);
      });
    };
    fileInput.addEventListener('change', () => { st.files.push(...fileInput.files); fileInput.value = ''; drawPhotos(); });
    strip.addEventListener('click', e => {
      const del = e.target.closest('[data-cb-del]'); if(!del) return;
      st.files.splice(Number(del.dataset.cbDel), 1); drawPhotos();
    });

    function setSale(on){
      st.sale = !!on;
      q('[data-cb-salefield]').style.display = on ? '' : 'none';
      const pl = q('[data-cb-pricelabel]'); if(pl) pl.textContent = on ? 'Actual price (₹)' : 'Price (₹)';
      if(pricing) pricing.setSale(on);
      salePreview();
    }
    function read(){
      return {
        colorName: name.value.trim(), swatch: shade.value, price: price.value, costPrice: costInput ? costInput.value : undefined, salePercent: st.sale ? pct.value : undefined,
        stock: q('[data-cb="stock"]').value, lowStockThreshold: q('[data-cb="lowStockThreshold"]').value, files: st.files.slice()
      };
    }
    function destroy(){ st.urls.forEach(u => URL.revokeObjectURL(u)); st.urls = []; }
    salePreview();
    return { el: root, read, setSale, destroy, setPrice(v){ if(!costInput && !st.priceTouched){ price.value = v; salePreview(); } }, setCost(v){ if(pricing && !st.costTouched){ pricing.setCost(v); salePreview(); } }, setPct(v){ if(!st.pctTouched){ pct.value = v; if(pricing) pricing.refresh(); salePreview(); } },
      focusName(){ name.focus(); }, nameInput: name, priceInput: price };
  }

  return { tip, blockHTML, wire, suggestShade, shadeOptionsHTML, esc, setConfig, getConfig, calc, marginText, pricingHTML, wirePricing };
})();
