const router  = require('express').Router();
const crypto  = require('crypto');
const { v4: uuid } = require('uuid');
const db      = require('../config/database');

router.post('/paystack', (req, res) => {
  try {
    const hash = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY)
      .update(JSON.stringify(req.body)).digest('hex');

    if (hash !== req.headers['x-paystack-signature'])
      return res.status(400).json({ message: 'Invalid signature' });

    const event = req.body;
    if (event.event === 'charge.success') {
      const ref     = event.data.reference;
      const payment = db.prepare("SELECT * FROM payments WHERE ref=? AND status='pending'").get(ref);
      if (payment) {
        db.prepare("UPDATE payments SET status='success' WHERE ref=?").run(ref);
        db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(payment.coins_bought, payment.user_id);
        db.prepare(`INSERT INTO transactions (id,user_id,type,amount,naira_value,description,ref,status) VALUES (?,?,'buy',?,?,?,?,?)`)
          .run(uuid(), payment.user_id, payment.coins_bought, payment.amount_ngn,
            `Bought ${payment.coins_bought} coins (Paystack)`, ref, 'success');
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Paystack webhook error:', err.message);
    res.sendStatus(500);
  }
});

router.post('/flutterwave', (req, res) => {
  try {
    const secretHash = process.env.FLW_WEBHOOK_SECRET;
    const signature  = req.headers['verif-hash'];
    if (!signature || signature !== secretHash)
      return res.status(400).json({ message: 'Invalid signature' });

    const event = req.body;
    if (event.event === 'charge.completed' && event.data.status === 'successful') {
      const ref     = event.data.tx_ref;
      const payment = db.prepare("SELECT * FROM payments WHERE ref=? AND status='pending'").get(ref);
      if (payment) {
        db.prepare("UPDATE payments SET status='success' WHERE ref=?").run(ref);
        db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(payment.coins_bought, payment.user_id);
        db.prepare(`INSERT INTO transactions (id,user_id,type,amount,naira_value,description,ref,status) VALUES (?,?,'buy',?,?,?,?,?)`)
          .run(uuid(), payment.user_id, payment.coins_bought, payment.amount_ngn,
            `Bought ${payment.coins_bought} coins (Flutterwave)`, ref, 'success');
      }
    }
    res.sendStatus(200);
  } catch (err) {
    console.error('Flutterwave webhook error:', err.message);
    res.sendStatus(500);
  }
});

module.exports = router;
