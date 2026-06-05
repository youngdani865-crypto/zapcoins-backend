const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const app = express();
app.use(cors());
app.use(express.json());

const DB = { users: {}, sessions: {}, transactions: [], redemptions: [] };

function generateId() { return crypto.randomBytes(8).toString('hex'); }
function generateToken() { return crypto.randomBytes(32).toString('hex'); }

function auth(req, res, next) {
  const token = req.headers['authorization']?.replace('Bearer ', '');
  if (!token || !DB.sessions[token]) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = DB.sessions[token];
  req.user = DB.users[req.userId];
  next();
}

const PACKAGES = [
  { id: 'starter', coins: 200, price: 150 },
  { id: 'popular', coins: 600, price: 400 },
  { id: 'medium', coins: 1500, price: 1200 },
  { id: 'big', coins: 4000, price: 3000 },
];

app.post('/auth/signup', (req, res) => {
  const { name, phone } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Name and phone required' });
  const existing = Object.values(DB.users).find(u => u.phone === phone);
  if (existing) return res.status(400).json({ error: 'Phone already registered' });
  const userId = generateId();
  const token = generateToken();
  DB.users[userId] = { id: userId, name, phone, coins: 100, totalEarned: 100, totalSpent: 0, streak: 1, lastLogin: new Date().toDateString(), joinedAt: new Date().toISOString(), ad1WatchedToday: false, ad2WatchedToday: false };
  DB.sessions[token] = userId;
  DB.transactions.push({ id: generateId(), userId, type: 'EARN', coins: 100, item: 'Welcome Bonus', timestamp: new Date().toISOString() });
  res.json({ success: true, token, user: DB.users[userId], message: `Welcome ${name}! You got 100 free coins!` });
});

app.post('/auth/login', (req, res) => {
  const { phone } = req.body;
  const user = Object.values(DB.users).find(u => u.phone === phone);
  if (!user) return res.status(404).json({ error: 'Account not found. Please sign up.' });
  const token = generateToken();
  DB.sessions[token] = user.id;
  const today = new Date().toDateString();
  let bonusCoins = 0;
  if (user.lastLogin !== today) {
    bonusCoins = 10;
    user.coins += bonusCoins;
    user.totalEarned += bonusCoins;
    user.streak += 1;
    user.lastLogin = today;
    user.ad1WatchedToday = false;
    user.ad2WatchedToday = false;
    if (user.streak % 30 === 0) { user.coins += 200; user.totalEarned += 200; bonusCoins += 200; }
    DB.transactions.push({ id: generateId(), userId: user.id, type: 'EARN', coins: bonusCoins, item: 'Daily Login', timestamp: new Date().toISOString() });
  }
  res.json({ success: true, token, user, bonusCoins });
});

app.get('/user/me', auth, (req, res) => res.json({ success: true, user: req.user }));

app.post('/earn/ad', auth, (req, res) => {
  const { adNumber } = req.body;
  const user = req.user;
  if (adNumber === 1 && user.ad1WatchedToday) return res.status(400).json({ error: 'Already watched Ad 1 today' });
  if (adNumber === 2 && user.ad2WatchedToday) return res.status(400).json({ error: 'Already watched Ad 2 today' });
  user.coins += 50; user.totalEarned += 50;
  if (adNumber === 1) user.ad1WatchedToday = true;
  if (adNumber === 2) user.ad2WatchedToday = true;
  DB.transactions.push({ id: generateId(), userId: user.id, type: 'EARN', coins: 50, item: `Ad ${adNumber}`, timestamp: new Date().toISOString() });
  res.json({ success: true, coinsEarned: 50, newBalance: user.coins });
});

app.post('/redeem/request', auth, (req, res) => {
  const { itemName, category, coins, vtpassCost, phone } = req.body;
  const user = req.user;
  if (category === 'data' && coins < 500) return res.status(400).json({ error: 'Minimum 500 coins for data' });
  if (category === 'airtime' && coins < 300) return res.status(400).json({ error: 'Minimum 300 coins for airtime' });
  if (user.coins < coins) return res.status(400).json({ error: `Need ${coins - user.coins} more coins` });
  user.coins -= coins; user.totalSpent += coins;
  const redemption = { id: generateId(), userId: user.id, userName: user.name, userPhone: user.phone, targetPhone: phone || user.phone, itemName, category, coinsSpent: coins, vtpassCost, profit: (coins * 0.5) - vtpassCost, status: 'PENDING', requestedAt: new Date().toISOString() };
  DB.redemptions.push(redemption);
  DB.transactions.push({ id: generateId(), userId: user.id, type: 'SPEND', coins, item: itemName, timestamp: new Date().toISOString() });
  res.json({ success: true, redemption, newBalance: user.coins, message: `${itemName} request submitted! Coming in 5 minutes.` });
});

app.get('/packages', (req, res) => res.json({ success: true, packages: PACKAGES }));

const ADMIN_KEY = process.env.ADMIN_KEY || 'zapcoins-admin-2026';
function adminAuth(req, res, next) {
  if (req.headers['x-admin-key'] !== ADMIN_KEY) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.get('/admin/users', adminAuth, (req, res) => res.json({ success: true, totalUsers: Object.keys(DB.users).length, users: Object.values(DB.users) }));
app.get('/admin/redemptions', adminAuth, (req, res) => {
  const pending = DB.redemptions.filter(r => r.status === 'PENDING');
  const done = DB.redemptions.filter(r => r.status === 'DONE');
  res.json({ success: true, pending, done, totalProfit: done.reduce((s, r) => s + r.profit, 0) });
});
app.post('/admin/fulfill', adminAuth, (req, res) => {
  const r = DB.redemptions.find(r => r.id === req.body.redemptionId);
  if (!r) return res.status(404).json({ error: 'Not found' });
  r.status = 'DONE'; r.fulfilledAt = new Date().toISOString();
  res.json({ success: true, message: 'Order marked done', redemption: r });
});
app.get('/admin/stats', adminAuth, (req, res) => {
  const users = Object.values(DB.users);
  res.json({ success: true, stats: { totalUsers: users.length, totalTransactions: DB.transactions.length, pendingRedemptions: DB.redemptions.filter(r => r.status === 'PENDING').length, totalProfit: DB.redemptions.filter(r => r.status === 'DONE').reduce((s, r) => s + r.profit, 0) } });
});

app.get('/', (req, res) => res.json({ status: 'ZapCoins Backend Running!', users: Object.keys(DB.users).length }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ZapCoins Backend running on port ${PORT}`));
