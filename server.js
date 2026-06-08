// Mon Bureau - Backend Render (sans stockage de tokens)
// Les tokens sont stockés côté frontend (localStorage)

import express from 'express';
import cors from 'cors';
import { google } from 'googleapis';
import fetch from 'node-fetch';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
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
// HELPERS
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
// GEMINI (gratuit - remplace Claude pour tâches légères)
// =================

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = 'gemini-1.5-flash';
const GEMINI_URL     = () => `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

async function callGemini(systemPrompt, messages, maxTokens = 1024) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY manquante');
  const geminiMessages = messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string' ? m.content
        : (Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n') : String(m.content)) }]
    }));
  const body = {
    contents: geminiMessages,
    generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
  };
  if (systemPrompt) body.system_instruction = { parts: [{ text: systemPrompt }] };
  const resp = await fetch(GEMINI_URL(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  if (!resp.ok) { const err = await resp.json().catch(() => ({})); throw new Error(`Gemini ${resp.status}: ${err.error?.message || resp.statusText}`); }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// POST /gemini/summarize — résumés RSS (gratuit)
app.post('/gemini/summarize', async (req, res) => {
  const { text, type = 'article' } = req.body;
  if (!text) return res.status(400).json({ success: false, error: 'text requis' });
  try {
    const system = 'Tu es un assistant de lecture expert en français. Résume de façon claire, structurée et utile. Réponds TOUJOURS en français.';
    const prompt = `Résume cet ${type} en 3-4 phrases claires. Points essentiels en premier :\n\n${text.substring(0, 4000)}`;
    const summary = await callGemini(system, [{ role: 'user', content: prompt }], 512);
    res.json({ success: true, summary, model: GEMINI_MODEL });
  } catch(e) { console.error('[Gemini/summarize]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// POST /gemini/chat — agents IA, citations (gratuit)
app.post('/gemini/chat', async (req, res) => {
  const { messages = [], system = '' } = req.body;
  if (!messages.length) return res.status(400).json({ success: false, error: 'messages requis' });
  try {
    const text = await callGemini(system, messages, 1500);
    res.json({ success: true, content: [{ type: 'text', text }], model: GEMINI_MODEL });
  } catch(e) { console.error('[Gemini/chat]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

// GET /gemini/status
app.get('/gemini/status', async (req, res) => {
  if (!GEMINI_API_KEY) return res.json({ ok: false, error: 'GEMINI_API_KEY non configurée' });
  try {
    const text = await callGemini('', [{ role: 'user', content: 'Dis juste "ok"' }], 10);
    res.json({ ok: true, model: GEMINI_MODEL, response: text.trim() });
  } catch(e) { res.json({ ok: false, error: e.message }); }
});

// =================
// CLAUDE — uniquement fiches de lecture et dossiers (qualité max)
// =================

// Contexte de date injecté dans les prompts Claude : évite que le modèle
// "corrige" ou rejette des infos récentes (sport, actu) qu'il ne connaît pas
// car sa connaissance interne s'arrête avant la date du jour.
function dateDuJour() {
  return new Date().toLocaleDateString('fr-FR', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Europe/Paris'
  });
}
function dateContexte() {
  return `Nous sommes le ${dateDuJour()}. Ta connaissance interne peut être périmée : ne corrige pas, ne fact-checke pas et ne remets pas en cause les informations factuelles récentes (résultats sportifs, actualités, événements) présentes dans le contenu fourni — considère qu'elles peuvent être exactes même si elles te surprennent.`;
}

app.post('/claude/summarize', async (req, res) => {
  try {
    const { text, type } = req.body;
    let prompt = '';
    if (type === 'article') prompt = `Résume cet article en 3 points clés (max 50 mots par point). Sois concis et factuel.\n\nArticle:\n${text}`;
    else if (type === 'note') prompt = `Résume cette note en gardant les informations essentielles.\n\nNote:\n${text}`;
    else if (type === 'meeting') prompt = `Résume cet événement/réunion : quoi, quand, avec qui, objectifs.\n\nÉvénement:\n${text}`;
    const message = await anthropic.messages.create({ model: 'claude-sonnet-4-20250514', max_tokens: 500, system: dateContexte(), messages: [{ role: 'user', content: prompt }] });
    res.json({ success: true, summary: message.content[0].text, usage: message.usage });
  } catch (error) { console.error('Summarize error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.post('/claude/factcheck', async (req, res) => {
  try {
    const { title, content, url } = req.body;
    const prompt = `Vérifie la crédibilité de cet article. Utilise la recherche web pour confronter les affirmations factuelles importantes à des sources fiables, surtout pour les événements récents.\n\nArticle:\nTitre: ${title}\nURL: ${url}\nContenu: ${content}\n\nUne fois tes vérifications faites, fournis ton analyse en JSON :\n{\n  "score": 0-100,\n  "verdict": "Fiable" | "Douteux" | "Faux" | "Non vérifiable",\n  "points_positifs": [],\n  "points_negatifs": [],\n  "recommandation": "courte phrase"\n}\nTermine ta réponse par ce JSON uniquement, sans texte après.`;

    const systemFC = `Nous sommes le ${dateDuJour()}. Tu es un fact-checker rigoureux. Ta connaissance interne s'arrête avant cette date : pour tout fait récent, vérifie-le via la recherche web AVANT de juger. Ne baisse jamais le score d'un article uniquement parce qu'une information dépasse ta connaissance — vérifie d'abord, puis juge sur la base des sources trouvées, de la cohérence interne et de la concordance avec des sources fiables.`;

    const message = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      system: systemFC,
      tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
      messages: [{ role: 'user', content: prompt }]
    });

    // Avec la recherche web, la réponse contient plusieurs blocs
    // (recherches + résultats + texte). On ne garde que le texte final.
    const textOut = message.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');

    let analysis;
    try {
      let jsonStr = textOut.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      const first = jsonStr.indexOf('{');
      const last = jsonStr.lastIndexOf('}');
      if (first !== -1 && last !== -1) jsonStr = jsonStr.slice(first, last + 1);
      analysis = JSON.parse(jsonStr);
    } catch (e) {
      analysis = { score: 50, verdict: "Non vérifiable", points_positifs: [], points_negatifs: [], recommandation: "Vérifier manuellement" };
    }
    res.json({ success: true, analysis, usage: message.usage });
  } catch (error) { console.error('Fact-check error:', error); res.status(500).json({ success: false, error: error.message }); }
});

app.post('/claude/chat', async (req, res) => {
  try {
    const { message: userMessage, context } = req.body;
    let systemPrompt = `Tu es l'assistant personnel de Sandra. ${dateContexte()}\n\nTu as accès à ses données :`;
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
// AGENTS IA (Claude — fiches + dossiers)
// =================

app.post('/agents/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ success: false, error: 'Messages array is required' });
    let fullContent = [], currentMessages = [...messages];
    let totalInputTokens = 0, totalOutputTokens = 0;
    const MAX_TURNS = 5;
    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const config = { model: 'claude-sonnet-4-20250514', max_tokens: 8000, messages: currentMessages };
      if (system) config.system = system;
      console.log(`[Agents] Turn ${turn + 1}, messages: ${currentMessages.length}`);
      const message = await anthropic.messages.create(config);
      totalInputTokens += message.usage?.input_tokens || 0;
      totalOutputTokens += message.usage?.output_tokens || 0;
      fullContent.push(...message.content.filter(b => b.type === 'text'));
      if (message.stop_reason === 'end_turn') { console.log(`[Agents] Complet en ${turn + 1} tour(s)`); break; }
      if (message.stop_reason === 'max_tokens') {
        console.log(`[Agents] Coupé à ${turn + 1}, continuation...`);
        currentMessages = [...currentMessages, { role: 'assistant', content: message.content }, { role: 'user', content: 'Continue.' }];
        continue;
      }
      break;
    }
    const mergedText = fullContent.map(b => b.text).join('');
    console.log(`[Agents] Réponse finale: ${mergedText.length} chars, tokens: ${totalOutputTokens}`);
    res.json({ success: true, content: [{ type: 'text', text: mergedText }], usage: { input_tokens: totalInputTokens, output_tokens: totalOutputTokens }, model: 'claude-sonnet-4-20250514', stop_reason: 'end_turn' });
  } catch (error) { console.error('[Agents] Error:', error); res.status(500).json({ success: false, error: error.message }); }
});

// Last.fm proxy
app.get('/agents/lastfm/:method', async (req, res) => {
  try {
    const { method } = req.params;
    const LFM_KEY = process.env.LASTFM_API_KEY || '58c198bcc66ba74924848228a2fa6935';
    const LFM_USER = process.env.LASTFM_USER || 'franfran120374';
    const methodMap = { gettoptracks: 'user.getTopTracks', gettopartists: 'user.getTopArtists', getrecenttracks: 'user.getRecentTracks' };
    const lfmMethod = methodMap[method.toLowerCase()];
    if (!lfmMethod) return res.status(404).json({ success: false, error: 'Méthode inconnue' });
    const params = new URLSearchParams({ method: lfmMethod, user: LFM_USER, api_key: LFM_KEY, format: 'json', limit: req.query.limit || 10, period: req.query.period || '1month' });
    const data = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`).then(r => r.json());
    res.json({ success: true, data });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// YouTube search proxy
app.get('/agents/youtube/search', async (req, res) => {
  try {
    const YT_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    const params = new URLSearchParams({ key: YT_KEY, q: req.query.q || '', part: 'snippet', type: 'video', maxResults: req.query.maxResults || 5 });
    const data = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`).then(r => r.json());
    res.json({ success: true, items: data.items || [] });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// =================
// TRAJETS & RAPPELS
// =================

const HOME_ADDRESS = '10 rue Etienne Bacquié, Toulouse';
const DEFAULT_PREP_MINUTES = 10;

app.post('/proxy/maps', async (req, res) => {
  try {
    const { origin, destination, arrivalTime, mode } = req.body;
    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    const params = new URLSearchParams({ origin: origin || HOME_ADDRESS, destination, mode: mode || 'transit', key: MAPS_KEY, language: 'fr', region: 'fr' });
    if (arrivalTime) params.set('arrival_time', Math.floor(new Date(arrivalTime).getTime() / 1000));
    const data = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`).then(r => r.json());
    if (data.status !== 'OK' && data.status !== 'ZERO_RESULTS') console.error('[Maps] Status:', data.status, data.error_message);
    res.json(data);
  } catch (error) { console.error('Maps proxy error:', error); res.status(500).json({ error: error.message, status: 'ERROR' }); }
});

app.post('/maps/trajet', async (req, res) => {
  try {
    const { destination, arrivalTime, mode = 'transit', prepMinutes = DEFAULT_PREP_MINUTES, origin } = req.body;
    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    if (!destination) return res.status(400).json({ success: false, error: 'Destination requise' });
    const fromAddress = origin || HOME_ADDRESS;
    const arrivalTimestamp = arrivalTime ? Math.floor(new Date(arrivalTime).getTime() / 1000) : Math.floor(Date.now() / 1000 + 3600);
    const params = new URLSearchParams({ origin: fromAddress, destination, mode, arrival_time: arrivalTimestamp, key: MAPS_KEY, language: 'fr', region: 'fr' });
    let data = await fetch(`https://maps.googleapis.com/maps/api/directions/json?${params}`).then(r => r.json());
    if (data.status !== 'OK') {
      const params2 = new URLSearchParams({ origin: fromAddress, destination, mode, departure_time: 'now', key: MAPS_KEY, language: 'fr', region: 'fr' });
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
    const steps = (leg.steps || []).map(s => ({
      instruction: (s.html_instructions || '').replace(/<[^>]+>/g, ''),
      duration: s.duration?.text || '',
      distance: s.distance?.text || '',
      mode: s.travel_mode?.toLowerCase() || mode,
      transit: s.transit_details ? {
        line: s.transit_details.line?.short_name || s.transit_details.line?.name || '',
        headsign: s.transit_details.headsign || '',
        direction: s.transit_details.headsign || '',
        from: s.transit_details.departure_stop?.name || '',
        to: s.transit_details.arrival_stop?.name || '',
        numStops: s.transit_details.num_stops || 0,
        departureTime: s.transit_details.departure_time?.text || '',
        arrivalTime: s.transit_details.arrival_time?.text || '',
        vehicleType: s.transit_details.line?.vehicle?.type || ''
      } : null
    }));
    console.log(`[Maps/Trajet] ${destination}: ${durationText}, départ: ${rappel?.departureText || 'N/A'}`);
    res.json({ success: true, trajet: { origin: fromAddress, destination: leg.end_address || destination, duration: durationText, durationMinutes, distance: leg.distance?.text || '', mode, steps, mapsLink: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(fromAddress)}&destination=${encodeURIComponent(destination)}&travelmode=${mode}` }, rappel });
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
      const steps = (leg.steps || []).map(s => ({
        instruction: (s.html_instructions || '').replace(/<[^>]+>/g, ''),
        duration: s.duration?.text || '', distance: s.distance?.text || '',
        mode: s.travel_mode?.toLowerCase() || 'transit',
        transit: s.transit_details ? { line: s.transit_details.line?.short_name || s.transit_details.line?.name || '', headsign: s.transit_details.headsign || '', from: s.transit_details.departure_stop?.name || '', to: s.transit_details.arrival_stop?.name || '', numStops: s.transit_details.num_stops || 0, departureTime: s.transit_details.departure_time?.text || '', arrivalTime: s.transit_details.arrival_time?.text || '', vehicleType: s.transit_details.line?.vehicle?.type || '' } : null
      }));
      return { eventId: event.id, eventTitle: event.summary || event.title || '', destination: event.location, duration: leg.duration?.text, durationMinutes, distance: leg.distance?.text, steps, mapsLink: `https://www.google.com/maps/dir/?api=1&origin=${encodeURIComponent(HOME_ADDRESS)}&destination=${encodeURIComponent(event.location)}&travelmode=transit`, departureTime: departureTime?.toISOString(), departureText, minutesUntilDeparture, isUrgent: minutesUntilDeparture !== null && minutesUntilDeparture >= 0 && minutesUntilDeparture <= 15, isLate: minutesUntilDeparture !== null && minutesUntilDeparture < 0 };
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
    const data = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`).then(r => r.json());
    res.json({ success: true, data });
  } catch(error) { res.status(500).json({ success: false, error: error.message }); }
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
    res.json({ success: true, meteo });
  } catch(error) { res.status(500).json({ success: false, error: error.message }); }
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
    res.json({ success: true, eventTitle, departTime, meteo: { ...meteo, temperature: Math.round(meteo.temperature), apparentTemp: Math.round(meteo.apparentTemp) }, desc, conseils, resume: conseils.length ? `${desc} · ${Math.round(temp)}°C · Pense à : ${conseils.map(c => c.item).join(', ')}` : `${desc} · ${Math.round(temp)}°C · Aucun équipement spécial nécessaire ✅` });
  } catch(error) { res.status(500).json({ success: false, error: error.message }); }
});

// =================
// AUTH GOOGLE
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
// CONTACTS
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
// CALENDAR
// =================

app.get('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) { const { credentials } = await auth.refreshAccessToken(); auth.setCredentials(credentials); }
    const calendar = google.calendar({ version: 'v3', auth });
    const params = { calendarId: 'primary', timeMin: req.query.timeMin || new Date().toISOString(), maxResults: parseInt(req.query.maxResults) || 50, singleEvents: true, orderBy: 'startTime' };
    if (req.query.timeMax) params.timeMax = req.query.timeMax;
    const response = await calendar.events.list(params);
    res.json({ events: response.data.items, tokens: auth.credentials });
  } catch (error) { console.error('Calendar list error:', error.message); res.status(500).json({ error: error.message }); }
});

app.post('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) { const { credentials } = await auth.refreshAccessToken(); auth.setCredentials(credentials); }
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.insert({ calendarId: 'primary', requestBody: req.body });
    res.json({ event: event.data, tokens: auth.credentials });
  } catch (error) { console.error('Calendar create error:', error.message); res.status(500).json({ error: error.message }); }
});

app.delete('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) { const { credentials } = await auth.refreshAccessToken(); auth.setCredentials(credentials); }
    const calendar = google.calendar({ version: 'v3', auth });
    await calendar.events.delete({ calendarId: 'primary', eventId: req.params.eventId });
    res.json({ success: true, tokens: auth.credentials });
  } catch (error) { console.error('Calendar delete error:', error.message); res.status(500).json({ error: error.message }); }
});

app.patch('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) { const { credentials } = await auth.refreshAccessToken(); auth.setCredentials(credentials); }
    const calendar = google.calendar({ version: 'v3', auth });
    const event = await calendar.events.patch({ calendarId: 'primary', eventId: req.params.eventId, requestBody: req.body });
    res.json({ event: event.data, tokens: auth.credentials });
  } catch (error) { console.error('Calendar update error:', error.message); res.status(500).json({ error: error.message }); }
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
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/drive/search', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.list({ pageSize: 20, fields: 'files(id, name, mimeType, modifiedTime, webViewLink)', q: `name contains '${req.query.q}' and trashed=false` });
    res.json({ files: response.data.files, tokens: auth.credentials });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/drive/upload', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const file = await drive.files.create({ resource: { name: req.body.fileName }, media: { mimeType: req.body.mimeType || 'text/plain', body: req.body.content }, fields: 'id, name, webViewLink' });
    res.json({ file: file.data, tokens: auth.credentials });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/drive/download/:fileId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const response = await drive.files.get({ fileId: req.params.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
    res.json({ content: Buffer.from(response.data).toString('base64'), tokens: auth.credentials });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.post('/drive/create-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const resource = { name: req.body.folderName, mimeType: 'application/vnd.google-apps.folder' };
    if (req.body.parentId) resource.parents = [req.body.parentId];
    const folder = await drive.files.create({ resource, fields: 'id, name, webViewLink' });
    res.json({ folder: folder.data, tokens: auth.credentials });
  } catch (error) { res.status(500).json({ error: error.message }); }
});

app.get('/drive/search-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const { name, parentId } = req.query;
    let q = `name='${name}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (parentId) q += ` and '${parentId}' in parents`;
    const resp = await drive.files.list({ q, fields: 'files(id,name)', pageSize: 1 });
    res.json({ success: true, folder: resp.data.files?.[0] || null });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/drive/save-agent', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const { fileName, content, folderName, mimeType = 'text/markdown' } = req.body;
    // Trouver/créer dossier Mon Bureau
    let monBureauFolderId = null;
    const mbSearch = await drive.files.list({ q: `name='Mon Bureau' and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: 'files(id,name)', pageSize: 1 });
    if (mbSearch.data.files?.length) { monBureauFolderId = mbSearch.data.files[0].id; }
    else { const mb = await drive.files.create({ resource: { name: 'Mon Bureau', mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' }); monBureauFolderId = mb.data.id; }
    // Sous-dossier
    let targetFolderId = monBureauFolderId;
    if (folderName) {
      const subSearch = await drive.files.list({ q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${monBureauFolderId}' in parents and trashed=false`, fields: 'files(id,name)', pageSize: 1 });
      if (subSearch.data.files?.length) { targetFolderId = subSearch.data.files[0].id; }
      else { const sub = await drive.files.create({ resource: { name: folderName, mimeType: 'application/vnd.google-apps.folder', parents: [monBureauFolderId] }, fields: 'id' }); targetFolderId = sub.data.id; }
    }
    // Créer ou mettre à jour
    const existSearch = await drive.files.list({ q: `name='${fileName}' and '${targetFolderId}' in parents and trashed=false`, fields: 'files(id)', pageSize: 1 });
    let fileId, webViewLink;
    const { Readable } = await import('stream');
    if (existSearch.data.files?.length) {
      fileId = existSearch.data.files[0].id;
      await drive.files.update({ fileId, media: { mimeType, body: Readable.from([content]) }, fields: 'id,webViewLink' });
      const info = await drive.files.get({ fileId, fields: 'webViewLink' });
      webViewLink = info.data.webViewLink;
    } else {
      const created = await drive.files.create({ resource: { name: fileName, parents: [targetFolderId] }, media: { mimeType, body: Readable.from([content]) }, fields: 'id,webViewLink' });
      fileId = created.data.id; webViewLink = created.data.webViewLink;
    }
    console.log(`[Drive/SaveAgent] Sauvegardé: ${folderName}/${fileName}`);
    res.json({ success: true, fileId, webViewLink, fileName });
  } catch(e) { console.error('[Drive/SaveAgent]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

app.post('/drive/create-doc-in-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    if (tokens.expiry_date && tokens.expiry_date < Date.now() + 60000) { const { credentials } = await auth.refreshAccessToken(); auth.setCredentials(credentials); }
    const drive = google.drive({ version: 'v3', auth });
    const docs = google.docs({ version: 'v1', auth });
    const { title, content, folderId } = req.body;
    if (!folderId) return res.status(400).json({ success: false, error: 'folderId requis' });
    const created = await drive.files.create({ resource: { name: title, mimeType: 'application/vnd.google-apps.document', parents: [folderId] }, fields: 'id,webViewLink' });
    const docId = created.data.id;
    if (content) { await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: content } }] } }); }
    console.log(`[Drive/CreateDoc] "${title}" créé dans dossier ${folderId}`);
    res.json({ success: true, docId, webViewLink: created.data.webViewLink, title });
  } catch(e) { console.error('[Drive/CreateDoc]', e.message); res.status(500).json({ success: false, error: e.message }); }
});

app.post('/drive/append-to-doc', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const auth = getAuthClient(tokens);
    const drive = google.drive({ version: 'v3', auth });
    const docs = google.docs({ version: 'v1', auth });
    const { docTitle, content, folderName } = req.body;
    let folderId = null;
    const mbSearch = await drive.files.list({ q: `name='Mon Bureau' and mimeType='application/vnd.google-apps.folder' and trashed=false`, fields: 'files(id)', pageSize: 1 });
    if (mbSearch.data.files?.length) {
      const monBureauId = mbSearch.data.files[0].id;
      const subSearch = await drive.files.list({ q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and '${monBureauId}' in parents and trashed=false`, fields: 'files(id)', pageSize: 1 });
      folderId = subSearch.data.files?.[0]?.id || monBureauId;
    }
    let docId = null;
    const docSearch = await drive.files.list({ q: `name='${docTitle}' and mimeType='application/vnd.google-apps.document'${folderId ? ` and '${folderId}' in parents` : ''} and trashed=false`, fields: 'files(id,webViewLink)', pageSize: 1 });
    if (docSearch.data.files?.length) { docId = docSearch.data.files[0].id; }
    else {
      const resource = { name: docTitle, mimeType: 'application/vnd.google-apps.document' };
      if (folderId) resource.parents = [folderId];
      const created = await drive.files.create({ resource, fields: 'id' });
      docId = created.data.id;
      await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: 1 }, text: `${docTitle}\n\n` } }] } });
    }
    const docInfo = await docs.documents.get({ documentId: docId });
    const endIndex = docInfo.data.body.content.slice(-1)[0]?.endIndex - 1 || 1;
    await docs.documents.batchUpdate({ documentId: docId, requestBody: { requests: [{ insertText: { location: { index: endIndex }, text: '\n\n════════════════════════════════\n\n' + content } }] } });
    const docInfoUpdated = await drive.files.get({ fileId: docId, fields: 'webViewLink' });
    res.json({ success: true, docId, webViewLink: docInfoUpdated.data.webViewLink });
  } catch(e) { console.error('[Drive/AppendDoc]', e.message); res.status(500).json({ success: false, error: e.message }); }
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
    const items = [];
    let m;
    const itemRe = /<item>([\s\S]*?)<\/item>/gi;
    const entryRe = /<entry>([\s\S]*?)<\/entry>/gi;
    while ((m = itemRe.exec(text)) !== null) items.push(m[1]);
    while ((m = entryRe.exec(text)) !== null) items.push(m[1]);
    const events = [];
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
    res.json({ events, source: name, total: events.length });
  } catch (error) { res.status(500).json({ error: error.message, events: [] }); }
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
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    res.json(await resp.json());
  } catch(e) { res.status(500).json({ error: e.message, events: [] }); }
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
    const results = await Promise.allSettled(TOULOUSE_AGENDAS.map(agenda => fetch(buildUrl(agenda.uid), { signal: AbortSignal.timeout(10000) }).then(r => r.ok ? r.json() : null).catch(() => null)));
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
    res.json({ events: allEvents, total: allEvents.length });
  } catch(e) { res.status(500).json({ error: e.message, events: [] }); }
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
// TISSÉO (1 seule définition propre)
// =================

const TISSEO_API_KEY = process.env.TISSEO_API_KEY || '';
const TISSEO_BASE = 'https://api.tisseo.fr/v2';
const ARRETS_IDS = { gallieni: null, langlade: null };

// IDs hardcodes des arrets connus (evite la recherche dynamique qui peut echouer)
const ARRETS_HARDCODED = {
  gallieni: null,  // Sera rempli au premier appel reussi
  langlade: null
};

// Donnees demo generees dynamiquement
function getTisseoDemo(arret) {
  const now = Date.now();
  if (arret === 'gallieni') return [
    { ligne: '152', direction: 'Empalot', attente: '3 min', heure: new Date(now+3*60000).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}), attenteMin: 3, realtime: true, mode: 'Bus' },
    { ligne: '152', direction: 'IUC',     attente: '9 min', heure: new Date(now+9*60000).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}), attenteMin: 9, realtime: true, mode: 'Bus' },
    { ligne: '152', direction: 'Empalot', attente: '18 min', heure: new Date(now+18*60000).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}), attenteMin: 18, realtime: false, mode: 'Bus' }
  ];
  return [
    { ligne: '152', direction: 'IUC', attente: '5 min', heure: new Date(now+5*60000).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}), attenteMin: 5, realtime: true, mode: 'Bus' }
  ];
}

app.get('/tisseo/prochains', async (req, res) => {
  try {
    const { arret = 'gallieni', nb = 8 } = req.query;

    // Sans cle : donnees demo
    if (!TISSEO_API_KEY) {
      return res.json({ success: true, arret, demo: true, passages: getTisseoDemo(arret) });
    }

    // Essayer plusieurs variantes du nom d'arret
    const searchTerms = {
      gallieni: ['Gallieni', 'Galliéni', 'gallieni'],
      langlade: ['Langlade', 'langlade']
    };
    const terms = searchTerms[arret] || [arret];

    let stopId = ARRETS_HARDCODED[arret] || ARRETS_IDS[arret];

    if (!stopId) {
      for (const term of terms) {
        try {
          const searchResp = await fetch(
            `${TISSEO_BASE}/stops_area.json?key=${TISSEO_API_KEY}&displayLines=1&srsName=EPSG:4326&term=${encodeURIComponent(term)}`,
            { signal: AbortSignal.timeout(8000) }
          );
          if (!searchResp.ok) continue;
          const searchData = await searchResp.json();
          const stops = searchData.stopsArea?.stopsArea || [];
          if (stops.length > 0) {
            stopId = stops[0].id;
            ARRETS_HARDCODED[arret] = stopId;
            ARRETS_IDS[arret] = stopId;
            console.log(`[Tisséo] Arret trouve: "${term}" → ${stopId}`);
            break;
          }
        } catch(e) {
          console.warn(`[Tisséo] Recherche "${term}" echouee:`, e.message);
        }
      }
    }

    // Toujours si pas d'ID : retourner demo (pas une erreur)
    if (!stopId) {
      console.warn(`[Tisséo] Arret "${arret}" introuvable, retour demo`);
      return res.json({ success: true, arret, demo: true, passages: getTisseoDemo(arret) });
    }

    const params = new URLSearchParams({ key: TISSEO_API_KEY, stopAreaId: stopId, number: nb, srsName: 'EPSG:4326' });
    const response = await fetch(`${TISSEO_BASE}/departures.json?${params}`, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      console.warn(`[Tisséo] departures HTTP ${response.status}`);
      return res.json({ success: true, arret, demo: true, passages: getTisseoDemo(arret) });
    }
    const data = await response.json();
    const now = new Date();
    const passages = (data.departures?.departure || []).map(dep => {
      const dt = new Date(dep.dateTime);
      const diffMin = Math.round((dt - now) / 60000);
      return {
        ligne: dep.line?.shortName || dep.line?.longName || '?',
        direction: dep.destination?.name || '',
        heure: dt.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }),
        attente: diffMin <= 0 ? 'A quai' : diffMin === 1 ? '1 min' : `${diffMin} min`,
        attenteMin: diffMin, realtime: dep.realTime === '1',
        mode: dep.line?.transportMode?.nameTransportMode || 'Bus'
      };
    });

    // Si API repond mais 0 passages : donnees demo
    if (!passages.length) {
      return res.json({ success: true, arret, demo: true, passages: getTisseoDemo(arret) });
    }

    console.log(`[Tisseo] ${arret} (${stopId}): ${passages.length} passages`);
    res.json({ success: true, arret, stopId, passages, updatedAt: new Date().toISOString() });

  } catch(error) {
    console.error('[Tisseo] Error:', error.message);
    // Jamais d'erreur 500 — retourner demo
    res.json({ success: true, arret: req.query.arret || 'gallieni', demo: true, passages: getTisseoDemo(req.query.arret || 'gallieni') });
  }
});

app.get('/tisseo/search', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, error: 'Paramètre q requis' });
    if (!TISSEO_API_KEY) return res.json({ success: true, demo: true, arrets: [] });
    const response = await fetch(`${TISSEO_BASE}/stops_area.json?key=${TISSEO_API_KEY}&displayLines=1&srsName=EPSG:4326&term=${encodeURIComponent(q)}`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    const arrets = (data.stopsArea?.stopsArea || []).slice(0, 10).map(s => ({ id: s.id, name: s.name, city: s.city?.name || 'Toulouse', lignes: (s.lines?.line || []).map(l => l.shortName || l.longName).join(', ') }));
    res.json({ success: true, arrets });
  } catch(error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/tisseo/perturbations', async (req, res) => {
  try {
    if (!TISSEO_API_KEY) return res.json({ success: true, demo: true, perturbations: [] });
    const response = await fetch(`${TISSEO_BASE}/disruptions.json?key=${TISSEO_API_KEY}`, { signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    const perturbations = (data.disruptions?.disruption || []).slice(0, 5).map(d => ({ titre: d.title || '', lignes: (d.lines?.line || []).map(l => l.shortName).join(', '), debut: d.startDate, fin: d.endDate, message: d.comment || '' }));
    res.json({ success: true, perturbations });
  } catch(error) { res.status(500).json({ success: false, error: error.message }); }
});

// =================
// VÉLÔTOULOUSE
// =================

let _veloCache = null;
let _veloCacheTime = 0;

async function fetchVeloData() {
  const now = Date.now();
  if (_veloCache && now - _veloCacheTime < 60000) return _veloCache;
  try {
    const [infoData, statusData] = await Promise.all([
      fetch('https://api.cyclocity.fr/contracts/toulouse/gbfs/station_information.json', { signal: AbortSignal.timeout(5000) }).then(r => r.json()),
      fetch('https://api.cyclocity.fr/contracts/toulouse/gbfs/station_status.json', { signal: AbortSignal.timeout(5000) }).then(r => r.json())
    ]);
    const statusMap = {};
    (statusData.data?.stations || []).forEach(s => { statusMap[s.station_id] = s; });
    const stations = (infoData.data?.stations || []).map(s => {
      const status = statusMap[s.station_id] || {};
      return { id: s.station_id, name: s.name.replace(/VélôToulouse - /i, '').replace(/Vélo Toulouse - /i, '').trim(), lat: s.lat, lon: s.lon, capacity: s.capacity || 0, availableBikes: status.num_bikes_available || 0, availableDocks: status.num_docks_available || 0, isInstalled: status.is_installed === 1, isRenting: status.is_renting === 1, lastUpdated: status.last_reported || 0 };
    }).filter(s => s.isInstalled && s.isRenting);
    _veloCache = stations; _veloCacheTime = now;
    return stations;
  } catch(e) { console.error('[Vélo] Erreur GBFS:', e.message); return _veloCache || []; }
}

function haversine(lat1, lon1, lat2, lon2) {
  const R = 6371000, dLat = (lat2-lat1)*Math.PI/180, dLon = (lon2-lon1)*Math.PI/180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

app.get('/velo/stations', async (req, res) => {
  try {
    const lat = parseFloat(req.query.lat) || 43.5986, lon = parseFloat(req.query.lon) || 1.4441, nb = parseInt(req.query.nb) || 10;
    const stations = await fetchVeloData();
    const withDist = stations.map(s => ({ ...s, dist: Math.round(haversine(lat, lon, s.lat, s.lon)) })).filter(s => s.dist < 2000).sort((a, b) => a.dist - b.dist).slice(0, nb);
    res.json({ success: true, stations: withDist, total: stations.length, updatedAt: new Date(_veloCacheTime).toISOString() });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/velo/all', async (req, res) => {
  try {
    const stations = await fetchVeloData();
    res.json({ success: true, stations, total: stations.length });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// =================
// CINÉMA INDÉPENDANT TOULOUSE (1 seule définition propre)
// =================

const CINEMAS = {
  abc:        { name: 'Cinéma ABC',         allocineCode: 'P0071', url: 'https://www.abc-toulouse.fr',           allocineUrl: 'https://www.allocine.fr/seance/salle_gen_csalle=P0071.html', style: 'Art et essai · Films engagés' },
  cosmograph: { name: 'American Cosmograph', allocineCode: 'P0235', url: 'https://www.americancosmograph.fr',    allocineUrl: 'https://www.allocine.fr/seance/salle_gen_csalle=P0235.html', style: 'Cinéma du monde · Répertoire' },
  cratere:    { name: 'Le Cratère',          allocineCode: 'P0056', url: 'https://www.cinemalecratere.fr',        allocineUrl: 'https://www.allocine.fr/seance/salle_gen_csalle=P0056.html', style: 'Art et essai · Tarifs réduits' },
  veo:        { name: 'Véo Cartoucherie',    allocineCode: 'G0699', url: 'https://cartoucherie.veocinemas.fr',   allocineUrl: 'https://www.allocine.fr/seance/salle_gen_csalle=G0699.html', style: 'Indépendant · Avant-premières' }
};

let _cinemaCache = null, _cinemaCacheTime = 0;
const CINEMA_CACHE_TTL = 30 * 60 * 1000;

async function fetchSeancesAllocine(cinemaCode, date) {
  try {
    const url = `https://www.allocine.fr/_/showtimes/theater-${cinemaCode}/d-${date}/`;
    const response = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json, */*', 'Accept-Language': 'fr-FR,fr;q=0.9', 'X-Requested-With': 'XMLHttpRequest' }, signal: AbortSignal.timeout(8000) });
    if (!response.ok) return [];
    const data = await response.json();
    return (data.results || []).map(item => ({
      titre: item.movie?.title || '', titreOriginal: item.movie?.originalTitle || '',
      duree: item.movie?.runtime ? `${Math.floor(item.movie.runtime/60)}h${String(item.movie.runtime%60).padStart(2,'0')}` : '',
      synopsis: (item.movie?.synopsis || '').substring(0, 200),
      note: item.movie?.stats?.userRating?.score?.toFixed(1) || null,
      affiche: item.movie?.poster?.url || null,
      genres: (item.movie?.genres || []).map(g => g.tag).join(', '),
      seances: [...(item.showtimes?.dubbed||[]), ...(item.showtimes?.original||[]), ...(item.showtimes?.local||[])].map(s => ({ heure: s.startsAt ? new Date(s.startsAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }) : '', version: (s.tags||[]).includes('vf') ? 'VF' : (s.tags||[]).includes('vost') ? 'VOST' : 'VO' })).filter(s => s.heure)
    })).filter(f => f.titre && f.seances.length > 0);
  } catch(e) { console.warn(`[Cinéma] AlloCiné ${cinemaCode} échoué:`, e.message); return []; }
}

app.get('/cinema/seances', async (req, res) => {
  try {
    const targetDate = req.query.date || new Date().toISOString().split('T')[0];
    const now = Date.now();
    if (_cinemaCache && now - _cinemaCacheTime < CINEMA_CACHE_TTL) return res.json({ success: true, ..._cinemaCache, cached: true });
    const results = await Promise.allSettled(Object.entries(CINEMAS).map(async ([id, cinema]) => ({ id, cinema: { name: cinema.name, style: cinema.style, url: cinema.url, allocineUrl: cinema.allocineUrl }, films: await fetchSeancesAllocine(cinema.allocineCode, targetDate), date: targetDate })));
    const cinemas = results.filter(r => r.status === 'fulfilled').map(r => r.value);
    const totalFilms = cinemas.reduce((acc, c) => acc + c.films.length, 0);
    const payload = { date: targetDate, cinemas, totalFilms };
    _cinemaCache = payload; _cinemaCacheTime = now;
    console.log(`[Cinéma] ${totalFilms} films pour ${targetDate}`);
    res.json({ success: true, ...payload });
  } catch(error) { res.status(500).json({ success: false, error: error.message }); }
});

app.get('/cinema/infos', (req, res) => {
  res.json({ success: true, cinemas: Object.entries(CINEMAS).map(([id, c]) => ({ id, ...c, mapsLink: `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.name + ' Toulouse')}` })) });
});

app.post('/cinema/recommande', async (req, res) => {
  try {
    const { date, googleTokens } = req.body;
    const targetDate = date || new Date().toISOString().split('T')[0];
    const seancesResp = await fetch(`http://localhost:${PORT}/cinema/seances?date=${targetDate}`);
    const seancesData = await seancesResp.json();
    let eventsOccupes = [];
    if (googleTokens) {
      try {
        const auth = getAuthClient(googleTokens);
        const calendar = google.calendar({ version: 'v3', auth });
        const eventsResp = await calendar.events.list({ calendarId: 'primary', timeMin: new Date(targetDate + 'T00:00:00').toISOString(), timeMax: new Date(targetDate + 'T23:59:59').toISOString(), singleEvents: true, orderBy: 'startTime' });
        eventsOccupes = (eventsResp.data.items || []).map(e => ({ debut: new Date(e.start?.dateTime || e.start?.date), fin: new Date(e.end?.dateTime || e.end?.date), titre: e.summary }));
      } catch(e) { console.warn('[Cinéma] Agenda non dispo:', e.message); }
    }
    const recommandations = [];
    for (const cinema of (seancesData.cinemas || [])) {
      for (const film of cinema.films) {
        const seancesDispo = film.seances.filter(s => {
          if (!s.heure) return false;
          const [h, m] = s.heure.split('h').map(Number);
          const debut = new Date(targetDate); debut.setHours(h, m || 0, 0);
          const fin = new Date(debut.getTime() + ((parseInt(film.duree) || 120) * 60000));
          return !eventsOccupes.some(ev => ev.debut < fin && ev.fin > debut);
        });
        if (seancesDispo.length > 0) recommandations.push({ cinema: cinema.cinema.name, cinemaUrl: cinema.cinema.allocineUrl, cinemaStyle: cinema.cinema.style, ...film, seancesDispo });
      }
    }
    recommandations.sort((a, b) => (parseFloat(b.note) || 0) - (parseFloat(a.note) || 0));
    res.json({ success: true, date: targetDate, hasCalendar: eventsOccupes.length > 0, recommandations: recommandations.slice(0, 12) });
  } catch(error) { res.status(500).json({ success: false, error: error.message }); }
});

// =================
// PLACES AUTOCOMPLETE
// =================

app.get('/places/autocomplete', async (req, res) => {
  try {
    const { q } = req.query;
    if (!q) return res.status(400).json({ success: false, predictions: [] });
    const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    const params = new URLSearchParams({ input: q, key: MAPS_KEY, language: 'fr', components: 'country:fr', location: '43.6047,1.4442', radius: 30000, types: 'establishment|geocode' });
    const resp = await fetch(`https://maps.googleapis.com/maps/api/place/autocomplete/json?${params}`, { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    res.json({ success: true, predictions: (data.predictions || []).slice(0, 5) });
  } catch(e) { res.json({ success: true, predictions: [] }); }
});

// =================
// YOUTUBE SEARCH
// =================

app.get('/youtube/search', async (req, res) => {
  try {
    const { q, limit = 1 } = req.query;
    if (!q) return res.status(400).json({ success: false, items: [] });
    const YT_KEY = process.env.YOUTUBE_API_KEY || 'AIzaSyDi4FQgEY8rTRYv1K7unY-m_ra3cgBEPC4';
    const params = new URLSearchParams({ key: YT_KEY, q: q + ' audio officiel', part: 'snippet', type: 'video', maxResults: limit, videoCategoryId: '10', relevanceLanguage: 'fr' });
    const resp = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`, { signal: AbortSignal.timeout(5000) });
    const data = await resp.json();
    if (data.error) return res.json({ success: false, items: [], error: data.error.message });
    res.json({ success: true, items: data.items || [] });
  } catch(e) { res.json({ success: false, items: [] }); }
});

// =================
// ELEVENLABS TTS
// =================

const ELEVEN_API_KEY = process.env.ELEVENLABS_API_KEY || '';
const ELEVEN_VOICES = { 'aria': '9BWtsMINqrJLrRacOk9x', 'sarah': 'EXAVITQu4vr4xnSDxMaL', 'charlotte': 'XB0fDUnXU5powFXDhCwa', 'laura': 'FGY2WhTYpPnrIDTdsKH5', 'default': '9BWtsMINqrJLrRacOk9x' };

app.get('/elevenlabs/voices', async (req, res) => {
  if (!ELEVEN_API_KEY) return res.json({ success: false, error: 'Clé ElevenLabs non configurée' });
  try { const resp = await fetch('https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': ELEVEN_API_KEY }, signal: AbortSignal.timeout(5000) }); res.json({ success: true, voices: (await resp.json()).voices || [] }); }
  catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/elevenlabs/tts', async (req, res) => {
  const { text, voiceId, stability = 0.75, similarityBoost = 0.85 } = req.body;
  if (!ELEVEN_API_KEY) return res.status(400).json({ success: false, error: 'Clé ElevenLabs non configurée' });
  if (!text) return res.status(400).json({ success: false, error: 'Texte requis' });
  try {
    const vid = voiceId || ELEVEN_VOICES.default;
    const resp = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, { method: 'POST', headers: { 'xi-api-key': ELEVEN_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' }, body: JSON.stringify({ text, model_id: 'eleven_multilingual_v2', voice_settings: { stability, similarity_boost: similarityBoost, style: 0.2, use_speaker_boost: false } }), signal: AbortSignal.timeout(30000) });
    if (!resp.ok) { const err = await resp.text(); return res.status(resp.status).json({ success: false, error: err }); }
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-cache');
    res.send(Buffer.from(await resp.arrayBuffer()));
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// =================
// GOOGLE CLOUD TTS
// =================

const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY || '';

app.post('/tts/synthesize', async (req, res) => {
  const { text, ssml, voiceName = 'fr-FR-Studio-A', speakingRate = 0.38, pitch = -5.0 } = req.body;
  if (!GOOGLE_TTS_KEY) return res.status(400).json({ success: false, error: 'Clé Google TTS non configurée' });
  if (!text && !ssml) return res.status(400).json({ success: false, error: 'Texte requis' });
  try {
    const cleanedText = (text || '').replace(/\.{3,}/g, '... ').replace(/\s{2,}/g, ' ').trim();
    const input = ssml ? { ssml } : { text: cleanedText };
    const resp = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ input, voice: { languageCode: 'fr-FR', name: voiceName, ssmlGender: 'FEMALE' }, audioConfig: { audioEncoding: 'MP3', speakingRate, pitch, effectsProfileId: ['headphone-class-device'] } }), signal: AbortSignal.timeout(15000) });
    const data = await resp.json();
    if (data.error) return res.status(400).json({ success: false, error: data.error.message });
    if (!data.audioContent) return res.status(400).json({ success: false, error: 'Pas de contenu audio' });
    res.json({ success: true, audioContent: data.audioContent });
  } catch(e) { res.status(500).json({ success: false, error: e.message }); }
});

// =================
// HEALTH & START
// =================

app.get('/', (req, res) => { res.json({ name: 'Mon Bureau Backend', version: '3.0.0', status: 'ok', features: ['claude', 'gemini', 'agents', 'calendar', 'drive', 'contacts', 'maps', 'meteo', 'cinema', 'tisseo', 'velo', 'spotify', 'youtube', 'elevenlabs'] }); });
app.get('/health', (req, res) => { res.json({ status: 'ok', timestamp: Date.now() }); });

app.listen(PORT, () => {
  console.log(`Mon Bureau Backend v3 - Port ${PORT}`);
  console.log(`Gemini: ${GEMINI_API_KEY ? '✅ configuré' : '❌ manquant'}`);
  console.log(`Claude: ${process.env.ANTHROPIC_API_KEY ? '✅ configuré' : '❌ manquant'}`);
  console.log(`Tisséo: ${TISSEO_API_KEY ? '✅ configuré' : '❌ manquant (mode démo)'}`);
});
