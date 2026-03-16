const express = require('express');
const { Pool } = require('pg');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const cookieSession = require('cookie-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const XLSX = require('xlsx');
const cloudinary = require('cloudinary').v2;

// ========== Cloudinary ==========
if (process.env.CLOUDINARY_URL) {
  cloudinary.config(); // auto-reads CLOUDINARY_URL env
  console.log('☁️ Cloudinary connected:', cloudinary.config().cloud_name);
}

const app = express();
app.set('trust proxy', 1);
const PORT = process.env.PORT || 3000;

// ========== PostgreSQL ==========
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS categories (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        icon TEXT DEFAULT '📌'
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS work_logs (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id),
        date TEXT NOT NULL,
        channel TEXT NOT NULL,
        system_type TEXT DEFAULT '',
        topic TEXT NOT NULL,
        reporter TEXT DEFAULT '',
        detail TEXT DEFAULT '',
        status TEXT DEFAULT 'รอดำเนินการ',
        images JSONB DEFAULT '[]',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);
    console.log('✅ Database tables ready');
  } finally {
    client.release();
  }
}

// ========== Security Headers ==========
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'wasm-unsafe-eval'", "https://cdn.jsdelivr.net"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "blob:", "https://res.cloudinary.com"],
      workerSrc: ["'self'", "blob:", "https://cdn.jsdelivr.net"],
      connectSrc: ["'self'", "data:", "blob:", "https://cdn.jsdelivr.net", "https://tessdata.projectnaptha.com"],
      childSrc: ["'self'", "blob:"]
    }
  }
}));

// ========== Rate Limiting ==========
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: 'คำขอมากเกินไป กรุณารอ 15 นาที' },
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  message: { error: 'คำขอมากเกินไป กรุณารอสักครู่' },
  standardHeaders: true,
  legacyHeaders: false
});

// Multer setup (memory storage for Cloudinary upload)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = /jpeg|jpg|png|gif|webp/;
    if (allowed.test(path.extname(file.originalname).toLowerCase()) && allowed.test(file.mimetype.split('/')[1])) return cb(null, true);
    cb(new Error('อนุญาตเฉพาะไฟล์รูปภาพ'));
  }
});

// Middleware
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex')],
  maxAge: 30 * 24 * 60 * 60 * 1000,
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production'
}));

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

app.post('/api/auth/register', authLimiter, async (req, res) => {
  try {
    const name = sanitize(req.body.name);
    const email = sanitize(req.body.email);
    const password = req.body.password;
    if (!name || !email || !password) return res.status(400).json({ error: 'กรุณากรอกข้อมูลให้ครบ' });
    if (password.length < 6) return res.status(400).json({ error: 'รหัสผ่านต้องมีอย่างน้อย 6 ตัวอักษร' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'รูปแบบอีเมลไม่ถูกต้อง' });

    const existing = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) return res.status(400).json({ error: 'อีเมลนี้ถูกใช้แล้ว' });

    const hash = bcrypt.hashSync(password, 10);
    const result = await pool.query('INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id', [name, email, hash]);
    const userId = result.rows[0].id;

    // Add default categories
    const defaults = [
      ['ระบบสมัครเรียนไทย', '🇹🇭'], ['ระบบสมัครเรียนต่างชาติ', '🌏'],
      ['ระบบคอร์สอบรม', '📚'], ['ระบบสอบภาษาอังกฤษ', '🔤'],
      ['ระบบ e-Form', '📝'], ['ระบบ Grad Portal', '🎓'],
      ['ระบบ iThesis', '📖'], ['ระบบ Turnitin', '🔍'], ['อื่นๆ', '📌']
    ];
    for (const [catName, icon] of defaults) {
      await pool.query('INSERT INTO categories (user_id, name, icon) VALUES ($1, $2, $3)', [userId, catName, icon]);
    }

    req.session.userId = userId;
    req.session.userName = name;
    res.status(201).json({ id: userId, name, email });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'กรุณากรอกอีเมลและรหัสผ่าน' });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    if (!user || !bcrypt.compareSync(password, user.password)) {
      return res.status(401).json({ error: 'อีเมลหรือรหัสผ่านไม่ถูกต้อง' });
    }

    req.session.userId = user.id;
    req.session.userName = user.name;
    res.json({ id: user.id, name: user.name, email: user.email });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'เกิดข้อผิดพลาด' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session = null;
  res.json({ success: true });
});

app.get('/api/auth/me', async (req, res) => {
  if (!req.session.userId) return res.json(null);
  try {
    const result = await pool.query('SELECT id, name, email FROM users WHERE id = $1', [req.session.userId]);
    res.json(result.rows[0] || null);
  } catch { res.json(null); }
});

// ========== CATEGORIES API ==========

app.get('/api/categories', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM categories WHERE user_id = $1 ORDER BY id', [req.session.userId]);
  res.json(result.rows);
});

app.post('/api/categories', requireAuth, async (req, res) => {
  const { name, icon } = req.body;
  if (!name) return res.status(400).json({ error: 'กรุณาใส่ชื่อประเภท' });
  const result = await pool.query('INSERT INTO categories (user_id, name, icon) VALUES ($1, $2, $3) RETURNING *', [req.session.userId, name, icon || '📌']);
  res.status(201).json(result.rows[0]);
});

app.put('/api/categories/:id', requireAuth, async (req, res) => {
  const { name, icon } = req.body;
  await pool.query('UPDATE categories SET name=$1, icon=$2 WHERE id=$3 AND user_id=$4', [name, icon || '📌', req.params.id, req.session.userId]);
  res.json({ success: true });
});

app.delete('/api/categories/:id', requireAuth, async (req, res) => {
  await pool.query('DELETE FROM categories WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  res.json({ success: true });
});

// ========== UPLOAD ==========

app.post('/api/upload', requireAuth, upload.array('images', 5), async (req, res) => {
  try {
    const files = [];
    for (const f of req.files) {
      if (process.env.CLOUDINARY_URL) {
        // Upload to Cloudinary
        const result = await new Promise((resolve, reject) => {
          const stream = cloudinary.uploader.upload_stream(
            { folder: 'work-log', resource_type: 'image' },
            (err, result) => err ? reject(err) : resolve(result)
          );
          stream.end(f.buffer);
        });
        files.push({ filename: result.public_id, path: result.secure_url, originalname: f.originalname });
      } else {
        // Fallback: save locally
        const uploadsDir = path.join(__dirname, 'public', 'uploads');
        if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
        const ext = path.extname(f.originalname);
        const filename = Date.now() + '-' + Math.round(Math.random() * 1000) + ext;
        fs.writeFileSync(path.join(uploadsDir, filename), f.buffer);
        files.push({ filename, path: '/uploads/' + filename, originalname: f.originalname });
      }
    }
    res.json({ files });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'อัปโหลดไม่สำเร็จ' });
  }
});

// ========== WORK LOGS API ==========

app.get('/api/logs', requireAuth, async (req, res) => {
  const { date, month, status, channel, system_type } = req.query;
  let sql = 'SELECT * FROM work_logs WHERE user_id = $1';
  const params = [req.session.userId];
  let paramCount = 1;

  if (date) { paramCount++; sql += ` AND date = $${paramCount}`; params.push(date); }
  if (month) { paramCount++; sql += ` AND to_char(date::date, 'YYYY-MM') = $${paramCount}`; params.push(month); }
  if (status) { paramCount++; sql += ` AND status = $${paramCount}`; params.push(status); }
  if (channel) { paramCount++; sql += ` AND channel = $${paramCount}`; params.push(channel); }
  if (system_type) { paramCount++; sql += ` AND system_type = $${paramCount}`; params.push(system_type); }

  sql += ' ORDER BY date DESC, created_at DESC';
  const result = await pool.query(sql, params);
  res.json(result.rows);
});

app.get('/api/summary', requireAuth, async (req, res) => {
  const { type, date, month } = req.query;
  const uid = req.session.userId;

  try {
    if (type === 'daily' && date) {
      const total = await pool.query('SELECT COUNT(*) as count FROM work_logs WHERE user_id=$1 AND date=$2', [uid, date]);
      const byChannel = await pool.query('SELECT channel, COUNT(*) as count FROM work_logs WHERE user_id=$1 AND date=$2 GROUP BY channel', [uid, date]);
      const byStatus = await pool.query('SELECT status, COUNT(*) as count FROM work_logs WHERE user_id=$1 AND date=$2 GROUP BY status', [uid, date]);
      const bySystem = await pool.query("SELECT system_type, COUNT(*) as count FROM work_logs WHERE user_id=$1 AND date=$2 AND system_type!='' GROUP BY system_type", [uid, date]);
      res.json({ total: parseInt(total.rows[0].count), byChannel: byChannel.rows, byStatus: byStatus.rows, bySystem: bySystem.rows });
    } else if (type === 'monthly' && month) {
      const total = await pool.query("SELECT COUNT(*) as count FROM work_logs WHERE user_id=$1 AND to_char(date::date, 'YYYY-MM')=$2", [uid, month]);
      const byChannel = await pool.query("SELECT channel, COUNT(*) as count FROM work_logs WHERE user_id=$1 AND to_char(date::date, 'YYYY-MM')=$2 GROUP BY channel", [uid, month]);
      const byStatus = await pool.query("SELECT status, COUNT(*) as count FROM work_logs WHERE user_id=$1 AND to_char(date::date, 'YYYY-MM')=$2 GROUP BY status", [uid, month]);
      const byDay = await pool.query("SELECT date, COUNT(*) as count FROM work_logs WHERE user_id=$1 AND to_char(date::date, 'YYYY-MM')=$2 GROUP BY date ORDER BY date", [uid, month]);
      const bySystem = await pool.query("SELECT system_type, COUNT(*) as count FROM work_logs WHERE user_id=$1 AND to_char(date::date, 'YYYY-MM')=$2 AND system_type!='' GROUP BY system_type", [uid, month]);
      res.json({ total: parseInt(total.rows[0].count), byChannel: byChannel.rows, byStatus: byStatus.rows, byDay: byDay.rows, bySystem: bySystem.rows });
    } else {
      res.json({ total: 0, byChannel: [], byStatus: [], bySystem: [] });
    }
  } catch (err) {
    console.error('Summary error:', err);
    res.json({ total: 0, byChannel: [], byStatus: [], bySystem: [] });
  }
});

app.post('/api/logs', requireAuth, async (req, res) => {
  const date = sanitize(req.body.date);
  const channel = sanitize(req.body.channel);
  const topic = sanitize(req.body.topic);
  const reporter = sanitize(req.body.reporter);
  const detail = sanitize(req.body.detail);
  const status = sanitize(req.body.status);
  const system_type = sanitize(req.body.system_type);
  const images = req.body.images || [];
  if (!date || !channel || !topic) return res.status(400).json({ error: 'กรุณากรอก วันที่ ช่องทาง และเรื่อง' });

  const result = await pool.query(
    'INSERT INTO work_logs (user_id, date, channel, system_type, topic, reporter, detail, status, images) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
    [req.session.userId, date, channel, system_type, topic, reporter, detail, status || 'รอดำเนินการ', JSON.stringify(images)]
  );
  res.status(201).json(result.rows[0]);
});

app.put('/api/logs/:id', requireAuth, async (req, res) => {
  const { date, channel, topic, reporter, detail, status, images, system_type } = req.body;
  const result = await pool.query(
    'UPDATE work_logs SET date=$1, channel=$2, system_type=$3, topic=$4, reporter=$5, detail=$6, status=$7, images=$8, updated_at=NOW() WHERE id=$9 AND user_id=$10 RETURNING *',
    [date, channel, system_type || '', topic, reporter || '', detail || '', status, JSON.stringify(images || []), req.params.id, req.session.userId]
  );
  res.json(result.rows[0]);
});

app.delete('/api/logs/:id', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT images FROM work_logs WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  if (result.rows[0]) {
    try {
      const images = typeof result.rows[0].images === 'string' ? JSON.parse(result.rows[0].images) : result.rows[0].images;
      images.forEach(img => { const p = path.join(__dirname, 'public', img.path); if (fs.existsSync(p)) fs.unlinkSync(p); });
    } catch {}
  }
  await pool.query('DELETE FROM work_logs WHERE id=$1 AND user_id=$2', [req.params.id, req.session.userId]);
  res.json({ success: true });
});

// ========== EXPORT API ==========

app.get('/api/export/:format', requireAuth, async (req, res) => {
  const format = req.params.format;
  if (!['xlsx', 'csv'].includes(format)) return res.status(400).json({ error: 'รองรับเฉพาะ xlsx และ csv' });

  const result = await pool.query(
    'SELECT date, channel, system_type, topic, reporter, detail, status, created_at FROM work_logs WHERE user_id = $1 ORDER BY date DESC, created_at DESC',
    [req.session.userId]
  );

  const data = result.rows.map(r => ({
    'วันที่': r.date,
    'ช่องทาง': r.channel,
    'ประเภทระบบ': r.system_type || '',
    'เรื่อง': r.topic,
    'ผู้แจ้ง': r.reporter || '',
    'รายละเอียด': r.detail || '',
    'สถานะ': r.status,
    'บันทึกเมื่อ': r.created_at
  }));

  if (data.length === 0) {
    data.push({ 'วันที่': '', 'ช่องทาง': '', 'ประเภทระบบ': '', 'เรื่อง': 'ไม่มีข้อมูล', 'ผู้แจ้ง': '', 'รายละเอียด': '', 'สถานะ': '', 'บันทึกเมื่อ': '' });
  }

  const ws = XLSX.utils.json_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Work Log');

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
    res.setHeader('Content-Disposition', 'attachment; filename=work-log-export.csv');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.send('\uFEFF' + csvData);
  }
});

// ========== START ==========
initDB().then(() => {
  app.listen(PORT, () => console.log(`🚀 Work Log app running at http://localhost:${PORT}`));
}).catch(err => {
  console.error('Failed to init database:', err);
  process.exit(1);
});
