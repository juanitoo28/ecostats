// netlify/functions/gedia-proxy.js
// Authentification automatique Gedia avec refresh token

const GEDIA_AUTH_URL    = 'https://mon-compte-client.gedia-reseaux.com/application/auth/externe/authentification';
const GEDIA_REFRESH_URL = 'https://mon-compte-client.gedia-reseaux.com/application/auth/externe/refresh';
const GEDIA_API_URL     = 'https://mon-compte-client.gedia-reseaux.com/application/rest/interfaces/aelgrd/historiqueDeMesure/exporter';
const GEDIA_PASC_ID     = 'JqSWF2hJXJTs.TMsQavMkC2MX24vVO3aWQJ66_Y1DEw==';

async function login() {
  const email    = process.env.GEDIA_EMAIL;
  const password = process.env.GEDIA_PASSWORD;
  if (!email || !password) throw new Error('Variables GEDIA_EMAIL et GEDIA_PASSWORD manquantes');

  const res = await fetch(GEDIA_AUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ username: email, password }),
  });

  if (!res.ok) throw new Error(`Login échoué (${res.status}): ${await res.text()}`);
  const data = await res.json();
  return data.access_token ?? data.token ?? null;
}

async function refreshToken() {
  const token = process.env.GEDIA_REFRESH_TOKEN;
  if (!token) return null;
  try {
    const res = await fetch(GEDIA_REFRESH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({ refresh_token: token }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.access_token ?? data.token ?? null;
  } catch { return null; }
}

async function fetchConsommations(jwt) {
  const now = new Date();
  const oneYearAgo = new Date(now);
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);

  const res = await fetch(GEDIA_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'Authorization': `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      typeObjet: 'DonneesHistoriqueMesureRepresentation',
      dateDebut: oneYearAgo.toISOString(),
      dateFin:   now.toISOString(),
      groupesDeGrandeurs: [
        { typeObjet: 'produit.GroupeGrandeur', codeGroupeGrandeur: { code: '2' } },
        { typeObjet: 'produit.GroupeGrandeur', codeGroupeGrandeur: { code: '3' } },
      ],
      pointAccesServicesClient: {
        typeObjet: 'produit.PointAccesServicesClient',
        id: GEDIA_PASC_ID,
      },
    }),
  });

  return { status: res.status, body: await res.text() };
}

function normalizeData(raw) {
  let data;
  try { data = JSON.parse(raw); } catch { return { error: 'parse_error', raw }; }

  let mesures = data.mesures ?? data.donnees ?? data.valeurs ?? null;
  if (!mesures && Array.isArray(data.groupesDeGrandeurs)) {
    for (const g of data.groupesDeGrandeurs) {
      const m = g.mesures ?? g.donnees ?? g.valeurs;
      if (m?.length) { mesures = m; break; }
    }
  }
  if (!mesures && Array.isArray(data)) mesures = data;
  if (!mesures) return { debug: true, structure: Object.keys(data), raw: data };

  const rows = mesures.map(m => {
    const dateStr = m.date ?? m.dateDebut ?? m.timestamp ?? m.horodatage ?? null;
    const kwh = parseFloat(m.valeur ?? m.energie ?? m.kWh ?? m.valeurMesure ?? 0);
    if (!dateStr || isNaN(kwh)) return null;
    const d = new Date(dateStr);
    const dd = String(d.getDate()).padStart(2,'0');
    const mm = String(d.getMonth()+1).padStart(2,'0');
    return { date: `${dd}-${mm}-${d.getFullYear()}`, ts: d.getTime(), kwh };
  }).filter(Boolean).sort((a,b) => a.ts - b.ts);

  return {
    source: 'gedia-api',
    fetchedAt: new Date().toISOString(),
    totalJours: rows.length,
    totalKwh: Math.round(rows.reduce((s,r) => s+r.kwh, 0)*100)/100,
    data: rows,
  };
}

export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=21600',
  };

  try {
    let jwt = await refreshToken();
    if (!jwt) jwt = await login();
    if (!jwt) return { statusCode: 401, headers, body: JSON.stringify({ error: 'auth_failed' }) };

    let result = await fetchConsommations(jwt);

    if (result.status === 401) {
      jwt = await login();
      if (!jwt) return { statusCode: 401, headers, body: JSON.stringify({ error: 'relogin_failed' }) };
      result = await fetchConsommations(jwt);
    }

    if (result.status !== 200) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: 'api_error', httpCode: result.status, detail: result.body }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(normalizeData(result.body), null, 2) };

  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'internal_error', message: e.message }) };
  }
};
