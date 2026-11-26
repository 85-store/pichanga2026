// Resuelve el escudo (crest) de cada club: busca la entidad en Wikidata,
// obtiene el titulo exacto del articulo en Wikipedia ingles (sitelink enwiki),
// y extrae el campo "image" de la plantilla Infobox football club.
const fs = require('fs');
const path = require('path');

const UA = 'Mozilla/5.0 PichangaGameBot/1.0';

const PRIMERA_A = [
  'Audax Italiano',
  'Cobresal',
  'Colo-Colo',
  'Coquimbo Unido',
  'Deportes Concepción',
  'Deportes La Serena',
  'Deportes Limache',
  'Everton de Viña del Mar',
  'Huachipato',
  'Ñublense',
  "O'Higgins",
  'Palestino',
  'Unión La Calera',
  'Universidad Católica',
  'Universidad de Chile',
  'Universidad de Concepción',
];

const PRIMERA_B = [
  'Cobreloa',
  'Curicó Unido',
  'Deportes Antofagasta',
  'Deportes Copiapó',
  'Deportes Iquique',
  'Deportes Puerto Montt',
  'Deportes Recoleta',
  'Deportes Santa Cruz',
  'Deportes Temuco',
  'Magallanes',
  'Rangers de Talca',
  'San Luis de Quillota',
  'San Marcos de Arica',
  'Santiago Wanderers',
  'Unión Española',
  'Unión San Felipe',
];

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, asJson) {
  let delay = 3000;
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.status === 429) {
      console.log(`  (429, reintentando en ${delay}ms...)`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
      continue;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return asJson ? res.json() : res.text();
  }
  throw new Error(`Rate limited repetidamente: ${url}`);
}

async function fetchJson(url) {
  return fetchWithRetry(url, true);
}

async function findWikidataId(name) {
  const url = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
    name + ' football club Chile'
  )}&language=es&format=json&limit=1&type=item`;
  const data = await fetchJson(url);
  if (data.search && data.search.length) return data.search[0].id;
  // fallback: search without the extra qualifier
  const url2 = `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=${encodeURIComponent(
    name
  )}&language=es&format=json&limit=1&type=item`;
  const data2 = await fetchJson(url2);
  return data2.search && data2.search.length ? data2.search[0].id : null;
}

async function getEnwikiTitle(qid) {
  const url = `https://www.wikidata.org/w/api.php?action=wbgetentities&ids=${qid}&props=sitelinks&sitefilter=enwiki&format=json`;
  const data = await fetchJson(url);
  const ent = data.entities[qid];
  return ent && ent.sitelinks && ent.sitelinks.enwiki ? ent.sitelinks.enwiki.title : null;
}

async function getImageField(title) {
  const url = `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(title)}&action=raw`;
  const text = await fetchWithRetry(url, false);
  const m = text.match(/\|\s*image\s*=\s*([^\n|]+)/i);
  if (!m) return null;
  let fname = m[1].trim();
  fname = fname.replace(/\[\[File:/i, '').replace(/]]$/, '').split('|')[0].trim();
  return fname || null;
}

async function resolveCrest(spanishName) {
  const qid = await findWikidataId(spanishName);
  await sleep(1500);
  if (!qid) return { club: spanishName, qid: null, wikiTitle: null, file: null, crest_url: null };
  const title = await getEnwikiTitle(qid);
  await sleep(1500);
  if (!title) return { club: spanishName, qid, wikiTitle: null, file: null, crest_url: null };
  const file = await getImageField(title);
  await sleep(1500);
  return {
    club: spanishName,
    qid,
    wikiTitle: title,
    file,
    crest_url: file ? `https://en.wikipedia.org/wiki/Special:FilePath/${encodeURIComponent(file)}` : null,
  };
}

async function main() {
  const all = [
    ...PRIMERA_A.map((c) => ({ name: c, division: 'Primera A' })),
    ...PRIMERA_B.map((c) => ({ name: c, division: 'Primera B' })),
  ];
  const outPath = path.join(__dirname, '..', 'data', 'crests.json');
  let existing = [];
  if (fs.existsSync(outPath)) {
    existing = JSON.parse(fs.readFileSync(outPath, 'utf8'));
  }
  const byName = new Map(existing.map((r) => [r.club, r]));

  for (const club of all) {
    const prev = byName.get(club.name);
    if (prev && prev.crest_url) {
      console.log(club.name, '-> (ya tenia)', prev.crest_url);
      continue;
    }
    let r;
    try {
      r = await resolveCrest(club.name);
    } catch (e) {
      r = { club: club.name, error: e.message };
    }
    byName.set(club.name, { ...club, ...r });
    console.log(club.name, '->', r.crest_url || `NO ENCONTRADO (qid=${r.qid}, title=${r.wikiTitle})`);
    fs.writeFileSync(outPath, JSON.stringify([...byName.values()], null, 2));
  }
  const results = [...byName.values()];
  console.log('\nGuardado en', outPath);
  console.log('Faltantes:', results.filter((r) => !r.crest_url).length);
}

main();
