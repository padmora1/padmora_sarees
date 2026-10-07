// Admin: photos and the product video of a colour.
//
// A colour's gallery is ordered: 1st the main photo, 2nd the product video (optional), then any number of more photos.
// Customers see the video play when they hover a product card and on the second slide of the product page, so it must be
// short and light: MP4 or WEBM, at most 20MB and 30 seconds. These checks run in the browser BEFORE anything is sent, so a
// wrong file is explained at once instead of after a long upload; the server checks the same things again.
const AdminMedia = (function(){
  'use strict';
  const VIDEO_TYPES = ['video/mp4', 'video/webm'];
  const VIDEO_MAX_BYTES = 20 * 1024 * 1024;
  const VIDEO_MAX_SECONDS = 30;
  const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

  const mb = n => (n / 1024 / 1024).toFixed(1) + 'MB';

  // Resolves { ok: true, seconds } or { ok: false, error } for a chosen video file.
  function checkVideo(file){
    return new Promise(resolve => {
      if(!file) return resolve({ ok: false, error: 'No video chosen.' });
      if(!VIDEO_TYPES.includes(file.type)){
        return resolve({ ok: false, error: 'The product video must be an MP4 or WEBM file. A .mov from an iPhone often will not play in every browser — export it as MP4 (H.264) first.' });
      }
      if(file.size > VIDEO_MAX_BYTES){
        return resolve({ ok: false, error: `That video is ${mb(file.size)}. Keep the product video under 20MB (about 15 seconds at normal phone quality) so it starts quickly for customers.` });
      }
      const v = document.createElement('video');
      const url = URL.createObjectURL(file);
      let done = false;
      const finish = r => { if(done) return; done = true; clearTimeout(timer); v.removeAttribute('src'); v.load(); URL.revokeObjectURL(url); resolve(r); };
      const timer = setTimeout(() => finish({ ok: false, error: 'This video could not be read by the browser. Export it as an MP4 (H.264) and try again.' }), 12000);
      v.preload = 'metadata'; v.muted = true;
      const judge = () => {
        const s = v.duration;
        if(!isFinite(s) || s <= 0) return finish({ ok: false, error: 'This video could not be read by the browser. Export it as an MP4 (H.264) and try again.' });
        if(s > VIDEO_MAX_SECONDS) return finish({ ok: false, error: `That video is ${Math.round(s)} seconds long. Keep the product video to ${VIDEO_MAX_SECONDS} seconds or less (8–15 seconds is ideal).` });
        finish({ ok: true, seconds: s });
      };
      v.onloadedmetadata = () => {
        // some WEBM files do not state their length up front; jumping to the end makes the browser work it out
        if(v.duration === Infinity){ v.ontimeupdate = () => { if(v.duration !== Infinity){ v.ontimeupdate = null; judge(); } }; try{ v.currentTime = 1e7; }catch(e){ judge(); } return; }
        judge();
      };
      v.onerror = () => finish({ ok: false, error: 'This video could not be read by the browser. Export it as an MP4 (H.264) and try again.' });
      v.src = url;
    });
  }

  // Photos are shrunk first (the admin page's own helper); a video goes up as it is.
  async function prepare(file){
    if(file && file.type.startsWith('image/') && typeof prepareImageForUpload === 'function') return prepareImageForUpload(file);
    return file;
  }

  // Sends one file to a colour with progress (XHR, because fetch cannot report upload progress). Resolves the server's JSON.
  function upload(variantId, file, onProgress){
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/admin/variants/' + variantId + '/media');
      const token = typeof getAdminToken === 'function' ? getAdminToken() : '';
      if(token) xhr.setRequestHeader('Authorization', 'Bearer ' + token);
      xhr.timeout = UPLOAD_TIMEOUT_MS;
      xhr.upload.onprogress = e => { if(onProgress && e.lengthComputable) onProgress(Math.round(e.loaded / e.total * 100)); };
      xhr.onload = () => {
        let j = {}; try{ j = JSON.parse(xhr.responseText); }catch(e){ /* no body */ }
        if(xhr.status === 401){ try{ clearAdminToken(); }catch(e){} window.location.href = '/admin-login'; return reject(new Error('Please log in again.')); }
        if(xhr.status >= 200 && xhr.status < 300) resolve(j);
        else reject(new Error(j.message || 'Upload failed (' + xhr.status + ').'));
      };
      xhr.onerror = () => reject(new Error('The upload was interrupted — check the connection and try again.'));
      xhr.ontimeout = () => reject(new Error('The upload took too long and was stopped. Try a smaller file or a better connection.'));
      const fd = new FormData();
      fd.append('file', file);
      xhr.send(fd);
    });
  }

  // Uploads files one after another (so the order is kept: main photo, then video, then more photos). Calls
  // onStep(doneCount, total, percentOfCurrentFile, file, 'progress' | 'done') as it goes. Stops at the first failure and says which file failed.
  async function uploadSet(variantId, files, onStep){
    let done = 0;
    for(const original of files){
      const file = await prepare(original);
      if(onStep) onStep(done, files.length, 0, file, 'progress');
      try{ await upload(variantId, file, pct => { if(onStep) onStep(done, files.length, pct, file, 'progress'); }); }
      catch(err){ err.uploaded = done; err.failedFile = original.name; throw err; }
      done++;
      if(onStep) onStep(done, files.length, 100, file, 'done');
    }
    return done;
  }

  // The gallery order the customer sees: [main photo, video, more photos...]. media = a colour's media list from the API.
  function ordered(media){
    const list = media || [];
    const images = list.filter(m => m.type === 'image');
    const main = images.find(m => m.isPrimary) || images[0] || null;
    const video = list.find(m => m.type === 'video') || null;
    return [main, video, ...images.filter(m => m !== main)].filter(Boolean);
  }

  return { checkVideo, prepare, upload, uploadSet, ordered, VIDEO_MAX_BYTES, VIDEO_MAX_SECONDS };
})();
