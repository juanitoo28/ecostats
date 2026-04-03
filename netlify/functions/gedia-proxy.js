// netlify/functions/gedia-proxy.js
// Flow OAuth Gedia : Form login → tokenUtilisateurInternet → API historique

const GEDIA_LOGIN_URL  = 'https://mon-compte-client.gedia-reseaux.com/application/auth/externe/authentification';
const GEDIA_TOKEN_URL  = 'https://mon-compte-client.gedia-reseaux.com/application/auth/tokenUtilisateurInternet';
const GEDIA_API_URL    = 'https://mon-compte-client.gedia-reseaux.com/application/rest/interfaces/aelgrd/historiqueDeMesure/exporter';
const GEDIA_CLIENT_ID  = '4tcNbWM_v7wUN5L_r9rME0y';
const GEDIA_PASC_ID    = 'JqSWF2hJXJTs.TMsQavMkC2MX24vVO3aWQJ66_Y1DEw==';

// Étape 1 : Login avec Form Data → récupère le cookie OAuth
async function loginAndGetCookie() {
  const email    = process.env.GEDIA_EMAIL;
  const password = process.env.GEDIA_PASSWORD;
  if (!email || !password) throw new Error('Variables GEDIA_EMAIL / GEDIA_PASSWORD manquantes');

  const formData = new URLSearchParams({
    username:  email,
    password:  password,
    client_id: GEDIA_CLIENT_ID,
  });

  const res = await fetch(GEDIA_LOGIN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json, text/plain, */*',
      'Origin': 'https://mon-compte-client.gedia-reseaux.com',
      'Referer': 'https://mon-compte-client.gedia-reseaux.com/',
    },
    body: formData.toString(),
    redirect: 'manual', // ne pas suivre les redirects automatiquement
  });

  console.log(`[login] status=${res.status}`);

  // Récupérer le cookie cookieOauth depuis la réponse
  const setCookie = res.headers.get('set-cookie');
  console.log(`[login] set-cookie=${setCookie}`);

  // Extraire la valeur du cookie cookieOauth
  let cookieOauth = null;
  if (setCookie) {
    const match = setCookie.match(/cookieOauth=([^;]+)/);
    if (match) cookieOauth = match[1];
  }

  // Si redirect, suivre manuellement
  const location = res.headers.get('location');
  console.log(`[login] location=${location}`);

  return { cookieOauth, location, status: res.status };
}

// Étape 2 : Obtenir le JWT via tokenUtilisateurInternet avec le cookie
async function getJWT(cookieOauth) {
  const res = await fetch(GEDIA_TOKEN_URL, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Origin': 'https://mon-compte-client.gedia-reseaux.com',
      'Referer': 'https://mon-compte-client.gedia-reseaux.com/',
      'Cookie': `cookieOauth=${cookieOauth}`,
    },
  });

  console.log(`[token] status=${res.status}`);
  const text = await res.text();
  console.log(`[token] body=${text.slice(0, 300)}`);

  if (!res.ok) return null;
  const data = JSON.parse(text);
  return data.access_token ?? data.token ?? data.authorization ?? null;
}

// Étape 3 : Appeler l'API historique
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
      'Origin': 'https://mon-compte-client.gedia-reseaux.com',
      'Referer': 'https://mon-compte-client.gedia-reseaux.com/',
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

  const body = await res.text();
  console.log(`[api] status=${res.status} body=${body.slice(0, 300)}`);
  return { status: res.status, body };
}

// Étape 4 : Normaliser
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

// Handler principal
export const handler = async () => {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=21600',
  };

  try {
    // 1. Login → cookie
    const { cookieOauth, status: loginStatus } = await loginAndGetCookie();

    if (!cookieOauth) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({
          error: 'login_failed',
          message: `Login échoué (status ${loginStatus}). Vérifier GEDIA_EMAIL et GEDIA_PASSWORD dans les env vars Netlify.`,
        }),
      };
    }

    // 2. Cookie → JWT
    const jwt = await getJWT(cookieOauth);
    if (!jwt) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'token_failed', message: 'Impossible d\'obtenir le JWT depuis tokenUtilisateurInternet' }),
      };
    }

    // 3. JWT → données historique
    const result = await fetchConsommations(jwt);
    if (result.status !== 200) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({ error: 'api_error', httpCode: result.status, detail: result.body.slice(0, 500) }),
      };
    }

    // 4. Normaliser et retourner
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(normalizeData(result.body), null, 2),
    };

  } catch (e) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'internal_error', message: e.message }),
    };
  }
};
