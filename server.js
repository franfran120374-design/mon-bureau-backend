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

    const frontendUrl = state || 'https://franfran120374-design.github.io/mon-bureau/';
    
    // Encoder les données en base64 pour passer dans l'URL
    const encoded = Buffer.from(JSON.stringify(accountData)).toString('base64');
    
    // Rediriger vers le frontend avec les données dans le hash
    const redirectUrl = `${frontendUrl}#google_auth=${encoded}`;
    res.redirect(redirectUrl);
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

// =================
// MAPS TRAJETS — Calcul itinéraires
// =================

const DEFAULT_ORIGIN = '10 rue Etienne Bacquié, Toulouse, France';

app.post('/maps/trajet', async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ success: false, error: 'Google Maps API key not configured' });
  
  try {
    const { origin, destination, arrivalTime, mode = 'transit', prepMinutes = 10 } = req.body;
    if (!destination) return res.status(400).json({ success: false, error: 'destination required' });
    
    const from = origin || DEFAULT_ORIGIN;
    const params = new URLSearchParams({
      origin: from,
      destination,
      mode: mode === 'transit' ? 'transit' : mode,
      key: apiKey
    });
    
    // Si heure d'arrivée fournie, utiliser arrival_time
    if (arrivalTime) {
      const arrivalDate = new Date(arrivalTime);
      const epochSec = Math.floor(arrivalDate.getTime() / 1000) - prepMinutes * 60;
      params.set('arrival_time', epochSec);
    }
    
    const r = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
    const data = await r.json();
    
    if (data.status !== 'OK' || !data.routes?.length) {
      return res.json({ success: false, error: data.status || 'Aucun itinéraire trouvé' });
    }
    
    const route = data.routes[0];
    const leg = route.legs[0];
    
    // Extraire les étapes de transport en commun
    const transitSteps = leg.steps.filter(s => s.travel_mode === 'TRANSIT').map(s => ({
      line: s.transit_details?.line?.short_name || s.transit_details?.line?.name || '',
      vehicle: s.transit_details?.line?.vehicle?.type || '',
      departure: s.transit_details?.departure_stop?.name || '',
      arrival: s.transit_details?.arrival_stop?.name || '',
      duration: s.duration?.text || ''
    }));
    
    // Calculer heure de départ
    const departMs = leg.departure_time?.value ? leg.departure_time.value * 1000 : null;
    const departText = departMs ? new Date(departMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null;
    
    // Calculer rappel (notification)
    let rappel = null;
    if (departMs && arrivalTime) {
      const now = Date.now();
      const minBefore = Math.floor((departMs - now) / 60000);
      rappel = {
        departureTime: new Date(departMs).toISOString(),
        departureText: departText,
        minutesUntilDeparture: minBefore,
        message: minBefore <= 0 ? 'Tu devrais être parti !' : `Partir à ${departText} (dans ${minBefore} min)`
      };
    }
    
    res.json({
      success: true,
      trajet: {
        distance: leg.distance?.text || '',
        duration: leg.duration?.text || '',
        departureTime: departText,
        steps: transitSteps
      },
      rappel
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/maps/trajets-agenda', async (req, res) => {
  const apiKey = process.env.GOOGLE_MAPS_API_KEY;
  if (!apiKey) return res.status(503).json({ success: false, error: 'Google Maps API key not configured' });
  
  try {
    const { events, prepMinutes = 10 } = req.body;
    if (!Array.isArray(events)) return res.status(400).json({ success: false, error: 'events[] required' });
    
    const trajets = await Promise.allSettled(events.map(async (evt) => {
      if (!evt.location) return { eventId: evt.id, success: false, error: 'Pas de lieu' };
      
      const params = new URLSearchParams({
        origin: DEFAULT_ORIGIN,
        destination: evt.location,
        mode: 'transit',
        key: apiKey
      });
      
      if (evt.startTime || evt.start) {
        const arrivalDate = new Date(evt.startTime || evt.start);
        const epochSec = Math.floor(arrivalDate.getTime() / 1000) - prepMinutes * 60;
        params.set('arrival_time', epochSec);
      }
      
      const r = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
      const data = await r.json();
      
      if (data.status !== 'OK' || !data.routes?.length) {
        return { eventId: evt.id, success: false, error: data.status };
      }
      
      const leg = data.routes[0].legs[0];
      const departMs = leg.departure_time?.value ? leg.departure_time.value * 1000 : null;
      
      return {
        eventId: evt.id,
        success: true,
        trajet: {
          distance: leg.distance?.text || '',
          duration: leg.duration?.text || '',
          departureTime: departMs ? new Date(departMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : null
        }
      };
    }));
    
    res.json({
      success: true,
      trajets: trajets.filter(r => r.status === 'fulfilled').map(r => r.value)
    });
  } catch (e) {
    res.json({ success: false, error: e.message });
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
// MÉTÉO — Open-Meteo (gratuit, sans clé API)
// Toulouse: 43.6047°N, 1.4442°E
// =================

const METEO_LAT = 43.6047;
const METEO_LON = 1.4442;

app.get('/meteo/actuelle', async (req, res) => {
  try {
    const params = new URLSearchParams({
      latitude: String(METEO_LAT), longitude: String(METEO_LON),
      current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,uv_index',
      timezone: 'Europe/Paris'
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (!data.current) return res.json({ success: false, error: 'No current data', raw: data });
    res.json({ success: true, data: { current_weather: data.current } });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.get('/meteo/heure', async (req, res) => {
  try {
    const { datetime } = req.query;
    const params = new URLSearchParams({
      latitude: String(METEO_LAT), longitude: String(METEO_LON),
      hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,uv_index',
      timezone: 'Europe/Paris',
      forecast_days: '2'
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    
    // Trouver l'heure la plus proche
    const target = datetime ? new Date(datetime) : new Date();
    const hours = data.hourly?.time || [];
    let closestIdx = 0;
    let minDiff = Infinity;
    hours.forEach((h, i) => {
      const diff = Math.abs(new Date(h) - target);
      if (diff < minDiff) { minDiff = diff; closestIdx = i; }
    });
    
    const meteo = {
      temperature: data.hourly?.temperature_2m?.[closestIdx],
      apparentTemp: data.hourly?.apparent_temperature?.[closestIdx],
      precipProb: data.hourly?.precipitation_probability?.[closestIdx],
      precip: data.hourly?.precipitation?.[closestIdx],
      weatherCode: data.hourly?.weather_code?.[closestIdx],
      windspeed: data.hourly?.wind_speed_10m?.[closestIdx],
      uvIndex: data.hourly?.uv_index?.[closestIdx]
    };
    
    res.json({ success: true, meteo });
  } catch (e) {
    res.json({ success: false, error: e.message });
  }
});

app.post('/meteo/conseils-rdv', async (req, res) => {
  try {
    const { datetime } = req.body;
    const params = new URLSearchParams({
      latitude: String(METEO_LAT), longitude: String(METEO_LON),
      hourly: 'temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m,uv_index',
      timezone: 'Europe/Paris',
      forecast_days: 2
    });
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    
    const target = datetime ? new Date(datetime) : new Date();
    const hours = data.hourly?.time || [];
    let closestIdx = 0;
    let minDiff = Infinity;
    hours.forEach((h, i) => {
      const diff = Math.abs(new Date(h) - target);
      if (diff < minDiff) { minDiff = diff; closestIdx = i; }
    });
    
    const m = {
      temp: data.hourly?.temperature_2m?.[closestIdx],
      feelsLike: data.hourly?.apparent_temperature?.[closestIdx],
      precipProb: data.hourly?.precipitation_probability?.[closestIdx],
      precip: data.hourly?.precipitation?.[closestIdx],
      weatherCode: data.hourly?.weather_code?.[closestIdx],
      windspeed: data.hourly?.wind_speed_10m?.[closestIdx],
      uvIndex: data.hourly?.uv_index?.[closestIdx]
    };
    
    const conseils = [];
    if (m.precipProb > 50) conseils.push('Prévois un parapluie');
    if (m.temp < 5) conseils.push('Habille-toi chaudement');
    if (m.temp > 30) conseils.push('Reste à l\'ombre si possible');
    if (m.windspeed > 30) conseils.push('Vent fort prévu');
    if (m.uvIndex > 6) conseils.push('Crème solaire recommandée');
    if (conseils.length === 0) conseils.push('Belle conditions pour ce rendez-vous');
    
    res.json({ success: true, meteo: m, conseils });
  } catch (e) {
    res.json({ success: false, error: e.message });
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
