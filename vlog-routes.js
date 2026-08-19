/* =========================================================
   VLOG ROUTES — Module backend (Mon Bureau)
   -------------------------------------------------------
   Fichier AUTONOME, sur le même principe que emploi-routes.js.
   Une seule route : l'envoi du digest quotidien des nouvelles
   fiches publiées sur le Vlog aux abonnés inscrits via le
   Google Form.

   Comment ça marche :
   1) Un déclencheur externe (GitHub Actions, une fois par jour)
      appelle GET /vlog/send-digest?key=... avec un mot de passe
      secret partagé (VLOG_DIGEST_SECRET).
   2) On va chercher dans Supabase (clé "anon" publique, la même
      que dans vlog.html — rien de secret à configurer côté
      Supabase) les fiches publiées pas encore envoyées.
   3) S'il y en a, on lit la liste des emails abonnés directement
      dans le Google Sheet relié au Google Form (via l'export CSV
      de Drive — le compte Google déjà connecté à Mon Bureau a
      déjà le droit de lire ses propres fichiers Drive, aucune
      reconnexion nécessaire pour cette partie).
   4) On envoie un email récapitulatif à chaque abonné via Gmail
      (même mécanisme que /emploi/gmail-send, jeton Google déjà
      mémorisé côté serveur pour les rappels d'agenda).
   5) On marque les fiches comme envoyées (fonction Supabase
      dédiée, toujours avec la clé publique) pour ne jamais les
      renvoyer.

   Variables d'environnement à créer sur Render :
     VLOG_DIGEST_SECRET    → un mot de passe long inventé par toi
     VLOG_SUBS_SHEET_ID    → l'identifiant du Google Sheet des
                              abonnés (voir INSTRUCTIONS pour le
                              trouver dans son URL)
     PUBLIC_VLOG_BASE_URL  → optionnel, une valeur par défaut existe

   Ajouter dans server.js (déjà fait si tu as suivi les étapes
   précédentes, rien à refaire) :
     import mountVlog from './vlog-routes.js';
     ...
     mountVlog(app, { getStoredGoogleRefreshToken, refreshAccessToken });
   ========================================================= */

'use strict';

// Clé "anon" publique de Supabase — la même que celle déjà présente
// dans vlog.html. Ce n'est pas un secret (elle est faite pour être
// visible publiquement), donc pas besoin d'une variable d'environnement.
const SUPABASE_URL = 'https://wujlcxzyrdxltwhckcok.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Ind1amxjeHp5cmR4bHR3aGNrY29rIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyODM4MzMsImV4cCI6MjA5ODg1OTgzM30.ScNR5eYyt1nThLLfliDJwCg4eFiH4_83YHtPyPWwySI';

const VLOG_DIGEST_SECRET = process.env.VLOG_DIGEST_SECRET || '';
const VLOG_SUBS_SHEET_ID = process.env.VLOG_SUBS_SHEET_ID || '';
const PUBLIC_VLOG_BASE_URL = (process.env.PUBLIC_VLOG_BASE_URL || 'https://franfran120374-design.github.io/mon-bureau/').replace(/\/?$/, '/');

function supaHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    'Content-Type': 'application/json'
  };
}

async function supaGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: supaHeaders() });
  if (!r.ok) throw new Error(`Supabase GET ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function supaRpc(fn, args) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: supaHeaders(),
    body: JSON.stringify(args)
  });
  if (!r.ok) throw new Error(`Supabase RPC ${fn} → ${r.status}: ${await r.text()}`);
}

// ---------- Lecture des abonnés depuis le Google Sheet ----------
function parseCsvLine(line) {
  return line.split(',').map(c => c.trim().replace(/^"|"$/g, ''));
}

async function getSubscriberEmails(accessToken) {
  if (!VLOG_SUBS_SHEET_ID) throw new Error('VLOG_SUBS_SHEET_ID non configuré sur Render');

  const url = `https://www.googleapis.com/drive/v3/files/${VLOG_SUBS_SHEET_ID}/export?mimeType=text/csv`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error(`Lecture du Google Sheet impossible (HTTP ${r.status}) — vérifie VLOG_SUBS_SHEET_ID et l'accès du compte connecté.`);
  const csv = await r.text();

  const lignes = csv.split('\n').map(l => l.trim()).filter(Boolean);
  if (lignes.length < 2) return [];

  const entetes = parseCsvLine(lignes[0]).map(h => h.toLowerCase());
  const colEmail = entetes.findIndex(h => h.includes('mail'));
  if (colEmail === -1) throw new Error('Aucune colonne contenant "email" trouvée dans le Google Sheet.');

  const emails = new Set();
  for (let i = 1; i < lignes.length; i++) {
    const cols = parseCsvLine(lignes[i]);
    const email = (cols[colEmail] || '').trim();
    if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) emails.add(email.toLowerCase());
  }
  return Array.from(emails);
}

// ---------- Construction et envoi de l'email (Gmail API) ----------
function encodeSujet(s) {
  return `=?UTF-8?B?${Buffer.from(String(s || ''), 'utf8').toString('base64')}?=`;
}

function coupe76(b64) {
  return (b64.match(/.{1,76}/g) || []).join('\r\n');
}

function construitMimeSimple({ to, sujet, html }) {
  const L = [];
  L.push(`To: ${to}`);
  L.push(`Subject: ${encodeSujet(sujet)}`);
  L.push('MIME-Version: 1.0');
  L.push('Content-Type: text/html; charset="UTF-8"');
  L.push('Content-Transfer-Encoding: base64');
  L.push('');
  L.push(coupe76(Buffer.from(html, 'utf8').toString('base64')));
  return L.join('\r\n');
}

function excerpt(text, len) {
  if (!text) return '';
  const clean = String(text).replace(/\s+/g, ' ').trim();
  return clean.length > len ? clean.slice(0, len).trim() + '…' : clean;
}

function buildDigestHtml(fiches) {
  const items = fiches.map(f => `
    <tr>
      <td style="padding:14px 0; border-bottom:1px solid #e4dcc5;">
        <a href="${PUBLIC_VLOG_BASE_URL}vlog.html?f=${encodeURIComponent(f.slug)}"
           style="font-family:Georgia,serif; font-size:17px; font-weight:600; color:#211d16; text-decoration:none;">
          ${f.titre}
        </a>
        <div style="font-family:Arial,sans-serif; font-size:13px; color:#514a3c; margin-top:6px; line-height:1.5;">
          ${excerpt(f.essentiel, 160)}
        </div>
      </td>
    </tr>`).join('');

  return `
  <div style="max-width:560px; margin:0 auto; font-family:Arial,sans-serif;">
    <div style="font-family:Arial,sans-serif; font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:#c8a24a; margin-bottom:4px;">Mon Bureau</div>
    <h1 style="font-family:Georgia,serif; font-size:24px; margin:0 0 20px;">Le Vlog — nouvelles fiches</h1>
    <table style="width:100%; border-collapse:collapse;">${items}</table>
    <p style="font-family:Arial,sans-serif; font-size:11px; color:#a9a693; margin-top:30px;">
      Tu reçois cet email car tu es abonné(e) au Vlog Mon Bureau.<br>
      Pour te désabonner, réponds simplement à ce message.
    </p>
  </div>`;
}

export default function mountVlog(app, { getStoredGoogleRefreshToken, refreshAccessToken }) {

  app.get('/vlog/send-digest', async (req, res) => {
    try {
      if (!VLOG_DIGEST_SECRET || req.query.key !== VLOG_DIGEST_SECRET) {
        return res.status(403).json({ success: false, error: 'Clé invalide ou absente' });
      }

      const fiches = await supaGet(
        `vlog_fiches?select=slug,titre,essentiel&digest_envoye=eq.false&publie=eq.true&order=created_at.asc`
      );

      if (!fiches.length) {
        return res.json({ success: true, sent: false, reason: 'Aucune nouvelle fiche à envoyer.' });
      }

      const refreshToken = getStoredGoogleRefreshToken();
      if (!refreshToken) {
        return res.status(500).json({ success: false, error: 'Aucun compte Google connecté côté serveur.' });
      }
      const { access_token } = await refreshAccessToken(refreshToken);

      const emails = await getSubscriberEmails(access_token);

      if (!emails.length) {
        await supaRpc('marquer_digest_envoye', { p_slugs: fiches.map(f => f.slug) });
        return res.json({ success: true, sent: false, reason: 'Aucun abonné dans le Google Sheet pour le moment.' });
      }

      const html = buildDigestHtml(fiches);
      const sujet = fiches.length === 1 ? `📰 Nouvelle fiche : ${fiches[0].titre}` : `📰 ${fiches.length} nouvelles fiches sur le Vlog`;

      let envoyes = 0;
      const echecs = [];

      for (const email of emails) {
        try {
          const raw = Buffer.from(construitMimeSimple({ to: email, sujet, html }), 'utf8')
            .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

          const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
            method: 'POST',
            headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ raw })
          });
          if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            throw new Error(data.error?.message || `Gmail a refusé (HTTP ${r.status})`);
          }
          envoyes++;
        } catch (e) {
          echecs.push({ email, error: e.message });
        }
      }

      await supaRpc('marquer_digest_envoye', { p_slugs: fiches.map(f => f.slug) });

      const besoinReconnexion = echecs.some(e => /insufficient|scope|permission/i.test(e.error));

      res.json({
        success: true,
        sent: envoyes > 0,
        fichesEnvoyees: fiches.length,
        abonnesTouches: envoyes,
        totalAbonnes: emails.length,
        echecs,
        conseil: besoinReconnexion
          ? "Le compte Google connecté n'a pas le droit d'envoyer des emails (gmail.send). Reconnecte-toi depuis la tuile Emploi pour le réactiver."
          : undefined
      });

    } catch (error) {
      console.error('[Vlog] send-digest:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Vlog] ✅ route chargée : /vlog/send-digest');
}
