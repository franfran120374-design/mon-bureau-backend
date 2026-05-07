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
    version: '1.0.0',
    status: 'ok'
  });
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
