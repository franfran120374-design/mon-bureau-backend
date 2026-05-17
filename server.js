// Mon Bureau - Backend Render (sans stockage de tokens)
// Les tokens sont stockés côté frontend (localStorage)

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

// OAuth Google
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
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/contacts.readonly'  // ← People API pour les contacts
];

// =================
// ROUTES API CLAUDE
// =================

app.post('/claude/summarize', async (req, res) => {
  try {
    const { text, type } = req.body;
    let prompt = '';
    if (type === 'article') {
      prompt = `Résume cet article en 3 points clés (max 50 mots par point). Sois concis et factuel.\n\nArticle:\n${text}`;
    } else if (type === 'note') {
      prompt = `Résume cette note en gardant les informations essentielles.\n\nNote:\n${text}`;
    } else if (type === 'meeting') {
      prompt = `Résume cet événement/réunion : quoi, quand, avec qui, objectifs.\n\nÉvénement:\n${text}`;
    }
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    });
    res.json({ success: true, summary: message.content[0].text, usage: message.usage });
  } catch (error) {
    console.error('Summarize error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/factcheck', async (req, res) => {
  try {
    const { title, content, url } = req.body;
    const prompt = `Tu es un fact-checker expert. Analyse cet article et évalue sa crédibilité.

Article:
Titre: ${title}
URL: ${url}
Contenu: ${content}

Fournis une analyse structurée en JSON avec:
{
  "score": 0-100 (score de confiance),
  "verdict": "Fiable" | "Douteux" | "Faux" | "Non vérifiable",
  "points_positifs": ["point1", "point2"],
  "points_negatifs": ["point1", "point2"],
  "recommandation": "courte phrase"
}

Réponds UNIQUEMENT avec le JSON, sans texte avant ou après.`;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });
    const responseText = message.content[0].text;
    let analysis;
    try {
      const cleanText = responseText.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      analysis = JSON.parse(cleanText);
    } catch (parseError) {
      analysis = { score: 50, verdict: "Non vérifiable", points_positifs: [], points_negatifs: [], recommandation: "Vérifier manuellement" };
    }
    res.json({ success: true, analysis, usage: message.usage });
  } catch (error) {
    console.error('Fact-check error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/chat', async (req, res) => {
  try {
    const { message: userMessage, context } = req.body;
    let systemPrompt = `Tu es l'assistant personnel de Sandra. Tu as accès à ses données :`;
    if (context?.tasks?.length) systemPrompt += `\n\nTÂCHES EN COURS:\n${context.tasks.join('\n')}`;
    if (context?.events?.length) systemPrompt += `\n\nÉVÉNEMENTS À VENIR:\n${context.events.join('\n')}`;
    if (context?.notes?.length) systemPrompt += `\n\nNOTES RÉCENTES:\n${context.notes.join('\n')}`;
    if (context?.habits?.length) systemPrompt += `\n\nHABITUDES:\n${context.habits.join('\n')}`;
    systemPrompt += `\n\nRéponds de façon concise, bienveillante et actionnable. Utilise le prénom Sandra si approprié.`;
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMessage }]
    });
    res.json({ success: true, reply: message.content[0].text, usage: message.usage });
  } catch (error) {
    console.error('Chat error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/analyze', async (req, res) => {
  try {
    const { type, data } = req.body;
    let prompt = '';
    if (type === 'tasks') {
      prompt = `Analyse ces tâches et fournis des insights en JSON:\n${JSON.stringify(data, null, 2)}\n\nFormat:\n{"total": nombre, "completed_rate": pourcentage, "patterns": [], "suggestions": []}`;
    } else if (type === 'notes') {
      prompt = `Analyse ces notes et extrais les thèmes en JSON:\n${JSON.stringify(data, null, 2)}\n\nFormat:\n{"themes": [], "mood_trend": "positif|neutre|négatif", "key_topics": []}`;
    }
    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }]
    });
    let insights;
    try {
      const cleanText = message.content[0].text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      insights = JSON.parse(cleanText);
    } catch (e) { insights = { error: "Format inattendu" }; }
    res.json({ success: true, insights, usage: message.usage });
  } catch (error) {
    console.error('Analyze error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// PROXY GOOGLE MAPS (Directions API - évite CORS)
// =================

app.post('/proxy/maps', async (req, res) => {
  try {
    const { origin, destination, arrivalTime, mode } = req.body;
    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';

    const params = new URLSearchParams({
      origin: origin || '10 rue Etienne Bacquié, Toulouse',
      destination,
      mode: mode || 'transit',
      key: MAPS_KEY,
      language: 'fr',
      region: 'fr'
    });

    if (arrivalTime) {
      params.set('arrival_time', Math.floor(new Date(arrivalTime).getTime() / 1000));
    }

    const url = `https://maps.googleapis.com/maps/api/directions/json?${params}`;
    const response = await fetch(url);
    const data = await response.json();

    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
      console.error('[Maps] Status:', data.status, data.error_message);
    }

    res.json(data);
  } catch (error) {
    console.error('Maps proxy error:', error);
    res.status(500).json({ error: error.message, status: 'ERROR' });
  }
});

// =================
// CONTACTS (People API)
// =================

app.get('/contacts/search', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const people = google.people({ version: 'v1', auth });

    const query = req.query.q || '';
    const response = await people.people.searchContacts({
      query,
      readMask: 'names,emailAddresses',
      pageSize: 10
    });

    const contacts = (response.data.results || []).map(r => ({
      name: r.person?.names?.[0]?.displayName || '',
      email: r.person?.emailAddresses?.[0]?.value || ''
    })).filter(c => c.email);

    res.json({ contacts, tokens: auth.credentials });
  } catch (error) {
    console.error('Contacts search error:', error);
    res.status(500).json({ contacts: [], error: error.message });
  }
});

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
      id: data.id, email: data.email, name: data.name || data.email,
      picture: data.picture, tokens, addedAt: Date.now()
    };
    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connexion réussie</title>
<style>body{font-family:system-ui,sans-serif;padding:40px;text-align:center;background:#f5f5f5}.card{background:white;padding:30px;border-radius:12px;max-width:400px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,.1)}h1{color:#22c55e;margin:0 0 10px}img{width:60px;height:60px;border-radius:50%;margin:10px 0}</style>
</head><body><div class="card">
<h1>✓ Connecté</h1>
${data.picture ? `<img src="${data.picture}" alt="">` : ''}
<h2>${data.name || data.email}</h2><p>${data.email}</p>
<p style="margin-top:20px;font-size:14px">Cette fenêtre va se fermer...</p>
</div>
<script>
const accountData = ${JSON.stringify(accountData)};
if (window.opener) { try { window.opener.postMessage({ type: 'GOOGLE_AUTH_SUCCESS', account: accountData }, '*'); } catch(e) {} }
try { localStorage.setItem('pendingGoogleAuth', JSON.stringify(accountData)); } catch(e) {}
setTimeout(() => { window.close(); if (!window.closed) { document.body.innerHTML = '<div class="card"><h1>✓ Connexion OK</h1><p>Tu peux fermer cette fenêtre.</p></div>'; } }, 1500);
</script></body></html>`);
  } catch (error) {
    console.error('Auth error:', error);
    res.send(`<h1>Erreur</h1><pre>${error.message}</pre>`);
  }
});

// =================
// Helper functions
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
  try {
    return JSON.parse(Buffer.from(auth.substring(7), 'base64').toString('utf8'));
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
      singleEvents: true, orderBy: 'startTime'
    });
    res.json({ events: response.data.items, tokens: auth.credentials });
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
    const event = await calendar.events.insert({ calendarId: 'primary', resource: req.body });
    res.json({ event: event.data, tokens: auth.credentials });
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
    await calendar.events.delete({ calendarId: 'primary', eventId: req.params.eventId });
    res.json({ success: true, tokens: auth.credentials });
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
    const event = await calendar.events.patch({ calendarId: 'primary', eventId: req.params.eventId, resource: req.body });
    res.json({ event: event.data, tokens: auth.credentials });
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
    res.json({ files: response.data.files, tokens: auth.credentials });
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
    res.json({ files: response.data.files, tokens: auth.credentials });
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
      media: { mimeType: req.body.mimeType || 'text/plain', body: req.body.content },
      fields: 'id, name, webViewLink'
    });
    res.json({ file: file.data, tokens: auth.credentials });
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
    const response = await drive.files.get({ fileId: req.params.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    res.json({ content: Buffer.from(response.data).toString('base64'), tokens: auth.credentials });
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
      resource: { name: req.body.folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id, name, webViewLink'
    });
    res.json({ folder: folder.data, tokens: auth.credentials });
  } catch (error) {
    console.error('Drive create folder error:', error);
    res.status(500).json({ error: error.message });
  }
});

// =================
// PROXY RSS ÉVÉNEMENTS TOULOUSE
// =================

app.post('/proxy/rss', async (req, res) => {
  try {
    const { url, name, start, end } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MonBureau/1.0)',
        'Accept': 'application/rss+xml, application/xml, text/xml, application/json, */*'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();

    // Parser RSS/Atom
    const events = [];
    const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');

    if (isJson) {
      // Format JSON (OpenAgenda v2)
      const data = JSON.parse(text);
      const items = data.events || data.items || data.results || [];
      items.forEach(item => {
        const dateStr = (item.firstDate || item.date_debut || item.timings?.[0]?.begin || '').split('T')[0];
        if (!dateStr || (start && dateStr < start) || (end && dateStr > end)) return;
        events.push({
          id: item.uid || item.id || Math.random().toString(36).substr(2,9),
          title: item.title?.fr || item.title || item.nom || '',
          description: item.description?.fr || item.description || item.descriptif || '',
          date: dateStr,
          heure: (item.timings?.[0]?.begin || '').split('T')[1]?.substring(0,5) || '',
          lieu: item.location?.name || item.lieu || '',
          adresse: item.location?.address || '',
          commune: item.location?.city || 'Toulouse',
          url: item.canonicalUrl || item.url || item.link || '',
          tarif: item.registration?.[0]?.price ? `${item.registration[0].price}€` : '',
          type: item.keywords?.fr?.[0] || item.type || '',
          categorie: item.categories?.[0] || '',
          source: name
        });
      });
    } else {
      // Format RSS/Atom XML — parser simple sans dépendance
      const extractTag = (xml, tag) => {
        const match = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\/${tag}>`, 'i'));
        return match ? match[1].replace(/<[^>]+>/g, '').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#039;/g,"'").trim() : '';
      };
      const extractAttr = (xml, tag, attr) => {
        const match = xml.match(new RegExp(`<${tag}[^>]*${attr}="([^"]*)"`, 'i'));
        return match ? match[1] : '';
      };

      // Extraire les items RSS
      const itemMatches = [...text.matchAll(/<item>([\s\S]*?)<\/item>/gi)];
      const entryMatches = [...text.matchAll(/<entry>([\s\S]*?)<\/entry>/gi)];
      const allItems = [...itemMatches, ...entryMatches].map(m => m[1]);

      allItems.forEach(item => {
        const title = extractTag(item, 'title');
        const link = extractTag(item, 'link') || extractAttr(item, 'link', 'href');
        const pubDate = extractTag(item, 'pubDate') || extractTag(item, 'published') || extractTag(item, 'dc:date') || '';
        const description = extractTag(item, 'description') || extractTag(item, 'summary') || extractTag(item, 'content');
        
        // Essayer d'extraire une date d'événement du contenu
        let dateStr = '';
        const dateMatch = description.match(/(\d{2})\/(\d{2})\/(\d{4})/);
        if (dateMatch) {
          dateStr = `${dateMatch[3]}-${dateMatch[2]}-${dateMatch[1]}`;
        } else if (pubDate) {
          try { dateStr = new Date(pubDate).toISOString().split('T')[0]; } catch(e) {}
        }

        if (!title || !dateStr) return;
        if (start && dateStr < start) return;
        if (end && dateStr > end) return;

        // Extraire l'heure du contenu
        const heureMatch = description.match(/(\d{1,2})[h:](\d{2})/i);
        const heure = heureMatch ? `${heureMatch[1].padStart(2,'0')}:${heureMatch[2]}` : '';

        // Extraire lieu et tarif du contenu
        const lieuMatch = description.match(/(?:lieu|salle)[^:]{0,5}:?\s*([^<,\n]{3,40})/i);
,]{3,40})/i);
        const tarifMatch = description.match(/(?:tarif|prix|billet)[^:]{0,5}:?\s*([^<\n]{3,30})/i);
]{3,30})/i);

        events.push({
          id: link || Math.random().toString(36).substr(2,9),
          title: title.substring(0, 120),
          description: description.replace(/<[^>]+>/g,'').substring(0, 200),
          date: dateStr,
          heure,
          lieu: lieuMatch?.[1]?.trim() || '',
          adresse: '',
          commune: 'Toulouse',
          url: link,
          tarif: tarifMatch?.[1]?.trim() || '',
          type: 'Événement',
          categorie: '',
          source: name
        });
      });
    }

    console.log(`[RSS Proxy] ${name}: ${events.length} events parsés`);
    res.json({ events, source: name, total: events.length });

  } catch (error) {
    console.error('[RSS Proxy] Erreur:', error.message);
    res.status(500).json({ error: error.message, events: [] });
  }
});

// =================
// HEALTH
// =================

app.get('/', (req, res) => {
  res.json({ name: 'Mon Bureau Backend', version: '2.0.0', status: 'ok', features: ['claude', 'calendar', 'drive', 'contacts', 'maps'] });
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// =================
// SPOTIFY
// =================

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '8611685c700247fe8342ff3e255578de';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '381515c912c3439cb87beb47f4936a4d';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://mon-bureau-backend.onrender.com/auth/spotify/callback';

app.get('/auth/spotify/url', (req, res) => {
  const scopes = ['user-read-private','user-read-email','user-top-read','user-read-currently-playing','user-read-recently-played'];
  const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
    response_type: 'code', client_id: SPOTIFY_CLIENT_ID,
    scope: scopes.join(' '), redirect_uri: SPOTIFY_REDIRECT_URI,
    state: req.query.frontend || ''
  });
  res.json({ url: authUrl });
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send('<h1>Erreur: code manquant</h1>');
  try {
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64') },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI })
    });
    const tokens = await tokenResponse.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);
    const userResponse = await fetch('https://api.spotify.com/v1/me', { headers: { 'Authorization': `Bearer ${tokens.access_token}` } });
    const userData = await userResponse.json();
    const spotifyData = { id: userData.id, email: userData.email, name: userData.display_name || userData.email, picture: userData.images?.[0]?.url, tokens, addedAt: Date.now() };
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Spotify connecté</title></head><body>
<script>
const spotifyData = ${JSON.stringify(spotifyData)};
if (window.opener) { try { window.opener.postMessage({ type: 'SPOTIFY_AUTH_SUCCESS', account: spotifyData }, '*'); } catch(e) {} }
try { localStorage.setItem('pendingSpotifyAuth', JSON.stringify(spotifyData)); } catch(e) {}
setTimeout(() => { window.close(); }, 1500);
</script><p>Spotify connecté ! Fermeture...</p></body></html>`);
  } catch (error) {
    res.send(`<h1>Erreur Spotify</h1><pre>${error.message}</pre>`);
  }
});

app.post('/spotify/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64') },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token })
    });
    res.json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/spotify/top-tracks', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) throw new Error('Authorization header missing');
    const response = await fetch('https://api.spotify.com/v1/me/top/tracks?limit=20&time_range=medium_term', { headers: { 'Authorization': auth } });
    res.json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/spotify/currently-playing', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) throw new Error('Authorization header missing');
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { 'Authorization': auth } });
    if (response.status === 204) return res.json({ is_playing: false });
    res.json(await response.json());
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// =================
// START
// =================

app.listen(PORT, () => {
  console.log(`Mon Bureau Backend v2 - Port ${PORT} - Routes: Claude, Calendar, Drive, Contacts, Maps`);
});
