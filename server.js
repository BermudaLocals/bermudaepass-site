const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
require('./google-auth')(app);
app.use(express.json());
app.use(express.static(__dirname));
// Empire health endpoint (added 2026-07-31)
app.get("/health", (req, res) => res.json({ ok: true, service: "bermuda-epass", version: "3.0-state-of-the-art", port: PORT, uptime: process.uptime(), ts: Date.now() }));

// Run scraper on startup + schedule twice daily (7am and 2pm BDA = 11am and 6pm UTC)
const { scrapeAll } = require('./scraper');

const webpush = require('web-push');
const VAPID_PUBLIC = 'BFD3ybWKOq1VRVUnzpHj3wQ4ql9wdO-0zoIAviSMERaAb-EfCkefwjf6Y1elycmKI1joSPtKwPN7O29dZBPZwG0';
const VAPID_PRIVATE = '3d_981CXMJkK_Ax8Tr_1xQhIvEqdj-YT0SwiHKmKSxQ';
webpush.setVapidDetails('mailto:dollardoublemarketing@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);
let pushSubscriptions = [];
setTimeout(() => scrapeAll().catch(e => console.log('Initial scrape error:', e.message)), 3000);
// 7am BDA = 11:00 UTC, 2pm BDA = 18:00 UTC
const now = new Date();
const scheduleNext = (targetHourUTC) => {
  const next = new Date();
  next.setUTCHours(targetHourUTC, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  setTimeout(() => {
    scrapeAll().catch(e => console.log('Scheduled scrape error:', e.message));
    setInterval(() => scrapeAll().catch(e => console.log('Scrape error:', e.message)), 24 * 60 * 60 * 1000);
  }, next - now);
};
scheduleNext(11);
scheduleNext(18);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const PORT = process.env.PORT || 3040;

// Serve live events from scraper
app.get('/api/events', (req, res) => {
  const eventsFile = path.join(__dirname, 'live-events.json');
  if (fs.existsSync(eventsFile)) {
    res.json(JSON.parse(fs.readFileSync(eventsFile, 'utf8')));
  } else {
    res.json({ updated: null, count: 0, events: [] });
  }
});

app.post('/api/claude', async (req, res) => {
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PAYPAL_CLIENT_ID = process.env.PAYPAL_CLIENT_ID;
const PAYPAL_CLIENT_SECRET = process.env.PAYPAL_CLIENT_SECRET;
const PAYPAL_MODE = process.env.PAYPAL_MODE || 'live';
const PAYPAL_API = PAYPAL_MODE === 'live' ? 'https://api-m.paypal.com' : 'https://api-m.sandbox.paypal.com';
const APP_URL = process.env.APP_URL || 'https://bermudaepass.com';

async function getPayPalAccessToken() {
  const auth = Buffer.from(`${PAYPAL_CLIENT_ID}:${PAYPAL_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(`${PAYPAL_API}/v1/oauth2/token`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials'
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.error_description || 'PayPal auth failed');
  return d.access_token;
}

// Server-side price whitelist — never trust client-supplied amounts (2026-08-07 premium wiring)
const PRICE_BOOK = {
  '1.00':  { value: '1.00',  description: 'Bermuda ePass - 1 Hour Premium Trial' },
  '2.00': { value: '2.00', description: 'Bermuda ePass Full Day Pass' }
};

app.post('/api/paypal/create-order', async (req, res) => {
  try {
    const requested = String((req.body && req.body.amount) || '1.00');
    const ORDER = PRICE_BOOK[requested];
    if (!ORDER) return res.status(400).json({ ok: false, error: 'Invalid amount' });
    const accessToken = await getPayPalAccessToken();
    const order = await fetch(`${PAYPAL_API}/v2/checkout/orders`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        intent: 'CAPTURE',
        purchase_units: [{
          description: ORDER.description,
          amount: { currency_code: 'USD', value: ORDER.value }
        }],
        application_context: {
          return_url: `${APP_URL}/api/paypal/return`,
          cancel_url: `${APP_URL}/?trial=cancelled`,
          user_action: 'PAY_NOW',
          brand_name: 'Bermuda ePass',
          shipping_preference: 'NO_SHIPPING'
        }
      })
    });
    const data = await order.json();
    if (!order.ok) return res.status(500).json({ ok: false, error: data });
    const approveUrl = (data.links || []).find(l => l.rel === 'approve')?.href;
    res.json({ ok: true, approveUrl });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/paypal/return', async (req, res) => {
  const orderId = req.query.token;
  if (!orderId) return res.redirect('/?trial=failed');
  try {
    const accessToken = await getPayPalAccessToken();
    const capture = await fetch(`${PAYPAL_API}/v2/checkout/orders/${orderId}/capture`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    });
    const data = await capture.json();
    const completed = data.status === 'COMPLETED' ||
      (data.purchase_units || []).some(pu => (pu.payments?.captures || []).some(c => c.status === 'COMPLETED'));
    if (!capture.ok || !completed) return res.redirect('/?trial=failed');
    const trialExpires = Date.now() + 60 * 60 * 1000;
    res.redirect(`/?trial=activated&exp=${trialExpires}`);
  } catch (err) {
    console.log('PayPal capture error:', err.message);
    res.redirect('/?trial=failed');
  }
});

app.post('/api/nearby-guide', async (req, res) => {
  const { lat, lng } = req.body;
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat/lng required' });
  }
  try {
    const geoRes = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=16&addressdetails=1`,
      { headers: { 'User-Agent': 'BermudaEpass/1.0 (contact: dollardoublemarketing@gmail.com)' } }
    );
    const geoData = await geoRes.json();
    const addr = geoData.address || {};
    const parish = addr.county || addr.suburb || addr.city_district || addr.city || 'Bermuda';
    const placeName = geoData.display_name || 'this location in Bermuda';

    const prompt = `You are a friendly, knowledgeable Bermuda tour guide AI speaking to a visitor standing at this exact spot: ${placeName} (near ${parish} parish, coordinates ${lat.toFixed(5)}, ${lng.toFixed(5)}). Tell them something specific and interesting about this immediate area - history, notable nearby spots, local tips, or what the neighborhood is known for. Be conversational, warm, and concise (under 130 words). If you are not certain of exact details for this precise spot, speak more generally about the parish or region it's in rather than inventing specifics.`;

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    const claudeData = await claudeRes.json();
    const text = (claudeData.content || []).map(c => c.text || '').join('');

    res.json({ ok: true, parish, placeName, guide: text || "I couldn't quite place this spot, but you're somewhere beautiful in Bermuda!" });
  } catch (err) {
    console.log('Nearby guide error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});


// === GEO-CAPTURE: auto-detect Bermuda arrivals (added 2026-07-31) ===
const GEO_ZONES = {
  bermuda:  { lat: [32.24, 32.40], lng: [-64.90, -64.50] },
  airport:  { lat: [32.350, 32.375], lng: [-64.700, -64.660] },
  dockyard: { lat: [32.315, 32.330], lng: [-64.845, -64.820] },
  hamilton: { lat: [32.290, 32.300], lng: [-64.795, -64.775] }
};
function geoInBox(lat, lng, b) { return lat >= b.lat[0] && lat <= b.lat[1] && lng >= b.lng[0] && lng <= b.lng[1]; }
app.get('/api/geo-check', async (req, res) => {
  try {
    let lat = parseFloat(req.query.test_lat), lng = parseFloat(req.query.test_lng);
    let source = 'gps';
    if (isNaN(lat) || isNaN(lng)) {
      let ip = req.query.test_ip || ((req.headers['x-forwarded-for'] || '').split(',')[0].trim()) || (req.socket.remoteAddress || '');
      ip = ip.replace('::ffff:', '');
      if (!ip || ip === '127.0.0.1' || ip === '::1' || ip.startsWith('10.') || ip.startsWith('192.168.') || ip.startsWith('172.')) {
        return res.json({ ok: true, inBermuda: false, zone: null, source: 'ip-private' });
      }
      const r = await fetch('http://ip-api.com/json/' + ip + '?fields=status,countryCode,lat,lon,city');
      const d = await r.json();
      if (d.status !== 'success') return res.json({ ok: true, inBermuda: false, zone: null, source: 'ip-fail' });
      lat = d.lat; lng = d.lon;
      source = 'ip:' + d.countryCode + (d.city ? ':' + d.city : '');
      if (d.countryCode === 'BM') return res.json({ ok: true, inBermuda: true, zone: null, lat, lng, source });
    }
    const inBermuda = geoInBox(lat, lng, GEO_ZONES.bermuda);
    let zone = null;
    if (inBermuda) {
      if (geoInBox(lat, lng, GEO_ZONES.airport)) zone = 'airport';
      else if (geoInBox(lat, lng, GEO_ZONES.dockyard)) zone = 'dockyard';
      else if (geoInBox(lat, lng, GEO_ZONES.hamilton)) zone = 'hamilton';
    }
    res.json({ ok: true, inBermuda, zone, lat, lng, source });
  } catch (e) { res.json({ ok: true, inBermuda: false, zone: null, source: 'error' }); }
});


// === FREE 1-HOUR WELCOME TRIAL (added 2026-07-31) ===
app.post('/api/trial/free', (req, res) => {
  const exp = Date.now() + 60 * 60 * 1000;
  res.json({ ok: true, exp, minutes: 60 });
});


// === PUSH NOTIFICATION ENDPOINTS (added 2026-08-02) ===
app.get('/api/push/vapid-key', (req, res) => {
  res.json({ ok: true, publicKey: VAPID_PUBLIC });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub || !sub.endpoint) return res.status(400).json({ ok: false, error: 'Invalid subscription' });
  const exists = pushSubscriptions.some(s => s.endpoint === sub.endpoint);
  if (!exists) pushSubscriptions.push(sub);
  console.log('Push subscriber added. Total:', pushSubscriptions.length);
  res.json({ ok: true, count: pushSubscriptions.length });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
  res.json({ ok: true });
});

app.post('/api/push/notify', async (req, res) => {
  const { title = 'Bermuda ePass', body = 'New update!', url = '/' } = req.body;
  const payload = JSON.stringify({ title, body, url, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png' });
  const results = await Promise.allSettled(
    pushSubscriptions.map(sub => webpush.sendNotification(sub, payload).catch(e => {
      if (e.statusCode === 410 || e.statusCode === 404) {
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
      }
      throw e;
    }))
  );
  const sent = results.filter(r => r.status === 'fulfilled').length;
  res.json({ ok: true, sent, total: pushSubscriptions.length });
});

// HOT NOW auto-notifications — every hour broadcast top hot spots
setInterval(async () => {
  if (pushSubscriptions.length === 0) return;
  const h = new Date().getUTCHours() - 3; // Bermuda UTC-3
  const spots = ['Horseshoe Bay', 'Front Street Hamilton', 'Swizzle Inn', 'Crystal Caves', 'Tobacco Bay'];
  const spot = spots[Math.floor(Date.now()/3600000) % spots.length];
  const payload = JSON.stringify({
    title: '🔥 HOT NOW in Bermuda',
    body: spot + ' is buzzing right now! Open your ePass.',
    url: '/',
    icon: '/icons/icon-192.png'
  });
  pushSubscriptions.forEach(sub => webpush.sendNotification(sub, payload).catch(() => {}));
}, 3600000);

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => console.log('Bermuda ePass running on port ' + PORT));
