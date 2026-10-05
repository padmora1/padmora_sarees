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
      <div class="form-row-2">
        <div class="form-field"><label><span data-cb-pricelabel>${sale ? 'Actual price (₹)' : 'Price (₹)'}</span> ${tip('The price customers pay, in rupees. GST is already included — nothing is added on top. For a Sale saree, enter the actual (original) price and the % off below.')}</label>
          <input type="number" class="admin-input" style="width:100%;" data-cb="price" min="1" step="1" placeholder="e.g. 5999" value="${o.price != null ? esc(o.price) : ''}"></div>
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
    price.addEventListener('input', () => { st.priceTouched = true; salePreview(); if(o.onPriceInput) o.onPriceInput(price.value, 'price'); });
    pct.addEventListener('input', () => { st.pctTouched = true; salePreview(); if(o.onPriceInput) o.onPriceInput(pct.value, 'pct'); });

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
      q('[data-cb-pricelabel]').textContent = on ? 'Actual price (₹)' : 'Price (₹)';
      salePreview();
    }
    function read(){
      return {
        colorName: name.value.trim(), swatch: shade.value, price: price.value, salePercent: st.sale ? pct.value : undefined,
        stock: q('[data-cb="stock"]').value, lowStockThreshold: q('[data-cb="lowStockThreshold"]').value, files: st.files.slice()
      };
    }
    function destroy(){ st.urls.forEach(u => URL.revokeObjectURL(u)); st.urls = []; }
    salePreview();
    return { el: root, read, setSale, destroy, setPrice(v){ if(!st.priceTouched){ price.value = v; salePreview(); } }, setPct(v){ if(!st.pctTouched){ pct.value = v; salePreview(); } },
      focusName(){ name.focus(); }, nameInput: name, priceInput: price };
  }

  return { tip, blockHTML, wire, suggestShade, shadeOptionsHTML, esc };
})();
