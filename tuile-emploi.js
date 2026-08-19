/* =========================================================
   TUILE EMPLOI — Mon Bureau  (v1)
   Recherche d'offres ciblées sur le profil de Sandra,
   priorisées selon l'accessibilité VélôToulouse / Toulouse,
   avec candidature en un clic :
     lettre de motivation générée → sauvegarde Drive →
     recherche du mail du recruteur → envoi Gmail.

   Fichier 100 % autonome :
   - il crée lui-même sa tuile dans <main> (rien à ajouter
     dans index.html à part la ligne <script>) ;
   - il s'enregistre dans Apps (couche3.js) pour le panneau ;
   - il injecte ses propres styles (styles.css intact) ;
   - profil + candidatures passent par CloudSync catégorie
     'settings' → synchro PC <-> téléphone automatique.

   index.html, APRÈS couche3.js :
     <script src="tuile-emploi.js?v=1" defer></script>
   ========================================================= */

(function () {
  'use strict';

  // =========================================================
  // 1. CONFIGURATION
  // =========================================================

  const BACKEND = (location.hostname === 'localhost')
    ? 'http://localhost:3000'
    : 'https://mon-bureau-backend.onrender.com';

  const CAT = 'settings';
  const CLE_CFG  = 'emploi';
  const CLE_CAND = 'emploi_candidatures';
  const LS_CFG   = 'mb_emploi_cfg';
  const LS_CACHE = 'mb_emploi_cache';     // local uniquement : trop gros pour la sync
  const LS_VUES  = 'mb_emploi_vues';      // offres déjà vues (pour le badge "nouveau")
  const LS_IGNOR = 'mb_emploi_ignorees';  // offres écartées à la main
  const LS_APPRIS = 'mb_emploi_appris';   // ce que la tuile a appris de tes refus
  const CLE_CARNET = 'emploi_carnet';     // mails de recruteurs déjà trouvés, par entreprise

  const DOSSIER_DRIVE = 'Candidatures — Mon Bureau';

  const DEFAUT = {
    // --- Profil ---
    nom: 'Sandra MERCIER',
    mailPerso: 'franfran120374@gmail.com',
    telephone: '06 35 26 85 79',
    ville: 'Toulouse',
    codePostal: '31100',
    lienApp: 'https://franfran120374-design.github.io/appli-sante-31/',

    cv: [
      "Infirmière de coordination thérapeutique — Coordinatrice de Parcours Médico-Social, Toulouse (31100).",
      "",
      "APPLICATIONS CONÇUES ET DÉVELOPPÉES PAR MOI :",
      "- Santé 31, orientation dans le parcours de soins : https://franfran120374-design.github.io/appli-sante-31/",
      "- AOEPS, aide à l'évaluation du potentiel suicidaire : https://franfran120374-design.github.io/AOEPS/",
      "",
      "PROFIL : spécialiste de la coordination de parcours de soins complexes (précarité, exil, santé",
      "mentale). Six années à l'UCRM : pilotage de dispositifs innovants, animation de réseaux",
      "partenariaux sur le territoire toulousain. Créatrice autodidacte de deux applications métier.",
      "J'allie humanité et outils digitaux pour améliorer l'efficience des prises en charge et la",
      "continuité des soins.",
      "",
      "EXPÉRIENCE :",
      "- À partir de septembre 2026 — Infirmière de coordination, projet ACCSO, Forum réfugiés, Toulouse.",
      "  ACCompagnement aux SOins : accès aux soins et articulation des parcours de santé des personnes",
      "  exilées vulnérables et traumatisées. (CDD d'un mois renouvelable — je cherche un poste stable.)",
      "- Décembre 2022 à septembre 2026 — Coordinatrice, Programme de Convergence Médico-sociale,",
      "  UCRM Toulouse. Pilotage d'un dispositif innovant de fluidification des parcours de soins ;",
      "  coordination de l'habitat inclusif « La Demeure de l'Oasis » ; structuration du programme",
      "  convergence santé mentale/social ; animation du réseau institutionnel et associatif toulousain ;",
      "  conception et développement de deux applications déployées auprès des professionnels et patients.",
      "- 2020 à 2022 — Infirmière de coordination thérapeutique, UCRM Toulouse.",
      "  Coordination des soins pour publics en grande précarité ; interface ville-hôpital entre familles,",
      "  médecins et travailleurs sociaux ; gestion de crise et désamorçage de situations conflictuelles.",
      "",
      "FORMATION :",
      "- 2025 : Évaluation de la crise suicidaire (MSA Toulouse)",
      "- 2024 : Prise en charge du psycho-trauma lié à l'exil (Médecins du Monde)",
      "- 2022 : Communication assertive (Format Différence)",
      "- 2017 : Diplôme d'État Infirmier",
      "- BTS Secrétariat Trilingue — Baccalauréat B",
      "",
      "COMPÉTENCES : pilotage de projets complexes santé/social ; gestion de crise et évaluation des",
      "risques ; accompagnement de publics vulnérables (exil, trauma) ; communication assertive ;",
      "conception d'applications métier assistée par IA ; adaptabilité interculturelle.",
      "",
      "LANGUES : français (maternel), anglais (avancé), espagnol (notions). Permis B."
    ].join('\n'),

    // --- Recherche ---
    rayon: 25,
    publieeDepuis: 31,
    commune: '31555',
    minScore: 25,
    // Codes ROME : le référentiel officiel des métiers. Une recherche par code
    // attrape TOUTES les offres du métier, quelle que soit la formulation du
    // titre — bien plus large qu'un mot-clé, et sans perte de précision.
    codesRome: [
      { code: 'J1502', label: 'Coordination de services paramédicaux', actif: true },
      { code: 'J1506', label: 'Infirmier en soins généraux',            actif: true },
      { code: 'K1201', label: 'Action sociale',                          actif: true },
      { code: 'K1403', label: 'Management de structure santé/sociale',   actif: true },
      { code: 'M1402', label: 'Conseil en organisation',                 actif: false },
      { code: 'K1206', label: 'Intervention socioculturelle',            actif: false },
      { code: 'K2112', label: 'Orientation / insertion',                 actif: false }
    ],

    motsCles: [
      { q: 'infirmier coordination',       poids: 10 },
      { q: 'coordinateur parcours santé',  poids: 10 },
      { q: 'coordinateur médico-social',   poids: 9 },
      { q: 'infirmier précarité',          poids: 8 },
      { q: 'santé mentale coordination',   poids: 8 },
      { q: 'case manager santé',           poids: 8 },
      { q: 'habitat inclusif',             poids: 7 },
      { q: 'chef de projet santé',         poids: 7 },
      { q: 'chef de projet digital santé', poids: 7 },
      { q: 'développeur web no code',      poids: 6 }
    ],

    // --- Candidature ---
    cvDriveId: '',            // ID du fichier CV dans le Drive (pièce jointe)
    cvDriveNom: 'CV Sandra Mercier.pdf',
    signature: 'Sandra MERCIER\nInfirmière de coordination thérapeutique\n06 35 26 85 79 — franfran120374@gmail.com',
    envoiDirect: false,       // true = envoie sans écran de validation
    copieAMoi: true           // se mettre en Cci de chaque candidature
  };

  // =========================================================
  // 2. LECTURE / ÉCRITURE (même patron que tuile-tabac.js)
  // =========================================================

  function lireBloc() {
    try { return JSON.parse(localStorage.getItem('sync_' + CAT) || '{}'); }
    catch (e) { return {}; }
  }

  function sauver(cle, valeur) {
    if (typeof CloudSync !== 'undefined' && CloudSync.save) {
      try { CloudSync.save(CAT, cle, valeur); return; } catch (e) {}
    }
    try {
      const bloc = lireBloc();
      bloc[cle] = valeur;
      localStorage.setItem('sync_' + CAT, JSON.stringify(bloc));
    } catch (e) { console.warn('[Emploi] écriture KO', e); }
  }

  function lire() {
    const bloc = lireBloc();
    let brut = bloc[CLE_CFG] || null;
    if (!brut) { try { brut = JSON.parse(localStorage.getItem(LS_CFG) || 'null'); } catch (e) {} }
    return Object.assign({}, DEFAUT, brut || {});
  }

  function ecrire(cfg) {
    try { localStorage.setItem(LS_CFG, JSON.stringify(cfg)); } catch (e) {}
    sauver(CLE_CFG, cfg);
  }

  // Étapes du suivi d'une candidature, dans l'ordre chronologique
  const STATUTS = [
    { id: 'apostuler', label: 'À postuler',   emoji: '📌', cls: 'em-pill-orange' },
    { id: 'envoyee',   label: 'Envoyée',      emoji: '📤', cls: 'em-pill-bleu' },
    { id: 'relancee',  label: 'Relancée',     emoji: '🔔', cls: 'em-pill-bleu' },
    { id: 'reponse',   label: 'Réponse reçue',emoji: '📬', cls: 'em-pill-vert' },
    { id: 'entretien', label: 'Entretien',    emoji: '🤝', cls: 'em-pill-vert' },
    { id: 'refus',     label: 'Refus',        emoji: '❌', cls: 'em-pill-rouge' },
    { id: 'sansuite',  label: 'Sans réponse', emoji: '🕓', cls: 'em-pill-gris' }
  ];

  const JOURS_RELANCE = 12;

  function statutInfo(id) {
    return STATUTS.find(s => s.id === id) || STATUTS[1];
  }

  function joursDepuis(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return Math.floor((Date.now() - d.getTime()) / 86400000);
  }

  function aRelancer(c) {
    if (c.statut !== 'envoyee') return false;
    const j = joursDepuis(c.date);
    return j != null && j >= JOURS_RELANCE;
  }

  function lireCandidatures() {
    const v = lireBloc()[CLE_CAND];
    return Array.isArray(v) ? v : [];
  }

  function ecrireCandidatures(liste) {
    sauver(CLE_CAND, liste.slice(-120));
  }

  // --- Carnet d'adresses : un mail trouvé une fois est réutilisé ---
  function lireCarnet() {
    const v = lireBloc()[CLE_CARNET];
    return (v && typeof v === 'object') ? v : {};
  }

  function cleEntreprise(nom) {
    return sansAccentsSimple(nom).replace(/[^a-z0-9]+/g, '').slice(0, 40);
  }

  function sansAccentsSimple(s) {
    return String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  }

  function noterMail(entreprise, mail) {
    if (!entreprise || !mail || !mail.includes('@')) return;
    const c = lireCarnet();
    c[cleEntreprise(entreprise)] = { mail, nom: entreprise, date: new Date().toISOString() };
    sauver(CLE_CARNET, c);
  }

  function mailConnu(entreprise) {
    return lireCarnet()[cleEntreprise(entreprise)]?.mail || '';
  }

  function statutDe(id) { return statutInfo(id); }

  function enregistrerCandidature(infos) {
    const liste = lireCandidatures();
    liste.push(Object.assign({
      id: 'c' + Date.now(),
      date: new Date().toISOString(),
      statut: 'envoyee',
      notes: ''
    }, infos));
    ecrireCandidatures(liste);
    return liste[liste.length - 1];
  }

  function majCandidature(id, champs) {
    const liste = lireCandidatures().map(c => c.id === id ? Object.assign({}, c, champs) : c);
    ecrireCandidatures(liste);
  }

  function lireCache() {
    try { return JSON.parse(localStorage.getItem(LS_CACHE) || 'null'); }
    catch (e) { return null; }
  }

  function ecrireCache(data) {
    try { localStorage.setItem(LS_CACHE, JSON.stringify(data)); }
    catch (e) { console.warn('[Emploi] cache trop gros, ignoré'); }
  }

  function lireIgnorees() {
    try { return JSON.parse(localStorage.getItem(LS_IGNOR) || '[]'); }
    catch (e) { return []; }
  }

  function ignorer(id) {
    const l = lireIgnorees();
    if (!l.includes(id)) l.push(id);
    try { localStorage.setItem(LS_IGNOR, JSON.stringify(l.slice(-600))); } catch (e) {}
  }

  function restaurerIgnorees() {
    try { localStorage.removeItem(LS_IGNOR); } catch (e) {}
  }

  // =========================================================
  //  APPRENTISSAGE À PARTIR DES REFUS
  // =========================================================

  const MOTIFS = [
    { id: 'metier',   label: '🩺 Pas mon métier',      aide: "Le poste ne correspond pas à ce que je fais" },
    { id: 'public',   label: '👥 Public / structure',  aide: "Le type de public ou de structure ne me convient pas" },
    { id: 'horaires', label: '🌙 Horaires',            aide: "Nuit, week-ends, roulements" },
    { id: 'contrat',  label: '📄 Contrat',             aide: "Type ou durée de contrat" },
    { id: 'loin',     label: '🚗 Trop loin',           aide: "Pas accessible en vélo ou transports" },
    { id: 'autre',    label: '🤷 Autre raison',        aide: "Sans précision" }
  ];

  // Mots vides français : ils n'apprennent rien, on les jette.
  const VIDES = new Set(('le la les un une des du de des au aux et ou ni mais donc or car que qui quoi dont ou ' +
    'a as ai est sont etre suis sera seront ete avec sans pour par sur sous dans chez vers entre depuis pendant ' +
    'ce cet cette ces son sa ses leur leurs notre nos votre vos mon ma mes ton ta tes il elle ils elles nous vous ' +
    'je tu on se sy en y ne pas plus tres tout tous toute toutes meme aussi bien plusieurs autre autres ' +
    'poste emploi offre candidat candidate recherche recherchons recrute recrutons profil mission missions ' +
    'vous etes votre vos poste cdi cdd temps plein partiel heures semaine mois an ans annee ' +
    'travail travailler equipe service etablissement structure site lieu ville toulouse haute garonne ' +
    'competences experience formation diplome salaire remuneration selon convention collective ' +
    'sein cadre notre nos aupres afin ainsi lors dont sera etre faire assurer participer').split(/\s+/));

  // Mots du cœur de ton métier : jamais appris comme filtre, même s'ils
  // apparaissent dans des annonces refusées. Sans cette protection, refuser
  // 3 postes de nuit suffirait à pénaliser « soins » ou « coordination ».
  const PROTEGES_FIXES = ('soin soins sante santee infirmier infirmiere infirmiers coordination coordinateur ' +
    'coordinatrice parcours precarite precaire vulnerable vulnerables exil exiles migrant migrants asile ' +
    'mentale psychique psychiatrie addictologie social medico partenariat partenarial reseau inclusif ' +
    'habitat accompagnement patient patients usager usagers case management dispositif projet numerique ' +
    'application trauma psychotrauma interculturel prevention orientation liaison hopital ville').split(' ');

  function motsProteges() {
    const cfg = lire();
    const desMotsCles = (cfg.motsCles || [])
      .map(m => (m.q || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase())
      .join(' ').split(/[^a-z0-9]+/).filter(Boolean);
    return new Set(PROTEGES_FIXES.concat(desMotsCles));
  }

  function lireAppris() {
    try {
      const v = JSON.parse(localStorage.getItem(LS_APPRIS) || 'null');
      if (v && typeof v === 'object') {
        return Object.assign({ termes: {}, motifs: {}, contrats: {}, retires: [], refus: 0 }, v);
      }
    } catch (e) {}
    return { termes: {}, motifs: {}, contrats: {}, retires: [], refus: 0 };
  }

  function ecrireAppris(a) {
    try { localStorage.setItem(LS_APPRIS, JSON.stringify(a)); } catch (e) {}
  }

  function motsDeLOffre(o) {
    const brut = ((o.titre || '') + ' ' + (o.rome || '') + ' ' + (o.description || '').slice(0, 600));
    const propre = brut
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]+/g, ' ');
    const mots = propre.split(' ').filter(m => m.length >= 4 && m.length <= 22 && !VIDES.has(m) && !/^\d+$/.test(m));
    return [...new Set(mots)];
  }

  // Enregistre un refus et met à jour les compteurs
  function apprendreRefus(o, motif) {
    const a = lireAppris();
    a.refus = (a.refus || 0) + 1;
    a.motifs[motif] = (a.motifs[motif] || 0) + 1;

    // Le type de contrat compte à part : c'est un critère net
    if (motif === 'contrat' && o.contrat) {
      const c = o.contrat.split(' ')[0];
      a.contrats[c] = (a.contrats[c] || 0) + 1;
    }

    // Le vocabulaire n'est appris que pour les motifs qui parlent du contenu
    if (motif === 'metier' || motif === 'public' || motif === 'horaires') {
      const proteges = motsProteges();
      for (const m of motsDeLOffre(o)) {
        if (proteges.has(m)) continue;
        if (!a.termes[m]) a.termes[m] = { n: 0, motifs: {} };
        a.termes[m].n++;
        a.termes[m].motifs[motif] = (a.termes[m].motifs[motif] || 0) + 1;
      }
    }
    ecrireAppris(a);
  }

  // Un terme devient filtrant à partir de 3 refus, sauf si tu l'as retiré
  const SEUIL_APPRIS = 3;

  function termesFiltrants() {
    const a = lireAppris();
    const proteges = motsProteges();
    return Object.entries(a.termes)
      .filter(([m, d]) => d.n >= SEUIL_APPRIS && !a.retires.includes(m) && !proteges.has(m))
      .sort((x, y) => y[1].n - x[1].n)
      .map(([m, d]) => ({ mot: m, n: d.n, motif: Object.keys(d.motifs).sort((p, q) => d.motifs[q] - d.motifs[p])[0] }));
  }

  function contratsFiltrants() {
    const a = lireAppris();
    return Object.entries(a.contrats)
      .filter(([c, n]) => n >= SEUIL_APPRIS && !a.retires.includes('contrat:' + c))
      .map(([c, n]) => ({ contrat: c, n }));
  }

  // Malus appliqué à l'affichage, sans attendre une nouvelle recherche
  function malusAppris(o) {
    const filtrants = termesFiltrants();
    if (!filtrants.length && !contratsFiltrants().length) return { malus: 0, causes: [] };
    const mots = new Set(motsDeLOffre(o));
    const causes = [];
    let malus = 0;
    for (const f of filtrants) {
      if (mots.has(f.mot)) { malus += Math.min(12, 4 + f.n); causes.push(f.mot); }
    }
    for (const c of contratsFiltrants()) {
      if ((o.contrat || '').startsWith(c.contrat)) { malus += 10; causes.push(c.contrat); }
    }
    return { malus: Math.min(45, malus), causes: causes.slice(0, 4) };
  }

  function oublierTout() {
    try { localStorage.removeItem(LS_APPRIS); } catch (e) {}
  }

  function lireVues() {
    try { return JSON.parse(localStorage.getItem(LS_VUES) || '[]'); }
    catch (e) { return []; }
  }

  function marquerVues(ids) {
    try { localStorage.setItem(LS_VUES, JSON.stringify([...new Set(ids)].slice(-400))); }
    catch (e) {}
  }

  // =========================================================
  // 3. OUTILS
  // =========================================================

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Lit une réponse serveur en JSON. Si le serveur renvoie une page d'erreur
  // HTML (route absente, service endormi, 502...), on produit un message
  // compréhensible au lieu de laisser planter JSON.parse.
  async function jsonSafe(r, quoi) {
    const txt = await r.text();
    const debut = txt.trim().slice(0, 1).toLowerCase();
    if (debut === '<') {
      if (r.status === 404) {
        throw new Error(
          quoi + " : la route n'existe pas sur le serveur (404). " +
          "Le fichier emploi-routes.js n'est pas actif sur Render — " +
          "va dans Render > mon-bureau-backend > Manual Deploy."
        );
      }
      if (r.status === 502 || r.status === 503) {
        throw new Error(quoi + ' : le serveur redémarre (' + r.status + '). Réessaie dans une minute.');
      }
      throw new Error(quoi + ' : le serveur a répondu une page HTML (' + r.status + ') au lieu de données.');
    }
    try {
      return JSON.parse(txt);
    } catch (e) {
      throw new Error(quoi + ' : réponse illisible du serveur (' + r.status + ').');
    }
  }

  function tokensGoogle() {
    try {
      const c = JSON.parse(localStorage.getItem('googleAccounts') || '[]');
      return c[0]?.tokens || null;
    } catch (e) { return null; }
  }

  function entete(tokens) { return 'Bearer ' + btoa(JSON.stringify(tokens)); }

  // Le WebView du launcher Android bloque window.open() ET le clic
  // programmatique sur un lien, sans lever d'erreur. Le seul moyen fiable
  // est un vrai <a href> touché par l'utilisateur, ou une navigation
  // directe. On garde cette fonction pour les cas déclenchés par le code.
  const EST_WEBVIEW = /\bwv\b|; wv|Version\/[\d.]+ Chrome/i.test(navigator.userAgent || '');

  function ouvrirLien(url) {
    if (!url) return;
    if (!EST_WEBVIEW) {
      try {
        const w = window.open(url, '_blank', 'noopener');
        if (w) return;
      } catch (e) {}
    }
    // Navigation directe : fonctionne partout, y compris en WebView.
    // Le bouton retour d'Android ramène à Mon Bureau.
    try { window.location.href = url; }
    catch (e) { afficherLienSecours(url); }
  }

  // Barre de secours : si rien ne s'ouvre, l'adresse reste copiable.
  function afficherLienSecours(url) {
    let bar = document.getElementById('em-lien-secours');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'em-lien-secours';
      bar.style.cssText = 'position:fixed;left:10px;right:10px;bottom:12px;z-index:99999;' +
        'background:#111;color:#fff;padding:11px 13px;border-radius:12px;font-size:12px;' +
        'box-shadow:0 6px 20px rgba(0,0,0,0.4);line-height:1.5';
      document.body.appendChild(bar);
    }
    bar.innerHTML =
      '<div style="margin-bottom:7px">Le lien n\'a pas pu s\'ouvrir. Adresse à copier :</div>' +
      `<input readonly value="${esc(url)}" style="width:100%;padding:7px;border-radius:7px;` +
      'border:none;font-size:11px;box-sizing:border-box" onclick="this.select()">' +
      '<div style="text-align:right;margin-top:7px">' +
      '<button style="border:none;background:#444;color:#fff;padding:6px 12px;border-radius:7px" ' +
      'onclick="document.getElementById(\'em-lien-secours\').remove()">Fermer</button></div>';
  }

  function badgeVelo(v, mob) {
    if (mob && mob.libelle) {
      const cls = (mob.mode === 'velo') ? 'em-pill-vert'
                : (mob.mode === 'velo-marche') ? 'em-pill-vert'
                : (mob.mode === 'inconnu') ? 'em-pill-gris'
                : 'em-pill-orange';
      return `<span class="em-pill ${cls}">${esc(mob.emoji || '📍')} ${esc(mob.libelle)}</span>`;
    }
    if (!v) return '<span class="em-pill em-pill-gris">📍 hors zone Vélô</span>';
    if (v.metres <= 500)  return `<span class="em-pill em-pill-vert">🚲 ${v.metres} m — ${esc(v.station)}</span>`;
    if (v.metres <= 1000) return `<span class="em-pill em-pill-vert">🚲 ${v.metres} m</span>`;
    if (v.metres <= 2500) return `<span class="em-pill em-pill-orange">🚲 ${(v.metres / 1000).toFixed(1)} km</span>`;
    return '<span class="em-pill em-pill-gris">🚲 loin d\'une station</span>';
  }

  function couleurScore(s) {
    if (s >= 60) return 'em-score-haut';
    if (s >= 35) return 'em-score-moyen';
    return 'em-score-bas';
  }

  function ilYA(jours) {
    if (jours == null) return '';
    if (jours <= 0) return "aujourd'hui";
    if (jours === 1) return 'hier';
    if (jours < 31) return `il y a ${jours} j`;
    return `il y a ${Math.round(jours / 30)} mois`;
  }

  // =========================================================
  // 4. STYLES
  // =========================================================

  function injectStyles() {
    if (document.getElementById('emploi-styles')) return;
    const st = document.createElement('style');
    st.id = 'emploi-styles';
    st.textContent = `
      .em-top { position:sticky; top:0; z-index:40; display:flex; gap:8px; align-items:center;
                background:var(--bg,#fff); padding:8px 0 10px; margin:-4px 0 4px; }
      .em-home { flex:0 0 auto; display:flex; align-items:center; gap:6px;
                 padding:8px 13px; border-radius:999px; border:none; cursor:pointer;
                 background:rgba(99,102,241,0.14); color:#4f46e5;
                 font:inherit; font-size:12px; font-weight:800; }
      .em-home:active { transform:scale(0.97); }
      .em-bas { width:100%; margin-top:6px; padding:12px; border-radius:12px; border:none;
                cursor:pointer; font:inherit; font-size:13px; font-weight:800;
                background:rgba(120,120,140,0.13); color:var(--ink,#222); }
      .em-tabs { display:flex; gap:6px; margin-bottom:14px; overflow-x:auto; padding-bottom:2px; }
      .em-tab { flex:0 0 auto; padding:8px 13px; border-radius:999px; border:none;
                background:rgba(120,120,140,0.12); color:var(--ink-mid,#666);
                font:inherit; font-size:12px; font-weight:700; cursor:pointer; }
      .em-tab.actif { background:var(--accent,#6366f1); color:#fff; }
      .em-card { background:var(--bg-card,#fff); border-radius:14px; padding:13px 14px;
                 margin-bottom:11px; box-shadow:var(--shadow-sm,0 1px 4px rgba(0,0,0,0.07));
                 border-left:4px solid transparent; }
      .em-card.em-score-haut  { border-left-color:#16a34a; }
      .em-card.em-score-moyen { border-left-color:#f59e0b; }
      .em-card.em-score-bas   { border-left-color:#cbd5e1; }
      .em-titre { font-size:14px; font-weight:800; line-height:1.3; margin-bottom:3px; color:var(--ink,#111); }
      .em-entreprise { font-size:12px; color:var(--ink-mid,#666); margin-bottom:8px; }
      .em-pills { display:flex; flex-wrap:wrap; gap:5px; margin-bottom:9px; }
      .em-pill { font-size:10.5px; font-weight:700; padding:3px 8px; border-radius:999px;
                 background:rgba(120,120,140,0.12); color:var(--ink-mid,#555); }
      .em-pill-vert   { background:rgba(22,163,74,0.15); color:#15803d; }
      .em-pill-orange { background:rgba(245,158,11,0.18); color:#b45309; }
      .em-pill-gris   { background:rgba(120,120,140,0.12); color:var(--ink-mid,#666); }
      .em-pill-bleu   { background:rgba(99,102,241,0.15); color:#4f46e5; }
      .em-pill-rouge  { background:rgba(220,38,38,0.14); color:#b91c1c; }
      .em-score { float:right; font-size:11px; font-weight:900; padding:3px 9px; border-radius:999px;
                  background:rgba(99,102,241,0.14); color:#4f46e5; margin-left:8px; }
      .em-desc { font-size:12px; line-height:1.5; color:var(--ink-mid,#555); margin-bottom:10px;
                 max-height:60px; overflow:hidden; position:relative; }
      .em-desc.ouvert { max-height:none; }
      .em-actions { display:flex; gap:7px; flex-wrap:wrap; }
      .em-btn { flex:1; min-width:110px; padding:9px 10px; border-radius:10px; border:none;
                font:inherit; font-size:12px; font-weight:700; cursor:pointer;
                background:rgba(120,120,140,0.13); color:var(--ink,#222); }
      .em-btn-primaire { background:var(--accent,#6366f1); color:#fff; }
      .em-btn:active { transform:scale(0.98); }
      a.em-btn { display:block; text-decoration:none; text-align:center; box-sizing:border-box; }
      .em-field { margin-bottom:12px; }
      .em-field label { display:block; font-size:12px; font-weight:700; margin-bottom:5px; color:var(--ink,#222); }
      .em-field input, .em-field textarea, .em-field select {
        width:100%; padding:9px 11px; border-radius:10px; font:inherit; font-size:13px;
        border:1px solid rgba(120,120,140,0.28); background:var(--bg,#fff); color:var(--ink,#111);
        box-sizing:border-box;
      }
      .em-field textarea { min-height:110px; resize:vertical; line-height:1.5; }
      .em-hint { font-size:11px; color:var(--ink-mid,#777); line-height:1.45; margin-top:4px; }
      .em-etat { text-align:center; padding:26px 12px; font-size:13px; color:var(--ink-mid,#666); }
      .em-etape { display:flex; align-items:center; gap:9px; padding:8px 0; font-size:13px; }
      .em-etape .em-ico { width:22px; text-align:center; }
      .em-etape.attente { opacity:0.4; }
      .em-erreur { background:rgba(220,38,38,0.1); color:#b91c1c; padding:10px 12px;
                   border-radius:10px; font-size:12px; line-height:1.5; margin-bottom:12px; }
      .em-ok { background:rgba(22,163,74,0.12); color:#15803d; padding:10px 12px;
               border-radius:10px; font-size:12px; line-height:1.5; margin-bottom:12px; }
      .em-mot { display:flex; gap:6px; margin-bottom:6px; align-items:center; }
      .em-mot input[type=text] { flex:1; }
      .em-mot input[type=number] { width:62px; }
      .em-mot button { border:none; background:rgba(220,38,38,0.12); color:#b91c1c;
                       border-radius:8px; padding:7px 10px; cursor:pointer; font-weight:700; }
      .em-sep { height:1px; background:rgba(120,120,140,0.18); margin:16px 0; }
      .em-h { font-size:13px; font-weight:800; margin:0 0 9px; color:var(--ink,#111); }
    `;
    document.head.appendChild(st);
  }

  // =========================================================
  // 5. LA TUILE (auto-injectée dans <main>)
  // =========================================================

  function creerTuile() {
    if (document.querySelector('[data-app="emploi"]')) return;
    const main = document.querySelector('main');
    if (!main) return;

    const sec = document.createElement('section');
    sec.className = 'tile tile-emploi';
    sec.setAttribute('data-app', 'emploi');
    sec.setAttribute('role', 'button');
    sec.setAttribute('tabindex', '0');
    sec.innerHTML =
      '<div class="tile-header"><span class="tile-label">💼 Emploi</span></div>' +
      '<div class="tile-body">' +
        '<div style="font-size:40px;text-align:center;margin:10px 0 6px">💼</div>' +
        '<div id="em-tuile-info" style="text-align:center;font-size:13px;color:var(--ink-mid)">Offres ciblées</div>' +
        '<div id="em-tuile-top" style="text-align:center;font-size:11px;color:var(--ink-mid);margin-top:5px;line-height:1.35"></div>' +
      '</div>' +
      '<div class="tile-foot">Voir les offres →</div>';

    main.appendChild(sec);
  }

  function majTuile() {
    const info = document.getElementById('em-tuile-info');
    const top  = document.getElementById('em-tuile-top');
    if (!info) return;

    const cache = lireCache();
    if (!cache || !cache.offres || !cache.offres.length) {
      info.textContent = 'Offres ciblées';
      if (top) top.textContent = 'Appuie pour lancer la recherche';
      return;
    }

    const vues = lireVues();
    const ignorees = lireIgnorees();
    const actives = cache.offres.filter(o => !ignorees.includes(o.id));
    const nouvelles = actives.filter(o => !vues.includes(o.id)).length;
    const fortes = actives.filter(o => o.score >= 60).length;

    if (!actives.length) {
      info.textContent = 'Toutes les offres écartées';
      if (top) top.textContent = 'Relance une recherche';
      return;
    }

    info.innerHTML = `<strong style="font-size:19px">${actives.length}</strong> offres` +
      (nouvelles ? ` <span style="color:#16a34a;font-weight:700">· ${nouvelles} nouvelles</span>` : '');

    const relances = lireCandidatures().filter(c =>
      ['envoyee', 'apostuler'].includes(c.statut || 'envoyee') &&
      (joursDepuis(c.date) || 0) >= JOURS_RELANCE).length;

    if (top) {
      const meilleure = actives[0];
      if (relances) {
        top.innerHTML = `<span style="color:#b45309;font-weight:700">🔔 ${relances} relance(s) à faire</span><br>` +
                        (fortes ? `⭐ ${fortes} offres très ciblées` : '');
        return;
      }
      top.innerHTML = (fortes ? `⭐ ${fortes} très ciblées<br>` : '') +
        (meilleure ? esc(meilleure.titre).slice(0, 48) : '');
    }
  }

  // =========================================================
  // 6. APPELS RÉSEAU
  // =========================================================

  // Traduit une offre du backend vers le format utilisé par la tuile.
  function traduire(o) {
    const m = o.mobilite || null;
    return {
      id: o.id,
      titre: o.intitule || 'Sans titre',
      entreprise: o.entreprise || 'Employeur non précisé',
      entrepriseUrl: o.entrepriseUrl || null,
      lieu: o.ville || '',
      codePostal: o.codePostal || '',
      lat: o.lat, lon: o.lon,
      contrat: o.contratLibelle || o.typeContrat || '',
      duree: o.duree || '',
      experience: o.experience || '',
      salaire: o.salaire || '',
      secteur: o.secteur || '',
      date: o.dateCreation || '',
      jours: (o.joursDepuis != null ? o.joursDepuis : null),
      description: o.descriptionComplete || o.description || '',
      rome: o.romeLibelle || '',
      urlOffre: o.url || '',
      contact: o.contact || {},
      score: o.score || 0,
      raisons: o.raisons || [],
      mobilite: m,
      velo: (m && m.metresStation != null)
        ? { station: m.station, metres: m.metresStation }
        : null
    };
  }

  async function chargerOffres() {
    const cfg = lire();

    const commune = cfg.commune || '31555';
    const distance = cfg.rayon || 25;

    // Les codes ROME d'abord : ils ramènent le gros du volume.
    const requetes = (cfg.codesRome || [])
      .filter(c => c.actif)
      .map(c => ({ codeROME: c.code, commune, distance }));

    // Puis les mots-clés, pour ce que le ROME ne couvre pas (santé numérique...).
    for (const m of (cfg.motsCles || [])) {
      if (requetes.length >= 12) break;
      if (m.q) requetes.push({ motsCles: m.q, commune, distance });
    }

    const body = {
      requetes,
      rayonKm: cfg.rayon || 25,
      motsExclus: termesFiltrants().slice(0, 25).map(f => f.mot),
      publieeDepuis: cfg.publieeDepuis || 31,
      scoreMini: cfg.minScore || 25
    };

    const r = await fetch(`${BACKEND}/emploi/offres`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const j = await jsonSafe(r, 'Recherche des offres');
    if (!j.success) throw new Error(j.error || 'Recherche impossible');

    const offres = (j.offres || []).map(traduire);
    ecrireCache({
      offres,
      majAt: j.genereLe || new Date().toISOString(),
      total: j.total,
      erreurs: j.erreurs || null
    });
    majTuile();
    return { total: offres.length, brut: j.total, erreurs: j.erreurs };
  }

  // Marqueurs qui trahissent une réponse d'erreur déguisée en texte.
  const SIGNES_ERREUR = [
    'rate limit', 'error from provider', 'erreur ia', '⚠️', 'quota',
    'try again later', 'service unavailable', 'timeout', 'overloaded',
    'invalid api key', 'unauthorized', 'internal server error'
  ];

  function lettreValide(txt) {
    if (!txt) return false;
    const bas = txt.toLowerCase();
    for (const s of SIGNES_ERREUR) if (bas.includes(s)) return false;
    if (txt.length < 500) return false;                       // trop court = raté
    if (!/madame|monsieur/i.test(txt.slice(0, 200))) return false;
    return true;
  }

  function attendre(ms) { return new Promise(r => setTimeout(r, ms)); }

  function consignesLettre(cfg, offre) {
    return [
      "Tu écris une lettre de motivation en français, à la première personne, pour une candidate réelle.",
      "Elle sera lue par un recruteur du secteur santé/médico-social qui en lit des dizaines par semaine.",
      "",
      "LONGUEUR : 300 à 360 mots. Quatre paragraphes courts, puis une formule de politesse. Rien d'autre.",
      "",
      "STRUCTURE :",
      "1. Ouvre sur un besoin PRÉCIS que l'annonce exprime, reformulé avec tes mots. Nomme la structure.",
      "   Pas de phrase d'accroche générique sur son intérêt pour le poste.",
      "2. Relie UNE expérience datée et concrète du CV à ce besoin. Des faits vérifiables :",
      "   ce qu'elle a piloté, avec qui, pour quel public, avec quel résultat observable.",
      "3. Une seconde compétence, différente de la première, qui répond à un autre point de l'annonce.",
      "   Si l'annonce touche au numérique, à la coordination d'outils ou aux process, mentionne",
      "   les applications qu'elle a conçues — sans en faire un argument principal si ce n'est pas demandé.",
      "4. Ce qu'elle veut apporter à CETTE structure. Termine par sa disponibilité.",
      "",
      "INTERDICTIONS ABSOLUES — ces formules disqualifient immédiatement une lettre :",
      "- « Fort(e) de mon expérience », « C'est avec un vif intérêt », « Je me permets de »,",
      "  « dynamique et motivée », « riche de », « n'hésitez pas à me contacter »,",
      "  « Je serais ravie de », « au sein de votre prestigieuse structure », « votre renommée »,",
      "  « je suis convaincue que mon profil », « polyvalente et rigoureuse », « à l'écoute et bienveillante ».",
      "- Les énumérations de trois adjectifs. Les listes à puces. Les titres de section.",
      "- Les tirets cadratins : un seul dans toute la lettre, au maximum.",
      "- Les phrases toutes de la même longueur : alterne des phrases courtes et des phrases longues.",
      "- Toute qualité affirmée sans preuve. Si tu écris qu'elle est rigoureuse, montre-le par un fait.",
      "- Les superlatifs et le vocabulaire promotionnel.",
      "",
      "TON : professionnel, direct, chaleureux sans familiarité. Elle a 25 ans de vie active,",
      "elle n'a rien à prouver et ne quémande pas. Elle expose ce qu'elle sait faire.",
      "",
      "N'INVENTE RIEN. Aucune expérience, aucun chiffre, aucune formation absents du CV.",
      "Si l'annonce demande une compétence qu'elle n'a pas, ne mens pas : ne l'aborde pas.",
      "",
      "SORTIE : uniquement le corps de la lettre, de « Madame, Monsieur, » à la formule de politesse",
      "incluse. Pas d'en-tête, pas d'adresse, pas d'objet, pas de signature, pas de commentaire."
    ].join('\n');
  }

  async function genererLettre(offre, onEtat) {
    const cfg = lire();
    const system = consignesLettre(cfg, offre);

    const user =
      "=== CV DE LA CANDIDATE ===\n" + cfg.cv + "\n\n" +
      "=== ANNONCE À LAQUELLE ELLE RÉPOND ===\n" +
      "Intitulé   : " + (offre.titre || '') + "\n" +
      "Structure  : " + (offre.entreprise || '') + "\n" +
      (offre.secteur ? "Secteur    : " + offre.secteur + "\n" : '') +
      "Lieu       : " + (offre.lieu || '') + "\n" +
      "Contrat    : " + (offre.contrat || '') + (offre.duree ? ' — ' + offre.duree : '') + "\n" +
      (offre.experience ? "Expérience : " + offre.experience + "\n" : '') +
      (offre.salaire ? "Salaire    : " + offre.salaire + "\n" : '') +
      "\nTexte intégral de l'annonce :\n" + (offre.description || '').slice(0, 4500) + "\n\n" +
      "Rédige la lettre en suivant les consignes à la lettre.";

    const DELAIS = [0, 12000, 30000];   // 3 tentatives, espacées
    let derniere = '';
    let derniereSource = '';
    infosLettre = null;

    for (let i = 0; i < DELAIS.length; i++) {
      if (DELAIS[i]) {
        if (onEtat) onEtat(`Serveur IA saturé, nouvelle tentative dans ${DELAIS[i] / 1000} s…`);
        await attendre(DELAIS[i]);
      }
      if (onEtat && i > 0) onEtat(`Rédaction de la lettre (tentative ${i + 1}/3)…`);

      let texte = '';
      try {
        // Route dédiée : elle essaie plusieurs fournisseurs IA et ne renvoie
        // jamais une erreur déguisée en lettre.
        const r = await fetch(`${BACKEND}/emploi/lettre`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system,
            prompt: user,
            cv: cfg.cv,
            annonce: "Intitulé : " + (offre.titre || '') +
                     "\nStructure : " + (offre.entreprise || '') +
                     "\nContrat : " + (offre.contrat || '') +
                     "\n\n" + (offre.description || '').slice(0, 4500)
          })
        });
        const j = await jsonSafe(r, 'Rédaction de la lettre');
        if (j.success && j.lettre) {
          texte = j.lettre;
          derniereSource = j.fournisseur || '';
          infosLettre = {
            relu: !!j.relu,
            correcteur: j.correcteur || '',
            alertes: j.alertes || [],
            mots: j.mots || 0,
            correspondances: j.correspondances || [],
            atouts: j.atouts || []
          };
        } else {
          derniere = j.error || (j.essais && j.essais.length ? j.essais[0] : 'échec');
        }
      } catch (e1) {
        // Secours : l'ancienne route, au cas où le module lettre ne serait
        // pas encore déployé sur Render.
        try {
          const r2 = await fetch(`${BACKEND}/agents/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ system, messages: [{ role: 'user', content: user }] })
          });
          const j2 = await jsonSafe(r2, 'Rédaction de la lettre');
          if (Array.isArray(j2.content))          texte = j2.content.map(b => b.text || '').join('\n').trim();
          else if (typeof j2.content === 'string') texte = j2.content.trim();
          else if (j2.text)                        texte = String(j2.text).trim();
        } catch (e2) {
          derniere = e1.message;
          continue;
        }
      }

      if (lettreValide(texte)) {
        if (derniereSource) console.log('[Emploi] lettre rédigée par', derniereSource);
        return nettoyerLettre(texte);
      }
      derniere = texte.slice(0, 160) || 'réponse vide';
    }

    throw new Error(
      /absentes de ton CV|ACTES|sigles|chiffres/i.test(derniere)
        ? derniere
        : "Le service IA n'a pas réussi à écrire la lettre après 3 tentatives. " +
          "Dernière réponse : « " + derniere + " ». " +
          "C'est une saturation temporaire : réessaie dans deux ou trois minutes."
    );
  }

  // Dernier filet : retire ce que les modèles ajoutent parfois malgré la consigne.
  function nettoyerLettre(txt) {
    let s = txt.trim();
    s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '');
    s = s.replace(/^(Objet|Sujet)\s*:.*$/gim, '');
    s = s.replace(/^(Voici|Bien s[uû]r).{0,80}:\s*$/gim, '');
    s = s.replace(/\n{3,}/g, '\n\n');
    // Coupe une éventuelle signature ajoutée d'office
    s = s.replace(/\n+(Sandra MERCIER|Sandra Mercier)\s*$/,'');
    return s.trim();
  }

  async function sauverDansDrive(offre, lettre) {
    const tokens = tokensGoogle();
    if (!tokens) throw new Error('Google non connecté (tuile Drive)');

    const auth = entete(tokens);

    // Dossier principal
    let r = await fetch(`${BACKEND}/drive/search-folder?name=${encodeURIComponent(DOSSIER_DRIVE)}`,
      { headers: { Authorization: auth } });
    let j = await jsonSafe(r, 'Recherche du dossier Drive');
    let dossierId = j.folder?.id;

    if (!dossierId) {
      r = await fetch(`${BACKEND}/drive/create-folder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ folderName: DOSSIER_DRIVE })
      });
      j = await jsonSafe(r, 'Création du dossier Drive');
      dossierId = j.folder?.id;
    }
    if (!dossierId) throw new Error('Impossible de créer le dossier Drive');

    const date = new Date().toISOString().slice(0, 10);
    const titre = `${date} — ${offre.entreprise} — ${offre.titre}`.slice(0, 120).replace(/[\\/:*?"<>|]/g, '-');

    const contenu =
      `LETTRE DE MOTIVATION\n` +
      `====================\n\n` +
      `Poste      : ${offre.titre}\n` +
      `Structure  : ${offre.entreprise}\n` +
      `Lieu       : ${offre.lieu}\n` +
      `Contrat    : ${offre.contrat}\n` +
      `Annonce    : ${offre.urlOffre}\n` +
      `Rédigée le : ${new Date().toLocaleString('fr-FR')}\n\n` +
      `--------------------------------------------------\n\n` +
      lettre + '\n';

    const dr = await fetch(`${BACKEND}/drive/create-doc-in-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: auth },
      body: JSON.stringify({ title: titre, content: contenu, folderId: dossierId })
    });
    const dj = await jsonSafe(dr, 'Sauvegarde Drive');
    if (!dj.success) throw new Error(dj.error || 'Sauvegarde Drive échouée');

    return { docId: dj.docId, lien: dj.webViewLink, titre };
  }

  async function trouverMail(offre) {
    const r = await fetch(`${BACKEND}/emploi/email-recruteur`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        offreId: offre.id,
        entreprise: offre.entreprise || '',
        siteWeb: offre.entrepriseUrl || ''
      })
    });
    const j = await jsonSafe(r, 'Recherche du mail recruteur');
    return {
      success: !!j.email,
      mail: j.email || '',
      source: j.source || '',
      autres: j.candidats || [],
      repli: j.urlPostulation || offre.urlOffre || null,
      nomContact: j.nomContact || ''
    };
  }

  async function envoyerMail({ a, sujet, corps, cc }) {
    const cfg = lire();
    const tokens = tokensGoogle();
    if (!tokens) throw new Error('Google non connecté');

    const r = await fetch(`${BACKEND}/emploi/gmail-send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: entete(tokens) },
      body: JSON.stringify({
        to: a,
        cc: cc || '',
        sujet: sujet,
        texte: corps,
        driveFileIds: cfg.cvDriveId ? [cfg.cvDriveId] : []
      })
    });
    const j = await jsonSafe(r, 'Envoi du mail');
    if (!j.success) {
      if (j.besoinReconnexion) {
        throw new Error((j.conseil || j.error) +
          ' — bouton « Reconnecter Google » dans l\'onglet Réglages.');
      }
      throw new Error(j.error || 'Envoi impossible');
    }
    if (j.tokens) {
      try {
        const c = JSON.parse(localStorage.getItem('googleAccounts') || '[]');
        if (c[0]) { c[0].tokens = j.tokens; localStorage.setItem('googleAccounts', JSON.stringify(c)); }
      } catch (e) {}
    }
    return { pieces: j.piecesJointes || [] };
  }

  // =========================================================
  // 7. ÉTAT DU PANNEAU
  // =========================================================

  let onglet = 'offres';
  let enCours = false;
  let message = null;          // { type:'ok'|'err', texte:'' }
  let brouillon = null;        // écran de validation avant envoi
  let detail = null;           // id de l'offre lue en plein écran
  let infosLettre = null;      // qualité de la dernière lettre générée
  let motifPour = null;        // id de l'offre dont on demande le motif de refus

  function reouvrir() {
    if (typeof window.openSheet === 'function') {
      window.openSheet('💼 Recherche d\'emploi', rendrePanneau(), brancherPanneau);
    }
  }

  // =========================================================
  // 8. RENDU
  // =========================================================

  function rendrePanneau() {
    if (brouillon) return rendreBrouillon();
    if (detail) return rendreDetail();

    let html = '<div class="em-top"><button class="em-home" data-home="1">🏠 Mon Bureau</button></div>';

    html += '<div class="em-tabs">' +
      ['offres|📋 Offres', 'candidatures|📨 Candidatures', 'profil|👤 Mon profil', 'reglages|⚙️ Réglages']
        .map(x => {
          const [id, label] = x.split('|');
          return `<button class="em-tab${onglet === id ? ' actif' : ''}" data-tab="${id}">${label}</button>`;
        }).join('') +
      '</div>';

    if (message) {
      html += `<div class="${message.type === 'ok' ? 'em-ok' : 'em-erreur'}">${message.texte}</div>`;
    }

    if (onglet === 'offres')            html += rendreOffres();
    else if (onglet === 'candidatures') html += rendreCandidatures();
    else if (onglet === 'profil')       html += rendreProfil();
    else                                html += rendreReglages();

    html += '<div class="em-sep"></div>' +
            '<button class="em-bas" data-home="1">🏠 Retour à Mon Bureau</button>';

    return html;
  }

  function rendreOffres() {
    const cache = lireCache();
    let html = '<button class="em-btn em-btn-primaire" id="emRefresh" style="width:100%;margin-bottom:14px">' +
               (enCours ? '⏳ Recherche en cours… (30 à 60 s)' : '🔄 Chercher les offres') + '</button>';

    if (!cache || !cache.offres || !cache.offres.length) {
      let derniereErr = '';
      try { derniereErr = localStorage.getItem('mb_emploi_dernier_err') || ''; } catch (e) {}
      html += '<div class="em-etat">Aucune offre en mémoire.<br>Appuie sur « Chercher les offres ».</div>';
      if (derniereErr) {
        html += `<div class="em-erreur"><b>Dernière erreur :</b><br>${esc(derniereErr)}</div>`;
      }
      html += '<button class="em-btn" id="emDiagRapide" style="width:100%">🩺 Tester la connexion au serveur</button>' +
              '<div id="emDiagOut" style="margin-top:12px"></div>';
      return html;
    }

    const vues = lireVues();
    const candIds = lireCandidatures().map(c => c.offreId);
    const ignorees = lireIgnorees();
    const visibles = cache.offres
      .filter(o => !ignorees.includes(o.id))
      .map(o => {
        const m = malusAppris(o);
        return Object.assign({}, o, {
          scoreAffiche: Math.max(0, o.score - m.malus),
          malusAppris: m.malus,
          causesAppris: m.causes
        });
      })
      .sort((a, b) => b.scoreAffiche - a.scoreAffiche);
    const nbMasquees = cache.offres.length - visibles.length;

    html += `<div class="em-hint" style="margin-bottom:12px">` +
            `${visibles.length} offres · mise à jour ${new Date(cache.majAt).toLocaleString('fr-FR')}` +
            `${cache.stationsVelo ? ' · ' + cache.stationsVelo + ' stations Vélô comparées' : ''}` +
            `${nbMasquees ? ' · <b>' + nbMasquees + ' écartée(s)</b>' : ''}</div>`;

    if (nbMasquees) {
      html += '<button class="em-btn" id="emRestaurer" style="width:100%;margin-bottom:14px">' +
              `↩️ Réafficher les ${nbMasquees} offre(s) écartée(s)</button>`;
    }

    if (!visibles.length) {
      html += '<div class="em-etat">Toutes les offres ont été écartées.<br>' +
              'Utilise le bouton ci-dessus pour les réafficher, ou relance une recherche.</div>';
      return html;
    }

    visibles.forEach(o => {
      const dejaPostule = candIds.includes(o.id);
      html +=
        `<div class="em-card ${couleurScore(o.score)}" data-offre="${esc(o.id)}">` +
          `<span class="em-score">${o.scoreAffiche != null ? o.scoreAffiche : o.score}</span>` +
          `<div class="em-titre">${!vues.includes(o.id) ? '🟢 ' : ''}${esc(o.titre)}</div>` +
          `<div class="em-entreprise">${esc(o.entreprise)} — ${esc(o.lieu)}</div>` +
          `<div class="em-pills">` +
            badgeVelo(o.velo, o.mobilite) +
            (o.contrat ? `<span class="em-pill em-pill-bleu">${esc(o.contrat)}</span>` : '') +
            (o.salaire ? `<span class="em-pill">${esc(o.salaire.slice(0, 32))}</span>` : '') +
            (o.jours != null ? `<span class="em-pill">${ilYA(o.jours)}</span>` : '') +
            (dejaPostule ? '<span class="em-pill em-pill-vert">✅ Candidature envoyée</span>' : '') +
            (o.malusAppris ? `<span class="em-pill em-pill-rouge" title="Ressemble à ce que tu refuses">🧠 −${o.malusAppris} : ${esc(o.causesAppris.join(', '))}</span>` : '') +
          `</div>` +
          `<div class="em-desc" data-desc="${esc(o.id)}">${esc((o.description || '').slice(0, 700))}</div>` +
          `<div class="em-actions">` +
            (motifPour === o.id
              ? '<div style="width:100%">' +
                  '<div class="em-hint" style="margin:2px 0 7px"><b>Pourquoi tu l\'écartes ?</b> ' +
                  'Ça me sert à filtrer les suivantes.</div>' +
                  '<div style="display:flex;flex-wrap:wrap;gap:6px">' +
                  MOTIFS.map(m => `<button class="em-btn" style="flex:0 1 auto;min-width:0;font-size:11px;padding:7px 10px" data-motif="${m.id}" data-motif-offre="${esc(o.id)}">${m.label}</button>`).join('') +
                  `<button class="em-btn" style="flex:0 1 auto;min-width:0;font-size:11px;padding:7px 10px" data-motif-annule="1">Annuler</button>` +
                  '</div></div>'
              : `<button class="em-btn" data-plus="${esc(o.id)}">📖 Détail</button>` +
                `<a class="em-btn" href="${esc(o.urlOffre)}" target="_blank" rel="noopener" ` +
              `style="text-decoration:none;text-align:center;line-height:1.6">🔗 L'annonce</a>` +
                `<button class="em-btn" data-ignorer="${esc(o.id)}" title="Masquer cette offre">🚫 Pas pour moi</button>` +
                `<button class="em-btn em-btn-primaire" data-postuler="${esc(o.id)}">` +
                  (dejaPostule ? '↻ Repostuler' : '✍️ Postuler') +
                `</button>`) +
          `</div>` +
        `</div>`;
    });

    return html;
  }

  function rendreDetail() {
    const o = offreParId(detail);
    if (!o) { detail = null; return rendreOffres(); }

    const candIds = lireCandidatures().map(c => c.offreId);
    const dejaPostule = candIds.includes(o.id);

    // La description arrive en texte brut avec des retours a la ligne :
    // on les convertit en HTML apres echappement, sinon tout s'affiche en pave.
    const corps = esc(o.description || 'Pas de descriptif fourni par l\'annonce.')
      .replace(/\r\n/g, '\n')
      .replace(/\n{2,}/g, '</p><p>')
      .replace(/\n/g, '<br>');

    let html = '<div class="em-top">' +
                 '<button class="em-home" id="emRetourListe">← Les offres</button>' +
                 '<button class="em-home" data-home="1">🏠 Mon Bureau</button>' +
               '</div>';

    html +=
      `<div class="em-card ${couleurScore(o.score)}">` +
        `<span class="em-score">${o.score}</span>` +
        `<div class="em-titre" style="font-size:16px">${esc(o.titre)}</div>` +
        `<div class="em-entreprise">${esc(o.entreprise)} — ${esc(o.lieu)}</div>` +
        `<div class="em-pills">` +
          badgeVelo(o.velo, o.mobilite) +
          (o.contrat    ? `<span class="em-pill em-pill-bleu">${esc(o.contrat)}</span>` : '') +
          (o.duree      ? `<span class="em-pill">${esc(o.duree)}</span>` : '') +
          (o.salaire    ? `<span class="em-pill">${esc(o.salaire)}</span>` : '') +
          (o.experience ? `<span class="em-pill">${esc(o.experience)}</span>` : '') +
          (o.jours != null ? `<span class="em-pill">${ilYA(o.jours)}</span>` : '') +
          (dejaPostule  ? '<span class="em-pill em-pill-vert">✅ Candidature envoyée</span>' : '') +
        `</div>` +
      `</div>`;

    if (o.raisons && o.raisons.length) {
      html += `<div class="em-card"><div class="em-h">Pourquoi cette offre remonte</div>` +
              '<ul style="margin:0 0 0 16px;padding:0;font-size:12px;line-height:1.6">' +
              o.raisons.map(r => `<li>${esc(r)}</li>`).join('') +
              (o.motCle ? `<li>Trouvée via « ${esc(o.motCle)} »</li>` : '') +
              '</ul></div>';
    }

    html += `<div class="em-card"><div class="em-h">L'annonce complète</div>` +
            `<div class="em-lecture"><p>${corps}</p></div></div>`;

    if (o.contact && (o.contact.nom || o.contact.courriel || o.contact.telephone)) {
      html += `<div class="em-card"><div class="em-h">Contact indiqué</div>` +
              '<div style="font-size:12px;line-height:1.7">' +
              (o.contact.nom       ? esc(o.contact.nom) + '<br>' : '') +
              (o.contact.courriel  ? '✉️ ' + esc(o.contact.courriel) + '<br>' : '') +
              (o.contact.telephone ? '📞 ' + esc(o.contact.telephone) : '') +
              '</div></div>';
    }

    html += '<div class="em-actions">' +
              `<a class="em-btn" href="${esc(o.urlOffre)}" target="_blank" rel="noopener" ` +
                `style="text-decoration:none;text-align:center;line-height:1.6">🔗 Voir sur le site</a>` +
              `<button class="em-btn" data-ignorer="${esc(o.id)}">🚫 Pas pour moi</button>` +
              `<button class="em-btn em-btn-primaire" data-postuler="${esc(o.id)}">` +
                (dejaPostule ? '↻ Repostuler' : '✍️ Postuler') + '</button>' +
            '</div>' +
            '<div class="em-sep"></div>' +
            '<button class="em-bas" data-home="1">🏠 Retour à Mon Bureau</button>';

    return html;
  }

  function rendreCandidatures() {
    const liste = lireCandidatures().slice().reverse();

    let html = '<button class="em-btn" id="emAjoutCand" style="width:100%;margin-bottom:12px">' +
               '➕ Ajouter une candidature faite ailleurs</button>';

    if (!html || !liste.length) {
      return html + '<div class="em-etat">Aucune candidature enregistrée.<br>' +
             'Chaque envoi apparaîtra ici avec sa date, son statut et un rappel de relance.</div>';
    }

    // Compteurs par statut
    const parStatut = {};
    liste.forEach(c => { parStatut[c.statut || 'envoyee'] = (parStatut[c.statut || 'envoyee'] || 0) + 1; });
    html += '<div class="em-pills" style="margin-bottom:12px">' +
            `<span class="em-pill em-pill-bleu"><b>${liste.length}</b> au total</span>` +
            STATUTS.filter(s => parStatut[s.id])
              .map(s => `<span class="em-pill ${s.cls}">${s.emoji} ${s.label} ${parStatut[s.id]}</span>`).join('') +
            '</div>';

    // À relancer en priorité
    const aRelancer = liste.filter(c => {
      const j = joursDepuis(c.date);
      return j !== null && j >= JOURS_RELANCE &&
             ['envoyee', 'apostuler'].includes(c.statut || 'envoyee');
    });
    if (aRelancer.length) {
      html += `<div class="em-ok" style="margin-bottom:12px"><b>🔔 ${aRelancer.length} relance(s) à faire</b><br>` +
              `Ces candidatures ont plus de ${JOURS_RELANCE} jours et sont restées sans réponse. ` +
              `Une relance courte fait souvent la différence.</div>`;
    }

    liste.forEach(c => {
      const st = statutDe(c.statut || 'envoyee');
      const j = joursDepuis(c.date);
      const dateFr = new Date(c.date).toLocaleDateString('fr-FR', {
        day: '2-digit', month: 'short', year: 'numeric'
      });
      const relancable = j !== null && j >= JOURS_RELANCE && ['envoyee', 'apostuler'].includes(c.statut || 'envoyee');

      html += `<div class="em-card ${relancable ? 'em-score-moyen' : 'em-score-bas'}">` +
        `<div class="em-titre">${esc(c.titre || 'Candidature')}</div>` +
        `<div class="em-entreprise">${esc(c.entreprise || '')}</div>` +
        `<div class="em-pills">` +
          `<span class="em-pill ${st.cls}">${st.emoji} ${st.label}</span>` +
          `<span class="em-pill">📅 ${dateFr}</span>` +
          (j !== null ? `<span class="em-pill${relancable ? ' em-pill-orange' : ''}">${
            j === 0 ? "aujourd'hui" : 'il y a ' + j + ' j'}</span>` : '') +
          (c.mail ? `<span class="em-pill">✉️ ${esc(c.mail)}</span>` : '') +
          (c.relanceLe ? `<span class="em-pill em-pill-orange">🔔 relancée le ${
            new Date(c.relanceLe).toLocaleDateString('fr-FR')}</span>` : '') +
        `</div>` +
        (c.notes ? `<div class="em-hint" style="margin-bottom:8px">📝 ${esc(c.notes)}</div>` : '') +
        `<div class="em-actions" style="margin-bottom:6px">` +
          (c.driveLien ? `<a class="em-btn" href="${esc(c.driveLien)}" target="_blank" rel="noopener" ` +
             `style="text-decoration:none;text-align:center;line-height:1.6">📄 La lettre</a>` : '') +
          (c.urlOffre ? `<a class="em-btn" href="${esc(c.urlOffre)}" target="_blank" rel="noopener" ` +
             `style="text-decoration:none;text-align:center;line-height:1.6">🔗 L'annonce</a>` : '') +
          (relancable && c.mail ? `<button class="em-btn em-btn-primaire" data-relancer="${esc(c.id)}">🔔 Relancer</button>` : '') +
        `</div>` +
        `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:6px">` +
          STATUTS.filter(s => s.id !== (c.statut || 'envoyee')).map(s =>
            `<button class="em-btn" style="flex:0 1 auto;min-width:0;font-size:10.5px;padding:6px 9px" ` +
            `data-statut="${s.id}" data-cand="${esc(c.id)}">${s.emoji} ${s.label}</button>`).join('') +
        `</div>` +
        `<div class="em-actions">` +
          `<button class="em-btn" style="font-size:11px" data-note="${esc(c.id)}">📝 Note</button>` +
          `<button class="em-btn" style="font-size:11px" data-suppr-cand="${esc(c.id)}">🗑️ Supprimer</button>` +
        `</div>` +
      `</div>`;
    });

    return html;
  }

  function rendreProfil() {
    const c = lire();
    return '' +
      '<div class="em-h">Identité</div>' +
      `<div class="em-field"><label for="emNom">Nom affiché dans les mails</label>` +
        `<input type="text" id="emNom" value="${esc(c.nom)}"></div>` +
      `<div class="em-field"><label for="emTel">Téléphone</label>` +
        `<input type="text" id="emTel" value="${esc(c.telephone)}"></div>` +
      `<div class="em-field"><label for="emSign">Signature ajoutée en bas de chaque mail</label>` +
        `<textarea id="emSign" style="min-height:80px">${esc(c.signature)}</textarea></div>` +

      '<div class="em-sep"></div>' +
      '<div class="em-h">CV utilisé pour écrire les lettres</div>' +
      `<div class="em-field"><textarea id="emCv" style="min-height:260px">${esc(c.cv)}</textarea>` +
        `<div class="em-hint">C'est ce texte que l'IA lit pour rédiger. Plus il est précis, ` +
        `plus les lettres seront justes. Mets-le à jour à chaque nouvelle expérience.</div></div>` +

      '<div class="em-sep"></div>' +
      '<div class="em-h">CV en pièce jointe</div>' +
      `<div class="em-field"><label for="emCvId">ID du fichier CV dans ton Drive</label>` +
        `<input type="text" id="emCvId" value="${esc(c.cvDriveId)}" placeholder="1AbC...xyz">` +
        `<div class="em-hint">Ouvre ton CV dans Google Drive : l'adresse ressemble à ` +
        `drive.google.com/file/d/<b>1AbC...xyz</b>/view. Colle la partie en gras ici. ` +
        `Sans ça, le mail partira sans CV joint.</div></div>` +
      `<div class="em-field"><label for="emCvNom">Nom du fichier joint</label>` +
        `<input type="text" id="emCvNom" value="${esc(c.cvDriveNom)}"></div>` +

      '<button class="em-btn em-btn-primaire" id="emSaveProfil" style="width:100%">💾 Enregistrer le profil</button>';
  }

  function rendreReglages() {
    const c = lire();
    let html = '' +
      '<div class="em-h">Zone de recherche</div>' +
      `<div class="em-field"><label for="emCommune">Code INSEE de la commune centre</label>` +
        `<input type="text" id="emCommune" value="${esc(c.commune)}">` +
        `<div class="em-hint">31555 = Toulouse. Laisse tel quel sauf si tu déménages.</div></div>` +
      `<div class="em-field"><label for="emRayon">Rayon de recherche (km)</label>` +
        `<input type="number" id="emRayon" min="5" max="60" value="${c.rayon}">` +
        `<div class="em-hint">Le rayon élargit la pêche ; le score, lui, fait remonter en premier ` +
        `ce qui est près d'une station VélôToulouse.</div></div>` +
      `<div class="em-field"><label for="emMinScore">Score minimum affiché</label>` +
        `<input type="number" id="emMinScore" min="0" max="90" value="${c.minScore}">` +
        `<div class="em-hint">25 = large. 45 = seulement les offres bien ciblées. ` +
        `Si tu vois trop de bruit, monte ce chiffre.</div></div>` +

      '<div class="em-sep"></div>' +
      '<div class="em-h">Métiers recherchés (codes ROME)</div>' +
      '<div class="em-hint" style="margin-bottom:9px">C\'est le référentiel officiel des métiers. ' +
      'Chaque case cochée ramène toutes les offres du métier, même quand le titre est formulé autrement. ' +
      'C\'est ce qui fait le volume — les mots-clés ne servent qu\'à compléter.</div>' +
      '<div id="emRomes" style="margin-bottom:14px">' +
      (c.codesRome || []).map((r, i) =>
        `<div class="em-field" style="margin-bottom:6px"><label style="font-weight:600">` +
        `<input type="checkbox" class="em-rome" data-rome="${esc(r.code)}" ${r.actif ? 'checked' : ''}> ` +
        `<b>${esc(r.code)}</b> — ${esc(r.label)}</label></div>`
      ).join('') +
      '</div>' +

      '<div class="em-sep"></div>' +
      '<div class="em-h">Mots-clés complémentaires</div>' +
      '<div id="emMots">';

    (c.motsCles || []).forEach((m, i) => {
      html += `<div class="em-mot">` +
        `<input type="text" class="em-mot-q" value="${esc(m.q)}">` +
        `<input type="number" class="em-mot-p" min="1" max="10" value="${m.poids}">` +
        `<button data-suppr-mot="${i}">✕</button></div>`;
    });

    html += '</div>' +
      '<button class="em-btn" id="emAddMot" style="width:100%;margin-bottom:14px">➕ Ajouter un mot-clé</button>' +
      `<div class="em-hint" style="margin-bottom:14px">Le chiffre à droite est l'importance (1 à 10). ` +
      `Une offre trouvée via un mot-clé à 10 démarre avec un meilleur score qu'une offre trouvée via un mot-clé à 5.</div>` +

      '<div class="em-sep"></div>' +
      '<div class="em-h">Envoi des candidatures</div>' +
      `<div class="em-field"><label><input type="checkbox" id="emCopie" ${c.copieAMoi ? 'checked' : ''}> ` +
        `Recevoir une copie de chaque candidature</label></div>` +
      `<div class="em-field"><label><input type="checkbox" id="emDirect" ${c.envoiDirect ? 'checked' : ''}> ` +
        `Envoi direct, sans écran de validation</label>` +
        `<div class="em-hint">Décoché : tu relis la lettre et le destinataire avant l'envoi. ` +
        `Coché : un seul clic envoie tout. Un mail parti ne se rattrape pas — coche seulement quand ` +
        `tu auras vu passer quelques lettres et qu'elles te conviennent.</div></div>` +

      '<button class="em-btn em-btn-primaire" id="emSaveReglages" style="width:100%;margin-bottom:14px">💾 Enregistrer</button>' +

      '<div class="em-sep"></div>' +
      rendreAppris() +
      '<div class="em-h">Compte Google</div>' +
      '<button class="em-btn" id="emReco" style="width:100%;margin-bottom:8px">🔑 Reconnecter Google (autoriser l\'envoi de mails)</button>' +
      '<div class="em-hint" style="margin-bottom:14px">À faire une seule fois : le droit d\'envoyer des mails ' +
      'n\'existait pas quand tu as connecté ton compte. Sans ça, l\'envoi sera refusé.</div>' +
      '<div class="em-h">Diagnostic</div>' +
      '<button class="em-btn" id="emDiag" style="width:100%">🩺 Tester la connexion</button>' +
      '<div id="emDiagOut" style="margin-top:12px"></div>';

    return html;
  }

  function rendreAppris() {
    const a = lireAppris();
    const filtrants = termesFiltrants();
    const contrats = contratsFiltrants();

    let html = '<div class="em-sep"></div><div class="em-h">🧠 Ce que j\'ai appris de tes refus</div>';

    if (!a.refus) {
      html += '<div class="em-hint" style="margin-bottom:14px">Aucun refus enregistré pour l\'instant. ' +
              'Quand tu écartes une offre avec « 🚫 Pas pour moi », je te demande pourquoi, ' +
              'et j\'utilise les annonces refusées pour filtrer les suivantes.</div>';
      return html;
    }

    // Répartition des motifs
    const total = a.refus;
    html += `<div class="em-hint" style="margin-bottom:8px"><b>${total} refus enregistré(s).</b> Motifs :</div>` +
            '<div class="em-pills" style="margin-bottom:12px">' +
            MOTIFS.filter(m => a.motifs[m.id])
              .sort((x, y) => a.motifs[y.id] - a.motifs[x.id])
              .map(m => `<span class="em-pill em-pill-bleu">${m.label} × ${a.motifs[m.id]}</span>`)
              .join('') +
            '</div>';

    // Termes en cours d'apprentissage mais pas encore filtrants
    const presque = Object.entries(a.termes)
      .filter(([m, d]) => d.n === SEUIL_APPRIS - 1 && !a.retires.includes(m))
      .map(([m]) => m).slice(0, 8);

    if (filtrants.length || contrats.length) {
      html += '<div class="em-hint" style="margin-bottom:6px">Filtres actifs — une offre contenant ces mots ' +
              'perd des points et descend dans la liste. Touche la croix pour en retirer un.</div>' +
              '<div class="em-pills" style="margin-bottom:10px">';
      for (const f of filtrants.slice(0, 30)) {
        html += `<span class="em-pill em-pill-rouge">${esc(f.mot)} <b>×${f.n}</b> ` +
                `<button data-oublier="${esc(f.mot)}" style="border:none;background:none;cursor:pointer;font-weight:900;color:inherit;padding:0 0 0 3px">✕</button></span>`;
      }
      for (const c of contrats) {
        html += `<span class="em-pill em-pill-rouge">contrat ${esc(c.contrat)} <b>×${c.n}</b> ` +
                `<button data-oublier="contrat:${esc(c.contrat)}" style="border:none;background:none;cursor:pointer;font-weight:900;color:inherit;padding:0 0 0 3px">✕</button></span>`;
      }
      html += '</div>';
    } else {
      html += `<div class="em-hint" style="margin-bottom:10px">Aucun filtre actif pour l\'instant : ` +
              `il faut qu\'un mot revienne dans ${SEUIL_APPRIS} refus pour qu\'il compte. ` +
              `Ça évite qu\'un refus isolé écarte une bonne offre.</div>`;
    }

    if (presque.length) {
      html += `<div class="em-hint" style="margin-bottom:10px">Bientôt filtrants (${SEUIL_APPRIS - 1} refus sur ${SEUIL_APPRIS}) : ` +
              `<i>${presque.map(esc).join(', ')}</i></div>`;
    }

    // Conseils tirés des motifs dominants
    const conseils = [];
    if ((a.motifs.loin || 0) >= 3) conseils.push('Tu refuses souvent pour la distance : baisse le rayon de recherche.');
    if ((a.motifs.contrat || 0) >= 3) conseils.push('Le contrat te bloque souvent : je peux ajouter un filtre « CDI uniquement » si tu veux.');
    if ((a.motifs.metier || 0) >= 4) conseils.push('Beaucoup de hors-sujet métier : tes mots-clés sont peut-être trop larges.');
    if (conseils.length) {
      html += '<div class="em-ok" style="margin-bottom:10px">💡 ' + conseils.map(esc).join('<br>💡 ') + '</div>';
    }

    html += '<button class="em-btn" id="emOublierTout" style="width:100%;margin-bottom:14px">🧹 Tout oublier et repartir de zéro</button>';
    return html;
  }

  function rendreBrouillon() {
    const b = brouillon;
    let html = '<div class="em-top">' +
                 '<button class="em-home" id="emRetour">← Les offres</button>' +
                 '<button class="em-home" data-home="1">🏠 Mon Bureau</button>' +
               '</div>';

    if (b.etapes) {
      html += '<div class="em-card">';
      b.etapes.forEach(e => {
        html += `<div class="em-etape ${e.fait ? '' : 'attente'}">` +
                `<span class="em-ico">${e.fait ? '✅' : (e.actif ? '⏳' : '·')}</span>` +
                `<span>${esc(e.label)}</span></div>`;
      });
      html += '</div>';
      if (!b.pret) return html;
    }

    if (b.erreur) html += `<div class="em-erreur">${esc(b.erreur)}</div>`;
    if (b.message) html += `<div class="em-ok">${b.message}</div>`;
    if (b.alertes && b.alertes.length) {
      html += `<div class="em-erreur"><b>⚠️ À vérifier avant d'envoyer :</b><br>` +
              b.alertes.map(esc).join('<br>') + '</div>';
    }

    html +=
      `<div class="em-card">` +
        `<div class="em-titre">${esc(b.offre.titre)}</div>` +
        `<div class="em-entreprise">${esc(b.offre.entreprise)} — ${esc(b.offre.lieu)}</div>` +
      `</div>`;

    if (b.driveLien) {
      html += `<div class="em-ok">📄 Lettre enregistrée dans le Drive, dossier « ${DOSSIER_DRIVE} ». ` +
              `<a href="${esc(b.driveLien)}" target="_blank" rel="noopener">Ouvrir le document</a></div>`;
    }

    if (b.correspondances && b.correspondances.length) {
      const couleur = { forte: 'em-pill-vert', moyenne: 'em-pill-orange', aucune: 'em-pill-gris' };
      const fortes = b.correspondances.filter(c => c.lien === 'forte').length;
      const nulles = b.correspondances.filter(c => c.lien === 'aucune').length;

      if (fortes === 0 || nulles >= Math.ceil(b.correspondances.length / 2)) {
        html += '<div class="em-erreur"><b>⚠️ Cette offre correspond mal à ton profil.</b><br>' +
                `${nulles} exigence(s) sur ${b.correspondances.length} sans réponse dans ton parcours` +
                (fortes === 0 ? ', et aucun lien fort' : '') + '.<br>' +
                'La lettre reste honnête et s\'appuie sur tes atouts, mais l\'entretien risque ' +
                'de porter sur ce que tu ne fais pas. À toi de juger si ça vaut le coup. ' +
                'Sinon, écarte-la avec 🚫 « Pas pour moi » → « Pas mon métier » : je retiendrai le vocabulaire.' +
                '</div>';
      }
      html += '<div class="em-card"><div class="em-h">🔗 Ce que l\'annonce demande ↔ ce que tu apportes</div>' +
              '<div class="em-hint" style="margin-bottom:8px">La lettre a été construite sur cette base. ' +
              'Vérifie qu\'aucun rapprochement n\'est abusif.</div>';
      b.correspondances.forEach(c => {
        html += '<div style="margin-bottom:11px;padding-left:9px;border-left:3px solid rgba(120,120,140,0.25)">' +
                `<div style="font-size:12px;font-weight:700;margin-bottom:2px">${esc(c.annonce)}</div>` +
                `<div style="font-size:12px;color:var(--ink-mid,#555);margin-bottom:3px">↳ ${esc(c.parcours)}</div>` +
                (c.adjacent && c.lien === 'aucune'
                  ? `<div style="font-size:11.5px;color:#b45309;margin-bottom:3px">↝ compétence proche : ${esc(c.adjacent)}</div>`
                  : '') +
                `<span class="em-pill ${couleur[c.lien] || 'em-pill-gris'}">lien ${esc(c.lien)}</span>` +
                '</div>';
      });
      html += '</div>';
    }

    if (b.atouts && b.atouts.length) {
      html += '<div class="em-card"><div class="em-h">⭐ Tes atouts mis en avant</div>' +
              '<div class="em-hint" style="margin-bottom:8px">Ce que l\'annonce ne demande pas, ' +
              'mais qui te distingue des autres candidatures.</div>';
      b.atouts.forEach(a => {
        html += '<div style="margin-bottom:9px;padding-left:9px;border-left:3px solid rgba(22,163,74,0.4)">' +
                `<div style="font-size:12px;font-weight:700;margin-bottom:2px">${esc(a.atout)}</div>` +
                `<div style="font-size:12px;color:var(--ink-mid,#555)">${esc(a.apport)}</div>` +
                '</div>';
      });
      html += '</div>';
    }

    html +=
      `<div class="em-field"><label for="emTo">Destinataire</label>` +
        `<input type="text" id="emTo" value="${esc(b.mail || '')}" placeholder="recrutement@...">` +
        `<div class="em-hint">${b.mailSource
            ? 'Trouvé automatiquement (' + esc(b.mailSource) + ').'
            : 'Aucun mail trouvé. France Travail masque souvent le contact. ' +
              'Deux solutions : le chercher (bouton ci-dessous), ou postuler sur le site et ' +
              'enregistrer quand même la candidature dans ton suivi.'}` +
          (b.autres && b.autres.length ? '<br>Autres adresses repérées : ' + b.autres.map(esc).join(', ') : '') +
          (b.repli ? `<br><a href="${esc(b.repli)}" target="_blank" rel="noopener">Ouvrir l\'annonce pour postuler</a>` : '') +
        `</div>` +
        (!b.mail ? '<div class="em-actions" style="margin-top:7px">' +
          `<a class="em-btn" target="_blank" rel="noopener" style="text-decoration:none;text-align:center;line-height:1.6" ` +
          `href="https://duckduckgo.com/?q=${encodeURIComponent('"' + (b.offre.entreprise || '') + '" recrutement candidature email contact')}">` +
          `🔎 Chercher le mail sur le web</a>` +
          '</div>' : '') +
        `</div>` +

      `<div class="em-field"><label for="emSujet">Objet</label>` +
        `<input type="text" id="emSujet" value="${esc(b.sujet)}"></div>` +

      `<div class="em-field"><label for="emCorps">Message</label>` +
        `<textarea id="emCorps" style="min-height:340px">${esc(b.corps)}</textarea></div>`;

    const cfg = lire();
    html += `<div class="em-hint" style="margin-bottom:12px">` +
      (cfg.cvDriveId ? `📎 CV joint : ${esc(cfg.cvDriveNom)}` :
        '⚠️ Aucun CV joint — renseigne l\'ID du fichier dans l\'onglet « Mon profil ».') +
      (cfg.copieAMoi ? `<br>📬 Copie envoyée à ${esc(cfg.mailPerso)}` : '') + '</div>';

    html += '<div class="em-actions" style="margin-bottom:8px">' +
              '<button class="em-btn" id="emRelire">🔍 Relire et corriger</button>' +
              '<button class="em-btn" id="emReecrire">🔄 Réécrire</button>' +
            '</div>' +
            '<button class="em-btn" id="emSuivreSeul" style="width:100%;margin-bottom:8px">' +
              '📌 Postuler sur le site et suivre ici (sans envoi de mail)</button>' +
            '<button class="em-btn em-btn-primaire" id="emEnvoyer" style="width:100%">📤 Envoyer la candidature</button>' +
            '<div class="em-sep"></div>' +
            '<button class="em-bas" data-home="1">🏠 Retour à Mon Bureau</button>';
    return html;
  }

  // =========================================================
  // 9. FLUX « POSTULER »
  // =========================================================

  function offreParId(id) {
    const cache = lireCache();
    return (cache?.offres || []).find(o => o.id === id) || null;
  }

  async function postuler(id) {
    const offre = offreParId(id);
    if (!offre) return;
    const cfg = lire();

    brouillon = {
      offre,
      pret: false,
      etapes: [
        { label: 'Analyse de l\'annonce puis rédaction de la lettre', fait: false, actif: true },
        { label: 'Sauvegarde dans le Drive', fait: false, actif: false },
        { label: 'Recherche du mail du recruteur', fait: false, actif: false }
      ]
    };
    reouvrir();

    function etape(i) {
      brouillon.etapes.forEach((e, k) => { e.fait = k < i; e.actif = k === i; });
      reouvrir();
    }

    try {
      // 1. Lettre — avec réessais automatiques si le service IA sature
      const lettre = await genererLettre(offre, (msg) => {
        brouillon.etapes[0].label = msg;
        reouvrir();
      });
      etape(1);

      // 2. Drive
      let drive = null;
      try {
        drive = await sauverDansDrive(offre, lettre);
      } catch (e) {
        console.warn('[Emploi] Drive KO', e);
        brouillon.erreur = 'Lettre écrite, mais sauvegarde Drive impossible : ' + e.message;
      }
      etape(2);

      // 3. Mail du recruteur
      const contact = await trouverMail(offre);

      brouillon.etapes.forEach(e => { e.fait = true; e.actif = false; });
      brouillon.pret = true;
      brouillon.lettre = lettre;
      brouillon.driveLien = drive?.lien || null;
      brouillon.driveId = drive?.docId || null;
      const duCarnet = mailConnu(offre.entreprise);
      brouillon.mail = contact.mail || duCarnet || '';
      brouillon.mailSource = contact.mail ? (contact.source || '')
                           : (duCarnet ? 'carnet d\'adresses (candidature précédente)' : '');
      brouillon.autres = contact.autres || [];
      brouillon.repli = contact.repli || offre.urlOffre;
      brouillon.sujet = `Candidature — ${offre.titre} — ${cfg.nom}`;
      brouillon.corps = lettre + '\n\n' + cfg.signature;
      brouillon.alertes = infosLettre ? infosLettre.alertes : [];
      brouillon.correspondances = infosLettre ? infosLettre.correspondances : [];
      brouillon.atouts = infosLettre ? infosLettre.atouts : [];
      brouillon.message = infosLettre && infosLettre.relu
        ? `✅ Lettre relue et corrigée (${infosLettre.mots} mots).`
        : null;

      // Envoi direct si l'option est active ET qu'on a un destinataire
      if (cfg.envoiDirect && brouillon.mail) {
        reouvrir();
        await declencherEnvoi();
        return;
      }

      reouvrir();

    } catch (e) {
      brouillon.pret = true;
      brouillon.erreur = e.message;
      brouillon.sujet = `Candidature — ${offre.titre} — ${cfg.nom}`;
      brouillon.corps = '';
      brouillon.etapes = null;
      reouvrir();
    }
  }

  // =========================================================
  //  ACTIONS DE L'ÉCRAN DE VALIDATION
  //  Définies au niveau du module et déclenchées par délégation :
  //  elles restent actives quel que soit le nombre de redessins du
  //  panneau, ce qui évite les boutons qui ne répondent plus.
  // =========================================================

  function memoriserChamps() {
    const b = brouillon;
    if (!b) return;
    const to = document.getElementById('emTo');
    const su = document.getElementById('emSujet');
    const co = document.getElementById('emCorps');
    if (to) b.mail  = to.value.trim();
    if (su) b.sujet = su.value.trim();
    if (co) b.corps = co.value;
  }

  async function actionRelire(bouton) {
    const b = brouillon;
    if (!b) return;
    memoriserChamps();
    if (bouton) bouton.textContent = '🔍 Relecture en cours…';
    try {
      const r = await fetch(`${BACKEND}/emploi/relire`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ texte: b.corps })
      });
      const j = await jsonSafe(r, 'Relecture');
      if (!j.success) throw new Error(j.error || 'Relecture impossible');
      b.corps = j.texte;
      b.erreur = null;
      const liste = (j.corrections || []).slice(0, 8);
      b.message = j.modifie
        ? '✅ Corrections appliquées' + (j.correcteur ? ' (' + j.correcteur + ')' : '') +
          (liste.length ? ' :<br>' + liste.join('<br>') : '.')
        : 'ℹ️ Aucune faute détectée, le texte est inchangé.';
    } catch (e) {
      b.erreur = 'Relecture : ' + e.message;
    }
    reouvrir();
  }

  async function actionReecrire(bouton) {
    const b = brouillon;
    if (!b) return;
    memoriserChamps();
    if (bouton) bouton.textContent = '🔄 Nouvelle rédaction…';
    b.erreur = null;
    b.message = null;
    b.pret = false;
    b.etapes = [{ label: 'Nouvelle rédaction en cours…', fait: false, actif: true }];
    reouvrir();
    try {
      const cfg = lire();
      const lettre = await genererLettre(b.offre, (msg) => { b.etapes[0].label = msg; reouvrir(); });
      b.lettre = lettre;
      b.corps = lettre + '\n\n' + cfg.signature;
      b.driveLien = null;
      b.alertes = infosLettre ? infosLettre.alertes : [];
      b.message = infosLettre && infosLettre.relu ? '✅ Nouvelle version relue et corrigée.' : null;
    } catch (e) {
      b.erreur = e.message;
    }
    b.etapes = null;
    b.pret = true;
    reouvrir();
  }

  // Enregistre la candidature sans envoyer de mail : le cas le plus
  // fréquent, puisque France Travail masque souvent l'adresse du recruteur.
  function suivreSansEnvoi() {
    const b = brouillon;
    if (!b) return;
    memoriserChamps();
    enregistrerCandidature({
      offreId: b.offre.id,
      titre: b.offre.titre,
      entreprise: b.offre.entreprise,
      urlOffre: b.offre.urlOffre,
      driveLien: b.driveLien || null,
      mail: b.mail || '',
      statut: 'apostuler',
      notes: 'Lettre prête. À déposer sur le site de l\'employeur.'
    });
    if (b.mail) noterMail(b.offre.entreprise, b.mail);
    const lien = b.repli || b.offre.urlOffre || '';
    brouillon = null;
    onglet = 'candidatures';
    message = {
      type: 'ok',
      texte: '📌 <b>Candidature enregistrée dans le suivi</b>, avec la date du jour.<br>' +
             (lien
               ? `<a href="${esc(lien)}" target="_blank" rel="noopener" ` +
                 'style="display:inline-block;margin-top:8px;padding:9px 14px;border-radius:9px;' +
                 'background:#4f46e5;color:#fff;text-decoration:none;font-weight:700">' +
                 '🔗 Ouvrir l\'annonce pour déposer ta candidature</a><br>'
               : '') +
             '<span style="font-size:11px">Reviens ensuite ici et passe-la en « 📤 Envoyée ».</span>'
    };
    majTuile();
    reouvrir();
  }

  // Prépare un mail de relance à partir d'une candidature suivie
  async function relancer(id) {
    const c = lireCandidatures().find(x => x.id === id);
    if (!c) return;
    const cfg = lire();
    const j = joursDepuis(c.date);

    brouillon = {
      offre: {
        id: c.offreId || ('r' + id),
        titre: c.titre,
        entreprise: c.entreprise,
        lieu: '',
        urlOffre: c.urlOffre
      },
      pret: true,
      relanceDe: id,
      mail: c.mail || mailConnu(c.entreprise) || '',
      mailSource: c.mail ? 'candidature précédente' : '',
      autres: [],
      repli: c.urlOffre,
      sujet: `Relance — candidature ${c.titre} — ${cfg.nom}`,
      corps:
        'Madame, Monsieur,\n\n' +
        `Je me permets de revenir vers vous au sujet de ma candidature au poste de ${c.titre}, ` +
        `adressée le ${new Date(c.date).toLocaleDateString('fr-FR')}${j ? `, il y a ${j} jours` : ''}.\n\n` +
        'Ce poste correspond à ce que je cherche et je reste pleinement disponible pour un échange. ' +
        'Si ma candidature n\'a pas retenu votre attention, je vous serais reconnaissante de me le ' +
        'faire savoir : cela m\'aidera à orienter mes recherches.\n\n' +
        'Je vous remercie du temps que vous voudrez bien m\'accorder.\n\n' +
        'Veuillez agréer, Madame, Monsieur, l\'expression de mes salutations distinguées.\n\n' +
        cfg.signature
    };
    detail = null;
    reouvrir();
  }

  async function declencherEnvoi() {
    const cfg = lire();
    const b = brouillon;
    if (!b) return;

    memoriserChamps();
    const to    = b.mail;
    const sujet = b.sujet;
    const corps = b.corps;

    if (!tokensGoogle()) {
      b.erreur = "Compte Google non connecté : impossible d'envoyer. " +
                 "Va dans ⚙️ Réglages → 🔑 Reconnecter Google.";
      b.pret = true; b.etapes = null;
      reouvrir();
      return;
    }
    if (!to || !to.includes('@')) {
      b.erreur = 'Il manque une adresse de destinataire.';
      b.mail = to; b.sujet = sujet; b.corps = corps;
      reouvrir();
      return;
    }

    b.erreur = null;
    b.mail = to; b.sujet = sujet; b.corps = corps;
    b.etapes = [{ label: 'Envoi du mail en cours…', fait: false, actif: true }];
    b.pret = false;
    reouvrir();

    try {
      const res = await envoyerMail({
        a: to,
        cc: cfg.copieAMoi ? cfg.mailPerso : '',
        sujet, corps
      });

      enregistrerCandidature(b, { mode: 'mail', statut: 'envoyee', mail: to });

      brouillon = null;
      onglet = 'candidatures';
      message = { type: 'ok', texte: `✅ Candidature envoyée à ${esc(to)}` + (res.pieces?.length ? ` avec ${esc(res.pieces.join(', '))}` : ' (sans pièce jointe)') };
      reouvrir();
      setTimeout(() => { message = null; }, 100);

    } catch (e) {
      b.pret = true;
      b.etapes = null;
      b.erreur = 'Envoi impossible : ' + e.message;
      reouvrir();
    }
  }

  // Journalise une candidature, quel que soit le mode d'envoi.
  function enregistrerCandidature(b, opts) {
    const liste = lireCandidatures();
    const maintenant = new Date().toISOString();
    const dejala = liste.find(c => c.offreId === b.offre.id);

    const fiche = {
      id: dejala ? dejala.id : 'c' + Date.now(),
      offreId: b.offre.id,
      titre: b.offre.titre,
      entreprise: b.offre.entreprise,
      lieu: b.offre.lieu || '',
      contrat: b.offre.contrat || '',
      urlOffre: b.offre.urlOffre || '',
      urlPostulation: (b.offre.contact && b.offre.contact.urlPostulation) || b.repli || '',
      driveLien: b.driveLien || (dejala && dejala.driveLien) || null,
      mail: opts.mail || '',
      mode: opts.mode || 'site',
      statut: opts.statut || 'envoyee',
      date: (dejala && dejala.date) || maintenant,
      dateMaj: maintenant,
      historique: (dejala && dejala.historique ? dejala.historique : [])
        .concat([{ statut: opts.statut || 'envoyee', date: maintenant }]),
      notes: (dejala && dejala.notes) || ''
    };

    const autres = liste.filter(c => c.offreId !== b.offre.id);
    autres.push(fiche);
    ecrireCandidatures(autres);
    return fiche;
  }

  function majStatut(id, statut) {
    const liste = lireCandidatures();
    const c = liste.find(x => x.id === id);
    if (!c) return;
    c.statut = statut;
    c.dateMaj = new Date().toISOString();
    c.historique = (c.historique || []).concat([{ statut, date: c.dateMaj }]);
    if (statut === 'relancee') c.dateRelance = c.dateMaj;
    ecrireCandidatures(liste);
  }

  // =========================================================
  // 10. BRANCHEMENT DES ÉVÉNEMENTS
  // =========================================================

  function brancherPanneau() {
    // --- Retour à l'accueil (barre collante + bas de page) ---
    document.querySelectorAll('[data-home]').forEach(b => {
      b.addEventListener('click', () => {
        brouillon = null;
        detail = null;
        message = null;
        onglet = 'offres';
        if (typeof window.closeSheet === 'function') window.closeSheet();
        else {
          const s = document.getElementById('sheet');
          if (s) { s.classList.remove('active'); s.setAttribute('aria-hidden', 'true'); }
          const bd = document.querySelector('.backdrop');
          if (bd) bd.classList.remove('active');
          document.body.style.overflow = '';
        }
        majTuile();
      });
    });

    // --- Onglets ---
    document.querySelectorAll('.em-tab').forEach(b => {
      b.addEventListener('click', () => { onglet = b.dataset.tab; detail = null; message = null; reouvrir(); });
    });

    // --- Retour depuis le brouillon ---
    const ret = document.getElementById('emRetour');
    if (ret) ret.addEventListener('click', () => { brouillon = null; detail = null; reouvrir(); });

    // --- Rafraîchir les offres ---
    const rf = document.getElementById('emRefresh');
    if (rf) rf.addEventListener('click', async () => {
      if (enCours) return;
      enCours = true; message = null; reouvrir();
      try {
        const j = await chargerOffres();
        message = {
          type: 'ok',
          texte: `${j.total} offre(s) retenue(s)` +
                 (j.brut && j.brut !== j.total ? ` sur ${j.brut} analysées.` : '.') +
                 (j.erreurs && j.erreurs.length ? `<br><small>${esc(j.erreurs.slice(0,2).join(' · '))}</small>` : '')
        };
      } catch (e) {
        message = { type: 'err', texte: 'Recherche impossible : ' + esc(e.message) };
      }
      enCours = false;
      reouvrir();
    });

    // --- Liens externes ---
    document.querySelectorAll('[data-lien]').forEach(b => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); ouvrirLien(b.dataset.lien); });
    });

    // Les vrais liens ne doivent pas déclencher l'ouverture de la carte
    document.querySelectorAll('a.em-btn').forEach(a => {
      a.addEventListener('click', (ev) => { ev.stopPropagation(); });
      // Appui long : proposer l'adresse en clair si l'ouverture échoue
      a.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        afficherLienSecours(a.getAttribute('href'));
      });
    });

    // --- Lire l'annonce en plein écran ---
    document.querySelectorAll('[data-plus]').forEach(b => {
      b.addEventListener('click', () => {
        const vues = lireVues(); vues.push(b.dataset.plus); marquerVues(vues);
        detail = b.dataset.plus;
        majTuile();
        reouvrir();
      });
    });

    // --- Toute la carte est cliquable pour lire l'annonce ---
    document.querySelectorAll('.em-card[data-offre]').forEach(c => {
      c.addEventListener('click', (ev) => {
        if (ev.target.closest('button')) return;   // les boutons gardent leur rôle
        const id = c.getAttribute('data-offre');
        const vues = lireVues(); vues.push(id); marquerVues(vues);
        detail = id;
        majTuile();
        reouvrir();
      });
    });

    // --- Retour à la liste depuis la lecture ---
    const rl = document.getElementById('emRetourListe');
    if (rl) rl.addEventListener('click', () => { detail = null; reouvrir(); });

    // --- Demander le motif avant d'écarter ---
    document.querySelectorAll('[data-ignorer]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        if (detail) {          // depuis la lecture plein écran : pas de question
          ignorer(b.dataset.ignorer);
          detail = null;
          majTuile();
          reouvrir();
          return;
        }
        motifPour = b.dataset.ignorer;
        reouvrir();
      });
    });

    // --- Motif choisi : on apprend puis on écarte ---
    document.querySelectorAll('[data-motif]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = b.dataset.motifOffre;
        const o = offreParId(id);
        if (o) apprendreRefus(o, b.dataset.motif);
        const carte = b.closest('.em-card');
        ignorer(id);
        motifPour = null;
        detail = null;
        if (carte) {
          carte.style.transition = 'opacity .18s ease, transform .18s ease';
          carte.style.opacity = '0';
          carte.style.transform = 'scale(0.97)';
        }
        majTuile();
        setTimeout(reouvrir, 190);
      });
    });

    // --- Annuler la demande de motif ---
    document.querySelectorAll('[data-motif-annule]').forEach(b => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); motifPour = null; reouvrir(); });
    });

    // --- Réafficher les offres écartées ---
    const rest = document.getElementById('emRestaurer');
    if (rest) rest.addEventListener('click', () => {
      restaurerIgnorees();
      majTuile();
      reouvrir();
    });

    // --- Postuler ---
    document.querySelectorAll('[data-postuler]').forEach(b => {
      b.addEventListener('click', () => {
        const vues = lireVues(); vues.push(b.dataset.postuler); marquerVues(vues);
        postuler(b.dataset.postuler);
      });
    });

    // --- Changer le statut d'une candidature ---
    document.querySelectorAll('[data-statut]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const champs = { statut: b.dataset.statut };
        if (b.dataset.statut === 'relancee') champs.relanceLe = new Date().toISOString();
        majCandidature(b.dataset.cand, champs);
        reouvrir();
      });
    });

    // --- Relancer ---
    document.querySelectorAll('[data-relancer]').forEach(b => {
      b.addEventListener('click', (ev) => { ev.stopPropagation(); relancer(b.dataset.relancer); });
    });

    // --- Ajouter une note ---
    document.querySelectorAll('[data-note]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const c = lireCandidatures().find(x => x.id === b.dataset.note);
        const texte = prompt('Note sur cette candidature :', c?.notes || '');
        if (texte !== null) { majCandidature(b.dataset.note, { notes: texte.slice(0, 300) }); reouvrir(); }
      });
    });

    // --- Ajouter une candidature faite ailleurs ---
    const aj = document.getElementById('emAjoutCand');
    if (aj) aj.addEventListener('click', () => {
      const titre = prompt('Intitulé du poste :');
      if (!titre) return;
      const entreprise = prompt('Employeur :') || '';
      const quand = prompt('Date de la candidature (JJ/MM/AAAA), vide = aujourd\'hui :') || '';
      let date = new Date().toISOString();
      const m = quand.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      if (m) {
        const d = new Date(+m[3], +m[2] - 1, +m[1]);
        if (!isNaN(d)) date = d.toISOString();
      }
      enregistrerCandidature({
        titre, entreprise, date,
        mail: mailConnu(entreprise) || '',
        statut: 'envoyee',
        notes: 'Ajoutée manuellement'
      });
      message = { type: 'ok', texte: '✅ Candidature ajoutée au suivi.' };
      reouvrir();
    });

    // --- Enregistrer sans envoyer ---
    const ss = document.getElementById('emSuivreSeul');
    if (ss) ss.addEventListener('click', (ev) => { ev.stopPropagation(); suivreSansEnvoi(); });

    // --- Chercher le mail du recruteur sur le web ---
    document.querySelectorAll('[data-chercher-mail]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const n = b.dataset.chercherMail;
        ouvrirLien('https://duckduckgo.com/?q=' +
          encodeURIComponent('"' + n + '" recrutement OR candidature email contact'));
      });
    });

    // --- Supprimer une candidature ---
    document.querySelectorAll('[data-suppr-cand]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const c = lireCandidatures().find(x => x.id === b.dataset.supprCand);
        if (!confirm('Supprimer définitivement le suivi de « ' + (c?.titre || 'cette candidature') + ' » ?')) return;
        ecrireCandidatures(lireCandidatures().filter(x => x.id !== b.dataset.supprCand));
        reouvrir();
      });
    });

    // --- Profil ---
    const sp = document.getElementById('emSaveProfil');
    if (sp) sp.addEventListener('click', () => {
      const c = lire();
      c.nom        = document.getElementById('emNom').value.trim() || c.nom;
      c.telephone  = document.getElementById('emTel').value.trim();
      c.signature  = document.getElementById('emSign').value;
      c.cv         = document.getElementById('emCv').value;
      c.cvDriveId  = document.getElementById('emCvId').value.trim();
      c.cvDriveNom = document.getElementById('emCvNom').value.trim() || 'CV.pdf';
      ecrire(c);
      message = { type: 'ok', texte: '✅ Profil enregistré et synchronisé.' };
      reouvrir();
    });

    // --- Mots-clés ---
    const add = document.getElementById('emAddMot');
    if (add) add.addEventListener('click', () => {
      const c = lire();
      c.motsCles = collecterMots();
      c.motsCles.push({ q: '', poids: 5 });
      ecrire(c);
      reouvrir();
    });

    document.querySelectorAll('[data-suppr-mot]').forEach(b => {
      b.addEventListener('click', () => {
        const c = lire();
        const mots = collecterMots();
        mots.splice(parseInt(b.dataset.supprMot, 10), 1);
        c.motsCles = mots;
        ecrire(c);
        reouvrir();
      });
    });

    // --- Réglages ---
    const sr = document.getElementById('emSaveReglages');
    if (sr) sr.addEventListener('click', () => {
      const c = lire();
      c.commune   = document.getElementById('emCommune').value.trim() || '31555';
      c.rayon     = Math.max(5, Math.min(60, parseInt(document.getElementById('emRayon').value, 10) || 20));
      c.minScore  = Math.max(0, Math.min(90, parseInt(document.getElementById('emMinScore').value, 10) || 25));
      c.motsCles  = collecterMots().filter(m => m.q);
      const coches = [...document.querySelectorAll('.em-rome')];
      if (coches.length) {
        c.codesRome = (c.codesRome || []).map(r => {
          const el = coches.find(x => x.dataset.rome === r.code);
          return Object.assign({}, r, { actif: el ? el.checked : r.actif });
        });
      }
      c.copieAMoi = !!document.getElementById('emCopie').checked;
      c.envoiDirect = !!document.getElementById('emDirect').checked;
      ecrire(c);
      message = { type: 'ok', texte: '✅ Réglages enregistrés.' };
      reouvrir();
    });

    // --- Retirer un terme appris ---
    document.querySelectorAll('[data-oublier]').forEach(b => {
      b.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const a = lireAppris();
        const mot = b.dataset.oublier;
        if (!a.retires.includes(mot)) a.retires.push(mot);
        ecrireAppris(a);
        reouvrir();
      });
    });

    // --- Tout oublier ---
    const ot = document.getElementById('emOublierTout');
    if (ot) ot.addEventListener('click', () => {
      oublierTout();
      message = { type: 'ok', texte: '🧹 Apprentissage remis à zéro.' };
      reouvrir();
    });

    // --- Reconnexion Google avec le droit d'envoi ---
    const rc = document.getElementById('emReco');
    if (rc) rc.addEventListener('click', async () => {
      try {
        const r = await fetch(`${BACKEND}/emploi/auth-url?redirect=${encodeURIComponent(location.href)}`);
        const j = await jsonSafe(r, 'Reconnexion Google');
        if (j.url) ouvrirLien(j.url);
        else throw new Error(j.error || 'URL non fournie');
      } catch (e) {
        message = { type: 'err', texte: esc(e.message) };
        reouvrir();
      }
    });

    // --- Diagnostic ---
    const dg = document.getElementById('emDiag') || document.getElementById('emDiagRapide');
    if (dg) dg.addEventListener('click', async () => {
      const out = document.getElementById('emDiagOut');
      out.innerHTML = '<div class="em-hint">Test en cours…</div>';
      try {
        const r = await fetch(`${BACKEND}/emploi/ping`);
        const j = await jsonSafe(r, 'Diagnostic');
        const g = tokensGoogle();
        out.innerHTML =
          `<div class="em-card">` +
          `<div class="em-etape"><span class="em-ico">${j.success ? '✅' : '❌'}</span>` +
            `Module Emploi actif (v${esc(j.version || '?')})</div>` +
          `<div class="em-etape"><span class="em-ico">${j.franceTravail ? '✅' : '❌'}</span>` +
            `Clés France Travail ${j.franceTravail ? 'présentes' : 'ABSENTES sur Render'}</div>` +
          `<div class="em-etape"><span class="em-ico">${j.google ? '✅' : '❌'}</span>` +
            `Clés Google présentes</div>` +
          `<div class="em-etape"><span class="em-ico">${g ? '✅' : '❌'}</span>` +
            `Compte Google ${g ? 'connecté' : 'NON connecté'}</div>` +
          `<div class="em-etape"><span class="em-ico">🚲</span>` +
            `Stations VélôToulouse : ${esc(String(j.stationsVelo))}</div>` +
          `</div>`;
      } catch (e) {
        out.innerHTML = `<div class="em-erreur">Backend injoignable : ${esc(e.message)}</div>`;
      }
    });
  }

  function collecterMots() {
    const qs = [...document.querySelectorAll('.em-mot-q')];
    const ps = [...document.querySelectorAll('.em-mot-p')];
    if (!qs.length) return lire().motsCles || [];
    return qs.map((q, i) => ({
      q: q.value.trim(),
      poids: Math.max(1, Math.min(10, parseInt(ps[i]?.value, 10) || 5))
    }));
  }

  // =========================================================
  // 11. DÉMARRAGE
  // =========================================================

  function demarrer() {
    injectStyles();
    creerTuile();

    // -----------------------------------------------------
    // Enregistrement dans Apps (couche3.js)
    // Selon l'ordre de chargement des scripts, Apps peut ne pas encore
    // exister au moment où cette tuile démarre. On réessaie donc à
    // plusieurs reprises au lieu d'abandonner au premier échec.
    // -----------------------------------------------------
    let enregistre = false;

    function trouverApps() {
      // 1. Variable globale exposée par couche3.js
      if (window.Apps && typeof window.Apps === 'object') return window.Apps;
      // 2. Déclaration `const Apps` : accessible sans passer par window.
      //    typeof lève une erreur si la variable est déclarée mais pas
      //    encore initialisée : on l'enferme dans un try.
      try {
        if (typeof Apps !== 'undefined' && Apps && typeof Apps === 'object') return Apps;
      } catch (e) {}
      return null;
    }

    function tenterEnregistrement(silencieux) {
      if (enregistre) return true;
      const A = trouverApps();
      if (!A) return false;
      try {
        A.emploi = {
          title: '💼 Recherche d\'emploi',
          render: rendrePanneau,
          bind: brancherPanneau
        };
        enregistre = true;
        if (!silencieux) console.log('[Emploi] tuile enregistrée dans Apps');
        return true;
      } catch (e) {
        console.warn('[Emploi] enregistrement refusé :', e.message);
        return false;
      }
    }

    // Essai immédiat, puis aux moments clés du chargement, puis en filet.
    tenterEnregistrement(true);
    if (!enregistre) {
      document.addEventListener('DOMContentLoaded', () => tenterEnregistrement(), { once: true });
      window.addEventListener('load', () => tenterEnregistrement(), { once: true });
      [200, 800, 2000, 5000].forEach(ms => setTimeout(() => tenterEnregistrement(), ms));
    }

    // Ouverture de secours : elle reste branchée en permanence, même si
    // l'enregistrement finit par réussir. Si Apps prend le relais, ce
    // gestionnaire ne se déclenche pas (il vérifie d'abord).
    document.addEventListener('click', function (ev) {
      const t = ev.target.closest && ev.target.closest('[data-app="emploi"]');
      if (!t) return;
      if (enregistre) return;          // couche3.js s'en charge
      ev.stopImmediatePropagation();
      ev.preventDefault();
      reouvrir();
    }, true);

    // -----------------------------------------------------
    // Délégation permanente pour les trois boutons critiques.
    // Posée une fois pour toutes sur le document : même si le
    // panneau est redessiné vingt fois, ils répondent toujours.
    // -----------------------------------------------------
    if (!window.__mbEmploiDelegue) {
      window.__mbEmploiDelegue = true;
      document.addEventListener('click', function (ev) {
        const cible = ev.target.closest && ev.target.closest('#emEnvoyer, #emRelire, #emReecrire');
        if (!cible) return;
        ev.preventDefault();
        ev.stopPropagation();
        if (cible.dataset.occupe === '1') return;      // anti double-clic
        cible.dataset.occupe = '1';
        cible.style.opacity = '0.6';

        const fini = () => { cible.dataset.occupe = '0'; };
        try {
          if (cible.id === 'emEnvoyer') {
            cible.textContent = '📤 Envoi en cours…';
            Promise.resolve(declencherEnvoi()).catch(e => {
              if (brouillon) { brouillon.erreur = 'Envoi : ' + e.message; brouillon.pret = true; brouillon.etapes = null; reouvrir(); }
            }).finally(fini);
          } else if (cible.id === 'emRelire') {
            Promise.resolve(actionRelire(cible)).finally(fini);
          } else if (cible.id === 'emReecrire') {
            Promise.resolve(actionReecrire(cible)).finally(fini);
          }
        } catch (e) {
          fini();
          console.error('[Emploi] action', cible.id, e);
          if (brouillon) { brouillon.erreur = e.message; reouvrir(); }
        }
      }, false);
    }

    // Outil de diagnostic, tapable dans la console
    window.MBEmploiDiag = function () {
      const A = trouverApps();
      console.log('Apps trouvé      :', !!A);
      console.log('window.Apps      :', typeof window.Apps);
      console.log('Apps.emploi posé :', !!(A && A.emploi));
      console.log('Clés de Apps     :', A ? Object.keys(A).join(', ') : '(aucune)');
      return { apps: !!A, enregistre: enregistre };
    };

    majTuile();

    // Rafraîchissement automatique une fois par jour, au premier plan
    const DERNIER = 'mb_emploi_dernier';
    function peutRafraichir() {
      const d = parseInt(localStorage.getItem(DERNIER) || '0', 10);
      return Date.now() - d > 20 * 3600 * 1000;
    }
    async function auto() {
      if (!peutRafraichir()) return;
      try {
        await chargerOffres();
        localStorage.setItem(DERNIER, String(Date.now()));
        console.log('[Emploi] offres rafraîchies automatiquement');
      } catch (e) {
        console.warn('[Emploi] auto KO', e.message);
        try { localStorage.setItem('mb_emploi_dernier_err', e.message); } catch (x) {}
        const top = document.getElementById('em-tuile-top');
        const cache = lireCache();
        if (top && (!cache || !cache.offres || !cache.offres.length)) {
          top.innerHTML = '<span style="color:#b91c1c">⚠️ Backend injoignable<br>Ouvre la tuile → Réglages → Tester</span>';
        }
      }
    }
    setTimeout(auto, 12000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { majTuile(); auto(); } });

    window.MBEmploi = {
      lire, ecrire, chargerOffres, lireCache, lireCandidatures,
      majTuile, postuler, ouvrir: reouvrir
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', demarrer);
  } else {
    demarrer();
  }
})();
