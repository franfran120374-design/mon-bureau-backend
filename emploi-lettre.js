/* =========================================================
   ROUTE LETTRE DE MOTIVATION — mon-bureau-backend
   Fichier autonome, à poser à la racine à côté de server.js.

   POURQUOI CE FICHIER
   La route /agents/chat passe par un seul fournisseur IA. Quand il
   sature, il répond « Rate limit exceeded » DANS le texte, avec un
   statut de succès — la tuile prenait donc l'erreur pour une lettre.
   Ce module essaie plusieurs fournisseurs l'un après l'autre et ne
   renvoie JAMAIS une erreur déguisée en texte.

   BRANCHEMENT — une seule ligne à ajouter dans server.js,
   juste sous la ligne « mountEmploi(app); » :

     mountLettre(app);

   ...et l'import correspondant tout en haut du fichier, sous
   « import mountEmploi from './emploi-routes.js'; » :

     import mountLettre from './emploi-lettre.js';

   VARIABLES D'ENVIRONNEMENT (déjà présentes sur Render, rien à créer) :
     AGGREGATOR_URL, AGGREGATOR_ACCESS_TOKEN, MIMO_API_URL, MIMO_MODEL

   ROUTE EXPOSÉE :
     POST /emploi/lettre  { system, prompt }
       → { success:true, lettre, fournisseur }
       → { success:false, error, essais:[...] }
   ========================================================= */

const VERSION = '1.3.0';

const AGGREGATOR_URL   = process.env.AGGREGATOR_URL || '';
const AGGREGATOR_TOKEN = process.env.AGGREGATOR_ACCESS_TOKEN || '';
const MIMO_API_URL     = process.env.MIMO_API_URL || 'https://opencode.ai/zen/v1/chat/completions';
const MIMO_MODEL       = process.env.MIMO_MODEL || 'mimo-v2.5-free';

// =========================================================
// 1. DÉTECTION DES FAUSSES RÉPONSES
// =========================================================

// Une réponse peut arriver avec un statut 200 tout en contenant un
// message d'erreur. On refuse ces textes plutôt que de les propager.
const SIGNES_ERREUR = [
  'rate limit', 'ratelimit', 'error from provider', 'erreur ia',
  'quota exceeded', 'try again later', 'service unavailable',
  'overloaded', 'invalid api key', 'unauthorized', 'insufficient',
  'internal server error', 'context length', '⚠️'
];

// =========================================================
// 1 bis. GARDE-FOU CONTRE LES CHIFFRES INVENTÉS
// =========================================================
//
// Les petits modèles fabriquent des statistiques pour « faire pro » :
// « 200 patients suivis », « satisfaction en hausse de 12 % ». Ces
// affirmations sont invérifiables et exposent la candidate en entretien.
// On refuse donc toute lettre contenant un nombre absent du CV et de
// l'annonce, et on relance un autre fournisseur.

function nombresDe(txt) {
  return (String(txt).match(/\d+(?:[.,]\d+)?/g) || [])
    .map(n => n.replace(',', '.'));
}

// Nombres toujours tolérés : années, département, durées courantes.
const NOMBRES_LIBRES = new Set([
  '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '12', '15', '24', '31',
  '2014', '2015', '2016', '2017', '2018', '2019', '2020', '2021', '2022',
  '2023', '2024', '2025', '2026', '2027'
]);

function chiffresInventes(lettre, sources) {
  const autorises = new Set(NOMBRES_LIBRES);
  for (const s of sources) for (const n of nombresDe(s)) autorises.add(n);
  return nombresDe(lettre).filter(n => !autorises.has(n));
}

// Formules qui trahissent une lettre générée. Leur présence suffit à
// rejeter la version et à en demander une autre.
const FORMULES_BANNIES = [
  'fort de mon experience', 'forte de mon experience', 'vif interet',
  'je me permets de', 'dynamique et motive', 'n hesitez pas',
  'je serais ravi', 'je serais heureu', 'je suis convaincu',
  'prestigieuse', 'votre renommee', 'polyvalente et rigoureuse',
  'a l ecoute et bienveillante', 'mettre mes competences au service',
  's integrent parfaitement', 'parfaitement aux exigences'
];

function sansAccentsMin(s) {
  return String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ');
}

function formulesTrouvees(lettre) {
  const plat = sansAccentsMin(lettre);
  return FORMULES_BANNIES.filter(f => plat.includes(f));
}

function texteExploitable(txt) {
  if (!txt || typeof txt !== 'string') return false;
  const s = txt.trim();
  if (s.length < 500) return false;                       // une lettre fait 1500+ signes
  const bas = s.toLowerCase();
  for (const marqueur of SIGNES_ERREUR) {
    if (bas.includes(marqueur)) return false;
  }
  // Une lettre de motivation commence toujours par une adresse au lecteur
  if (!/madame|monsieur|bonjour/i.test(s.slice(0, 250))) return false;
  return true;
}

// Retire ce que les modèles ajoutent parfois malgré la consigne
function nettoie(txt) {
  let s = String(txt).trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
  s = s.replace(/^(Objet|Sujet)\s*:.*$/gim, '');
  s = s.replace(/^(Voici|Bien s[uû]r|Certainement).{0,90}:\s*$/gim, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

function pause(ms) { return new Promise(r => setTimeout(r, ms)); }

// =========================================================
// 2. FOURNISSEUR A — AGRÉGATEUR IA (multi-modèles, le meilleur)
// =========================================================

async function viaAgregateur(system, prompt) {
  if (!AGGREGATOR_URL) throw new Error('AGGREGATOR_URL non configurée');

  // L'agrégateur n'a pas de champ « system » séparé : on fusionne.
  const complet = system + '\n\n----------\n\n' + prompt;

  const r = await fetch(`${AGGREGATOR_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(AGGREGATOR_TOKEN ? { 'X-Access-Token': AGGREGATOR_TOKEN } : {})
    },
    body: JSON.stringify({ prompt: complet, category: 'redaction' })
  });

  if (!r.ok) {
    const d = await r.json().catch(() => ({}));
    const e = new Error(d.detail || `agrégateur HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const j = await r.json();
  return { texte: j.response || '', modele: j.model || j.provider || 'agrégateur' };
}

// =========================================================
// 3. FOURNISSEUR B — MIMO (repli direct)
// =========================================================

async function viaMimo(system, prompt) {
  const r = await fetch(MIMO_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MIMO_MODEL,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: prompt }
      ],
      max_tokens: 1400,
      temperature: 0.8,
      top_p: 0.95
    })
  });

  const txt = await r.text();
  if (!r.ok) {
    const e = new Error(`MiMo HTTP ${r.status} : ${txt.slice(0, 140)}`);
    e.status = r.status;
    throw e;
  }
  let j;
  try { j = JSON.parse(txt); }
  catch { throw new Error('MiMo : réponse illisible'); }

  const contenu = j?.choices?.[0]?.message?.content || '';
  return { texte: contenu, modele: MIMO_MODEL };
}

// =========================================================
// 4. ENCHAÎNEMENT DES TENTATIVES
// =========================================================

// Ordre : agrégateur (meilleure qualité), puis MiMo, puis on repasse
// sur l'agrégateur après une pause au cas où c'était une saturation
// passagère. Chaque échec est consigné pour pouvoir être affiché.
const PLAN = [
  { nom: 'agrégateur IA', fn: viaAgregateur, avant: 0 },
  { nom: 'MiMo',          fn: viaMimo,       avant: 0 },
  { nom: 'agrégateur IA (2e essai)', fn: viaAgregateur, avant: 9000 },
  { nom: 'MiMo (2e essai)',          fn: viaMimo,       avant: 6000 }
];

async function redige(system, prompt, sources) {
  const essais = [];
  let repli = null;          // meilleure version imparfaite, au cas où

  for (const etape of PLAN) {
    if (etape.avant) await pause(etape.avant);
    try {
      const { texte, modele } = await etape.fn(system, prompt);
      const propre = nettoie(texte);

      if (!texteExploitable(propre)) {
        essais.push(`${etape.nom} : réponse inutilisable (${propre.slice(0, 80) || 'vide'})`);
        continue;
      }

      const inventes = chiffresInventes(propre, sources);
      const formules = formulesTrouvees(propre);

      if (!inventes.length && !formules.length) {
        return { lettre: propre, fournisseur: `${etape.nom} (${modele})`, essais, alertes: [] };
      }

      const alertes = [];
      if (inventes.length) alertes.push('chiffres non vérifiables : ' + inventes.slice(0, 6).join(', '));
      if (formules.length) alertes.push('formules toutes faites : ' + formules.slice(0, 3).join(', '));
      essais.push(`${etape.nom} : rejetée — ${alertes.join(' ; ')}`);

      // On garde la moins mauvaise en réserve : mieux vaut une lettre
      // signalée qu'aucune lettre du tout.
      const gravite = inventes.length * 3 + formules.length;
      if (!repli || gravite < repli.gravite) {
        repli = { lettre: propre, fournisseur: `${etape.nom} (${modele})`, gravite, alertes };
      }

    } catch (e) {
      essais.push(`${etape.nom} : ${e.message}`);
    }
  }

  if (repli) {
    return {
      lettre: repli.lettre,
      fournisseur: repli.fournisseur + ' — À RELIRE',
      essais,
      alertes: repli.alertes
    };
  }

  const err = new Error('Aucun fournisseur IA disponible pour le moment.');
  err.essais = essais;
  throw err;
}

// =========================================================
// 4 bis. RELECTURE ORTHOGRAPHIQUE ET GRAMMATICALE
// =========================================================
//
// Deuxième passage sur la lettre, consacré uniquement à la correction.
// Aucun droit de réécrire : on compare le résultat à l'original et on
// refuse la correction si elle a changé le fond (longueur, chiffres).

// ---------------------------------------------------------
// Correcteur LanguageTool : moteur à règles, gratuit, sans IA.
// Il ne peut pas inventer : il signale une faute et propose un
// remplacement. On applique uniquement les catégories sûres.
// ---------------------------------------------------------

const LT_URL = process.env.LANGUAGETOOL_URL || 'https://api.languagetool.org/v2/check';

// Catégories appliquées automatiquement : fautes objectives.
const LT_CATEGORIES_SURES = new Set([
  'TYPOS',          // fautes de frappe et d'orthographe
  'GRAMMAR',        // accords, conjugaison
  'CASING',         // majuscules
  'CONFUSED_WORDS', // a / à, ou / où, ce / se
  'TYPOGRAPHY',     // espaces avant ; : ! ?, apostrophes
  'PUNCTUATION',
  'COMPOUNDING',
  'MISC'
]);

// Règles écartées : trop bavardes ou stylistiques sur une lettre.
const LT_REGLES_IGNOREES = [
  'FRENCH_WHITESPACE',      // espaces insécables : illisible en texte brut
  'UPPERCASE_SENTENCE_START_FR',
  'AGREEMENT_POSTPONED_ADJ' // souvent faux positif sur les énumérations
];

async function corrigeLanguageTool(texte) {
  const corrections = [];
  if (!texte || texte.length > 19000) return { texte, corrections };

  let matches;
  try {
    const body = new URLSearchParams();
    body.set('language', 'fr');
    body.set('text', texte);
    body.set('level', 'default');

    const ctrl = new AbortController();
    const minuteur = setTimeout(() => ctrl.abort(), 15000);
    const r = await fetch(LT_URL, {
      method: 'POST',
      signal: ctrl.signal,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });
    clearTimeout(minuteur);
    if (!r.ok) throw new Error(`LanguageTool HTTP ${r.status}`);
    matches = (await r.json()).matches || [];
  } catch (e) {
    console.warn('[Lettre] LanguageTool indisponible :', e.message);
    return { texte, corrections };
  }

  // On applique de la fin vers le début : les positions restent valides.
  const retenus = matches
    .filter(m => m.replacements && m.replacements.length)
    .filter(m => LT_CATEGORIES_SURES.has(m.rule?.category?.id))
    .filter(m => !LT_REGLES_IGNOREES.includes(m.rule?.id))
    .filter(m => m.replacements[0].value && m.replacements[0].value.length < 40)
    .sort((a, b) => b.offset - a.offset);

  let sortie = texte;
  for (const m of retenus) {
    const avant = sortie.slice(m.offset, m.offset + m.length);
    const apres = m.replacements[0].value;
    if (avant === apres) continue;
    // Un correcteur ne doit jamais supprimer un chiffre
    if (/\d/.test(avant) && !/\d/.test(apres)) continue;
    sortie = sortie.slice(0, m.offset) + apres + sortie.slice(m.offset + m.length);
    corrections.push(`« ${avant} » → « ${apres} »`);
  }

  return { texte: sortie, corrections: corrections.reverse() };
}

const CONSIGNE_RELECTURE = [
  "Tu es correcteur professionnel de langue française. On te donne une lettre de motivation.",
  "",
  "TA SEULE MISSION : corriger les fautes. Rien d'autre.",
  "- Orthographe et accents.",
  "- Accords en genre et en nombre (participes passés, adjectifs, « souffrant » et non « souffrants »).",
  "- Conjugaison et concordance des temps.",
  "- Élisions et déterminants : « Mon expérience » et non « Ma expérience », « à AOEPS », « l'habitat ».",
  "- Ponctuation, espaces avant les deux-points et points-virgules, majuscules.",
  "- Répétitions immédiates d'un même mot dans une phrase.",
  "",
  "INTERDICTIONS ABSOLUES :",
  "- Ne reformule aucune phrase correcte. Ne change pas le style.",
  "- N'ajoute, ne supprime et ne déplace aucune information, aucun exemple, aucun paragraphe.",
  "- N'ajoute AUCUN chiffre, aucune date, aucun pourcentage.",
  "- Ne change pas la longueur : le texte corrigé doit faire le même nombre de phrases.",
  "- N'ajoute ni commentaire, ni explication, ni liste des corrections.",
  "",
  "SORTIE : uniquement la lettre corrigée, rien avant, rien après."
].join('\n');

function memesNombres(a, b) {
  const na = nombresDe(a).sort().join(',');
  const nb = nombresDe(b).sort().join(',');
  return na === nb;
}

async function relit(lettreOrigine) {
  // Passage 1 : LanguageTool, moteur à règles. Déterministe et sûr.
  const lt = await corrigeLanguageTool(lettreOrigine);
  const lettre = lt.texte;
  const corrections = lt.corrections.slice();

  // Passage 2 : relecture IA, pour ce que les règles ne voient pas
  // (concordance des temps, répétitions, tournures bancales).
  const plan = [
    { nom: 'agrégateur IA', fn: viaAgregateur },
    { nom: 'MiMo',          fn: viaMimo }
  ];

  for (const etape of plan) {
    try {
      const { texte } = await etape.fn(CONSIGNE_RELECTURE, "LETTRE À CORRIGER :\n\n" + lettre);
      const corrige = nettoie(texte);

      // Contrôles : la correction ne doit pas avoir réécrit la lettre.
      const ecart = Math.abs(corrige.length - lettre.length) / lettre.length;
      if (!texteExploitable(corrige)) continue;
      if (ecart > 0.18) continue;                    // trop de changement = réécriture
      if (!memesNombres(lettre, corrige)) continue;  // chiffres modifiés = refus
      if (formulesTrouvees(corrige).length > formulesTrouvees(lettre).length) continue;

      return {
        lettre: corrige,
        relu: true,
        correcteur: 'LanguageTool + ' + etape.nom,
        corrections,
        nbRegles: lt.corrections.length
      };
    } catch (e) {
      // On passe au correcteur suivant
    }
  }

  // L'IA n'a pas répondu : on garde au moins les corrections de règles.
  return {
    lettre,
    relu: corrections.length > 0,
    correcteur: corrections.length ? 'LanguageTool' : null,
    corrections,
    nbRegles: corrections.length
  };
}

// =========================================================
// 5. MONTAGE
// =========================================================

export default function mountLettre(app) {

  app.get('/emploi/lettre/ping', (req, res) => {
    res.json({
      success: true,
      version: VERSION,
      agregateur: !!AGGREGATOR_URL,
      agregateurToken: !!AGGREGATOR_TOKEN,
      mimo: !!MIMO_API_URL,
      modeleMimo: MIMO_MODEL
    });
  });

  app.post('/emploi/lettre', async (req, res) => {
    const debut = Date.now();
    try {
      const { system, prompt } = req.body || {};
      if (!system || !prompt) {
        return res.status(400).json({ success: false, error: 'system et prompt sont requis' });
      }
      if (String(prompt).length > 24000) {
        return res.status(400).json({ success: false, error: 'prompt trop long' });
      }

      // Le prompt contient le CV et l'annonce : ce sont les seules sources
      // de chiffres légitimes.
      const r = await redige(String(system), String(prompt), [String(prompt)]);

      // Deuxième passage : correction orthographique et grammaticale.
      // Elle ne peut que corriger, jamais réécrire (contrôles dans relit()).
      const relecture = (req.body.relire === false)
        ? { lettre: r.lettre, relu: false, correcteur: null }
        : await relit(r.lettre);

      console.log(`[Lettre] ${r.fournisseur} | relecture: ${relecture.relu ? relecture.correcteur : 'non'} | ` +
                  `${Math.round((Date.now() - debut) / 1000)}s` +
                  (r.essais.length ? ` | ${r.essais.length} échec(s)` : ''));

      res.json({
        success: true,
        lettre: relecture.lettre,
        fournisseur: r.fournisseur,
        relu: relecture.relu,
        correcteur: relecture.correcteur,
        corrections: relecture.corrections || [],
        mots: relecture.lettre.split(/\s+/).length,
        alertes: r.alertes || [],
        essais: r.essais
      });

    } catch (e) {
      console.error('[Lettre] échec complet :', (e.essais || []).join(' | ') || e.message);
      res.status(503).json({
        success: false,
        error: e.message,
        essais: e.essais || [],
        conseil: "Les services IA sont saturés. Réessaie dans deux à trois minutes."
      });
    }
  });

  // Corrige un texte fourni tel quel : sert au bouton « Relire » de la
  // tuile, une fois que tu as modifié la lettre à la main.
  app.post('/emploi/relire', async (req, res) => {
    try {
      const { texte } = req.body || {};
      if (!texte || String(texte).trim().length < 200) {
        return res.status(400).json({ success: false, error: 'texte trop court' });
      }
      const r = await relit(String(texte));
      res.json({
        success: true,
        texte: r.lettre,
        relu: r.relu,
        correcteur: r.correcteur,
        corrections: r.corrections || [],
        modifie: r.lettre !== String(texte)
      });
    } catch (e) {
      res.status(503).json({ success: false, error: e.message });
    }
  });

  console.log('[Lettre] ✅ routes chargées : /emploi/lettre, /emploi/relire (+ /emploi/lettre/ping)');
}
