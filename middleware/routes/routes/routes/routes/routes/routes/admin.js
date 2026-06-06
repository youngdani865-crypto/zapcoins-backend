const router  = require('express').Router();
const { v4: uuid } = require('uuid');
const db      = require('../config/database');
const { adminAuth } = require('../middleware/auth');

router.get('/stats', adminAuth, (req, res) => {
  const stats = {
    total_users:      db.prepare('SELECT COUNT(*) as c FROM users').get().c,
    total_coins_out:  db.prepare("SELECT SUM(amount) as s FROM transactions WHERE type='buy'").get().s || 0,
    total_redeemed:   db.prepare("SELECT SUM(ABS(naira_value)) as s FROM transactions WHERE type='redeem'").get().s || 0,
    total_trades:     db.prepare("SELECT COUNT(*) as c FROM market_orders WHERE status='filled'").get().c,
    platform_earnings:db.prepare("SELECT SUM(amount_ngn) as s FROM platform_earnings").get().s || 0,
    active_stakes:    db.prepare("SELECT COUNT(*) as c FROM stakes WHERE status='active'").get().c,
    pending_bank_payments: db.prepare("SELECT COUNT(*) as c FROM payments WHERE provider='bank' AND status='pending'").get().c,
    coin_price:       db.prepare('SELECT price_ngn FROM coin_price ORDER BY id DESC LIMIT 1').get().price_ngn,
  };
  res.json({ success: true, stats });
});

router.post('/coin-price', adminAuth, (req, res) => {
  const { price_ngn } = req.body;
  if (!price_ngn || price_ngn <= 0)
    return res.status(400).json({ success: false, message: 'Invalid price' });

  db.prepare('INSERT INTO coin_price (price_ngn, set_by) VALUES (?,?)').run(price_ngn, req.user.id);
  res.json({ success: true, new_price: price_ngn, message: `Coin price updated to ₦${price_ngn}` });
});

router.get('/bank-payments', adminAuth, (req, res) => {
  const payments = db.prepare(`
    SELECT p.*, u.name, u.email FROM payments p
    JOIN users u ON p.user_id = u.id
    WHERE p.provider='bank' AND p.status='pending'
    ORDER BY p.created_at ASC
  `).all();
  res.json({ success: true, payments });
});

router.post('/bank-payments/:id/confirm', adminAuth, (req, res) => {
  const payment = db.prepare("SELECT * FROM payments WHERE id=? AND provider='bank'").get(req.params.id);
  if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
  if (payment.status === 'success') return res.json({ success: true, message: 'Already confirmed' });

  db.prepare('UPDATE payments SET status=? WHERE id=?').run('success', payment.id);
  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(payment.coins_bought, payment.user_id);
  db.prepare(`INSERT INTO transactions (id,user_id,type,amount,naira_value,description,ref,status) VALUES (?,?,'buy',?,?,?,?,?)`)
    .run(uuid(), payment.user_id, payment.coins_bought, payment.amount_ngn, `Bank transfer confirmed - ${payment.coins_bought} coins`, payment.ref, 'success');

  const user = db.prepare('SELECT name, balance FROM users WHERE id=?').get(payment.user_id);
  res.json({ success: true, message: `Credited ${payment.coins_bought} coins to ${user.name}`, new_balance: user.balance });
});

router.post('/bank-payments/:id/reject', adminAuth, (req, res) => {
  db.prepare("UPDATE payments SET status='failed' WHERE id=?").run(req.params.id);
  res.json({ success: true, message: 'Payment rejected' });
});

router.get('/users', adminAuth, (req, res) => {
  const users = db.prepare('SELECT id,name,email,phone,balance,streak,role,created_at FROM users ORDER BY created_at DESC LIMIT 50').all();
  res.json({ success: true, users });
});

router.post('/credit', adminAuth, (req, res) => {
  const { user_id, coins, reason } = req.body;
  if (!user_id || !coins || coins <= 0)
    return res.status(400).json({ success: false, message: 'user_id and coins required' });

  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(coins, user_id);
  db.prepare(`INSERT INTO transactions (id,user_id,type,amount,description,ref,status) VALUES (?,?,'earn',?,?,?,?)`)
    .run(uuid(), user_id, coins, reason || 'Admin credit', `ADMIN-${uuid()}`, 'success');

  const user = db.prepare('SELECT name, balance FROM users WHERE id=?').get(user_id);
  res.json({ success: true, message: `Credited ${coins} to ${user.name}`, new_balance: user.balance });
});

router.get('/earnings', adminAuth, (req, res) => {
  const earnings = db.prepare("SELECT source, SUM(amount_ngn) as total_ngn, SUM(coins) as total_coins FROM platform_earnings GROUP BY source").all();
  res.json({ success: true, earnings });
});

router.get('/queued-redemptions', adminAuth, (req, res) => {
  const items = db.prepare(`
    SELECT r.*, u.name, u.email FROM redemptions r
    JOIN users u ON r.user_id = u.id
    WHERE r.status IN ('queued','pending') ORDER BY r.created_at ASC
  `).all();
  res.json({ success: true, items });
});

router.post('/queued-redemptions/:id/complete', adminAuth, (req, res) => {
  db.prepare("UPDATE redemptions SET status='success' WHERE id=?").run(req.params.id);
  res.json({ success: true, message: 'Marked as completed' });
});

module.exports = router;
