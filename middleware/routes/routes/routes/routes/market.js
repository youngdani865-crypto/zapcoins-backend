const router  = require('express').Router();
const { v4: uuid } = require('uuid');
const db      = require('../config/database');
const { auth } = require('../middleware/auth');

const TRADE_FEE_PCT = 0.05;
const STAKE_PLANS = [
  { id: 'flex',   label: 'Flex (3 days)',   days: 3,  rate: 2.0 },
  { id: 'silver', label: 'Silver (7 days)', days: 7,  rate: 3.5 },
  { id: 'gold',   label: 'Gold (14 days)',  days: 14, rate: 5.0 },
  { id: 'vip',    label: 'VIP (30 days)',   days: 30, rate: 8.0 },
];

router.get('/price', (req, res) => {
  const price = db.prepare('SELECT * FROM coin_price ORDER BY id DESC LIMIT 1').get();
  const history = db.prepare('SELECT price_ngn, created_at FROM coin_price ORDER BY id DESC LIMIT 10').all();
  res.json({ success: true, price_ngn: price.price_ngn, history });
});

router.get('/orders', auth, (req, res) => {
  const orders = db.prepare(`
    SELECT o.*, u.name as seller_name
    FROM market_orders o JOIN users u ON o.seller_id = u.id
    WHERE o.status='open' AND o.seller_id != ?
    ORDER BY o.price_ngn ASC
  `).all(req.user.id);
  res.json({ success: true, orders });
});

router.post('/sell', auth, (req, res) => {
  try {
    const { coins, price_ngn } = req.body;
    if (!coins || coins < 100) return res.status(400).json({ success: false, message: 'Minimum 100 coins to sell' });
    if (!price_ngn || price_ngn <= 0) return res.status(400).json({ success: false, message: 'Invalid price' });

    const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
    if (user.balance < coins) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(coins, req.user.id);

    const id       = uuid();
    const total    = parseFloat((coins * price_ngn).toFixed(2));
    const fee      = Math.ceil(coins * TRADE_FEE_PCT);
    const netCoins = coins - fee;

    db.prepare(`INSERT INTO market_orders (id,seller_id,coins,price_ngn,total_ngn,fee_coins,status)
      VALUES (?,?,?,?,?,?,'open')`)
      .run(id, req.user.id, coins, price_ngn, total, fee);

    db.prepare(`INSERT INTO platform_earnings (source, amount_ngn, coins) VALUES ('trade_fee',?,?)`)
      .run(fee * price_ngn, fee);

    res.json({ success: true, order_id: id, coins_locked: coins, fee_coins: fee, net_coins: netCoins, total_ngn: total });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/buy/:orderId', auth, (req, res) => {
  try {
    const order = db.prepare('SELECT * FROM market_orders WHERE id=? AND status=?').get(req.params.orderId, 'open');
    if (!order) return res.status(404).json({ success: false, message: 'Order not found or filled' });
    if (order.seller_id === req.user.id) return res.status(400).json({ success: false, message: 'Cannot buy your own order' });

    const coinsToReceive = order.coins - order.fee_coins;

    const buyTx = db.transaction(() => {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(coinsToReceive, req.user.id);
      db.prepare(`UPDATE market_orders SET status='filled', buyer_id=?, filled_at=datetime('now') WHERE id=?`)
        .run(req.user.id, order.id);
      db.prepare(`INSERT INTO transactions (id,user_id,type,amount,naira_value,description,ref,status) VALUES (?,?,'trade',?,?,?,?,?)`)
        .run(uuid(), req.user.id, coinsToReceive, order.total_ngn, `Bought ${coinsToReceive} coins from market`, `BUY-${order.id}`, 'success');
      db.prepare(`INSERT INTO transactions (id,user_id,type,amount,naira_value,description,ref,status) VALUES (?,?,'trade',?,?,?,?,?)`)
        .run(uuid(), order.seller_id, order.coins, order.total_ngn, `Sold ${order.coins} coins on market`, `SELL-${order.id}`, 'success');
    });
    buyTx();

    const buyer = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
    res.json({ success: true, coins_received: coinsToReceive, new_balance: buyer.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/cancel/:orderId', auth, (req, res) => {
  const order = db.prepare('SELECT * FROM market_orders WHERE id=? AND seller_id=? AND status=?')
    .get(req.params.orderId, req.user.id, 'open');
  if (!order) return res.status(404).json({ success: false, message: 'Order not found' });

  db.prepare('UPDATE market_orders SET status=? WHERE id=?').run('cancelled', order.id);
  db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(order.coins, req.user.id);
  res.json({ success: true, coins_returned: order.coins });
});

router.get('/convert/:coins', (req, res) => {
  const price = db.prepare('SELECT price_ngn FROM coin_price ORDER BY id DESC LIMIT 1').get();
  const naira = (req.params.coins * price.price_ngn).toFixed(2);
  res.json({ success: true, coins: parseInt(req.params.coins), naira_value: parseFloat(naira) });
});

router.get('/stake/plans', (req, res) => {
  res.json({ success: true, plans: STAKE_PLANS });
});

router.post('/stake', auth, (req, res) => {
  try {
    const { coins, plan_id } = req.body;
    const plan = STAKE_PLANS.find(p => p.id === plan_id);
    if (!plan) return res.status(400).json({ success: false, message: 'Invalid plan' });
    if (!coins || coins < 500) return res.status(400).json({ success: false, message: 'Minimum 500 coins to stake' });

    const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
    if (user.balance < coins) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    const endsAt = new Date();
    endsAt.setDate(endsAt.getDate() + plan.days);

    db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(coins, req.user.id);
    const id = uuid();
    db.prepare(`INSERT INTO stakes (id,user_id,coins,rate_pct,duration_days,status,ends_at)
      VALUES (?,?,?,?,?,'active',?)`)
      .run(id, req.user.id, coins, plan.rate, plan.days, endsAt.toISOString());

    const totalReward = Math.floor(coins * (plan.rate / 100) * plan.days);
    res.json({
      success:      true,
      stake_id:     id,
      coins_staked: coins,
      plan:         plan.label,
      daily_rate:   `${plan.rate}%`,
      est_reward:   totalReward,
      ends_at:      endsAt.toISOString()
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/stake/mine', auth, (req, res) => {
  const stakes = db.prepare('SELECT * FROM stakes WHERE user_id=? ORDER BY started_at DESC').all(req.user.id);
  res.json({ success: true, stakes });
});

router.get('/my-orders', auth, (req, res) => {
  const orders = db.prepare('SELECT * FROM market_orders WHERE seller_id=? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  res.json({ success: true, orders });
});

module.exports = router;
