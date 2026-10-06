// The "Order inquiry" window: one saree order, one form - what is wrong, which saree(s), a description and 3 photos taken
// with the camera. Used from Account -> Order History (logged in) and from the private e-mail link (guests, no login).
//   OrderInquiry.open({ order, onDone })                 logged-in customer (order = the order object from /orders)
//   OrderInquiry.open({ token, onDone })                 guest, from the private link: the order is fetched with the token
// The rules (who may ask, when, how many tries) all come from the server (utils/inquiry.js); this only shows them.
const OrderInquiry = (function(){
  'use strict';
  const esc = v => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const isTouch = () => (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) || /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const fmtDate = d => d ? new Date(d).toLocaleDateString('en-IN', { day:'numeric', month:'short', year:'numeric' }) : '';
  const STATUS_TEXT = {
    Requested: 'Waiting for our team to review it',
    Approved: 'Approved — please ship the saree(s) back to us',
    Received: 'We received your saree(s) and are checking them',
    Refunded: 'Refunded',
    Rejected: 'Not approved'
  };

  let root = null, opts = null, ctx = null, photos = [], busy = false, lastFocus = null;

  // ---- how this window talks to the server (logged in vs private link) ----
  function api(){
    if(opts.token){
      const t = encodeURIComponent(opts.token);
      return {
        load: () => apiFetch('/inquiry/' + t),
        upload: (files, onP) => returnUploadPhotos(files, onP, '/inquiry/' + t + '/photos'),
        send: body => apiFetch('/inquiry/' + t, { method:'POST', body: JSON.stringify(body) })
      };
    }
    return {
      load: async () => ({ order: opts.order, inquiry: await apiFetch('/returns/eligibility/' + encodeURIComponent(opts.order.id)) }),
      upload: (files, onP) => returnUploadPhotos(files, onP),
      send: body => apiFetch('/returns', { method:'POST', body: JSON.stringify(body) })
    };
  }

  function close(){
    if(!root) return;
    photos.forEach(f => f._preview && URL.revokeObjectURL(f._preview));
    photos = []; root.remove(); root = null;
    document.body.classList.remove('oi-open');
    document.removeEventListener('keydown', onKey);
    if(lastFocus && lastFocus.focus) lastFocus.focus();
  }
  function onKey(e){
    if(!root) return;
    if(e.key === 'Escape' && !busy && !document.querySelector('.cam-modal')) close();
    if(e.key === 'Tab'){
      const f = [...root.querySelectorAll('button, input, select, textarea, a[href]')].filter(x => !x.disabled && x.offsetParent !== null);
      if(!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if(e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if(!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
  }

  function shell(){
    root = document.createElement('div');
    root.className = 'oi-modal';
    root.innerHTML = `
      <div class="oi-backdrop" data-oi-close></div>
      <div class="oi-dialog" role="dialog" aria-modal="true" aria-labelledby="oiTitle">
        <div class="oi-head"><div><h3 id="oiTitle">Order inquiry</h3><span class="oi-order" data-oi-orderid></span></div><button type="button" class="oi-x" data-oi-close aria-label="Close">×</button></div>
        <div class="oi-body" data-oi-body><div class="loading-state"><span class="zari-spinner"></span>Loading…</div></div>
      </div>`;
    document.body.appendChild(root);
    document.body.classList.add('oi-open');
    root.addEventListener('click', e => { if(e.target.closest('[data-oi-close]') && !busy) close(); });
    document.addEventListener('keydown', onKey);
  }
  const body = () => root.querySelector('[data-oi-body]');

  // ---- views ----
  function noticeView(order, inq){
    const last = (inq.requests || [])[(inq.requests || []).length - 1];
    const lines = (inq.requests || []).map(r => `
      <div class="oi-hist ${r.status === 'Rejected' ? 'is-rejected' : ''}">
        <strong>Inquiry ${r.attempt} of ${inq.maxAttempts}</strong> · ${fmtDate(r.requestedAt)} — ${esc(STATUS_TEXT[r.status] || r.status)}
        ${r.adminNote ? `<p>Note from our team: ${esc(r.adminNote)}</p>` : ''}
      </div>`).join('');
    body().innerHTML = `
      <div class="oi-notice ${inq.finalRejected ? 'is-final' : ''}"><p>${esc(inq.message || 'An inquiry cannot be made for this order.')}</p></div>
      ${lines}
      <div class="oi-foot"><button type="button" class="btn btn-outline btn-sm" data-oi-close>Close</button><a class="btn btn-primary btn-sm" href="/contact">Contact us</a></div>`;
  }

  function doneView(res){
    body().innerHTML = `
      <div class="oi-done">
        <div class="oi-tick" aria-hidden="true">✓</div>
        <h4>Inquiry sent</h4>
        <p>Thank you. Our team will look at your photos and reply by e-mail, usually within 1–2 working days. If it is approved, we will tell you how to send the saree back, and your refund follows once we have checked it.</p>
        <button type="button" class="btn btn-primary btn-sm" data-oi-close>Done</button>
      </div>`;
    if(opts.onDone) try{ opts.onDone(res); }catch(e){ /* ignore */ }
  }

  function formView(order, inq){
    const items = order.items || [];
    const prev = (inq.requests || [])[(inq.requests || []).length - 1];
    body().innerHTML = `
      ${inq.secondChance ? `<div class="oi-notice is-second"><strong>This is your second and last chance.</strong>${prev && prev.adminNote ? `<p>Our note on your first inquiry: “${esc(prev.adminNote)}”</p>` : ''}<p>Clearer photos and a fuller description help us decide. After this inquiry our decision is final.</p></div>` : ''}
      <form id="oiForm" novalidate>
        <div class="form-field"><label for="oiType">What is your inquiry about?</label>
          <select id="oiType">${(inq.types || []).map(t => `<option value="${esc(t.key)}">${esc(t.label)}</option>`).join('')}</select></div>

        <div class="form-field"><label>Which saree(s)?</label>
          <div class="oi-items">${items.map(i => `
            <label class="oi-item"><input type="checkbox" data-oi-item="${i.id}" checked>
              <span class="oi-thumb" style="background:${typeof photoBg === 'function' ? photoBg(i.imageUrl, i.color, 90) : '#eee'};"></span>
              <span class="oi-item-text"><strong>${esc(i.name)}</strong><small>${esc(i.color || '')}${i.qty > 1 ? ' · ordered ' + i.qty : ''}</small></span>
              ${i.qty > 1 ? `<select data-oi-qty="${i.id}" aria-label="How many of ${esc(i.name)}">${Array.from({ length: i.qty }, (_, k) => `<option value="${i.qty - k}">${i.qty - k}</option>`).join('')}</select>` : ''}
            </label>`).join('')}</div></div>

        <div class="form-field"><label for="oiReason">What went wrong?</label>
          <select id="oiReason"><option value="">Choose a reason…</option>${(inq.reasons || []).map(r => `<option value="${esc(r.key)}">${esc(r.label)}</option>`).join('')}</select></div>

        <div class="form-field"><label for="oiDesc">Describe the problem</label>
          <textarea id="oiDesc" rows="4" maxlength="1000" placeholder="e.g. The pallu has a small tear near the border, and the colour is darker than in the photos."></textarea>
          <span class="oi-count" id="oiCount">0 / 1000</span></div>

        <div class="form-field"><label>Photos of the saree <span class="oi-req">(${inq.minPhotos} required)</span></label>
          <input type="file" id="oiCam" accept="image/*" capture="environment" hidden>
          <div class="return-photo-actions">
            <button type="button" class="btn btn-sm btn-outline" id="oiTake"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h3l2-2.5h6L17 8h3v11H4z"/><circle cx="12" cy="13" r="3.5"/></svg> Take a photo</button>
            <span class="return-photo-count" id="oiPhotoCount"></span>
          </div>
          <p class="oi-hint">Take clear photos with your camera in good light — the whole saree, and a close-up of the problem. Photos are taken here, not picked from your gallery. Up to ${inq.maxPhotos}.</p>
          <div class="return-photo-preview" id="oiPreview"></div></div>

        <div class="form-error" id="oiError"></div>
        <p class="oi-hint">Return window: ${inq.policy.windowDays} days from delivery${inq.deadline ? ' (open until ' + fmtDate(inq.deadline) + ')' : ''}. Your refund goes back the way you paid.</p>
        <div class="oi-foot"><button type="button" class="btn btn-outline btn-sm" data-oi-close>Cancel</button><button type="submit" class="btn btn-primary btn-sm" id="oiSend">Send inquiry</button></div>
      </form>`;
    wireForm(order, inq);
  }

  function wireForm(order, inq){
    const $ = id => root.querySelector('#' + id);
    const err = $('oiError');
    const showErr = m => { err.textContent = m; err.classList.add('show'); };
    const drawPhotos = () => {
      const box = $('oiPreview'); box.innerHTML = '';
      photos.forEach((file, i) => {
        if(!file._preview) file._preview = URL.createObjectURL(file);
        const item = document.createElement('div'); item.className = 'return-photo-item';
        const img = document.createElement('img'); img.src = file._preview; img.alt = 'Photo ' + (i + 1); img.className = 'return-photo-thumb';
        const rm = document.createElement('button'); rm.type = 'button'; rm.className = 'return-photo-remove'; rm.setAttribute('aria-label', 'Remove photo ' + (i + 1)); rm.textContent = '×';
        rm.addEventListener('click', () => { URL.revokeObjectURL(file._preview); photos.splice(i, 1); drawPhotos(); });
        item.appendChild(img); item.appendChild(rm); box.appendChild(item);
      });
      const n = photos.length;
      $('oiPhotoCount').textContent = n + ' of ' + inq.minPhotos + ' needed' + (n >= inq.minPhotos ? ' ✓' : '');
      $('oiTake').disabled = n >= inq.maxPhotos;
    };
    const addPhoto = async raw => {
      err.classList.remove('show');
      if(!raw) return;
      if(photos.length >= inq.maxPhotos){ showErr('You can add up to ' + inq.maxPhotos + ' photos.'); return; }
      const btn = $('oiTake'), label = btn.innerHTML; btn.disabled = true; btn.textContent = 'Preparing photo…';
      try{ photos.push(await shrinkPhoto(raw)); drawPhotos(); }
      catch(e){ showErr(e.message); }
      finally{ btn.innerHTML = label; btn.disabled = photos.length >= inq.maxPhotos; }
    };
    $('oiTake').addEventListener('click', () => { if(isTouch()) $('oiCam').click(); else webcam(addPhoto, showErr); });
    $('oiCam').addEventListener('change', () => { const f = $('oiCam').files && $('oiCam').files[0]; $('oiCam').value = ''; if(f) addPhoto(f); });
    $('oiDesc').addEventListener('input', e => { $('oiCount').textContent = e.target.value.length + ' / 1000'; });
    drawPhotos();

    $('oiForm').addEventListener('submit', async e => {
      e.preventDefault(); err.classList.remove('show');
      const chosen = [...root.querySelectorAll('[data-oi-item]')].filter(c => c.checked).map(c => {
        const q = root.querySelector(`[data-oi-qty="${c.dataset.oiItem}"]`);
        const it = order.items.find(x => String(x.id) === c.dataset.oiItem);
        return { orderItemId: Number(c.dataset.oiItem), qty: q ? Number(q.value) : it.qty };
      });
      const reason = $('oiReason').value, desc = $('oiDesc').value.trim();
      if(!chosen.length) return showErr('Select at least one saree.');
      if(!reason) return showErr('Choose what went wrong.');
      if(desc.length < 10) return showErr('Please describe the problem, in at least a sentence.');
      if(photos.length < inq.minPhotos) return showErr('Please add ' + inq.minPhotos + ' photos of the saree (' + photos.length + ' so far).');
      const send = $('oiSend'), idle = send.textContent;
      const setBusy = t => { busy = true; send.disabled = true; $('oiTake').disabled = true; send.textContent = t; };
      const setIdle = () => { busy = false; send.disabled = false; $('oiTake').disabled = photos.length >= inq.maxPhotos; send.textContent = idle; };
      try{
        setBusy('Uploading photos…');
        const { urls } = await api().upload(photos, (done, total, pct) => { send.textContent = done >= total ? 'Sending…' : 'Uploading ' + (done + 1) + '/' + total + ' · ' + pct + '%'; });
        send.textContent = 'Sending…';
        const res = await api().send({ orderId: order.id, type: $('oiType').value, reason, description: desc, items: chosen, photoUrls: urls });
        busy = false; photos.forEach(f => f._preview && URL.revokeObjectURL(f._preview)); photos = [];
        doneView(res);
      }catch(ex){ showErr(ex.message || 'Something went wrong. Please try again.'); setIdle(); }
    });
  }

  // Webcam window for computers (nothing can be picked from files); phones open their camera app instead.
  async function webcam(onFile, showErr){
    if(!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia){ showErr('This device has no camera we can use. Please open this page on your phone to take the photos.'); return; }
    let stream;
    try{ stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }); }
    catch(e){ showErr('We could not open the camera. Allow camera access in your browser, or open this page on your phone to take the photos.'); return; }
    const modal = document.createElement('div');
    modal.className = 'cam-modal'; modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-label', 'Take a photo');
    modal.innerHTML = '<div class="cam-box"><video class="cam-video" autoplay playsinline muted></video><div class="cam-actions"><button type="button" class="btn btn-primary btn-sm" data-cam="shoot">Take photo</button><button type="button" class="btn btn-sm" data-cam="cancel">Cancel</button></div></div>';
    document.body.appendChild(modal);
    const video = modal.querySelector('video'); video.srcObject = stream;
    const stop = () => { stream.getTracks().forEach(t => t.stop()); modal.remove(); };
    modal.addEventListener('click', async e => {
      const b = e.target.closest('[data-cam]'); if(!b) return;
      if(b.dataset.cam === 'cancel') return stop();
      if(!video.videoWidth) return;
      const c = document.createElement('canvas'); c.width = video.videoWidth; c.height = video.videoHeight;
      c.getContext('2d').drawImage(video, 0, 0);
      stop();
      const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.9));
      if(blob) onFile(new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
    });
    modal.querySelector('[data-cam="shoot"]').focus();
  }

  async function open(options){
    if(root) return;
    opts = options; lastFocus = document.activeElement; photos = []; busy = false;
    shell();
    try{
      ctx = await api().load();
      const order = ctx.order, inq = ctx.inquiry;
      root.querySelector('[data-oi-orderid]').textContent = 'Order #' + order.id;
      if(inq.eligible) formView(order, inq); else noticeView(order, inq);
      const f = root.querySelector('select, button.oi-x'); if(f) f.focus();
    }catch(e){
      body().innerHTML = `<div class="oi-notice"><p>${esc(e.message)}</p></div><div class="oi-foot"><button type="button" class="btn btn-outline btn-sm" data-oi-close>Close</button></div>`;
    }
  }

  return { open, close };
})();
