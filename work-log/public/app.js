// ========== State ==========
let editingId = null;
let uploadedImages = [];

// ========== Init ==========
document.addEventListener('DOMContentLoaded', () => {
  // Set today's date
  const today = new Date().toISOString().split('T')[0];
  document.getElementById('log-date').value = today;
  document.getElementById('summary-date').value = today;
  document.getElementById('summary-month').value = today.substring(0, 7);

  initTabs();
  initForm();
  initUpload();
  initQuickTags();
  initFilter();
  initSummary();
  initModal();
  loadTodayLogs();
});

// ========== Tabs ==========
function initTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById('tab-' + tab.dataset.tab).classList.add('active');

      if (tab.dataset.tab === 'list') loadFilteredLogs();
    });
  });
}

// ========== Image Upload & OCR ==========
function initUpload() {
  const zone = document.getElementById('upload-zone');
  const input = document.getElementById('file-input');

  zone.addEventListener('click', () => input.click());

  zone.addEventListener('dragover', e => {
    e.preventDefault();
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    handleFiles(e.dataTransfer.files);
  });

  input.addEventListener('change', () => {
    handleFiles(input.files);
    input.value = '';
  });
}

async function handleFiles(files) {
  let firstFile = null;
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;

    if (!firstFile) firstFile = file;

    const formData = new FormData();
    formData.append('images', file);

    try {
      const res = await fetch('/api/upload', { method: 'POST', body: formData });
      const data = await res.json();
      if (data.files && data.files.length > 0) {
        uploadedImages.push(...data.files);
        renderImagePreviews();
      }
    } catch (err) {
      alert('อัปโหลดไม่สำเร็จ: ' + err.message);
    }
  }

  // Run OCR on the first uploaded image
  if (firstFile) {
    runOCR(firstFile);
  }
}

function renderImagePreviews() {
  const container = document.getElementById('image-preview-list');
  container.innerHTML = uploadedImages.map((img, i) => `
    <div class="image-preview-item">
      <img src="${img.path}" alt="${img.originalname}" onclick="openModal('${img.path}')">
      <button class="image-remove-btn" onclick="removeImage(${i})">&times;</button>
      <span class="image-name">${img.originalname}</span>
    </div>
  `).join('');
}

function removeImage(index) {
  uploadedImages.splice(index, 1);
  renderImagePreviews();
}

// ========== Image Preprocessing ==========
function preprocessImage(file) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      // Upscale small images (Tesseract works best at 300+ DPI)
      const SCALE = img.width < 1000 ? 3 : (img.width < 2000 ? 2 : 1);
      const canvas = document.createElement('canvas');
      canvas.width = img.width * SCALE;
      canvas.height = img.height * SCALE;
      const ctx = canvas.getContext('2d');

      // Draw upscaled image
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

      // Get pixel data
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;

      // Step 1: Grayscale
      for (let i = 0; i < data.length; i += 4) {
        const gray = data[i] * 0.299 + data[i+1] * 0.587 + data[i+2] * 0.114;
        data[i] = data[i+1] = data[i+2] = gray;
      }

      // Step 2: Increase contrast
      const contrast = 50;
      const factor = (259 * (contrast + 255)) / (255 * (259 - contrast));
      for (let i = 0; i < data.length; i += 4) {
        data[i]   = Math.min(255, Math.max(0, factor * (data[i] - 128) + 128));
        data[i+1] = Math.min(255, Math.max(0, factor * (data[i+1] - 128) + 128));
        data[i+2] = Math.min(255, Math.max(0, factor * (data[i+2] - 128) + 128));
      }

      // Step 3: Adaptive threshold (Binarization) - improves Thai text clarity
      const threshold = 140;
      for (let i = 0; i < data.length; i += 4) {
        const val = data[i] < threshold ? 0 : 255;
        data[i] = data[i+1] = data[i+2] = val;
      }

      ctx.putImageData(imageData, 0, 0);

      canvas.toBlob(blob => {
        resolve(blob);
      }, 'image/png');
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
    // Preprocess image before OCR
    const processedBlob = await preprocessImage(file);

    statusText.textContent = '📖 กำลังอ่านข้อความ... (อาจใช้เวลาสักครู่)';

    const worker = await Tesseract.createWorker('tha+eng', 1, {
      logger: m => {
        if (m.status === 'recognizing text') {
          const pct = Math.round(m.progress * 100);
          statusText.textContent = `📖 กำลังอ่านข้อความ... ${pct}%`;
        }
      }
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
      <div class="ocr-result-header">
        <h4>📝 ข้อความที่อ่านได้จากภาพ</h4>
        <span class="ocr-hint-small">แก้ไขข้อความได้ก่อนกดใช้</span>
      </div>
      <textarea id="ocr-text" rows="5">${cleanText}</textarea>
      <div class="ocr-actions">
        <button type="button" class="btn btn-primary btn-sm" onclick="useOCRAsDetail()">📋 ใช้เป็นรายละเอียด</button>
        <button type="button" class="btn btn-primary btn-sm" onclick="useOCRAsTopic()">📌 ใช้เป็นเรื่อง</button>
        <button type="button" class="btn btn-secondary btn-sm" onclick="closeOCRResult()">ปิด</button>
      </div>
    </div>
  `;
  container.style.display = 'block';

  // Auto-detect channel
  const lower = cleanText.toLowerCase();
  if (lower.includes('facebook') || lower.includes('เฟซบุ๊ก') || lower.includes('messenger') || lower.includes('fb')) {
    document.getElementById('log-channel').value = 'เฟซบุ๊ก';
  } else if (lower.includes('email') || lower.includes('อีเมล') || lower.includes('@') || lower.includes('subject')) {
    document.getElementById('log-channel').value = 'อีเมล';
  } else if (lower.includes('line') || lower.includes('ไลน์')) {
    document.getElementById('log-channel').value = 'LINE';
  }
}

function useOCRAsDetail() {
  const text = document.getElementById('ocr-text').value.trim();
  if (text) document.getElementById('log-detail').value = text;
  closeOCRResult();
}

function useOCRAsTopic() {
  const text = document.getElementById('ocr-text').value.trim();
  if (text) {
    const lines = text.split('\n');
    document.getElementById('log-topic').value = lines[0].substring(0, 100);
    if (lines.length > 1) {
      document.getElementById('log-detail').value = lines.slice(1).join('\n');
    }
  }
  closeOCRResult();
}

function closeOCRResult() {
  document.getElementById('ocr-result').style.display = 'none';
}

// ========== Quick Tags ==========
function initQuickTags() {
  document.querySelectorAll('.quick-tag').forEach(tag => {
    tag.addEventListener('click', () => {
      document.getElementById('log-topic').value = tag.dataset.value;
      document.getElementById('log-topic').focus();
    });
  });
}

// ========== Form ==========
function initForm() {
  const form = document.getElementById('log-form');
  const cancelBtn = document.getElementById('btn-cancel');

  form.addEventListener('submit', async e => {
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
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error);
      }

      resetForm();
      loadTodayLogs();
    } catch (err) {
      alert('เกิดข้อผิดพลาด: ' + err.message);
    }
  });

  cancelBtn.addEventListener('click', resetForm);
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

  // Switch to record tab
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
  renderLogs(logs, 'today-logs');
}

async function loadFilteredLogs() {
  const params = new URLSearchParams();
  const date = document.getElementById('filter-date').value;
  const month = document.getElementById('filter-month').value;
  const channel = document.getElementById('filter-channel').value;
  const status = document.getElementById('filter-status').value;
  const systemType = document.getElementById('filter-system').value;

  if (date) params.set('date', date);
  else if (month) params.set('month', month);
  if (channel) params.set('channel', channel);
  if (status) params.set('status', status);
  if (systemType) params.set('system_type', systemType);

  const res = await fetch('/api/logs?' + params.toString());
  const logs = await res.json();
  renderLogs(logs, 'log-list');
}

function getStatusClass(status) {
  if (status === 'รอดำเนินการ') return 'waiting';
  if (status === 'กำลังดำเนินการ') return 'progress';
  if (status === 'เสร็จแล้ว') return 'done';
  return '';
}

function getStatusBadge(status) {
  const cls = getStatusClass(status);
  const icons = { 'รอดำเนินการ': '🟡', 'กำลังดำเนินการ': '🔵', 'เสร็จแล้ว': '🟢' };
  return `<span class="badge badge-${cls}">${icons[status] || ''} ${status}</span>`;
}

function getChannelIcon(channel) {
  const icons = { 'โทรศัพท์': '📞', 'อีเมล': '📧', 'เฟซบุ๊ก': '💬', 'LINE': '💚', 'Walk-in': '🚶', 'อื่นๆ': '📌' };
  return icons[channel] || '📌';
}

function renderLogs(logs, containerId) {
  const container = document.getElementById(containerId);
  if (logs.length === 0) {
    container.innerHTML = '<div class="empty-state">ไม่มีรายการ</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    const images = log.images || [];
    const imagesHtml = images.length > 0 ? `
      <div class="log-card-images">
        ${images.map(img => `<img src="${img.path}" alt="" class="log-thumb" onclick="openModal('${img.path}')">`).join('')}
      </div>
    ` : '';

    return `
      <div class="log-card status-${getStatusClass(log.status)}">
        <div class="log-card-header">
          <span class="log-card-title">${log.topic}</span>
          ${getStatusBadge(log.status)}
        </div>
        <div class="log-card-meta">
          <span>${getChannelIcon(log.channel)} ${log.channel}</span>
          ${log.system_type ? `<span class="badge badge-system">🖥️ ${log.system_type}</span>` : ''}
          <span>📅 ${log.date}</span>
          ${log.reporter ? `<span>👤 ${log.reporter}</span>` : ''}
        </div>
        ${log.detail ? `<div class="log-card-detail">${log.detail}</div>` : ''}
        ${imagesHtml}
        <div class="log-card-actions">
          <button class="btn btn-sm btn-primary" onclick='editLog(${JSON.stringify(log)})'>✏️ แก้ไข</button>
          <button class="btn btn-sm btn-danger" onclick="deleteLog(${log.id})">🗑️ ลบ</button>
        </div>
      </div>
    `;
  }).join('');
}

// ========== Filter ==========
function initFilter() {
  document.getElementById('btn-filter').addEventListener('click', loadFilteredLogs);
  document.getElementById('btn-clear-filter').addEventListener('click', () => {
    document.getElementById('filter-date').value = '';
    document.getElementById('filter-month').value = '';
    document.getElementById('filter-channel').value = '';
    document.getElementById('filter-status').value = '';
    document.getElementById('filter-system').value = '';
    loadFilteredLogs();
  });
}

// ========== Summary ==========
function initSummary() {
  const dailyBtn = document.getElementById('btn-summary-daily');
  const monthlyBtn = document.getElementById('btn-summary-monthly');
  const dateGroup = document.getElementById('summary-date-group');
  const monthGroup = document.getElementById('summary-month-group');

  dailyBtn.addEventListener('click', () => {
    dailyBtn.classList.add('active');
    monthlyBtn.classList.remove('active');
    dateGroup.style.display = '';
    monthGroup.style.display = 'none';
  });

  monthlyBtn.addEventListener('click', () => {
    monthlyBtn.classList.add('active');
    dailyBtn.classList.remove('active');
    dateGroup.style.display = 'none';
    monthGroup.style.display = '';
  });

  document.getElementById('btn-load-summary').addEventListener('click', loadSummary);
}

async function loadSummary() {
  const isDaily = document.getElementById('btn-summary-daily').classList.contains('active');
  const params = new URLSearchParams();

  if (isDaily) {
    params.set('type', 'daily');
    params.set('date', document.getElementById('summary-date').value);
  } else {
    params.set('type', 'monthly');
    params.set('month', document.getElementById('summary-month').value);
  }

  const res = await fetch('/api/summary?' + params.toString());
  const data = await res.json();
  renderSummary(data, isDaily);
}

function renderSummary(data, isDaily) {
  const container = document.getElementById('summary-content');
  if (data.total === 0) {
    container.innerHTML = '<div class="empty-state">ไม่มีข้อมูล</div>';
    return;
  }

  const maxCount = Math.max(...data.byChannel.map(c => c.count), ...data.byStatus.map(s => s.count), 1);

  let html = `
    <div class="summary-card">
      <h3>📊 ภาพรวม</h3>
      <div class="stat-grid">
        <div class="stat-box">
          <div class="stat-number">${data.total}</div>
          <div class="stat-label">งานทั้งหมด</div>
        </div>
        ${data.byStatus.map(s => `
          <div class="stat-box">
            <div class="stat-number">${s.count}</div>
            <div class="stat-label">${s.status}</div>
          </div>
        `).join('')}
      </div>
    </div>

    <div class="summary-card">
      <h3>📡 แยกตามช่องทาง</h3>
      ${data.byChannel.map(c => `
        <div class="chart-bar">
          <span class="chart-bar-label">${getChannelIcon(c.channel)} ${c.channel}</span>
          <div class="chart-bar-fill channel" style="width: ${Math.max(c.count / maxCount * 100, 10)}%">${c.count}</div>
        </div>
      `).join('')}
    </div>

    <div class="summary-card">
      <h3>📋 แยกตามสถานะ</h3>
      ${data.byStatus.map(s => `
        <div class="chart-bar">
          <span class="chart-bar-label">${s.status}</span>
          <div class="chart-bar-fill status-${getStatusClass(s.status)}" style="width: ${Math.max(s.count / maxCount * 100, 10)}%">${s.count}</div>
        </div>
      `).join('')}
    </div>
  `;

  if (data.bySystem && data.bySystem.length > 0) {
    const maxSys = Math.max(...data.bySystem.map(s => s.count), 1);
    html += `
      <div class="summary-card">
        <h3>🖥️ แยกตามระบบ</h3>
        ${data.bySystem.map(s => `
          <div class="chart-bar">
            <span class="chart-bar-label">${s.system_type}</span>
            <div class="chart-bar-fill system" style="width: ${Math.max(s.count / maxSys * 100, 10)}%">${s.count}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  if (!isDaily && data.byDay) {
    const maxDay = Math.max(...data.byDay.map(d => d.count), 1);
    html += `
      <div class="summary-card">
        <h3>📅 แยกรายวัน</h3>
        ${data.byDay.map(d => `
          <div class="chart-bar">
            <span class="chart-bar-label">${d.date}</span>
            <div class="chart-bar-fill" style="width: ${Math.max(d.count / maxDay * 100, 10)}%">${d.count}</div>
          </div>
        `).join('')}
      </div>
    `;
  }

  container.innerHTML = html;
}

// ========== Image Modal ==========
function initModal() {
  const modal = document.getElementById('image-modal');
  modal.querySelector('.modal-overlay').addEventListener('click', closeModal);
  modal.querySelector('.modal-close').addEventListener('click', closeModal);
}

function openModal(src) {
  const modal = document.getElementById('image-modal');
  document.getElementById('modal-image').src = src;
  modal.style.display = 'flex';
}

function closeModal() {
  document.getElementById('image-modal').style.display = 'none';
}
