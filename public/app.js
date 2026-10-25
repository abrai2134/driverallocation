'use strict';

// ---------- small helpers ----------
const $app = document.getElementById('app');
const state = { pub: { orgName: 'Driver Allocation', vehicleTypes: ['4W', '3W', '2W'] }, me: null, tab: 'today', admin: null, from: null, to: null };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const VEHICLE_NAMES = { '4W': 'Four-wheeler', '3W': 'Three-wheeler', '2W': 'Two-wheeler' };

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    method: opts.method || 'GET',
    headers: opts.body ? { 'Content-Type': 'application/json' } : {},
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && path !== '/login') { state.me = null; render(); throw new Error(data.error || 'Please log in'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function toast(msg, bad) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = 'toast' + (bad ? ' bad' : '');
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3200);
}

function dateObj(d) { return new Date(d + 'T00:00:00Z'); }
function fmtDate(d, opts = { weekday: 'short', day: 'numeric', month: 'short' }) {
  return dateObj(d).toLocaleDateString('en-IN', { ...opts, timeZone: 'UTC' });
}
function addDays(d, n) { const x = dateObj(d); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); }
function dayName(d) { return DAYS[dateObj(d).getUTCDay()]; }

function slotSpec(unitId, slot) {
  const u = A().units.find((x) => x.id === unitId);
  return (u && u.slots && u.slots[slot]) || { type: 'ANY', second: 'ANY' };
}
function slotLabel(spec) {
  if (spec.type === 'ANY') return 'Any vehicle';
  if (spec.second === 'NONE') return `${spec.type} only`;
  if (spec.second === 'ANY') return `${spec.type}, else any`;
  return `${spec.type}, else ${spec.second}`;
}
function slotHtml(spec) {
  if (spec.type === 'ANY') return '<span class="muted small">Any vehicle</span>';
  const tail = spec.second === 'NONE' ? ' <span class="small">only</span>' : spec.second === 'ANY' ? ' <span class="small muted">→ any</span>' : ` <span class="small muted">→</span> ${vbadge(spec.second)}`;
  return vbadge(spec.type) + tail;
}
// 0 = 1st choice, 1 = 2nd choice, 2 = other vehicle, -1 = not allowed (same rules as the server).
function vehicleFit(spec, t) {
  if (spec.type === 'ANY' || spec.type === t) return 0;
  if (spec.second === t) return 1;
  return spec.second === 'ANY' ? 2 : -1;
}
// Small note when the driver's vehicle is not the slot's 1st choice.
function wantNote(unitId, slot, d) {
  if (!d) return '';
  const spec = slotSpec(unitId, slot);
  const fit = vehicleFit(spec, d.vehicleType);
  if (fit === 1) return ' <span class="badge">2nd choice</span>';
  if (fit === 2) return ` <span class="badge warn">wanted ${esc(spec.type)}</span>`;
  return '';
}
function vbadge(t) { return `<span class="badge ${t === '4W' ? 'w4' : t === '3W' ? 'w3' : 'w2'}">${esc(t)}</span>`; }
function telLink(phone, label) {
  if (!phone) return '';
  return `<a href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">${esc(label || phone)}</a>`;
}

const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
function openModal(html, onSubmit) {
  modalBody.innerHTML = html;
  // Cancel must close the form even when required fields are still empty.
  modalBody.querySelectorAll('button[value=cancel]').forEach((b) => (b.formNoValidate = true));
  modalBody.onsubmit = async (e) => {
    const btn = e.submitter;
    if (btn && btn.value === 'cancel') return; // let dialog close
    e.preventDefault();
    const err = modalBody.querySelector('.error');
    if (err) err.remove();
    try {
      if (btn) btn.disabled = true;
      await onSubmit(new FormData(modalBody), modalBody);
      modal.close();
    } catch (ex) {
      modalBody.querySelector('.actions').insertAdjacentHTML('beforebegin', `<div class="error">${esc(ex.message)}</div>`);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  modal.showModal();
}

// ---------- boot ----------
async function boot() {
  try { state.pub = await api('/public'); state.incentivePct = state.pub.internalPercent; } catch { /* keep defaults */ }
  document.title = state.pub.orgName;
  try { state.me = await api('/me'); } catch { state.me = null; }
  render();
}

function render() {
  if (!state.me || !state.me.role) return renderLogin();
  if (state.me.role === 'admin') return renderAdmin();
  if (state.me.role === 'unit') return renderUnit();
  if (state.me.role === 'driver') return renderDriver();
}

function topbar(subtitle) {
  return `<div class="topbar">
    <div><div class="title">${esc(state.pub.orgName)}</div><div class="who">${esc(subtitle)}</div></div>
    <div class="spacer"></div>
    <button id="logout">Log out</button>
  </div>`;
}
function bindLogout() {
  document.getElementById('logout').onclick = async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    state.me = null;
    state.admin = null;
    render();
  };
}

// ---------- login ----------
function renderLogin(role = localStorageGet('role') || 'unit') {
  const labels = { unit: 'Unit login ID', driver: 'Driver login ID (usually phone no.)', admin: 'Admin username' };
  $app.innerHTML = `<div class="login">
    <div class="brand"><div class="logo">🚚</div><h1>${esc(state.pub.orgName)}</h1><div class="muted">Daily driver allocation</div></div>
    <div class="card">
      <div class="role-switch">
        <button type="button" data-role="unit" class="${role === 'unit' ? 'on' : ''}"><span>🏢</span>Unit</button>
        <button type="button" data-role="driver" class="${role === 'driver' ? 'on' : ''}"><span>🧑‍✈️</span>Driver</button>
        <button type="button" data-role="admin" class="${role === 'admin' ? 'on' : ''}"><span>🔑</span>Admin</button>
      </div>
      <form id="login-form">
        <label>${labels[role]}</label>
        <input name="username" autocomplete="username" autocapitalize="none" required>
        <label>Password${role === 'driver' ? ' / PIN' : ''}</label>
        <input name="password" type="password" autocomplete="current-password" required>
        <button class="primary" type="submit">Log in</button>
      </form>
    </div>
    <p class="muted small" style="text-align:center">Ask your admin for your login ID and password.</p>
  </div>`;
  $app.querySelectorAll('[data-role]').forEach((b) => (b.onclick = () => { localStorageSet('role', b.dataset.role); renderLogin(b.dataset.role); }));
  const form = document.getElementById('login-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const old = form.querySelector('.error');
    if (old) old.remove();
    try {
      await api('/login', { method: 'POST', body: { role, username: fd.get('username'), password: fd.get('password') } });
      state.me = await api('/me');
      state.tab = 'today';
      render();
    } catch (ex) {
      form.insertAdjacentHTML('beforeend', `<div class="error">${esc(ex.message)}</div>`);
    }
  };
}
function localStorageGet(k) { try { return localStorage.getItem('da_' + k); } catch { return null; } }
function localStorageSet(k, v) { try { localStorage.setItem('da_' + k, v); } catch { /* ignore */ } }

// ---------- unit view ----------
async function renderUnit() {
  $app.innerHTML = topbar('Unit: ' + state.me.name) + '<div class="wrap"><div class="loading">Loading…</div></div>';
  bindLogout();
  const data = await api('/unit/home');
  const [first, ...rest] = data.days;
  const extraBadge = (d) => d.extra ? ` <span class="badge warn">Emergency extra</span>` : '';
  const cancelBtn = (date, d) => d.extra ? `<button class="link small" data-cancel="${esc(date)}|${d.slot}" style="color:inherit;text-decoration:underline">Cancel extra</button>` : '';
  const driverBlock = (d) => d
    ? `<div class="person"><div class="big">${esc(d.name)}${extraBadge(d)}</div>
        <div class="line">${esc(VEHICLE_NAMES[d.vehicleType] || d.vehicleType)}${d.vehicleNo ? ' · ' + esc(d.vehicleNo) : ''}${d.reason ? ' · ' + esc(d.reason) : ''}</div>
        <div class="row">${d.phone ? `<a class="call" href="tel:${esc(d.phone.replace(/[^\d+]/g, ''))}">📞 Call ${esc(d.phone)}</a>` : ''} ${cancelBtn(first.date, d)}</div></div>`
    : `<div class="person"><div class="big">No driver available</div><div class="line">Please contact the admin.</div></div>`;
  const others = (day) => {
    const lost = day.otherExtras.filter((o) => o.fromMe);
    const rest = day.otherExtras.filter((o) => !o.fromMe);
    return (lost.length ? `<div class="badge bad" style="margin-top:6px;white-space:normal">⚠ ${lost.map((o) => `${esc(o.driver)} was taken by ${esc(o.unit)} for an emergency`).join('; ')}</div>` : '') +
      (rest.length ? `<div class="muted small" style="margin-top:4px">Emergency: ${rest.map((o) => `${esc(o.driver)} → ${esc(o.unit)}`).join(', ')}</div>` : '');
  };
  const hero = !first.working && !first.drivers.length
    ? `<div class="hero off"><div class="label">Today · ${esc(fmtDate(first.date))}</div><div class="big">Holiday / off day</div><div class="line">No deliveries scheduled.</div></div>`
    : `<div class="hero"><div class="label">Your driver today · ${esc(fmtDate(first.date))}</div>${first.drivers.map(driverBlock).join('') || driverBlock(null)}</div>`;
  const list = rest.map((d) => `<div class="day"><div class="date">${esc(dayName(d.date))}<small>${esc(fmtDate(d.date, { day: 'numeric', month: 'short' }))}</small></div>
    <div>${!d.working && !d.drivers.length ? '<span class="muted">Off day</span>' : (d.drivers.map((x) => `<div><b>${esc(x.name)}</b> ${vbadge(x.vehicleType)}${extraBadge(x)} ${telLink(x.phone)} ${cancelBtn(d.date, x)}</div>`).join('') || '<div class="empty">Not assigned</div>')}${others(d)}</div></div>`).join('');
  $app.querySelector('.wrap').innerHTML = `${hero}
    <div class="card section"><div class="row"><div><h2 style="margin:0">Need one more driver?</h2>
      <div class="muted small">For a shortage or emergency. Pick any driver: a free driver is best. If you pick a driver working at another unit, they move to you and that unit is told.</div></div>
      <div class="spacer"></div><button class="primary" id="need-extra">+ Ask for an emergency driver</button></div>
      ${others(first) ? `<div style="margin-top:8px"><b class="small">Today</b>${others(first)}</div>` : ''}</div>
    <div class="card section"><h2>Deliveries today (${data.trips.filter((t) => t.dropAt).length} done)</h2>
      ${data.trips.filter((t) => !t.dropAt).map((t) => tripRow(t, { showDriver: true, showUnit: false })).join('')}
      ${data.trips.some((t) => t.dropAt) ? doneList(data.trips.filter((t) => t.dropAt), { showDriver: true }) : ''}
      ${!data.trips.length ? '<p class="muted small">No deliveries recorded today yet.</p>' : ''}
      <h3 style="margin-top:12px">Month-wise deliveries</h3>${monthTable(data.months)}</div>
    <div class="card"><h2>Next days</h2><div class="daylist">${list}</div></div>`;
  document.getElementById('need-extra').onclick = () => askExtra(data);
  $app.querySelectorAll('[data-cancel]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Cancel this emergency driver? They become free for other units.')) return;
    const [date, slot] = b.dataset.cancel.split('|');
    try { await api('/unit/extra/cancel', { method: 'POST', body: { date, slot: Number(slot) } }); toast('Cancelled'); renderUnit(); } catch (ex) { toast(ex.message, true); }
  }));
}

function askExtra(data) {
  const dayOpts = data.days.map((d, i) => `<option value="${esc(d.date)}">${i === 0 ? 'Today' : esc(dayName(d.date))} – ${esc(fmtDate(d.date, { day: 'numeric', month: 'short' }))}</option>`).join('');
  openModal(`<h2>Ask for an emergency driver</h2>
    <label>Day</label><select name="date" id="x-date">${dayOpts}</select>
    <label>Driver</label><div id="x-list" class="muted">Loading…</div>
    <label>Reason (optional)</label><input name="reason" placeholder="e.g. extra delivery, driver busy">
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok" id="x-ok">Take this driver</button></div>`,
  async (fd) => {
    const driverId = fd.get('driverId');
    if (!driverId) throw new Error('Choose a driver');
    const opt = document.querySelector('#x-driver option:checked');
    if (opt && opt.dataset.at && !confirm(`${opt.dataset.name} is working at ${opt.dataset.at}. Move them to you? ${opt.dataset.at} will be told.`)) throw new Error('Not moved');
    await api('/unit/extra', { method: 'POST', body: { date: fd.get('date'), driverId, reason: fd.get('reason') } });
    toast('Driver reserved for you');
    renderUnit();
  });
  const load = async () => {
    const box = document.getElementById('x-list');
    const ok = document.getElementById('x-ok');
    box.innerHTML = 'Loading…';
    try {
      const r = await api('/unit/free?date=' + document.getElementById('x-date').value);
      const note = { free: 'free', other: 'now at ', emergency: 'emergency at ', mine: 'already with you' };
      const usable = r.drivers.filter((d) => d.status === 'free' || d.status === 'other');
      ok.disabled = !usable.length;
      const freeCount = r.drivers.filter((d) => d.status === 'free').length;
      box.innerHTML = r.drivers.length
        ? `<select name="driverId" id="x-driver">
            ${r.drivers.map((d) => {
              const can = d.status === 'free' || d.status === 'other';
              const where = d.status === 'other' || d.status === 'emergency' ? note[d.status] + d.at : note[d.status];
              return `<option value="${esc(d.id)}" ${can ? '' : 'disabled'} data-name="${esc(d.name)}" data-at="${d.status === 'other' ? esc(d.at) : ''}">${esc(d.name)} (${esc(d.vehicleType)}) – ${esc(where)}</option>`;
            }).join('')}
          </select>
          <div class="small ${freeCount ? 'muted' : ''}" id="x-hint" style="margin-top:6px"></div>`
        : '<div class="error">No driver is available that day (all inactive or on leave). Please call the admin.</div>';
      const sel = document.getElementById('x-driver');
      const hint = document.getElementById('x-hint');
      const sync = () => {
        const o = sel.options[sel.selectedIndex];
        hint.innerHTML = o && o.dataset.at
          ? `<span class="badge warn" style="white-space:normal">${esc(o.dataset.name)} will move from ${esc(o.dataset.at)} to you. ${esc(o.dataset.at)} will see this.</span>`
          : freeCount ? `${freeCount} free driver(s) at the top of the list.` : '';
      };
      if (sel) { sel.onchange = sync; sync(); }
    } catch (ex) { box.innerHTML = `<div class="error">${esc(ex.message)}</div>`; }
  };
  document.getElementById('x-date').onchange = load;
  load();
}


// ---------- deliveries helpers ----------
function fmtTime(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: state.pub.timezone || 'Asia/Kolkata' });
}
// ISO -> 'YYYY-MM-DDTHH:mm' in the company time zone (for <input type="datetime-local">).
function toLocalInput(iso) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: state.pub.timezone || 'Asia/Kolkata', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(iso ? new Date(iso) : new Date()).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
// Remarks shown on a delivery (wrong entry, manual time, admin correction, admin comment).
function tripRemarks(t) {
  const out = [];
  if (t.wrongEntry) out.push('<span class="badge bad">Wrong entry – drop uploaded next day</span>');
  if (t.dropTimeManual) out.push(`<span class="badge">Drop time entered manually · uploaded ${esc(fmtDate(toLocalInput(t.dropUploadedAt).slice(0, 10), { day: 'numeric', month: 'short' }))} ${esc(fmtTime(t.dropUploadedAt))}</span>`);
  if (t.adminEdited) out.push('<span class="badge manual">Time corrected by admin</span>');
  if (t.adminNote) out.push(`<span class="small">💬 ${esc(t.adminNote)}</span>`);
  return out.length ? `<div class="row" style="gap:4px;margin-top:4px">${out.join(' ')}</div>` : '';
}
function money(v) {
  return '₹' + (Number(v) || 0).toFixed(2);
}
// "Unit / Other" picker used for pickup and drop.
function placePicker(name, units, selected, otherValue, placeholder) {
  return `<select name="${name}" class="place-select" required>
      ${selected ? '' : '<option value="">— Choose —</option>'}
      ${units.map((u) => `<option value="${esc(u.id)}" ${u.id === selected ? 'selected' : ''}>Unit ${esc(u.name)}</option>`).join('')}
      <option value="OTHER" ${selected === 'OTHER' ? 'selected' : ''}>Other – client / vendor</option>
    </select>
    <input name="${name}Other" class="place-other" placeholder="${esc(placeholder)}" value="${esc(otherValue || '')}" style="margin-top:6px">`;
}
function bindPlacePickers(root) {
  root.querySelectorAll('.place-select').forEach((sel) => {
    const other = sel.nextElementSibling;
    const sync = () => { other.hidden = sel.value !== 'OTHER'; other.required = sel.value === 'OTHER'; };
    sel.addEventListener('change', sync);
    sync();
  });
}
function fmtDur(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  return h ? `${h}h ${min % 60}m` : `${min}m`;
}
function thumb(url, label) {
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="${esc(label)}"><img src="${esc(url)}" alt="${esc(label)}" class="thumb" loading="lazy"></a>` : '';
}

// Shrink a camera photo before upload (keeps uploads fast and disk use low).
async function compressImage(file, max = 1280, quality = 0.7) {
  let src;
  try {
    src = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    src = await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read the photo'));
      img.src = URL.createObjectURL(file);
    });
  }
  const scale = Math.min(1, max / Math.max(src.width, src.height));
  const c = document.createElement('canvas');
  c.width = Math.round(src.width * scale);
  c.height = Math.round(src.height * scale);
  c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}

// Finger / mouse signature box. Returns { isEmpty(), toDataURL(), clear() }.
function signaturePad(canvas) {
  const ratio = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 300;
  const hgt = canvas.clientHeight || 160;
  canvas.width = w * ratio;
  canvas.height = hgt * ratio;
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.lineWidth = 2.2;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#111';
  let drawing = false;
  let empty = true;
  const pos = (e) => { const r = canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };
  canvas.addEventListener('pointerdown', (e) => { drawing = true; canvas.setPointerCapture(e.pointerId); const [x, y] = pos(e); ctx.beginPath(); ctx.moveTo(x, y); });
  canvas.addEventListener('pointermove', (e) => { if (!drawing) return; const [x, y] = pos(e); ctx.lineTo(x, y); ctx.stroke(); empty = false; });
  const stop = () => { drawing = false; };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  return {
    isEmpty: () => empty,
    clear: () => { ctx.clearRect(0, 0, w, hgt); empty = true; },
    toDataURL: () => {
      // white background so the signature is readable anywhere
      const out = document.createElement('canvas');
      out.width = canvas.width; out.height = canvas.height;
      const o = out.getContext('2d');
      o.fillStyle = '#fff'; o.fillRect(0, 0, out.width, out.height); o.drawImage(canvas, 0, 0);
      return out.toDataURL('image/jpeg', 0.8);
    },
  };
}

// Shared pickup / drop form. kind = 'pickup' | 'drop'.
function deliveryForm(kind, { units = [], defaultUnit = '', trip = null, onDone }) {
  const isPick = kind === 'pickup';
  openModal(`<h2>${isPick ? '📦 Pickup' : '✅ Drop / delivery'}</h2>
    ${isPick
      ? `<label>Pickup from *</label>${placePicker('unitId', units, defaultUnit, '', 'Client / vendor name')}`
      : `<div class="muted">From ${esc(trip.unitName)} · picked up at ${esc(fmtTime(trip.pickupAt))}${trip.pickupNote ? ' · ' + esc(trip.pickupNote) : ''}</div>
         <label>Drop to *</label>${placePicker('dropUnitId', units, '', '', 'Client / vendor name')}
         <div class="muted small">Unit to unit = internal delivery (incentive ${esc(state.incentivePct || 50)}%).</div>`}
    <label>${isPick ? 'Photo of pickup material *' : 'Photo of challan *'}</label>
    <input type="file" name="photo" accept="image/*" capture="environment" required>
    <img id="preview" class="thumb" style="display:none;width:120px;height:auto;margin-top:6px">
    <label>${isPick ? 'Material / remarks (optional)' : 'Remarks (optional)'}</label>
    <input name="note" placeholder="${isPick ? 'e.g. 20 boxes' : 'e.g. delivered at gate'}">
    <label>Signature ${isPick ? 'of person handing over' : 'of receiver'} *</label>
    <canvas id="sig" class="sig"></canvas>
    <div class="row"><button type="button" class="link" id="sig-clear">Clear signature</button></div>
    <label>Name of person signing</label>
    <input name="signer" placeholder="optional">
    ${isPick ? '' : `<label class="check" style="margin-top:12px"><input type="checkbox" name="late" id="late" ${trip.date !== toLocalInput().slice(0, 10) ? 'checked' : ''}> I forgot to record the drop at the time – enter the actual drop time</label>
    <div id="late-box"><label>Actual drop date &amp; time</label><input type="datetime-local" name="dropTime" min="${esc(toLocalInput(trip.pickupAt))}" max="${esc(toLocalInput())}" value="${esc(toLocalInput())}">
      <div class="muted small">This delivery will be marked "drop time entered manually".</div></div>`}
    <div class="muted small" style="margin-top:8px">The time is recorded automatically when you save.</div>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">${isPick ? 'Save pickup' : 'Save drop'}</button></div>`,
  async (fd) => {
    const file = fd.get('photo');
    if (!file || !file.size) throw new Error(isPick ? 'Photo of the material is required' : 'Photo of the challan is required');
    if (pad.isEmpty()) throw new Error('Signature is required');
    const photo = await compressImage(file);
    const body = { photo, signature: pad.toDataURL(), note: fd.get('note'), signer: fd.get('signer') };
    if (!isPick && fd.get('late') === 'on') {
      if (!fd.get('dropTime')) throw new Error('Enter the actual drop date and time');
      body.dropTime = fd.get('dropTime');
    }
    if (isPick) await api('/driver/trips', { method: 'POST', body: { ...body, unitId: fd.get('unitId'), pickupOther: fd.get('unitIdOther') } });
    else await api(`/driver/trips/${trip.id}/drop`, { method: 'POST', body: { ...body, dropUnitId: fd.get('dropUnitId'), dropOther: fd.get('dropUnitIdOther') } });
    toast(isPick ? 'Pickup saved' : 'Drop saved');
    onDone();
  });
  bindPlacePickers(modalBody);
  const pad = signaturePad(document.getElementById('sig'));
  const late = document.getElementById('late');
  if (late) {
    const box = document.getElementById('late-box');
    const sync = () => (box.hidden = !late.checked);
    late.onchange = sync;
    sync();
  }
  document.getElementById('sig-clear').onclick = () => pad.clear();
  modalBody.querySelector('[name=photo]').onchange = (e) => {
    const f = e.target.files[0];
    const img = document.getElementById('preview');
    if (f) { img.src = URL.createObjectURL(f); img.style.display = 'block'; }
  };
}

function tripRow(t, { showDriver = false, showUnit = true } = {}) {
  return `<div class="trip">
    <div class="row"><b>${showDriver ? esc(t.driverName) + ' · ' : ''}${showUnit ? 'From ' + esc(t.unitName) : ''}${t.dropName ? ' → ' + esc(t.dropName) : ''}</b>
      ${t.dropAt ? `<span class="badge ok">Delivered · ${esc(fmtDur(t.minutes))}</span>` : '<span class="badge warn">In transit</span>'}</div>
    <div class="small">📦 Pickup ${esc(fmtTime(t.pickupAt))}${t.pickupNote ? ' · ' + esc(t.pickupNote) : ''}${t.pickupSigner ? ' · signed by ' + esc(t.pickupSigner) : ''}</div>
    ${tripRemarks(t)}
    ${t.dropAt ? `<div class="small">✅ Drop ${esc(fmtTime(t.dropAt))}${t.dropNote ? ' · ' + esc(t.dropNote) : ''}${t.dropSigner ? ' · signed by ' + esc(t.dropSigner) : ''}</div>` : ''}
    <div class="thumbs">${thumb(t.pickupPhoto, 'Pickup material')}${thumb(t.pickupSign, 'Pickup signature')}${thumb(t.dropPhoto, 'Challan')}${thumb(t.dropSign, 'Drop signature')}</div>
  </div>`;
}

// ---------- driver view ----------
async function renderDriver() {
  $app.innerHTML = topbar('Driver: ' + state.me.name) + '<div class="wrap"><div class="loading">Loading…</div></div>';
  bindLogout();
  const data = await api('/driver/home');
  const [first, ...rest] = data.days;
  let hero;
  if (!first.working) hero = `<div class="hero off"><div class="label">Today · ${esc(fmtDate(first.date))}</div><div class="big">Off day</div></div>`;
  else if (first.onLeave) hero = `<div class="hero off"><div class="label">Today · ${esc(fmtDate(first.date))}</div><div class="big">You are on leave</div></div>`;
  else if (!first.unit) hero = `<div class="hero off"><div class="label">Today · ${esc(fmtDate(first.date))}</div><div class="big">Rest day</div><div class="line">No unit assigned to you today.</div></div>`;
  else {
    const u = first.unit;
    hero = `<div class="hero"><div class="label">Today you serve · ${esc(fmtDate(first.date))}${first.extra ? ' · emergency request' : ''}</div>
      <div class="big">${esc(u.name)}</div>
      ${u.address ? `<div class="line">📍 ${esc(u.address)}</div>` : ''}
      ${u.contactName ? `<div class="line">👤 ${esc(u.contactName)}</div>` : ''}
      <div class="row">${u.phone ? `<a class="call" href="tel:${esc(u.phone.replace(/[^\d+]/g, ''))}">📞 Call ${esc(u.phone)}</a>` : ''}
      ${u.address ? `<a class="call" target="_blank" rel="noopener" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(u.address)}">🗺️ Map</a>` : ''}</div></div>`;
  }
  const list = rest.map((d) => `<div class="day"><div class="date">${esc(dayName(d.date))}<small>${esc(fmtDate(d.date, { day: 'numeric', month: 'short' }))}</small></div>
    <div>${!d.working ? '<span class="muted">Off day</span>' : d.onLeave ? '<span class="badge warn">Leave</span>' : d.unit ? `<b>${esc(d.unit.name)}</b>${d.extra ? ' <span class="badge warn">Emergency</span>' : ''}${d.unit.address ? `<div class="muted small">${esc(d.unit.address)}</div>` : ''}` : '<span class="muted">Rest day</span>'}</div></div>`).join('');
  const open = data.trips.filter((t) => !t.dropAt);
  const done = data.trips.filter((t) => t.dropAt && t.date === data.today);
  const totalMin = done.reduce((n, t) => n + t.minutes, 0);
  const thisMonth = data.months[0] || { count: 0, minutes: 0 };
  const tab = state.dTab || (open.length ? 'transit' : 'done');
  const tabBtn = (k, label) => `<button class="${tab === k ? 'on' : ''}" data-dtab="${k}">${label}</button>`;
  $app.querySelector('.wrap').innerHTML = `${hero}
    <div class="card section">
      <div class="row"><div><h2 style="margin:0">Deliveries</h2>
        <div class="muted small">Today: ${done.length} delivered${done.length ? ' · ' + esc(fmtDur(totalMin)) : ''} · <b class="bonus-inline">${esc(money(done.reduce((n, t) => n + (t.incentive || 0), 0)))}</b></div>
        <div class="muted small">This month: ${thisMonth.count} delivered${thisMonth.count ? ' · ' + esc(fmtDur(thisMonth.minutes)) : ''} · <b class="bonus-inline">${esc(money(thisMonth.incentive))}</b> incentive</div></div>
        <div class="spacer"></div><button class="primary" id="new-pickup">📦 New pickup</button></div>
      <div class="subtabs">${tabBtn('transit', `In transit (${open.length})`)}${tabBtn('done', `Completed today (${done.length})`)}${tabBtn('month', 'Monthly')}</div>
      <div id="dtab-body"></div>
    </div>
    <div class="card"><div class="row"><h2>Next days</h2><div class="spacer"></div><span class="badge ok">${data.monthDuties} duties this month</span></div><div class="daylist">${list}</div></div>`;
  const body = document.getElementById('dtab-body');
  if (tab === 'transit') {
    body.innerHTML = open.length
      ? `<div class="error" style="background:var(--warn-bg);color:var(--warn)">Complete the drop (challan photo + signature) for every pickup.</div>
         ${open.map((t) => `${tripRow(t)}<button class="primary" data-drop="${esc(t.id)}" style="margin:4px 0 10px">✅ Drop – upload challan</button>`).join('')}`
      : '<p class="muted">Nothing in transit. Tap "New pickup" when you collect material.</p>';
  } else if (tab === 'done') {
    body.innerHTML = done.length ? doneList(done) : '<p class="muted">No completed deliveries yet today.</p>';
  } else {
    body.innerHTML = '<div class="loading">Loading…</div>';
    driverMonthly(body);
  }
  $app.querySelectorAll('[data-dtab]').forEach((b) => (b.onclick = () => { state.dTab = b.dataset.dtab; renderDriver(); }));
  document.getElementById('new-pickup').onclick = () => deliveryForm('pickup', { units: data.units, defaultUnit: first.unit ? first.unit.id : '', onDone: () => { state.dTab = 'transit'; renderDriver(); } });
  $app.querySelectorAll('[data-drop]').forEach((b) => (b.onclick = () => deliveryForm('drop', { units: data.units, trip: data.trips.find((t) => t.id === b.dataset.drop), onDone: () => { state.dTab = 'done'; renderDriver(); } })));
}

function fmtMonth(m) {
  return new Date(m + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

// Compact list of completed deliveries with time taken.
function doneList(trips, { showDriver = false, showDate = false } = {}) {
  return `<div class="done-list">${trips.map((t) => `<div class="done-row">
      <div class="grow">
        <div><b>${showDriver ? esc(t.driverName) + ' · ' : ''}${esc(t.unitName)} → ${esc(t.dropName || '?')}</b> ${t.dropName ? (t.internal ? '<span class="badge">Internal</span>' : '<span class="badge ok">External</span>') : ''}${t.dropNote ? ` <span class="small muted">${esc(t.dropNote)}</span>` : ''}</div>
        <div class="small muted">${showDate ? esc(fmtDate(t.date)) + ' · ' : ''}📦 ${esc(fmtTime(t.pickupAt))} → ✅ ${esc(fmtTime(t.dropAt))}${t.pickupNote ? ' · ' + esc(t.pickupNote) : ''}</div>
        ${tripRemarks(t)}
        <div class="thumbs small-thumbs">${thumb(t.pickupPhoto, 'Pickup material')}${thumb(t.pickupSign, 'Pickup signature')}${thumb(t.dropPhoto, 'Challan')}${thumb(t.dropSign, 'Drop signature')}</div>
      </div>
      ${t.wrongEntry
        ? `<div class="dur" style="color:var(--bad)">Wrong entry<div class="small muted">${esc(fmtDur(t.rawMinutes))} · not counted</div></div>`
        : `<div class="dur">${esc(fmtDur(t.minutes))}<div class="small muted">time taken</div><div class="bonus">${esc(money(t.incentive))}</div><div class="small muted">${t.minutes ? `${t.minutes} min × ${t.rate}${t.internal ? ` × ${t.incentivePct}%` : ''}` : ''}</div></div>`}
    </div>`).join('')}</div>`;
}

function monthTable(months, onPick, picked, showIncentive) {
  return `<div class="table-wrap section"><table><thead><tr><th>Month</th><th class="num">Deliveries</th><th class="num">Total time</th><th class="num">Avg / delivery</th>${showIncentive ? '<th class="num">Incentive</th>' : ''}</tr></thead><tbody>
    ${months.map((m) => `<tr ${onPick ? `data-month="${m.month}" style="cursor:pointer"` : ''} class="${picked === m.month ? 'picked' : ''}"><td><b>${esc(fmtMonth(m.month))}</b></td><td class="num"><b>${m.count}</b></td><td class="num">${m.count ? esc(fmtDur(m.minutes)) : '–'}</td><td class="num">${m.count ? esc(fmtDur(Math.round(m.minutes / m.count))) : '–'}</td>${showIncentive ? `<td class="num"><b>${m.count ? esc(money(m.incentive)) : '–'}</b></td>` : ''}</tr>`).join('')}
  </tbody></table></div>`;
}

async function driverMonthly(body, month) {
  const r = await api('/driver/trips' + (month ? '?month=' + month : ''));
  body.innerHTML = `${monthTable(r.months.filter((m, i) => i === 0 || m.count || m.month === r.month), true, r.month, true)}
    <h3>${esc(fmtMonth(r.month))} – ${r.trips.length} completed</h3>
    ${r.trips.length ? doneList(r.trips, { showDate: true }) : '<p class="muted">No completed deliveries this month.</p>'}
    <p class="muted small">Tap a month to see its deliveries.</p>`;
  body.querySelectorAll('[data-month]').forEach((tr) => (tr.onclick = () => driverMonthly(body, tr.dataset.month)));
}

// ---------- admin ----------
const TABS = [
  ['today', 'Today'],
  ['schedule', 'Schedule'],
  ['units', 'Units'],
  ['drivers', 'Drivers'],
  ['deliveries', 'Deliveries'],
  ['leaves', 'Leave'],
  ['report', 'Fairness report'],
  ['settings', 'Settings'],
];

async function loadAdmin() {
  const q = state.from ? `?from=${state.from}&to=${state.to}` : '';
  state.admin = await api('/admin/data' + q);
  if (!state.from) { state.from = state.admin.from; state.to = state.admin.to; }
}

async function renderAdmin() {
  if (!document.querySelector('.tabs')) {
    $app.innerHTML = topbar('Admin: ' + state.me.name) +
      `<nav class="tabs">${TABS.map(([k, l]) => `<button data-tab="${k}">${l}</button>`).join('')}</nav><div class="wrap" id="main"><div class="loading">Loading…</div></div>`;
    bindLogout();
    $app.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { state.tab = b.dataset.tab; renderAdmin(); }));
  }
  $app.querySelectorAll('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === state.tab));
  try {
    await loadAdmin();
  } catch (ex) {
    if (state.me) document.getElementById('main').innerHTML = `<div class="error">${esc(ex.message)}</div>`;
    return;
  }
  const main = document.getElementById('main');
  const views = { deliveries: adminDeliveries, today: adminToday, schedule: adminSchedule, units: adminUnits, drivers: adminDrivers, leaves: adminLeaves, report: adminReport, settings: adminSettings };
  await views[state.tab](main);
}

const A = () => state.admin;
const unitName = (id) => (A().allUnits.find((u) => u.id === id) || {}).name || '(removed unit)';
const driverOf = (id) => A().drivers.find((d) => d.id === id) || A().allDrivers.find((d) => d.id === id);
const onLeaveOn = (driverId, date) => A().leaves.some((l) => l.driverId === driverId && l.from <= date && date <= l.to);

// --- Today ---
function adminToday(main) {
  const t = A().today;
  const day = A().days.find((d) => d.date === t);
  const todays = A().assignments.filter((a) => a.date === t);
  const units = A().units.filter((u) => u.active);
  if (!units.length || !A().drivers.length) {
    main.innerHTML = `<div class="card"><h2>Welcome! Let's set things up</h2>
      <ol><li>Go to <b>Units</b> and add your units (each gets its own login).</li>
      <li>Go to <b>Drivers</b> and add your drivers with their vehicle type (each gets a login).</li>
      <li>The schedule is created automatically and rotates fairly every day.</li>
      <li>Share the website link with your team; units and drivers log in to see today's plan.</li></ol></div>`;
    return;
  }
  const busy = new Set(todays.map((a) => a.driverId).filter(Boolean));
  const free = A().drivers.filter((d) => d.active && !busy.has(d.id));
  const cards = units.map((u) => {
    const rows = todays.filter((a) => a.unitId === u.id);
    const inner = rows.map((a) => {
      const d = a.driverId && driverOf(a.driverId);
      return `<div class="drv">${d ? `<b>${esc(d.name)}</b> ${vbadge(d.vehicleType)}${wantNote(a.unitId, a.slot, d)} ${a.extra ? `<span class="badge warn">emergency extra</span>${a.fromUnitId ? ` <span class="small muted">moved from ${esc(unitName(a.fromUnitId))}</span>` : ''}${a.reason ? ` <span class="small muted">${esc(a.reason)}</span>` : ''}` : a.manual ? '<span class="badge manual">changed</span>' : ''}<div class="small">${telLink(d.phone)} ${d.vehicleNo ? '· ' + esc(d.vehicleNo) : ''}</div>` : `<span class="muted">Driver ${a.slot + 1} (${esc(slotLabel(slotSpec(a.unitId, a.slot)))}) – ${todays.some((x) => x.extra && x.fromUnitId === a.unitId) ? `driver moved to ${esc(todays.filter((x) => x.extra && x.fromUnitId === a.unitId).map((x) => unitName(x.unitId)).join(', '))} for an emergency` : 'no free driver today'}</span>`}
        <div><button class="link small" data-change="${esc(a.unitId)}|${a.slot}">Change</button></div></div>`;
    }).join('');
    return `<div class="card unit-card"><div class="name">${esc(u.name)}</div>${u.contactName ? `<div class="muted small">${esc(u.contactName)} ${telLink(u.phone)}</div>` : ''}${inner}</div>`;
  }).join('');
  main.innerHTML = `<div class="row section"><div><h1>Today · ${esc(fmtDate(t, { weekday: 'long', day: 'numeric', month: 'long' }))}</h1>
      <div class="muted">${day && day.working ? `${todays.filter((a) => a.driverId).length} of ${todays.length} slots filled${todays.some((a) => !a.driverId) ? ` – ${A().drivers.filter((d) => d.active && !onLeaveOn(d.id, t)).length} drivers available. Add a driver or reduce drivers needed in Units to fill every slot.` : ''}` : 'Off day / holiday — no allocation'}</div></div>
      <div class="spacer"></div>
      ${day && day.working ? '<button id="wa">📤 Share on WhatsApp</button>' : ''}</div>
    ${day && day.working ? `<div class="grid">${cards}</div>
    <div class="card" style="margin-top:12px"><h3>Not on duty today</h3>${free.length ? free.map((d) => `${esc(d.name)} ${onLeaveOn(d.id, t) ? '<span class="badge warn">leave</span>' : '<span class="badge">rest</span>'}`).join(' &nbsp; ') : '<span class="muted">Everyone is on duty.</span>'}</div>` : ''}`;
  main.querySelectorAll('[data-change]').forEach((b) => (b.onclick = () => { const [u, s] = b.dataset.change.split('|'); changeSlot(t, u, Number(s)); }));
  const wa = document.getElementById('wa');
  if (wa) wa.onclick = () => {
    const lines = [`*${state.pub.orgName} – Driver plan ${fmtDate(t)}*`];
    for (const u of units) {
      for (const a of todays.filter((x) => x.unitId === u.id)) {
        const d = a.driverId && driverOf(a.driverId);
        if (d) lines.push(`• ${u.name}: ${d.name} (${d.vehicleType}${d.phone ? ', ' + d.phone : ''})`);
      }
    }
    window.open('https://wa.me/?text=' + encodeURIComponent(lines.join('\n')), '_blank');
  };
}

function changeSlot(date, unitId, slot) {
  const current = A().assignments.find((a) => a.date === date && a.unitId === unitId && a.slot === slot);
  const unit = A().units.find((u) => u.id === unitId);
  const types = (unit && unit.vehicleTypes) || [];
  const spec = slotSpec(unitId, slot);
  const opts = A().drivers.filter((d) => d.active).map((d) => {
    const leave = onLeaveOn(d.id, date);
    const wrongVehicle = (types.length && !types.includes(d.vehicleType)) || vehicleFit(spec, d.vehicleType) < 0;
    const where = A().assignments.find((a) => a.date === date && a.driverId === d.id);
    const note = leave ? ' — on leave' : wrongVehicle ? ' — vehicle not allowed' : where && where !== current ? ` — at ${unitName(where.unitId)} (will swap)` : '';
    return `<option value="${esc(d.id)}" ${current && current.driverId === d.id ? 'selected' : ''} ${leave || wrongVehicle ? 'disabled' : ''}>${esc(d.name)} (${esc(d.vehicleType)})${esc(note)}</option>`;
  }).join('');
  openModal(`<h2>Change driver</h2><div class="muted">${esc(unitName(unitId))} · ${slot >= 100 ? 'emergency extra (requested by unit)' : `driver ${slot + 1} (${esc(slotLabel(spec))})`} · ${esc(fmtDate(date))}</div>
    <label>Driver</label><select name="driverId"><option value="">${slot >= 100 ? '— Remove this extra driver —' : '— No driver —'}</option>${opts}</select>
    <p class="muted small">Later days are re-balanced automatically so duty stays equal.</p>
    <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
  async (fd) => {
    await api('/admin/assign', { method: 'POST', body: { date, unitId, slot, driverId: fd.get('driverId') || null } });
    toast('Saved');
    renderAdmin();
  });
}

// --- Schedule ---
function adminSchedule(main) {
  const units = A().units.filter((u) => u.active);
  const t = A().today;
  const head = units.map((u) => `<th>${esc(u.name)}</th>`).join('');
  const body = A().days.map((day) => {
    const cls = [day.date === t ? 'today' : '', day.working ? '' : 'off'].join(' ');
    if (!day.working) return `<tr class="${cls}"><td class="sticky">${esc(fmtDate(day.date))}</td><td colspan="${units.length}">${day.holiday ? 'Holiday' : 'Off day'}</td></tr>`;
    const cells = units.map((u) => {
      const rows = A().assignments.filter((a) => a.date === day.date && a.unitId === u.id);
      const past = day.date < t;
      if (!rows.length) return `<td class="cell past"><span class="muted small">${past ? '—' : 'not planned'}</span></td>`;
      return `<td class="cell ${past ? 'past' : ''}">${rows.map((a) => {
        const d = a.driverId && driverOf(a.driverId);
        return `<div ${past ? '' : `data-slot="${esc(day.date)}|${esc(u.id)}|${a.slot}"`}>${d ? `<span class="dname">${esc(d.name)}</span> ${vbadge(d.vehicleType)}${wantNote(u.id, a.slot, d)}${a.extra ? ' <span class="badge warn">extra</span>' : a.manual ? ' <span class="badge manual">✎</span>' : ''}` : '<span class="muted small">— (no free driver)</span>'}</div>`;
      }).join('')}</td>`;
    }).join('');
    return `<tr class="${cls}"><td class="sticky">${esc(fmtDate(day.date))}</td>${cells}</tr>`;
  }).join('');
  main.innerHTML = `<div class="row section no-print">
      <button id="prev">◀ Prev week</button><button id="this">This week</button><button id="next">Next week ▶</button>
      <input type="date" id="from" value="${esc(A().from)}" style="width:auto"> to <input type="date" id="to" value="${esc(A().to)}" style="width:auto">
      <button id="go">Show</button><div class="spacer"></div>
      <button id="print">🖨️ Print</button><button id="regen" class="primary">↻ Re-balance</button></div>
    <p class="muted small no-print">Tap a name to change it. ✎ = changed by admin. Days are planned automatically ${A().settings.horizonDays} days ahead.</p>
    <h2 style="display:none" class="print-title">${esc(state.pub.orgName)} – ${esc(fmtDate(A().from))} to ${esc(fmtDate(A().to))}</h2>
    <div class="table-wrap"><table class="sched"><thead><tr><th class="sticky">Date</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  const go = (from, to) => { state.from = from; state.to = to; renderAdmin(); };
  document.getElementById('prev').onclick = () => go(addDays(state.from, -7), addDays(state.to, -7));
  document.getElementById('next').onclick = () => go(addDays(state.from, 7), addDays(state.to, 7));
  document.getElementById('this').onclick = () => go(t, addDays(t, 6));
  document.getElementById('go').onclick = () => go(document.getElementById('from').value, document.getElementById('to').value);
  document.getElementById('print').onclick = () => window.print();
  document.getElementById('regen').onclick = () => openModal(`<h2>Re-balance schedule</h2>
      <p>Re-create the plan from the chosen day onward using the fairness rules. Past days never change.</p>
      <label>Starting from</label><input type="date" name="from" value="${esc(addDays(t, 1))}" min="${esc(t)}">
      <label class="check"><input type="checkbox" name="keepManual" checked> Keep my manual changes</label>
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Re-balance</button></div>`,
    async (fd) => {
      await api('/admin/regenerate', { method: 'POST', body: { from: fd.get('from'), keepManual: fd.get('keepManual') === 'on' } });
      toast('Schedule re-balanced');
      renderAdmin();
    });
  main.querySelectorAll('[data-slot]').forEach((el) => (el.onclick = () => { const [d, u, s] = el.dataset.slot.split('|'); changeSlot(d, u, Number(s)); }));
}

// --- Units ---
function adminUnits(main) {
  const rows = A().units.map((u) => `<tr>
    <td><b>${esc(u.name)}</b>${u.address ? `<div class="muted small">${esc(u.address)}</div>` : ''}</td>
    <td>${esc(u.contactName)}<div class="small">${telLink(u.phone)}</div></td>
    <td>${u.slots.map((sp, i) => `<div class="small">${i + 1}. ${slotHtml(sp)}</div>`).join('')}</td>
    <td>${u.vehicleTypes.length ? u.vehicleTypes.map(vbadge).join(' ') : '<span class="muted small">Any</span>'}</td>
    <td><code>${esc(u.username)}</code></td>
    <td>${u.active ? '<span class="badge ok">Active</span>' : '<span class="badge">Inactive</span>'}</td>
    <td><button class="link" data-edit="${esc(u.id)}">Edit</button></td></tr>`).join('');
  main.innerHTML = `<div class="row section"><h1>Units</h1><div class="spacer"></div><button class="primary" id="add">+ Add unit</button></div>
    ${A().units.length ? `<div class="table-wrap"><table><thead><tr><th>Unit</th><th>Contact</th><th>Drivers needed (in priority order)</th><th>Allowed vehicles</th><th>Login ID</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="card muted">No units yet. Add your first unit.</div>'}`;
  document.getElementById('add').onclick = () => unitForm();
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => unitForm(A().units.find((u) => u.id === b.dataset.edit))));
}

function unitForm(u) {
  const v = u || { name: '', contactName: '', phone: '', address: '', slots: [{ type: '2W', second: 'ANY' }, { type: '4W', second: 'ANY' }], vehicleTypes: [], username: '', active: true };
  openModal(`<h2>${u ? 'Edit unit' : 'Add unit'}</h2>
    <div class="form-grid">
      <div><label>Unit name *</label><input name="name" required value="${esc(v.name)}"></div>
      <div><label>Contact person</label><input name="contactName" value="${esc(v.contactName)}"></div>
      <div><label>Phone</label><input name="phone" type="tel" value="${esc(v.phone)}"></div>
    </div>
    <label>Address</label><textarea name="address">${esc(v.address)}</textarea>
    <label>Drivers needed every day</label>
    <div class="muted small">Put the must-have drivers first (e.g. Driver 1 = 2W, Driver 2 = 4W). They always get their vehicle first. The 2nd choice is used when no 1st-choice driver is free. If there are not enough drivers, the last driver in this list is left out first.</div>
    <div id="slots"></div>
    <button type="button" id="add-slot" class="link">+ Add another driver</button>
    <label>Vehicle types this unit accepts (for all its drivers)</label>
    <div>${state.pub.vehicleTypes.map((t) => `<label class="check"><input type="checkbox" name="vt" value="${t}" ${v.vehicleTypes.includes(t) ? 'checked' : ''}> ${t} ${VEHICLE_NAMES[t]}</label>`).join('')}</div>
    <div class="muted small">Leave all unticked to accept any vehicle.</div>
    <div class="form-grid">
      <div><label>Login ID *</label><input name="username" autocapitalize="none" value="${esc(v.username)}" placeholder="e.g. unit1"></div>
      <div><label>Password ${u ? '(leave blank to keep)' : '*'}</label><input name="password" type="text" autocomplete="new-password" ${u ? '' : 'required'}></div>
    </div>
    <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (gets a driver every working day)</label>
    <div class="actions">${u ? '<button type="button" class="danger" id="del">Remove</button><div class="spacer"></div>' : ''}<button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
  async (fd) => {
    const body = {
      name: fd.get('name'), driversNeeded: fd.get('driversNeeded'), contactName: fd.get('contactName'), phone: fd.get('phone'),
      address: fd.get('address'), vehicleTypes: fd.getAll('vt'), slots: readSlots(), username: fd.get('username'), password: fd.get('password'), active: fd.get('active') === 'on',
    };
    await api(u ? `/admin/units/${u.id}` : '/admin/units', { method: u ? 'PUT' : 'POST', body });
    toast(u ? 'Unit updated' : 'Unit added – schedule updated');
    renderAdmin();
  });
  const slotsEl = document.getElementById('slots');
  const opt = (value, label, cur) => `<option value="${value}" ${cur === value ? 'selected' : ''}>${label}</option>`;
  const slotRow = (sp) => `<div class="slot-row card" style="margin:8px 0;padding:10px">
      <div class="row"><b class="slot-no"></b><div class="spacer"></div><button type="button" class="link danger slot-del">Remove</button></div>
      <div class="form-grid">
        <div><label>1st choice</label><select class="slot-type">
          ${opt('ANY', 'Any vehicle', sp.type)}
          ${state.pub.vehicleTypes.map((t) => opt(t, `${t} – ${VEHICLE_NAMES[t]}`, sp.type)).join('')}
        </select></div>
        <div class="second-wrap"><label>2nd choice (if 1st is busy / short)</label><select class="slot-second">
          ${state.pub.vehicleTypes.map((t) => opt(t, `${t} – ${VEHICLE_NAMES[t]}`, sp.second)).join('')}
          ${opt('ANY', 'Any other vehicle', sp.second || 'ANY')}
          ${opt('NONE', 'No other – 1st choice only', sp.second)}
        </select></div>
      </div></div>`;
  const renumber = () => slotsEl.querySelectorAll('.slot-row').forEach((r, i, all) => {
    r.querySelector('.slot-no').textContent = 'Driver ' + (i + 1);
    r.querySelector('.slot-del').hidden = all.length === 1;
  });
  const bindRow = (r) => {
    r.querySelector('.slot-del').onclick = () => { r.remove(); renumber(); };
    const type = r.querySelector('.slot-type');
    const sync = () => {
      r.querySelector('.second-wrap').hidden = type.value === 'ANY';
      r.querySelectorAll('.slot-second option').forEach((o) => (o.hidden = o.value === type.value));
      const sec = r.querySelector('.slot-second');
      if (sec.value === type.value) sec.value = 'ANY';
    };
    type.onchange = sync;
    sync();
  };
  slotsEl.innerHTML = (v.slots && v.slots.length ? v.slots : [{ type: 'ANY', second: 'ANY' }]).map(slotRow).join('');
  slotsEl.querySelectorAll('.slot-row').forEach(bindRow);
  renumber();
  document.getElementById('add-slot').onclick = () => {
    if (slotsEl.children.length >= 10) return;
    slotsEl.insertAdjacentHTML('beforeend', slotRow({ type: 'ANY', second: 'ANY' }));
    bindRow(slotsEl.lastElementChild);
    renumber();
  };
  function readSlots() {
    return [...slotsEl.querySelectorAll('.slot-row')].map((r) => ({
      type: r.querySelector('.slot-type').value,
      second: r.querySelector('.slot-second').value,
    }));
  }
  const del = document.getElementById('del');
  if (del) del.onclick = async () => {
    if (!confirm(`Remove ${u.name}? Past history is kept.`)) return;
    try { await api(`/admin/units/${u.id}`, { method: 'DELETE' }); modal.close(); toast('Unit removed'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  };
}

// --- Drivers ---
function adminDrivers(main) {
  const rows = A().drivers.map((d) => `<tr>
    <td><b>${esc(d.name)}</b></td><td>${telLink(d.phone)}</td>
    <td>${vbadge(d.vehicleType)} <span class="small">${esc(d.vehicleNo)}</span></td>
    <td><code>${esc(d.username)}</code></td>
    <td>${!d.active ? '<span class="badge">Inactive</span>' : onLeaveOn(d.id, A().today) ? '<span class="badge warn">On leave</span>' : '<span class="badge ok">Active</span>'}</td>
    <td><button class="link" data-edit="${esc(d.id)}">Edit</button></td></tr>`).join('');
  main.innerHTML = `<div class="row section"><h1>Drivers</h1><div class="spacer"></div><button class="primary" id="add">+ Add driver</button></div>
    ${A().drivers.length ? `<div class="table-wrap"><table><thead><tr><th>Name</th><th>Phone</th><th>Vehicle</th><th>Login ID</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<div class="card muted">No drivers yet. Add your first driver.</div>'}
    <p class="muted small">A new driver starts level with the others, so they are not given extra days to "catch up".</p>`;
  document.getElementById('add').onclick = () => driverForm();
  main.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => driverForm(A().drivers.find((d) => d.id === b.dataset.edit))));
}

function driverForm(d) {
  const v = d || { name: '', phone: '', vehicleType: '4W', vehicleNo: '', username: '', active: true };
  openModal(`<h2>${d ? 'Edit driver' : 'Add driver'}</h2>
    <div class="form-grid">
      <div><label>Name *</label><input name="name" required value="${esc(v.name)}"></div>
      <div><label>Phone</label><input name="phone" type="tel" value="${esc(v.phone)}"></div>
      <div><label>Vehicle type *</label><select name="vehicleType">${state.pub.vehicleTypes.map((t) => `<option value="${t}" ${v.vehicleType === t ? 'selected' : ''}>${t} – ${VEHICLE_NAMES[t]}</option>`).join('')}</select></div>
      <div><label>Vehicle number</label><input name="vehicleNo" value="${esc(v.vehicleNo)}" placeholder="MH 01 AB 1234"></div>
      <div><label>Login ID</label><input name="username" autocapitalize="none" value="${esc(v.username)}" placeholder="defaults to phone number"></div>
      <div><label>Password / PIN ${d ? '(leave blank to keep)' : '*'}</label><input name="password" type="text" autocomplete="new-password" ${d ? '' : 'required'}></div>
    </div>
    <label class="check"><input type="checkbox" name="active" ${v.active ? 'checked' : ''}> Active (included in the rotation)</label>
    <div class="actions">${d ? '<button type="button" class="danger" id="del">Remove</button><div class="spacer"></div>' : ''}<button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
  async (fd) => {
    const body = {
      name: fd.get('name'), phone: fd.get('phone'), vehicleType: fd.get('vehicleType'), vehicleNo: fd.get('vehicleNo'),
      username: fd.get('username'), password: fd.get('password'), active: fd.get('active') === 'on',
    };
    await api(d ? `/admin/drivers/${d.id}` : '/admin/drivers', { method: d ? 'PUT' : 'POST', body });
    toast(d ? 'Driver updated' : 'Driver added – schedule updated');
    renderAdmin();
  });
  const del = document.getElementById('del');
  if (del) del.onclick = async () => {
    if (!confirm(`Remove ${d.name}? Past history is kept.`)) return;
    try { await api(`/admin/drivers/${d.id}`, { method: 'DELETE' }); modal.close(); toast('Driver removed'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  };
}

// --- Leave ---
function adminLeaves(main) {
  const t = A().today;
  const opts = A().drivers.map((d) => `<option value="${esc(d.id)}">${esc(d.name)} (${esc(d.vehicleType)})</option>`).join('');
  const rows = A().leaves.map((l) => {
    const d = driverOf(l.driverId);
    const status = l.to < t ? '<span class="badge">Past</span>' : l.from <= t ? '<span class="badge warn">Now</span>' : '<span class="badge ok">Upcoming</span>';
    return `<tr><td><b>${esc(d ? d.name : '(removed)')}</b></td><td>${esc(fmtDate(l.from))}${l.to !== l.from ? ' → ' + esc(fmtDate(l.to)) : ''}</td><td>${esc(l.reason)}</td><td>${status}</td>
      <td>${l.to >= t ? `<button class="link" data-del="${esc(l.id)}">Cancel leave</button>` : ''}</td></tr>`;
  }).join('');
  main.innerHTML = `<h1>Leave / absence</h1>
    <form class="card section" id="leave-form"><div class="form-grid">
      <div><label>Driver</label><select name="driverId" required>${opts}</select></div>
      <div><label>From</label><input type="date" name="from" value="${esc(t)}" required></div>
      <div><label>To</label><input type="date" name="to" value="${esc(t)}" required></div>
      <div><label>Reason</label><input name="reason" placeholder="optional"></div></div>
      <div style="margin-top:12px"><button class="primary">Add leave</button></div>
      <p class="muted small">If the driver was on duty today, only their slot is filled by a free driver; future days are re-balanced.</p></form>
    ${A().leaves.length ? `<div class="table-wrap"><table><thead><tr><th>Driver</th><th>Dates</th><th>Reason</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}`;
  const form = document.getElementById('leave-form');
  form.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    try {
      await api('/admin/leaves', { method: 'POST', body: Object.fromEntries(fd) });
      toast('Leave added – schedule updated');
      renderAdmin();
    } catch (ex) { toast(ex.message, true); }
  };
  main.querySelectorAll('[data-del]').forEach((b) => (b.onclick = async () => {
    try { await api(`/admin/leaves/${b.dataset.del}`, { method: 'DELETE' }); toast('Leave cancelled'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  }));
}

// --- Fairness report ---
async function adminReport(main) {
  const t = A().today;
  const from = state.repFrom || addDays(t, -29);
  const to = state.repTo || t;
  const s = await api(`/admin/stats?from=${from}&to=${to}`);
  const max = Math.max(1, ...s.rows.flatMap((r) => Object.values(r.perUnit)));
  const heat = (n) => `<span class="heat" style="background:rgba(46,117,182,${(0.08 + 0.5 * n / max).toFixed(2)})">${n}</span>`;
  const totals = s.rows.filter((r) => r.active).map((r) => r.total);
  const spread = totals.length ? Math.max(...totals) - Math.min(...totals) : 0;
  main.innerHTML = `<div class="row section"><h1>Fairness report</h1><div class="spacer"></div>
      <input type="date" id="rf" value="${esc(from)}" style="width:auto"> to <input type="date" id="rt" value="${esc(to)}" style="width:auto"><button id="rgo">Show</button></div>
    <div class="card section">Difference between most and least duties (active drivers): <b>${spread}</b> ${spread <= 1 ? '<span class="badge ok">Balanced</span>' : '<span class="badge warn">Check leave / vehicle rules</span>'}
      ${s.unfilled ? `<div class="small" style="margin-top:6px"><span class="badge bad">${s.unfilled} unfilled slots</span> – not enough drivers on some days.</div>` : ''}</div>
    <div class="table-wrap"><table><thead><tr><th>Driver</th><th class="num">Total duties</th><th class="num">Leave days</th>${s.units.map((u) => `<th class="num">${esc(u.name)}</th>`).join('')}</tr></thead>
    <tbody>${s.rows.map((r) => `<tr><td><b>${esc(r.name)}</b> ${vbadge(r.vehicleType)}${r.active ? '' : ' <span class="badge">inactive</span>'}</td><td class="num"><b>${r.total}</b></td><td class="num">${r.leaveDays}</td>${s.units.map((u) => `<td class="num">${heat(r.perUnit[u.id] || 0)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
    <p class="muted small">Counts include planned future days up to the end date. Each column shows how often a driver served that unit — an even spread means good rotation.</p>`;
  document.getElementById('rgo').onclick = () => { state.repFrom = document.getElementById('rf').value; state.repTo = document.getElementById('rt').value; renderAdmin(); };
}

// --- Deliveries ---
async function adminDeliveries(main) {
  const t = A().today;
  const from = state.delFrom || t;
  const to = state.delTo || from;
  const [r, mon] = await Promise.all([api(`/admin/trips?from=${from}&to=${to}`), api('/admin/trips/monthly?months=6')]);
  const drivers = state.delDriver || '';
  const list = r.trips.filter((x) => !drivers || x.driverId === drivers);
  const done = list.filter((x) => x.dropAt);
  const sumRows = r.summary.map((x) => `<tr><td><b>${esc(x.name)}</b> ${vbadge(x.vehicleType)}</td><td class="num"><b>${x.done}</b></td>
    <td class="num">${x.open ? `<span class="badge warn">${x.open}</span>` : '0'}${x.wrong ? ` <span class="badge bad" title="wrong entries">${x.wrong} wrong</span>` : ''}</td><td class="num">${esc(fmtDur(x.minutes))}</td><td class="num">${x.done ? esc(fmtDur(Math.round(x.minutes / x.done))) : '–'}</td><td class="num">${x.internal}</td><td class="num"><b>${esc(money(x.incentive))}</b></td></tr>`).join('');
  main.innerHTML = `<div class="row section"><h1>Deliveries</h1><div class="spacer"></div>
      <input type="date" id="df" value="${esc(from)}" style="width:auto"> to <input type="date" id="dt" value="${esc(to)}" style="width:auto">
      <button id="dgo">Show</button><a class="btn" href="/api/admin/trips.csv?from=${esc(from)}&to=${esc(to)}">⬇️ Excel (CSV)</a></div>
    <div class="grid section">
      <div class="card"><div class="muted small">Delivered</div><div style="font-size:1.8rem;font-weight:800">${r.trips.filter((x) => x.dropAt).length}</div></div>
      <div class="card"><div class="muted small">In transit / not dropped</div><div style="font-size:1.8rem;font-weight:800;color:var(--warn)">${r.trips.filter((x) => !x.dropAt).length}</div></div>
      <div class="card"><div class="muted small">Total incentive</div><div style="font-size:1.8rem;font-weight:800;color:var(--ok)">${esc(money(r.summary.reduce((n, x) => n + x.incentive, 0)))}</div></div>
      <div class="card"><div class="muted small">Total driving time</div><div style="font-size:1.8rem;font-weight:800">${esc(fmtDur(r.trips.reduce((n, x) => n + (x.minutes || 0), 0)) || '0m')}</div></div>
    </div>
    <h2>Per driver</h2>
    ${r.summary.length ? `<div class="table-wrap section"><table><thead><tr><th>Driver</th><th class="num">Delivered</th><th class="num">Not dropped</th><th class="num">Total time</th><th class="num">Avg / delivery</th><th class="num">Internal</th><th class="num">Incentive</th></tr></thead><tbody>${sumRows}</tbody></table></div>` : '<div class="card muted section">No deliveries recorded for these dates.</div>'}
    ${r.trips.length ? `<div class="row"><h2>All deliveries</h2><div class="spacer"></div>
      <select id="ddrv" style="width:auto"><option value="">All drivers</option>${r.summary.map((x) => `<option value="${esc(x.driverId)}" ${drivers === x.driverId ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>
      <div class="card">${list.map((x) => `${x.dropAt ? doneList([x], { showDriver: true, showDate: true }) : tripRow(x, { showDriver: true })}<div class="row" style="justify-content:flex-end"><button class="link small" data-edittrip="${esc(x.id)}">Correct time / comment</button><button class="link danger small" data-deltrip="${esc(x.id)}">Delete</button></div>`).join('')}</div>` : ''}
    <h2 style="margin-top:18px">Month-wise (completed deliveries · time)</h2>
    ${monthGrid(mon.months, mon.drivers, 'Driver')}
    ${monthGrid(mon.months, mon.units, 'Unit')}
    <p class="muted small">Photos are kept for ${esc(A().settings.photoDays || 120)} days (change in Settings); times and names are kept forever. ${done.length ? '' : ''}</p>`;
  document.getElementById('dgo').onclick = () => { state.delFrom = document.getElementById('df').value; state.delTo = document.getElementById('dt').value; renderAdmin(); };
  const dd = document.getElementById('ddrv');
  if (dd) dd.onchange = () => { state.delDriver = dd.value; renderAdmin(); };
  main.querySelectorAll('[data-edittrip]').forEach((b) => (b.onclick = () => {
    const x = r.trips.find((y) => y.id === b.dataset.edittrip);
    openModal(`<h2>Correct delivery</h2><div class="muted">${esc(x.driverName)} · ${esc(x.unitName)}</div>
      <label>Pickup date &amp; time</label><input type="datetime-local" name="pickup" value="${esc(toLocalInput(x.pickupAt))}" required>
      <label>Drop date &amp; time ${x.dropAt ? '' : '(not dropped yet – fill to close it)'}</label><input type="datetime-local" name="drop" value="${x.dropAt ? esc(toLocalInput(x.dropAt)) : ''}">
      <div class="form-grid"><div><label>Pickup from</label>${placePicker('pickupUnitId', A().units, x.unitId || 'OTHER', x.pickupOther, 'Client / vendor name')}</div>
      ${x.dropAt ? `<div><label>Drop to</label>${placePicker('dropUnitId', A().units, x.dropUnitId || (x.dropOther ? 'OTHER' : ''), x.dropOther, 'Client / vendor name')}</div>` : ''}</div>
      <label>Comment</label><input name="note" value="${esc(x.adminNote)}" placeholder="e.g. Wrong entry – actual drop 3:30 pm">
      <p class="muted small">Changing a time marks it "Time corrected by admin" and counts its time again.</p>
      <div class="actions"><button value="cancel">Cancel</button><button class="primary" value="ok">Save</button></div>`,
    async (fd) => {
      await api(`/admin/trips/${x.id}/edit`, { method: 'POST', body: { pickup: fd.get('pickup'), drop: fd.get('drop'), note: fd.get('note'),
        pickupUnitId: fd.get('pickupUnitId'), pickupOther: fd.get('pickupUnitIdOther'), dropUnitId: fd.get('dropUnitId'), dropOther: fd.get('dropUnitIdOther') } });
      toast('Saved');
      renderAdmin();
    });
    bindPlacePickers(modalBody);
  }));
  main.querySelectorAll('[data-deltrip]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this delivery entry and its photos?')) return;
    try { await api(`/admin/trips/${b.dataset.deltrip}`, { method: 'DELETE' }); toast('Deleted'); renderAdmin(); } catch (ex) { toast(ex.message, true); }
  }));
}

function monthGrid(months, rows, label) {
  const cell = (m) => (m.count ? `<b>${m.count}</b><div class="small muted">${esc(fmtDur(m.minutes))}</div>${label === 'Driver' ? `<div class="small" style="color:var(--ok);font-weight:700">${esc(money(m.incentive))}</div>` : ''}` : '<span class="muted">–</span>');
  return `<div class="table-wrap section"><table><thead><tr><th>${label}</th>${months.map((m) => `<th class="num">${esc(new Date(m + '-01T00:00:00Z').toLocaleDateString('en-IN', { month: 'short', year: '2-digit', timeZone: 'UTC' }))}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td><b>${esc(r.name)}</b>${r.vehicleType ? ' ' + vbadge(r.vehicleType) : ''}</td>${r.months.map((m) => `<td class="num">${cell(m)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// --- Settings ---
function adminSettings(main) {
  const s = A().settings;
  main.innerHTML = `<h1>Settings</h1>
    <form class="card section" id="set-form">
      <div class="form-grid">
        <div><label>Company / app name</label><input name="orgName" value="${esc(s.orgName)}"></div>
        <div><label>Plan ahead (days)</label><input name="horizonDays" type="number" min="1" max="60" value="${esc(s.horizonDays)}"></div>
        <div><label>Time zone</label><input name="timezone" value="${esc(s.timezone)}"></div>
        <div><label>Keep delivery photos (days)</label><input name="photoDays" type="number" min="7" max="3650" value="${esc(s.photoDays || 120)}"></div>
      </div>
      <label>Delivery incentive (₹ per minute, by time taken)</label>
      <div class="muted small">A delivery taking up to "minutes" gets that rate for every minute. Longer than the last row: last rate.</div>
      <div id="slabs">${(s.incentive ? s.incentive.slabs : []).map((x, i, all) => `<div class="row slab" style="margin:4px 0">
        <span class="small" style="width:110px">${i === 0 ? '1' : all[i - 1].upTo + 1} – </span>
        <input class="slab-up" type="number" min="1" value="${esc(x.upTo)}" style="width:90px"> <span class="small">min →</span>
        <input class="slab-rate" type="number" step="0.01" min="0" value="${esc(x.rate)}" style="width:90px"> <span class="small">₹/min</span></div>`).join('')}</div>
      <div class="row" style="margin-top:6px"><span class="small">Internal (unit to unit) delivery gets</span>
        <input name="internalPercent" type="number" min="0" max="100" value="${esc(s.incentive ? s.incentive.internalPercent : 50)}" style="width:80px"> <span class="small">% of this</span></div>
      <label>Weekly off days (no deliveries)</label>
      <div>${DAYS.map((d, i) => `<label class="check"><input type="checkbox" name="off" value="${i}" ${s.offDays.includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div>
      <label>Holidays (one date per line, YYYY-MM-DD)</label>
      <textarea name="holidays" placeholder="2026-11-08">${esc(s.holidays.join('\n'))}</textarea>
      <div style="margin-top:12px"><button class="primary">Save settings</button></div>
    </form>
    <form class="card section" id="pw-form"><h2>Admin login</h2>
      <div class="form-grid">
        <div><label>Username</label><input name="username" value="${esc(state.me.name)}" autocapitalize="none"></div>
        <div><label>Current password</label><input name="current" type="password" required autocomplete="current-password"></div>
        <div><label>New password</label><input name="next" type="password" required minlength="6" autocomplete="new-password"></div>
      </div><div style="margin-top:12px"><button class="primary">Change password</button></div></form>
    <div class="card"><h2>Backup</h2><p class="muted">Download all data (units, drivers, history). Keep a copy safe; you can restore it any time.</p>
      <div class="row"><a class="btn" href="/api/admin/backup">⬇️ Download backup</a>
      <label class="btn" style="margin:0;font-weight:500">⬆️ Restore from file<input type="file" id="restore" accept=".json,application/json" hidden></label></div></div>`;
  const sf = document.getElementById('set-form');
  sf.onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(sf);
    try {
      await api('/admin/settings', { method: 'PUT', body: {
        orgName: fd.get('orgName'), horizonDays: fd.get('horizonDays'), timezone: fd.get('timezone'), photoDays: fd.get('photoDays'),
        incentive: { internalPercent: fd.get('internalPercent'), slabs: [...document.querySelectorAll('#slabs .slab')].map((r) => ({ upTo: r.querySelector('.slab-up').value, rate: r.querySelector('.slab-rate').value })) },
        offDays: fd.getAll('off').map(Number), holidays: String(fd.get('holidays')).split(/[\s,]+/).filter(Boolean),
      } });
      state.pub.orgName = fd.get('orgName') || state.pub.orgName;
      toast('Settings saved – schedule updated');
      $app.innerHTML = '';
      renderAdmin();
    } catch (ex) { toast(ex.message, true); }
  };
  const pf = document.getElementById('pw-form');
  pf.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/admin/password', { method: 'POST', body: Object.fromEntries(new FormData(pf)) });
      state.me = await api('/me');
      toast('Password changed');
      pf.reset();
    } catch (ex) { toast(ex.message, true); }
  };
  document.getElementById('restore').onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (!confirm('Replace ALL current data with this backup?')) return;
    try {
      await api('/admin/restore', { method: 'POST', body: JSON.parse(await file.text()) });
      toast('Backup restored');
      renderAdmin();
    } catch (ex) { toast(ex.message, true); }
  };
}

boot();
