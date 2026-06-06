const router  = require('express').Router();
const axios   = require('axios');
const { v4: uuid } = require('uuid');
const db      = require('../config/database');
const { auth } = require('../middleware/auth');

const VT_URL     = 'https://vtpass.com/api';
const VT_HEADERS = {
  'api-key':    process.env.VTPASS_API_KEY,
  'secret-key': process.env.VTPASS_SECRET_KEY,
  'Content-Type': 'application/json'
};

const MIN_COINS = { data: 500, airtime: 300 };

const MTN_DATA_PLANS = [
  { id: 'mtn-100mb-1day',  label: '100MB (1 day)',   coins: 500,  naira: 250  },
  { id: 'mtn-200mb-3day',  label: '200MB (3 days)',  coins: 900,  naira: 450  },
  { id: 'mtn-500mb-30day', label: '500MB (30 days)', coins: 1800, naira: 900  },
  { id: 'mtn-1gb-30day',   label: '1GB (30 days)',   coins: 3000, naira: 1500 },
  { id: 'mtn-2gb-30day',   label: '2GB (30 days)',   coins: 5000, naira: 2500 },
  { id: 'mtn-5gb-30day',   label: '5GB (30 days)',   coins: 9000, naira: 4500 },
];

function coinsToNaira(coins) {
  const price = db.prepare('SELECT price_ngn FROM coin_price ORDER BY id DESC LIMIT 1').get();
  return parseFloat((coins * price.price_ngn).toFixed(2));
}

router.get('/plans', auth, (req, res) => {
  res.json({
    success: true,
    minimums: MIN_COINS,
    data_plans: MTN_DATA_PLANS,
    airtime: { min_coins: MIN_COINS.airtime, note: 'Every 300 coins = ₦150 airtime' }
  });
});

router.post('/airtime', auth, async (req, res) => {
  try {
    const { phone, coins } = req.body;
    if (!phone || !/^(0[789][01]\d{8})$/.test(phone))
      return res.status(400).json({ success: false, message: 'Invalid MTN number' });
    if (!coins || coins < MIN_COINS.airtime)
      return res.status(400).json({ success: false, message: `Minimum ${MIN_COINS.airtime} coins for airtime` });

    const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
    if (user.balance < coins) return res.status(400).json({ success: false, message: 'Insufficient balance' });

    const nairaValue = coinsToNaira(coins);
    const ref        = `ZAP-AIRTIME-${uuid()}`;

    db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(coins, req.user.id);

    const redemptionId = uuid();
    db.prepare(`INSERT INTO redemptions (id,user_id,type,phone,network,coins,naira_value,status,provider_ref)
      VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(redemptionId, req.user.id, 'airtime', phone, 'MTN', coins, nairaValue, 'processing', ref);

    try {
      const vtRes = await axios.post(`${VT_URL}/pay`, {
        request_id:   ref,
        serviceID:    'mtn',
        amount:       nairaValue,
        phone,
        billersCode:  phone,
        variation_code: 'prepaid'
      }, { headers: VT_HEADERS });

      const vtStatus = vtRes.data?.content?.transactions?.status;
      const success  = vtStatus === 'delivered';

      db.prepare('UPDATE redemptions SET status=?, provider_ref=? WHERE id=?')
        .run(success ? 'success' : 'failed', vtRes.data?.requestId || ref, redemptionId);

      if (!success) {
        db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(coins, req.user.id);
        return res.status(400).json({ success: false, message: 'Airtime delivery failed. Coins refunded.' });
      }
    } catch (vtErr) {
      db.prepare('UPDATE redemptions SET status=? WHERE id=?').run('queued', redemptionId);
    }

    db.prepare(`INSERT INTO transactions (id,user_id,type,amount,naira_value,description,ref,status) VALUES (?,?,'redeem',?,?,?,?,?)`)
      .run(uuid(), req.user.id, -coins, nairaValue, `MTN Airtime ₦${nairaValue} → ${phone}`, ref, 'success');

    const updated = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
    res.json({ success: true, airtime: nairaValue, phone, new_balance: updated.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/data', auth, async (req, res) => {
  try {
    const { phone, plan_id } = req.body;
    const plan = MTN_DATA_PLANS.find(p => p.id === plan_id);
    if (!plan) return res.status(400).json({ success: false, message: 'Invalid plan' });
    if (!phone || !/^(0[789][01]\d{8})$/.test(phone))
      return res.status(400).json({ success: false, message: 'Invalid MTN number' });

    const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
    if (user.balance < plan.coins) return res.status(400).json({ success: false, message: 'Insufficient coins' });

    const ref = `ZAP-DATA-${uuid()}`;
    db.prepare('UPDATE users SET balance = balance - ? WHERE id=?').run(plan.coins, req.user.id);

    const redemptionId = uuid();
    db.prepare(`INSERT INTO redemptions (id,user_id,type,phone,network,coins,naira_value,plan,status,provider_ref)
      VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(redemptionId, req.user.id, 'data', phone, 'MTN', plan.coins, plan.naira, plan.label, 'processing', ref);

    try {
      const vtRes = await axios.post(`${VT_URL}/pay`, {
        request_id:     ref,
        serviceID:      'mtn-data',
        billersCode:    phone,
        variation_code: plan_id,
        amount:         plan.naira,
        phone
      }, { headers: VT_HEADERS });

      const vtStatus = vtRes.data?.content?.transactions?.status;
      const success  = vtStatus === 'delivered';

      db.prepare('UPDATE redemptions SET status=? WHERE id=?').run(success ? 'success' : 'failed', redemptionId);

      if (!success) {
        db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(plan.coins, req.user.id);
        return res.status(400).json({ success: false, message: 'Data delivery failed. Coins refunded.' });
      }
    } catch {
      db.prepare('UPDATE redemptions SET status=? WHERE id=?').run('queued', redemptionId);
    }

    db.prepare(`INSERT INTO transactions (id,user_id,type,amount,naira_value,description,ref,status) VALUES (?,?,'redeem',?,?,?,?,?)`)
      .run(uuid(), req.user.id, -plan.coins, plan.naira, `MTN Data ${plan.label} → ${phone}`, ref, 'success');

    const updated = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
    res.json({ success: true, plan: plan.label, phone, coins_spent: plan.coins, new_balance: updated.balance });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/history', auth, (req, res) => {
  const history = db.prepare('SELECT * FROM redemptions WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  res.json({ success: true, history });
});

module.exports = router;
