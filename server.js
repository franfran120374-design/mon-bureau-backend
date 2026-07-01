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

// Web Push VAPID — uniquement via variables d'environnement Render
// (pas de fallback en dur : le repo est public, une clé privée ne doit jamais s'y trouver)
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
let pushEnabled = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
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
  console.log('[Push] ⚠️ VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY absentes des variables d\'environnement — push désactivé');
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
    const e = new Error('Header Authorization manquant');
    e.statusCode = 401;
    throw e;
  }
  const encoded = auth.substring(7);
  try {
    return JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  } catch (e) {
    const err = new Error('Tokens invalides');
    err.statusCode = 401;
    throw err;
  }
}

// =================
// Helper: force un vrai refresh du token via l'endpoint OAuth2 de Google
// (indépendant du mécanisme interne de la lib, qui se base sur expiry_date —
// utile quand expiry_date est faux/absent et que Google renvoie un 401 direct)
// =================
async function forceRefreshToken(refresh_token) {
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    // ex: invalid_grant => refresh_token lui-même mort (révoqué/expiré côté Google)
    throw new Error(data.error_description || data.error || 'Refresh token invalide');
  }
  return {
    access_token: data.access_token,
    expiry_date: Date.now() + (data.expires_in * 1000),
    scope: data.scope,
    token_type: data.token_type,
    refresh_token // Google n'en renvoie généralement pas un nouveau, on garde l'original
  };
}

// =================
// Helper: exécute un appel Google API, et si Google répond 401
// (credentials invalides malgré expiry_date), force un refresh réel et réessaie UNE fois.
// Centralise la logique pour toutes les routes Calendar/Drive au lieu de la dupliquer.
// =================
async function withGoogleAuth(tokens, apiCallFn) {
  let currentTokens = tokens;
  let auth = getAuthClient(currentTokens);

  const isAuthError = (error) => {
    const status = error?.code || error?.response?.status;
    return status === 401 || status === '401';
  };

  try {
    const result = await apiCallFn(auth);
    return { result, tokens: auth.credentials };
  } catch (error) {
    if (isAuthError(error) && currentTokens.refresh_token) {
      const refreshed = await forceRefreshToken(currentTokens.refresh_token).catch((refreshErr) => {
        const e = new Error('Session Google expirée — reconnexion nécessaire');
        e.statusCode = 401;
        e.cause = refreshErr.message;
        throw e;
      });
      currentTokens = { ...currentTokens, ...refreshed };
      auth = getAuthClient(currentTokens);
      try {
        const result = await apiCallFn(auth);
        return { result, tokens: auth.credentials };
      } catch (retryError) {
        const e = new Error('Session Google expirée — reconnexion nécessaire');
        e.statusCode = 401;
        throw e;
      }
    }
    if (isAuthError(error)) {
      const e = new Error('Session Google expirée — reconnexion nécessaire (pas de refresh token disponible)');
      e.statusCode = 401;
      throw e;
    }
    throw error;
  }
}

// =================
// CALENDAR
// =================

app.get('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const calendar = google.calendar({ version: 'v3', auth });
      const response = await calendar.events.list({
        calendarId: 'primary',
        timeMin: req.query.timeMin || new Date().toISOString(),
        maxResults: parseInt(req.query.maxResults) || 50,
        singleEvents: true,
        orderBy: 'startTime'
      });
      return response.data.items;
    });

    res.json({
      events: result,
      tokens: newTokens // Le frontend met à jour son localStorage
    });
  } catch (error) {
    console.error('[Calendar] list error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/calendar/events', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const calendar = google.calendar({ version: 'v3', auth });
      const event = await calendar.events.insert({
        calendarId: 'primary',
        resource: req.body
      });
      return event.data;
    });

    res.json({
      event: result,
      tokens: newTokens
    });
  } catch (error) {
    console.error('[Calendar] create error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.delete('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const calendar = google.calendar({ version: 'v3', auth });
      await calendar.events.delete({
        calendarId: 'primary',
        eventId: req.params.eventId
      });
    });

    res.json({
      success: true,
      tokens: newTokens
    });
  } catch (error) {
    console.error('[Calendar] delete error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.patch('/calendar/events/:eventId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const calendar = google.calendar({ version: 'v3', auth });
      const event = await calendar.events.patch({
        calendarId: 'primary',
        eventId: req.params.eventId,
        requestBody: req.body
      });
      return event.data;
    });

    res.json({
      event: result,
      tokens: newTokens
    });
  } catch (error) {
    console.error('[Calendar] update error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// =================
// DRIVE
// =================

app.get('/drive/files', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const drive = google.drive({ version: 'v3', auth });
      const response = await drive.files.list({
        pageSize: parseInt(req.query.pageSize) || 20,
        fields: 'files(id, name, mimeType, modifiedTime, size, webViewLink)',
        q: req.query.query || "trashed=false",
        orderBy: 'modifiedTime desc'
      });
      return response.data.files;
    });

    res.json({
      files: result,
      tokens: newTokens
    });
  } catch (error) {
    console.error('[Drive] list error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/drive/search', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const drive = google.drive({ version: 'v3', auth });
      const response = await drive.files.list({
        pageSize: 20,
        fields: 'files(id, name, mimeType, modifiedTime, webViewLink)',
        q: `name contains '${req.query.q}' and trashed=false`
      });
      return response.data.files;
    });

    res.json({
      files: result,
      tokens: newTokens
    });
  } catch (error) {
    console.error('[Drive] search error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/drive/upload', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const drive = google.drive({ version: 'v3', auth });
      // Comportement historique inchangé (fileName/content/mimeType = type du média source).
      // Deux champs additifs optionnels, jamais envoyés par les appelants existants :
      // - folderId : range le fichier dans un dossier au lieu de la racine
      // - targetMimeType : convertit à l'upload en type natif Drive (ex: Google Doc)
      const resource = { name: req.body.fileName };
      if (req.body.folderId) resource.parents = [req.body.folderId];
      if (req.body.targetMimeType) resource.mimeType = req.body.targetMimeType;
      const file = await drive.files.create({
        resource,
        media: {
          mimeType: req.body.mimeType || 'text/plain',
          body: req.body.content
        },
        fields: 'id, name, webViewLink'
      });
      return file.data;
    });

    res.json({
      file: result,
      tokens: newTokens
    });
  } catch (error) {
    console.error('[Drive] upload error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.get('/drive/download/:fileId', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const drive = google.drive({ version: 'v3', auth });
      const response = await drive.files.get({
        fileId: req.params.fileId,
        alt: 'media'
      }, { responseType: 'arraybuffer' });
      return Buffer.from(response.data).toString('base64');
    });

    res.json({
      content: result,
      tokens: newTokens
    });
  } catch (error) {
    console.error('[Drive] download error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

app.post('/drive/create-folder', async (req, res) => {
  try {
    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const drive = google.drive({ version: 'v3', auth });
      const folder = await drive.files.create({
        resource: {
          name: req.body.folderName,
          mimeType: 'application/vnd.google-apps.folder'
        },
        fields: 'id, name, webViewLink'
      });
      return folder.data;
    });

    res.json({
      folder: result,
      tokens: newTokens
    });
  } catch (error) {
    console.error('[Drive] create folder error:', error.message);
    res.status(error.statusCode || 500).json({ error: error.message });
  }
});

// =================
// FICHE — synthèse d'un article (résumé + fact-check + tags) sauvegardée sur Drive
// en Google Doc natif. Utilise l'agrégateur IA gratuit (voir callAggregator plus bas).
// =================

function buildFichePrompt(title, content, url) {
  return `Tu analyses un article pour en faire une fiche de synthèse. Réponds STRICTEMENT dans ce format markdown, sans rien ajouter avant ou après :

## Résumé
(3 à 5 phrases résumant les points essentiels de l'article)

## Vérification factuelle
Verdict : (Vrai / Faux / Non vérifiable / Partiellement vrai)
Confiance : (un pourcentage)
Justification : (2-3 phrases expliquant le verdict)

## Mots-clés
(3 à 6 mots-clés séparés par des virgules, en minuscules)

---
Titre de l'article : ${title || 'N/A'}
URL : ${url || 'N/A'}
Contenu : ${String(content || '').substring(0, 4000)}`;
}

// Étape 1/2 : génère le contenu de la fiche (résumé + fact-check + tags) SANS l'enregistrer.
// Ne nécessite pas d'auth Google — juste l'agrégateur IA. L'utilisateur relit/édite
// avant de valider l'enregistrement via /fiche/save.
app.post('/fiche/preview', async (req, res) => {
  try {
    const { title, content, url, sourceDate } = req.body;
    if (!content && !title) return res.status(400).json({ error: 'content ou title requis' });

    const prompt = buildFichePrompt(title, content, url);
    const aggregatorResult = await callAggregator(prompt, 'raisonnement');
    const analyse = aggregatorResult.response || '';

    const now = new Date().toISOString().slice(0, 10);
    const ficheContent = `# ${title || 'Fiche sans titre'}

**Source :** ${url || 'N/A'}
**Date de l'article :** ${sourceDate || 'inconnue'}
**Fiche créée le :** ${now}

${analyse}
`;

    res.json({
      success: true,
      title: title || 'Fiche sans titre',
      ficheContent,
      provider: aggregatorResult.provider,
      model: aggregatorResult.model
    });
  } catch (error) {
    console.error('[Fiche] preview error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Étape 2/2 : enregistre le contenu (potentiellement édité par l'utilisateur) sur
// Drive en Google Doc natif. Appelée uniquement après validation explicite.
app.post('/fiche/save', async (req, res) => {
  try {
    const { title, ficheContent, folderId } = req.body;
    if (!ficheContent) return res.status(400).json({ error: 'ficheContent requis' });

    const tokens = getTokensFromRequest(req);
    const { result, tokens: newTokens } = await withGoogleAuth(tokens, async (auth) => {
      const drive = google.drive({ version: 'v3', auth });
      const resource = {
        name: `Fiche - ${(title || 'sans titre').substring(0, 80)}`,
        mimeType: 'application/vnd.google-apps.document' // converti en Google Doc natif
      };
      if (folderId) resource.parents = [folderId];
      const file = await drive.files.create({
        resource,
        media: { mimeType: 'text/plain', body: ficheContent },
        fields: 'id, name, webViewLink'
      });
      return file.data;
    });

    res.json({ success: true, file: result, tokens: newTokens });
  } catch (error) {
    console.error('[Fiche] save error:', error.message);
    res.status(error.statusCode || 500).json({ success: false, error: error.message });
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

// =================
// AGRÉGATEUR IA (Groq/Gemini/OpenRouter gratuits) — voir repo ai-aggregator
// Utilisé par défaut pour résumé/factcheck RSS (gratuit, rapide).
// Claude reste disponible en option manuelle via /claude/factcheck-deep
// et pour tout le reste de l'app (recettes, agents, etc.)
// =================

const AGGREGATOR_URL = process.env.AGGREGATOR_URL; // ex: https://ai-aggregator-78gp.onrender.com
const AGGREGATOR_ACCESS_TOKEN = process.env.AGGREGATOR_ACCESS_TOKEN;

async function callAggregator(prompt, category) {
  if (!AGGREGATOR_URL) throw new Error('AGGREGATOR_URL non configurée');
  const response = await fetch(`${AGGREGATOR_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AGGREGATOR_ACCESS_TOKEN ? { 'X-Access-Token': AGGREGATOR_ACCESS_TOKEN } : {})
    },
    // Le service Render gratuit peut être en veille (cold start ~30-50s) : on laisse le temps
    body: JSON.stringify({ prompt, category })
  });
  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err.detail || `Agrégateur IA error: ${response.status}`);
  }
  return await response.json(); // { response, category, provider, model }
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
  // Nom de route conservé (compat frontend), mais passe désormais par l'agrégateur
  // gratuit (Groq/Gemini/OpenRouter) au lieu de Claude payant.
  try {
    const { text, type } = req.body;
    if (!text) return res.status(400).json({ error: 'text required' });
    const prompt = `Résume ce texte en 3-5 phrases claires et concises, en français. Type: ${type || 'article'}.\n\n${String(text).substring(0, 4000)}`;
    const data = await callAggregator(prompt, 'contexte_long');
    res.json({ success: true, summary: data.response || '', provider: data.provider, model: data.model });
  } catch (error) {
    console.error('[Aggregator] summarize error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/factcheck', async (req, res) => {
  // Nom de route conservé (compat frontend), mais passe désormais par l'agrégateur
  // gratuit. Pour une vérification plus poussée (Claude), voir /claude/factcheck-deep.
  try {
    const { title, content, url } = req.body;
    if (!content && !title) return res.status(400).json({ error: 'content required' });
    const prompt = `Tu es un fact-checker. Vérifie l'affirmation ou l'article suivant et réponds en français, de façon structurée avec : verdict (Vrai/Faux/Non vérifiable/Partiellement vrai), confiance (%), contexte (2-3 phrases).\n\nTitre: ${title || 'N/A'}\nContenu: ${String(content || '').substring(0, 4000)}\nURL: ${url || 'N/A'}`;
    const data = await callAggregator(prompt, 'raisonnement');
    res.json({ success: true, result: data.response || '', provider: data.provider, model: data.model });
  } catch (error) {
    console.error('[Aggregator] factcheck error:', error.message);
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/claude/factcheck-deep', async (req, res) => {
  // Vérification approfondie via Claude (payant), déclenchée manuellement uniquement
  // (bouton "Analyse approfondie" dans l'app) — jamais appelée automatiquement.
  try {
    const { title, content, url } = req.body;
    if (!content && !title) return res.status(400).json({ error: 'content required' });
    const system = `Tu es un fact-checker expert. Vérifie l'affirmation ou l'article suivant. Indique si c'est vraisemblable, faux, ou non vérifiable. Donne une réponse structurée avec: verdict (Vrai/Faux/Non vérifiable), confiance (%), sources suggérées, contexte. Réponds en français.`;
    const data = await callClaude([{ role: 'user', content: `Titre: ${title || 'N/A'}\nContenu: ${content}\nURL: ${url || 'N/A'}` }], system, 1024);
    res.json({ success: true, result: data.content[0]?.text || '', provider: 'anthropic', model: data.model || 'claude-sonnet-4-20250514' });
  } catch (error) {
    console.error('[Claude] factcheck-deep error:', error.message);
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
