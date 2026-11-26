require('dotenv').config();
const express = require('express');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const FIVESIM_API_KEY = process.env.FIVESIM_API_KEY || '';
const PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC_KEY = process.env.PAYSTACK_PUBLIC_KEY || '';
const RUB_TO_NGN = Number(process.env.RUB_TO_NGN || 18);

async function call5sim(endpoint, authRequired = true) {
  if (authRequired && !FIVESIM_API_KEY) {
    return { ok: false, status: 500, error: 'FIVESIM_API_KEY environment variable is not set on server.' };
  }
  const headers = { Accept: 'application/json' };
  if (authRequired) headers.Authorization = `Bearer ${FIVESIM_API_KEY}`;

  try {
    const res = await fetch(`https://5sim.net/v1/${endpoint}`, { headers });
    const raw = await res.text();
    let data = null;
    try { data = JSON.parse(raw); } catch (_) {}

    // 5sim sometimes returns HTTP 200 or 400 with plain text like "no free phones" or "not enough user balance"
    if (!res.ok || !data || typeof data === 'string') {
      const msg = (data && (data.message || data.error)) || raw || `5sim HTTP ${res.status}`;
      return { ok: false, status: res.status || 400, error: msg.trim() };
    }
    return { ok: true, status: 200, data };
  } catch (err) {
    return { ok: false, status: 502, error: `Network error reaching 5sim: ${err.message}` };
  }
}

// Public safe config (never exposes FIVESIM_API_KEY or PAYSTACK_SECRET_KEY)
app.get('/api/config', (req, res) => {
  res.json({ paystackPublicKey: PAYSTACK_PUBLIC_KEY, rubToNgn: RUB_TO_NGN });
});

// Live 5sim stock & prices
app.get('/api/5sim/prices', async (req, res) => {
  const result = await call5sim('guest/prices', false);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, rubToNgn: RUB_TO_NGN, prices: result.data });
});

// Real 5sim provider balance (for Admin)
app.get('/api/5sim/profile', async (req, res) => {
  const result = await call5sim('user/profile', true);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, balance: result.data.balance, email: result.data.email, rating: result.data.rating });
});

// 1. Buy real activation number on 5sim
app.post('/api/5sim/buy', async (req, res) => {
  const { country, product } = req.body || {};
  if (!country || !product) return res.status(400).json({ error: 'Country and product are required.' });

  const endpoint = `user/buy/activation/${encodeURIComponent(country)}/any/${encodeURIComponent(product)}`;
  const result = await call5sim(endpoint, true);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  const d = result.data;
  if (!d.id || !d.phone) return res.status(400).json({ error: '5sim did not return a valid phone number.' });

  res.json({
    ok: true,
    id: d.id,
    phone: d.phone.startsWith('+') ? d.phone : `+${d.phone}`,
    priceRub: Number(d.price || 0),
    priceNgn: Math.max(1, Math.ceil(Number(d.price || 0) * RUB_TO_NGN)),
    status: d.status,
    expires: d.expires
  });
});

// 2. Poll 5sim order for incoming SMS
app.get('/api/5sim/check/:id', async (req, res) => {
  const result = await call5sim(`user/check/${encodeURIComponent(req.params.id)}`, true);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({
    ok: true,
    id: result.data.id,
    status: result.data.status,
    sms: result.data.sms || [],
    expires: result.data.expires
  });
});

// 3. Cancel active 5sim order (when no SMS received)
app.post('/api/5sim/cancel/:id', async (req, res) => {
  const result = await call5sim(`user/cancel/${encodeURIComponent(req.params.id)}`, true);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  res.json({ ok: true, status: result.data.status });
});

// Verify real Paystack payment before crediting wallet
app.post('/api/paystack/verify', async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'Missing Paystack reference.' });
  if (!PAYSTACK_SECRET_KEY) return res.status(500).json({ error: 'PAYSTACK_SECRET_KEY is not set on server.' });

  try {
    const r = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${PAYSTACK_SECRET_KEY}` }
    });
    const data = await r.json();
    if (!r.ok || !data.status || data.data?.status !== 'success') {
      return res.status(400).json({ error: data.message || 'Paystack verification failed.' });
    }
    res.json({ ok: true, amountNGN: Number(data.data.amount) / 100, reference });
  } catch (err) {
    res.status(502).json({ error: `Paystack verification error: ${err.message}` });
  }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`TMSMSHub running on http://localhost:${PORT}`));
