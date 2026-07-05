export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = 'https://rejestr.io/api/v2';
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

globalThis.__REJESTR_CACHE__ ||= new Map();

function json(data, status = 200) {
  return Response.json(data, { status });
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s\u00a0]+/g, ' ')
    .trim();
}

function stripLeadingZerosForKrs(digits) {
  const stripped = String(digits || '').replace(/^0+/, '');
  return stripped || '0';
}

function digitsOrEmpty(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/\D/g, '');
}

function fullKrs(v) {
  const d = digitsOrEmpty(v);
  return d ? d.padStart(10, '0') : '';
}

function fullNip(v) {
  const d = digitsOrEmpty(v);
  return d.length === 10 ? d : '';
}

function firstString(values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  }
  return '';
}

function authHeaderVariants() {
  const key = process.env.REJESTR_API_KEY;
  if (!key) return [];
  return [
    { Authorization: key },
    { Authorization: `Bearer ${key}` },
    { 'X-Api-Key': key }
  ];
}

function cacheGet(cacheKey) {
  const hit = globalThis.__REJESTR_CACHE__.get(cacheKey);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) {
    globalThis.__REJESTR_CACHE__.delete(cacheKey);
    return null;
  }
  return hit.data;
}

function cacheSet(cacheKey, data) {
  globalThis.__REJESTR_CACHE__.set(cacheKey, { ts: Date.now(), data });
}

async function fetchRejestrJson(path, params = {}) {
  const query = new URLSearchParams(params).toString();
  const url = `${API_BASE}${path}${query ? `?${query}` : ''}`;
  const cacheKey = url;
  const cached = cacheGet(cacheKey);
  if (cached) return cached;

  const variants = authHeaderVariants();
  if (!variants.length) {
    throw new Error('Brak REJESTR_API_KEY w zmiennych środowiskowych hostingu.');
  }

  let lastError = null;
  for (const headers of variants) {
    const res = await fetch(url, { headers, cache: 'no-store' });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }

    if (res.ok) {
      cacheSet(cacheKey, body);
      return body;
    }

    lastError = { status: res.status, body };
    if (![401, 403].includes(res.status)) break;
  }

  const message = typeof lastError?.body === 'object'
    ? JSON.stringify(lastError.body)
    : String(lastError?.body || 'Nieznany błąd Rejestr.io');
  const err = new Error(`Rejestr.io API zwróciło błąd ${lastError?.status || ''}: ${message}`);
  err.status = lastError?.status || 500;
  err.details = lastError?.body;
  throw err;
}

function extractPersonId(inputRaw) {
  const raw = String(inputRaw || '').trim();
  if (!raw) return '';

  const urlMatch = raw.match(/(?:osoby|osoba)\/(\d+)/i);
  if (urlMatch) return urlMatch[1];

  // Rejestr.io używa liczbowego id osoby. Jeśli użytkownik wklei sam numer,
  // albo tekst typu "ID osoby: 123456", bierzemy najdłuższy ciąg cyfr.
  const numbers = raw.match(/\d+/g) || [];
  return numbers.sort((a, b) => b.length - a.length)[0] || '';
}

async function fetchPersonRelations(personId) {
  const data = await fetchRejestrJson(`/osoby/${encodeURIComponent(personId)}/krs-powiazania`, {
    aktualnosc: 'aktualne'
  });
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.wyniki)) return data.wyniki;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

async function fetchDocumentList(orgId) {
  return await fetchRejestrJson(`/org/${encodeURIComponent(orgId)}/krs-dokumenty`);
}

function selectMatchingPeriod(documentSets, periodStart, periodEnd) {
  if (!Array.isArray(documentSets)) return null;
  const exact = documentSets.find(s => s.data_start === periodStart && s.data_koniec === periodEnd);
  if (exact) return exact;

  const endYear = String(periodEnd || '').slice(0, 4);
  if (endYear) {
    return documentSets.find(s => String(s.data_koniec || '').startsWith(endYear)) || null;
  }
  return null;
}

function pickDocument(periodSet, wantedName) {
  const docs = periodSet?.dokumenty || [];
  const candidates = docs.filter(d => d.czy_ma_json);

  if (normalizeText(wantedName).includes('bilans')) {
    return candidates.find(d => normalizeText(d.nazwa) === 'bilans')
      || candidates.find(d => normalizeText(d.nazwa).includes('bilans'))
      || null;
  }

  return candidates.find(d => normalizeText(d.nazwa).includes('rachunek zyskow i strat'))
    || candidates.find(d => normalizeText(d.nazwa).includes('zyskow i strat'))
    || null;
}

function relationRole(item) {
  const rels = Array.isArray(item?.krs_powiazania_kwerendowane) ? item.krs_powiazania_kwerendowane : [];
  const roles = rels
    .map(r => firstString([r?.opis, r?.typ]))
    .filter(Boolean);
  return [...new Set(roles)].join(', ');
}

function isCurrentlyRelated(item) {
  if (item?.stan?.czy_wykreslona === true) return false;
  const rels = Array.isArray(item?.krs_powiazania_kwerendowane) ? item.krs_powiazania_kwerendowane : [];
  if (!rels.length) return true;
  return rels.some(r => !r?.data_koniec);
}

function relationToCompany(item) {
  const krs = fullKrs(item?.numery?.krs || item?.id);
  const nip = fullNip(item?.numery?.nip);
  const orgId = stripLeadingZerosForKrs(krs || item?.id);
  const name = firstString([item?.nazwy?.pelna, item?.nazwy?.skrocona, item?.nazwa, item?.firma]);

  if (!orgId || orgId === '0') return null;

  return {
    orgId,
    krs,
    nip,
    // Wypełniamy porównywarkę zawsze numerem KRS, nie NIP.
    // To unika błędu 409, gdy jeden NIP jest przypisany do kilku organizacji.
    preferredId: krs,
    preferredKind: 'KRS',
    name,
    role: relationRole(item),
    raw: item
  };
}

async function enrichWithReportInfo(company, periodStart, periodEnd) {
  try {
    const list = await fetchDocumentList(company.orgId);
    const selectedPeriod = selectMatchingPeriod(list, periodStart, periodEnd);
    if (!selectedPeriod) {
      return { ...company, hasReports: false, reason: 'Brak sprawozdania dla wybranego roku/okresu.' };
    }

    const balanceDoc = pickDocument(selectedPeriod, 'bilans');
    const pnlDoc = pickDocument(selectedPeriod, 'rachunek zysków i strat');
    const hasReports = Boolean(balanceDoc || pnlDoc);

    return {
      ...company,
      hasReports,
      hasBalance: Boolean(balanceDoc),
      hasPnl: Boolean(pnlDoc),
      period: { start: selectedPeriod.data_start, end: selectedPeriod.data_koniec },
      reason: hasReports ? '' : 'Brak bilansu/RZiS w JSON dla wybranego okresu.'
    };
  } catch (e) {
    return { ...company, hasReports: false, reason: e.message || 'Nie udało się sprawdzić sprawozdania.' };
  }
}

export async function POST(req) {
  try {
    const body = await req.json();
    const personInput = body.personInput || '';
    const periodStart = body.periodStart || '2024-01-01';
    const periodEnd = body.periodEnd || '2024-12-31';
    const max = Math.min(Math.max(Number(body.max || 20), 1), 20);

    const personId = extractPersonId(personInput);
    if (!personId) return json({ error: 'Podaj ID osoby albo link do osoby z Rejestr.io.' }, 400);

    const relations = await fetchPersonRelations(personId);
    const dedup = new Map();

    for (const item of relations) {
      if (!isCurrentlyRelated(item)) continue;
      const company = relationToCompany(item);
      if (!company) continue;
      const key = company.krs || company.nip || company.orgId;
      if (!dedup.has(key)) dedup.set(key, company);
    }

    const allCurrent = [...dedup.values()];
    const checked = [];
    for (const company of allCurrent) {
      checked.push(await enrichWithReportInfo(company, periodStart, periodEnd));
    }

    const withReports = checked.filter(c => c.hasReports);
    const selected = withReports.slice(0, max);
    const skipped = checked.filter(c => !c.hasReports).slice(0, 50);

    return json({
      personId,
      periodStart,
      periodEnd,
      totalCurrentRelations: allCurrent.length,
      totalWithReports: withReports.length,
      max,
      companies: selected.map(({ raw, ...c }) => c),
      skipped: skipped.map(({ raw, ...c }) => c),
      truncated: withReports.length > selected.length
    });
  } catch (e) {
    return json({ error: e.message || 'Błąd serwera.', details: e.details || null }, 500);
  }
}
