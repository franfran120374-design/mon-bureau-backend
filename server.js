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
  'https://www.googleapis.com/auth/gmail.modify',
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
// AGENTS IA - Endpoint universel pour tous les agents
// =================

app.post('/agents/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ 
        success: false, 
        error: 'Messages array is required' 
      });
    }

    // Configuration de base pour l'API
    const config = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: messages
    };

    // Ajouter le system prompt si fourni
    if (system) {
      config.system = system;
    }

    console.log('[Agents] Request:', {
      messageCount: messages.length,
      hasSystem: !!system
    });

    // Appel à l'API Anthropic (sans MCP servers - non supporté par l'API standard)
    const message = await anthropic.messages.create(config);

    console.log('[Agents] Response:', {
      contentBlocks: message.content.length,
      usage: message.usage
    });

    // Retourner la réponse complète
    res.json({ 
      success: true, 
      content: message.content,
      usage: message.usage,
      model: message.model,
      stop_reason: message.stop_reason
    });

  } catch (error) {
    console.error('[Agents] Error:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message,
      details: error.error?.message || error.toString()
    });
  }
});

// =================
// ENDPOINTS PROXY POUR LES AGENTS IA
// À ajouter dans server.js après les routes Claude existantes
// =================

// Middleware pour vérifier le token Google et le rafraîchir si nécessaire
async function refreshGoogleToken(tokens) {
  oauth2Client.setCredentials(tokens);
  if (oauth2Client.credentials.expiry_date && oauth2Client.credentials.expiry_date < Date.now()) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    return credentials;
  }
  return tokens;
}

// =================
// SPOTIFY PROXY POUR AGENTS
// =================

app.post('/agents/spotify/search', async (req, res) => {
  try {
    const { query, type = 'track', limit = 10, accessToken } = req.body;
    
    if (!accessToken) {
      return res.status(401).json({ success: false, error: 'Spotify access token required' });
    }

    const params = new URLSearchParams({
      q: query,
      type: type,
      limit: limit.toString(),
      market: 'FR'
    });

    const response = await fetch(`https://api.spotify.com/v1/search?${params}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'Spotify API error');
    }

    console.log('[Agent-Spotify] Search:', query, '→', data.tracks?.items?.length || 0, 'results');
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Agent-Spotify] Search error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/agents/spotify/create-playlist', async (req, res) => {
  try {
    const { name, description, trackUris, accessToken, userId } = req.body;
    
    if (!accessToken || !userId) {
      return res.status(401).json({ success: false, error: 'Spotify credentials required' });
    }

    // Créer la playlist
    const createResponse = await fetch(`https://api.spotify.com/v1/users/${userId}/playlists`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        description: description || 'Créée par Mon Bureau AI',
        public: false
      })
    });

    const playlist = await createResponse.json();
    
    if (!createResponse.ok) {
      throw new Error(playlist.error?.message || 'Failed to create playlist');
    }

    // Ajouter les tracks si fournis
    if (trackUris && trackUris.length > 0) {
      const addResponse = await fetch(`https://api.spotify.com/v1/playlists/${playlist.id}/tracks`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          uris: trackUris
        })
      });

      if (!addResponse.ok) {
        console.warn('[Agent-Spotify] Failed to add tracks to playlist');
      }
    }

    console.log('[Agent-Spotify] Playlist created:', playlist.name, playlist.external_urls.spotify);
    res.json({ 
      success: true, 
      playlist: {
        id: playlist.id,
        name: playlist.name,
        url: playlist.external_urls.spotify,
        tracks: trackUris?.length || 0
      }
    });
  } catch (error) {
    console.error('[Agent-Spotify] Create playlist error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/agents/spotify/recommendations', async (req, res) => {
  try {
    const { seedArtists, seedTracks, seedGenres, limit = 20, accessToken } = req.body;
    
    if (!accessToken) {
      return res.status(401).json({ success: false, error: 'Spotify access token required' });
    }

    const params = new URLSearchParams({
      limit: limit.toString(),
      market: 'FR'
    });

    if (seedArtists?.length) params.append('seed_artists', seedArtists.join(','));
    if (seedTracks?.length) params.append('seed_tracks', seedTracks.join(','));
    if (seedGenres?.length) params.append('seed_genres', seedGenres.join(','));

    const response = await fetch(`https://api.spotify.com/v1/recommendations?${params}`, {
      headers: {
        'Authorization': `Bearer ${accessToken}`
      }
    });

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error?.message || 'Spotify API error');
    }

    console.log('[Agent-Spotify] Recommendations:', data.tracks?.length || 0, 'tracks');
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Agent-Spotify] Recommendations error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// GOOGLE CALENDAR PROXY POUR AGENTS
// =================

app.post('/agents/calendar/list-events', async (req, res) => {
  try {
    const { tokens, maxResults = 10, timeMin, timeMax } = req.body;
    
    if (!tokens) {
      return res.status(401).json({ success: false, error: 'Google tokens required' });
    }

    const refreshedTokens = await refreshGoogleToken(tokens);
    oauth2Client.setCredentials(refreshedTokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const params = {
      calendarId: 'primary',
      maxResults,
      singleEvents: true,
      orderBy: 'startTime'
    };

    if (timeMin) params.timeMin = timeMin;
    if (timeMax) params.timeMax = timeMax;

    const response = await calendar.events.list(params);
    const events = response.data.items || [];

    console.log('[Agent-Calendar] Listed:', events.length, 'events');
    res.json({ 
      success: true, 
      events: events.map(e => ({
        id: e.id,
        summary: e.summary,
        start: e.start?.dateTime || e.start?.date,
        end: e.end?.dateTime || e.end?.date,
        location: e.location,
        description: e.description,
        attendees: e.attendees?.map(a => a.email)
      })),
      tokens: refreshedTokens
    });
  } catch (error) {
    console.error('[Agent-Calendar] List error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/agents/calendar/create-event', async (req, res) => {
  try {
    const { tokens, summary, description, start, end, location, attendees } = req.body;
    
    if (!tokens || !summary || !start || !end) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const refreshedTokens = await refreshGoogleToken(tokens);
    oauth2Client.setCredentials(refreshedTokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const event = {
      summary,
      description,
      start: { dateTime: start, timeZone: 'Europe/Paris' },
      end: { dateTime: end, timeZone: 'Europe/Paris' }
    };

    if (location) event.location = location;
    if (attendees?.length) event.attendees = attendees.map(email => ({ email }));

    const response = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: event
    });

    console.log('[Agent-Calendar] Event created:', response.data.summary);
    res.json({ 
      success: true, 
      event: {
        id: response.data.id,
        summary: response.data.summary,
        htmlLink: response.data.htmlLink,
        start: response.data.start?.dateTime
      },
      tokens: refreshedTokens
    });
  } catch (error) {
    console.error('[Agent-Calendar] Create error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/agents/calendar/find-free-time', async (req, res) => {
  try {
    const { tokens, timeMin, timeMax, duration = 60 } = req.body;
    
    if (!tokens || !timeMin || !timeMax) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const refreshedTokens = await refreshGoogleToken(tokens);
    oauth2Client.setCredentials(refreshedTokens);

    const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

    const response = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        items: [{ id: 'primary' }]
      }
    });

    const busy = response.data.calendars?.primary?.busy || [];
    
    // Calculer les créneaux libres
    const freeSlots = [];
    let currentTime = new Date(timeMin);
    const endTime = new Date(timeMax);

    busy.forEach((busyPeriod, index) => {
      const busyStart = new Date(busyPeriod.start);
      const busyEnd = new Date(busyPeriod.end);
      
      // Créneau libre avant ce busy period
      if (currentTime < busyStart) {
        const slotDuration = (busyStart - currentTime) / (1000 * 60);
        if (slotDuration >= duration) {
          freeSlots.push({
            start: currentTime.toISOString(),
            end: busyStart.toISOString(),
            duration: Math.floor(slotDuration)
          });
        }
      }
      currentTime = busyEnd;
    });

    // Dernier créneau libre
    if (currentTime < endTime) {
      const slotDuration = (endTime - currentTime) / (1000 * 60);
      if (slotDuration >= duration) {
        freeSlots.push({
          start: currentTime.toISOString(),
          end: endTime.toISOString(),
          duration: Math.floor(slotDuration)
        });
      }
    }

    console.log('[Agent-Calendar] Found:', freeSlots.length, 'free slots');
    res.json({ success: true, freeSlots, tokens: refreshedTokens });
  } catch (error) {
    console.error('[Agent-Calendar] Free time error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// GMAIL PROXY POUR AGENTS
// =================

app.post('/agents/gmail/list-messages', async (req, res) => {
  try {
    const { tokens, maxResults = 10, query = '', labelIds = ['INBOX'] } = req.body;
    
    if (!tokens) {
      return res.status(401).json({ success: false, error: 'Google tokens required' });
    }

    const refreshedTokens = await refreshGoogleToken(tokens);
    oauth2Client.setCredentials(refreshedTokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    const response = await gmail.users.messages.list({
      userId: 'me',
      maxResults,
      q: query,
      labelIds
    });

    const messages = response.data.messages || [];
    
    // Récupérer les détails de chaque message
    const detailedMessages = await Promise.all(
      messages.slice(0, maxResults).map(async (msg) => {
        const detail = await gmail.users.messages.get({
          userId: 'me',
          id: msg.id,
          format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date']
        });
        
        const headers = detail.data.payload.headers;
        return {
          id: msg.id,
          threadId: msg.threadId,
          from: headers.find(h => h.name === 'From')?.value,
          to: headers.find(h => h.name === 'To')?.value,
          subject: headers.find(h => h.name === 'Subject')?.value,
          date: headers.find(h => h.name === 'Date')?.value,
          snippet: detail.data.snippet
        };
      })
    );

    console.log('[Agent-Gmail] Listed:', detailedMessages.length, 'messages');
    res.json({ success: true, messages: detailedMessages, tokens: refreshedTokens });
  } catch (error) {
    console.error('[Agent-Gmail] List error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/agents/gmail/send-message', async (req, res) => {
  try {
    const { tokens, to, subject, body, cc, bcc } = req.body;
    
    if (!tokens || !to || !subject || !body) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    const refreshedTokens = await refreshGoogleToken(tokens);
    oauth2Client.setCredentials(refreshedTokens);

    const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

    // Construire le message au format RFC 2822
    let message = [
      `To: ${to}`,
      `Subject: ${subject}`,
    ];
    
    if (cc) message.push(`Cc: ${cc}`);
    if (bcc) message.push(`Bcc: ${bcc}`);
    
    message.push('Content-Type: text/html; charset=utf-8');
    message.push('');
    message.push(body);

    const encodedMessage = Buffer.from(message.join('\n'))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedMessage
      }
    });

    console.log('[Agent-Gmail] Message sent:', response.data.id);
    res.json({ 
      success: true, 
      messageId: response.data.id,
      tokens: refreshedTokens
    });
  } catch (error) {
    console.error('[Agent-Gmail] Send error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// LAST.FM PROXY (pas d'auth nécessaire)
// =================

app.get('/agents/lastfm/:method', async (req, res) => {
  try {
    const { method } = req.params;
    const LASTFM_API_KEY = '58c198bcc66ba74924848228a2fa6935';
    const LASTFM_USER = 'franfran120374';
    
    const params = new URLSearchParams({
      method: `user.${method}`,
      user: LASTFM_USER,
      api_key: LASTFM_API_KEY,
      format: 'json',
      limit: req.query.limit || '10',
      period: req.query.period || 'overall'
    });

    const response = await fetch(`http://ws.audioscrobbler.com/2.0/?${params}`);
    const data = await response.json();

    if (data.error) {
      throw new Error(data.message);
    }

    console.log('[Agent-LastFM]', method, '→', Object.keys(data)[0]);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Agent-LastFM] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// YOUTUBE PROXY (pas d'auth nécessaire)
// =================

app.get('/agents/youtube/search', async (req, res) => {
  try {
    const YOUTUBE_API_KEY = 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    
    const params = new URLSearchParams({
      part: 'snippet',
      q: req.query.q,
      type: 'video',
      maxResults: req.query.maxResults || '5',
      key: YOUTUBE_API_KEY
    });

    const response = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
    const data = await response.json();

    if (data.error) {
      throw new Error(data.error.message);
    }

    console.log('[Agent-YouTube] Search:', req.query.q, '→', data.items?.length, 'videos');
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Agent-YouTube] Error:', error);
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
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });

    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': 'application/rss+xml, application/xml, text/xml, application/json, */*',
        'Accept-Language': 'fr-FR,fr;q=0.9',
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();

    // Parser RSS/XML
    const events = [];
    const isJson = text.trim().startsWith('{') || text.trim().startsWith('[');

    if (!isJson) {
      // Extraire items RSS ou Atom
      const itemRe = /<item>([\s\S]*?)<\/item>/gi;
      const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
      const items = [];
      let m;
      while ((m = itemRe.exec(text)) !== null) items.push(m[1]);
      while ((m = entryRe.exec(text)) !== null) items.push(m[1]);

      items.forEach(item => {
        // Extraire un tag en gérant CDATA
        const get = (tag) => {
          // CDATA
          const cd = item.match(new RegExp('<' + tag + '[^>]*><!\[CDATA\[([\s\S]*?)\]\]><\/' + tag + '>', 'i'));
          if (cd) return cd[1].trim();
          // Texte simple
          const tx = item.match(new RegExp('<' + tag + '[^>]*>([^<]*)<\/' + tag + '>', 'i'));
          return tx ? tx[1].trim() : '';
        };
        const getAttr = (tag, attr) => {
          const a = item.match(new RegExp('<' + tag + '[^>]*' + attr + '="([^"]*)"', 'i'));
          return a ? a[1] : '';
        };

        const title = get('title');
        if (!title) return;

        const link = get('link') || getAttr('link', 'href') || get('guid');
        const desc = (get('description') || get('summary') || get('content:encoded') || get('content'))
          .replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
        const pubDate = get('pubDate') || get('published') || get('dc:date') || get('updated');

        // Chercher la date de l'événement dans description/title
        // Format : Le 23/05/2026, 23 mai 2026, 23 mai, etc.
        let dateStr = '';
        
        // Format DD/MM/YYYY
        const dm1 = desc.match(/(?:le\s+)?(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/i);
        if (dm1) dateStr = `${dm1[3]}-${dm1[2].padStart(2,'0')}-${dm1[1].padStart(2,'0')}`;
        
        // Format "23 mai 2026" ou "23 mai"
        if (!dateStr) {
          const mois = {janvier:'01',février:'02',mars:'03',avril:'04',mai:'05',juin:'06',juillet:'07',août:'08',septembre:'09',octobre:'10',novembre:'11',décembre:'12'};
          const dm2 = (title + ' ' + desc).match(/(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s*(\d{4})?/i);
          if (dm2) {
            const year = dm2[3] || new Date().getFullYear().toString();
            dateStr = `${year}-${mois[dm2[2].toLowerCase()]}-${dm2[1].padStart(2,'0')}`;
          }
        }

        // Format YYYY-MM-DD dans la description
        if (!dateStr) {
          const dm3 = desc.match(/(\d{4})-(\d{2})-(\d{2})/);
          if (dm3) dateStr = `${dm3[1]}-${dm3[2]}-${dm3[3]}`;
        }

        // Fallback : date de publication
        if (!dateStr && pubDate) {
          try { dateStr = new Date(pubDate).toISOString().split('T')[0]; } catch(e) {}
        }

        if (!dateStr) return;

        // Heure
        const hm = (title + ' ' + desc).match(/(\d{1,2})[h:](\d{2})/i);
        const heure = hm ? `${hm[1].padStart(2,'0')}:${hm[2]}` : '';

        // Tarif
        const isFree = /gratuit|entrée libre|libre|sans inscription/i.test(title + ' ' + desc);
        const tarifM = desc.match(/(\d+)\s*€/);
        const tarif = isFree ? 'Gratuit' : (tarifM ? tarifM[0] : '');

        events.push({
          id: link || title + dateStr,
          title: title.substring(0, 150),
          description: desc.substring(0, 250),
          date: dateStr,
          heure,
          horaires: heure ? `${dateStr} à ${heure}` : dateStr,
          lieu: '',
          adresse: '',
          commune: 'Toulouse',
          url: link,
          tarif,
          isGratuit: isFree,
          type: '',
          categorie: '',
          source: name
        });
      });
    }

    // Trier par date
    events.sort((a, b) => (a.date||'').localeCompare(b.date||''));

    console.log('[RSS Proxy]', name + ':', events.length, 'events, url:', url.substring(0,60));
    res.json({ events, source: name, total: events.length });

  } catch (error) {
    console.error('[RSS Proxy] Erreur:', name, error.message);
    res.status(500).json({ error: error.message, events: [] });
  }
});

// =================
// PROXY OPENAGENDA
// =================

const OA_KEY = '0895eaaa77584278ad341e9def08de13';

// Chercher les agendas Toulouse
app.get('/openagenda/agendas', async (req, res) => {
  try {
    const search = req.query.search || 'toulouse';
    const resp = await fetch(`https://api.openagenda.com/v2/agendas?search=${encodeURIComponent(search)}&size=20`, {
      headers: { 'key': OA_KEY, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(8000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Récupérer les événements d'un ou plusieurs agendas
app.get('/openagenda/events', async (req, res) => {
  try {
    const { agendaUid, dateFrom, dateTo, size = 100, keyword } = req.query;
    if (!agendaUid) return res.status(400).json({ error: 'agendaUid requis' });

    const params = new URLSearchParams();
    params.set('size', size);
    params.set('sort', 'timings.start');
    if (dateFrom) params.set('timings[gte]', dateFrom + 'T00:00:00');
    if (dateTo) params.set('timings[lte]', dateTo + 'T23:59:59');
    if (keyword) params.set('search', keyword);

    const url = `https://api.openagenda.com/v2/agendas/${agendaUid}/events?${params}`;
    console.log('[OA] Fetch:', url);

    const resp = await fetch(url, {
      headers: { 'key': OA_KEY, 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      const txt = await resp.text();
      throw new Error(`HTTP ${resp.status}: ${txt.substring(0,100)}`);
    }
    const data = await resp.json();
    console.log(`[OA] ${data.events?.length || 0} events pour agenda ${agendaUid}`);
    res.json(data);
  } catch(e) {
    console.error('[OA] Erreur:', e.message);
    res.status(500).json({ error: e.message, events: [] });
  }
});

// Route combinée : tous les agendas Toulouse en une fois
app.get('/openagenda/toulouse', async (req, res) => {
  try {
    const { dateFrom, dateTo, size = 100 } = req.query;
    console.log('[OA/toulouse] dateFrom:', dateFrom, 'dateTo:', dateTo);

    const TOULOUSE_AGENDAS = [
      { uid: 42448083,  name: 'Toulouse' },
      { uid: 50522407,  name: 'Toulouse Métropole' },
      { uid: 36779486,  name: 'Bibliothèques de Toulouse' },
      { uid: 2342325,   name: 'Muséum de Toulouse' },
      { uid: 96398684,  name: 'Zénith Toulouse' },
      { uid: 92305987,  name: 'Opéra National du Capitole' },
      { uid: 93202109,  name: 'Monuments de Toulouse' },
      { uid: 2417371,   name: 'Centres culturels Toulouse' },
      { uid: 39750428,  name: 'Sport Toulouse' },
      { uid: 4846673,   name: 'Balma' },
      { uid: 59938959,  name: 'Colomiers' },
      { uid: 50781256,  name: 'Launaguet' },
    ];

    // Tester d'abord un seul agenda pour debugger
    const testUrl = `https://api.openagenda.com/v2/agendas/42448083/events?size=3&key=${OA_KEY}`;
    const testResp = await fetch(testUrl, { signal: AbortSignal.timeout(8000) });
    console.log('[OA/toulouse] Test agenda 42448083:', testResp.status);
    const testData = testResp.ok ? await testResp.json() : null;
    console.log('[OA/toulouse] Test events:', testData?.events?.length, testData?.error);

    // Construction URL avec timings
    const buildUrl = (uid) => {
      let url = `https://api.openagenda.com/v2/agendas/${uid}/events?size=${size}&key=${OA_KEY}`;
      if (dateFrom) url += `&timings[gte]=${dateFrom}T00:00:00`;
      if (dateTo) url += `&timings[lte]=${dateTo}T23:59:59`;
      return url;
    };

    // Chercher dans plusieurs agendas séquentiellement pour éviter rate limit
    const results = await Promise.allSettled(
      TOULOUSE_AGENDAS.map(agenda =>
        fetch(buildUrl(agenda.uid), {
          signal: AbortSignal.timeout(10000)
        }).then(r => {
          console.log(`[OA] ${agenda.name}: HTTP ${r.status}`);
          if (!r.ok) return null;
          return r.json();
        }).catch(e => { console.warn(`[OA] ${agenda.name} err:`, e.message); return null; })
      )
    );

    let allEvents = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value?.events?.length) {
        const agenda = TOULOUSE_AGENDAS[i];
        console.log(`[OA] ${agenda.name}: ${result.value.events.length} events`);
        result.value.events.forEach(e => {
          const timing = e.timings?.[0] || {};
          // OpenAgenda v2 : les dates sont dans timing.begin (ISO) ou firstDate
          // Format possible : "2026-05-18T20:00:00+02:00" ou "2026-05-18T20:00:00Z" ou "2026-05-18"
          const beginRaw = timing.begin || timing.start || e.firstDate || e.nextDate || '';
          const dateStr = beginRaw ? beginRaw.substring(0, 10) : '';
          const heure = beginRaw && beginRaw.length > 10 ? beginRaw.substring(11, 16) : '';
          const title = e.title?.fr || e.title?.en || Object.values(e.title||{})[0] || '';
          if (!title) return; // Ignorer events sans titre (pas de filtre sur dateStr)
          const desc = e.description?.fr || Object.values(e.description||{})[0] || '';
          const loc = e.location || {};
          const kw = (e.keywords?.fr || []).concat(e.keywords?.en || []).join(' ');
          allEvents.push({
            id: String(e.uid),
            title,
            description: (desc||'').substring(0, 300),
            date: dateStr,
            heure,
            horaires: heure ? `${dateStr} à ${heure}` : dateStr,
            lieu: loc.name || '',
            adresse: [loc.address, loc.postalCode, loc.city].filter(Boolean).join(', '),
            commune: loc.city || 'Toulouse',
            tarif: e.conditions?.fr || '',
            isGratuit: (e.conditions?.fr || '').toLowerCase().includes('gratuit') ||
                       (e.conditions?.fr || '').toLowerCase().includes('libre') ||
                       (e.conditions?.fr || '').toLowerCase().includes('entrée libre') ||
                       (e.conditions?.fr || '') === '0' ||
                       (e.conditions?.fr || '') === '0€',
            url: e.canonicalUrl || `https://openagenda.com/fr/${e.slug}`,
            keywords: kw,
            image: e.image?.thumbnails?.['600x400'] || e.image?.base || '',
            source: agenda.name,
            payant: !!(e.registration?.length) && !((e.conditions?.fr||'').toLowerCase().includes('gratuit')),
          });
        });
      }
    });

    // Dédupliquer par uid
    const seen = new Set();
    allEvents = allEvents.filter(e => {
      if (seen.has(e.id)) return false;
      seen.add(e.id); return true;
    });

    // Trier par date
    allEvents.sort((a, b) => (a.date||'').localeCompare(b.date||'') || (a.heure||'').localeCompare(b.heure||''));

    console.log(`[OA] Total Toulouse: ${allEvents.length} events`);
    res.json({ events: allEvents, total: allEvents.length });
  } catch(e) {
    console.error('[OA] Erreur toulouse:', e.message);
    res.status(500).json({ error: e.message, events: [] });
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
