const router  = require('express').Router();
const axios   = require('axios');
const { v4: uuid } = require('uuid');
const db      = require('../config/database');
const { auth } = require('../middleware/auth');

const PAYSTACK_SK  = process.env.PAYSTACK_SECRET_KEY;
const FLW_SK       = process.env.FLUTTERWAVE_SECRET_KEY;
const ADMIN_BANK   = { bank: process.env.ADMIN_BANK_NAME, account: process.env.ADMIN_BANK_ACCOUNT, name: process.env.ADMIN_BANK_HOLDER };

function calcCoins(naira) {
  const price = db.prepare('SELECT price_ngn FROM coin_price ORDER BY id DESC LIMIT 1').get();
  return Math.floor(naira / price.price_ngn);
}

router.post('/paystack/initiate', auth, async (req, res) => {
  try {
    const { amount_ngn } = req.body;
    if (!amount_ngn || amount_ngn < 100)
      return res.status(400).json({ success: false, message: 'Minimum ₦100' });

    const ref = `ZAP-PS-${uuid()}`;
    const response = await axios.post('https://api.paystack.co/transaction/initialize', {
      email:     req.user.email,
      amount:    amount_ngn * 100,
      reference: ref,
      callback_url: `${process.env.FRONTEND_URL}/payment/verify`,
      metadata:  { user_id: req.user.id, coins: calcCoins(amount_ngn) }
    }, { headers: { Authorization: `Bearer ${PAYSTACK_SK}` } });

    db.prepare(`INSERT INTO payments (id,user_id,provider,ref,amount_ngn,coins_bought,status)
      VALUES (?,?,?,?,?,?,?)`)
      .run(uuid(), req.user.id, 'paystack', ref, amount_ngn, calcCoins(amount_ngn), 'pending');

    res.json({ success: true, url: response.data.data.authorization_url, ref });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/paystack/verify/:ref', auth, async (req, res) => {
  try {
    const { ref } = req.params;
    const payment = db.prepare('SELECT * FROM payments WHERE ref=? AND user_id=?').get(ref, req.user.id);
    if (!payment) return res.status(404).json({ success: false, message: 'Payment not found' });
    if (payment.status === 'success') return res.json({ success: true, message: 'Already verified' });

    const response = await axios.get(`https://api.paystack.co/transaction/verify/${ref}`,
      { headers: { Authorization: `Bearer ${PAYSTACK_SK}` } });

    if (response.data.data.status === 'success') {
      const coins = payment.coins_bought;
      db.prepare('UPDATE payments SET status=? WHERE ref=?').run('success', ref);
      db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(coins, req.user.id);
      db.prepare(`INSERT INTO transactions (id,user_id,type,amount,naira_value,description,ref,status)
        VALUES (?,?,'buy',?,?,?,?,?)`)
        .run(uuid(), req.user.id, coins, payment.amount_ngn, `Bought ${coins} coins via Paystack`, ref, 'success');

      const user = db.prepare('SELECT balance FROM users WHERE id=?').get(req.user.id);
      return res.json({ success: true, coins_added: coins, new_balance: user.balance });
    }

    res.json({ success: false, message: 'Payment not completed' });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/flutterwave/initiate', auth, async (req, res) => {
  try {
    const { amount_ngn } = req.body;
    if (!amount_ngn || amount_ngn < 100)
      return res.status(400).json({ success: false, message: 'Minimum ₦100' });

    const ref = `ZAP-FLW-${uuid()}`;
    const response = await axios.post('https://api.flutterwave.com/v3/payments', {
      tx_ref:       ref,
      amount:       amount_ngn,
      currency:     'NGN',
      redirect_url: `${process.env.FRONTEND_URL}/payment/verify`,
      customer:     { email: req.user.email, name: req.user.name, phonenumber: req.user.phone },
      customizations: { title: 'Buy Zapcoins', logo: process.env.FRONTEND_URL + '/logo.png' },
      meta:         { user_id: req.user.id }
    }, { headers: { Authorization: `Bearer ${FLW_SK}` } });

    db.prepare(`INSERT INTO payments (id,user_id,provider,ref,amount_ngn,coins_bought,status)
      VALUES (?,?,?,?,?,?,?)`)
      .run(uuid(), req.user.id, 'flutterwave', ref, amount_ngn, calcCoins(amount_ngn), 'pending');

    res.json({ success: true, url: response.data.data.link, ref });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.post('/bank/initiate', auth, (req, res) => {
  try {
    const { amount_ngn } = req.body;
    if (!amount_ngn || amount_ngn < 100)
      return res.status(400).json({ success: false, message: 'Minimum ₦100' });

    const ref = `ZAP-BNK-${uuid()}`;
    db.prepare(`INSERT INTO payments (id,user_id,provider,ref,amount_ngn,coins_bought,status,metadata)
      VALUES (?,?,?,?,?,?,?,?)`)
      .run(uuid(), req.user.id, 'bank', ref, amount_ngn, calcCoins(amount_ngn), 'pending',
        JSON.stringify({ note: 'Awaiting admin confirmation' }));

    res.json({
      success: true,
      ref,
      coins_to_receive: calcCoins(amount_ngn),
      bank_details: {
        bank:    ADMIN_BANK.bank,
        account: ADMIN_BANK.account,
        name:    ADMIN_BANK.name,
        amount:  amount_ngn,
        narration: `ZAPCOIN-${ref}`
      },
      message: 'Transfer the exact amount and use the narration. Coins credited after confirmation.'
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

router.get('/history', auth, (req, res) => {
  const payments = db.prepare('SELECT * FROM payments WHERE user_id=? ORDER BY created_at DESC LIMIT 20').all(req.user.id);
  res.json({ success: true, payments });
});

module.exports = router;
