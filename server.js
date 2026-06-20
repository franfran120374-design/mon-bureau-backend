// Mon Bureau - Backend Render (sans stockage de tokens)
// Les tokens sont stockés côté frontend (localStorage)

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import webPush from 'web-push';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Web Push VAPID
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || 'BMDXlVypI88MrD_UToYt6OIFORyaxAB50UsC1VbE_OF5gQ6BQGed77ETAhLAKQoQQWIVqUzNHNxTQtux_YoYF4Q';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '4rEsQzB9QzMH_7cmcgTRN8Dd54FF3OO2jJ1NDdLX1sg';
let pushEnabled = false;
if (VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails(
      'mailto:mon-bureau@example.com',
      VAPID_PUBLIC_KEY,
      VAPID_PRIVATE_KEY
    );
    pushEnabled = true;
    console.log('[Push] ✅ VAPID configuré');
  } catch (e) {
    console.warn('[Push] ⚠️ VAPID invalide — push désactivé:', e.message);
  }
} else {
  console.log('[Push] ⚠️ Pas de VAPID_PRIVATE_KEY — push désactivé');
}

// Store des subscriptions push (en mémoire — en prod, utiliser une DB)
const pushSubscriptions = [];

// Middleware
const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'https://mon-bureau.netlify.app',
  'https://mon-bureau.onrender.com',
  'http://localhost:3000',
  'http://localhost:5173'
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) {
      callback(null, true);
    } else {
      callback(null, true); // Fallback permissif pour les apps mobiles
    }
  },
  credentials: true
}));
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

// Génère l'URL de connexion Google
app.get('/auth/google/url', (req, res) => {
  // L'URL frontend où renvoyer après auth (passée en query param)
  const frontendUrl = req.query.frontend || '';
  
  const authUrl = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
    state: frontendUrl // pour rediriger vers le frontend après
  });
  res.json({ url: authUrl });
});

// Callback OAuth - récupère les tokens et les renvoie au frontend
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
    
    // Encoder en base64 pour passer dans l'URL
    const encoded = Buffer.from(JSON.stringify(accountData)).toString('base64');
    const frontendUrl = state || '/';
    
    // Page qui transmet les tokens au frontend via postMessage et localStorage
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
    
    // Méthode 1: postMessage à la fenêtre parente
    if (window.opener) {
      try {
        window.opener.postMessage({ 
          type: 'GOOGLE_AUTH_SUCCESS', 
          account: accountData 
        }, '*');
      } catch(e) {
        console.error('postMessage failed:', e);
      }
    }
    
    // Méthode 2: localStorage partagé (si même origine)
    try {
      localStorage.setItem('pendingGoogleAuth', JSON.stringify(accountData));
    } catch(e) {
      console.error('localStorage failed:', e);
    }
    
    // Fermer après 1.5s
    setTimeout(() => {
      window.close();
      // Si window.close ne marche pas, redirection
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
// Helper: créer un client OAuth depuis les tokens reçus du frontend
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

// Helper: récupère les tokens depuis le header Authorization
function getTokensFromRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    throw new Error('Header Authorization manquant');
  }
  const encoded = auth.substring(7);
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (e) {
    throw new Error('Tokens invalides');
  }
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
    
    // Renvoie aussi les tokens mis à jour si refresh
    const newTokens = auth.credentials;
    res.json({ 
      events: response.data.items,
      tokens: newTokens // Le frontend met à jour son localStorage
    });
  } catch (error) {
    console.error('Calendar list error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    
    const event = await calendar.events.insert({
      calendarId: 'primary',
      resource: req.body
    });
    
    res.json({ 
      event: event.data,
      tokens: auth.credentials
    });
  } catch (error) {
    console.error('Calendar create error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    
    await calendar.events.delete({
      calendarId: 'primary',
      eventId: req.params.eventId
    });
    
    res.json({ 
      success: true,
      tokens: auth.credentials
    });
  } catch (error) {
    console.error('Calendar delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const calendar = google.calendar({ version: 'v3', auth });
    
    const event = await calendar.events.patch({
      calendarId: 'primary',
      eventId: req.params.eventId,
      resource: req.body
    });
    
    res.json({ 
      event: event.data,
      tokens: auth.credentials
    });
  } catch (error) {
    console.error('Calendar update error:', error);
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
    
    res.json({ 
      files: response.data.files,
      tokens: auth.credentials
    });
  } catch (error) {
    console.error('Drive list error:', error);
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
    
    res.json({ 
      files: response.data.files,
      tokens: auth.credentials
    });
  } catch (error) {
    console.error('Drive search error:', error);
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
      media: { 
        mimeType: req.body.mimeType || 'text/plain', 
        body: req.body.content 
      },
      fields: 'id, name, webViewLink'
    });
    
    res.json({ 
      file: file.data,
      tokens: auth.credentials
    });
  } catch (error) {
    console.error('Drive upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.get('/drive/download/:fileId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    
    const response = await drive.files.get({
      fileId: req.params.fileId,
      alt: 'media'
    }, { responseType: 'arraybuffer' });
    
    res.json({
      content: Buffer.from(response.data).toString('base64'),
      tokens: auth.credentials
    });
  } catch (error) {
    console.error('Drive download error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/drive/create-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    
    const folder = await drive.files.create({
      resource: {
        name: req.body.folderName,
        mimeType: 'application/vnd.google-apps.folder'
      },
      fields: 'id, name, webViewLink'
    });
    
    res.json({
      folder: folder.data,
      tokens: auth.credentials
    });
  } catch (error) {
    console.error('Drive create folder error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =================
// HEALTH
// =================

app.get('/', (req, res) => {
  res.json({ 
    name: 'Mon Bureau Backend',
    version: '1.2.0',
    status: 'ok'
  });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', version: '1.2.0' });
});

// =================
// CLAUDE API — Chat, Summarize, Factcheck, Analyze
// =================

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

async function callClaude(messages, system, maxTokens = 1024) {
  if (!ANTHROPIC_API_KEY) throw new Error('Claude API key not configured');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: system || 'Tu es un assistant utile.',
      messages: messages
    })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.error?.message || `Claude API error: ${response.status}`);
  }
  return await response.json();
}

app.post('/agents/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    if (!messages || !messages.length) return res.status(400).json({ error: 'messages required' });
    const data = await callClaude(messages, system, 2048);
    res.json({ success: true, content: data.content });
  } catch (error) {
    console.error('[Claude] chat error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/chat', async (req, res) => {
  try {
    const { message, context } = req.body;
    const messages = [{ role: 'user', content: message }];
    const system = context?.system || 'Tu es un assistant utile. Réponds en français.';
    const data = await callClaude(messages, system);
    res.json({ success: true, content: data.content });
  } catch (error) {
    console.error('[Claude] chat error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/summarize', async (req, res) => {
  try {
    const { text, type } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const system = `Tu es un expert en résumé. Résume le texte suivant en 3-5 bullet points clairs et concis en français. Type: ${type || 'article'}.`;
    const data = await callClaude([{ role: 'user', content: text }], system, 512);
    res.json({ success: true, summary: data.content[0]?.text || '' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/factcheck', async (req, res) => {
  try {
    const { title, content, url } = req.body;
    if (!content && !title) return res.status(400).json({ error: 'content required' });
    const system = `Tu es un fact-checker expert. Vérifie l'affirmation ou l'article suivant. Indique si c'est vraisemblable, faux, ou non vérifiable. Donne une réponse structurée avec: verdict (Vrai/Faux/Non vérifiable), confiance (%), sources suggérées, contexte. Réponds en français.`;
    const data = await callClaude([{ role: 'user', content: `Titre: ${title || 'N/A'}\nContenu: ${content}\nURL: ${url || 'N/A'}` }], system, 1024);
    res.json({ success: true, result: data.content[0]?.text || '' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/analyze', async (req, res) => {
  try {
    const { type, data: analysisData } = req.body;
    const system = `Tu es un analyste expert. Analyse les données fournies et donne un retour structuré. Type d'analyse: ${type || 'general'}. Réponds en français.`;
    const data = await callClaude([{ role: 'user', content: JSON.stringify(analysisData) }], system, 1024);
    res.json({ success: true, analysis: data.content[0]?.text || '' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// LASTFM AGENTS — API format compatible frontend
// =================

app.get('/agents/lastfm/gettoptracks', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({
      method: 'user.gettoptracks',
      api_key: LASTFM_API_KEY,
      user: req.query.user || 'franfran120374',
      format: 'json',
      limit: req.query.limit || '10',
      period: req.query.period || '1month'
    });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    const data = await r.json();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/agents/lastfm/gettopartists', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({
      method: 'user.gettopartists',
      api_key: LASTFM_API_KEY,
      user: req.query.user || 'franfran120374',
      format: 'json',
      limit: req.query.limit || '10',
      period: req.query.period || 'overall'
    });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    const data = await r.json();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/agents/lastfm/getrecenttracks', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({
      method: 'user.getrecenttracks',
      api_key: LASTFM_API_KEY,
      user: req.query.user || 'franfran120374',
      format: 'json',
      limit: req.query.limit || '10'
    });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    const data = await r.json();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =================
// METEO — Open-Meteo (gratuit, pas de clé API)
// =================

app.get('/meteo/actuelle', async (req, res) => {
  try {
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=43.6047&longitude=1.4442&current_weather=true&hourly=temperature_2m,relativehumidity_2m,precipitation_probability,windspeed_10m,uv_index&timezone=Europe/Paris');
    const data = await r.json();
    res.json({ success: true, data });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.get('/meteo/heure', async (req, res) => {
  try {
    const datetime = req.query.datetime || new Date().toISOString();
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=43.6047&longitude=1.4442&hourly=temperature_2m,apparent_temperature,precipitation_probability,windspeed_10m,uv_index&timezone=Europe/Paris&start=${datetime}&end=${datetime}`);
    const data = await r.json();
    const hourly = data.hourly || {};
    const meteo = {
      temperature: hourly.temperature_2m?.[0] || 0,
      apparentTemp: hourly.apparent_temperature?.[0] || 0,
      precipProb: hourly.precipitation_probability?.[0] || 0,
      windspeed: hourly.windspeed_10m?.[0] || 0,
      uvIndex: hourly.uv_index?.[0] || 0
    };
    res.json({ success: true, meteo });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

app.post('/meteo/conseils-rdv', async (req, res) => {
  try {
    const { eventTitle, departTime, destination } = req.body;
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=43.6047&longitude=1.4442&hourly=temperature_2m,apparent_temperature,precipitation_probability,windspeed_10m,weathercode&timezone=Europe/Paris`);
    const data = await r.json();
    const hourly = data.hourly || {};
    const depart = departTime ? new Date(departTime) : new Date();
    const hourIdx = Math.max(0, Math.min(23, depart.getHours()));
    const temp = hourly.temperature_2m?.[hourIdx] || 15;
    const precip = hourly.precipitation_probability?.[hourIdx] || 0;
    const wind = hourly.windspeed_10m?.[hourIdx] || 0;
    const code = hourly.weathercode?.[hourIdx] || 0;

    let vêtements = [];
    if (temp < 10) vêtements.push('🧥 Manteau');
    if (temp < 5) vêtements.push('🧤 Gants');
    if (precip > 50) vêtements.push('☂️ Parapluie');
    if (precip > 30 && precip <= 50) vêtements.push('🧥 Imperméable');
    if (temp > 25 && precip < 10) vêtements.push('🧴 Crème solaire');
    if (wind > 30) vêtements.push('💨 Coupe-vent');
    if (temp > 15 && temp <= 25 && precip < 20) vêtements.push('👌 Confortable');
    if (vêtements.length === 0) vêtements.push('👌 Tenue standard');

    const resume = `${eventTitle || 'RDV'} — Il fera ${Math.round(temp)}°C, pluie ${precip}%, vent ${Math.round(wind)} km/h. Conseil: ${vêtements.join(', ')}`;
    res.json({ success: true, resume, temp, precip, wind, conseils: vêtements });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =================
// MAPS — Google Maps Directions
// =================

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

app.post('/maps/trajet', async (req, res) => {
  try {
    const { origin, destination, arrivalTime, mode, prepMinutes } = req.body;
    if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });

    if (!GOOGLE_MAPS_API_KEY) {
      // Fallback: estimation basique sans API
      const durationMin = mode === 'transit' ? 25 : mode === 'driving' ? 15 : mode === 'walking' ? 45 : 20;
      return res.json({
        success: true,
        trajet: { duration: `${durationMin} min`, distance: '~3 km', mode },
        rappel: null
      });
    }

    const arrival = arrivalTime ? Math.floor(new Date(arrivalTime).getTime() / 1000) : undefined;
    const params = new URLSearchParams({
      origin,
      destination,
      key: GOOGLE_MAPS_API_KEY,
      mode: mode || 'transit',
      departure_time: arrival ? undefined : 'now',
      arrival_time: arrival ? String(arrival) : undefined,
      language: 'fr'
    });

    const r = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
    const data = await r.json();

    if (data.status !== 'OK' || !data.routes?.length) {
      return res.json({ success: false, error: data.error_message || 'Itinéraire non trouvé' });
    }

    const leg = data.routes[0].legs[0];
    const duration = leg.duration?.text || '? min';
    const distance = leg.distance?.text || '? km';

    let rappel = null;
    if (arrivalTime && leg.duration) {
      const departMs = new Date(arrivalTime).getTime() - (leg.duration.value * 1000) - ((prepMinutes || 10) * 60000);
      const nowMs = Date.now();
      const minutesUntil = Math.round((departMs - nowMs) / 60000);
      rappel = {
        departureText: new Date(departMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        minutesUntilDeparture: minutesUntil,
        isUrgent: minutesUntil <= 30,
        isLate: minutesUntil < 0,
        message: minutesUntil < 0
          ? `⚠️ Tu es en retard de ${Math.abs(minutesUntil)} min !`
          : minutesUntil <= 30
            ? `⚠️ Partir dans ${minutesUntil} min`
            : `Tu peux partir dans ${minutesUntil} min`
      };
    }

    res.json({ success: true, trajet: { duration, distance, mode }, rappel });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =================
// WEB PUSH NOTIFICATIONS
// =================

app.post('/push/subscribe', (req, res) => {
  try {
    const subscription = req.body;
    if (!subscription?.endpoint) return res.status(400).json({ error: 'endpoint required' });
    // Éviter les doublons
    const exists = pushSubscriptions.find(s => s.endpoint === subscription.endpoint);
    if (!exists) {
      pushSubscriptions.push(subscription);
      console.log(`[Push] Nouvelle subscription (${pushSubscriptions.length} total)`);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/push/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    const idx = pushSubscriptions.findIndex(s => s.endpoint === endpoint);
    if (idx >= 0) {
      pushSubscriptions.splice(idx, 1);
      console.log(`[Push] Subscription supprimée (${pushSubscriptions.length} total)`);
    }
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/push/send', async (req, res) => {
  try {
    if (!pushEnabled) return res.status(503).json({ error: 'Push notifications not configured (VAPID key invalid)' });
    const { title, body, url } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });

    const payload = JSON.stringify({
      title: title || 'Mon Bureau',
      body: body || '',
      url: url || '/mon-bureau/',
      icon: '/mon-bureau/icon-192.png',
      badge: '/mon-bureau/icon-192.png'
    });

    const results = await Promise.allSettled(
      pushSubscriptions.map(sub =>
        webPush.sendNotification(sub, payload).catch(e => {
          if (e.statusCode === 410 || e.statusCode === 404) {
            // Subscription expirée, la supprimer
            const idx = pushSubscriptions.findIndex(s => s.endpoint === sub.endpoint);
            if (idx >= 0) pushSubscriptions.splice(idx, 1);
          }
          throw e;
        })
      )
    );

    const sent = results.filter(r => r.status === 'fulfilled').length;
    const failed = results.filter(r => r.status === 'rejected').length;
    res.json({ success: true, sent, failed, total: pushSubscriptions.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// =================
// RSS PARSE
// =================

app.post('/rss/parse', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    // Essayer via proxy CORS
    const proxies = [
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`
    ];
    let xml = '';
    for (const proxyUrl of proxies) {
      try {
        const r = await fetch(proxyUrl, { signal: AbortSignal?.timeout?.(10000) || undefined });
        if (r.ok) { xml = await r.text(); break; }
      } catch(e) { /* try next */ }
    }
    if (!xml) return res.status(502).json({ error: 'RSS feed inaccessible' });
    res.json({ success: true, xml });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// =================
// API PROXY — YouTube, Last.fm, Tisséo
// Les clés API restent côté serveur, jamais exposées au frontend
// =================

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const LASTFM_API_KEY = process.env.LASTFM_API_KEY;
const TISSEO_API_KEY = process.env.TISSEO_API_KEY;

// YouTube Search Proxy
app.get('/proxy/youtube/search', async (req, res) => {
  if (!YOUTUBE_API_KEY) return res.status(503).json({ error: 'YouTube API key not configured' });
  try {
    const params = new URLSearchParams({
      part: 'snippet',
      q: req.query.q || '',
      type: 'video',
      maxResults: req.query.maxResults || '5',
      key: YOUTUBE_API_KEY
    });
    const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Last.fm Proxy
app.get('/proxy/lastfm/:method', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({
      method: req.params.method,
      api_key: LASTFM_API_KEY,
      format: 'json',
      ...req.query
    });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Tisséo Proxy
app.get('/proxy/tisseo/:endpoint', async (req, res) => {
  if (!TISSEO_API_KEY) return res.status(503).json({ error: 'Tisséo API key not configured' });
  try {
    const params = new URLSearchParams({
      key: TISSEO_API_KEY,
      displayLines: 1,
      srsName: 'EPSG:4326',
      ...req.query
    });
    const r = await fetch(`https://api.tisseo.fr/v2/${req.params.endpoint}?${params}`);
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
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
