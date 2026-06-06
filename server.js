const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
require('dotenv').config();

const app = express();

app.use(helmet());
app.use(cors({ origin: process.env.FRONTEND_URL || '*' }));
app.use(express.json());

const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
app.use(limiter);

app.use('/api/auth',    require('./routes/auth'));
app.use('/api/coins',   require('./routes/coins'));
app.use('/api/payment', require('./routes/payment'));
app.use('/api/market',  require('./routes/market'));
app.use('/api/redeem',  require('./routes/redeem'));
app.use('/api/admin',   require('./routes/admin'));
app.use('/api/webhook', require('./routes/webhook'));

app.get('/health', (req, res) => res.json({ status: 'ok', time: new Date() }));

const cronJobs = require('./services/cronJobs');
cronJobs.startAll();

app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(err.status || 500).json({ success: false, message: err.message || 'Server error' });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Zapcoin backend running on port ${PORT}`));

module.exports = app;
