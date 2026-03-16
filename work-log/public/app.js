// ========== State ==========
let editingId = null;
let uploadedImages = [];
let currentUser = null;
let userCategories = [];
let logsCache = {};

// ========== Init ==========
document.addEventListener('DOMContentLoaded', () => {
  initAuth();
  initModal();
  initGlobalClicks();
});

// ========== Global Event Delegation ==========
function initGlobalClicks() {
  document.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id = btn.dataset.id;

    if (action === 'edit-log') editLog(logsCache[id]);
    else if (action === 'delete-log') deleteLog(id);
    else if (action === 'delete-cat') deleteCategory(id);
    else if (action === 'open-modal') openModal(btn.dataset.src);
    else if (action === 'remove-image') removeImage(Number(id));
    else if (action === 'ocr-detail') useOCRAsDetail();
    else if (action === 'ocr-topic') useOCRAsTopic();
    else if (action === 'ocr-close') closeOCRResult();
  });
}

// ========== Auth ==========
function initAuth() {
  document.getElementById('show-register').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('login-form-wrap').style.display = 'none';
    document.getElementById('register-form-wrap').style.display = '';
  });
  document.getElementById('show-login').addEventListener('click', e => {
    e.preventDefault();
    document.getElementById('register-form-wrap').style.display = 'none';
    document.getElementById('login-form-wrap').style.display = '';
  });

  document.getElementById('login-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: document.getElementById('login-email').value, password: document.getElementById('login-password').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      currentUser = data;
      showApp();
    } catch (err) { errEl.textContent = err.message; }
  });

  document.getElementById('register-form').addEventListener('submit', async e => {
    e.preventDefault();
    const errEl = document.getElementById('register-error');
    errEl.textContent = '';
    try {
      const res = await fetch('/api/auth/register', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: document.getElementById('reg-name').value, email: document.getElementById('reg-email').value, password: document.getElementById('reg-password').value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      currentUser = data;
      showApp();
    } catch (err) { errEl.textContent = err.message; }
  });

  document.getElementById('btn-logout').addEventListener('click', async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    currentUser = null;
    document.getElementById('app-screen').style.display = 'none';
    document.getElementById('auth-screen').style.display = 'flex';
  });

  checkAuth();
}

async function checkAuth() {
  try {
    const res = await fetch('/api/auth/me');
    const user = await res.json();
    if (user) { currentUser = user; showApp(); }
  } catch {}
}

async function showApp() {
  document.getElementById('auth-screen').style.display = 'none';
  document.getElementById('app-screen').style.display = '';
  document.getElementById('user-name').textContent = '👤 ' + currentUser.name;

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('log-date').value = today;
  document.getElementById('summary-date').value = today;
  document.getElementById('summary-month').value = today.substring(0, 7);

  await loadCategories();
  initTabs();
  initForm();
  initUpload();
  initQuickTags();
  initFilter();
  initSummary();
  initSettings();
  initAttendance();
  loadTodayLogs();

  // Show admin tab if user is admin
  if (currentUser.role === 'admin') {
    document.getElementById('tab-btn-admin').style.display = '';
    initAdmin();
  }
}

// ========== Categories ==========
async function loadCategories() {
  const res = await fetch('/api/categories');
  userCategories = await res.json();
  populateCategoryDropdowns();
}

function populateCategoryDropdowns() {
  const selects = [document.getElementById('log-system'), document.getElementById('filter-system')];
  selects.forEach(sel => {
    const current = sel.value;
    while (sel.options.length > 1) sel.remove(1);
    userCategories.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat.name;
      opt.textContent = cat.icon + ' ' + cat.name;
      sel.appendChild(opt);
    });
    sel.value = current;
  });
}

// ========== Tabs ==========
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
      if (tab.dataset.tab === 'list') loadFilteredLogs();
      if (tab.dataset.tab === 'pending') loadPendingTasks();
      if (tab.dataset.tab === 'settings') renderCategories();
    });
  });
}

// ========== Image Upload ==========
function initUpload() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('file-input');
  const cameraInput = document.getElementById('camera-input');

  // Camera button
  document.getElementById('btn-camera').addEventListener('click', () => cameraInput.click());
  cameraInput.addEventListener('change', () => { handleFiles(cameraInput.files); cameraInput.value = ''; });

  // Gallery button
  document.getElementById('btn-gallery').addEventListener('click', () => input.click());
  input.addEventListener('change', () => { handleFiles(input.files); input.value = ''; });

  // Drag & drop zone
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag-over'); handleFiles(e.dataTransfer.files); });
}

// Compress image before upload (max 1280px, quality 0.7)
function compressImage(file, maxWidth = 1280, quality = 0.7) {
  return new Promise((resolve) => {
    // If file is already small (<500KB), skip compression
    if (file.size < 500 * 1024) return resolve(file);
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      canvas.getContext('2d').drawImage(img, 0, 0, w, h);
      canvas.toBlob(blob => {
        const compressed = new File([blob], file.name, { type: 'image/jpeg' });
        console.log(`📦 ย่อ: ${(file.size/1024).toFixed(0)}KB → ${(compressed.size/1024).toFixed(0)}KB`);
        resolve(compressed);
      }, 'image/jpeg', quality);
    };
    img.src = URL.createObjectURL(file);
  });
}

async function handleFiles(files) {
  let firstFile = null;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    if (!firstFile) firstFile = file;
    const compressed = await compressImage(file);
    const formData = new FormData();
    formData.append('images', compressed);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.files && data.files.length > 0) { uploadedImages.push(...data.files); renderImagePreviews(); }
    } catch (err) { alert('อัปโหลดไม่สำเร็จ: ' + err.message); }
  }
  if (firstFile) runOCR(firstFile);
}

function renderImagePreviews() {
  document.getElementById('image-preview-list').innerHTML = uploadedImages.map((img, i) => `
    <div class="image-preview-item">
      <img src="${img.path}" alt="${img.originalname}" data-action="open-modal" data-src="${img.path}">
      <button class="image-remove-btn" data-action="remove-image" data-id="${i}">&times;</button>
      <span class="image-name">${img.originalname}</span>
    </div>
  `).join('');
}

function removeImage(index) { uploadedImages.splice(index, 1); renderImagePreviews(); }

// ========== Image Preprocessing ==========
function preprocessImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const SCALE = img.width < 1000 ? 3 : (img.width < 2000 ? 2 : 1);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * SCALE;
      canvas.height = img.height * SCALE;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        const gray = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
        data[i] = data[i+1] = data[i+2] = gray;
      }
      const contrast = 50;
      const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
      for (let i = 0; i < data.length; i += 4) {
        data[i]   = Math.min(255, Math.max(0, factor * (data[i] - 128) + 128));
        data[i+1] = Math.min(255, Math.max(0, factor * (data[i+1] - 128) + 128));
        data[i+2] = Math.min(255, Math.max(0, factor * (data[i+2] - 128) + 128));
      }
      const threshold = 140;
      for (let i = 0; i < data.length; i += 4) {
        const val = data[i] < threshold ? 0 : 255;
        data[i] = data[i+1] = data[i+2] = val;
      }
      ctx.putImageData(imageData, 0, 0);
      canvas.toBlob(blob => resolve(blob), 'image/png');
    };
    img.src = URL.createObjectURL(file);
  });
}

// ========== OCR ==========
async function runOCR(file) {
  const statusEl = document.getElementById('ocr-status');
  const statusText = document.getElementById('ocr-status-text');
  statusEl.style.display = 'flex';
  statusText.textContent = '🔧 กำลังปรับปรุงภาพให้คมชัด...';
  try {
    const processedBlob = await preprocessImage(file);
    statusText.textContent = '📖 กำลังอ่านข้อความ... (อาจใช้เวลาสักครู่)';
    const worker = await Tesseract.createWorker('tha+eng', 1, {
      logger: m => { if (m.status === 'recognizing text') statusText.textContent = `📖 กำลังอ่านข้อความ... ${Math.round(m.progress * 100)}%`; }
    });
    const { data: { text } } = await worker.recognize(processedBlob);
    await worker.terminate();
    statusEl.style.display = 'none';
    showOCRResult(text);
  } catch (err) {
    statusText.textContent = 'ไม่สามารถอ่านข้อความได้: ' + err.message;
    setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
  }
}

function showOCRResult(text) {
  const container = document.getElementById('ocr-result');
  if (!text || text.trim().length === 0) {
    container.innerHTML = '<p class="ocr-empty">ไม่พบข้อความในภาพ</p>';
    container.style.display = 'block';
    return;
  }
  const cleanText = text.replace(/\n{3,}/g, '\n\n').trim();
  container.innerHTML = `
    <div class="ocr-result-box">
      <div class="ocr-result-header"><h4>📝 ข้อความที่อ่านได้จากภาพ</h4><span class="ocr-hint-small">แก้ไขข้อความได้ก่อนกดใช้</span></div>
      <textarea id="ocr-text" rows="5">${cleanText}</textarea>
      <div class="ocr-actions">
        <button type="button" class="btn btn-primary btn-sm" data-action="ocr-detail">📋 ใช้เป็นรายละเอียด</button>
        <button type="button" class="btn btn-primary btn-sm" data-action="ocr-topic">📌 ใช้เป็นเรื่อง</button>
        <button type="button" class="btn btn-secondary btn-sm" data-action="ocr-close">ปิด</button>
      </div>
    </div>`;
  container.style.display = 'block';
  const lower = cleanText.toLowerCase();
  if (lower.includes('facebook') || lower.includes('เฟซบุ๊ก') || lower.includes('messenger') || lower.includes('fb')) document.getElementById('log-channel').value = 'เฟซบุ๊ก';
  else if (lower.includes('email') || lower.includes('อีเมล') || lower.includes('@') || lower.includes('subject')) document.getElementById('log-channel').value = 'อีเมล';
  else if (lower.includes('line') || lower.includes('ไลน์')) document.getElementById('log-channel').value = 'LINE';
}

function useOCRAsDetail() { const t = document.getElementById('ocr-text').value.trim(); if (t) document.getElementById('log-detail').value = t; closeOCRResult(); }
function useOCRAsTopic() {
  const t = document.getElementById('ocr-text').value.trim();
  if (t) { const lines = t.split('\n'); document.getElementById('log-topic').value = lines[0].substring(0, 100); if (lines.length > 1) document.getElementById('log-detail').value = lines.slice(1).join('\n'); }
  closeOCRResult();
}
function closeOCRResult() { document.getElementById('ocr-result').style.display = 'none'; }

// ========== Quick Tags ==========
function initQuickTags() {
  document.querySelectorAll('.quick-tag').forEach(tag => {
    tag.addEventListener('click', () => { document.getElementById('log-topic').value = tag.dataset.value; document.getElementById('log-topic').focus(); });
  });
}

// ========== Form ==========
function initForm() {
  document.getElementById('log-form').addEventListener('submit', async e => {
    e.preventDefault();
    const data = {
      date: document.getElementById('log-date').value,
      channel: document.getElementById('log-channel').value,
      system_type: document.getElementById('log-system').value,
      topic: document.getElementById('log-topic').value,
      reporter: document.getElementById('log-reporter').value,
      detail: document.getElementById('log-detail').value,
      status: document.getElementById('log-status').value,
      images: uploadedImages
    };
    try {
      const url = editingId ? `/api/logs/${editingId}` : '/api/logs';
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      if (!res.ok) { const err = await res.json(); throw new Error(err.error); }
      resetForm();
      loadTodayLogs();
    } catch (err) { alert('เกิดข้อผิดพลาด: ' + err.message); }
  });
  document.getElementById('btn-cancel').addEventListener('click', resetForm);
}

function resetForm() {
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('log-form').reset();
  document.getElementById('log-date').value = today;
  document.getElementById('log-status').value = 'รอดำเนินการ';
  document.getElementById('log-system').value = '';
  document.getElementById('btn-submit').textContent = '💾 บันทึก';
  document.getElementById('btn-cancel').style.display = 'none';
  document.getElementById('image-preview-list').innerHTML = '';
  editingId = null;
  uploadedImages = [];
}

function editLog(log) {
  if (!log) return;
  editingId = log.id;
  document.getElementById('log-date').value = log.date;
  document.getElementById('log-channel').value = log.channel;
  document.getElementById('log-system').value = log.system_type || '';
  document.getElementById('log-topic').value = log.topic;
  document.getElementById('log-reporter').value = log.reporter;
  document.getElementById('log-detail').value = log.detail;
  document.getElementById('log-status').value = log.status;
  uploadedImages = log.images || [];
  renderImagePreviews();
  document.getElementById('btn-submit').textContent = '✏️ อัปเดต';
  document.getElementById('btn-cancel').style.display = 'inline-block';
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
  document.querySelector('[data-tab="record"]').classList.add('active');
  document.getElementById('tab-record').classList.add('active');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

async function deleteLog(id) {
  if (!confirm('ต้องการลบรายการนี้ใช่ไหม?')) return;
  await fetch(`/api/logs/${id}`, { method: 'DELETE' });
  loadTodayLogs();
  loadFilteredLogs();
}

// ========== Load Logs ==========
async function loadTodayLogs() {
  const today = new Date().toISOString().split('T')[0];
  const res = await fetch(`/api/logs?date=${today}`);
  const logs = await res.json();
  logs.forEach(l => logsCache[l.id] = l);
  renderLogs(logs, 'today-logs');
}

async function loadFilteredLogs() {
  const params = new URLSearchParams();
  const date = document.getElementById('filter-date').value;
  const month = document.getElementById('filter-month').value;
  const channel = document.getElementById('filter-channel').value;
  const status = document.getElementById('filter-status').value;
  const systemType = document.getElementById('filter-system').value;
  if (date) params.set('date', date); else if (month) params.set('month', month);
  if (channel) params.set('channel', channel);
  if (status) params.set('status', status);
  if (systemType) params.set('system_type', systemType);
  const res = await fetch('/api/logs?' + params.toString());
  const logs = await res.json();
  logs.forEach(l => logsCache[l.id] = l);
  renderLogs(logs, 'log-list');
}

function getStatusClass(s) { return s === 'รอดำเนินการ' ? 'waiting' : s === 'กำลังดำเนินการ' ? 'progress' : s === 'เสร็จแล้ว' ? 'done' : ''; }
function getStatusBadge(s) { const icons = { 'รอดำเนินการ': '🟡', 'กำลังดำเนินการ': '🔵', 'เสร็จแล้ว': '🟢' }; return `<span class="badge badge-${getStatusClass(s)}">${icons[s]||''} ${s}</span>`; }
function getChannelIcon(c) { return { 'โทรศัพท์': '📞', 'อีเมล': '📧', 'เฟซบุ๊ก': '💬', 'LINE': '💚', 'Walk-in': '🚶', 'อื่นๆ': '📌' }[c] || '📌'; }

function renderLogs(logs, containerId) {
  const container = document.getElementById(containerId);
  if (!logs.length) { container.innerHTML = '<div class="empty-state">ไม่มีรายการ</div>'; return; }
  container.innerHTML = logs.map(log => {
    const images = log.images || [];
    const imagesHtml = images.length ? `<div class="log-card-images">${images.map(img => `<img src="${img.path}" alt="" class="log-thumb" data-action="open-modal" data-src="${img.path}">`).join('')}</div>` : '';
    return `
      <div class="log-card status-${getStatusClass(log.status)}">
        <div class="log-card-header"><span class="log-card-title">${log.topic}</span>${getStatusBadge(log.status)}</div>
        <div class="log-card-meta">
          <span>${getChannelIcon(log.channel)} ${log.channel}</span>
          ${log.system_type ? `<span class="badge badge-system">🖥️ ${log.system_type}</span>` : ''}
          <span>📅 ${log.date}</span>
          ${log.reporter ? `<span>👤 ${log.reporter}</span>` : ''}
        </div>
        ${log.detail ? `<div class="log-card-detail">${log.detail}</div>` : ''}
        ${imagesHtml}
        <div class="log-card-actions">
          <button class="btn btn-sm btn-primary" data-action="edit-log" data-id="${log.id}">✏️ แก้ไข</button>
          <button class="btn btn-sm btn-danger" data-action="delete-log" data-id="${log.id}">🗑️ ลบ</button>
        </div>
      </div>`;
  }).join('');
}

// ========== Pending Tasks ==========
async function loadPendingTasks() {
  const res = await fetch('/api/pending');
  let tasks = await res.json();
  tasks.forEach(t => logsCache[t.id] = t);

  // Sort
  const sortEl = document.getElementById('pending-sort');
  const filterEl = document.getElementById('pending-filter-status');

  const sort = sortEl.value;
  const filterStatus = filterEl.value;

  if (filterStatus !== 'all') tasks = tasks.filter(t => t.status === filterStatus);
  if (sort === 'newest') tasks.reverse();

  // Stats
  const waiting = tasks.filter(t => t.status === 'รอดำเนินการ').length;
  const inProgress = tasks.filter(t => t.status === 'กำลังดำเนินการ').length;
  const urgent = tasks.filter(t => t.days_pending >= 7).length;

  document.getElementById('pending-stats').innerHTML = `
    <div class="stat-chips">
      <span class="stat-chip chip-total">ทั้งหมด ${tasks.length}</span>
      <span class="stat-chip chip-waiting">🟡 รอ ${waiting}</span>
      <span class="stat-chip chip-progress">🔵 กำลังทำ ${inProgress}</span>
      ${urgent > 0 ? `<span class="stat-chip chip-urgent">🔴 เกิน 7 วัน ${urgent}</span>` : ''}
    </div>`;

  // Render
  const container = document.getElementById('pending-list');
  if (!tasks.length) { container.innerHTML = '<div class="empty-state">🎉 ไม่มีงานค้าง!</div>'; return; }

  container.innerHTML = tasks.map(task => {
    const days = task.days_pending || 0;
    const urgentClass = days >= 7 ? 'urgent' : days >= 3 ? 'warning' : '';
    const daysLabel = days === 0 ? 'วันนี้' : `${days} วันแล้ว`;
    const images = task.images || [];
    const imagesHtml = images.length ? `<div class="log-card-images">${images.map(img => `<img src="${img.path}" alt="" class="log-thumb" data-action="open-modal" data-src="${img.path}">`).join('')}</div>` : '';
    return `
      <div class="log-card pending-card ${urgentClass}">
        <div class="log-card-header">
          <span class="log-card-title">${task.topic}</span>
          <span class="days-badge ${urgentClass}">⏱️ ${daysLabel}</span>
        </div>
        <div class="log-card-meta">
          ${getStatusBadge(task.status)}
          <span>${getChannelIcon(task.channel)} ${task.channel}</span>
          ${task.system_type ? `<span class="badge badge-system">🖥️ ${task.system_type}</span>` : ''}
          <span>📅 ${task.date}</span>
          ${task.reporter ? `<span>👤 ${task.reporter}</span>` : ''}
        </div>
        ${task.detail ? `<div class="log-card-detail">${task.detail}</div>` : ''}
        ${imagesHtml}
        <div class="log-card-actions">
          <button class="btn btn-sm btn-primary" data-action="edit-log" data-id="${task.id}">✏️ แก้ไข</button>
          <button class="btn btn-sm btn-danger" data-action="delete-log" data-id="${task.id}">🗑️ ลบ</button>
        </div>
      </div>`;
  }).join('');

  // Attach sort/filter events
  sortEl.onchange = loadPendingTasks;
  filterEl.onchange = loadPendingTasks;
}

// ========== Filter ==========
function initFilter() {
  document.getElementById('btn-filter').addEventListener('click', loadFilteredLogs);
  document.getElementById('btn-clear-filter').addEventListener('click', () => {
    ['filter-date','filter-month','filter-channel','filter-status','filter-system'].forEach(id => document.getElementById(id).value = '');
    loadFilteredLogs();
  });
}

// ========== Summary ==========
function initSummary() {
  const dailyBtn = document.getElementById('btn-summary-daily'), monthlyBtn = document.getElementById('btn-summary-monthly');
  dailyBtn.addEventListener('click', () => { dailyBtn.classList.add('active'); monthlyBtn.classList.remove('active'); document.getElementById('summary-date-group').style.display=''; document.getElementById('summary-month-group').style.display='none'; });
  monthlyBtn.addEventListener('click', () => { monthlyBtn.classList.add('active'); dailyBtn.classList.remove('active'); document.getElementById('summary-date-group').style.display='none'; document.getElementById('summary-month-group').style.display=''; });
  document.getElementById('btn-load-summary').addEventListener('click', loadSummary);
}

async function loadSummary() {
  const isDaily = document.getElementById('btn-summary-daily').classList.contains('active');
  const params = new URLSearchParams();
  if (isDaily) { params.set('type', 'daily'); params.set('date', document.getElementById('summary-date').value); }
  else { params.set('type', 'monthly'); params.set('month', document.getElementById('summary-month').value); }
  const res = await fetch('/api/summary?' + params.toString());
  renderSummary(await res.json(), isDaily);
}

function renderSummary(data, isDaily) {
  const container = document.getElementById('summary-content');
  if (!data.total) { container.innerHTML = '<div class="empty-state">ไม่มีข้อมูล</div>'; return; }
  const maxCount = Math.max(...data.byChannel.map(c => c.count), ...data.byStatus.map(s => s.count), 1);
  let html = `<div class="summary-card"><h3>📊 ภาพรวม</h3><div class="stat-grid"><div class="stat-box"><div class="stat-number">${data.total}</div><div class="stat-label">งานทั้งหมด</div></div>${data.byStatus.map(s=>`<div class="stat-box"><div class="stat-number">${s.count}</div><div class="stat-label">${s.status}</div></div>`).join('')}</div></div>`;
  html += `<div class="summary-card"><h3>📡 แยกตามช่องทาง</h3>${data.byChannel.map(c=>`<div class="chart-bar"><span class="chart-bar-label">${getChannelIcon(c.channel)} ${c.channel}</span><div class="chart-bar-fill channel" style="width:${Math.max(c.count/maxCount*100,10)}%">${c.count}</div></div>`).join('')}</div>`;
  html += `<div class="summary-card"><h3>📋 แยกตามสถานะ</h3>${data.byStatus.map(s=>`<div class="chart-bar"><span class="chart-bar-label">${s.status}</span><div class="chart-bar-fill status-${getStatusClass(s.status)}" style="width:${Math.max(s.count/maxCount*100,10)}%">${s.count}</div></div>`).join('')}</div>`;
  if (data.bySystem && data.bySystem.length) {
    const maxSys = Math.max(...data.bySystem.map(s=>s.count), 1);
    html += `<div class="summary-card"><h3>🖥️ แยกตามระบบ</h3>${data.bySystem.map(s=>`<div class="chart-bar"><span class="chart-bar-label">${s.system_type}</span><div class="chart-bar-fill system" style="width:${Math.max(s.count/maxSys*100,10)}%">${s.count}</div></div>`).join('')}</div>`;
  }
  if (!isDaily && data.byDay) {
    const maxDay = Math.max(...data.byDay.map(d=>d.count), 1);
    html += `<div class="summary-card"><h3>📅 แยกรายวัน</h3>${data.byDay.map(d=>`<div class="chart-bar"><span class="chart-bar-label">${d.date}</span><div class="chart-bar-fill" style="width:${Math.max(d.count/maxDay*100,10)}%">${d.count}</div></div>`).join('')}</div>`;
  }
  container.innerHTML = html;
}

// ========== Settings (Categories) ==========
function initSettings() {
  document.getElementById('btn-add-cat').addEventListener('click', async () => {
    const name = document.getElementById('new-cat-name').value.trim();
    const icon = document.getElementById('new-cat-icon').value.trim() || '📌';
    if (!name) return alert('กรุณาใส่ชื่อประเภท');
    await fetch('/api/categories', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, icon }) });
    document.getElementById('new-cat-name').value = '';
    document.getElementById('new-cat-icon').value = '';
    await loadCategories();
    renderCategories();
  });
}

function renderCategories() {
  document.getElementById('category-list').innerHTML = userCategories.map(cat => `
    <div class="category-item">
      <span class="cat-icon">${cat.icon}</span>
      <span class="cat-name">${cat.name}</span>
      <button class="btn btn-sm btn-danger" data-action="delete-cat" data-id="${cat.id}">🗑️ ลบ</button>
    </div>
  `).join('');
}

async function deleteCategory(id) {
  if (!confirm('ต้องการลบประเภทนี้ใช่ไหม?')) return;
  await fetch(`/api/categories/${id}`, { method: 'DELETE' });
  await loadCategories();
  renderCategories();
}

// ========== Image Modal ==========
function initModal() {
  const modal = document.getElementById('image-modal');
  modal.querySelector('.modal-overlay').addEventListener('click', closeModal);
  modal.querySelector('.modal-close').addEventListener('click', closeModal);
}
function openModal(src) { document.getElementById('modal-image').src = src; document.getElementById('image-modal').style.display = 'flex'; }
function closeModal() { document.getElementById('image-modal').style.display = 'none'; }

// ========== Attendance ==========
let attendanceClock;

function initAttendance() {
  // Live clock
  updateClock();
  attendanceClock = setInterval(updateClock, 1000);

  document.getElementById('btn-clock-in').addEventListener('click', () => clockAction('in'));
  document.getElementById('btn-clock-out').addEventListener('click', () => clockAction('out'));
  document.getElementById('btn-load-attendance').addEventListener('click', loadAttendanceHistory);

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('attendance-month').value = today.substring(0, 7);

  loadTodayAttendance();
}

function updateClock() {
  const now = new Date();
  const time = now.toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok', hour12: false });
  const dateStr = now.toLocaleDateString('th-TH', { timeZone: 'Asia/Bangkok', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const el = document.getElementById('attendance-clock');
  if (el) el.innerHTML = `<div class="clock-time">${time}</div><div class="clock-date">${dateStr}</div>`;
}

async function loadTodayAttendance() {
  const res = await fetch('/api/attendance/today');
  const data = await res.json();
  const statusEl = document.getElementById('attendance-status');
  const todayEl = document.getElementById('attendance-today');
  const btnIn = document.getElementById('btn-clock-in');
  const btnOut = document.getElementById('btn-clock-out');

  if (!data) {
    statusEl.innerHTML = '<div class="att-badge att-none">📝 ยังไม่ได้ลงเวลาเข้า</div>';
    btnIn.disabled = false;
    btnOut.disabled = true;
    todayEl.innerHTML = '';
    return;
  }

  const statusIcon = data.status === 'ตรงเวลา' ? '🟢' : '🟡';
  const statusClass = data.status === 'ตรงเวลา' ? 'att-ontime' : 'att-late';

  let html = `<div class="att-record">
    <div class="att-row"><span class="att-label">เข้างาน:</span> <strong>${data.clock_in_time}</strong> <span class="att-badge ${statusClass}">${statusIcon} ${data.status}</span></div>`;

  if (data.clock_in_photo) html += `<img src="${data.clock_in_photo}" class="att-photo" data-action="open-modal" data-src="${data.clock_in_photo}">`;
  if (data.clock_in_location) html += `<div class="att-location">📍 ${data.clock_in_location}</div>`;

  if (data.clock_out_time) {
    html += `<div class="att-row"><span class="att-label">ออกงาน:</span> <strong>${data.clock_out_time}</strong></div>`;
    if (data.clock_out_photo) html += `<img src="${data.clock_out_photo}" class="att-photo" data-action="open-modal" data-src="${data.clock_out_photo}">`;
    if (data.clock_out_location) html += `<div class="att-location">📍 ${data.clock_out_location}</div>`;
  }
  html += '</div>';

  statusEl.innerHTML = data.clock_out_time
    ? '<div class="att-badge att-done">✅ ลงเวลาครบแล้ววันนี้</div>'
    : `<div class="att-badge ${statusClass}">${statusIcon} ลงเวลาเข้าแล้ว (${data.status})</div>`;

  btnIn.disabled = true;
  btnOut.disabled = !!data.clock_out_time;
  todayEl.innerHTML = html;
}

async function clockAction(type) {
  try {
    // Get GPS
    let lat = null, lng = null, location = '';
    try {
      const pos = await new Promise((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 10000 });
      });
      lat = pos.coords.latitude;
      lng = pos.coords.longitude;
      location = `${lat.toFixed(6)}, ${lng.toFixed(6)}`;
    } catch { location = 'ไม่สามารถระบุตำแหน่งได้'; }

    // Take photo
    const photoFile = await captureAttendancePhoto();

    const formData = new FormData();
    if (photoFile) formData.append('photo', photoFile);
    formData.append('lat', lat || '');
    formData.append('lng', lng || '');
    formData.append('location', location);

    const url = type === 'in' ? '/api/attendance/clock-in' : '/api/attendance/clock-out';
    const res = await fetch(url, { method: 'POST', body: formData });
    const data = await res.json();

    if (!res.ok) { alert(data.error); return; }
    loadTodayAttendance();
  } catch (err) {
    alert('เกิดข้อผิดพลาด: ' + err.message);
  }
}

function captureAttendancePhoto() {
  return new Promise((resolve) => {
    const input = document.getElementById('attendance-photo');
    input.onchange = () => {
      const file = input.files[0];
      input.value = '';
      if (file) {
        compressImage(file, 800, 0.6).then(resolve);
      } else {
        resolve(null);
      }
    };
    input.click();
    // If user cancels, resolve with null after timeout
    setTimeout(() => { if (!input.files.length) resolve(null); }, 60000);
  });
}

async function loadAttendanceHistory() {
  const month = document.getElementById('attendance-month').value;
  if (!month) return;
  const res = await fetch('/api/attendance/history?month=' + month);
  const records = await res.json();
  const container = document.getElementById('attendance-list');

  if (!records.length) { container.innerHTML = '<div class="empty-state">ไม่มีข้อมูล</div>'; return; }

  // Stats
  const onTime = records.filter(r => r.status === 'ตรงเวลา').length;
  const late = records.filter(r => r.status === 'สาย').length;

  let html = `<div class="att-stats">
    <span class="stat-chip chip-total">ทั้งหมด ${records.length} วัน</span>
    <span class="stat-chip chip-ontime">🟢 ตรงเวลา ${onTime}</span>
    <span class="stat-chip chip-late">🟡 สาย ${late}</span>
  </div>`;

  html += records.map(r => {
    const statusClass = r.status === 'ตรงเวลา' ? 'att-ontime' : 'att-late';
    const statusIcon = r.status === 'ตรงเวลา' ? '🟢' : '🟡';
    return `<div class="att-history-item ${statusClass}">
      <div class="att-history-date">📅 ${r.date}</div>
      <div class="att-history-times">
        <span>เข้า: <strong>${r.clock_in_time || '-'}</strong></span>
        <span>ออก: <strong>${r.clock_out_time || '-'}</strong></span>
        <span class="att-badge ${statusClass}">${statusIcon} ${r.status}</span>
      </div>
    </div>`;
  }).join('');

  container.innerHTML = html;
}

// ========== Admin ==========
function initAdmin() {
  document.getElementById('btn-admin-att').addEventListener('click', loadAdminAttSummary);
  document.getElementById('btn-admin-att-detail').addEventListener('click', loadAdminAttDetail);

  const today = new Date().toISOString().split('T')[0];
  document.getElementById('admin-att-month').value = today.substring(0, 7);
  document.getElementById('admin-att-date').value = today;

  loadAdminUsers();
}

async function loadAdminUsers() {
  const res = await fetch('/api/admin/users');
  const users = await res.json();
  document.getElementById('admin-users-list').innerHTML = `
    <table class="admin-table">
      <tr><th>ชื่อ</th><th>อีเมล</th><th>สิทธิ์</th><th>จัดการ</th></tr>
      ${users.map(u => `<tr>
        <td>${u.name}</td><td>${u.email}</td>
        <td><span class="att-badge ${u.role === 'admin' ? 'att-ontime' : ''}">${u.role === 'admin' ? '👑 Admin' : '👤 User'}</span></td>
        <td><select data-action="change-role" data-id="${u.id}">
          <option value="user" ${u.role === 'user' ? 'selected' : ''}>User</option>
          <option value="admin" ${u.role === 'admin' ? 'selected' : ''}>Admin</option>
        </select></td>
      </tr>`).join('')}
    </table>`;

  // Attach role change events
  document.querySelectorAll('[data-action="change-role"]').forEach(sel => {
    sel.addEventListener('change', async () => {
      await fetch(`/api/admin/users/${sel.dataset.id}/role`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: sel.value })
      });
      loadAdminUsers();
    });
  });
}

async function loadAdminAttSummary() {
  const month = document.getElementById('admin-att-month').value;
  if (!month) return;
  const res = await fetch('/api/admin/attendance/summary?month=' + month);
  const data = await res.json();
  const container = document.getElementById('admin-att-summary');

  if (!data.length) { container.innerHTML = '<div class="empty-state">ไม่มีข้อมูล</div>'; return; }

  container.innerHTML = `
    <table class="admin-table">
      <tr><th>ชื่อ</th><th>ลงเวลา (วัน)</th><th>🟢 ตรงเวลา</th><th>🟡 สาย</th><th>ลงออก</th></tr>
      ${data.map(u => `<tr>
        <td>${u.name}</td>
        <td>${u.total_days}</td>
        <td class="text-success">${u.on_time}</td>
        <td class="text-warning">${u.late}</td>
        <td>${u.clocked_out}</td>
      </tr>`).join('')}
    </table>`;
}

async function loadAdminAttDetail() {
  const date = document.getElementById('admin-att-date').value;
  if (!date) return;
  const res = await fetch('/api/admin/attendance?date=' + date);
  const records = await res.json();
  const container = document.getElementById('admin-att-detail');

  if (!records.length) { container.innerHTML = '<div class="empty-state">ไม่มีข้อมูลวันนี้</div>'; return; }

  container.innerHTML = records.map(r => {
    const statusClass = r.status === 'ตรงเวลา' ? 'att-ontime' : 'att-late';
    const statusIcon = r.status === 'ตรงเวลา' ? '🟢' : '🟡';
    return `<div class="att-admin-card">
      <div class="att-admin-header">
        <strong>👤 ${r.user_name}</strong>
        <span class="att-badge ${statusClass}">${statusIcon} ${r.status}</span>
      </div>
      <div class="att-admin-body">
        <div class="att-admin-row">
          <span>🟢 เข้า: <strong>${r.clock_in_time || '-'}</strong></span>
          ${r.clock_in_photo ? `<img src="${r.clock_in_photo}" class="att-photo-sm" data-action="open-modal" data-src="${r.clock_in_photo}">` : ''}
          ${r.clock_in_location ? `<span class="att-location-sm">📍 ${r.clock_in_location}</span>` : ''}
        </div>
        <div class="att-admin-row">
          <span>🔴 ออก: <strong>${r.clock_out_time || '-'}</strong></span>
          ${r.clock_out_photo ? `<img src="${r.clock_out_photo}" class="att-photo-sm" data-action="open-modal" data-src="${r.clock_out_photo}">` : ''}
          ${r.clock_out_location ? `<span class="att-location-sm">📍 ${r.clock_out_location}</span>` : ''}
        </div>
      </div>
    </div>`;
  }).join('');
}
