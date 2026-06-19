// Mon Bureau - Backend Render (sans stockage de tokens)
// Les tokens sont stockés côté frontend (localStorage)

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// OAuth Google - URL de redirection dynamique
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  REDIRECT_URI
);

const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// =================
// ROUTES OAuth
// =================

app.get('/auth/google/url', (req, res) => {
  const frontendUrl = req.query.frontend || '';
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: frontendUrl
  });
  res.json({ url: authUrl });
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send('<h1>Erreur: code manquant</h1>');

  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();

    const accountData = {
      id: data.id,
      email: data.email,
      name: data.name || data.email,
      picture: data.picture,
      tokens: tokens,
      addedAt: Date.now()
    };

    const frontendUrl = state || '/';

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Connexion réussie</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 40px; text-align: center; background: #f5f5f5; }
    .card { background: white; padding: 30px; border-radius: 12px; max-width: 400px; margin: 0 auto; box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
    h1 { color: #22c55e; margin: 0 0 10px; }
    p { color: #666; }
    img { width: 60px; height: 60px; border-radius: 50%; margin: 10px 0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>✓ Connecté</h1>
    ${data.picture ? `<img src="${data.picture}" alt="">` : ''}
    <h2>${data.name || data.email}</h2>
    <p>${data.email}</p>
    <p style="margin-top:20px; font-size:14px">Cette fenêtre va se fermer...</p>
  </div>
  <script>
    const accountData = ${JSON.stringify(accountData)};
    if (window.opener) {
      try { window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', account: accountData }, '*'); } catch(e) {}
    }
    try { localStorage.setItem('pendingGoogleAuth', JSON.stringify(accountData)); } catch(e) {}
    setTimeout(() => {
      window.close();
      if (!window.closed) {
        document.body.innerHTML = '<div class="card"><h1>✓ Connexion OK</h1><p>Tu peux fermer cette fenêtre et retourner à l\\'app.</p></div>';
      }
    }, 1500);
  </script>
</body>
</html>`);
  } catch (error) {
    console.error('Auth error:', error);
    res.send(`<h1>Erreur</h1><pre>${error.message}</pre>`);
  }
});

// =================
// Helpers
// =================

function getAuthClient(tokens) {
  if (!tokens) throw new Error('Tokens manquants');
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

function getTokensFromRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) throw new Error('Header Authorization manquant');
  const encoded = auth.substring(7);
  return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
}

// =================
// CALENDAR
// =================

app.get('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const response = await calendar.events.list({
      calendarId: 'primary',
      timeMin: req.query.timeMin || new Date().toISOString(),
      maxResults: parseInt(req.query.maxResults) || 50,
      singleEvents: true,
      orderBy: 'startTime'
    });
    res.json({ events: response.data.items, tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.insert({ calendarId: 'primary', resource: req.body });
    res.json({ event: event.data, tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId: req.params.eventId });
    res.json({ success: true, tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.patch('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.patch({ calendarId: 'primary', eventId: req.params.eventId, resource: req.body });
    res.json({ event: event.data, tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =================
// DRIVE
// =================

app.get('/drive/files', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.list({
      pageSize: parseInt(req.query.pageSize) || 20,
      fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
      q: req.query.query || "trashed=false",
      orderBy: 'modifiedTime desc'
    });
    res.json({ files: response.data.files, tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/drive/search', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.list({
      pageSize: 20,
      fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
      q: `name contains '${req.query.q}' and trashed=false`
    });
    res.json({ files: response.data.files, tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/drive/upload', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const file = await drive.files.create({
      resource: { name: req.body.fileName },
      media: { mimeType: req.body.mimeType || 'text/plain', body: req.body.content },
      fields: 'id, name, webViewLink'
    });
    res.json({ file: file.data, tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/drive/download/:fileId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.get({ fileId: req.params.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    res.json({ content: Buffer.from(response.data).toString('base64'), tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/drive/create-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const folder = await drive.files.create({
      resource: { name: req.body.folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id, name, webViewLink'
    });
    res.json({ folder: folder.data, tokens: auth.credentials });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =================
// TISSÉO — Prochains passages
// =================

const TISSEO_API_KEY = process.env.TISSEO_API_KEY || 'f39e1e02-80f5-4342-bfd6-72981063f1b6';
const TISSEO_BASE = 'https://api.tisseo.fr/v2';

const TISSEO_ARRETS = {
  gallieni: { name: 'Gallieni', id: null, term: 'Gallieni' },
  langlade: { name: 'Langlade', id: null, term: 'Langlade' },
  tourraine: { name: 'Tourraine', id: null, term: 'Tourraine' }
};

async function tisseoResolveStopId(term) {
  const params = new URLSearchParams({ key: TISSEO_API_KEY, displayLines: 1, srsName: 'EPSG:4326', term });
  const r = await fetch(`${TISSEO_BASE}/stops_area.json?${params}`, { signal: AbortSignal.timeout(5000) });
  const d = await r.json();
  const stops = d.stopsArea?.stopsArea || [];
  return stops.length ? stops[0].id : null;
}

app.get('/tisseo/prochains', async (req, res) => {
  try {
    const { arret = 'gallieni', nb = 5 } = req.query;
    const arretConfig = TISSEO_ARRETS[arret.toLowerCase()];
    if (!arretConfig) return res.status(400).json({ success: false, error: `Arrêt inconnu: ${arret}` });

    if (!arretConfig.id) arretConfig.id = await tisseoResolveStopId(arretConfig.term);
    if (!arretConfig.id) return res.json({ success: false, arret, passages: [], error: 'Arrêt non trouvé' });

    const params = new URLSearchParams({ key: TISSEO_API_KEY, stopAreaId: arretConfig.id, number: nb, srsName: 'EPSG:4326' });
    const r = await fetch(`${TISSEO_BASE}/departures.json?${params}`, { signal: AbortSignal.timeout(5000) });
    const d = await r.json();
    const now = new Date();

    const passages = (d.departures?.departure || []).map(dep => {
      const dt = new Date(dep.dateTime);
      const diffMin = Math.round((dt - now) / 60000);
      return {
        ligne: dep.line?.shortName || dep.line?.longName || '?',
        direction: dep.destination?.name || '',
        heure: dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        attente: diffMin <= 0 ? 'Maintenant' : diffMin === 1 ? '1 min' : `${diffMin} min`,
        attenteMin: diffMin,
        realtime: dep.realTime === '1'
      };
    });

    res.json({ success: true, arret, name: arretConfig.name, passages });
  } catch (e) {
    res.json({ success: false, arret: req.query.arret, passages: [], error: e.message });
  }
});

// =================
// API PROXY — YouTube, Last.fm
// =================

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

// YouTube Search Proxy
app.get('/proxy/youtube/search', async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube API key not configured' });
  try {
    const params = new URLSearchParams({
      part: 'snippet', q: req.query.q || '', type: 'video',
      maxResults: req.query.maxResults || '5', key: YOUTUBE_API_KEY
    });
    const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Last.fm Proxy
app.get('/proxy/lastfm/:method', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({
      method: req.params.method, api_key: LASTFM_API_KEY, format: 'json', ...req.query
    });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tisséo generic proxy (for agent-tisseo.js)
app.get('/proxy/tisseo/:endpoint', async (req, res) => {
  try {
    const params = new URLSearchParams({ key: TISSEO_API_KEY, displayLines: 1, srsName: 'EPSG:4326', ...req.query });
    const r = await fetch(`https://api.tisseo.fr/v2/${req.params.endpoint}?${params}`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Google Maps Directions proxy
app.get('/proxy/maps/directions', async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Google Maps API key not configured' });
  try {
    const params = new URLSearchParams({ ...req.query, key: apiKey });
    const r = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
    res.json(await r.json());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// RSS Proxy (for podcast fallback)
app.post('/proxy/rss', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'URL required' });
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
    const text = await r.text();
    res.type('application/xml').send(text);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =================
// WEB PUSH — Notifications
// =================

const PUSH_SUBSCRIPTIONS = []; // En prod: utiliser une DB

app.post('/push/subscribe', (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Subscription required' });
  
  // Éviter les doublons
  const exists = PUSH_SUBSCRIPTIONS.find(s => s.endpoint === subscription.endpoint);
  if (!exists) PUSH_SUBSCRIPTIONS.push(subscription);
  
  console.log(`[Push] Nouvel abonnement (${PUSH_SUBSCRIPTIONS.length} total)`);
  res.json({ success: true, count: PUSH_SUBSCRIPTIONS.length });
});

app.post('/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body;
  const idx = PUSH_SUBSCRIPTIONS.findIndex(s => s.endpoint === endpoint);
  if (idx !== -1) PUSH_SUBSCRIPTIONS.splice(idx, 1);
  res.json({ success: true });
});

app.post('/push/send', async (req, res) => {
  const { title, body, url } = req.body;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  
  if (!privateKey) {
    return res.status(503).json({ error: 'VAPID_PRIVATE_KEY not configured' });
  }
  
  if (!PUSH_SUBSCRIPTIONS.length) {
    return res.json({ success: true, sent: 0, message: 'No subscribers' });
  }
  
  // Import dynamique de web-push
  let webpush;
  try {
    webpush = await import('web-push');
    webpush.default.setVapidDetails(
      'mailto:mon-bureau@example.com',
      'BMMP3lc0SYLpcwMTvK4wt0a7ru3bAe67uVZK3AmS3yXmZ79k1e-i6DNt9BGZiuUwnOkyKkOZpRB63_Oh58U9SaE',
      privateKey
    );
  } catch(e) {
    return res.status(503).json({ error: 'web-push module not installed' });
  }
  
  const payload = JSON.stringify({ title: title || 'Mon Bureau', body: body || '', url: url || '/' });
  let sent = 0;
  
  for (const sub of PUSH_SUBSCRIPTIONS) {
    try {
      await webpush.default.sendNotification(sub, payload);
      sent++;
    } catch(e) {
      if (e.statusCode === 410) {
        // Abonnement expiré, le supprimer
        const idx = PUSH_SUBSCRIPTIONS.findIndex(s => s.endpoint === sub.endpoint);
        if (idx !== -1) PUSH_SUBSCRIPTIONS.splice(idx, 1);
      }
    }
  }
  
  res.json({ success: true, sent, total: PUSH_SUBSCRIPTIONS.length });
});

// =================
// AGENTS IA (proxy Anthropic)
// =================

app.post('/agents/chat', async (req, res) => {
  try {
    const { messages, system, model, max_tokens } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages[] requis' });
    }
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY manquante' });

    const payload = {
      model: model || 'claude-sonnet-4-6',
      max_tokens: max_tokens || 1024,
      messages
    };
    if (system) payload.system = system;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await r.json();
    if (!r.ok) return res.status(r.status).json(data);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: 'Erreur proxy Anthropic', detail: String(e?.message || e) });
  }
});

// =================
// HEALTH
// =================

app.get('/', (req, res) => {
  res.json({ name: 'Mon Bureau Backend', version: '2.1.0', status: 'ok' });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// =================
// START
// =================

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║  Mon Bureau Backend - Render          ║
║  Port: ${PORT}                            ║
║  Mode: stateless (tokens côté client) ║
╚═══════════════════════════════════════╝
  `);
});
