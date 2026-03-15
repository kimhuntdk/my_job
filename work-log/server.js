const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// Multer setup for image uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const name = Date.now() + '-' + Math.round(Math.random() * 1000) + ext;
    cb(null, name);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    const ext = allowed.test(path.extname(file.originalname).toLowerCase());
    const mime = allowed.test(file.mimetype.split('/')[1]);
    if (ext && mime) return cb(null, true);
    cb(new Error('อนุญาตเฉพาะไฟล์รูปภาพ (jpg, png, gif, webp)'));
  }
});

// Database setup
const db = new Database(path.join(__dirname, 'worklog.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    channel TEXT NOT NULL,
    topic TEXT NOT NULL,
    reporter TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    status TEXT DEFAULT 'รอดำเนินการ',
    images TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )
`);

// Add columns if not exists (for existing databases)
try { db.exec("ALTER TABLE work_logs ADD COLUMN images TEXT DEFAULT '[]'"); } catch (e) {}
try { db.exec("ALTER TABLE work_logs ADD COLUMN system_type TEXT DEFAULT ''"); } catch (e) {}

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Upload images
app.post('/api/upload', upload.array('images', 5), (req, res) => {
  const files = req.files.map(f => ({
    filename: f.filename,
    path: '/uploads/' + f.filename,
    originalname: f.originalname
  }));
  res.json({ files });
});

// Get all logs with optional filters
app.get('/api/logs', (req, res) => {
  const { date, month, status, channel } = req.query;
  let sql = 'SELECT * FROM work_logs WHERE 1=1';
  const params = [];

  if (date) {
    sql += ' AND date = ?';
    params.push(date);
  }
  if (month) {
    sql += " AND strftime('%Y-%m', date) = ?";
    params.push(month);
  }
  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (channel) {
    sql += ' AND channel = ?';
    params.push(channel);
  }
  if (req.query.system_type) {
    sql += ' AND system_type = ?';
    params.push(req.query.system_type);
  }

  sql += ' ORDER BY date DESC, created_at DESC';
  const rows = db.prepare(sql).all(...params);
  // Parse images JSON
  rows.forEach(r => {
    try { r.images = JSON.parse(r.images); } catch { r.images = []; }
  });
  res.json(rows);
});

// Get summary
app.get('/api/summary', (req, res) => {
  const { type, date, month } = req.query;

  if (type === 'daily' && date) {
    const total = db.prepare('SELECT COUNT(*) as count FROM work_logs WHERE date = ?').get(date);
    const byChannel = db.prepare('SELECT channel, COUNT(*) as count FROM work_logs WHERE date = ? GROUP BY channel').all(date);
    const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM work_logs WHERE date = ? GROUP BY status').all(date);
    const bySystem = db.prepare("SELECT system_type, COUNT(*) as count FROM work_logs WHERE date = ? AND system_type != '' GROUP BY system_type").all(date);
    res.json({ total: total.count, byChannel, byStatus, bySystem });
  } else if (type === 'monthly' && month) {
    const total = db.prepare("SELECT COUNT(*) as count FROM work_logs WHERE strftime('%Y-%m', date) = ?").get(month);
    const byChannel = db.prepare("SELECT channel, COUNT(*) as count FROM work_logs WHERE strftime('%Y-%m', date) = ? GROUP BY channel").all(month);
    const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM work_logs WHERE strftime('%Y-%m', date) = ? GROUP BY status").all(month);
    const byDay = db.prepare("SELECT date, COUNT(*) as count FROM work_logs WHERE strftime('%Y-%m', date) = ? GROUP BY date ORDER BY date").all(month);
    const bySystem = db.prepare("SELECT system_type, COUNT(*) as count FROM work_logs WHERE strftime('%Y-%m', date) = ? AND system_type != '' GROUP BY system_type").all(month);
    res.json({ total: total.count, byChannel, byStatus, byDay, bySystem });
  } else {
    res.json({ total: 0, byChannel: [], byStatus: [] });
  }
});

// Create log
app.post('/api/logs', (req, res) => {
  const { date, channel, topic, reporter, detail, status, images, system_type } = req.body;
  if (!date || !channel || !topic) {
    return res.status(400).json({ error: 'กรุณากรอก วันที่ ช่องทาง และเรื่อง' });
  }
  const stmt = db.prepare(`
    INSERT INTO work_logs (date, channel, topic, reporter, detail, status, images, system_type)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(date, channel, topic, reporter || '', detail || '', status || 'รอดำเนินการ', JSON.stringify(images || []), system_type || '');
  const row = db.prepare('SELECT * FROM work_logs WHERE id = ?').get(result.lastInsertRowid);
  try { row.images = JSON.parse(row.images); } catch { row.images = []; }
  res.status(201).json(row);
});

// Update log
app.put('/api/logs/:id', (req, res) => {
  const { date, channel, topic, reporter, detail, status, images, system_type } = req.body;
  const stmt = db.prepare(`
    UPDATE work_logs SET date=?, channel=?, topic=?, reporter=?, detail=?, status=?, images=?, system_type=?, updated_at=datetime('now','localtime')
    WHERE id=?
  `);
  stmt.run(date, channel, topic, reporter || '', detail || '', status, JSON.stringify(images || []), system_type || '', req.params.id);
  const row = db.prepare('SELECT * FROM work_logs WHERE id = ?').get(req.params.id);
  try { row.images = JSON.parse(row.images); } catch { row.images = []; }
  res.json(row);
});

// Delete log
app.delete('/api/logs/:id', (req, res) => {
  // Delete associated images
  const row = db.prepare('SELECT images FROM work_logs WHERE id = ?').get(req.params.id);
  if (row) {
    try {
      const images = JSON.parse(row.images);
      images.forEach(img => {
        const filePath = path.join(__dirname, 'public', img.path);
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      });
    } catch {}
  }
  db.prepare('DELETE FROM work_logs WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`🚀 Work Log app running at http://localhost:${PORT}`);
});
