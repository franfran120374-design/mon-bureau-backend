/* =========================================================
   EMPLOI — Module de routes backend (Mon Bureau)
   -------------------------------------------------------
   Ce fichier est AUTONOME. Il s'ajoute à server.js sans le
   modifier, grâce à UNE SEULE ligne à coller tout en bas de
   server.js (voir README fourni) :

     import('./emploi-routes.js')
       .then(m => m.default(app))
       .catch(e => console.error('[Emploi] non chargé:', e.message));

   Ce qu'il fait :
   1) Interroge l'API officielle France Travail (ex-Pôle Emploi)
      "Offres d'emploi v2" côté serveur (impossible depuis le
      navigateur : pas de CORS + le secret ne doit pas fuiter).
   2) Note chaque offre selon le profil de Sandra (coordination
      de parcours de soins + santé numérique / dev IA).
   3) Calcule la vraie accessibilité : distance à pied jusqu'à
      la station VélôToulouse la plus proche (flux GBFS JCDecaux
      déjà utilisé par la tuile Vélô), puis zone Tisséo.
   4) Trouve l'email du recruteur (fiche offre, puis site de
      l'entreprise en dernier recours).
   5) Envoie la candidature par Gmail avec le CV en pièce jointe.

   Variables d'environnement à créer sur Render :
     FT_CLIENT_ID      → identifiant appli francetravail.io
     FT_CLIENT_SECRET  → secret appli francetravail.io
   (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI
    existent déjà, on les réutilise.)
   ========================================================= */

'use strict';

// =========================================================
// CONFIGURATION
// =========================================================

const FT_CLIENT_ID     = process.env.FT_CLIENT_ID || '';
const FT_CLIENT_SECRET = process.env.FT_CLIENT_SECRET || '';

const FT_TOKEN_URL  = 'https://entreprise.francetravail.fr/connexion/oauth2/access_token?realm=%2Fpartenaire';
const FT_SEARCH_URL = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres/search';
const FT_OFFRE_URL  = 'https://api.francetravail.io/partenaire/offresdemploi/v2/offres';

const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REDIRECT_URI  = process.env.GOOGLE_REDIRECT_URI || 'http://localhost:3000/auth/google/callback';

// Scopes = ceux déjà utilisés par Mon Bureau + l'envoi Gmail.
// gmail.send permet UNIQUEMENT d'envoyer : il ne donne aucun
// accès en lecture à la boîte mail.
const SCOPES_AVEC_GMAIL = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/drive',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile'
];

// Centre de Toulouse (Capitole)
const TLS_LAT = 43.60446;
const TLS_LON = 1.44422;

// Flux GBFS VélôToulouse (déjà validé CORS-ouvert côté tuile Vélô)
const GBFS_STATIONS = 'https://api.cyclocity.fr/contracts/toulouse/gbfs/v2/station_information.json';

// =========================================================
// PETITS OUTILS
// =========================================================

function haversineKm(lat1, lon1, lat2, lon2) {
  if ([lat1, lon1, lat2, lon2].some(v => typeof v !== 'number' || isNaN(v))) return null;
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)) * 100) / 100;
}

function sansAccents(s) {
  return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function nettoie(txt, max) {
  const t = String(txt || '').replace(/\s+/g, ' ').trim();
  return max && t.length > max ? t.slice(0, max) + '…' : t;
}

// =========================================================
// AUTHENTIFICATION FRANCE TRAVAIL (OAuth2 client_credentials)
// Le jeton dure ~25 min : on le garde en mémoire et on le
// renouvelle seulement quand il est périmé.
// =========================================================

let ftToken = null;
let ftTokenExpire = 0;

async function getFtToken() {
  if (!FT_CLIENT_ID || !FT_CLIENT_SECRET) {
    throw new Error('Clés France Travail absentes (FT_CLIENT_ID / FT_CLIENT_SECRET à créer sur Render)');
  }
  if (ftToken && Date.now() < ftTokenExpire - 60000) return ftToken;

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: FT_CLIENT_ID,
    client_secret: FT_CLIENT_SECRET,
    scope: 'api_offresdemploiv2 o2dsoffre'
  });

  const r = await fetch(FT_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(`France Travail auth ${r.status} : ${txt.slice(0, 200)}`);

  const data = JSON.parse(txt);
  ftToken = data.access_token;
  ftTokenExpire = Date.now() + (data.expires_in || 1500) * 1000;
  console.log('[Emploi] jeton France Travail obtenu');
  return ftToken;
}

async function ftGet(url) {
  const token = await getFtToken();
  const r = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' }
  });
  // 204 = aucun résultat ; 206 = résultats partiels (pagination) → normal
  if (r.status === 204) return { resultats: [] };
  const txt = await r.text();
  if (!r.ok && r.status !== 206) {
    throw new Error(`France Travail ${r.status} : ${txt.slice(0, 200)}`);
  }
  return txt ? JSON.parse(txt) : { resultats: [] };
}

// =========================================================
// STATIONS VÉLÔTOULOUSE (mises en cache 24 h)
// =========================================================

let stationsCache = null;
let stationsCacheDate = 0;

async function getStations() {
  if (stationsCache && Date.now() - stationsCacheDate < 24 * 3600 * 1000) return stationsCache;
  try {
    const r = await fetch(GBFS_STATIONS);
    const data = await r.json();
    stationsCache = (data?.data?.stations || []).map(s => ({
      nom: s.name, lat: s.lat, lon: s.lon
    }));
    stationsCacheDate = Date.now();
    console.log(`[Emploi] ${stationsCache.length} stations VélôToulouse chargées`);
  } catch (e) {
    console.warn('[Emploi] stations vélo indisponibles:', e.message);
    stationsCache = stationsCache || [];
  }
  return stationsCache;
}

/**
 * Détermine comment Sandra peut se rendre au lieu de travail.
 * Renvoie { mode, emoji, libelle, kmCentre, station, metresStation, points }
 */
async function evalueMobilite(lat, lon) {
  const kmCentre = haversineKm(TLS_LAT, TLS_LON, lat, lon);
  if (kmCentre === null) {
    return { mode: 'inconnu', emoji: '📍', libelle: 'Lieu non géolocalisé', kmCentre: null, points: 0 };
  }

  const stations = await getStations();
  let best = null;
  for (const s of stations) {
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (d !== null && (!best || d < best.d)) best = { d, nom: s.nom };
  }
  const metresStation = best ? Math.round(best.d * 1000) : null;

  // Une station à moins de 500 m = vraiment "à vélo"
  if (metresStation !== null && metresStation <= 500) {
    return {
      mode: 'velo', emoji: '🚲',
      libelle: `Station ${best.nom} à ${metresStation} m`,
      kmCentre, station: best.nom, metresStation, points: 18
    };
  }
  if (metresStation !== null && metresStation <= 1000) {
    return {
      mode: 'velo-marche', emoji: '🚲',
      libelle: `Station ${best.nom} à ${metresStation} m (10 min à pied)`,
      kmCentre, station: best.nom, metresStation, points: 12
    };
  }
  if (kmCentre <= 12) {
    return {
      mode: 'tisseo', emoji: '🚌',
      libelle: `${kmCentre} km du Capitole — réseau Tisséo`,
      kmCentre, station: best?.nom || null, metresStation, points: 8
    };
  }
  if (kmCentre <= 30) {
    return {
      mode: 'peripherie', emoji: '🚗',
      libelle: `${kmCentre} km — périphérie, voiture conseillée`,
      kmCentre, station: null, metresStation, points: 2
    };
  }
  return {
    mode: 'loin', emoji: '🚗',
    libelle: `${kmCentre} km de Toulouse`,
    kmCentre, station: null, metresStation, points: 0
  };
}

// =========================================================
// SCORING : à quel point l'offre colle au profil ?
// Note sur 100. Les listes de mots sont modifiables depuis les
// réglages de la tuile (envoyées dans le corps de la requête).
// =========================================================

const MOTS_METIER_DEFAUT = [
  'coordination', 'coordinateur', 'coordinatrice', 'coordonnateur',
  'parcours de soin', 'parcours patient', 'case manager', 'idec',
  'infirmier coordinateur', 'infirmiere coordinatrice',
  'infirmier de coordination', 'gestionnaire de cas',
  'referent parcours', 'chargee de mission sante', 'charge de mission sante'
];

const MOTS_PUBLIC_DEFAUT = [
  'precarite', 'exil', 'migrant', 'demandeur d asile', 'sante mentale',
  'psychiatrie', 'addictologie', 'habitat inclusif', 'vulnerable',
  'lhss', 'lam', 'act ', 'csapa', 'caarud', 'pass ', 'insertion',
  'medico-social', 'medico social', 'reseau', 'partenarial', 'psychotrauma'
];

const MOTS_NUM_DEFAUT = [
  'e-sante', 'e sante', 'numerique en sante', 'sante numerique',
  'chef de projet digital', 'product owner', 'no-code', 'no code',
  'intelligence artificielle', 'transformation numerique',
  'systeme d information', 'telemedecine', 'application mobile'
];

const MOTS_EXCLUS_DEFAUT = ['nuit permanente', 'garde de nuit uniquement'];

function noteOffre(offre, mob, cfg) {
  const metier  = (cfg.motsMetier  || MOTS_METIER_DEFAUT).map(sansAccents);
  const publics = (cfg.motsPublic  || MOTS_PUBLIC_DEFAUT).map(sansAccents);
  const numer   = (cfg.motsNum     || MOTS_NUM_DEFAUT).map(sansAccents);
  const exclus  = (cfg.motsExclus  || MOTS_EXCLUS_DEFAUT).map(sansAccents).filter(Boolean);

  const titre = sansAccents(offre.intitule);
  const texte = sansAccents(`${offre.intitule} ${offre.description} ${offre.romeLibelle || ''} ${offre.appellationlibelle || ''}`);

  let score = 0;
  const raisons = [];

  // 1) Le TITRE parle-t-il de coordination ? (le signal le plus fort)
  const hitTitre = metier.filter(m => titre.includes(m));
  if (hitTitre.length) { score += 32; raisons.push('Poste de coordination'); }
  else {
    const hitTexte = metier.filter(m => texte.includes(m));
    if (hitTexte.length) { score += 14; raisons.push('Coordination évoquée dans l’annonce'); }
  }

  // 2) Publics et champs d'expertise
  const hitPublic = publics.filter(m => texte.includes(m));
  if (hitPublic.length >= 3) { score += 22; raisons.push('Publics vulnérables / réseau (fort)'); }
  else if (hitPublic.length >= 1) { score += 12; raisons.push('Champ médico-social'); }

  // 3) Volet numérique / IA
  const hitNum = numer.filter(m => texte.includes(m));
  if (hitNum.length) { score += 14; raisons.push('Dimension santé numérique'); }

  // 4) Diplôme infirmier explicitement demandé
  if (/\b(infirmier|infirmiere|ide\b|diplome d etat)/.test(texte)) {
    score += 8; raisons.push('Diplôme IDE valorisé');
  }

  // 5) Mobilité (vélo prioritaire, c'est la demande de Sandra)
  score += mob.points;
  if (mob.points >= 12) raisons.push('Accessible en VélôToulouse');
  else if (mob.points >= 8) raisons.push('Accessible en Tisséo');

  // 6) Type de contrat et fraîcheur
  if (/CDI/i.test(offre.typeContrat || '')) { score += 8; raisons.push('CDI'); }
  const joursDepuis = offre.dateCreation
    ? Math.floor((Date.now() - new Date(offre.dateCreation).getTime()) / 86400000) : 99;
  if (joursDepuis <= 3) { score += 8; raisons.push('Publiée il y a moins de 3 jours'); }
  else if (joursDepuis <= 7) { score += 4; }

  // 7) Bonus décisif : on peut postuler par email en un clic
  if (offre.contact?.courriel) { score += 10; raisons.push('Candidature par email possible'); }

  // 8) Malus sur les mots exclus par Sandra
  for (const m of exclus) {
    if (texte.includes(m)) { score -= 30; raisons.push(`Contient « ${m} »`); }
  }

  return { score: Math.max(0, Math.min(100, score)), raisons, joursDepuis };
}

// =========================================================
// NORMALISATION D'UNE OFFRE
// =========================================================

async function normalise(o, cfg) {
  const lat = o.lieuTravail?.latitude;
  const lon = o.lieuTravail?.longitude;
  const mob = await evalueMobilite(lat, lon);
  const { score, raisons, joursDepuis } = noteOffre(o, mob, cfg);

  return {
    id: o.id,
    intitule: nettoie(o.intitule, 140),
    entreprise: nettoie(o.entreprise?.nom || o.agence?.nom || 'Employeur non précisé', 90),
    entrepriseUrl: o.entreprise?.url || null,
    secteur: nettoie(o.secteurActiviteLibelle, 80),
    description: nettoie(o.description, 1200),
    descriptionComplete: nettoie(o.description, 6000),
    typeContrat: o.typeContrat || '',
    contratLibelle: nettoie(o.typeContratLibelle, 60),
    duree: nettoie(o.dureeTravailLibelleConverti || o.dureeTravailLibelle, 50),
    salaire: nettoie(o.salaire?.libelle, 80),
    experience: nettoie(o.experienceLibelle, 60),
    qualification: nettoie(o.qualificationLibelle, 60),
    rome: o.romeCode || '',
    romeLibelle: nettoie(o.romeLibelle, 80),
    ville: nettoie(o.lieuTravail?.libelle, 60),
    codePostal: o.lieuTravail?.codePostal || '',
    lat, lon,
    dateCreation: o.dateCreation || null,
    joursDepuis,
    url: o.origineOffre?.urlOrigine || `https://candidat.francetravail.fr/offres/recherche/detail/${o.id}`,
    contact: {
      nom: nettoie(o.contact?.nom, 90) || null,
      courriel: o.contact?.courriel || null,
      telephone: o.contact?.telephone || null,
      urlPostulation: o.contact?.urlPostulation || null,
      coordonnees: nettoie([o.contact?.coordonnees1, o.contact?.coordonnees2, o.contact?.coordonnees3].filter(Boolean).join(' — '), 200) || null
    },
    mobilite: mob,
    score,
    raisons
  };
}

// =========================================================
// RECHERCHE D'EMAIL SUR LE SITE DE L'ENTREPRISE
// (dernier recours quand l'offre ne donne pas de contact)
// =========================================================

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const EMAILS_A_IGNORER = /(sentry|wixpress|example|\.png|\.jpg|\.gif|\.webp|domain\.com|votre-?email)/i;

function trieEmails(liste) {
  const priorite = ['recrut', 'rh', 'emploi', 'candidat', 'drh', 'job', 'career', 'direction', 'contact', 'accueil', 'info', 'secretariat'];
  return [...new Set(liste)]
    .filter(e => !EMAILS_A_IGNORER.test(e))
    .sort((a, b) => {
      const ia = priorite.findIndex(p => a.toLowerCase().includes(p));
      const ib = priorite.findIndex(p => b.toLowerCase().includes(p));
      return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
    });
}

async function chercheEmailSurSite(siteUrl) {
  if (!siteUrl) return [];
  let base = siteUrl.trim();
  if (!/^https?:\/\//i.test(base)) base = 'https://' + base;

  const pages = [base, base.replace(/\/$/, '') + '/contact', base.replace(/\/$/, '') + '/nous-contacter',
                 base.replace(/\/$/, '') + '/recrutement', base.replace(/\/$/, '') + '/nous-rejoindre'];
  const trouves = [];

  for (const url of pages) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 6000);
      const r = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MonBureau/1.0)' }
      });
      clearTimeout(t);
      if (!r.ok) continue;
      const html = await r.text();
      const m = html.match(EMAIL_REGEX) || [];
      trouves.push(...m);
      if (trieEmails(trouves).length >= 3) break;
    } catch (e) { /* page absente ou trop lente : on passe */ }
  }
  return trieEmails(trouves).slice(0, 5);
}

// =========================================================
// GOOGLE : jeton d'accès valide + envoi Gmail
// =========================================================

function tokensDepuisRequete(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) throw new Error('Compte Google non connecté');
  try {
    return JSON.parse(Buffer.from(auth.substring(7), 'base64').toString('utf8'));
  } catch {
    throw new Error('Jetons Google illisibles');
  }
}

async function jetonValide(tokens) {
  if (!tokens?.access_token) throw new Error('Compte Google non connecté');
  const marge = 2 * 60 * 1000;
  if (tokens.expiry_date && Date.now() < tokens.expiry_date - marge) return tokens.access_token;
  if (!tokens.refresh_token) return tokens.access_token;

  const body = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: tokens.refresh_token,
    grant_type: 'refresh_token'
  });
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error_description || 'Rafraîchissement du jeton Google impossible');
  tokens.access_token = data.access_token;
  tokens.expiry_date = Date.now() + (data.expires_in || 3600) * 1000;
  return tokens.access_token;
}

/** Récupère un fichier Drive prêt à être mis en pièce jointe. */
async function pieceJointeDepuisDrive(accessToken, fileId) {
  const metaR = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const meta = await metaR.json();
  if (!metaR.ok) throw new Error(meta.error?.message || 'Fichier Drive introuvable');

  let url, mimeType, nom = meta.name || 'piece-jointe';

  if (String(meta.mimeType).startsWith('application/vnd.google-apps')) {
    // Google Doc / Slides… → on exporte en PDF
    mimeType = 'application/pdf';
    url = `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=application%2Fpdf`;
    if (!/\.pdf$/i.test(nom)) nom += '.pdf';
  } else {
    mimeType = meta.mimeType || 'application/octet-stream';
    url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
  }

  const r = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) throw new Error('Téléchargement du fichier Drive impossible');
  const buf = Buffer.from(await r.arrayBuffer());
  return { nom, mimeType, base64: buf.toString('base64') };
}

/** Encode un sujet contenant des accents (RFC 2047). */
function encodeSujet(s) {
  return `=?UTF-8?B?${Buffer.from(String(s || ''), 'utf8').toString('base64')}?=`;
}

function coupe76(b64) {
  return (b64.match(/.{1,76}/g) || []).join('\r\n');
}

function construitMime({ to, cc, sujet, texte, html, pieces }) {
  const frontiere = '=_MonBureau_' + Date.now().toString(36);
  const L = [];
  L.push(`To: ${to}`);
  if (cc) L.push(`Cc: ${cc}`);
  L.push(`Subject: ${encodeSujet(sujet)}`);
  L.push('MIME-Version: 1.0');

  const aPieces = Array.isArray(pieces) && pieces.length > 0;

  if (!aPieces) {
    L.push('Content-Type: text/html; charset="UTF-8"');
    L.push('Content-Transfer-Encoding: base64');
    L.push('');
    L.push(coupe76(Buffer.from(html || texte || '', 'utf8').toString('base64')));
    return L.join('\r\n');
  }

  L.push(`Content-Type: multipart/mixed; boundary="${frontiere}"`);
  L.push('');
  L.push(`--${frontiere}`);
  L.push('Content-Type: text/html; charset="UTF-8"');
  L.push('Content-Transfer-Encoding: base64');
  L.push('');
  L.push(coupe76(Buffer.from(html || texte || '', 'utf8').toString('base64')));

  for (const p of pieces) {
    L.push('');
    L.push(`--${frontiere}`);
    L.push(`Content-Type: ${p.mimeType}; name="${p.nom}"`);
    L.push(`Content-Disposition: attachment; filename="${p.nom}"`);
    L.push('Content-Transfer-Encoding: base64');
    L.push('');
    L.push(coupe76(p.base64));
  }
  L.push('');
  L.push(`--${frontiere}--`);
  return L.join('\r\n');
}

// =========================================================
// ENREGISTREMENT DES ROUTES
// =========================================================

export default function registerEmploiRoutes(app) {

  // ---------------------------------------------------------
  // Diagnostic : est-ce que tout est branché ?
  // ---------------------------------------------------------
  app.get('/emploi/ping', (req, res) => {
    res.json({
      success: true,
      module: 'emploi',
      version: '1.0.0',
      franceTravail: Boolean(FT_CLIENT_ID && FT_CLIENT_SECRET),
      google: Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET),
      stationsVelo: stationsCache ? stationsCache.length : 'pas encore chargées'
    });
  });

  // ---------------------------------------------------------
  // URL de reconnexion Google AVEC le droit d'envoyer des mails
  // ---------------------------------------------------------
  app.get('/emploi/auth-url', (req, res) => {
    if (!GOOGLE_CLIENT_ID) return res.status(500).json({ success: false, error: 'GOOGLE_CLIENT_ID absent' });
    const params = new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      redirect_uri: GOOGLE_REDIRECT_URI,
      response_type: 'code',
      scope: SCOPES_AVEC_GMAIL.join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state: req.query.redirect || ''
    });
    res.json({ success: true, url: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
  });

  // ---------------------------------------------------------
  // RECHERCHE D'OFFRES
  // Corps attendu :
  // {
  //   requetes: [{ motsCles, codeROME, commune, distance }, ...],
  //   publieeDepuis: 31,
  //   scoreMini: 40,
  //   motsMetier: [], motsPublic: [], motsNum: [], motsExclus: []
  // }
  // ---------------------------------------------------------
  app.post('/emploi/offres', async (req, res) => {
    try {
      const cfg = req.body || {};
      const requetes = Array.isArray(cfg.requetes) && cfg.requetes.length
        ? cfg.requetes.slice(0, 8)
        : [{ motsCles: 'coordination parcours de soins' }];

      const publieeDepuis = [1, 3, 7, 14, 31].includes(Number(cfg.publieeDepuis))
        ? Number(cfg.publieeDepuis) : 31;

      const brutes = new Map();   // id -> offre brute (dédoublonnage)
      const erreurs = [];

      for (const q of requetes) {
        const p = new URLSearchParams();
        if (q.motsCles) p.set('motsCles', String(q.motsCles).slice(0, 200));
        if (q.codeROME) p.set('codeROME', String(q.codeROME));
        p.set('commune', String(q.commune || '31555'));           // 31555 = Toulouse
        p.set('distance', String(q.distance ?? cfg.rayonKm ?? 25));
        p.set('publieeDepuis', String(publieeDepuis));
        p.set('sort', '1');                                        // tri par date décroissante
        p.set('range', '0-49');

        try {
          const data = await ftGet(`${FT_SEARCH_URL}?${p}`);
          for (const o of (data.resultats || [])) {
            if (!brutes.has(o.id)) brutes.set(o.id, o);
          }
        } catch (e) {
          erreurs.push(`${q.motsCles || q.codeROME} : ${e.message}`);
        }
      }

      const offres = [];
      for (const o of brutes.values()) {
        offres.push(await normalise(o, cfg));
      }

      const scoreMini = Number(cfg.scoreMini ?? 35);
      const retenues = offres
        .filter(o => o.score >= scoreMini)
        .sort((a, b) => b.score - a.score || a.joursDepuis - b.joursDepuis);

      res.json({
        success: true,
        total: brutes.size,
        retenues: retenues.length,
        offres: retenues.slice(0, 60),
        erreurs: erreurs.length ? erreurs : undefined,
        genereLe: new Date().toISOString()
      });

    } catch (error) {
      console.error('[Emploi] recherche:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------------------------------------------------------
  // DÉTAIL D'UNE OFFRE (contient le contact du recruteur)
  // ---------------------------------------------------------
  app.get('/emploi/offre/:id', async (req, res) => {
    try {
      const data = await ftGet(`${FT_OFFRE_URL}/${encodeURIComponent(req.params.id)}`);
      const offre = await normalise(data, req.query || {});
      res.json({ success: true, offre });
    } catch (error) {
      console.error('[Emploi] détail:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------------------------------------------------------
  // TROUVER L'EMAIL DU RECRUTEUR
  // Corps : { offreId, entreprise, siteWeb }
  // Ordre : contact de l'offre → site de l'entreprise → rien
  // ---------------------------------------------------------
  app.post('/emploi/email-recruteur', async (req, res) => {
    try {
      const { offreId, siteWeb } = req.body || {};
      let source = null, email = null, candidats = [], urlPostulation = null, nomContact = null;

      if (offreId) {
        try {
          const data = await ftGet(`${FT_OFFRE_URL}/${encodeURIComponent(offreId)}`);
          if (data?.contact?.courriel) {
            email = data.contact.courriel;
            source = 'offre France Travail';
            nomContact = data.contact.nom || null;
          }
          urlPostulation = data?.contact?.urlPostulation || data?.origineOffre?.urlOrigine || null;
          if (!siteWeb && data?.entreprise?.url) {
            candidats = await chercheEmailSurSite(data.entreprise.url);
          }
        } catch (e) { /* on continue avec le site */ }
      }

      if (!email && siteWeb) {
        candidats = await chercheEmailSurSite(siteWeb);
      }
      if (!email && candidats.length) {
        email = candidats[0];
        source = 'site de l’entreprise';
      }

      res.json({
        success: true,
        email,
        nomContact,
        source,
        candidats,
        urlPostulation,
        message: email
          ? `Email trouvé via ${source}`
          : 'Aucun email : il faudra passer par le lien de candidature'
      });

    } catch (error) {
      console.error('[Emploi] email-recruteur:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  // ---------------------------------------------------------
  // ENVOI DE LA CANDIDATURE PAR GMAIL
  // En-tête Authorization : Bearer <tokens Google en base64>
  // Corps : { to, cc, sujet, html, texte, driveFileIds: [] }
  // ---------------------------------------------------------
  app.post('/emploi/gmail-send', async (req, res) => {
    try {
      const { to, cc, sujet, html, texte, driveFileIds } = req.body || {};
      if (!to) return res.status(400).json({ success: false, error: 'Destinataire manquant' });
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(to).trim())) {
        return res.status(400).json({ success: false, error: `Adresse invalide : ${to}` });
      }

      const tokens = tokensDepuisRequete(req);
      const accessToken = await jetonValide(tokens);

      const pieces = [];
      for (const fid of (Array.isArray(driveFileIds) ? driveFileIds.slice(0, 4) : [])) {
        if (!fid) continue;
        try { pieces.push(await pieceJointeDepuisDrive(accessToken, fid)); }
        catch (e) { console.warn('[Emploi] pièce jointe ignorée:', e.message); }
      }

      const mime = construitMime({ to: String(to).trim(), cc, sujet, texte, html, pieces });
      const raw = Buffer.from(mime, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const r = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw })
      });
      const data = await r.json();

      if (!r.ok) {
        const msg = data.error?.message || 'Envoi refusé par Gmail';
        // Cas typique : le compte Google n'a pas encore le droit gmail.send
        const besoinReconnexion = /insufficient|scope|permission/i.test(msg);
        return res.status(r.status).json({
          success: false,
          error: msg,
          besoinReconnexion,
          conseil: besoinReconnexion
            ? 'Reconnecte Google depuis les réglages de la tuile Emploi pour autoriser l’envoi de mails.'
            : undefined
        });
      }

      res.json({
        success: true,
        messageId: data.id,
        threadId: data.threadId,
        piecesJointes: pieces.map(p => p.nom),
        tokens: { ...tokens, access_token: accessToken }
      });

    } catch (error) {
      console.error('[Emploi] gmail-send:', error.message);
      res.status(500).json({ success: false, error: error.message });
    }
  });

  console.log('[Emploi] ✅ routes chargées : /emploi/ping, /emploi/auth-url, /emploi/offres, /emploi/offre/:id, /emploi/email-recruteur, /emploi/gmail-send');
}
