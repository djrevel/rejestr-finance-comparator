export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const API_BASE = 'https://rejestr.io/api/v2';
const CURRENT_FIELD = 'pln_rok_obrotowy_biezacy';
const PREVIOUS_FIELD = 'pln_rok_obrotowy_poprzedni';
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

function keyText(s) {
  return normalizeText(s)
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function stripLeadingZerosForKrs(digits) {
  const stripped = String(digits || '').replace(/^0+/, '');
  return stripped || '0';
}

function uniqueCandidates(candidates) {
  const seen = new Set();
  return candidates.filter(c => {
    const key = `${c.kind}:${c.orgId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeOrgId(inputRaw) {
  const raw = String(inputRaw || '').trim();
  if (!raw) return null;

  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D/g, '');
  if (!digits) return null;

  // Jawne prefiksy usuwają niejednoznaczność pełnych 10-cyfrowych numerów:
  // "NIP 5882421573" -> tylko NIP, "KRS 0000956152" -> tylko KRS.
  if (/^nip\b|^nip[:#-]/i.test(lower) || /^nip\s*[0-9]/i.test(lower)) {
    if (digits.length !== 10) return null;
    return {
      raw,
      display: digits,
      kind: 'NIP',
      orgId: `nip${digits}`,
      candidates: [{ orgId: `nip${digits}`, display: digits, kind: 'NIP' }]
    };
  }

  if (/^krs\b|^krs[:#-]/i.test(lower) || /^krs\s*[0-9]/i.test(lower)) {
    if (digits.length < 1 || digits.length > 10) return null;
    const orgId = stripLeadingZerosForKrs(digits);
    return {
      raw,
      display: digits.padStart(10, '0'),
      kind: 'KRS',
      orgId,
      candidates: [{ orgId, display: digits.padStart(10, '0'), kind: 'KRS' }]
    };
  }

  // Bez prefiksu:
  // - 10 cyfr jest niejednoznaczne (NIP albo pełny KRS z zerami).
  //   Próbujemy najpierw NIP, a jeśli Rejestr.io zwróci błąd, potem KRS.
  // - mniej niż 10 cyfr traktujemy jako KRS.
  if (digits.length === 10) {
    const krsOrgId = stripLeadingZerosForKrs(digits);
    const candidates = uniqueCandidates([
      { orgId: `nip${digits}`, display: digits, kind: 'NIP' },
      { orgId: krsOrgId, display: digits.padStart(10, '0'), kind: 'KRS' }
    ]);
    return { raw, display: digits, kind: 'AUTO', orgId: candidates[0].orgId, candidates };
  }

  if (digits.length > 0 && digits.length < 10) {
    const orgId = stripLeadingZerosForKrs(digits);
    return {
      raw,
      display: digits.padStart(10, '0'),
      kind: 'KRS',
      orgId,
      candidates: [{ orgId, display: digits.padStart(10, '0'), kind: 'KRS' }]
    };
  }

  return null;
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

async function fetchOrgBasic(orgId) {
  return await fetchRejestrJson(`/org/${encodeURIComponent(orgId)}`);
}

function unwrapValue(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && '_wartosc' in v) return v._wartosc;
  return v;
}

function firstNonEmptyString(values) {
  for (const v of values) {
    const unwrapped = unwrapValue(v);
    if (typeof unwrapped === 'string' && unwrapped.trim()) return unwrapped.trim();
    if (typeof unwrapped === 'number' && Number.isFinite(unwrapped)) return String(unwrapped);
  }
  return '';
}

function extractCompanyName(orgData) {
  if (!orgData || typeof orgData !== 'object') return '';

  // Podstawowy endpoint Rejestr.io zwykle zwraca nazwy.pelna i nazwy.skrocona.
  const direct = firstNonEmptyString([
    orgData?.nazwy?.pelna,
    orgData?.nazwy?.skrocona,
    orgData?.nazwa,
    orgData?.nazwa_pelna,
    orgData?.firma,
    orgData?.dane?.nazwy?.pelna,
    orgData?.dane?.nazwy?.skrocona,
    orgData?.dane?.nazwa,
    orgData?.dane?.firma
  ]);
  if (direct) return direct;

  // Fallback dla bardziej zagnieżdżonych struktur: szukamy pól z nazwą podmiotu.
  const candidates = [];
  function walk(obj, path = '') {
    if (!obj || typeof obj !== 'object' || candidates.length >= 20) return;
    for (const [k, v] of Object.entries(obj)) {
      const nextPath = path ? `${path}.${k}` : k;
      const key = normalizeText(k);
      const val = unwrapValue(v);
      if (typeof val === 'string' && val.trim()) {
        if (/nazwa|firma/.test(key) && !/organ|rejestr|forma|ulica|miejscowosc/.test(key)) {
          candidates.push({ path: nextPath, value: val.trim() });
        }
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, nextPath);
      }
    }
  }
  walk(orgData);

  const preferred = candidates.find(c => /pelna|firma|nazwa/.test(normalizeText(c.path)));
  return preferred?.value || candidates[0]?.value || '';
}

async function fetchDocumentList(orgId) {
  return await fetchRejestrJson(`/org/${encodeURIComponent(orgId)}/krs-dokumenty`);
}

async function fetchDocumentJson(orgId, docId) {
  return await fetchRejestrJson(`/org/${encodeURIComponent(orgId)}/krs-dokumenty/${docId}`, { format: 'json' });
}

function selectPeriod(documentSets, periodStart, periodEnd) {
  if (!Array.isArray(documentSets)) return null;
  const exact = documentSets.find(s => s.data_start === periodStart && s.data_koniec === periodEnd);
  if (exact) return exact;

  // Fallback: rok końca okresu. Pomaga przy minimalnych różnicach dat albo przesuniętym roku obrotowym.
  const year = String(periodEnd || '').slice(0, 4);
  if (year) {
    const sameYear = documentSets.find(s => String(s.data_koniec || '').startsWith(year));
    if (sameYear) return sameYear;
  }

  // Ostatecznie najnowszy okres.
  return [...documentSets].sort((a, b) => String(b.data_koniec).localeCompare(String(a.data_koniec)))[0] || null;
}

function pickDocument(periodSet, wantedName) {
  const docs = periodSet?.dokumenty || [];
  const wanted = normalizeText(wantedName);
  const candidates = docs.filter(d => d.czy_ma_json);

  if (wanted.includes('bilans')) {
    return candidates.find(d => normalizeText(d.nazwa) === 'bilans')
      || candidates.find(d => normalizeText(d.nazwa).includes('bilans'))
      || null;
  }

  return candidates.find(d => normalizeText(d.nazwa).includes('rachunek zyskow i strat'))
    || candidates.find(d => normalizeText(d.nazwa).includes('zyskow i strat'))
    || null;
}

function cleanLabelPart(v) {
  return String(v || '').replace(/\s+/g, ' ').trim();
}

function looksLikeOrdinalLabel(v) {
  const s = cleanLabelPart(v);
  if (!s) return false;
  // Typowe oznaczenia pozycji w sprawozdaniach: A, A., I, II, 1, 1., a) itd.
  return /^[A-ZĄĆĘŁŃÓŚŹŻ]{1,3}\.?$/.test(s)
    || /^[IVXLCDM]{1,6}\.?$/i.test(s)
    || /^\d{1,3}\.?$/.test(s)
    || /^[a-z]\)?\.?$/i.test(s);
}

function labelOf(node) {
  const etykieta = cleanLabelPart(node?.etykieta);
  const podetykieta = cleanLabelPart(node?.podetykieta);
  const nazwa = cleanLabelPart(node?.nazwa_wezla);

  // W części JSON-ów Rejestr.io pole etykieta to tylko „A.” / „I.”,
  // a prawdziwa nazwa pozycji jest w podetykieta. Dla KPI i wyświetlania
  // wolimy wtedy podetykietę, bo inaczej np. kapitał własny nie jest znajdowany.
  if (podetykieta && (!etykieta || looksLikeOrdinalLabel(etykieta))) return podetykieta;
  if (etykieta && podetykieta && etykieta !== podetykieta) return `${etykieta} ${podetykieta}`;
  return etykieta || podetykieta || nazwa || '(bez nazwy)';
}

function searchTextOf(node, pathLabel = '') {
  const parts = [
    labelOf(node),
    node?.etykieta,
    node?.podetykieta,
    splitCamelCase(node?.nazwa_wezla || ''),
    node?.nazwa_wezla || '',
    pathLabel
  ];
  return parts.map(normalizeText).filter(Boolean).join(' | ');
}

function nodePartKey(node) {
  return keyText(labelOf(node) || node?.nazwa_wezla || 'node');
}

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const s = v.replace(/\s/g, '').replace(',', '.');
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function extractValueMap(node) {
  const out = {};

  function walk(obj, prefix = '') {
    if (!obj || typeof obj !== 'object') return;
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'podobiekty') continue;
      const path = prefix ? `${prefix}.${k}` : k;
      const n = toNumber(v);
      if (n !== null) {
        const simple = k.startsWith('pln_') ? k : path;
        out[simple] = (out[simple] || 0) + n;
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        walk(v, path);
      }
    }
  }

  walk(node);
  return out;
}

function getNodeValue(node, field = CURRENT_FIELD) {
  if (!node) return null;
  const direct = toNumber(node[field]);
  if (direct !== null) return direct;
  const map = extractValueMap(node);
  if (toNumber(map[field]) !== null) return toNumber(map[field]);

  const suffixKey = Object.keys(map).find(k => k.endsWith(`.${field}`) || k === field);
  return suffixKey ? toNumber(map[suffixKey]) : null;
}

function directChildren(node) {
  return Array.isArray(node?.podobiekty) ? node.podobiekty : [];
}

function findBalanceSection(root, wanted) {
  const wantedNorm = normalizeText(wanted);
  const children = directChildren(root);
  const direct = children.find(ch => normalizeText(labelOf(ch)).includes(wantedNorm));
  if (direct) return direct;

  const queue = [...children];
  while (queue.length) {
    const n = queue.shift();
    if (normalizeText(labelOf(n)).includes(wantedNorm)) return n;
    queue.push(...directChildren(n));
  }
  return null;
}

function flattenTree(node, valueField, depth = 0, parentKey = '') {
  if (!node) return [];
  const part = nodePartKey(node);
  const key = parentKey ? `${parentKey}>${part}` : part;
  const row = {
    key,
    label: labelOf(node),
    depth,
    value: getNodeValue(node, valueField),
    current: getNodeValue(node, CURRENT_FIELD),
    previous: getNodeValue(node, PREVIOUS_FIELD)
  };
  const rows = [row];
  for (const child of directChildren(node)) {
    rows.push(...flattenTree(child, valueField, depth + 1, key));
  }
  return rows;
}

function combineSectionRows(companies, sectionName, valueField) {
  const map = new Map();
  const order = [];

  for (const company of companies) {
    const rows = company.sections?.[sectionName] || [];
    for (const r of rows) {
      if (!map.has(r.key)) {
        map.set(r.key, {
          key: r.key,
          label: r.label,
          depth: r.depth,
          values: {},
          sum: 0
        });
        order.push(r.key);
      }
      const dest = map.get(r.key);
      const n = toNumber(r.value);
      dest.values[company.display] = n;
      if (n !== null) dest.sum += n;
    }
  }

  return order.map(k => map.get(k));
}

function splitCamelCase(s) {
  return String(s || '').replace(/([a-ząćęłńóśźż])([A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1 $2');
}

function flattenAllNodes(root, source) {
  const out = [];
  function walk(node, path = []) {
    if (!node) return;
    const label = labelOf(node);
    const nodeName = node?.nazwa_wezla || '';
    const pathLabel = [...path, label].join(' / ');
    const labelNorm = normalizeText(label);
    const nodeNameNorm = normalizeText(splitCamelCase(nodeName));
    const compactNodeNameNorm = normalizeText(nodeName);
    const pathNorm = normalizeText(pathLabel);
    const searchText = searchTextOf(node, pathLabel);

    const item = {
      node,
      source,
      label,
      labelNorm,
      nodeName,
      nodeNameNorm,
      compactNodeNameNorm,
      path: pathLabel,
      pathNorm,
      searchText,
      current: getNodeValue(node, CURRENT_FIELD),
      previous: getNodeValue(node, PREVIOUS_FIELD)
    };
    out.push(item);
    for (const child of directChildren(node)) walk(child, [...path, label]);
  }
  walk(root);
  return out;
}

function findMetric(nodes, includeRegex, options = {}) {
  const includes = Array.isArray(includeRegex) ? includeRegex : [includeRegex];
  const excludes = options.exclude ? (Array.isArray(options.exclude) ? options.exclude : [options.exclude]) : [];
  const source = options.source;

  const candidates = nodes.filter(n => {
    if (source && n.source !== source) return false;
    const text = options.labelOnly ? n.labelNorm : n.searchText;
    return includes.every(rx => rx.test(text)) && excludes.every(rx => !rx.test(text));
  });

  // Prefer rows with a numeric value and shortest path (often the aggregate row).
  // Then prefer aggregate-looking labels such as '... razem' and technical node names over nested details.
  return candidates
    .sort((a, b) => {
      const av = a.current !== null ? 0 : 1;
      const bv = b.current !== null ? 0 : 1;
      if (av !== bv) return av - bv;

      const ar = /razem|ogolem|suma/.test(a.labelNorm) ? 0 : 1;
      const br = /razem|ogolem|suma/.test(b.labelNorm) ? 0 : 1;
      if (ar !== br) return ar - br;

      return a.path.length - b.path.length;
    })[0] || null;
}

function avg(a, b) {
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an !== null && bn !== null) return (an + bn) / 2;
  if (an !== null) return an;
  if (bn !== null) return bn;
  return null;
}

function div(a, b) {
  const an = toNumber(a);
  const bn = toNumber(b);
  if (an === null || bn === null || bn === 0) return null;
  return an / bn;
}

function computeBaseMetrics(balanceRoot, pnlRoot) {
  const nodes = [
    ...flattenAllNodes(balanceRoot, 'balance'),
    ...flattenAllNodes(pnlRoot, 'pnl')
  ];

  const assets = findMetric(nodes, [/^aktywa razem$/], { source: 'balance' })
    || findMetric(nodes, [/aktywa.*razem|aktywarazem/], { source: 'balance' });
  const liabilitiesTotal = findMetric(nodes, [/^pasywa razem$/], { source: 'balance' })
    || findMetric(nodes, [/pasywa.*razem|pasywarazem/], { source: 'balance' });
  const equity = findMetric(nodes, [/^kapital\s*\(?fundusz\)?\s*wlasny$/], { source: 'balance', labelOnly: true })
    || findMetric(nodes, [/kapital.*fundusz.*wlasny|kapitalfunduszwlasny|kapital.*wlasny/], {
      source: 'balance',
      exclude: [/nalezny|wplaty|udzialy.*wlasne|kapital.*podstawowy|kapital.*zapasowy|kapital.*rezerwowy|zysk.*strata|wynik.*roku/]
    })
    || findMetric(nodes, [/^aktywa.*netto$/], { source: 'balance', labelOnly: true });
  const inventory = findMetric(nodes, [/^zapasy$/], { source: 'balance', labelOnly: true })
    || findMetric(nodes, [/zapasy/], { source: 'balance' });
  const currentAssets = findMetric(nodes, [/aktywa.*obrotowe|aktywaobrotowe/], { source: 'balance' });
  const shortLiabilities = findMetric(nodes, [/zobowiazania.*krotkoterminowe|zobowiazaniakrotkoterminowe/], { source: 'balance' });
  const debtAndProvisions = findMetric(nodes, [/^zobowiazania.*rezerwy.*zobowiazania$/], { source: 'balance', labelOnly: true })
    || findMetric(nodes, [/zobowiazania.*rezerwy.*zobowiazania|zobowiazaniairezerwynazobowiazania/], { source: 'balance' });

  const revenue = findMetric(nodes, [/przychody.*netto.*sprzedazy|przychodynettozesprzedazy/], { source: 'pnl' })
    || findMetric(nodes, [/przychody.*sprzedazy/], { source: 'pnl' })
    || findMetric(nodes, [/przychody netto/], { source: 'pnl' });
  const ebit = findMetric(nodes, [/zysk.*strata.*dzialalnosci.*operacyjnej|zyskstratazdzialalnoscioperacyjnej|wynik.*operacyjny|wynik.*dzialalnosci.*operacyjnej/], { source: 'pnl' });
  const ebt = findMetric(nodes, [/zysk.*strata.*brutto|zyskstratabrutto|wynik.*brutto/], { source: 'pnl', exclude: [/sprzedazy/] });
  const net = findMetric(nodes, [/zysk.*strata.*netto|zyskstratanetto|wynik.*netto/], { source: 'pnl' });
  const amort = findMetric(nodes, [/^amortyzacja$/], { source: 'pnl', labelOnly: true })
    || findMetric(nodes, [/amortyzacja/], { source: 'pnl' });
  const cogs = findMetric(nodes, [/koszt.*wlasny.*sprzedazy|kosztwlasnysprzedazy/], { source: 'pnl' });
  const financialIncome = findMetric(nodes, [/przychody.*finansowe|przychodyfinansowe/], { source: 'pnl' });
  const financialCosts = findMetric(nodes, [/koszty.*finansowe|kosztyfinansowe/], { source: 'pnl' });

  const ebtValue = ebt?.current ?? null;
  const finIncomeValue = financialIncome?.current ?? null;
  const finCostsValue = financialCosts?.current ?? null;
  const computedEbit = (ebit?.current ?? null) !== null
    ? ebit.current
    : (ebtValue !== null && (finIncomeValue !== null || finCostsValue !== null))
      ? ebtValue - (finIncomeValue || 0) + (finCostsValue || 0)
      : null;

  const m = {
    assets: assets?.current ?? null,
    assetsPrev: assets?.previous ?? null,
    liabilitiesTotal: liabilitiesTotal?.current ?? null,
    equity: (equity?.current ?? null) !== null
      ? equity.current
      : ((liabilitiesTotal?.current ?? null) !== null && (debtAndProvisions?.current ?? null) !== null
        ? liabilitiesTotal.current - debtAndProvisions.current
        : null),
    equityPrev: (equity?.previous ?? null) !== null
      ? equity.previous
      : ((liabilitiesTotal?.previous ?? null) !== null && (debtAndProvisions?.previous ?? null) !== null
        ? liabilitiesTotal.previous - debtAndProvisions.previous
        : null),
    revenue: revenue?.current ?? null,
    ebit: computedEbit,
    ebt: ebtValue,
    netProfit: net?.current ?? null,
    amortization: amort?.current ?? null,
    inventory: inventory?.current ?? null,
    inventoryPrev: inventory?.previous ?? null,
    currentAssets: currentAssets?.current ?? null,
    shortLiabilities: shortLiabilities?.current ?? null,
    cogs: cogs?.current ?? null,
    financialIncome: finIncomeValue,
    financialCosts: finCostsValue
  };

  m.ebitda = (m.ebit !== null && m.amortization !== null) ? m.ebit + m.amortization : null;
  return m;
}

function computeKpiFromMetrics(m) {
  const avgEquity = avg(m.equity, m.equityPrev);
  const avgInventory = avg(m.inventory, m.inventoryPrev);
  const inventoryBase = m.cogs !== null ? m.cogs : m.revenue;
  const inventoryTurnover = div(inventoryBase, avgInventory);

  return {
    revenue: m.revenue,
    ebit: m.ebit,
    ebitda: m.ebitda,
    ebt: m.ebt,
    netProfit: m.netProfit,
    equityRatio: div(m.equity, m.assets),
    rosNet: div(m.netProfit, m.revenue),
    ebitMargin: div(m.ebit, m.revenue),
    roe: div(m.netProfit, avgEquity),
    currentRatio: div(m.currentAssets, m.shortLiabilities),
    inventoryTurnover,
    inventoryDays: inventoryTurnover ? 365 / inventoryTurnover : null
  };
}

function sumMetrics(companies) {
  const keys = [
    'assets','assetsPrev','liabilitiesTotal','equity','equityPrev','revenue','ebit','ebt','netProfit','amortization',
    'inventory','inventoryPrev','currentAssets','shortLiabilities','cogs','financialIncome','financialCosts','ebitda'
  ];
  const out = {};
  for (const k of keys) {
    let sum = 0;
    let has = false;
    for (const c of companies) {
      const n = toNumber(c.metrics?.[k]);
      if (n !== null) { sum += n; has = true; }
    }
    out[k] = has ? sum : null;
  }
  return out;
}

const KPI_DEFS = [
  { key: 'revenue', label: 'Przychody netto ze sprzedaży', type: 'money' },
  { key: 'ebitda', label: 'EBITDA', type: 'money', note: 'EBIT + amortyzacja, jeśli amortyzacja występuje w RZiS.' },
  { key: 'ebit', label: 'EBIT', type: 'money', note: 'Zysk/strata z działalności operacyjnej wg RZiS.' },
  { key: 'ebt', label: 'EBT / zysk brutto', type: 'money' },
  { key: 'netProfit', label: 'Zysk netto', type: 'money' },
  { key: 'equityRatio', label: 'Kapitał własny / suma bilansowa', type: 'percent' },
  { key: 'rosNet', label: 'RoS netto', type: 'percent', note: 'Zysk netto / przychody.' },
  { key: 'ebitMargin', label: 'Marża EBIT', type: 'percent' },
  { key: 'roe', label: 'RoE', type: 'percent', note: 'Zysk netto / średni kapitał własny, jeśli dostępny poprzedni rok.' },
  { key: 'currentRatio', label: 'Current ratio', type: 'ratio', note: 'Aktywa obrotowe / zobowiązania krótkoterminowe.' },
  { key: 'inventoryTurnover', label: 'Rotacja zapasów', type: 'ratio', note: 'Koszt własny sprzedaży albo przychody / średnie zapasy.' },
  { key: 'inventoryDays', label: 'Zapasy w dniach', type: 'days' }
];

async function loadCompanyResolved(norm, periodStart, periodEnd, valueField) {
  const warnings = [];
  let name = '';
  try {
    const orgData = await fetchOrgBasic(norm.orgId);
    name = extractCompanyName(orgData);
  } catch (e) {
    warnings.push(`Nie udało się pobrać aktualnej nazwy spółki: ${e.message}`);
  }

  const list = await fetchDocumentList(norm.orgId);
  const selectedPeriod = selectPeriod(list, periodStart, periodEnd);
  if (!selectedPeriod) throw new Error('Nie znaleziono żadnego okresu sprawozdawczego.');

  if (selectedPeriod.data_start !== periodStart || selectedPeriod.data_koniec !== periodEnd) {
    warnings.push(`Użyto okresu ${selectedPeriod.data_start} – ${selectedPeriod.data_koniec}, bo nie znaleziono dokładnego okresu ${periodStart} – ${periodEnd}.`);
  }

  const balanceDoc = pickDocument(selectedPeriod, 'bilans');
  const pnlDoc = pickDocument(selectedPeriod, 'rachunek zysków i strat');

  if (!balanceDoc) warnings.push('Brak bilansu w JSON dla wybranego okresu.');
  if (!pnlDoc) warnings.push('Brak RZiS w JSON dla wybranego okresu.');

  const balance = balanceDoc ? await fetchDocumentJson(norm.orgId, balanceDoc.id) : null;
  const pnl = pnlDoc ? await fetchDocumentJson(norm.orgId, pnlDoc.id) : null;

  const balanceRoot = balance?.zawartosc || null;
  const pnlRoot = pnl?.zawartosc || null;
  const assetsRoot = findBalanceSection(balanceRoot, 'aktywa');
  const liabilitiesRoot = findBalanceSection(balanceRoot, 'pasywa');

  const sections = {
    assets: assetsRoot ? flattenTree(assetsRoot, valueField) : [],
    liabilities: liabilitiesRoot ? flattenTree(liabilitiesRoot, valueField) : [],
    pnl: pnlRoot ? flattenTree(pnlRoot, valueField) : []
  };

  const metrics = computeBaseMetrics(balanceRoot, pnlRoot);
  const kpis = computeKpiFromMetrics(metrics);

  return {
    orgId: norm.orgId,
    display: norm.display,
    kind: norm.kind,
    name,
    period: selectedPeriod ? { start: selectedPeriod.data_start, end: selectedPeriod.data_koniec } : null,
    docs: { balance: balanceDoc?.id || null, pnl: pnlDoc?.id || null },
    warnings,
    sections,
    metrics,
    kpis
  };
}


async function loadCompany(norm, periodStart, periodEnd, valueField) {
  const candidates = norm.candidates?.length ? norm.candidates : [norm];
  const errors = [];

  for (const candidate of candidates) {
    try {
      const loaded = await loadCompanyResolved(candidate, periodStart, periodEnd, valueField);
      const usedFallback = candidates.length > 1 && candidate.orgId !== candidates[0].orgId;
      return {
        ...loaded,
        input: norm.raw || norm.display,
        warnings: [
          ...(usedFallback ? [`Wpis ${norm.raw || norm.display} rozpoznano jako ${candidate.kind}, bo pierwszy wariant nie zadziałał.`] : []),
          ...(loaded.warnings || [])
        ]
      };
    } catch (e) {
      errors.push(`${candidate.kind} ${candidate.display}: ${e.message}`);
    }
  }

  const err = new Error(errors.join(' | ') || 'Nie udało się odczytać numeru jako NIP ani KRS.');
  err.details = errors;
  throw err;
}

export async function POST(req) {
  try {
    const body = await req.json();
    const ids = Array.isArray(body.ids) ? body.ids : [];
    const periodStart = body.periodStart || '2024-01-01';
    const periodEnd = body.periodEnd || '2024-12-31';
    const valueField = body.valueField || CURRENT_FIELD;

    const normalized = ids.map(normalizeOrgId).filter(Boolean).slice(0, 10);
    if (!normalized.length) return json({ error: 'Podaj co najmniej jeden NIP albo KRS.' }, 400);

    const results = [];
    for (const norm of normalized) {
      try {
        results.push(await loadCompany(norm, periodStart, periodEnd, valueField));
      } catch (e) {
        results.push({
          orgId: norm.orgId,
          display: norm.display,
          kind: norm.kind,
          name: '',
          error: e.message,
          warnings: e.details ? [JSON.stringify(e.details)] : [],
          sections: { assets: [], liabilities: [], pnl: [] },
          metrics: {},
          kpis: {}
        });
      }
    }

    const companiesOk = results.filter(r => !r.error);
    const aggregateMetrics = sumMetrics(companiesOk);
    const aggregateKpis = computeKpiFromMetrics(aggregateMetrics);

    const kpiRows = KPI_DEFS.map(def => ({
      key: def.key,
      label: def.label,
      type: def.type,
      note: def.note || '',
      sum: aggregateKpis[def.key] ?? aggregateMetrics[def.key] ?? null,
      values: Object.fromEntries(results.map(c => [c.display, c.kpis?.[def.key] ?? c.metrics?.[def.key] ?? null]))
    }));

    return json({
      periodStart,
      periodEnd,
      valueField,
      companies: results.map(({ sections, metrics, kpis, ...rest }) => rest),
      columns: results.map(r => ({ id: r.display, orgId: r.orgId, kind: r.kind, name: r.name || '', error: r.error || null })),
      tables: {
        assets: combineSectionRows(results, 'assets', valueField),
        liabilities: combineSectionRows(results, 'liabilities', valueField),
        pnl: combineSectionRows(results, 'pnl', valueField),
        kpis: kpiRows
      }
    });
  } catch (e) {
    return json({ error: e.message || 'Błąd serwera.', details: e.details || null }, 500);
  }
}
