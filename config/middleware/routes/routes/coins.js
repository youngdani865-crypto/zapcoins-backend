const router  = require('express').Router();
const { v4: uuid } = require('uuid');
const db      = require('../config/database');
const { auth } = require('../middleware/auth');

router.get('/balance', auth, (req, res) => {
  const user = db.prepare('SELECT balance, streak FROM users WHERE id=?').get(req.user.id);
  const price = db.prepare('SELECT price_ngn FROM coin_price ORDER BY id DESC LIMIT 1').get();
  res.json({
    success:    true,
    balance:    user.balance,
    streak:     user.streak,
    naira_value: parseFloat((user.balance * price.price_ngn).toFixed(2)),
    price_ngn:  price.price_ngn
  });
});

router.get('/transactions', auth, (req, res) => {
  const txns = db.prepare(`
    SELECT * FROM transactions WHERE user_id=? ORDER BY created_at DESC LIMIT 30
  `).all(req.user.id);
  res.json({ success: true, transactions: txns });
});

router.post('/watch-ad', auth, (req, res) => {
  try {
    const { ad_id } = req.body;

    const todayCount = db.prepare(`
      SELECT COUNT(*) as c FROM transactions
      WHERE user_id=? AND type='earn' AND description LIKE 'Watch Ad%'
      AND date(created_at) = date('now')
    `).get(req.user.id).c;

    if (todayCount >= 10)
      return res.status(400).json({ success: false, message: 'Max 10 ad watches per day reached' });

    const reward = 50;
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(reward, req.user.id);
    db.prepare(`INSERT INTO transactions (id,user_id,type,amount,description,ref,status) VALUES (?,?,'earn',?,?,?,?)`)
      .run(uuid(), req.user.id, reward, `Watch Ad ${ad_id || 1}`, `AD-${uuid()}`, 'success');

    const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
    res.json({ success: true, coins_earned: reward, new_balance: user.balance, ads_today: todayCount + 1 });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/referrals', auth, (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM users WHERE referred_by=?').get(req.user.id).c;
  const earned = db.prepare(`SELECT SUM(amount) as s FROM transactions WHERE user_id=? AND description='Referral bonus'`).get(req.user.id).s || 0;
  res.json({ success: true, referral_code: req.user.referral_code, total_referrals: count, coins_earned: earned });
});

module.exports = router;
