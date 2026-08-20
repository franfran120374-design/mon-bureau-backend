/* =========================================================
   BIOMIMÉTISME ROUTES — Module backend (Mon Bureau)
   -------------------------------------------------------
   Fichier AUTONOME, sur le même principe que vlog-routes.js
   et emploi-routes.js.

   Une seule route : la veille scientifique en direct pour le
   Laboratoire Biomimétisme (tuile 🌿 dans mon-bureau).

   GET /api/veille/biomimetisme/live?q=<mot-clé>&limite=<n>

   Interroge, CÔTÉ SERVEUR (donc sans problème de CORS pour le
   frontend), trois bases scientifiques publiques et gratuites :
     1. CrossRef          (articles avec DOI, tous domaines)
     2. Semantic Scholar   (articles + résumés + citations)
     3. PubMed / NCBI      (littérature biomédicale — utile pour
                            le volet santé / nutrition entérale)
   Fusionne, déduplique, trie par date, et met en cache mémoire
   10 minutes pour ne pas spammer ces API publiques.

   Aucune clé API ni variable d'environnement nécessaire.

   Ajouter dans server.js :
     import mountBiomimetisme from './biomimetisme-routes.js';
     ...
     mountBiomimetisme(app);
   ========================================================= */

'use strict';

// ---- Petit cache mémoire (évite de re-interroger les API trop souvent) ----
const cache = new Map();
const CACHE_DUREE_MS = 10 * 60 * 1000; // 10 minutes

function lireCache(cle) {
  const entree = cache.get(cle);
  if (!entree) return null;
  if (Date.now() - entree.horodatage > CACHE_DUREE_MS) {
    cache.delete(cle);
    return null;
  }
  return entree.donnees;
}

function ecrireCache(cle, donnees) {
  cache.set(cle, { donnees, horodatage: Date.now() });
}

// ---- Appel à CrossRef ----
async function chercherCrossRef(motCle, limite) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(motCle)}&rows=${limite}&sort=published&order=desc&filter=type:journal-article`;
  const reponse = await fetch(url, {
    headers: { 'User-Agent': 'LaboratoireBiomimetisme/1.0 (mailto:contact@example.com)' }
  });
  if (!reponse.ok) throw new Error(`CrossRef a répondu ${reponse.status}`);
  const donnees = await reponse.json();
  const items = donnees.message && donnees.message.items ? donnees.message.items : [];

  return items.map((item) => {
    const dateParts = (item.published && item.published['date-parts'] && item.published['date-parts'][0]) ||
      (item.created && item.created['date-parts'] && item.created['date-parts'][0]) || [];
    const auteurs = (item.author || [])
      .map((a) => [a.given, a.family].filter(Boolean).join(' '))
      .join(', ');
    return {
      source: 'CrossRef',
      titre: Array.isArray(item.title) ? item.title[0] : (item.title || 'Sans titre'),
      auteurs: auteurs || 'Auteurs non renseignés',
      revue: Array.isArray(item['container-title']) ? item['container-title'][0] : (item['container-title'] || ''),
      annee: dateParts[0] || null,
      resume: '',
      lien: item.URL || (item.DOI ? `https://doi.org/${item.DOI}` : ''),
      doi: item.DOI || ''
    };
  });
}

// ---- Appel à Semantic Scholar ----
async function chercherSemanticScholar(motCle, limite) {
  const champs = 'title,authors,year,venue,abstract,url,externalIds';
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(motCle)}&limit=${limite}&fields=${champs}`;
  const reponse = await fetch(url);
  if (!reponse.ok) throw new Error(`Semantic Scholar a répondu ${reponse.status}`);
  const donnees = await reponse.json();
  const items = donnees.data || [];

  return items.map((item) => ({
    source: 'Semantic Scholar',
    titre: item.title || 'Sans titre',
    auteurs: (item.authors || []).map((a) => a.name).join(', ') || 'Auteurs non renseignés',
    revue: item.venue || '',
    annee: item.year || null,
    resume: item.abstract ? item.abstract.slice(0, 400) : '',
    lien: item.url || '',
    doi: (item.externalIds && item.externalIds.DOI) || ''
  }));
}

// ---- Appel à PubMed / NCBI (E-utilities) ----
// Utile en particulier pour le volet santé / nutrition entérale du projet.
async function chercherPubMed(motCle, limite) {
  const urlRecherche = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=${encodeURIComponent(motCle)}&retmax=${limite}&sort=date&retmode=json`;
  const reponseRecherche = await fetch(urlRecherche);
  if (!reponseRecherche.ok) throw new Error(`PubMed (esearch) a répondu ${reponseRecherche.status}`);
  const donneesRecherche = await reponseRecherche.json();
  const ids = (donneesRecherche.esearchresult && donneesRecherche.esearchresult.idlist) || [];
  if (!ids.length) return [];

  const urlResume = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id=${ids.join(',')}&retmode=json`;
  const reponseResume = await fetch(urlResume);
  if (!reponseResume.ok) throw new Error(`PubMed (esummary) a répondu ${reponseResume.status}`);
  const donneesResume = await reponseResume.json();
  const resultat = donneesResume.result || {};

  return ids
    .filter((id) => resultat[id])
    .map((id) => {
      const article = resultat[id];
      const annee = article.pubdate ? parseInt(String(article.pubdate).slice(0, 4), 10) : null;
      const auteurs = (article.authors || []).map((a) => a.name).join(', ');
      return {
        source: 'PubMed',
        titre: article.title || 'Sans titre',
        auteurs: auteurs || 'Auteurs non renseignés',
        revue: article.source || '',
        annee: Number.isNaN(annee) ? null : annee,
        resume: '',
        lien: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
        doi: (article.elocationid || '').replace(/^doi:\s*/i, '')
      };
    });
}

// ---- Fusion + dédoublonnage (par DOI, sinon par titre) ----
function fusionnerEtDedupliquer(...listes) {
  const vus = new Set();
  const resultat = [];
  for (const liste of listes) {
    for (const article of liste) {
      const cle = (article.doi || article.titre || '').toLowerCase().trim();
      if (!cle || vus.has(cle)) continue;
      vus.add(cle);
      resultat.push(article);
    }
  }
  resultat.sort((a, b) => (b.annee || 0) - (a.annee || 0));
  return resultat;
}

// ---- Montage sur l'app Express ----
export default function mountBiomimetisme(app) {
  app.get('/api/veille/biomimetisme/live', async (requete, reponse) => {
    const motCle = (requete.query.q || 'biomimicry').toString().trim();
    const limite = Math.min(parseInt(requete.query.limite, 10) || 15, 30);
    const cleCache = `${motCle}::${limite}`;

    const enCache = lireCache(cleCache);
    if (enCache) {
      return reponse.json({ source: 'cache', requete: motCle, resultats: enCache });
    }

    try {
      const [crossref, semanticScholar, pubmed] = await Promise.allSettled([
        chercherCrossRef(motCle, limite),
        chercherSemanticScholar(motCle, limite),
        chercherPubMed(motCle, limite)
      ]);

      const resultatsCrossRef = crossref.status === 'fulfilled' ? crossref.value : [];
      const resultatsSemantic = semanticScholar.status === 'fulfilled' ? semanticScholar.value : [];
      const resultatsPubMed = pubmed.status === 'fulfilled' ? pubmed.value : [];

      const fusion = fusionnerEtDedupliquer(resultatsCrossRef, resultatsSemantic, resultatsPubMed).slice(0, limite);

      ecrireCache(cleCache, fusion);

      reponse.json({
        source: 'direct',
        requete: motCle,
        resultats: fusion,
        avertissements: [
          crossref.status === 'rejected' ? `CrossRef indisponible : ${crossref.reason.message}` : null,
          semanticScholar.status === 'rejected' ? `Semantic Scholar indisponible : ${semanticScholar.reason.message}` : null,
          pubmed.status === 'rejected' ? `PubMed indisponible : ${pubmed.reason.message}` : null
        ].filter(Boolean)
      });
    } catch (erreur) {
      reponse.status(500).json({ erreur: 'Erreur lors de la veille scientifique', detail: erreur.message });
    }
  });
}
