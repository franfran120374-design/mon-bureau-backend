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

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json({ limit: '10mb' }));

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
  'https://www.googleapis.com/auth/contacts.readonly'
];

// =================
// ROUTES API CLAUDE
// =================

app.post('/claude/summarize', async (req, res) => {
  try {
    const { text, type } = req.body;
    let prompt = '';
    if (type === 'article') prompt = `Résume cet article en 3 points clés (max 50 mots par point). Sois concis et factuel.\n\nArticle:\n${text}`;
    else if (type === 'note') prompt = `Résume cette note en gardant les informations essentielles.\n\nNote:\n${text}`;
    else if (type === 'meeting') prompt = `Résume cet événement/réunion : quoi, quand, avec qui, objectifs.\n\nÉvénement:\n${text}`;
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 500, messages: [{ role: 'user', content: prompt }] });
    res.json({ success: true, summary: message.content[0].text, usage: message.usage });
  } catch (error) { console.error('Summarize error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.post('/claude/factcheck', async (req, res) => {
  try {
    const { title, content, url } = req.body;
    const prompt = `Tu es un fact-checker expert. Analyse cet article et évalue sa crédibilité.\n\nArticle:\nTitre: ${title}\nURL: ${url}\nContenu: ${content}\n\nFournis une analyse structurée en JSON avec:\n{\n  "score": 0-100,\n  "verdict": "Fiable" | "Douteux" | "Faux" | "Non vérifiable",\n  "points_positifs": [],\n  "points_negatifs": [],\n  "recommandation": "courte phrase"\n}\nRéponds UNIQUEMENT avec le JSON.`;
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: prompt }] });
    let analysis;
    try { analysis = JSON.parse(message.content[0].text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()); }
    catch (e) { analysis = { score: 50, verdict: "Non vérifiable", points_positifs: [], points_negatifs: [], recommandation: "Vérifier manuellement" }; }
    res.json({ success: true, analysis, usage: message.usage });
  } catch (error) { console.error('Fact-check error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.post('/claude/chat', async (req, res) => {
  try {
    const { message: userMessage, context } = req.body;
    let systemPrompt = `Tu es l'assistant personnel de Sandra. Tu as accès à ses données :`;
    if (context?.tasks?.length) systemPrompt += `\n\nTÂCHES EN COURS:\n${context.tasks.join('\n')}`;
    if (context?.events?.length) systemPrompt += `\n\nÉVÉNEMENTS À VENIR:\n${context.events.join('\n')}`;
    if (context?.notes?.length) systemPrompt += `\n\nNOTES RÉCENTES:\n${context.notes.join('\n')}`;
    if (context?.habits?.length) systemPrompt += `\n\nHABITUDES:\n${context.habits.join('\n')}`;
    systemPrompt += `\n\nRéponds de façon concise, bienveillante et actionnable.`;
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 1000, system: systemPrompt, messages: [{ role: 'user', content: userMessage }] });
    res.json({ success: true, reply: message.content[0].text, usage: message.usage });
  } catch (error) { console.error('Chat error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.post('/claude/analyze', async (req, res) => {
  try {
    const { type, data } = req.body;
    let prompt = '';
    if (type === 'tasks') prompt = `Analyse ces tâches et fournis des insights en JSON:\n${JSON.stringify(data, null, 2)}\n\nFormat:\n{"total": nombre, "completed_rate": pourcentage, "patterns": [], "suggestions": []}`;
    else if (type === 'notes') prompt = `Analyse ces notes et extrais les thèmes en JSON:\n${JSON.stringify(data, null, 2)}\n\nFormat:\n{"themes": [], "mood_trend": "positif|neutre|négatif", "key_topics": []}`;
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 800, messages: [{ role: 'user', content: prompt }] });
    let insights;
    try { insights = JSON.parse(message.content[0].text.replace(/```json\n?/g,'').replace(/```\n?/g,'').trim()); }
    catch (e) { insights = { error: "Format inattendu" }; }
    res.json({ success: true, insights, usage: message.usage });
  } catch (error) { console.error('Analyze error:', error); res.status(500).json({ success: false, error: error.message }); }
});

// =================
// AGENTS IA
// =================

app.post('/agents/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ success: false, error: 'Messages array is required' });

    let fullContent = [];
    let currentMessages = [...messages];
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const MAX_TURNS = 5; // Maximum de continuations automatiques

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const config = {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 8000, // Augmenté pour éviter les coupures
        messages: currentMessages
      };
      if (system) config.system = system;

      console.log(`[Agents] Turn ${turn + 1}, messages: ${currentMessages.length}`);
      const message = await anthropic.messages.create(config);

      totalInputTokens += message.usage?.input_tokens || 0;
      totalOutputTokens += message.usage?.output_tokens || 0;

      // Collecter le contenu de ce tour
      const textBlocks = message.content.filter(b => b.type === 'text');
      fullContent.push(...textBlocks);

      // Si stop_reason est 'end_turn' → réponse complète, on s'arrête
      if (message.stop_reason === 'end_turn') {
        console.log(`[Agents] Complet en ${turn + 1} tour(s)`);
        break;
      }

      // Si stop_reason est 'max_tokens' → Claude a été coupé, on continue
      if (message.stop_reason === 'max_tokens') {
        console.log(`[Agents] Coupé à ${turn + 1}, continuation...`);
        // Ajouter la réponse partielle et demander de continuer
        currentMessages = [
          ...currentMessages,
          { role: 'assistant', content: message.content },
          { role: 'user', content: 'Continue.' }
        ];
        continue;
      }

      // Autre stop_reason → on s'arrête
      break;
    }

    // Fusionner tout le texte en une seule réponse
    const mergedText = fullContent.map(b => b.text).join('');

    console.log(`[Agents] Réponse finale: ${mergedText.length} chars, tokens: ${totalOutputTokens}`);
    res.json({
      success: true,
      content: [{ type: 'text', text: mergedText }],
      usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens },
      model: 'claude-sonnet-4-20250514',
      stop_reason: 'end_turn'
    });

  } catch (error) {
    console.error('[Agents] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// PROXY GOOGLE MAPS
// =================

app.post('/proxy/maps', async (req, res) => {
  try {
    const { origin, destination, arrivalTime, mode } = req.body;
    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    const params = new URLSearchParams({ origin: origin || '10 rue Etienne Bacquié, Toulouse', destination, mode: mode || 'transit', key: MAPS_KEY, language: 'fr', region: 'fr' });
    if (arrivalTime) params.set('arrival_time', Math.floor(new Date(arrivalTime).getTime() / 1000));
    const response = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`);
    const data = await response.json();
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') console.error('[Maps] Status:', data.status, data.error_message);
    res.json(data);
  } catch (error) { console.error('Maps proxy error:', error); res.status(500).json({ error: error.message, status: 'ERROR' }); }
});

// =================
// TRAJETS & RAPPELS
// =================

const HOME_ADDRESS = '10 rue Etienne Bacquié, Toulouse';
const DEFAULT_PREP_MINUTES = 10;

app.post('/maps/trajet', async (req, res) => {
  try {
    const { destination, arrivalTime, mode = 'transit', prepMinutes = DEFAULT_PREP_MINUTES } = req.body;
    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    if (!destination) return res.status(400).json({ success: false, error: 'Destination requise' });
    const arrivalTimestamp = arrivalTime ? Math.floor(new Date(arrivalTime).getTime() / 1000) : Math.floor(Date.now() / 1000 + 3600);
    const params = new URLSearchParams({ origin: HOME_ADDRESS, destination, mode, arrival_time: arrivalTimestamp, key: MAPS_KEY, language: 'fr', region: 'fr' });
    let data = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`).then(r => r.json());
    if (data.status !== 'OK') {
      const params2 = new URLSearchParams({ origin: HOME_ADDRESS, destination, mode, departure_time: 'now', key: MAPS_KEY, language: 'fr', region: 'fr' });
      data = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params2}`).then(r => r.json());
    }
    const leg = data.routes?.[0]?.legs?.[0];
    if (!leg) return res.json({ success: false, error: `Maps: ${data.status} - ${data.error_message || ''}` });
    const durationMinutes = Math.ceil((leg.duration_in_traffic?.value || leg.duration?.value || 0) / 60);
    const durationText = leg.duration_in_traffic?.text || leg.duration?.text || `${durationMinutes} min`;
    let rappel = null;
    if (arrivalTime) {
      const departureMs = new Date(arrivalTime).getTime() - (durationMinutes + prepMinutes) * 60000;
      const departureTime = new Date(departureMs);
      const minutesUntilDeparture = Math.round((departureMs - Date.now()) / 60000);
      const departureText = departureTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
      rappel = { departureTime: departureTime.toISOString(), departureText, minutesUntilDeparture, prepMinutes, message: minutesUntilDeparture > 0 ? `Pars dans ${minutesUntilDeparture} min (à ${departureText})` : minutesUntilDeparture === 0 ? 'Pars maintenant !' : `Tu aurais dû partir il y a ${Math.abs(minutesUntilDeparture)} min`, isUrgent: minutesUntilDeparture >= 0 && minutesUntilDeparture <= 15, isLate: minutesUntilDeparture < 0 };
    }
    const steps = (leg.steps || []).slice(0, 5).map(s => ({ instruction: (s.html_instructions || '').replace(/<[^>]+>/g, ''), duration: s.duration?.text || '', distance: s.distance?.text || '', mode: s.travel_mode?.toLowerCase() || mode, transit: s.transit_details ? { line: s.transit_details.line?.short_name || s.transit_details.line?.name || '', from: s.transit_details.departure_stop?.name || '', to: s.transit_details.arrival_stop?.name || '' } : null }));
    console.log(`[Maps/Trajet] ${destination}: ${durationText}, départ: ${rappel?.departureText || 'N/A'}`);
    res.json({ success: true, trajet: { origin: HOME_ADDRESS, destination: leg.end_address || destination, duration: durationText, durationMinutes, distance: leg.distance?.text || '', mode, steps, mapsLink: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(HOME_ADDRESS)}&destination=${encodeURIComponent(destination)}&travelmode=${mode}` }, rappel });
  } catch (error) { console.error('[Maps/Trajet] Error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.post('/maps/trajets-agenda', async (req, res) => {
  try {
    const { events, prepMinutes = DEFAULT_PREP_MINUTES } = req.body;
    if (!events?.length) return res.json({ success: true, trajets: [] });
    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    const withLocation = events.filter(e => e.location?.trim()).slice(0, 5);
    const results = await Promise.allSettled(withLocation.map(async (event) => {
      const params = new URLSearchParams({ origin: HOME_ADDRESS, destination: event.location, mode: 'transit', language: 'fr', region: 'fr', key: MAPS_KEY });
      if (event.start) params.set('arrival_time', Math.floor(new Date(event.start).getTime() / 1000));
      const data = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`).then(r => r.json());
      const leg = data.routes?.[0]?.legs?.[0];
      if (!leg) return null;
      const durationMinutes = Math.ceil((leg.duration?.value || 0) / 60);
      let departureTime = null, minutesUntilDeparture = null, departureText = '';
      if (event.start) {
        const departureMs = new Date(event.start).getTime() - (durationMinutes + prepMinutes) * 60000;
        departureTime = new Date(departureMs);
        minutesUntilDeparture = Math.round((departureMs - Date.now()) / 60000);
        departureText = departureTime.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
      }
      return { eventId: event.id, eventTitle: event.summary || event.title || '', destination: event.location, duration: leg.duration?.text, durationMinutes, distance: leg.distance?.text, mapsLink: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(HOME_ADDRESS)}&destination=${encodeURIComponent(event.location)}&travelmode=transit`, departureTime: departureTime?.toISOString(), departureText, minutesUntilDeparture, isUrgent: minutesUntilDeparture !== null && minutesUntilDeparture >= 0 && minutesUntilDeparture <= 15, isLate: minutesUntilDeparture !== null && minutesUntilDeparture < 0 };
    }));
    const trajets = results.filter(r => r.status === 'fulfilled' && r.value).map(r => r.value);
    console.log(`[Maps/Agenda] ${trajets.length} trajets calculés`);
    res.json({ success: true, trajets });
  } catch (error) { console.error('[Maps/Agenda] Error:', error); res.status(500).json({ success: false, error: error.message }); }
});

// =================
// MÉTÉO (Open-Meteo)
// =================

const TOULOUSE_LAT = 43.6047;
const TOULOUSE_LON = 1.4442;

app.get('/meteo/actuelle', async (req, res) => {
  try {
    const params = new URLSearchParams({ latitude: TOULOUSE_LAT, longitude: TOULOUSE_LON, current_weather: true, hourly: 'temperature_2m,precipitation,precipitation_probability,apparent_temperature,uv_index,direct_radiation,windspeed_10m,weathercode,snowfall', forecast_days: 1, timezone: 'Europe/Paris' });
    const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
    const data = await response.json();
    console.log('[Météo] Actuelle récupérée');
    res.json({ success: true, data });
  } catch(error) { console.error('[Météo] Error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.get('/meteo/heure', async (req, res) => {
  try {
    const { datetime } = req.query;
    if (!datetime) return res.status(400).json({ success: false, error: 'datetime requis' });
    const targetTime = new Date(datetime);
    const params = new URLSearchParams({ latitude: TOULOUSE_LAT, longitude: TOULOUSE_LON, hourly: 'temperature_2m,precipitation,precipitation_probability,apparent_temperature,uv_index,direct_radiation,windspeed_10m,weathercode,snowfall', forecast_days: 2, timezone: 'Europe/Paris' });
    const data = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`).then(r => r.json());
    const hours = data.hourly.time;
    let bestIdx = 0, bestDiff = Infinity;
    hours.forEach((t, i) => { const diff = Math.abs(new Date(t) - targetTime); if (diff < bestDiff) { bestDiff = diff; bestIdx = i; } });
    const meteo = { time: hours[bestIdx], temperature: data.hourly.temperature_2m[bestIdx], apparentTemp: data.hourly.apparent_temperature[bestIdx], precipitation: data.hourly.precipitation[bestIdx], precipProb: data.hourly.precipitation_probability[bestIdx], windspeed: data.hourly.windspeed_10m[bestIdx], snowfall: data.hourly.snowfall[bestIdx], uvIndex: data.hourly.uv_index[bestIdx], radiation: data.hourly.direct_radiation[bestIdx], weathercode: data.hourly.weathercode[bestIdx] };
    console.log(`[Météo] Heure ${datetime}: ${meteo.temperature}°C, pluie: ${meteo.precipProb}%`);
    res.json({ success: true, meteo });
  } catch(error) { console.error('[Météo] Heure error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.post('/meteo/conseils-rdv', async (req, res) => {
  try {
    const { eventTitle, departTime, destination } = req.body;
    if (!departTime) return res.status(400).json({ success: false, error: 'departTime requis' });
    const params = new URLSearchParams({ latitude: TOULOUSE_LAT, longitude: TOULOUSE_LON, hourly: 'temperature_2m,precipitation,precipitation_probability,apparent_temperature,uv_index,direct_radiation,windspeed_10m,weathercode,snowfall', forecast_days: 2, timezone: 'Europe/Paris' });
    const data = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`).then(r => r.json());
    const targetTime = new Date(departTime);
    const hours = data.hourly.time;
    let bestIdx = 0, bestDiff = Infinity;
    hours.forEach((t, i) => { const diff = Math.abs(new Date(t) - targetTime); if (diff < bestDiff) { bestDiff = diff; bestIdx = i; } });
    const meteo = { temperature: data.hourly.temperature_2m[bestIdx], apparentTemp: data.hourly.apparent_temperature[bestIdx], precipitation: data.hourly.precipitation[bestIdx], precipProb: data.hourly.precipitation_probability[bestIdx], windspeed: data.hourly.windspeed_10m[bestIdx], snowfall: data.hourly.snowfall[bestIdx], uvIndex: data.hourly.uv_index[bestIdx], radiation: data.hourly.direct_radiation[bestIdx], weathercode: data.hourly.weathercode[bestIdx] };
    const conseils = [];
    if (meteo.precipitation >= 0.3 || meteo.precipProb >= 70) conseils.push({ icon: '☂️', item: 'Parapluie', raison: `${meteo.precipProb}% de risque de pluie` });
    else if (meteo.precipProb >= 40) conseils.push({ icon: '🌂', item: 'Imperméable léger', raison: `${meteo.precipProb}% risque de bruine` });
    if (meteo.snowfall >= 0.1) conseils.push({ icon: '🥾', item: 'Bottes imperméables', raison: 'Neige prévue' });
    if (meteo.uvIndex >= 5) conseils.push({ icon: '🧴', item: 'Crème solaire', raison: `UV ${Math.round(meteo.uvIndex)}` });
    if (meteo.radiation >= 700 || meteo.uvIndex >= 4) conseils.push({ icon: '🕶️', item: 'Lunettes de soleil', raison: 'Fort ensoleillement' });
    const temp = meteo.apparentTemp ?? meteo.temperature;
    if (temp <= 10) conseils.push({ icon: '🧥', item: 'Manteau chaud', raison: `${Math.round(temp)}°C ressentis` });
    else if (temp <= 16) conseils.push({ icon: '🧣', item: 'Veste', raison: `${Math.round(temp)}°C, temps frais` });
    if (meteo.windspeed >= 30) conseils.push({ icon: '💨', item: 'Coupe-vent', raison: `Vent ${Math.round(meteo.windspeed)} km/h` });
    const codes = { 0:'☀️ Ciel dégagé', 1:'🌤️ Dégagé', 2:'⛅ Nuageux', 3:'☁️ Couvert', 51:'🌦️ Bruine', 61:'🌧️ Pluie légère', 63:'🌧️ Pluie', 65:'🌧️ Pluie forte', 71:'❄️ Neige', 80:'🌦️ Averses', 95:'⛈️ Orage' };
    const desc = codes[meteo.weathercode] || '🌡️ Variable';
    console.log(`[Météo] Conseils RDV "${eventTitle}": ${conseils.length} conseils`);
    res.json({ success: true, eventTitle, departTime, meteo: { ...meteo, temperature: Math.round(meteo.temperature), apparentTemp: Math.round(meteo.apparentTemp) }, desc, conseils, resume: conseils.length ? `${desc} · ${Math.round(temp)}°C · Pense à : ${conseils.map(c => c.item).join(', ')}` : `${desc} · ${Math.round(temp)}°C · Aucun équipement spécial nécessaire ✅` });
  } catch(error) { console.error('[Météo] Conseils error:', error); res.status(500).json({ success: false, error: error.message }); }
});

// =================
// CONTACTS (People API)
// =================

app.get('/contacts/search', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const people = google.people({ version: 'v1', auth });
    const response = await people.people.searchContacts({ query: req.query.q || '', readMask: 'names,emailAddresses', pageSize: 10 });
    const contacts = (response.data.results || []).map(r => ({ name: r.person?.names?.[0]?.displayName || '', email: r.person?.emailAddresses?.[0]?.value || '' })).filter(c => c.email);
    res.json({ contacts, tokens: auth.credentials });
  } catch (error) { console.error('Contacts search error:', error); res.status(500).json({ contacts: [], error: error.message }); }
});

// =================
// ROUTES OAuth Google
// =================

app.get('/auth/google/url', (req, res) => {
  const authUrl = oauth2Client.generateAuthUrl({ access_type: 'offline', scope: SCOPES, prompt: 'consent', state: req.query.frontend || '' });
  res.json({ url: authUrl });
});

app.get('/auth/google/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h1>Erreur: code manquant</h1>');
  try {
    const { tokens } = await oauth2Client.getToken(code);
    oauth2Client.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    const accountData = { id: data.id, email: data.email, name: data.name || data.email, picture: data.picture, tokens, addedAt: Date.now() };
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connexion réussie</title><style>body{font-family:system-ui,sans-serif;padding:40px;text-align:center;background:#f5f5f5}.card{background:white;padding:30px;border-radius:12px;max-width:400px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,.1)}h1{color:#22c55e;margin:0 0 10px}</style></head><body><div class="card"><h1>✓ Connecté</h1><h2>${data.name || data.email}</h2><p>${data.email}</p></div><script>const accountData=${JSON.stringify(accountData)};if(window.opener){try{window.opener.postMessage({type:'GOOGLE_AUTH_SUCCESS',account:accountData},'*');}catch(e){}}try{localStorage.setItem('pendingGoogleAuth',JSON.stringify(accountData));}catch(e){}setTimeout(()=>{window.close();},1500);</script></body></html>`);
  } catch (error) { console.error('Auth error:', error); res.send(`<h1>Erreur</h1><pre>${error.message}</pre>`); }
});

// =================
// Helper functions
// =================

function getAuthClient(tokens) {
  if (!tokens) throw new Error('Tokens manquants');
  const client = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, REDIRECT_URI);
  client.setCredentials(tokens);
  return client;
}

function getTokensFromRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) throw new Error('Header Authorization manquant');
  try { return JSON.parse(Buffer.from(auth.substring(7), 'base64').toString('utf8')); }
  catch (e) { throw new Error('Tokens invalides'); }
}

// =================
// CALENDAR
// =================

app.get('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
      const { credentials } = await auth.refreshAccessToken();
      auth.setCredentials(credentials);
    }
    const calendar = google.calendar({ version: 'v3', auth });
    const params = {
      calendarId: 'primary',
      timeMin: req.query.timeMin || new Date().toISOString(),
      maxResults: parseInt(req.query.maxResults) || 50,
      singleEvents: true,
      orderBy: 'startTime'
    };
    if (req.query.timeMax) params.timeMax = req.query.timeMax;
    const response = await calendar.events.list(params);
    res.json({ events: response.data.items, tokens: auth.credentials });
  } catch (error) { console.error('Calendar list error:', error.message); res.status(500).json({ error: error.message }); }
});

app.post('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
      const { credentials } = await auth.refreshAccessToken();
      auth.setCredentials(credentials);
    }
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.insert({ calendarId: 'primary', requestBody: req.body });
    res.json({ event: event.data, tokens: auth.credentials });
  } catch (error) { console.error('Calendar create error:', error.message); res.status(500).json({ error: error.message }); }
});

app.delete('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
      const { credentials } = await auth.refreshAccessToken();
      auth.setCredentials(credentials);
    }
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId: req.params.eventId });
    res.json({ success: true, tokens: auth.credentials });
  } catch (error) { console.error('Calendar delete error:', error.message); res.status(500).json({ error: error.message }); }
});

app.patch('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);

    // Refresh automatique si token expiré
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) {
      const { credentials } = await auth.refreshAccessToken();
      auth.setCredentials(credentials);
    }

    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.patch({
      calendarId: 'primary',
      eventId: req.params.eventId,
      requestBody: req.body  // ← requestBody au lieu de resource (API v3)
    });
    res.json({ event: event.data, tokens: auth.credentials });
  } catch (error) {
    console.error('Calendar update error:', error.message);
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
    const response = await drive.files.list({ pageSize: parseInt(req.query.pageSize) || 20, fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)', q: req.query.query || "trashed=false", orderBy: 'modifiedTime desc' });
    res.json({ files: response.data.files, tokens: auth.credentials });
  } catch (error) { console.error('Drive list error:', error); res.status(500).json({ error: error.message }); }
});

app.get('/drive/search', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.list({ pageSize: 20, fields: 'files(id, name, mimeType, modifiedTime, webViewLink)', q: `name contains '${req.query.q}' and trashed=false` });
    res.json({ files: response.data.files, tokens: auth.credentials });
  } catch (error) { console.error('Drive search error:', error); res.status(500).json({ error: error.message }); }
});

app.post('/drive/upload', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const file = await drive.files.create({ resource: { name: req.body.fileName }, media: { mimeType: req.body.mimeType || 'text/plain', body: req.body.content }, fields: 'id, name, webViewLink' });
    res.json({ file: file.data, tokens: auth.credentials });
  } catch (error) { console.error('Drive upload error:', error); res.status(500).json({ error: error.message }); }
});

app.get('/drive/download/:fileId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.get({ fileId: req.params.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    res.json({ content: Buffer.from(response.data).toString('base64'), tokens: auth.credentials });
  } catch (error) { console.error('Drive download error:', error); res.status(500).json({ error: error.message }); }
});

app.post('/drive/create-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const folder = await drive.files.create({ resource: { name: req.body.folderName, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id, name, webViewLink' });
    res.json({ folder: folder.data, tokens: auth.credentials });
  } catch (error) { console.error('Drive create folder error:', error); res.status(500).json({ error: error.message }); }
});

// =================
// PROXY RSS
// =================

app.post('/proxy/rss', async (req, res) => {
  try {
    const { url, name } = req.body;
    if (!url) return res.status(400).json({ error: 'URL manquante' });
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/rss+xml, application/xml, text/xml, */*', 'Accept-Language': 'fr-FR,fr;q=0.9' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const events = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
    const items = [];
    let m;
    while ((m = itemRe.exec(text)) !== null) items.push(m[1]);
    while ((m = entryRe.exec(text)) !== null) items.push(m[1]);
    items.forEach(item => {
      const get = (tag) => { const cd = item.match(new RegExp('<' + tag + '[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/' + tag + '>', 'i')); if (cd) return cd[1].trim(); const tx = item.match(new RegExp('<' + tag + '[^>]*>([^<]*)<\\/' + tag + '>', 'i')); return tx ? tx[1].trim() : ''; };
      const getAttr = (tag, attr) => { const a = item.match(new RegExp('<' + tag + '[^>]*' + attr + '="([^"]*)"', 'i')); return a ? a[1] : ''; };
      const title = get('title'); if (!title) return;
      const link = get('link') || getAttr('link', 'href') || get('guid');
      const desc = (get('description') || get('summary') || get('content')).replace(/<[^>]+>/g, ' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
      const pubDate = get('pubDate') || get('published') || get('updated');
      let dateStr = '';
      const dm1 = desc.match(/(?:le\s+)?(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{4})/i);
      if (dm1) dateStr = `${dm1[3]}-${dm1[2].padStart(2,'0')}-${dm1[1].padStart(2,'0')}`;
      if (!dateStr) { const mois = {janvier:'01',février:'02',mars:'03',avril:'04',mai:'05',juin:'06',juillet:'07',août:'08',septembre:'09',octobre:'10',novembre:'11',décembre:'12'}; const dm2 = (title+' '+desc).match(/(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)\s*(\d{4})?/i); if (dm2) { const year = dm2[3] || new Date().getFullYear().toString(); dateStr = `${year}-${mois[dm2[2].toLowerCase()]}-${dm2[1].padStart(2,'0')}`; } }
      if (!dateStr) { const dm3 = desc.match(/(\d{4})-(\d{2})-(\d{2})/); if (dm3) dateStr = `${dm3[1]}-${dm3[2]}-${dm3[3]}`; }
      if (!dateStr && pubDate) { try { dateStr = new Date(pubDate).toISOString().split('T')[0]; } catch(e) {} }
      if (!dateStr) return;
      const hm = (title+' '+desc).match(/(\d{1,2})[h:](\d{2})/i);
      const heure = hm ? `${hm[1].padStart(2,'0')}:${hm[2]}` : '';
      const isFree = /gratuit|entrée libre|libre|sans inscription/i.test(title+' '+desc);
      const tarifM = desc.match(/(\d+)\s*€/);
      events.push({ id: link || title+dateStr, title: title.substring(0,150), description: desc.substring(0,250), date: dateStr, heure, horaires: heure ? `${dateStr} à ${heure}` : dateStr, lieu: '', adresse: '', commune: 'Toulouse', url: link, tarif: isFree ? 'Gratuit' : (tarifM ? tarifM[0] : ''), isGratuit: isFree, source: name });
    });
    events.sort((a, b) => (a.date||'').localeCompare(b.date||''));
    console.log('[RSS Proxy]', name + ':', events.length, 'events');
    res.json({ events, source: name, total: events.length });
  } catch (error) { console.error('[RSS Proxy] Erreur:', name, error.message); res.status(500).json({ error: error.message, events: [] }); }
});

// =================
// OPENAGENDA
// =================

const OA_KEY = '0895eaaa77584278ad341e9def08de13';

app.get('/openagenda/agendas', async (req, res) => {
  try {
    const resp = await fetch(`https://api.openagenda.com/v2/agendas?search=${encodeURIComponent(req.query.search || 'toulouse')}&size=20`, { headers: { 'key': OA_KEY, 'Accept': 'application/json' }, signal: AbortSignal.timeout(8000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    res.json(await resp.json());
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/openagenda/events', async (req, res) => {
  try {
    const { agendaUid, dateFrom, dateTo, size = 100, keyword } = req.query;
    if (!agendaUid) return res.status(400).json({ error: 'agendaUid requis' });
    const params = new URLSearchParams();
    params.set('size', size); params.set('sort', 'timings.start');
    if (dateFrom) params.set('timings[gte]', dateFrom + 'T00:00:00');
    if (dateTo) params.set('timings[lte]', dateTo + 'T23:59:59');
    if (keyword) params.set('search', keyword);
    const resp = await fetch(`https://api.openagenda.com/v2/agendas/${agendaUid}/events?${params}`, { headers: { 'key': OA_KEY, 'Accept': 'application/json' }, signal: AbortSignal.timeout(10000) });
    if (!resp.ok) { const txt = await resp.text(); throw new Error(`HTTP ${resp.status}: ${txt.substring(0,100)}`); }
    res.json(await resp.json());
  } catch(e) { console.error('[OA] Erreur:', e.message); res.status(500).json({ error: e.message, events: [] }); }
});

app.get('/openagenda/toulouse', async (req, res) => {
  try {
    const { dateFrom, dateTo, size = 100 } = req.query;
    const TOULOUSE_AGENDAS = [
      { uid: 42448083, name: 'Toulouse' }, { uid: 50522407, name: 'Toulouse Métropole' },
      { uid: 36779486, name: 'Bibliothèques de Toulouse' }, { uid: 2342325, name: 'Muséum de Toulouse' },
      { uid: 96398684, name: 'Zénith Toulouse' }, { uid: 92305987, name: 'Opéra National du Capitole' },
      { uid: 93202109, name: 'Monuments de Toulouse' }, { uid: 2417371, name: 'Centres culturels Toulouse' },
      { uid: 39750428, name: 'Sport Toulouse' }, { uid: 4846673, name: 'Balma' },
      { uid: 59938959, name: 'Colomiers' }, { uid: 50781256, name: 'Launaguet' }
    ];
    const buildUrl = (uid) => { let url = `https://api.openagenda.com/v2/agendas/${uid}/events?size=${size}&key=${OA_KEY}`; if (dateFrom) url += `&timings[gte]=${dateFrom}T00:00:00`; if (dateTo) url += `&timings[lte]=${dateTo}T23:59:59`; return url; };
    const results = await Promise.allSettled(TOULOUSE_AGENDAS.map(agenda => fetch(buildUrl(agenda.uid), { signal: AbortSignal.timeout(10000) }).then(r => { if (!r.ok) return null; return r.json(); }).catch(e => null)));
    let allEvents = [];
    results.forEach((result, i) => {
      if (result.status === 'fulfilled' && result.value?.events?.length) {
        const agenda = TOULOUSE_AGENDAS[i];
        result.value.events.forEach(e => {
          const timing = e.timings?.[0] || {};
          const beginRaw = timing.begin || timing.start || e.firstDate || e.nextDate || '';
          const dateStr = beginRaw ? beginRaw.substring(0, 10) : '';
          const heure = beginRaw && beginRaw.length > 10 ? beginRaw.substring(11, 16) : '';
          const title = e.title?.fr || e.title?.en || Object.values(e.title||{})[0] || '';
          if (!title) return;
          const desc = e.description?.fr || Object.values(e.description||{})[0] || '';
          const loc = e.location || {};
          allEvents.push({ id: String(e.uid), title, description: (desc||'').substring(0,300), date: dateStr, heure, horaires: heure ? `${dateStr} à ${heure}` : dateStr, lieu: loc.name || '', adresse: [loc.address, loc.postalCode, loc.city].filter(Boolean).join(', '), commune: loc.city || 'Toulouse', tarif: e.conditions?.fr || '', isGratuit: (e.conditions?.fr||'').toLowerCase().includes('gratuit'), url: e.canonicalUrl || `https://openagenda.com/fr/${e.slug}`, image: e.image?.thumbnails?.['600x400'] || e.image?.base || '', source: agenda.name });
        });
      }
    });
    const seen = new Set();
    allEvents = allEvents.filter(e => { if (seen.has(e.id)) return false; seen.add(e.id); return true; });
    allEvents.sort((a, b) => (a.date||'').localeCompare(b.date||'') || (a.heure||'').localeCompare(b.heure||''));
    console.log(`[OA] Total Toulouse: ${allEvents.length} events`);
    res.json({ events: allEvents, total: allEvents.length });
  } catch(e) { console.error('[OA] Erreur toulouse:', e.message); res.status(500).json({ error: e.message, events: [] }); }
});

// =================
// SPOTIFY
// =================

const SPOTIFY_CLIENT_ID = process.env.SPOTIFY_CLIENT_ID || '8611685c700247fe8342ff3e255578de';
const SPOTIFY_CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET || '381515c912c3439cb87beb47f4936a4d';
const SPOTIFY_REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI || 'https://mon-bureau-backend.onrender.com/auth/spotify/callback';

app.get('/auth/spotify/url', (req, res) => {
  const scopes = ['user-read-private','user-read-email','user-top-read','user-read-currently-playing','user-read-recently-played'];
  const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({ response_type: 'code', client_id: SPOTIFY_CLIENT_ID, scope: scopes.join(' '), redirect_uri: SPOTIFY_REDIRECT_URI, state: req.query.frontend || '' });
  res.json({ url: authUrl });
});

app.get('/auth/spotify/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('<h1>Erreur: code manquant</h1>');
  try {
    const tokenResponse = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64') }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: SPOTIFY_REDIRECT_URI }) });
    const tokens = await tokenResponse.json();
    if (tokens.error) throw new Error(tokens.error_description || tokens.error);
    const userData = await fetch('https://api.spotify.com/v1/me', { headers: { 'Authorization': `Bearer ${tokens.access_token}` } }).then(r => r.json());
    const spotifyData = { id: userData.id, email: userData.email, name: userData.display_name || userData.email, picture: userData.images?.[0]?.url, tokens, addedAt: Date.now() };
    res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Spotify connecté</title></head><body><script>const spotifyData=${JSON.stringify(spotifyData)};if(window.opener){try{window.opener.postMessage({type:'SPOTIFY_AUTH_SUCCESS',account:spotifyData},'*');}catch(e){}}try{localStorage.setItem('pendingSpotifyAuth',JSON.stringify(spotifyData));}catch(e){}setTimeout(()=>{window.close();},1500);</script><p>Spotify connecté !</p></body></html>`);
  } catch (error) { res.send(`<h1>Erreur Spotify</h1><pre>${error.message}</pre>`); }
});

app.post('/spotify/refresh', async (req, res) => {
  try {
    const { refresh_token } = req.body;
    const response = await fetch('https://accounts.spotify.com/api/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(SPOTIFY_CLIENT_ID + ':' + SPOTIFY_CLIENT_SECRET).toString('base64') }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token }) });
    res.json(await response.json());
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/spotify/top-tracks', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) throw new Error('Authorization header missing');
    const response = await fetch('https://api.spotify.com/v1/me/top/tracks?limit=20&time_range=medium_term', { headers: { 'Authorization': auth } });
    res.json(await response.json());
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/spotify/currently-playing', async (req, res) => {
  try {
    const auth = req.headers.authorization;
    if (!auth) throw new Error('Authorization header missing');
    const response = await fetch('https://api.spotify.com/v1/me/player/currently-playing', { headers: { 'Authorization': auth } });
    if (response.status === 204) return res.json({ is_playing: false });
    res.json(await response.json());
  } catch (error) { res.status(500).json({ error: error.message }); }
});

// =================

// =================
// CINÉMA INDÉPENDANT TOULOUSE - Endpoints backend
// À ajouter dans server.js avant la section HEALTH & START
// =================

// Cinémas indépendants Toulouse
const CINEMAS_INDEPENDANTS = {
  abc: {
    name: 'Cinéma ABC',
    address: '13 rue Saint-Bernard, Toulouse',
    url: 'https://www.abc-toulouse.fr',
    programmeUrl: 'https://www.abc-toulouse.fr/programme',
    lat: 43.6048,
    lon: 1.4431,
    style: 'Art et essai, films engagés, documentaires'
  },
  cosmograph: {
    name: 'Cosmograph',
    address: '10 rue Peyrolières, Toulouse',
    url: 'https://cosmograph.fr',
    programmeUrl: 'https://cosmograph.fr/programme',
    lat: 43.6005,
    lon: 1.4431,
    style: 'Cinéma du monde, films rares, répertoire'
  },
  cratere: {
    name: 'Le Cratère',
    address: '95 allées Jules Guesde, Toulouse',
    url: 'https://www.lecratere.fr',
    programmeUrl: 'https://www.lecratere.fr/programme',
    lat: 43.5964,
    lon: 1.4474,
    style: 'Art et essai, jeune public, animations'
  },
  veo: {
    name: 'Véo',
    address: '15 rue de la Pomme, Toulouse',
    url: 'https://www.veo-cinema.fr',
    programmeUrl: 'https://www.veo-cinema.fr/programme',
    lat: 43.5996,
    lon: 1.4449,
    style: 'Films indépendants, avant-premières, répertoire'
  }
};

// Infos statiques des cinémas (pas de scraping - APIs publiques)
app.get('/cinema/infos', (req, res) => {
  res.json({
    success: true,
    cinemas: Object.entries(CINEMAS_INDEPENDANTS).map(([id, c]) => ({
      id,
      name: c.name,
      address: c.address,
      url: c.url,
      programmeUrl: c.programmeUrl,
      style: c.style,
      mapsLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name + ' ' + c.address)}`
    }))
  });
});

// Recherche AlloCiné pour les séances (cinémas indépendants Toulouse)
app.get('/cinema/seances', async (req, res) => {
  try {
    const { date } = req.query;
    const targetDate = date || new Date().toISOString().split('T')[0];

    // Utiliser l'API AlloCiné (format non-officiel mais fonctionnel)
    // Codes AlloCiné des cinémas indépendants Toulouse :
    const allocineCodes = {
      abc: 'P0048',        // ABC Toulouse
      cosmograph: 'P2607', // Cosmograph
      cratere: 'P0217',    // Le Cratère
      veo: 'P2171'         // Véo
    };

    const results = await Promise.allSettled(
      Object.entries(allocineCodes).map(async ([id, code]) => {
        try {
          const url = `https://www.allocine.fr/_/showtimes/theater-${code}/d-${targetDate}/`;
          const response = await fetch(url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
              'Accept': 'application/json, text/plain, */*',
              'Accept-Language': 'fr-FR,fr;q=0.9'
            },
            signal: AbortSignal.timeout(8000)
          });

          if (!response.ok) return { id, films: [], error: `HTTP ${response.status}` };

          const data = await response.json();
          const cinema = CINEMAS_INDEPENDANTS[id];

          const films = (data.results || []).map(item => ({
            titre: item.movie?.title || '',
            titreOriginal: item.movie?.originalTitle || '',
            duree: item.movie?.runtime ? `${Math.floor(item.movie.runtime / 60)}h${item.movie.runtime % 60}` : '',
            synopsis: item.movie?.synopsis?.substring(0, 200) || '',
            note: item.movie?.stats?.userRating?.score || null,
            affiche: item.movie?.poster?.url || null,
            genres: (item.movie?.genres || []).map(g => g.tag).join(', '),
            seances: (item.showtimes?.dubbed || item.showtimes?.original || []).map(s => ({
              heure: s.startsAt ? new Date(s.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '',
              version: s.tags?.includes('vf') ? 'VF' : 'VO'
            })).filter(s => s.heure)
          })).filter(f => f.titre && f.seances.length > 0);

          return {
            id,
            cinema: { name: cinema.name, address: cinema.address, style: cinema.style, url: cinema.url },
            films,
            date: targetDate
          };

        } catch(e) {
          return { id, films: [], error: e.message };
        }
      })
    );

    const seances = results
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value)
      .filter(r => !r.error || r.films?.length > 0);

    console.log(`[Cinéma] Séances du ${targetDate}: ${seances.reduce((a, c) => a + (c.films?.length || 0), 0)} films`);
    res.json({ success: true, date: targetDate, cinemas: seances });

  } catch(error) {
    console.error('[Cinéma] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Films recommandés selon les dispos du calendrier
app.post('/cinema/recommande', async (req, res) => {
  try {
    const { tokens, date, googleTokens } = req.body;
    const targetDate = date || new Date().toISOString().split('T')[0];

    // 1. Récupérer les séances
    const seancesResp = await fetch(`http://localhost:${process.env.PORT || 3000}/cinema/seances?date=${targetDate}`);
    const seancesData = await seancesResp.json();

    let dispos = null;

    // 2. Si tokens Google fournis, récupérer les dispos du calendrier
    if (googleTokens) {
      try {
        const auth = getAuthClient(googleTokens);
        const calendar = google.calendar({ version: 'v3', auth });
        const dayStart = new Date(targetDate + 'T00:00:00+02:00');
        const dayEnd = new Date(targetDate + 'T23:59:59+02:00');

        const eventsResp = await calendar.events.list({
          calendarId: 'primary',
          timeMin: dayStart.toISOString(),
          timeMax: dayEnd.toISOString(),
          singleEvents: true,
          orderBy: 'startTime'
        });

        const events = eventsResp.data.items || [];
        // Créneaux occupés
        const occupes = events.map(e => ({
          debut: new Date(e.start?.dateTime || e.start?.date),
          fin: new Date(e.end?.dateTime || e.end?.date),
          titre: e.summary
        }));
        dispos = { events: occupes };

      } catch(e) {
        console.warn('[Cinéma] Pas de tokens calendar:', e.message);
      }
    }

    // 3. Filtrer les séances selon les dispos
    const recommandations = [];

    (seancesData.cinemas || []).forEach(cinema => {
      (cinema.films || []).forEach(film => {
        const seancesDispo = film.seances.filter(s => {
          if (!dispos?.events?.length) return true;

          const [h, m] = s.heure.split(':').map(Number);
          const seanceDebut = new Date(targetDate);
          seanceDebut.setHours(h, m, 0);
          const seanceFin = new Date(seanceDebut.getTime() + 120 * 60000); // +2h approx

          // Vérifier qu'aucun event ne chevauche
          return !dispos.events.some(ev =>
            ev.debut < seanceFin && ev.fin > seanceDebut
          );
        });

        if (seancesDispo.length > 0) {
          recommandations.push({
            cinema: cinema.cinema.name,
            cinemaUrl: cinema.cinema.url,
            cinemaStyle: cinema.cinema.style,
            titre: film.titre,
            titreOriginal: film.titreOriginal,
            duree: film.duree,
            note: film.note,
            genres: film.genres,
            synopsis: film.synopsis,
            seancesDispo,
            seancesTotal: film.seances
          });
        }
      });
    });

    // Trier par note décroissante
    recommandations.sort((a, b) => (b.note || 0) - (a.note || 0));

    console.log(`[Cinéma/Recommande] ${recommandations.length} films disponibles le ${targetDate}`);
    res.json({
      success: true,
      date: targetDate,
      hasCalendar: !!dispos,
      recommandations: recommandations.slice(0, 10)
    });

  } catch(error) {
    console.error('[Cinéma/Recommande] Error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});


// =================
// DRIVE AGENT - Endpoints backend
// À ajouter dans server.js avant HEALTH & START
// =================

// Rechercher un dossier Drive par nom
app.get('/drive/search-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const { name, parentId } = req.query;

    let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;

    const resp = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 });
    const folder = resp.data.files?.[0] || null;
    res.json({ success: true, folder });
  } catch(e) {
    console.error('[Drive/SearchFolder]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Sauvegarder un fichier agent dans Drive (crée le dossier si besoin)
app.post('/drive/save-agent', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const { fileName, content, folderName, mimeType = 'text/markdown' } = req.body;

    // 1. Trouver ou créer le dossier "Mon Bureau"
    let monBureauFolderId = null;
    const mbSearch = await drive.files.list({
      q: `name='Mon Bureau' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id,name)', pageSize: 1
    });
    if (mbSearch.data.files?.length) {
      monBureauFolderId = mbSearch.data.files[0].id;
    } else {
      const mbCreate = await drive.files.create({
        resource: { name: 'Mon Bureau', mimeType: 'application/vnd.google-apps.folder' },
        fields: 'id'
      });
      monBureauFolderId = mbCreate.data.id;
    }

    // 2. Trouver ou créer le sous-dossier (ex: "Mon Bureau — Agents")
    let targetFolderId = monBureauFolderId;
    if (folderName) {
      const subSearch = await drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${monBureauFolderId}' in parents and trashed=false`,
        fields: 'files(id,name)', pageSize: 1
      });
      if (subSearch.data.files?.length) {
        targetFolderId = subSearch.data.files[0].id;
      } else {
        const subCreate = await drive.files.create({
          resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [monBureauFolderId] },
          fields: 'id'
        });
        targetFolderId = subCreate.data.id;
      }
    }

    // 3. Vérifier si le fichier existe déjà (pour l'écraser)
    const existSearch = await drive.files.list({
      q: `name='${fileName}' and '${targetFolderId}' in parents and trashed=false`,
      fields: 'files(id)', pageSize: 1
    });

    let fileId, webViewLink;

    if (existSearch.data.files?.length) {
      // Mettre à jour le fichier existant
      fileId = existSearch.data.files[0].id;
      const { Readable } = await import('stream');
      const stream = Readable.from([content]);
      await drive.files.update({
        fileId,
        media: { mimeType, body: stream },
        fields: 'id,webViewLink'
      });
      const info = await drive.files.get({ fileId, fields: 'webViewLink' });
      webViewLink = info.data.webViewLink;
    } else {
      // Créer le fichier
      const { Readable } = await import('stream');
      const stream = Readable.from([content]);
      const created = await drive.files.create({
        resource: { name: fileName, parents: [targetFolderId] },
        media: { mimeType, body: stream },
        fields: 'id,webViewLink'
      });
      fileId = created.data.id;
      webViewLink = created.data.webViewLink;
    }

    console.log(`[Drive/SaveAgent] Sauvegardé: ${folderName}/${fileName}`);
    res.json({ success: true, fileId, webViewLink, fileName });

  } catch(e) {
    console.error('[Drive/SaveAgent]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// Ajouter du contenu à un Google Doc (crée le doc si besoin)
app.post('/drive/append-to-doc', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const docs = google.docs({ version: 'v1', auth });
    const { docTitle, content, folderName } = req.body;

    // 1. Trouver le dossier parent
    let folderId = null;
    const mbSearch = await drive.files.list({
      q: `name='Mon Bureau' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: 'files(id)', pageSize: 1
    });
    if (mbSearch.data.files?.length) {
      const monBureauId = mbSearch.data.files[0].id;
      const subSearch = await drive.files.list({
        q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${monBureauId}' in parents and trashed=false`,
        fields: 'files(id)', pageSize: 1
      });
      folderId = subSearch.data.files?.[0]?.id || monBureauId;
    }

    // 2. Chercher le Google Doc hebdomadaire
    let docId = null;
    const docSearch = await drive.files.list({
      q: `name='${docTitle}' and mimeType='application/vnd.google-apps.document'${folderId ? ` and '${folderId}' in parents` : ''} and trashed=false`,
      fields: 'files(id,webViewLink)', pageSize: 1
    });

    if (docSearch.data.files?.length) {
      docId = docSearch.data.files[0].id;
    } else {
      // Créer le Google Doc
      const resource = {
        name: docTitle,
        mimeType: 'application/vnd.google-apps.document'
      };
      if (folderId) resource.parents = [folderId];
      const created = await drive.files.create({ resource, fields: 'id' });
      docId = created.data.id;

      // Initialiser avec un titre
      await docs.documents.batchUpdate({
        documentId: docId,
        requestBody: {
          requests: [{
            insertText: {
              location: { index: 1 },
              text: `${docTitle}\n\n`
            }
          }]
        }
      });
    }

    // 3. Récupérer la longueur actuelle du doc
    const docInfo = await docs.documents.get({ documentId: docId });
    const endIndex = docInfo.data.body.content.slice(-1)[0]?.endIndex - 1 || 1;

    // 4. Ajouter le nouveau contenu
    const separator = '\n\n════════════════════════════════\n\n';
    await docs.documents.batchUpdate({
      documentId: docId,
      requestBody: {
        requests: [{
          insertText: {
            location: { index: endIndex },
            text: separator + content
          }
        }]
      }
    });

    const docInfoUpdated = await drive.files.get({ fileId: docId, fields: 'webViewLink' });
    console.log(`[Drive/AppendDoc] Ajouté dans: ${docTitle}`);
    res.json({ success: true, docId, webViewLink: docInfoUpdated.data.webViewLink });

  } catch(e) {
    console.error('[Drive/AppendDoc]', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});


// =================
// TISSÉO - Endpoints backend
// API Open Data Toulouse Métropole
// Clé gratuite : https://data.toulouse-metropole.fr/pages/api/
// =================

const TISSEO_API_KEY = process.env.TISSEO_API_KEY || '';
const TISSEO_BASE = 'https://api.tisseo.fr/v2';

// IDs des arrêts Gallieni et Langlade (fixes, trouvés via API)
const ARRETS_IDS = {
  gallieni: 'stop_area:SNCF:87611002', // À confirmer avec l'API
  langlade: 'stop_area:Tisseo:5498'    // À confirmer avec l'API
};

// Prochains passages pour un arrêt
app.get('/tisseo/prochains', async (req, res) => {
  try {
    const { arret = 'gallieni', nb = 8 } = req.query;
    const stopId = ARRETS_IDS[arret];

    if (!stopId) {
      return res.status(400).json({ success: false, error: `Arrêt inconnu: ${arret}` });
    }

    if (!TISSEO_API_KEY) {
      // Mode démo si pas de clé
      return res.json({
        success: true,
        arret,
        demo: true,
        passages: [
          { ligne: 'A', direction: 'Basso Cambo', attente: '3 min', heure: '14:32', realtime: true },
          { ligne: 'B', direction: 'Borderouge', attente: '7 min', heure: '14:36', realtime: true },
          { ligne: 'A', direction: 'Balma-Gramont', attente: '10 min', heure: '14:39', realtime: true }
        ]
      });
    }

    const params = new URLSearchParams({
      key: TISSEO_API_KEY,
      stopAreaId: stopId,
      number: nb,
      srsName: 'EPSG:4326'
    });

    const response = await fetch(`${TISSEO_BASE}/departures.json?${params}`, {
      signal: AbortSignal.timeout(5000)
    });

    const data = await response.json();
    const now = new Date();

    const passages = (data.departures?.departure || []).map(dep => {
      const dt = new Date(dep.dateTime);
      const diffMin = Math.round((dt - now) / 60000);
      return {
        ligne: dep.line?.shortName || dep.line?.longName || '?',
        direction: dep.destination?.name || '',
        heure: dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        attente: diffMin <= 0 ? 'À quai' : diffMin === 1 ? '1 min' : `${diffMin} min`,
        attenteMin: diffMin,
        realtime: dep.realTime === '1',
        mode: dep.line?.transportMode?.nameTransportMode || 'Bus'
      };
    });

    console.log(`[Tisséo] ${arret}: ${passages.length} passages`);
    res.json({ success: true, arret, passages, updatedAt: new Date().toISOString() });

  } catch(error) {
    console.error('[Tisséo] Error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rechercher un arrêt par nom
app.get('/tisseo/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, error: 'Paramètre q requis' });

    if (!TISSEO_API_KEY) {
      return res.json({ success: true, demo: true, arrets: [] });
    }

    const params = new URLSearchParams({
      key: TISSEO_API_KEY,
      srsName: 'EPSG:4326',
      term: q
    });

    const response = await fetch(`${TISSEO_BASE}/stops_area.json?${params}`, {
      signal: AbortSignal.timeout(5000)
    });

    const data = await response.json();
    const arrets = (data.stopsArea?.stopsArea || []).slice(0, 10).map(s => ({
      id: s.id,
      name: s.name,
      city: s.city?.name || 'Toulouse',
      lignes: (s.lines?.line || []).map(l => l.shortName || l.longName).join(', ')
    }));

    res.json({ success: true, arrets });
  } catch(error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Perturbations en cours
app.get('/tisseo/perturbations', async (req, res) => {
  try {
    if (!TISSEO_API_KEY) {
      return res.json({ success: true, demo: true, perturbations: [] });
    }

    const params = new URLSearchParams({ key: TISSEO_API_KEY });
    const response = await fetch(`${TISSEO_BASE}/disruptions.json?${params}`, {
      signal: AbortSignal.timeout(5000)
    });

    const data = await response.json();
    const perturbations = (data.disruptions?.disruption || []).slice(0, 5).map(d => ({
      titre: d.title || '',
      lignes: (d.lines?.line || []).map(l => l.shortName).join(', '),
      debut: d.startDate,
      fin: d.endDate,
      message: d.comment || ''
    }));

    res.json({ success: true, perturbations });
  } catch(error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// HEALTH & START
// =================

app.get('/', (req, res) => { res.json({ name: 'Mon Bureau Backend', version: '2.0.0', status: 'ok', features: ['claude', 'agents', 'calendar', 'drive', 'contacts', 'maps', 'meteo', 'cinema', 'drive-agent', 'tisseo'] }); });
app.get('/health', (req, res) => { res.json({ status: 'ok', timestamp: Date.now() }); });

app.listen(PORT, () => {
  console.log(`Mon Bureau Backend v2 - Port ${PORT} - Routes: Claude, Agents, Calendar, Drive, Contacts, Maps, Météo`);
});
