const router  = require('express').Router();
const bcrypt  = require('bcryptjs');
const jwt     = require('jsonwebtoken');
const { v4: uuid } = require('uuid');
const db      = require('../config/database');
const { auth } = require('../middleware/auth');

router.post('/register', async (req, res) => {
  try {
    const { name, email, phone, password, referral_code } = req.body;
    if (!name || !email || !password)
      return res.status(400).json({ success: false, message: 'Name, email and password required' });

    const exists = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (exists) return res.status(400).json({ success: false, message: 'Email already registered' });

    const hash    = await bcrypt.hash(password, 10);
    const id      = uuid();
    const refCode = Math.random().toString(36).substr(2, 8).toUpperCase();

    let referrerId = null;
    if (referral_code) {
      const referrer = db.prepare('SELECT id FROM users WHERE referral_code = ?').get(referral_code);
      if (referrer) referrerId = referrer.id;
    }

    db.prepare(`
      INSERT INTO users (id, name, email, phone, password, referral_code, referred_by)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, email, phone || null, hash, refCode, referrerId);

    if (referrerId) {
      db.prepare('UPDATE users SET balance = balance + 200 WHERE id = ?').run(referrerId);
      db.prepare(`INSERT INTO transactions (id,user_id,type,amount,description,ref,status)
        VALUES (?,?,'earn',200,'Referral bonus',?,?)`)
        .run(uuid(), referrerId, `REF-${id}`, 'success');
    }

    db.prepare('UPDATE users SET balance = balance + 50 WHERE id = ?').run(id);

    const token = jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const user  = db.prepare('SELECT id,name,email,phone,balance,streak,referral_code FROM users WHERE id=?').get(id);

    res.json({ success: true, token, user });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(400).json({ success: false, message: 'Invalid credentials' });

    const valid = await bcrypt.compare(password, user.password);
    if (!valid) return res.status(400).json({ success: false, message: 'Invalid credentials' });

    const today     = new Date().toDateString();
    const lastLogin = user.last_login ? new Date(user.last_login).toDateString() : null;
    let streak = user.streak;
    let bonusEarned = 0;

    if (lastLogin !== today) {
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      streak = lastLogin === yesterday.toDateString() ? streak + 1 : 1;

      bonusEarned = streak % 30 === 0 ? 510 : 10;
      db.prepare(`UPDATE users SET streak=?, last_login=datetime('now'), balance=balance+? WHERE id=?`)
        .run(streak, bonusEarned, user.id);
      db.prepare(`INSERT INTO transactions (id,user_id,type,amount,description,ref,status) VALUES (?,?,'earn',?,?,?,?)`)
        .run(uuid(), user.id, bonusEarned, `Daily login (streak ${streak})`, `LOGIN-${Date.now()}`, 'success');
    }

    const token   = jwt.sign({ id: user.id }, process.env.JWT_SECRET, { expiresIn: '30d' });
    const updated = db.prepare('SELECT id,name,email,phone,balance,streak,referral_code,role FROM users WHERE id=?').get(user.id);

    res.json({ success: true, token, user: updated, bonus: bonusEarned });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/me', auth, (req, res) => {
  const user = db.prepare('SELECT id,name,email,phone,balance,streak,referral_code,role,created_at FROM users WHERE id=?').get(req.user.id);
  res.json({ success: true, user });
});

module.exports = router;
