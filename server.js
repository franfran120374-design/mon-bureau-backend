// Mon Bureau - Backend Render (sans stockage de tokens)
// Les tokens sont stockés côté frontend (localStorage)
// v2.0: googleapis supprimé → fetch natif Node 26 (pas de bug gzip)

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import webPush from 'web-push';
import mountEmploi from './emploi-routes.js';
dotenv.config();

// Supabase — projet ACTIF de Sandra (l'ancien tbbdkrapsmbzdfxxroda n'existe
// plus : la sync ordi<->telephone etait morte avec lui). Acces via fonctions
// RPC protegees par SYNC_DATA_KEY (voir SQL) : la cle anon est publique,
// aucune cle secrete Supabase n'est necessaire.
const SUPABASE_URL = (process.env.SUPABASE_URL || 'https://ezpqexxpktvvborsragt.supabase.co').replace(/\/+$/, '');
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'sb_publishable_01ckWqpnNrUlPeK464lKTA_yAnoOKO-';
const SYNC_DATA_KEY = process.env.SYNC_DATA_KEY || null;

async function supabaseRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Supabase ${fn}: HTTP ${r.status} ${text.slice(0, 150)}`);
  return text ? JSON.parse(text) : null;
}

const app = express();
const PORT = process.env.PORT || 3000;
const VERSION = '2.7.0';

// =================
// CONFIG
// =================

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// Web Push VAPID
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
let pushEnabled = false;
if (VAPID_PRIVATE_KEY) {
  try {
    webPush.setVapidDetails('mailto:mon-bureau@example.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    pushEnabled = true;
    console.log('[Push] ✅ VAPID configuré');
  } catch (e) {
    console.warn('[Push] ⚠️ VAPID invalide:', e.message);
  }
}

const pushSubscriptions = [];

// Identifiant interne fixe (pas un vrai compte) : Mon Bureau est mono-
// utilisatrice, ce n'est que la "boîte" Supabase où le serveur range son
// propre état (abonnements push + refresh token Google) pour survivre aux
// redémarrages (déploiement, veille du plan Render gratuit).
const SERVER_STATE_UID = 'mon-bureau-server-state';

async function loadServerState() {
  if (!SYNC_DATA_KEY) return;
  try {
    const rows = await supabaseRpc('sync_pull', { k: SYNC_DATA_KEY, uid: SERVER_STATE_UID });
    for (const row of (rows || [])) {
      if (row.category === 'push_subscriptions') pushSubscriptions.push(row.value);
      if (row.category === 'google_refresh_token') storedGoogleRefreshToken = row.value?.refresh_token || null;
      if (row.category === 'alert_departments' && Array.isArray(row.value?.departments) && row.value.departments.length) {
        alertDepartments = row.value.departments;
      }
    }
    console.log(`[State] Chargé depuis Supabase : ${pushSubscriptions.length} abonnement(s) push, refresh token ${storedGoogleRefreshToken ? 'présent' : 'absent'}, départements alerte [${alertDepartments.join(', ')}]`);
  } catch (e) {
    console.warn('[State] Chargement Supabase échoué:', e.message);
  }
}

async function persistPushSubscription(sub) {
  if (!SYNC_DATA_KEY || !sub?.endpoint) return;
  try {
    await supabaseRpc('sync_push', { k: SYNC_DATA_KEY, uid: SERVER_STATE_UID, items: [{ category: 'push_subscriptions', key: sub.endpoint, value: sub }] });
  } catch (e) {
    console.warn('[State] Sauvegarde abonnement push échouée:', e.message);
  }
}

async function removePushSubscription(endpoint) {
  if (!SYNC_DATA_KEY || !endpoint) return;
  try {
    await supabaseRpc('sync_delete', { k: SYNC_DATA_KEY, uid: SERVER_STATE_UID, cat: 'push_subscriptions', ky: endpoint });
  } catch (e) {
    console.warn('[State] Suppression abonnement push échouée:', e.message);
  }
}

// Refresh token Google conservé côté serveur (avec l'accord explicite de
// l'utilisatrice) : c'est le seul moyen pour le planificateur de rappels
// d'agenda (voir checkCalendarReminders) d'interroger Calendar de façon
// autonome, sans que le navigateur soit ouvert.
let storedGoogleRefreshToken = null;

async function persistGoogleRefreshToken(refreshToken, email) {
  if (!SYNC_DATA_KEY || !refreshToken) return;
  storedGoogleRefreshToken = refreshToken;
  try {
    await supabaseRpc('sync_push', { k: SYNC_DATA_KEY, uid: SERVER_STATE_UID, items: [{ category: 'google_refresh_token', key: 'primary', value: { refresh_token: refreshToken, email } }] });
  } catch (e) {
    console.warn('[State] Sauvegarde refresh token échouée:', e.message);
  }
}

// Départements suivis par le planificateur de notifications d'alerte (voir
// checkAlertNotifications) : persistés pour que le scheduler serveur sache
// quoi vérifier même quand l'app n'est pas ouverte. Détectés côté client par
// géolocalisation (POST /alerte/departments), avec 31/11 par défaut.
let alertDepartments = ['31', '11'];

async function persistAlertDepartments(departments) {
  if (!SYNC_DATA_KEY) return;
  try {
    await supabaseRpc('sync_push', { k: SYNC_DATA_KEY, uid: SERVER_STATE_UID, items: [{ category: 'alert_departments', key: 'list', value: { departments } }] });
  } catch (e) {
    console.warn('[State] Sauvegarde departements alerte échouée:', e.message);
  }
}

// =================
// MIDDLEWARE
// =================

const ALLOWED_ORIGINS = [
  process.env.FRONTEND_URL || 'https://mon-bureau.netlify.app',
  'https://mon-bureau.onrender.com',
  'https://franfran120374-design.github.io',
  'http://localhost:3000',
  'http://localhost:5173'
];
app.use(cors({
  origin: function(origin, callback) {
    if (!origin) return callback(null, true);
    if (ALLOWED_ORIGINS.some(o => origin.startsWith(o))) return callback(null, true);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '10mb' }));
// sendBeacon peut envoyer le corps en text/plain : on le parse aussi en JSON.
app.use(express.text({ type: ['text/plain', 'application/csp-report'], limit: '5mb' }));
app.use((req, res, next) => {
  if (typeof req.body === 'string' && req.body.trim().startsWith('{')) {
    try { req.body = JSON.parse(req.body); } catch (e) {}
  }
  next();
});

const chatLimiter = rateLimit({ windowMs: 60 * 1000, max: 20, message: { error: 'Trop de requêtes, attends 1 min' } });

// =================
// GOOGLE API HELPERS (fetch natif, pas de gaxios)
// =================

async function googleFetch(accessToken, url, options = {}, tokens = null) {
  let res = await fetch(url, {
    ...options,
    headers: {
      'Authorization': `Bearer ${accessToken}`,
      'Accept': 'application/json',
      ...options.headers
    }
  });
  // Si 401 et on a un refresh_token, rafraîchir et réessayer
  if (res.status === 401 && tokens?.refresh_token) {
    try {
      const newTokens = await refreshAccessToken(tokens.refresh_token);
      accessToken = newTokens.access_token;
      res = await fetch(url, {
        ...options,
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Accept': 'application/json',
          ...options.headers
        }
      });
    } catch (e) { /* refresh échoué, on garde l'erreur 401 */ }
  }
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Google API ${res.status}: ${err}`);
  }
  return res.json();
}

async function refreshAccessToken(refreshToken) {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: refreshToken,
      grant_type: 'refresh_token'
    }).toString()
  });
  if (!res.ok) throw new Error('Token refresh failed');
  const json = await res.json();
  // IMPORTANT : Google ne renvoie PAS le refresh_token lors d'un rafraichissement.
  // Sans cette ligne, le client ecrase son refresh_token par "undefined" et se
  // retrouve deconnecte au bout d'une heure. On le reconduit explicitement.
  if (!json.refresh_token) json.refresh_token = refreshToken;
  if (json.expires_in && !json.expiry_date) {
    json.expiry_date = Date.now() + (json.expires_in * 1000);
  }
  return json;
}

async function getValidAccessToken(tokens) {
  // v3 : on verifie l'expiration AVANT d'utiliser le token.
  // L'ancienne version renvoyait un access_token perime tant qu'il existait,
  // ce qui provoquait des 401 en cascade et la sensation d'etre deconnectee.
  const expired = tokens.expiry_date && tokens.expiry_date < (Date.now() + 60000);
  if (tokens.access_token && !expired) return tokens.access_token;
  if (tokens.refresh_token) {
    const newTokens = await refreshAccessToken(tokens.refresh_token);
    return newTokens.access_token;
  }
  if (tokens.access_token) return tokens.access_token;
  throw new Error('No valid token');
}

// =================
// ROUTES OAUTH
// =================

app.get('/auth/google/url', (req, res) => {
  const frontendUrl = req.query.frontend || '';
  // Validate state is a URL from an allowed origin
  let safeState = '/';
  try {
    const u = new URL(frontendUrl);
    if (ALLOWED_ORIGINS.some(o => u.origin.startsWith(o))) safeState = frontendUrl;
  } catch {}
  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    state: safeState
  });
  res.json({ url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
});

app.get('/auth/google/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code) return res.send('<h1>Erreur: code manquant</h1>');

  try {
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: GOOGLE_CLIENT_ID,
        client_secret: GOOGLE_CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: 'authorization_code'
      }).toString()
    });

    if (!tokenRes.ok) {
      const errText = await tokenRes.text();
      console.error('[OAuth] Token error:', tokenRes.status, errText);
      return res.send(`<h1>Erreur token</h1><pre>${errText}</pre>`);
    }

    const tokens = await tokenRes.json();
    const data = await googleFetch(tokens.access_token, 'https://www.googleapis.com/oauth2/v2/userinfo');

    // Conserve le refresh token côté serveur (accord explicite utilisatrice)
    // pour que le planificateur de rappels d'agenda (checkCalendarReminders)
    // puisse interroger Calendar même quand le navigateur est fermé.
    if (tokens.refresh_token) persistGoogleRefreshToken(tokens.refresh_token, data.email).catch(() => {});

    const accountData = {
      id: data.id,
      email: data.email,
      name: data.name || data.email,
      picture: data.picture,
      tokens,
      addedAt: Date.now()
    };

    const frontendUrl = state || '/';
    const accountB64 = Buffer.from(JSON.stringify(accountData)).toString('base64');
    const redirectUrl = `${frontendUrl.replace(/\/$/, '')}#google_auth=${accountB64}`;

    res.send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Connexion réussie</title>
<style>body{font-family:system-ui,sans-serif;padding:40px;text-align:center;background:#f5f5f5}
.card{background:#fff;padding:30px;border-radius:12px;max-width:400px;margin:0 auto;box-shadow:0 4px 12px rgba(0,0,0,.1)}
h1{color:#22c55e;margin:0 0 10px}p{color:#666}img{width:60px;height:60px;border-radius:50%;margin:10px 0}</style></head>
<body><div class="card"><h1>✓ Connecté</h1>
${data.picture ? `<img src="${data.picture}" alt="">` : ''}
<h2>${data.name || data.email}</h2><p>${data.email}</p></div>
<script>
const d=${JSON.stringify(accountData)};
if(window.opener){try{window.opener.postMessage({type:'GOOGLE_AUTH_SUCCESS',account:d},'*')}catch(e){}}
try{localStorage.setItem('pendingGoogleAuth',JSON.stringify(d))}catch(e){}

window.location.replace(${JSON.stringify(redirectUrl)});
</script></body></html>`);
  } catch (error) {
    console.error('[OAuth] Error:', error);
    res.send(`<h1>Erreur</h1><pre>${error.message}</pre>`);
  }
});

// =================
// HELPERS TOKENS
// =================

function getTokensFromRequest(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) throw new Error('Header Authorization manquant');
  try {
    return JSON.parse(Buffer.from(auth.substring(7), 'base64').toString('utf8'));
  } catch {
    throw new Error('Tokens invalides');
  }
}

// =================
// CALENDAR (REST natif)
// =================

app.get('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const params = new URLSearchParams({
      calendarId: 'primary',
      timeMin: req.query.timeMin || new Date().toISOString(),
      maxResults: req.query.maxResults || '50',
      singleEvents: 'true',
      orderBy: 'startTime'
    });
    const data = await googleFetch(accessToken, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, {}, tokens);
    res.json({ events: data.items, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Calendar] list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const data = await googleFetch(accessToken, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    }, tokens);
    res.json({ event: data, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Calendar] create error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${req.params.eventId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    res.json({ success: true, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Calendar] delete error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.patch('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const data = await googleFetch(accessToken, `https://www.googleapis.com/calendar/v3/calendars/primary/events/${req.params.eventId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body)
    }, tokens);
    res.json({ event: data, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Calendar] update error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =================
// DRIVE (REST natif)
// =================

app.get('/drive/files', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const params = new URLSearchParams({
      pageSize: req.query.pageSize || '20',
      fields: 'files(id,name,mimeType,modifiedTime,size,webViewLink)',
      q: req.query.query || 'trashed=false',
      orderBy: 'modifiedTime desc'
    });
    const data = await googleFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`, {}, tokens);
    res.json({ files: data.files, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] list error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/drive/search', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const q = (req.query.q || '').replace(/'/g, "\\'");
    const params = new URLSearchParams({
      pageSize: '20',
      fields: 'files(id,name,mimeType,modifiedTime,webViewLink)',
      q: `name contains '${q}' and trashed=false`
    });
    const data = await googleFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`, {}, tokens);
    res.json({ files: data.files, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] search error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/drive/upload', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const boundary = '----MonBureau' + Date.now();
    const metadata = JSON.stringify({ name: req.body.fileName });
    const content = req.body.content || '';
    const mimeType = req.body.mimeType || 'text/plain';
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`;

    const res2 = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': `multipart/related; boundary=${boundary}`
      },
      body
    });
    const data = await res2.json();
    res.json({ file: data, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] upload error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/drive/download/:fileId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const r = await fetch(`https://www.googleapis.com/drive/v3/files/${req.params.fileId}?alt=media`, {
      headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    const buffer = Buffer.from(await r.arrayBuffer());
    res.json({ content: buffer.toString('base64'), tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] download error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/drive/create-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const folderMeta = {
      name: req.body.folderName,
      mimeType: 'application/vnd.google-apps.folder'
    };
    // agent-drive-save envoie un parentId pour créer des sous-dossiers
    if (req.body.parentId) folderMeta.parents = [String(req.body.parentId)];
    const data = await googleFetch(accessToken, 'https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(folderMeta)
    }, tokens);
    res.json({ folder: data, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] folder error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =================
// DRIVE — routes utilisées par les agents (drive-save, approfondir).
// Elles n'avaient jamais été implémentées : chaque sauvegarde d'agent
// échouait en silence depuis la création de ces fichiers.
// =================

function escapeDriveQuery(s) {
  return String(s).replace(/'/g, "\\'");
}

async function findOrCreateFolder(accessToken, tokens, folderName, parentId) {
  let q = `name='${escapeDriveQuery(folderName)}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  if (parentId) q += ` and '${String(parentId).replace(/'/g, '')}' in parents`;
  const params = new URLSearchParams({ pageSize: '1', fields: 'files(id)', q });
  const found = await googleFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`, {}, tokens);
  if (found.files?.length) return found.files[0].id;
  const metadata = { name: folderName, mimeType: 'application/vnd.google-apps.folder' };
  if (parentId) metadata.parents = [parentId];
  const created = await googleFetch(accessToken, 'https://www.googleapis.com/drive/v3/files', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(metadata)
  }, tokens);
  return created.id;
}

// Upload multipart générique — création (POST) ou remplacement (PATCH + fileId)
async function driveMultipartUpload(accessToken, tokens, { metadata, content, contentType, fileId }) {
  const boundary = '----MonBureauUpload' + Date.now();
  const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata || {})}\r\n--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n${content}\r\n--${boundary}--`;
  const url = fileId
    ? `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=multipart&fields=id,name,webViewLink`
    : 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink';
  return googleFetch(accessToken, url, {
    method: fileId ? 'PATCH' : 'POST',
    headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
    body
  }, tokens);
}

app.get('/drive/search-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    let q = `name='${escapeDriveQuery(req.query.name || '')}' and mimeType='application/vnd.google-apps.folder' and trashed=false`;
    if (req.query.parentId) q += ` and '${String(req.query.parentId).replace(/'/g, '')}' in parents`;
    const params = new URLSearchParams({ pageSize: '1', fields: 'files(id,name,webViewLink)', q });
    const data = await googleFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`, {}, tokens);
    res.json({ folder: data.files?.[0] || null, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] search-folder error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.post('/drive/save-agent', async (req, res) => {
  try {
    const { fileName, content, folderName, mimeType } = req.body;
    if (!fileName || !content) return res.status(400).json({ success: false, error: 'fileName et content requis' });
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const metadata = { name: fileName };
    if (folderName) metadata.parents = [await findOrCreateFolder(accessToken, tokens, folderName)];
    const file = await driveMultipartUpload(accessToken, tokens, { metadata, content, contentType: mimeType || 'text/plain' });
    res.json({ success: true, file, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] save-agent error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/drive/create-doc-in-folder', async (req, res) => {
  try {
    const { title, content, folderId } = req.body;
    if (!title) return res.status(400).json({ success: false, error: 'title requis' });
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const metadata = { name: title, mimeType: 'application/vnd.google-apps.document' }; // conversion en Google Doc natif
    if (folderId) metadata.parents = [String(folderId)];
    const file = await driveMultipartUpload(accessToken, tokens, { metadata, content: content || '', contentType: 'text/plain' });
    res.json({ success: true, docId: file.id, webViewLink: file.webViewLink, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] create-doc error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Ajoute du texte à la fin d'un Google Doc identifié par son titre (créé s'il
// n'existe pas). Le scope OAuth ne couvre que Drive (pas l'API Docs) : on
// exporte le texte existant, on concatène, on ré-uploade avec conversion —
// suffisant pour ces journaux en texte simple.
app.post('/drive/append-to-doc', async (req, res) => {
  try {
    const { docTitle, content, folderName } = req.body;
    if (!docTitle || !content) return res.status(400).json({ success: false, error: 'docTitle et content requis' });
    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);
    const folderId = folderName ? await findOrCreateFolder(accessToken, tokens, folderName) : null;

    let q = `name='${escapeDriveQuery(docTitle)}' and mimeType='application/vnd.google-apps.document' and trashed=false`;
    if (folderId) q += ` and '${folderId}' in parents`;
    const params = new URLSearchParams({ pageSize: '1', fields: 'files(id,webViewLink)', q });
    const found = await googleFetch(accessToken, `https://www.googleapis.com/drive/v3/files?${params}`, {}, tokens);

    let file;
    if (found.files?.length) {
      const docId = found.files[0].id;
      const exp = await fetch(`https://www.googleapis.com/drive/v3/files/${docId}/export?mimeType=text/plain`, {
        headers: { Authorization: `Bearer ${accessToken}` }
      });
      const oldText = exp.ok ? await exp.text() : '';
      file = await driveMultipartUpload(accessToken, tokens, {
        metadata: {},
        content: `${oldText.trimEnd()}\n\n${content}`,
        contentType: 'text/plain',
        fileId: docId
      });
    } else {
      const metadata = { name: docTitle, mimeType: 'application/vnd.google-apps.document' };
      if (folderId) metadata.parents = [folderId];
      file = await driveMultipartUpload(accessToken, tokens, { metadata, content, contentType: 'text/plain' });
    }
    res.json({ success: true, docId: file.id, webViewLink: file.webViewLink, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] append-to-doc error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// FICHE — synthèse d'un article (résumé + fact-check + tags) via l'agrégateur IA,
// sauvegardée sur Drive en Google Doc natif après validation explicite de l'utilisateur.
// =================

function buildFichePrompt(title, content, url) {
  const escapedContent = String(content || '').substring(0, 6000).replace(/`/g, '\\`');
  return `Tu es documentaliste et rédacteur. À partir de l'article fourni, rédige un véritable DOSSIER DE RECHERCHE en français : une rédaction élaborée et fluide, pas une liste de tirets. Réponds STRICTEMENT dans ce format markdown, sans rien ajouter avant ou après :

## L'essentiel
(Un chapeau journalistique de 3-4 phrases : de quoi il s'agit, pourquoi c'est important, pour qui.)

## Analyse
(Une vraie rédaction de 3 à 5 paragraphes construits : le contexte et l'historique du sujet, les faits rapportés par l'article, les enjeux et points de débat, une mise en perspective. Phrases complètes, transitions soignées, ton neutre et précis. Cite les acteurs et les chiffres de l'article quand ils existent.)

## Vérification factuelle
Verdict : (Vrai / Faux / Non vérifiable / Partiellement vrai)
Confiance : (un pourcentage)
Justification : (2-3 phrases expliquant le verdict)

## Pour aller plus loin
### 📚 Lectures conseillées
(2 à 3 livres ou essais réels en lien avec le sujet : auteur, titre en italique, année, et une phrase expliquant pourquoi le lire.)

### 🎬 Films & documentaires
(1 à 3 films ou documentaires réels en lien avec le sujet : titre en italique, réalisateur, année, et une phrase sur ce qu'il apporte à la réflexion.)

### 🔗 Liens utiles
(2 à 4 liens au format markdown [nom du site — sujet de la page](URL). RÈGLE ABSOLUE : uniquement des URL dont tu es certain qu'elles existent — page Wikipédia du sujet, site officiel d'une institution citée, l'URL source de l'article. N'invente JAMAIS une URL : en cas de doute, donne le nom de la ressource sans lien.)

## Pistes de réflexion — développées
(2 ou 3 questions ouvertes qui prolongent le sujet. Pour CHAQUE question, rédige un vrai développement de recherche en 2 à 4 paragraphes, comme le ferait un chercheur, un analyste et un savant : replace la question dans un contexte plus large que l'article seul, présente au moins deux angles ou écoles de pensée qui s'opposent sur le sujet, appuie chaque angle sur des faits, données ou exemples concrets — ceux de l'article et des connaissances générales avérées — signale les incertitudes ou limites de l'analyse quand elles existent, et termine par une ouverture qui invite le lecteur à se positionner. Format pour chaque question :
### [La question, reformulée et complète]
(le développement, en paragraphes rédigés, sans liste à puces))

## Mots-clés
(3 à 6 mots-clés séparés par des virgules, en minuscules)

<suggestions>
(Répète ici les œuvres de "Pour aller plus loin" en JSON STRICT sur une seule ligne, rien d'autre dans cette balise :
{"lectures":[{"titre":"...","auteur":"...","annee":2020}],"films":[{"titre":"...","realisateur":"...","annee":2021,"type":"film"}]}
Le champ "type" vaut "film", "documentaire" ou "serie".)
</suggestions>

---
Titre de l'article : ${title || 'N/A'}
URL : ${url || 'N/A'}
Contenu : ${escapedContent}`;
}

// Extrait le bloc <suggestions>...</suggestions> de la réponse IA : retiré du
// texte de la fiche (il ne doit pas finir dans le Google Doc), renvoyé à part
// pour les boutons "Ajouter à Loisirs" du frontend. null si absent/malformé.
function extractSuggestions(analyse) {
  const match = analyse.match(/<suggestions>([\s\S]*?)<\/suggestions>/i);
  if (!match) return { cleaned: analyse, suggestions: null };
  const cleaned = analyse.replace(match[0], '').trimEnd();
  try {
    const jsonMatch = match[1].match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { cleaned, suggestions: null };
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      cleaned,
      suggestions: {
        lectures: Array.isArray(parsed.lectures) ? parsed.lectures : [],
        films: Array.isArray(parsed.films) ? parsed.films : []
      }
    };
  } catch (e) {
    return { cleaned, suggestions: null };
  }
}

// Étape 1/2 : génère le contenu (agrégateur IA), sans toucher Drive — pas d'auth
// Google requise. L'utilisateur relit/édite avant de valider via /fiche/save.
app.post('/fiche/preview', async (req, res) => {
  try {
    const { title, content, url, sourceDate } = req.body;
    if (!content && !title) return res.status(400).json({ error: 'content ou title requis' });

    const prompt = buildFichePrompt(title, content, url);
    const aggregatorResult = await callAggregator(prompt, 'raisonnement');
    const analyse = aggregatorResult.response || '';

    // Suggestions (lectures/films) extraites en JSON pour les boutons
    // "Ajouter à Loisirs" — le bloc est retiré du texte de la fiche.
    const { cleaned, suggestions } = extractSuggestions(analyse);

    const now = new Date().toISOString().slice(0, 10);
    const ficheContent = `# ${title || 'Fiche sans titre'}

**Source :** ${url || 'N/A'}
**Date de l'article :** ${sourceDate || 'inconnue'}
**Fiche créée le :** ${now}

${cleaned}
`;

    res.json({
      success: true,
      title: title || 'Fiche sans titre',
      ficheContent,
      suggestions,
      provider: aggregatorResult.provider,
      model: aggregatorResult.model
    });
  } catch (error) {
    console.error('[Fiche] preview error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Étape 2/2 : enregistre le contenu (potentiellement édité) sur Drive en Google
// Doc natif (conversion automatique via l'upload multipart), après validation.
app.post('/fiche/save', async (req, res) => {
  try {
    const { title, ficheContent, folderId } = req.body;
    if (!ficheContent) return res.status(400).json({ error: 'ficheContent requis' });

    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);

    const boundary = '----MonBureauFiche' + Date.now();
    const metadata = {
      name: `Fiche - ${(title || 'sans titre').substring(0, 80)}`,
      mimeType: 'application/vnd.google-apps.document' // converti en Google Doc natif
    };
    if (folderId) metadata.parents = [folderId];
    const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${ficheContent}\r\n--${boundary}--`;

    // googleFetch() gère le retry automatique avec refresh du token sur un 401
    // (getValidAccessToken seul renvoie l'access_token tel quel sans le valider,
    // donc un token périmé faisait échouer l'upload avec un 500 générique).
    const file = await googleFetch(
      accessToken,
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink',
      { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body },
      tokens
    );

    res.json({ success: true, file, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Fiche] save error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Rend un fichier Drive accessible par lien (lecture seule), à la demande —
// les fiches sont privées par défaut à la création, ce endpoint n'est appelé
// que quand l'utilisateur clique explicitement sur "Partager".
app.post('/drive/share', async (req, res) => {
  try {
    const { fileId } = req.body;
    if (!fileId) return res.status(400).json({ error: 'fileId requis' });

    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);

    await googleFetch(
      accessToken,
      `https://www.googleapis.com/drive/v3/files/${fileId}/permissions`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: 'reader', type: 'anyone' }) },
      tokens
    );

    res.json({ success: true, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Drive] share error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// HEALTH
// =================

app.get('/', (req, res) => res.json({ name: 'Mon Bureau Backend', version: VERSION, status: 'ok' }));
app.get('/health', (req, res) => res.json({ status: 'ok', version: VERSION }));

// =================
// SYNC — Supabase Cloud (ordi ↔ téléphone)
// =================

function validateUserId(userId) {
  if (!userId || typeof userId !== 'string') return null;
  if (userId.length < 3 || userId.length > 100) return null;
  if (!/^[a-zA-Z0-9_@.\-]+$/.test(userId)) return null;
  return userId;
}

// sendBeacon() ne permet aucun en-tete personnalise : quand l'appli se ferme
// sur Android, l'identite arrive dans l'URL (?uid=) ou dans le corps JSON.
// On accepte les trois sources, dans cet ordre de priorite.
function resolveUserId(req) {
  return validateUserId(req.headers['x-user-id'])
      || validateUserId(req.query && req.query.uid)
      || validateUserId(req.body && req.body.userId);
}

// Pull: récupérer toutes les données d'un user
app.get('/sync/pull', async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ error: 'Invalid x-user-id' });

    if (!SYNC_DATA_KEY) return res.status(503).json({ error: 'Sync non configuree (SYNC_DATA_KEY manquante)' });
    const rows = await supabaseRpc('sync_pull', { k: SYNC_DATA_KEY, uid: userId });

    // Organiser par catégorie
    const synced = {};
    for (const row of (rows || [])) {
      if (!synced[row.category]) synced[row.category] = {};
      synced[row.category][row.key] = row.value;
    }

    res.json({ success: true, data: synced });
  } catch (error) {
    console.error('[Sync] Pull error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Push: sauvegarder des données (upsert)
app.post('/sync/push', async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ error: 'Invalid x-user-id' });

    const { items } = req.body; // [{category, key, value}]
    if (!items || !items.length) return res.status(400).json({ error: 'items required' });

    if (!SYNC_DATA_KEY) return res.status(503).json({ error: 'Sync non configuree (SYNC_DATA_KEY manquante)' });
    const clean = items
      .filter(i => i && i.category && i.key)
      .map(i => ({ category: String(i.category), key: String(i.key), value: i.value }));
    const saved = await supabaseRpc('sync_push', { k: SYNC_DATA_KEY, uid: userId, items: clean });

    res.json({ success: true, saved: saved ?? clean.length });
  } catch (error) {
    console.error('[Sync] Push error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Push: supprimer des données
app.post('/sync/delete', async (req, res) => {
  try {
    const userId = resolveUserId(req);
    if (!userId) return res.status(400).json({ error: 'Invalid x-user-id' });

    const { category, key } = req.body;
    if (!category) return res.status(400).json({ error: 'category required' });

    if (!SYNC_DATA_KEY) return res.status(503).json({ error: 'Sync non configuree (SYNC_DATA_KEY manquante)' });
    await supabaseRpc('sync_delete', { k: SYNC_DATA_KEY, uid: userId, cat: String(category), ky: key ? String(key) : null });

    res.json({ success: true });
  } catch (error) {
    console.error('[Sync] Delete error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// =================
// IA — MiMo V2.5 Free
// =================

const MIMO_API_URL = process.env.MIMO_API_URL || 'https://opencode.ai/zen/v1/chat/completions';
const MIMO_MODEL = process.env.MIMO_MODEL || 'mimo-v2.5-free';

async function callMimo(messages, system, maxTokens = 1024) {
  const allMessages = [];
  if (system) allMessages.push({ role: 'system', content: system });
  for (const m of messages) {
    let content = m.content;
    if (Array.isArray(content)) content = content.filter(b => b.type === 'text').map(b => b.text).join('\n\n');
    if (typeof content !== 'string') content = String(content || '');
    if (content.trim()) allMessages.push({ role: m.role, content });
  }
  if (allMessages.length <= 1) throw new Error('Aucun message valide');

  let response;
  try {
    response = await fetch(MIMO_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: MIMO_MODEL, messages: allMessages, max_tokens: maxTokens, temperature: 0.7, top_p: 0.95 })
    });
  } catch (fetchErr) {
    console.error('[MiMo] Fetch error:', fetchErr.message);
    throw new Error('Impossible de contacter le service IA');
  }

  if (!response.ok) {
    let errMsg;
    try { const err = await response.json(); errMsg = err.error?.message || `MiMo error ${response.status}`; }
    catch { errMsg = `MiMo error ${response.status}`; }
    console.error('[MiMo] API error:', response.status, errMsg);
    throw new Error(errMsg);
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  return { content: [{ type: 'text', text }] };
}

// =================
// AGRÉGATEUR IA (Groq/Gemini/OpenRouter gratuits, ~20 modèles avec fallback
// automatique par quota/catégorie) — voir repo ai-aggregator, déployé sur Render.
// Utilisé par défaut pour résumé/factcheck RSS à la place de MiMo (un seul
// modèle, sans fallback). 100% gratuit, aucune clé payante requise.
// =================

const AGGREGATOR_URL = process.env.AGGREGATOR_URL;
const AGGREGATOR_ACCESS_TOKEN = process.env.AGGREGATOR_ACCESS_TOKEN;

async function _callAggregatorOnce(prompt, category) {
  const response = await fetch(`${AGGREGATOR_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AGGREGATOR_ACCESS_TOKEN ? { 'X-Access-Token': AGGREGATOR_ACCESS_TOKEN } : {})
    },
    body: JSON.stringify({ prompt, category })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    const error = new Error(err.detail || `Agrégateur IA error: ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return response.json(); // { response, category, provider, model }
}

// Le service ai-aggregator (Render, plan gratuit) s'endort après 15 min sans
// requête : la toute première requête peut recevoir un 502/503 le temps qu'il
// se réveille. Une seule tentative de plus après une courte pause suffit.
// Délais cumulés ~27s (5+10+12), sous la marge des timeouts frontend (30-45s) —
// un cold start Render peut prendre 15-50s, un seul essai à 4s ne suffisait pas.
async function callAggregator(prompt, category) {
  if (!AGGREGATOR_URL) throw new Error('AGGREGATOR_URL non configurée');
  const delays = [5000, 10000, 12000];
  let lastError;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await _callAggregatorOnce(prompt, category);
    } catch (error) {
      lastError = error;
      if (error.status !== 502 && error.status !== 503) throw error;
      if (attempt < delays.length) {
        console.warn(`[Aggregator] cold start probable (${error.status}), nouvelle tentative dans ${delays[attempt] / 1000}s...`);
        await new Promise(r => setTimeout(r, delays[attempt]));
      }
    }
  }
  throw lastError;
}

// =================
// CHAT (consolidated)
// Accepte { messages, system } (agents) OU { message, context } (assistant)
// =================

app.post('/chat', chatLimiter, async (req, res) => {
  try {
    let messages, system;
    if (req.body.messages && req.body.messages.length) {
      messages = req.body.messages;
      system = req.body.system;
    } else if (req.body.message) {
      messages = [{ role: 'user', content: req.body.message }];
      system = req.body.context?.system || 'Tu es un assistant utile. Réponds en français.';
    } else {
      return res.status(400).json({ error: 'messages or message required' });
    }
    const data = await callMimo(messages, system, 2048);
    res.json({ success: true, content: data.content });
  } catch (error) {
    console.error('[MiMo] chat error:', error.message);
    res.json({ success: true, content: [{ type: 'text', text: `⚠️ Erreur IA : ${error.message}` }] });
  }
});

// Anciens endpoints → rediriger vers /chat
app.post('/agents/chat', (req, res) => { req.url = '/chat'; app.handle(req, res); });
app.post('/claude/chat', (req, res) => { req.url = '/chat'; app.handle(req, res); });

app.post('/claude/summarize', async (req, res) => {
  // Passe par l'agrégateur IA (Groq/Gemini/OpenRouter, fallback multi-modèles).
  // Si l'agrégateur est indisponible (AGGREGATOR_URL absente, panne réseau...),
  // retombe sur MiMo pour ne jamais casser la fonctionnalité.
  try {
    const { text, type } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const escapedText = String(text).substring(0, 4000).replace(/`/g, '\\`');
    const prompt = `Résume ce texte en 3-5 phrases claires et concises, en français. Type: ${type || 'article'}.\n\n${escapedText}`;
    try {
      const data = await callAggregator(prompt, 'contexte_long');
      return res.json({ success: true, summary: data.response || '', provider: data.provider, model: data.model });
    } catch (aggError) {
      console.warn('[Aggregator] summarize indisponible, fallback MiMo:', aggError.message);
      const system = `Résume en 3-5 bullet points en français. Type: ${type || 'article'}.`;
      const data = await callMimo([{ role: 'user', content: text }], system, 512);
      return res.json({ success: true, summary: data.content[0]?.text || '', provider: 'mimo', model: MIMO_MODEL });
    }
  } catch (error) {
    console.error('[Summarize] error:', error.message);
    res.json({ success: true, summary: `⚠️ Erreur : ${error.message}` });
  }
});

app.post('/claude/factcheck', async (req, res) => {
  // Nom de route conservé (compat frontend). Passe par l'agrégateur IA, avec
  // fallback MiMo si l'agrégateur est indisponible.
  try {
    const { title, content, url } = req.body;
    if (!content && !title) return res.status(400).json({ error: 'content required' });
    const escapedContent = String(content || '').substring(0, 4000).replace(/`/g, '\\`');
    const prompt = `Tu es un fact-checker. Vérifie l'affirmation ou l'article suivant et réponds en français, de façon structurée avec : verdict (Vrai/Faux/Non vérifiable/Partiellement vrai), confiance (%), contexte (2-3 phrases).\n\nTitre: ${title || 'N/A'}\nContenu: ${escapedContent}\nURL: ${url || 'N/A'}`;
    try {
      const data = await callAggregator(prompt, 'raisonnement');
      return res.json({ success: true, result: data.response || '', provider: data.provider, model: data.model });
    } catch (aggError) {
      console.warn('[Aggregator] factcheck indisponible, fallback MiMo:', aggError.message);
      const system = 'Vérifie si c\'est vraisemblable, faux, ou non vérifiable. Réponds en français.';
      const escapedContentForMimo = String(content || '').replace(/`/g, '\\`');
      const data = await callMimo([{ role: 'user', content: `Titre: ${title || 'N/A'}\nContenu: ${escapedContentForMimo}\nURL: ${url || 'N/A'}` }], system, 1024);
      return res.json({ success: true, result: data.content[0]?.text || '', provider: 'mimo', model: MIMO_MODEL });
    }
  } catch (error) {
    console.error('[Factcheck] error:', error.message);
    res.json({ success: true, result: `⚠️ Erreur : ${error.message}` });
  }
});

app.post('/claude/analyze', async (req, res) => {
  try {
    const { type, data: analysisData } = req.body;
    const system = 'Analyse les données et donne un retour structuré en français.';
    const data = await callMimo([{ role: 'user', content: JSON.stringify(analysisData) }], system, 1024);
    res.json({ success: true, analysis: data.content[0]?.text || '' });
  } catch (error) {
    console.error('[MiMo] analyze error:', error.message);
    res.json({ success: true, analysis: `⚠️ Erreur : ${error.message}` });
  }
});

// =================
// LASTFM
// =================

const LASTFM_API_KEY = process.env.LASTFM_API_KEY;

app.get('/agents/lastfm/gettoptracks', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({ method: 'user.gettoptracks', api_key: LASTFM_API_KEY, user: req.query.user || 'franfran120374', format: 'json', limit: req.query.limit || '10', period: req.query.period || '1month' });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    res.json({ success: true, data: await r.json() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agents/lastfm/gettopartists', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({ method: 'user.gettopartists', api_key: LASTFM_API_KEY, user: req.query.user || 'franfran120374', format: 'json', limit: req.query.limit || '10', period: req.query.period || 'overall' });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    res.json({ success: true, data: await r.json() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/agents/lastfm/getrecenttracks', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({ method: 'user.getrecenttracks', api_key: LASTFM_API_KEY, user: req.query.user || 'franfran120374', format: 'json', limit: req.query.limit || '10' });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    res.json({ success: true, data: await r.json() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =================
// METEO — Open-Meteo (cached 5 min)
// =================

const meteoCache = { data: null, timestamp: 0 };
const METEO_TTL = 5 * 60 * 1000;

app.get('/meteo/actuelle', async (req, res) => {
  try {
    if (meteoCache.data && Date.now() - meteoCache.timestamp < METEO_TTL) {
      return res.json({ success: true, data: meteoCache.data });
    }
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=43.6047&longitude=1.4442&current_weather=true&hourly=temperature_2m,relativehumidity_2m,precipitation_probability,windspeed_10m,uv_index&timezone=Europe/Paris');
    const data = await r.json();
    meteoCache.data = data;
    meteoCache.timestamp = Date.now();
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.get('/meteo/heure', async (req, res) => {
  try {
    const datetime = req.query.datetime || new Date().toISOString();
    const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=43.6047&longitude=1.4442&hourly=temperature_2m,apparent_temperature,precipitation_probability,windspeed_10m,uv_index&timezone=Europe/Paris&start=${datetime}&end=${datetime}`);
    const data = await r.json();
    const h = data.hourly || {};
    res.json({ success: true, meteo: { temperature: h.temperature_2m?.[0] || 0, apparentTemp: h.apparent_temperature?.[0] || 0, precipProb: h.precipitation_probability?.[0] || 0, windspeed: h.windspeed_10m?.[0] || 0, uvIndex: h.uv_index?.[0] || 0 } });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

app.post('/meteo/conseils-rdv', async (req, res) => {
  try {
    const { eventTitle, departTime } = req.body;
    const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=43.6047&longitude=1.4442&hourly=temperature_2m,apparent_temperature,precipitation_probability,windspeed_10m,weathercode&timezone=Europe/Paris');
    const data = await r.json();
    const h = data.hourly || {};
    const depart = departTime ? new Date(departTime) : new Date();
    const idx = Math.max(0, Math.min(23, depart.getHours()));
    const temp = h.temperature_2m?.[idx] || 15;
    const precip = h.precipitation_probability?.[idx] || 0;
    const wind = h.windspeed_10m?.[idx] || 0;
    let vetements = [];
    if (temp < 10) vetements.push('🧥 Manteau');
    if (temp < 5) vetements.push('🧤 Gants');
    if (precip > 50) vetements.push('☂️ Parapluie');
    if (precip > 30 && precip <= 50) vetements.push('🧥 Imperméable');
    if (temp > 25 && precip < 10) vetements.push('🧴 Crème solaire');
    if (wind > 30) vetements.push('💨 Coupe-vent');
    if (temp > 15 && temp <= 25 && precip < 20) vetements.push('👌 Confortable');
    if (vetements.length === 0) vetements.push('👌 Tenue standard');
    const resume = `${eventTitle || 'RDV'} — ${Math.round(temp)}°C, pluie ${precip}%, vent ${Math.round(wind)} km/h. ${vetements.join(', ')}`;
    res.json({ success: true, resume, temp, precip, wind, conseils: vetements });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// =================
// MAPS — Routage open source : Nominatim (géocodage) + OSRM (voiture/vélo/
// à pied, instances FOSSGIS) + Transitous/MOTIS (transports en commun, GTFS
// Tisséo inclus). Remplace Google Directions : aucune clé, données
// OpenStreetMap. Les réponses gardent le format Google (status/routes/legs)
// pour ne rien changer côté frontend.
// =================

const DEFAULT_ORIGIN = process.env.HOME_ADDRESS || '10 rue Etienne Bacquié, Toulouse';

const _geoCache = new Map(); // adresse → { lat, lon } (Nominatim limite à 1 req/s)

// Les API publiques utilisées ici (Nominatim, OSRM openstreetmap.de, Transitous)
// sont gratuites, mutualisées et sans SLA : elles échouent ou timeout par
// intermittence sous charge. On absorbe ça avec 3 tentatives + court délai
// avant de considérer que c'est une vraie panne.
async function fetchWithRetry(url, options = {}, attempts = 3, delayMs = 600) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, options);
      if (!r.ok && r.status >= 500 && i < attempts - 1) {
        // Erreur serveur transitoire → on retente
        throw new Error(`HTTP ${r.status}`);
      }
      return r;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise(res => setTimeout(res, delayMs * (i + 1)));
    }
  }
  throw lastErr;
}

async function geocode(address) {
  const key = String(address).trim().toLowerCase();
  if (_geoCache.has(key)) return _geoCache.get(key);
  const params = new URLSearchParams({ q: address, format: 'json', limit: '1' });
  const r = await fetchWithRetry(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { 'User-Agent': 'MonBureau/2.3 (app personnelle)' }
  });
  const data = await r.json();
  if (!Array.isArray(data) || !data.length) throw new Error(`Adresse introuvable : ${address}`);
  const pt = { lat: parseFloat(data[0].lat), lon: parseFloat(data[0].lon) };
  _geoCache.set(key, pt);
  return pt;
}

// Géocodage inverse (coordonnées -> département) pour la tuile Alerte : permet
// au frontend de proposer "utiliser ma position" et de faire suivre les bonnes
// alertes (MétéoAlerte + préfecture) sans que l'utilisatrice saisisse elle-même
// son département.
async function reverseGeocodeDepartment(lat, lon) {
  const params = new URLSearchParams({ lat, lon, format: 'json', 'accept-language': 'fr', zoom: '8' });
  const r = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
    headers: { 'User-Agent': 'MonBureau/2.7 (app personnelle)' }
  });
  const data = await r.json();
  const addr = data.address || {};
  const postcode = addr.postcode || '';
  let department = null;
  if (/^97[1-6]/.test(postcode)) department = postcode.slice(0, 3); // DOM
  else if (/^20/.test(postcode)) {
    // Corse : approximation par plage de code postal (2A ~ 200xx-201xx, 2B au-delà)
    department = parseInt(postcode.slice(0, 5), 10) <= 20169 ? '2A' : '2B';
  } else if (/^\d{5}$/.test(postcode)) department = postcode.slice(0, 2);

  return {
    department,
    departmentName: addr.county || addr.state_district || addr.state || null,
    city: addr.city || addr.town || addr.village || addr.municipality || null
  };
}

function fmtDuration(sec) {
  const min = Math.max(1, Math.round(sec / 60));
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

function fmtDistance(m) {
  if (m == null) return '';
  return m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

const OSRM_PROFILES = {
  driving: 'routed-car/route/v1/driving',
  walking: 'routed-foot/route/v1/foot',
  bicycling: 'routed-bike/route/v1/bike',
};

async function routeOsrm(mode, from, to) {
  const profile = OSRM_PROFILES[mode] || OSRM_PROFILES.driving;
  const r = await fetchWithRetry(
    `https://routing.openstreetmap.de/${profile}/${from.lon},${from.lat};${to.lon},${to.lat}?overview=false`,
    { headers: { 'User-Agent': 'MonBureau/2.3' } }
  );
  const data = await r.json();
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('OSRM : itinéraire non trouvé');
  const rt = data.routes[0];
  return { durationSec: Math.round(rt.duration), distanceM: Math.round(rt.distance), legs: [] };
}

const TRANSITOUS_VEHICLES = {
  SUBWAY: 'SUBWAY', METRO: 'SUBWAY', BUS: 'BUS', TRAM: 'TRAM',
  RAIL: 'HEAVY_RAIL', HIGHSPEED_RAIL: 'HEAVY_RAIL', REGIONAL_RAIL: 'HEAVY_RAIL',
  REGIONAL_FAST_RAIL: 'HEAVY_RAIL', COACH: 'BUS', FERRY: 'FERRY',
};

async function routeTransitous(from, to, arrivalTime) {
  const params = new URLSearchParams({
    fromPlace: `${from.lat},${from.lon}`,
    toPlace: `${to.lat},${to.lon}`,
    numItineraries: '3',
  });
  if (arrivalTime) {
    params.set('time', new Date(arrivalTime).toISOString());
    params.set('arriveBy', 'true');
  }
  const r = await fetchWithRetry(`https://api.transitous.org/api/v3/plan?${params}`, {
    headers: { 'User-Agent': 'MonBureau/2.3' }
  });
  const data = await r.json();
  const it = data.itineraries?.[0];
  if (!it) throw new Error('Transitous : aucun itinéraire trouvé');
  return { durationSec: Math.round(it.duration), distanceM: null, legs: it.legs || [] };
}

// Calcule un itinéraire et le renvoie au format Google Directions.
async function computeRoute({ origin, destination, mode = 'transit', arrivalTime }) {
  const from = await geocode(origin);   // séquentiel : politesse Nominatim (1 req/s)
  const to = await geocode(destination);

  let core, estimated = false;
  if (mode === 'transit') {
    try {
      core = await routeTransitous(from, to, arrivalTime);
    } catch (e) {
      // Repli : estimation TC depuis le temps voiture (×1,9 + 8 min d'attente)
      console.warn('[Maps] Transitous indisponible, estimation:', e.message);
      const car = await routeOsrm('driving', from, to);
      core = { durationSec: Math.round(car.durationSec * 1.9 + 8 * 60), distanceM: car.distanceM, legs: [] };
      estimated = true;
    }
  } else {
    core = await routeOsrm(mode, from, to);
  }

  const steps = core.legs.map(leg => {
    const walk = leg.mode === 'WALK';
    return {
      travel_mode: walk ? 'WALKING' : 'TRANSIT',
      duration: { value: Math.round(leg.duration || 0), text: fmtDuration(leg.duration || 0) },
      html_instructions: walk
        ? `Marcher jusqu'à ${leg.to?.name === 'END' ? 'destination' : (leg.to?.name || 'la suite')}`
        : `${leg.routeShortName || ''} direction ${leg.headsign || leg.to?.name || ''}`.trim(),
      transit_details: walk ? undefined : {
        line: {
          short_name: leg.routeShortName || '',
          name: leg.routeLongName || leg.routeShortName || '',
          vehicle: { type: TRANSITOUS_VEHICLES[leg.mode] || 'BUS' },
        },
        headsign: leg.headsign || '',
        departure_stop: { name: leg.from?.name || '' },
        arrival_stop: { name: leg.to?.name || '' },
        num_stops: Array.isArray(leg.intermediateStops) ? leg.intermediateStops.length + 1 : undefined,
      },
    };
  });

  return {
    status: 'OK',
    provider: estimated ? 'estimation-osrm' : (mode === 'transit' ? 'transitous' : 'osrm'),
    routes: [{
      legs: [{
        duration: { value: core.durationSec, text: fmtDuration(core.durationSec) },
        distance: { value: core.distanceM || 0, text: fmtDistance(core.distanceM) },
        steps,
      }],
    }],
  };
}

function buildRappel(arrivalTime, durationSec, prepMinutes) {
  if (!arrivalTime || !durationSec) return null;
  const departMs = new Date(arrivalTime).getTime() - (durationSec * 1000) - ((prepMinutes || 10) * 60000);
  const minutesUntil = Math.round((departMs - Date.now()) / 60000);
  return {
    departureText: new Date(departMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }),
    minutesUntilDeparture: minutesUntil,
    isUrgent: minutesUntil <= 30,
    isLate: minutesUntil < 0,
    message: minutesUntil < 0 ? `⚠️ Retard ${Math.abs(minutesUntil)} min !` : minutesUntil <= 30 ? `⚠️ Partir dans ${minutesUntil} min` : `Tu peux partir dans ${minutesUntil} min`
  };
}

// Étapes au format attendu par trajet-module.js (vue détaillée)
function stepsForTrajetModule(googleSteps) {
  return (googleSteps || []).map(s => {
    if (s.travel_mode === 'TRANSIT' && s.transit_details) {
      return {
        mode: 'transit',
        duration: s.duration?.text || '',
        transit: {
          line: s.transit_details.line?.short_name || s.transit_details.line?.name || '?',
          vehicleType: s.transit_details.line?.vehicle?.type || 'BUS',
          from: s.transit_details.departure_stop?.name || '',
          to: s.transit_details.arrival_stop?.name || '',
          headsign: s.transit_details.headsign || '',
          numStops: s.transit_details.num_stops || '',
        },
      };
    }
    return { mode: 'walking', duration: s.duration?.text || '', instruction: s.html_instructions || '' };
  });
}

app.post('/maps/trajet', async (req, res) => {
  try {
    const { origin, destination, arrivalTime, mode, prepMinutes } = req.body;
    if (!destination) return res.status(400).json({ error: 'destination required' });
    // origin est optionnel : trajet-module.js ne l'envoie pas (l'ancienne
    // version exigeait origin et échouait donc systématiquement en 400).
    const data = await computeRoute({ origin: origin || DEFAULT_ORIGIN, destination, mode: mode || 'transit', arrivalTime });
    const leg = data.routes[0].legs[0];
    const rappel = buildRappel(arrivalTime, leg.duration.value, prepMinutes);
    res.json({
      success: true,
      trajet: {
        duration: leg.duration.text,
        distance: leg.distance.text,
        mode: mode || 'transit',
        provider: data.provider,
        steps: stepsForTrajetModule(leg.steps),
        mapsLink: `https://www.google.com/maps/dir/${encodeURIComponent(origin || DEFAULT_ORIGIN)}/${encodeURIComponent(destination)}`,
      },
      rappel
    });
  } catch (e) { res.json({ success: false, error: e.message }); }
});

// Trajets de plusieurs événements d'agenda d'un coup. Route appelée par
// trajet-module.js mais absente jusqu'ici : chaque badge échouait en silence.
app.post('/maps/trajets-agenda', async (req, res) => {
  try {
    const { events, prepMinutes, origin } = req.body;
    const departureOrigin = origin || DEFAULT_ORIGIN;
    if (!Array.isArray(events)) return res.status(400).json({ error: 'events[] required' });
    const trajets = [];
    for (const ev of events.slice(0, 8)) {
      const destination = ev?.location;
      if (!destination) continue;
      const arrivalTime = ev.start || ev.startTime || ev.dateTime || ev.date || null;
      try {
        const data = await computeRoute({ origin: departureOrigin, destination, mode: ev.mode || 'transit', arrivalTime });
        const leg = data.routes[0].legs[0];
        const rappel = buildRappel(arrivalTime, leg.duration.value, prepMinutes);
        trajets.push({
          eventId: ev.id,
          eventTitle: ev.title || '',
          duration: leg.duration.text,
          distance: leg.distance.text,
          steps: stepsForTrajetModule(leg.steps),
          mapsLink: `https://www.google.com/maps/dir/${encodeURIComponent(departureOrigin)}/${encodeURIComponent(destination)}`,
          departureText: rappel?.departureText ?? null,
          minutesUntilDeparture: rappel?.minutesUntilDeparture ?? null,
          isUrgent: rappel?.isUrgent ?? false,
          isLate: rappel?.isLate ?? false,
        });
      } catch (e) {
        console.warn('[Trajets/Agenda]', destination, '→', e.message);
      }
    }
    res.json({ success: true, trajets });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// =================
// WEB PUSH
// =================

app.post('/push/subscribe', (req, res) => {
  try {
    const sub = req.body;
    if (!sub?.endpoint) return res.status(400).json({ error: 'endpoint required' });
    if (!pushSubscriptions.find(s => s.endpoint === sub.endpoint)) {
      pushSubscriptions.push(sub);
      persistPushSubscription(sub).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/push/unsubscribe', (req, res) => {
  try {
    const idx = pushSubscriptions.findIndex(s => s.endpoint === req.body.endpoint);
    if (idx >= 0) pushSubscriptions.splice(idx, 1);
    removePushSubscription(req.body.endpoint).catch(() => {});
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Envoie payload à tous les abonnements connus, nettoie ceux qui ont expiré
// (410/404) en mémoire ET dans Supabase. Réutilisé par /push/send et par le
// planificateur de rappels d'agenda (checkCalendarReminders).
async function sendPushToAll(payload) {
  const results = await Promise.allSettled(pushSubscriptions.map(sub =>
    webPush.sendNotification(sub, payload).catch(e => {
      if (e.statusCode === 410 || e.statusCode === 404) {
        const idx = pushSubscriptions.findIndex(s => s.endpoint === sub.endpoint);
        if (idx >= 0) pushSubscriptions.splice(idx, 1);
        removePushSubscription(sub.endpoint).catch(() => {});
      }
      throw e;
    })
  ));
  const sent = results.filter(r => r.status === 'fulfilled').length;
  return { sent, failed: results.length - sent, total: pushSubscriptions.length };
}

app.post('/push/send', async (req, res) => {
  try {
    if (!pushEnabled) return res.status(503).json({ error: 'Push not configured' });
    const { title, body, url } = req.body;
    if (!title) return res.status(400).json({ error: 'title required' });
    const payload = JSON.stringify({ title, body: body || '', url: url || '/mon-bureau/', icon: '/mon-bureau/icon-192.png', badge: '/mon-bureau/icon-192.png' });
    const result = await sendPushToAll(payload);
    res.json({ success: true, ...result });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =================
// RSS
// =================

app.post('/rss/parse', async (req, res) => {
  // Requête directe côté serveur : le CORS ne s'applique qu'aux navigateurs,
  // donc pas besoin de proxy tiers pour la plupart des flux — élimine les
  // limites de taille et changements de format silencieux des proxys publics.
  // Note : corsproxy.io refuse structurellement les appels serveur-à-serveur
  // (403 "server-side requests not allowed" sur leur offre gratuite, confirmé
  // en prod) — inutile ici, gardé uniquement côté navigateur (voir couche3.js).
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });

    const attempts = [];
    let xml = '';

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const r = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
          'Accept': 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
          'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8'
        }
      });
      clearTimeout(timeout);
      if (r.ok) {
        xml = await r.text();
        attempts.push(`direct: ok (${xml.length} octets)`);
      } else {
        attempts.push(`direct: HTTP ${r.status}`);
      }
    } catch (e) {
      attempts.push(`direct: ${e.name === 'AbortError' ? 'timeout 20s' : e.message}`);
    }

    if (!xml) {
      try {
        const p = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15000);
        const r = await fetch(p, { signal: controller.signal });
        clearTimeout(timeout);
        if (r.ok) { xml = await r.text(); attempts.push('allorigins.win: ok'); }
        else attempts.push(`allorigins.win: HTTP ${r.status}`);
      } catch (e) {
        attempts.push(`allorigins.win: ${e.name === 'AbortError' ? 'timeout 15s' : e.message}`);
      }
    }

    console.log(`[RSS] ${url} ->`, attempts.join(' | '));
    if (!xml) return res.status(502).json({ error: 'RSS feed inaccessible', attempts });
    res.json({ success: true, xml });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// =================
// VEILLE — Suivi des articles pertinents liés à une fiche
// =================

const veilles = new Map(); // ficheId -> { title, keywords, folderId, articles: [] }

app.post('/veille/create', async (req, res) => {
  try {
    const { ficheTitle, keywords, folderId } = req.body;
    if (!ficheTitle || !keywords) return res.status(400).json({ error: 'ficheTitle et keywords requis' });

    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);

    // Créer un dossier Drive pour la veille
    const veilleFolder = await googleFetch(accessToken, 'https://www.googleapis.com/drive/v3/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: `Veille — ${ficheTitle.substring(0, 60)}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: folderId ? [folderId] : undefined
      })
    }, tokens);

    const veilleId = `veille_${Date.now()}`;
    veilles.set(veilleId, {
      title: ficheTitle,
      keywords: keywords.split(',').map(k => k.trim().toLowerCase()),
      folderId: veilleFolder.id,
      articles: [],
      createdAt: Date.now()
    });

    res.json({ success: true, veilleId, folderId: veilleFolder.id, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Veille] create error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/veille/search', async (req, res) => {
  try {
    const { veilleId, rssSources } = req.body;
    if (!veilleId || !rssSources) return res.status(400).json({ error: 'veilleId et rssSources requis' });

    const veille = veilles.get(veilleId);
    if (!veille) return res.status(404).json({ error: 'Veille non trouvée' });

    const tokens = getTokensFromRequest(req);
    const accessToken = await getValidAccessToken(tokens);

    const articlesFound = [];

    // Parser simple pour RSS XML — extraire les items pertinents
    function parseRssItems(xml) {
      const items = [];
      const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(xml)) !== null) {
        const itemXml = match[1];
        const getTag = (tag) => {
          const regex = new RegExp(`<${tag}[^>]*>(.*?)</${tag}>`, 'i');
          const m = itemXml.match(regex);
          return m ? m[1].replace(/<[^>]+>/g, '').trim() : '';
        };
        items.push({
          title: getTag('title'),
          description: getTag('description'),
          link: getTag('link'),
          pubDate: getTag('pubDate')
        });
      }
      return items;
    }

    // Fonction helper pour récupérer et parser un flux RSS
    async function fetchRssFeed(url) {
      let xml = '';
      const attempts = [];

      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 20000);
        const r = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
        if (r.ok) {
          xml = await r.text();
          attempts.push(`direct: ok`);
        } else {
          attempts.push(`direct: HTTP ${r.status}`);
        }
      } catch (e) {
        attempts.push(`direct: ${e.name === 'AbortError' ? 'timeout' : e.message}`);
      }

      if (!xml) {
        try {
          const p = `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 15000);
          const r = await fetch(p, { signal: controller.signal });
          clearTimeout(timeout);
          if (r.ok) { xml = await r.text(); attempts.push('allorigins.win: ok'); }
          else attempts.push(`allorigins.win: HTTP ${r.status}`);
        } catch (e) {
          attempts.push(`allorigins.win: ${e.message}`);
        }
      }

      if (!xml) throw new Error(`RSS fetch failed for ${url}: ${attempts.join(' | ')}`);
      return xml;
    }

    // Parcourir les sources RSS et chercher les articles pertinents
    for (const source of rssSources.slice(0, 10)) {
      try {
        const xml = await fetchRssFeed(source.url);
        const items = parseRssItems(xml);

        for (const item of items) {
          if (!item.title || !item.link) continue;

          const content = `${item.title} ${item.description}`.toLowerCase();
          const isRelevant = veille.keywords.some(kw => content.includes(kw));

          if (isRelevant && !veille.articles.some(a => a.link === item.link)) {
            articlesFound.push({
              title: item.title,
              description: item.description,
              link: item.link,
              pubDate: item.pubDate,
              source: source.name
            });
            veille.articles.push({ title: item.title, link: item.link });

            // Ajouter l'article au dossier Drive
            try {
              const docContent = `# ${item.title}

**Source :** ${source.name}
**Date :** ${item.pubDate}
**Lien :** ${item.link}

${item.description}`;

              const docMetadata = {
                name: `📰 ${item.title.substring(0, 60)}`,
                mimeType: 'application/vnd.google-apps.document',
                parents: [veille.folderId]
              };

              const boundary = '----VeilleDoc' + Date.now();
              const body = `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(docMetadata)}\r\n--${boundary}\r\nContent-Type: text/plain\r\n\r\n${docContent}\r\n--${boundary}--`;

              await googleFetch(accessToken, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', {
                method: 'POST',
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                body
              }, tokens);
            } catch (docError) {
              console.warn('[Veille] Erreur création doc:', docError.message);
            }
          }
        }
      } catch (sourceError) {
        console.warn('[Veille] Erreur source', source.name, ':', sourceError.message);
      }
    }

    res.json({ success: true, found: articlesFound.length, articles: articlesFound, tokens: { ...tokens, access_token: accessToken } });
  } catch (error) {
    console.error('[Veille] search error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// =================
// ALERTE — Vigilance météo/catastrophes/sécurité, géolocalisée, avec
// notifications push envoyées même app fermée (planificateur serveur).
// =================

// Géocodage inverse : le frontend envoie lat/lon (navigator.geolocation), on
// renvoie le département français pour choisir les bons flux d'alerte.
app.get('/geo/department', async (req, res) => {
  try {
    const { lat, lon } = req.query;
    if (!lat || !lon) return res.status(400).json({ error: 'lat et lon requis' });
    const result = await reverseGeocodeDepartment(lat, lon);
    if (!result.department) return res.status(404).json({ success: false, error: 'Département introuvable pour cette position' });
    res.json({ success: true, ...result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// Flux préfecture connus par département (à compléter au fil des besoins :
// MétéoAlerte, lui, fonctionne pour n'importe quel département via ?dep=XX).
const PREFECTURE_FEEDS = {
  '31': [
    { name: 'Préfecture Haute-Garonne — communiqués', url: 'https://www.haute-garonne.gouv.fr/syndication/flux/rss_feed_1446' },
    { name: 'Préfecture Haute-Garonne — actualités', url: 'https://www.haute-garonne.gouv.fr/syndication/flux/rss_feed_69' },
  ],
  '11': [
    { name: 'Préfecture Aude — actualités', url: 'https://www.aude.gouv.fr/syndication/flux/rss_feed_69' },
    { name: 'Préfecture Aude — publications', url: 'https://www.aude.gouv.fr/syndication/flux/rss_feed_66' },
  ]
};

function validDepartmentCode(d) {
  return /^(2[AB]|97[1-6]|[0-9]{2,3})$/i.test(String(d).trim());
}

app.get('/alerte/departments', (req, res) => {
  res.json({ success: true, departments: alertDepartments, prefectureFeeds: Object.keys(PREFECTURE_FEEDS) });
});

app.post('/alerte/departments', async (req, res) => {
  try {
    const { departments } = req.body;
    if (!Array.isArray(departments) || !departments.length) return res.status(400).json({ error: 'departments[] requis' });
    const clean = [...new Set(departments.map(d => String(d).trim().toUpperCase()).filter(validDepartmentCode))].slice(0, 5);
    if (!clean.length) return res.status(400).json({ error: 'Aucun département valide' });
    alertDepartments = clean;
    persistAlertDepartments(clean).catch(() => {});
    res.json({ success: true, departments: alertDepartments, prefectureFeeds: Object.keys(PREFECTURE_FEEDS) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Parseur RSS minimal par regex, partagé avec /veille/search — suffisant pour
// extraire titre/lien/description sans dépendance XML tierce.
function extractRssItemsBasic(xml) {
  const items = [];
  const itemRegex = /<item[^>]*>([\s\S]*?)<\/item>/g;
  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const itemXml = match[1];
    const getTag = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
      const m = itemXml.match(r);
      return m ? m[1].replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]+>/g, '').trim() : '';
    };
    items.push({ title: getTag('title'), link: getTag('link'), description: getTag('description') });
  }
  return items;
}

// Sévérité minimale (miroir simplifié de Apps.alerte.severityOf côté frontend) :
// seul le niveau compte ici pour décider d'envoyer une notification push.
function alertSeverityLevel(text) {
  if (/\brouge\b/i.test(text)) return 4;
  if (/\borange\b/i.test(text)) return 3;
  if (/\bjaune\b/i.test(text)) return 2;
  return 1;
}

const ALERT_SAFETY_KEYWORDS = /incendie|feux?\s+de\s+for[êe]t|inondation|crue|s[ée]cheresse|canicule|temp[êe]te|orage|vent violent|neige|verglas|avalanche|[ée]vacuation|risque majeur|confinement/i;

// Dédoublonnage des notifications déjà envoyées : en mémoire seulement (perdu
// au redémarrage Render — au pire une alerte déjà vue peut renotifier une fois,
// compromis acceptable pour éviter de complexifier la persistance Supabase ici).
const alertNotifiedLinks = new Set();

// Planificateur : vérifie les flux d'alerte des départements suivis et pousse
// une notification (même app fermée, via Web Push) sur toute vigilance
// orange/rouge ou communication préfecture à caractère sécurité.
async function checkAlertNotifications() {
  if (!pushEnabled || pushSubscriptions.length === 0) return;
  try {
    for (const dep of alertDepartments) {
      const sources = [
        { name: `MétéoAlerte ${dep}`, url: `https://meteoalerte.com/france/rss.php?dep=${dep}`, prefecture: false },
        ...((PREFECTURE_FEEDS[dep] || []).map(f => ({ ...f, prefecture: true })))
      ];
      for (const src of sources) {
        let xml;
        try {
          const r = await fetch(src.url, { headers: { 'User-Agent': 'MonBureau/2.7' } });
          if (!r.ok) continue;
          xml = await r.text();
        } catch (e) { continue; }

        const items = extractRssItemsBasic(xml).slice(0, 5);
        for (const item of items) {
          if (!item.title || !item.link || alertNotifiedLinks.has(item.link)) continue;
          const hay = (item.title + ' ' + item.description).toLowerCase();
          const level = alertSeverityLevel(hay);
          const isPrefectureSafety = src.prefecture && ALERT_SAFETY_KEYWORDS.test(hay);
          if (level < 3 && !isPrefectureSafety) continue;

          alertNotifiedLinks.add(item.link);
          if (alertNotifiedLinks.size > 500) {
            [...alertNotifiedLinks].slice(0, 200).forEach(l => alertNotifiedLinks.delete(l));
          }
          const title = level >= 4 ? `🔴 Vigilance rouge — ${src.name}`
            : level === 3 ? `🟠 Vigilance orange — ${src.name}`
            : `📢 Alerte sécurité — ${src.name}`;
          const payload = JSON.stringify({ title, body: item.title.slice(0, 140), url: item.link });
          await sendPushToAll(payload).catch(e => console.warn('[Alerte] push échoué:', e.message));
        }
      }
    }
  } catch (e) {
    console.warn('[Alerte] check échoué:', e.message);
  }
}

setInterval(checkAlertNotifications, 15 * 60 * 1000);
setTimeout(checkAlertNotifications, 20000);

// =================
// PROXIES — YouTube, Last.fm, Tisséo
// =================

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;
const TISSEO_API_KEY = process.env.TISSEO_API_KEY;

// Recherche vidéo via Piped (front-end YouTube open source) : sans clé ni
// quota. La réponse imite l'API YouTube v3 (items[].id.videoId + snippet)
// pour ne rien changer côté frontend. Repli sur l'API Google si toutes les
// instances Piped sont en panne et qu'une clé est configurée.
const PIPED_INSTANCES = [
  'https://api.piped.private.coffee',
  'https://pipedapi.adminforge.de',
  'https://pipedapi.drgns.space',
  'https://pipedapi.kavin.rocks',
];

app.get('/proxy/youtube/search', async (req, res) => {
  const q = req.query.q || '';
  const max = Math.min(parseInt(req.query.maxResults || '5', 10) || 5, 20);

  for (const base of PIPED_INSTANCES) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const r = await fetch(`${base}/search?q=${encodeURIComponent(q)}&filter=videos`, {
        signal: controller.signal,
        headers: { 'User-Agent': 'MonBureau/2.3' }
      });
      clearTimeout(timeout);
      if (!r.ok) continue;
      const data = await r.json();
      const items = (data.items || [])
        .filter(i => i.type === 'stream' && i.url)
        .slice(0, max)
        .map(i => ({
          id: { videoId: String(i.url).replace('/watch?v=', '') },
          snippet: {
            title: i.title || '',
            channelTitle: i.uploaderName || '',
            description: i.shortDescription || '',
            thumbnails: {
              default: { url: i.thumbnail || '' },
              medium: { url: i.thumbnail || '' },
              high: { url: i.thumbnail || '' },
            },
          },
        }));
      if (items.length) return res.json({ items, provider: 'piped' });
    } catch (e) { /* instance suivante */ }
  }

  // Repli Google (uniquement si toutes les instances Piped échouent)
  if (YOUTUBE_API_KEY) {
    try {
      const params = new URLSearchParams({ part: 'snippet', q, type: 'video', maxResults: String(max), key: YOUTUBE_API_KEY });
      const r = await fetch(`https://www.googleapis.com/youtube/v3/search?${params}`);
      return res.json(await r.json());
    } catch (e) { /* tombe sur l'erreur générique */ }
  }
  res.status(502).json({ error: 'Recherche vidéo indisponible (instances Piped en panne)' });
});

app.get('/proxy/lastfm/:method', async (req, res) => {
  if (!LASTFM_API_KEY) return res.status(503).json({ error: 'Last.fm API key not configured' });
  try {
    const params = new URLSearchParams({ method: req.params.method, api_key: LASTFM_API_KEY, format: 'json', ...req.query });
    const r = await fetch(`https://ws.audioscrobbler.com/2.0/?${params}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/proxy/tisseo/:endpoint', async (req, res) => {
  if (!TISSEO_API_KEY) return res.status(503).json({ error: 'Tisséo API key not configured' });
  try {
    const endpoint = req.params.endpoint.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!endpoint) return res.status(400).json({ error: 'Invalid endpoint' });
    const params = new URLSearchParams({ key: TISSEO_API_KEY, displayLines: 1, srsName: 'EPSG:4326', ...req.query });
    // L'API Tisséo v2 exige le suffixe .json — l'ancien proxy le supprimait
    // du nom d'endpoint, donc aucun appel Tisséo n'a jamais abouti.
    const r = await fetch(`https://api.tisseo.fr/v2/${endpoint}.json?${params}`);
    res.json(await r.json());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Prochains passages à un arrêt, par nom ("gallieni", "langlade"...).
// Route appelée par agent-tisseo et le dashboard du matin mais jamais
// implémentée. Réponse : { success, passages: [{ligne, direction, attente,
// attenteMin}] } — le format attendu par renderArrêt() du dashboard.
const _tisseoStopCache = new Map(); // nom → stopAreaId

app.get('/tisseo/prochains', async (req, res) => {
  if (!TISSEO_API_KEY) return res.status(503).json({ success: false, error: 'Tisséo API key not configured', passages: [] });
  try {
    const arret = String(req.query.arret || '').trim();
    const nb = Math.min(parseInt(req.query.nb, 10) || 4, 10);
    if (!arret) return res.status(400).json({ success: false, error: 'arret requis', passages: [] });

    let stopAreaId = _tisseoStopCache.get(arret.toLowerCase());
    if (!stopAreaId) {
      // Recherche via places.json (l'autocomplétion officielle) : stop_areas.json
      // ne sait pas filtrer par nom. On privilégie les arrêts toulousains.
      const sp = new URLSearchParams({ key: TISSEO_API_KEY, term: arret });
      const sr = await fetch(`https://api.tisseo.fr/v2/places.json?${sp}`);
      const sd = await sr.json();
      const places = (sd?.placesList?.place || sd?.places?.place || []).filter(p => String(p.id).startsWith('stop_area:'));
      const best = places.find(p => /toulouse/i.test(p.label || '')) || places[0];
      stopAreaId = best?.id;
      if (!stopAreaId) return res.json({ success: false, error: `Arrêt introuvable : ${arret}`, passages: [] });
      _tisseoStopCache.set(arret.toLowerCase(), stopAreaId);
    }

    const dp = new URLSearchParams({ key: TISSEO_API_KEY, stopAreaId, number: String(nb) });
    const dr = await fetch(`https://api.tisseo.fr/v2/stops_schedules.json?${dp}`);
    const dd = await dr.json();
    const departures = dd?.departures?.departure || [];
    const now = Date.now();
    // Tisséo renvoie des heures locales françaises SANS fuseau : parsées
    // telles quelles sur Render (UTC), elles gonflaient l'attente de 2 h.
    // On colle l'offset Europe/Paris du moment (+02:00 été / +01:00 hiver).
    const offPart = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Paris', timeZoneName: 'shortOffset' })
      .formatToParts(new Date()).find(pt => pt.type === 'timeZoneName')?.value || 'GMT+1';
    const offMatch = offPart.match(/([+-])(\d+)(?::(\d+))?/) || [null, '+', '1', '0'];
    const offset = `${offMatch[1]}${String(offMatch[2]).padStart(2, '0')}:${String(offMatch[3] || '0').padStart(2, '0')}`;
    const passages = departures.slice(0, nb).map(d => {
      let iso = String(d.dateTime).replace(' ', 'T');
      if (iso.length === 16) iso += ':00'; // "YYYY-MM-DDTHH:MM" → ajoute les secondes
      const t = new Date(iso + offset).getTime();
      const attenteMin = Math.max(0, Math.round((t - now) / 60000));
      return {
        ligne: d.line?.shortName || '?',
        direction: Array.isArray(d.destination) ? (d.destination[0]?.name || '') : (d.destination?.name || ''),
        attente: attenteMin === 0 ? 'imminent' : `${attenteMin} min`,
        attenteMin,
      };
    });
    res.json({ success: true, arret, passages });
  } catch (e) { res.status(500).json({ success: false, error: e.message, passages: [] }); }
});

// =================
// VÉLÔTOULOUSE — temps réel via le flux GBFS public (open data, sans clé).
// Route appelée par agent-velo et le dashboard du matin, jamais implémentée.
// =================

let _veloCache = { at: 0, stations: [] };

app.get('/velo/stations', async (req, res) => {
  try {
    if (Date.now() - _veloCache.at > 60000) {
      const [infoR, statusR] = await Promise.all([
        fetch('https://api.cyclocity.fr/contracts/toulouse/gbfs/v2/station_information.json'),
        fetch('https://api.cyclocity.fr/contracts/toulouse/gbfs/v2/station_status.json'),
      ]);
      const info = await infoR.json();
      const status = await statusR.json();
      const byId = new Map((status.data?.stations || []).map(s => [s.station_id, s]));
      _veloCache = {
        at: Date.now(),
        stations: (info.data?.stations || []).map(s => {
          const st = byId.get(s.station_id) || {};
          return {
            name: String(s.name || '').replace(/^\d+\s*-\s*/, ''),
            lat: s.lat, lon: s.lon,
            availableBikes: st.num_bikes_available ?? 0,
            availableDocks: st.num_docks_available ?? 0,
          };
        }),
      };
    }
    let stations = _veloCache.stations;
    const lat = parseFloat(req.query.lat), lon = parseFloat(req.query.lon);
    if (isFinite(lat) && isFinite(lon)) {
      const toRad = d => d * Math.PI / 180;
      const dist = s => {
        const dLat = toRad(s.lat - lat), dLon = toRad(s.lon - lon);
        const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat)) * Math.cos(toRad(s.lat)) * Math.sin(dLon / 2) ** 2;
        return Math.round(2 * 6371000 * Math.asin(Math.sqrt(h)));
      };
      stations = stations
        .map(s => ({ ...s, dist: dist(s) }))
        .sort((a, b) => a.dist - b.dist)
        .slice(0, parseInt(req.query.nb, 10) || 5);
    }
    res.json({ success: true, stations });
  } catch (e) { res.status(502).json({ success: false, error: e.message, stations: [] }); }
});

// =================
// CINÉMA — cinémas indépendants toulousains. Aucune API publique de séances
// n'existe (Allociné est fermé, pas d'open data) : ces routes renvoient les
// salles et leurs pages programme officielles pour que l'agent Culture
// oriente sans inventer d'horaires. Appelées par agent-culture, jamais
// implémentées jusqu'ici.
// =================

const CINEMAS_TOULOUSE = [
  { nom: 'American Cosmograph', url: 'https://cosmograph.fr', programme: 'https://cosmograph.fr/programme' },
  { nom: 'ABC', url: 'https://www.abc-toulouse.fr', programme: 'https://www.abc-toulouse.fr/programme' },
  { nom: 'Le Cratère', url: 'https://www.lecratere.fr', programme: 'https://www.lecratere.fr/programme' },
  { nom: 'Véo', url: 'https://www.veo-cinema.fr', programme: 'https://www.veo-cinema.fr/programme' },
];

app.get('/cinema/infos', (req, res) => res.json({ success: true, cinemas: CINEMAS_TOULOUSE }));

app.get('/cinema/seances', (req, res) => res.json({
  success: true,
  date: req.query.date || null,
  seances: [],
  cinemas: CINEMAS_TOULOUSE,
  note: 'Pas de source ouverte pour les horaires : orienter vers les pages programme officielles des salles.',
}));

app.post('/cinema/recommande', (req, res) => res.json({
  success: true,
  films: [],
  cinemas: CINEMAS_TOULOUSE,
  note: 'Pas de source ouverte pour les séances : proposer les pages programme officielles des salles.',
}));

// =================
// PROXY MAPS — mêmes routes qu'avant, servies par le routage open source
// (computeRoute) au format Google Directions. Le frontend est inchangé.
// =================

app.post('/proxy/maps', async (req, res) => {
  try {
    const { origin, destination, arrivalTime, mode } = req.body;
    if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });
    res.json(await computeRoute({ origin, destination, mode: mode || 'transit', arrivalTime }));
  } catch (e) { res.json({ status: 'NOT_FOUND', error_message: e.message, routes: [] }); }
});

app.get('/proxy/maps/directions', async (req, res) => {
  try {
    const { origin, destination, mode, arrival_time } = req.query;
    if (!origin || !destination) return res.status(400).json({ error: 'origin and destination required' });
    const arrivalTime = arrival_time ? new Date(parseInt(arrival_time, 10) * 1000).toISOString() : undefined;
    res.json(await computeRoute({ origin, destination, mode: mode || 'transit', arrivalTime }));
  } catch (e) { res.json({ status: 'NOT_FOUND', error_message: e.message, routes: [] }); }
});

// =================
// TTS — Google Cloud Text-to-Speech (voix Studio de la méditation).
// Route appelée par agent-meditation.js depuis toujours mais jamais
// implémentée : la tuile retombait en silence sur la voix du navigateur.
// Quota gratuit voix Studio : 100 000 caractères/mois (~60 séances) ;
// au-delà Google renvoie une erreur et le repli navigateur reprend.
// =================

const GOOGLE_TTS_KEY = process.env.GOOGLE_TTS_KEY;

app.post('/tts/synthesize', async (req, res) => {
  if (!GOOGLE_TTS_KEY) return res.status(503).json({ success: false, error: 'TTS non configuré' });
  try {
    const { text, voiceName, speakingRate, pitch } = req.body;
    if (!text || typeof text !== 'string') return res.status(400).json({ success: false, error: 'text requis' });
    const voice = voiceName || 'fr-FR-Studio-A';
    const audioConfig = {
      audioEncoding: 'MP3',
      speakingRate: Math.min(Math.max(Number(speakingRate) || 0.8, 0.25), 2),
    };
    // Les voix Studio refusent le réglage de pitch
    if (pitch && !voice.includes('Studio')) {
      audioConfig.pitch = Math.min(Math.max(Number(pitch), -20), 20);
    }
    const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${GOOGLE_TTS_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        input: { text: text.slice(0, 1500) }, // garde-fou quota
        voice: { languageCode: 'fr-FR', name: voice },
        audioConfig,
      }),
    });
    const data = await r.json();
    if (!r.ok || !data.audioContent) {
      return res.status(502).json({ success: false, error: data.error?.message || 'Synthèse impossible' });
    }
    res.json({ success: true, audioContent: data.audioContent });
  } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// =================
// PROXY RSS — Parser de flux RSS (podcasts)
// =================

app.post('/proxy/rss', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url required' });
    // SSRF protection: only allow public HTTP(S) URLs
    let parsed;
    try { parsed = new URL(url); } catch { return res.status(400).json({ error: 'Invalid URL' }); }
    if (!['http:', 'https:'].includes(parsed.protocol)) return res.status(400).json({ error: 'Only HTTP(S) allowed' });
    const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '169.254.169.254', '10.', '192.168.', '172.'];
    if (blocked.some(b => parsed.hostname.startsWith(b) || parsed.hostname === b)) return res.status(403).json({ error: 'Internal URLs blocked' });
    
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const r = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': 'MonBureau/2.0' } });
    clearTimeout(timeout);
    if (!r.ok) return res.status(502).json({ error: `RSS fetch failed: ${r.status}` });
    const xml = await r.text();
    // Parse RSS/Atom XML
    const items = [];
    const itemMatches = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
    for (const item of itemMatches.slice(0, 30)) {
      const title = (item.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').trim() || '';
      const enclosure = (item.match(/<enclosure[^>]*url="([^"]*)"/i) || [])[1] || '';
      const link = (item.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1]?.trim() || '';
      const pubDate = (item.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/i) || [])[1]?.trim() || '';
      const description = (item.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1]?.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, '').trim().slice(0, 300) || '';
      if (title) items.push({ title, audioUrl: enclosure || link, date: pubDate, description });
    }
    res.json({ events: items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// =================
// OPENAGENDA — Événements Toulouse
// =================

app.get('/openagenda/toulouse', async (req, res) => {
  try {
    const { dateFrom, dateTo, size } = req.query;
    const params = new URLSearchParams({ 'agenda': '322964', 'since': dateFrom || '', 'until': dateTo || '', 'limit': size || '50', 'excluded': '0' });
    const r = await fetch(`https://api.openagenda.com/v2/agendas/322964/events?${params}`, {
      headers: { 'Accept': 'application/json' }
    });
    if (!r.ok) {
      // Fallback: Toulouse OpenData
      const fallbackR = await fetch(`https://data.toulouse-metropole.fr/api/records/1.0/search/?dataset=evenements_toulouse_metropole&rows=${size || 20}&sort=date`);
      if (fallbackR.ok) {
        const fbData = await fallbackR.json();
        const events = (fbData.records || []).map(r => ({
          title: r.fields?.title || r.fields?.nom || '',
          date: r.fields?.date || r.fields?.dateStr || '',
          description: r.fields?.description || '',
          location: r.fields?.address || r.fields?.lieu || '',
          image: r.fields?.image?.url || ''
        }));
        return res.json({ events });
      }
      return res.json({ events: [] });
    }
    const data = await r.json();
    const events = (data.data || data.events || []).map(e => ({
      title: e.title?.fr || e.title || '',
      date: e.dateRange || e.date || '',
      description: e.description?.fr || e.description || '',
      location: e.location?.name || '',
      image: e.featuredImage?.original || ''
    }));
    res.json({ events });
  } catch (e) { res.json({ events: [] }); }
});

// =================
// RAPPELS D'AGENDA — planificateur serveur (fonctionne app fermée)
// =================
// Interroge Calendar toutes les 5 min avec le refresh token conservé côté
// serveur (voir persistGoogleRefreshToken) et envoie une vraie notification
// push pour tout événement commençant dans 10-15 min. C'est le seul moyen
// pour un rappel d'arriver même si le navigateur/l'appli n'est pas ouvert —
// contrairement au setTimeout côté client, qui s'arrête avec l'onglet.
const REMINDER_WINDOW_MIN = 15; // fenêtre : prévenir 10 à 15 min avant l'événement
const notifiedEventIds = new Set();
let notifiedEventsDay = new Date().toDateString();

async function checkCalendarReminders() {
  if (!pushEnabled || !storedGoogleRefreshToken || !pushSubscriptions.length) return;

  // Purge quotidienne du dé-doublonnage (sinon grossit indéfiniment)
  const today = new Date().toDateString();
  if (today !== notifiedEventsDay) {
    notifiedEventIds.clear();
    notifiedEventsDay = today;
  }

  try {
    const { access_token } = await refreshAccessToken(storedGoogleRefreshToken);
    const now = new Date();
    const windowEnd = new Date(now.getTime() + REMINDER_WINDOW_MIN * 60000);
    const params = new URLSearchParams({
      calendarId: 'primary',
      timeMin: now.toISOString(),
      timeMax: windowEnd.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime'
    });
    const data = await googleFetch(access_token, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`);

    for (const event of (data.items || [])) {
      const start = event.start?.dateTime;
      if (!start || !event.id || notifiedEventIds.has(event.id)) continue;
      const minutesUntil = Math.round((new Date(start).getTime() - now.getTime()) / 60000);
      if (minutesUntil < 0 || minutesUntil > REMINDER_WINDOW_MIN) continue;

      notifiedEventIds.add(event.id);
      const payload = JSON.stringify({
        title: '📅 ' + (event.summary || 'Événement'),
        body: `Dans ${minutesUntil} min${event.location ? ' — 📍 ' + event.location : ''}`,
        url: '/mon-bureau/',
        icon: '/mon-bureau/icon-192.png',
        badge: '/mon-bureau/icon-192.png'
      });
      await sendPushToAll(payload).catch(e => console.warn('[Rappels] Envoi push échoué:', e.message));
    }
  } catch (e) {
    console.warn('[Rappels] Vérification agenda échouée:', e.message);
  }
}
// Tuile Emploi — branchement des routes /emploi/*
mountEmploi(app);
// =================
// ERROR HANDLER
// =================

app.use((err, req, res, next) => {
  console.error('[Error]', err.message);
  if (err.message === 'Not allowed by CORS') return res.status(403).json({ error: 'CORS denied' });
  res.status(500).json({ error: 'Erreur serveur' });
});

// =================
// START
// =================

process.on('unhandledRejection', (reason) => {
  console.error('[UnhandledRejection]', reason);
});

// Ne jamais bloquer le démarrage du serveur là-dessus : si Supabase est lent
// ou injoignable, le serveur doit quand même répondre (juste sans les
// abonnements/refresh token déjà connus, rechargés dès que possible).
loadServerState().then(() => checkCalendarReminders());
setInterval(checkCalendarReminders, 5 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║  Mon Bureau Backend v${VERSION}            ║
║  Port: ${PORT}                            ║
║  Fetch: natif Node ${process.versions.node}              ║
╚═══════════════════════════════════════╝
  `);
});
