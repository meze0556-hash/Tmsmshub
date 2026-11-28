require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const FIVESIM_API_KEY = process.env.FIVESIM_API_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const RUB_TO_NGN = Number(process.env.RUB_TO_NGN || 18);
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@tmsmshub.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'CHANGE_ME_LATER';
const DATA_FILE = path.join(__dirname, 'data.json');

function loadDB() {
  try { if (fs.existsSync(DATA_FILE)) return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (_) {}
  return { users: [], sessions: {}, adminSessions: {}, adminSettings: { minFunding: 500, marginType: 'ngn', marginValue: 0, beepEnabled: true }, promoCodes: [], reports: [], countryRatings: {}, usedPaystackRefs: [] };
}
let db = loadDB();
function saveDB() { try { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2)); } catch (_) {} }

function hashPw(pw) { const s = crypto.randomBytes(16).toString('hex'); return `${s}:${crypto.scryptSync(pw, s, 64).toString('hex')}`; }
function verifyPw(pw, st) { const [s, h] = String(st || '').split(':'); return !!(s && h && crypto.scryptSync(pw, s, 64).toString('hex') === h); }
function safeUser(u) { return { name: u.name, email: u.email, balance: u.balance, referralCode: u.referralCode, referralsCount: u.referralsCount || 0, blocked: !!u.blocked, transactions: u.transactions || [], orders: u.orders || [] }; }

function requireUser(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  const email = db.sessions[token];
  const user = email && db.users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!user) return res.status(401).json({ error: 'Please sign in first.' });
  if (user.blocked) return res.status(403).json({ error: 'Your account is blocked.' });
  req.user = user; next();
}
function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!db.adminSessions[token]) return res.status(401).json({ error: 'Admin authorization required.' });
  next();
}

async function call5sim(endpoint, auth = true) {
  if (auth && !FIVESIM_API_KEY) return { ok: false, status: 500, error: 'FIVESIM_API_KEY environment variable is not set on server.' };
  const headers = { Accept: 'application/json' };
  if (auth) headers.Authorization = `Bearer ${FIVESIM_API_KEY}`;
  try {
    const res = await fetch(`https://5sim.net/v1/${endpoint}`, { headers });
    const raw = await res.text();
    let data = null; try { data = JSON.parse(raw); } catch (_) {}
    if (!res.ok || !data || typeof data === 'string') return { ok: false, status: res.status || 400, error: (data && (data.message || data.error)) || raw || `5sim error (${res.status})` };
    return { ok: true, status: 200, data };
  } catch (err) {
    return { ok: false, status: 502, error: `5sim network error: ${err.message}` };
  }
}

app.get('/api/config', (req, res) => res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY, rubToNgn: RUB_TO_NGN, adminSettings: db.adminSettings, promoCodes: db.promoCodes, countryRatings: db.countryRatings }));

app.post('/api/signup', (req, res) => {
  const { name, email, password, referralCode } = req.body || {};
  if (!email || !password || password.length < 6) return res.status(400).json({ error: 'Valid email and password (min 6 chars) required.' });
  const em = String(email).trim().toLowerCase();
  if (db.users.some(u => u.email.toLowerCase() === em)) return res.status(400).json({ error: 'Email already exists. Please Sign In.' });
  const refIn = String(referralCode || '').trim().toUpperCase();
  const refUser = refIn ? db.users.find(u => u.referralCode.toUpperCase() === refIn) : null;
  if (refIn && !refUser) return res.status(400).json({ error: 'Invalid referral code.' });

  const nu = { name: String(name || em.split('@')[0]).trim(), email: em, passwordHash: hashPw(password), balance: refUser ? 100 : 0, referralCode: `TM-${(em.split('@')[0].replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 3) || 'TM')}${Math.floor(100 + Math.random() * 899)}`, referralsCount: 0, blocked: false, transactions: [], orders: [] };
  if (refUser) {
    nu.transactions.unshift({ id: 'TX-RB-' + Date.now(), date: new Date().toLocaleString(), type: 'Fund', description: `Referral Bonus (${refUser.referralCode})`, amount: '+₦100', balanceAfter: 100 });
    refUser.balance += 100; refUser.referralsCount = (refUser.referralsCount || 0) + 1;
    refUser.transactions.unshift({ id: 'TX-RR-' + Date.now(), date: new Date().toLocaleString(), type: 'Fund', description: `Referral Reward (${em})`, amount: '+₦100', balanceAfter: refUser.balance });
  }
  const token = crypto.randomBytes(32).toString('hex');
  db.users.push(nu); db.sessions[token] = em; saveDB();
  res.json({ ok: true, token, user: safeUser(nu) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  const u = db.users.find(x => x.email.toLowerCase() === em);
  if (!u || !verifyPw(password, u.passwordHash)) return res.status(401).json({ error: 'Invalid email or password.' });
  if (u.blocked) return res.status(403).json({ error: 'Your account is blocked.' });
  const token = crypto.randomBytes(32).toString('hex');
  db.sessions[token] = u.email; saveDB();
  res.json({ ok: true, token, user: safeUser(u) });
});

app.get('/api/me', requireUser, (req, res) => res.json({ ok: true, user: safeUser(req.user) }));
app.post('/api/profile/name', requireUser, (req, res) => { const n = String(req.body?.name || '').trim(); if (!n) return res.status(400).json({ error: 'Name required.' }); req.user.name = n; saveDB(); res.json({ ok: true, user: safeUser(req.user) }); });

app.post('/api/paystack/verify', requireUser, async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'Missing Paystack reference.' });
  if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY not set on server.' });
  if (db.usedPaystackRefs.includes(reference)) return res.status(400).json({ error: 'Reference already used.' });
  try {
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, { headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` } });
    const d = await r.json();
    if (!r.ok || !d.status || d.data?.status !== 'success') return res.status(400).json({ error: d.message || 'Verification failed.' });
    const amt = Number(d.data.amount) / 100;
    db.usedPaystackRefs.push(reference); req.user.balance += amt;
    req.user.transactions.unshift({ id: reference, date: new Date().toLocaleString(), type: 'Fund', description: `Paystack (${reference})`, amount: `+₦${amt.toLocaleString('en-NG')}`, balanceAfter: req.user.balance });
    saveDB(); res.json({ ok: true, amountNGN: amt, user: safeUser(req.user) });
  } catch (err) { res.status(502).json({ error: err.message }); }
});

app.get('/api/5sim/prices', async (req, res) => {
  const r = await call5sim('guest/prices', false);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  res.json({ ok: true, rubToNgn: RUB_TO_NGN, prices: r.data });
});

app.post('/api/5sim/buy', requireUser, async (req, res) => {
  const { country, countryLabel, product, productLabel, flag, promoCode } = req.body || {};
  if (!country || !product) return res.status(400).json({ error: 'Country and product required.' });
  const r = await call5sim(`user/buy/activation/${encodeURIComponent(country)}/any/${encodeURIComponent(product)}`, true);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const d = r.data;
  if (!d.id || !d.phone) return res.status(400).json({ error: '5sim did not return a valid number.' });

  let priceNgn = Math.max(1, Math.ceil(Number(d.price || 0) * RUB_TO_NGN));
  const { marginType, marginValue } = db.adminSettings;
  priceNgn = marginType === 'percent' ? Math.max(1, Math.round(priceNgn + priceNgn * Number(marginValue || 0) / 100)) : Math.max(1, Math.round(priceNgn + Number(marginValue || 0)));
  if (promoCode) { const pr = db.promoCodes.find(p => p.code.toUpperCase() === String(promoCode).toUpperCase()); if (pr) priceNgn = Math.max(1, Math.round(priceNgn * (1 - pr.discountPct / 100))); }

  if (req.user.balance < priceNgn) {
    await call5sim(`user/cancel/${encodeURIComponent(d.id)}`, true).catch(() => {});
    return res.status(400).json({ error: `Insufficient balance. Required: ₦${priceNgn.toLocaleString('en-NG')}` });
  }
  req.user.balance -= priceNgn;
  const now = Date.now(), phone = d.phone.startsWith('+') ? d.phone : `+${d.phone}`;
  const order = { id: `ORD-${d.id}`, providerOrderId: d.id, date: new Date(now).toLocaleString(), createdAt: now, expiresAt: d.expires ? new Date(d.expires).getTime() : (now + 20 * 60 * 1000), app: productLabel || product, country: countryLabel || country, flag: flag || '🌍', number: phone, priceNum: priceNgn, status: 'Waiting for SMS', smsCode: null, smsReceivedAt: null, rated: false };
  req.user.orders.unshift(order);
  req.user.transactions.unshift({ id: `TX-${now}`, date: new Date(now).toLocaleString(), type: 'Buy', description: `${order.app} (${order.country})`, amount: `-₦${priceNgn.toLocaleString('en-NG')}`, balanceAfter: req.user.balance });
  saveDB(); res.json({ ok: true, order, user: safeUser(req.user) });
});

app.get('/api/5sim/check/:id', requireUser, async (req, res) => {
  const r = await call5sim(`user/check/${encodeURIComponent(req.params.id)}`, true);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  const order = req.user.orders.find(o => String(o.providerOrderId) === String(req.params.id));
  if (order && order.status === 'Waiting for SMS') {
    if (r.data.sms && r.data.sms.length > 0) { order.smsCode = r.data.sms[0].code || r.data.sms[0].text; order.smsReceivedAt = new Date().toLocaleTimeString(); order.status = 'Completed'; saveDB(); }
    else if (['TIMEOUT', 'CANCELED', 'BANNED'].includes(r.data.status)) { order.status = r.data.status === 'CANCELED' ? 'Cancelled' : 'Expired'; saveDB(); }
  }
  res.json({ ok: true, status: r.data.status, sms: r.data.sms || [], order });
});

app.post('/api/5sim/cancel/:id', requireUser, async (req, res) => {
  const order = req.user.orders.find(o => String(o.providerOrderId) === String(req.params.id));
  if (!order || order.status !== 'Waiting for SMS') return res.status(400).json({ error: 'Cannot cancel order.' });
  const r = await call5sim(`user/cancel/${encodeURIComponent(req.params.id)}`, true);
  if (!r.ok) return res.status(r.status).json({ error: r.error });
  order.status = 'Cancelled'; req.user.balance += Number(order.priceNum || 0);
  req.user.transactions.unshift({ id: `TX-REF-${Date.now()}`, date: new Date().toLocaleString(), type: 'Refund', description: `Cancelled: ${order.app}`, amount: `+₦${Number(order.priceNum).toLocaleString('en-NG')}`, balanceAfter: req.user.balance });
  saveDB(); res.json({ ok: true, order, user: safeUser(req.user) });
});

app.post('/api/orders/:id/rate', requireUser, (req, res) => {
  const o = req.user.orders.find(x => x.id === req.params.id), s = parseInt(req.body?.stars, 10);
  if (!o || isNaN(s) || s < 1 || s > 5) return res.status(400).json({ error: 'Invalid rating.' });
  if (!db.countryRatings[o.country]) db.countryRatings[o.country] = { sum: 0, count: 0 };
  db.countryRatings[o.country].sum += s; db.countryRatings[o.country].count += 1; o.rated = true; saveDB();
  res.json({ ok: true, countryRatings: db.countryRatings });
});

app.post('/api/reports', requireUser, (req, res) => {
  const { orderId, message } = req.body || {};
  if (!orderId || !message) return res.status(400).json({ error: 'Order ID and message required.' });
  const o = req.user.orders.find(x => x.id === orderId);
  db.reports.unshift({ id: `REP-${Date.now()}`, date: new Date().toLocaleString(), orderId, userEmail: req.user.email, details: o ? `${o.app} • ${o.country}` : 'Order', message: String(message).trim(), status: 'Open' });
  saveDB(); res.json({ ok: true });
});

app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body || {};
  if (String(email || '').trim().toLowerCase() === ADMIN_EMAIL.toLowerCase() && password === ADMIN_PASSWORD) {
    const token = crypto.randomBytes(32).toString('hex'); db.adminSessions[token] = true; saveDB(); return res.json({ ok: true, token });
  }
  res.status(401).json({ error: 'Invalid admin credentials.' });
});

app.get('/api/admin/dashboard', requireAdmin, async (req, res) => {
  const prof = await call5sim('user/profile', true);
  res.json({ ok: true, fivesimProfile: prof.ok ? { balance: prof.data.balance, email: prof.data.email } : { error: prof.error }, users: db.users.map(safeUser), adminSettings: db.adminSettings, promoCodes: db.promoCodes, reports: db.reports });
});
app.post('/api/admin/users/balance', requireAdmin, (req, res) => {
  const u = db.users.find(x => x.email.toLowerCase() === String(req.body?.email || '').toLowerCase()), amt = parseInt(req.body?.amount, 10);
  if (!u || isNaN(amt) || amt <= 0) return res.status(400).json({ error: 'Invalid request.' });
  u.balance += amt; u.transactions.unshift({ id: `TX-ADM-${Date.now()}`, date: new Date().toLocaleString(), type: 'Fund', description: 'Admin Manual Credit', amount: `+₦${amt.toLocaleString('en-NG')}`, balanceAfter: u.balance }); saveDB(); res.json({ ok: true });
});
app.post('/api/admin/users/block', requireAdmin, (req, res) => {
  const u = db.users.find(x => x.email.toLowerCase() === String(req.body?.email || '').toLowerCase());
  if (!u) return res.status(404).json({ error: 'User not found.' }); u.blocked = !u.blocked; saveDB(); res.json({ ok: true });
});
app.post('/api/admin/orders/refund', requireAdmin, (req, res) => {
  const u = db.users.find(x => x.email.toLowerCase() === String(req.body?.email || '').toLowerCase()), o = u?.orders?.find(x => x.id === req.body?.orderId);
  if (!o || o.status === 'Cancelled') return res.status(400).json({ error: 'Cannot refund.' });
  o.status = 'Cancelled'; u.balance += Number(o.priceNum || 0); u.transactions.unshift({ id: `TX-AR-${Date.now()}`, date: new Date().toLocaleString(), type: 'Refund', description: `Admin Refund: ${o.app}`, amount: `+₦${Number(o.priceNum).toLocaleString('en-NG')}`, balanceAfter: u.balance }); saveDB(); res.json({ ok: true });
});
app.post('/api/admin/settings', requireAdmin, (req, res) => {
  const { minFunding, marginType, marginValue } = req.body || {};
  if (minFunding !== undefined) db.adminSettings.minFunding = Math.max(0, Number(minFunding) || 0);
  if (marginType) db.adminSettings.marginType = marginType;
  if (marginValue !== undefined) db.adminSettings.marginValue = Math.max(0, Number(marginValue) || 0);
  saveDB(); res.json({ ok: true, adminSettings: db.adminSettings });
});
app.post('/api/admin/promos', requireAdmin, (req, res) => {
  const code = String(req.body?.code || '').trim().toUpperCase(), pct = parseInt(req.body?.discountPct, 10);
  if (!code || isNaN(pct) || pct < 1 || pct > 90) return res.status(400).json({ error: 'Invalid promo.' });
  db.promoCodes = db.promoCodes.filter(p => p.code !== code); db.promoCodes.push({ code, discountPct: pct }); saveDB(); res.json({ ok: true });
});
app.delete('/api/admin/promos/:code', requireAdmin, (req, res) => { db.promoCodes = db.promoCodes.filter(p => p.code !== req.params.code.toUpperCase()); saveDB(); res.json({ ok: true }); });
app.post('/api/admin/reports/:id/resolve', requireAdmin, (req, res) => { const r = db.reports.find(x => x.id === req.params.id); if (r) { r.status = 'Resolved'; saveDB(); } res.json({ ok: true }); });

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, () => console.log(`TMSMSHub running on port ${PORT}`));