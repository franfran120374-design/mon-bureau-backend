/* =========================================================
   ROUTES GEMINI - mon-bureau-backend
   Gemini 1.5 Flash (gratuit : 15 req/min, 1500 req/jour)
   Remplace Claude pour les taches legeres :
     - /gemini/summarize  (résumés RSS)
     - /gemini/chat       (agents, citations)
   Claude reste pour les fiches et dossiers (qualite superieure)
   ========================================================= */

const express = require('express');
const router  = express.Router();

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL   = 'gemini-1.5-flash';
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

// Helper : appel Gemini API
async function callGemini(systemPrompt, userMessage, options = {}) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY manquante dans les variables d\'environnement Render');
  }

  const maxTokens = options.maxTokens || 1024;

  const body = {
    system_instruction: systemPrompt ? {
      parts: [{ text: systemPrompt }]
    } : undefined,
    contents: [
      { role: 'user', parts: [{ text: userMessage }] }
    ],
    generationConfig: {
      maxOutputTokens: maxTokens,
      temperature: options.temperature || 0.7,
    }
  };

  // Retirer system_instruction si vide (Gemini ne l'accepte pas undefined)
  if (!systemPrompt) delete body.system_instruction;

  const resp = await fetch(GEMINI_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(`Gemini ${resp.status}: ${err.error?.message || resp.statusText}`);
  }

  const data = await resp.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  return text;
}

// Helper : convertir historique agents (format Anthropic) en format Gemini
function toGeminiMessages(messages) {
  return messages
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: typeof m.content === 'string'
        ? m.content
        : (Array.isArray(m.content)
            ? m.content.filter(b => b.type === 'text').map(b => b.text).join('\n')
            : String(m.content)) }]
    }));
}

// =====================
// POST /gemini/summarize
// Body: { text, type }
// Remplace /claude/summarize pour les résumés RSS
// =====================

router.post('/summarize', async (req, res) => {
  const { text, type = 'article' } = req.body;

  if (!text) {
    return res.status(400).json({ success: false, error: 'text requis' });
  }

  const systemPrompt = `Tu es un assistant de lecture expert en français.
Tu résumes des articles de façon claire, structurée et utile.
Réponds TOUJOURS en français, de façon concise et informative.`;

  const userMsg = type === 'article'
    ? `Résume cet article en 3-4 phrases claires. Mets en avant les points essentiels :\n\n${text.substring(0, 4000)}`
    : `Résume ce contenu en quelques phrases :\n\n${text.substring(0, 4000)}`;

  try {
    const summary = await callGemini(systemPrompt, userMsg, { maxTokens: 512 });
    res.json({ success: true, summary, model: 'gemini-1.5-flash' });
  } catch(e) {
    console.error('[Gemini] summarize:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// =====================
// POST /gemini/chat
// Body: { messages, system }
// Compatible avec le format /agents/chat existant
// Utilisé pour : agents IA, citations, fact-check leger
// =====================

router.post('/chat', async (req, res) => {
  const { messages = [], system = '' } = req.body;

  if (!messages.length) {
    return res.status(400).json({ success: false, error: 'messages requis' });
  }

  try {
    const geminiMessages = toGeminiMessages(messages);
    if (!geminiMessages.length) {
      return res.status(400).json({ success: false, error: 'messages vides après conversion' });
    }

    // Gemini multi-tour : utiliser generateContent avec contents[]
    const body = {
      system_instruction: system ? { parts: [{ text: system }] } : undefined,
      contents: geminiMessages,
      generationConfig: {
        maxOutputTokens: 1500,
        temperature: 0.7
      }
    };
    if (!system) delete body.system_instruction;

    const resp = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(`Gemini ${resp.status}: ${err.error?.message || resp.statusText}`);
    }

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Réponse au même format que /agents/chat (compatibilité frontend)
    res.json({
      success: true,
      content: [{ type: 'text', text }],
      model: 'gemini-1.5-flash'
    });
  } catch(e) {
    console.error('[Gemini] chat:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

// =====================
// GET /gemini/status
// Verifier que la clé est configurée
// =====================

router.get('/status', async (req, res) => {
  if (!GEMINI_API_KEY) {
    return res.json({ ok: false, error: 'GEMINI_API_KEY non configurée' });
  }
  try {
    // Appel test minimal
    const text = await callGemini('', 'Dis juste "ok"', { maxTokens: 10 });
    res.json({ ok: true, model: GEMINI_MODEL, response: text.trim() });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
