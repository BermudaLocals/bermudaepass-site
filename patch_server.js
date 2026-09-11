// patch_server.js — adds web-push to bermuda-epass server.js
const fs = require('fs');
const p = '/var/www/bermuda-epass/server.js';
let s = fs.readFileSync(p, 'utf8');

if (s.includes('web-push')) { console.log('ALREADY_PATCHED'); process.exit(0); }

// 1. Add web-push require + VAPID after the last require line
const webPushBlock = `
const webpush = require('web-push');
const VAPID_PUBLIC = 'BFD3ybWKOq1VRVUnzpHj3wQ4ql9wdO-0zoIAviSMERaAb-EfCkefwjf6Y1elycmKI1joSPtKwPN7O29dZBPZwG0';
const VAPID_PRIVATE = '3d_981CXMJkK_Ax8Tr_1xQhIvEqdj-YT0SwiHKmKSxQ';
webpush.setVapidDetails('mailto:dollardoublemarketing@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);
let pushSubscriptions = [];
`;

// Insert after the last require
const lastRequireIdx = s.lastIndexOf("require('./");
const afterRequireLine = s.indexOf('\n', lastRequireIdx) + 1;
s = s.slice(0, afterRequireLine) + webPushBlock + s.slice(afterRequireLine);

// 2. Add push endpoints before the catchall route
const pushRoutes = `
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

`;

const catchAllIdx = s.indexOf("app.get('*'");
if (catchAllIdx === -1) { console.error('CATCHALL_NOT_FOUND'); process.exit(1); }
s = s.slice(0, catchAllIdx) + pushRoutes + s.slice(catchAllIdx);

fs.writeFileSync(p, s);
console.log('SERVER_PUSH_PATCHED');
