const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== Security Headers ==========
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:"],
      workerSrc: ["'self'", "blob:", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'", "data:", "blob:", "https://cdn.jsdelivr.net", "https://tessdata.projectnaptha.com"],
      childSrc: ["'self'", "blob:"]
    }
  }
}));

// ========== Rate Limiting ==========
// Login/Register: max 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'คำขอมากเกินไป กรุณารอ 15 นาที' },
  standardHeaders: true,
  legacyHeaders: false
});

// General API: max 100 requests per minute per IP
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'คำขอมากเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false
});

// Ensure uploads directory exists
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

// Multer setup
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1000) + ext);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype.split('/')[1])) return cb(null, true);
    cb(new Error('อนุญาตเฉพาะไฟล์รูปภาพ'));
  }
});

// Database setup
const db = new Database(path.join(__dirname, 'worklog.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    icon TEXT DEFAULT '📌',
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS work_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    date TEXT NOT NULL,
    channel TEXT NOT NULL,
    system_type TEXT DEFAULT '',
    topic TEXT NOT NULL,
    reporter TEXT DEFAULT '',
    detail TEXT DEFAULT '',
    status TEXT DEFAULT 'รอดำเนินการ',
    images TEXT DEFAULT '[]',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Add columns for existing databases
try { db.exec("ALTER TABLE work_logs ADD COLUMN user_id INTEGER DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE work_logs ADD COLUMN system_type TEXT DEFAULT ''"); } catch {}
try { db.exec("ALTER TABLE work_logs ADD COLUMN images TEXT DEFAULT '[]'"); } catch {}

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

// Apply API rate limiter to all /api routes
app.use('/api/', apiLimiter);

// Auth middleware
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  next();
}

// XSS sanitize helper
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim();
}

// ========== AUTH API ==========

// Register
app.post('/api/auth/register', authLimiter, (req, res) => {
  const name = sanitize(req.body.name);
  const email = sanitize(req.body.email);
  const password = req.body.password;
  if (!name || !email || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
  if (password.length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(400).json({ error: 'อีเมลนี้ถูกใช้แล้ว' });

  const hash = bcrypt.hashSync(password, 10);
  const result = db.prepare('INSERT INTO users (name, email, password) VALUES (?, ?, ?)').run(name, email, hash);

  // Add default categories for new user
  const defaults = [
    ['ระบบสมัครเรียนไทย', '🇹🇭'], ['ระบบสมัครเรียนต่างชาติ', '🌏'],
    ['ระบบคอร์สอบรม', '📚'], ['ระบบสอบภาษาอังกฤษ', '🔤'],
    ['ระบบ e-Form', '📝'], ['ระบบ Grad Portal', '🎓'],
    ['ระบบ iThesis', '📖'], ['ระบบ Turnitin', '🔍'], ['อื่นๆ', '📌']
  ];
  const insertCat = db.prepare('INSERT INTO categories (user_id, name, icon) VALUES (?, ?, ?)');
  defaults.forEach(([name, icon]) => insertCat.run(result.lastInsertRowid, name, icon));

  req.session.userId = result.lastInsertRowid;
  req.session.userName = name;
  res.status(201).json({ id: result.lastInsertRowid, name, email });
});

// Login
app.post('/api/auth/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
  }

  req.session.userId = user.id;
  req.session.userName = user.name;
  res.json({ id: user.id, name: user.name, email: user.email });
});

// Logout
app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

// Get current user
app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.json(null);
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(req.session.userId);
  res.json(user || null);
});

// ========== CATEGORIES API ==========

app.get('/api/categories', requireAuth, (req, res) => {
  const cats = db.prepare('SELECT * FROM categories WHERE user_id = ? ORDER BY id').all(req.session.userId);
  res.json(cats);
});

app.post('/api/categories', requireAuth, (req, res) => {
  const { name, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อประเภท' });
  const result = db.prepare('INSERT INTO categories (user_id, name, icon) VALUES (?, ?, ?)').run(req.session.userId, name, icon || '📌');
  res.status(201).json({ id: result.lastInsertRowid, user_id: req.session.userId, name, icon: icon || '📌' });
});

app.put('/api/categories/:id', requireAuth, (req, res) => {
  const { name, icon } = req.body;
  db.prepare('UPDATE categories SET name=?, icon=? WHERE id=? AND user_id=?').run(name, icon || '📌', req.params.id, req.session.userId);
  res.json({ success: true });
});

app.delete('/api/categories/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM categories WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ success: true });
});

// ========== UPLOAD ==========

app.post('/api/upload', requireAuth, upload.array('images', 5), (req, res) => {
  const files = req.files.map(f => ({ filename: f.filename, path: '/uploads/' + f.filename, originalname: f.originalname }));
  res.json({ files });
});

// ========== WORK LOGS API ==========

app.get('/api/logs', requireAuth, (req, res) => {
  const { date, month, status, channel, system_type } = req.query;
  let sql = 'SELECT * FROM work_logs WHERE user_id = ?';
  const params = [req.session.userId];

  if (date) { sql += ' AND date = ?'; params.push(date); }
  if (month) { sql += " AND strftime('%Y-%m', date) = ?"; params.push(month); }
  if (status) { sql += ' AND status = ?'; params.push(status); }
  if (channel) { sql += ' AND channel = ?'; params.push(channel); }
  if (system_type) { sql += ' AND system_type = ?'; params.push(system_type); }

  sql += ' ORDER BY date DESC, created_at DESC';
  const rows = db.prepare(sql).all(...params);
  rows.forEach(r => { try { r.images = JSON.parse(r.images); } catch { r.images = []; } });
  res.json(rows);
});

app.get('/api/summary', requireAuth, (req, res) => {
  const { type, date, month } = req.query;
  const uid = req.session.userId;

  if (type === 'daily' && date) {
    const total = db.prepare('SELECT COUNT(*) as count FROM work_logs WHERE user_id=? AND date=?').get(uid, date);
    const byChannel = db.prepare('SELECT channel, COUNT(*) as count FROM work_logs WHERE user_id=? AND date=? GROUP BY channel').all(uid, date);
    const byStatus = db.prepare('SELECT status, COUNT(*) as count FROM work_logs WHERE user_id=? AND date=? GROUP BY status').all(uid, date);
    const bySystem = db.prepare("SELECT system_type, COUNT(*) as count FROM work_logs WHERE user_id=? AND date=? AND system_type!='' GROUP BY system_type").all(uid, date);
    res.json({ total: total.count, byChannel, byStatus, bySystem });
  } else if (type === 'monthly' && month) {
    const total = db.prepare("SELECT COUNT(*) as count FROM work_logs WHERE user_id=? AND strftime('%Y-%m', date)=?").get(uid, month);
    const byChannel = db.prepare("SELECT channel, COUNT(*) as count FROM work_logs WHERE user_id=? AND strftime('%Y-%m', date)=? GROUP BY channel").all(uid, month);
    const byStatus = db.prepare("SELECT status, COUNT(*) as count FROM work_logs WHERE user_id=? AND strftime('%Y-%m', date)=? GROUP BY status").all(uid, month);
    const byDay = db.prepare("SELECT date, COUNT(*) as count FROM work_logs WHERE user_id=? AND strftime('%Y-%m', date)=? GROUP BY date ORDER BY date").all(uid, month);
    const bySystem = db.prepare("SELECT system_type, COUNT(*) as count FROM work_logs WHERE user_id=? AND strftime('%Y-%m', date)=? AND system_type!='' GROUP BY system_type").all(uid, month);
    res.json({ total: total.count, byChannel, byStatus, byDay, bySystem });
  } else {
    res.json({ total: 0, byChannel: [], byStatus: [], bySystem: [] });
  }
});

app.post('/api/logs', requireAuth, (req, res) => {
  const date = sanitize(req.body.date);
  const channel = sanitize(req.body.channel);
  const topic = sanitize(req.body.topic);
  const reporter = sanitize(req.body.reporter);
  const detail = sanitize(req.body.detail);
  const status = sanitize(req.body.status);
  const system_type = sanitize(req.body.system_type);
  const images = req.body.images;
  if (!date || !channel || !topic) return res.status(400).json({ error: 'กรุณากรอก วันที่ ช่องทาง และเรื่อง' });

  const result = db.prepare(`
    INSERT INTO work_logs (user_id, date, channel, system_type, topic, reporter, detail, status, images)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(req.session.userId, date, channel, system_type, topic, reporter, detail, status || 'รอดำเนินการ', JSON.stringify(images || []));

  const row = db.prepare('SELECT * FROM work_logs WHERE id = ?').get(result.lastInsertRowid);
  try { row.images = JSON.parse(row.images); } catch { row.images = []; }
  res.status(201).json(row);
});

app.put('/api/logs/:id', requireAuth, (req, res) => {
  const { date, channel, topic, reporter, detail, status, images, system_type } = req.body;
  db.prepare(`
    UPDATE work_logs SET date=?, channel=?, system_type=?, topic=?, reporter=?, detail=?, status=?, images=?, updated_at=datetime('now','localtime')
    WHERE id=? AND user_id=?
  `).run(date, channel, system_type || '', topic, reporter || '', detail || '', status, JSON.stringify(images || []), req.params.id, req.session.userId);

  const row = db.prepare('SELECT * FROM work_logs WHERE id = ?').get(req.params.id);
  try { row.images = JSON.parse(row.images); } catch { row.images = []; }
  res.json(row);
});

app.delete('/api/logs/:id', requireAuth, (req, res) => {
  const row = db.prepare('SELECT images FROM work_logs WHERE id=? AND user_id=?').get(req.params.id, req.session.userId);
  if (row) {
    try { JSON.parse(row.images).forEach(img => { const p = path.join(__dirname, 'public', img.path); if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch {}
  }
  db.prepare('DELETE FROM work_logs WHERE id=? AND user_id=?').run(req.params.id, req.session.userId);
  res.json({ success: true });
});

// ========== EXPORT API ==========

app.get('/api/export/:format', requireAuth, (req, res) => {
  const format = req.params.format;
  if (!['xlsx', 'csv'].includes(format)) return res.status(400).json({ error: 'รองรับเฉพาะ xlsx และ csv' });

  const rows = db.prepare('SELECT date, channel, system_type, topic, reporter, detail, status, created_at FROM work_logs WHERE user_id = ? ORDER BY date DESC, created_at DESC').all(req.session.userId);

  const data = rows.map(r => ({
    'วันที่': r.date,
    'ช่องทาง': r.channel,
    'ประเภทระบบ': r.system_type || '',
    'เรื่อง': r.topic,
    'ผู้แจ้ง': r.reporter || '',
    'รายละเอียด': r.detail || '',
    'สถานะ': r.status,
    'บันทึกเมื่อ': r.created_at
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Work Log');

  // Auto column widths
  const colWidths = Object.keys(data[0] || {}).map(key => ({
    wch: Math.max(key.length * 2, ...data.map(r => String(r[key] || '').length).slice(0, 50)) + 2
  }));
  ws['!cols'] = colWidths;

  if (format === 'xlsx') {
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', 'attachment; filename=work-log-export.xlsx');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } else {
    const csvData = XLSX.utils.sheet_to_csv(ws);
    const bom = '\uFEFF';
    res.setHeader('Content-Disposition', 'attachment; filename=work-log-export.csv');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send(bom + csvData);
  }
});

app.listen(PORT, () => console.log(`🚀 Work Log app running at http://localhost:${PORT}`));
