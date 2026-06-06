const cron = require('node-cron');
const { v4: uuid } = require('uuid');
const db   = require('../config/database');

function payStakingRewards() {
  console.log('⚙️  [CRON] Paying staking rewards...');
  const activeStakes = db.prepare("SELECT * FROM stakes WHERE status='active'").all();

  for (const stake of activeStakes) {
    const dailyReward = Math.floor(stake.coins * (stake.rate_pct / 100));
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(dailyReward, stake.user_id);
    db.prepare('UPDATE stakes SET earned = earned + ? WHERE id=?').run(dailyReward, stake.id);
    db.prepare(`INSERT INTO transactions (id,user_id,type,amount,description,ref,status) VALUES (?,?,'earn',?,?,?,?)`)
      .run(uuid(), stake.user_id, dailyReward, `Staking reward (${stake.rate_pct}% daily)`, `STAKE-${stake.id}-${Date.now()}`, 'success');

    if (new Date() >= new Date(stake.ends_at)) {
      db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(stake.coins, stake.user_id);
      db.prepare("UPDATE stakes SET status='completed' WHERE id=?").run(stake.id);
      db.prepare(`INSERT INTO transactions (id,user_id,type,amount,description,ref,status) VALUES (?,?,'earn',?,?,?,?)`)
        .run(uuid(), stake.user_id, stake.coins, `Staking principal returned`, `STAKE-RETURN-${stake.id}`, 'success');
      console.log(`✅ Stake ${stake.id} completed for user ${stake.user_id}`);
    }
  }
  console.log(`✅ Paid rewards for ${activeStakes.length} stakes`);
}

function checkStreaks() {
  console.log('⚙️  [CRON] Checking streaks...');
  const broken = db.prepare(`
    UPDATE users SET streak=0
    WHERE last_login IS NOT NULL
    AND julianday('now') - julianday(last_login) >= 2
    AND streak > 0
  `).run();
  console.log(`✅ Reset streaks for ${broken.changes} users`);
}

function cancelStaleOrders() {
  console.log('⚙️  [CRON] Cancelling stale market orders...');
  const stale = db.prepare(`
    SELECT * FROM market_orders
    WHERE status='open' AND julianday('now') - julianday(created_at) > 7
  `).all();

  for (const order of stale) {
    db.prepare("UPDATE market_orders SET status='cancelled' WHERE id=?").run(order.id);
    db.prepare('UPDATE users SET balance = balance + ? WHERE id=?').run(order.coins, order.seller_id);
    console.log(`↩️  Refunded ${order.coins} coins to seller ${order.seller_id}`);
  }
  console.log(`✅ Cancelled ${stale.length} stale orders`);
}

function flashMarketEvent() {
  const rand     = Math.floor(Math.random() * 10) + 10;
  const current  = db.prepare('SELECT price_ngn FROM coin_price ORDER BY id DESC LIMIT 1').get();
  const newPrice = parseFloat((current.price_ngn * (1 + rand / 100)).toFixed(4));
  db.prepare('INSERT INTO coin_price (price_ngn, set_by) VALUES (?,?)').run(newPrice, 'system-flash');
  console.log(`⚡ [FLASH EVENT] Coin price boosted ${rand}% → ₦${newPrice}`);

  setTimeout(() => {
    db.prepare('INSERT INTO coin_price (price_ngn, set_by) VALUES (?,?)').run(current.price_ngn, 'system-revert');
    console.log(`↩️  [FLASH EVENT] Price reverted to ₦${current.price_ngn}`);
  }, 2 * 60 * 60 * 1000);
}

function retryQueuedRedemptions() {
  const queued = db.prepare("SELECT COUNT(*) as c FROM redemptions WHERE status='queued'").get().c;
  if (queued > 0) console.log(`⚠️  [ALERT] ${queued} redemptions still queued - manual action needed`);
}

function startAll() {
  cron.schedule('0 0 * * *', payStakingRewards);
  cron.schedule('5 0 * * *', checkStreaks);
  cron.schedule('0 */6 * * *', cancelStaleOrders);
  cron.schedule('0 3,9,15,21 * * *', flashMarketEvent);
  cron.schedule('*/30 * * * *', retryQueuedRedemptions);

  console.log('✅ All cron jobs started');
}

module.exports = { startAll, payStakingRewards, checkStreaks, cancelStaleOrders };
