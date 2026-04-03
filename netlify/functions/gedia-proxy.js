// netlify/functions/gedia-proxy.js
// Déploie sur Netlify — appelé via /.netlify/functions/gedia-proxy

const GEDIA_API_URL = 'https://mon-compte-client.gedia-reseaux.com/application/rest/interfaces/aelgrd/historiqueDeMesure/exporter';
const GEDIA_AUTH_URL = 'https://mon-compte-client.gedia-reseaux.com/application/rest/utilisateurs/connexionParToken';
const GEDIA_SHARE_TOKEN = 'a08d7e619ee242a5273a2f4a5bca674831b5ead723a013dcd5062d0e690fddd5';
const GEDIA_PASC_ID = 'JqSWF2hJXJTs.TMsQavMkC2MX24vVO3aWQJ66_Y1DEw==';

// ── Étape 1 : Obtenir un JWT via le token de partage ──────
async function getJWT() {
  try {
    const res = await fetch(GEDIA_AUTH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ token: GEDIA_SHARE_TOKEN }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.token ?? data.access_token ?? data.authorization ?? null;
  } catch (e) {
    return null;
  }
}

// ── Étape 2 : Appeler l'API historique ────────────────────
async function fetchConsommations(jwt) {
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const body = JSON.stringify({
    typeObjet: 'DonneesHistoriqueMesureRepresentation',
    dateDebut: oneYearAgo.toISOString(),
    dateFin: now.toISOString(),
    groupesDeGrandeurs: [
      { typeObjet: 'produit.GroupeGrandeur', codeGroupeGrandeur: { code: '2' } },
      { typeObjet: 'produit.GroupeGrandeur', codeGroupeGrandeur: { code: '3' } },
    ],
    pointAccesServicesClient: {
      typeObjet: 'produit.PointAccesServicesClient',
      id: GEDIA_PASC_ID,
    },
  });

  const res = await fetch(GEDIA_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body,
  });

  return { status: res.status, body: await res.text() };
}

// ── Étape 3 : Normaliser la réponse ───────────────────────
function normalizeData(raw) {
  let data;
  try { data = JSON.parse(raw); } catch (e) { return { error: 'parse_error', raw }; }

  // Chercher les mesures dans la structure retournée
  let mesures = data.mesures ?? data.donnees ?? data.valeurs ?? null;

  if (!mesures && data.groupesDeGrandeurs) {
    for (const groupe of data.groupesDeGrandeurs) {
      if (groupe.mesures?.length) { mesures = groupe.mesures; break; }
      if (groupe.donnees?.length) { mesures = groupe.donnees; break; }
    }
  }

  // Si structure inconnue → retourner le raw pour debug
  if (!mesures) return { debug: true, structure: Object.keys(data), raw: data };

  const rows = mesures.map(m => {
    const dateStr = m.date ?? m.dateDebut ?? m.timestamp ?? null;
    const kwh = parseFloat(m.valeur ?? m.energie ?? m.kWh ?? 0);
    if (!dateStr) return null;
    const ts = new Date(dateStr).getTime();
    const d = new Date(dateStr);
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return { date: `${dd}-${mm}-${yyyy}`, ts, kwh };
  }).filter(Boolean).sort((a, b) => a.ts - b.ts);

  return {
    source: 'gedia-api',
    fetchedAt: new Date().toISOString(),
    totalJours: rows.length,
    totalKwh: rows.reduce((s, r) => s + r.kwh, 0),
    data: rows,
  };
}

// ── Handler Netlify ────────────────────────────────────────
export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=21600', // cache CDN Netlify 6h
  };

  // 1. Obtenir JWT
  let jwt = await getJWT();

  // 2. Si pas de JWT via token de partage → essayer le token directement
  if (!jwt) jwt = GEDIA_SHARE_TOKEN;

  // 3. Appeler l'API
  let result;
  try {
    result = await fetchConsommations(jwt);
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'network_error', message: e.message }) };
  }

  if (result.status === 401) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'auth_failed', message: 'Token invalide ou expiré' }) };
  }

  if (result.status !== 200) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'api_error', httpCode: result.status, body: result.body }) };
  }

  // 4. Normaliser et retourner
  const normalized = normalizeData(result.body);
  return { statusCode: 200, headers, body: JSON.stringify(normalized, null, 2) };
};
