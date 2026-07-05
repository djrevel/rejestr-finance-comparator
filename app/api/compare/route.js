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

function normalizeOrgId(inputRaw) {
  const raw = String(inputRaw || '').trim();
  if (!raw) return null;

  const alreadyNip = raw.match(/^nip\s*([0-9]{10})$/i);
  if (alreadyNip) return { orgId: `nip${alreadyNip[1]}`, display: alreadyNip[1], kind: 'NIP' };

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return { orgId: `nip${digits}`, display: digits, kind: 'NIP' };
  if (digits.length > 0 && digits.length <= 10) return { orgId: digits, display: digits.padStart(10, '0'), kind: 'KRS' };

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

function labelOf(node) {
  return node?.etykieta || node?.podetykieta || node?.nazwa_wezla || '(bez nazwy)';
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
    const searchText = [labelNorm, nodeNameNorm, compactNodeNameNorm, pathNorm].filter(Boolean).join(' | ');

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
  const equity = findMetric(nodes, [/kapital.*fundusz.*wlasny|kapitalfunduszwlasny|kapital.*wlasny/], {
      source: 'balance',
      exclude: [/nalezny|wplaty|udzialy.*wlasne|kapital.*podstawowy|kapital.*zapasowy|kapital.*rezerwowy|zysk.*strata/]
    })
    || findMetric(nodes, [/^kapital.*wlasny$/], { source: 'balance', labelOnly: true });
  const inventory = findMetric(nodes, [/^zapasy$/], { source: 'balance', labelOnly: true })
    || findMetric(nodes, [/zapasy/], { source: 'balance' });
  const currentAssets = findMetric(nodes, [/aktywa.*obrotowe|aktywaobrotowe/], { source: 'balance' });
  const shortLiabilities = findMetric(nodes, [/zobowiazania.*krotkoterminowe|zobowiazaniakrotkoterminowe/], { source: 'balance' });

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
    equity: equity?.current ?? null,
    equityPrev: equity?.previous ?? null,
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

async function loadCompany(norm, periodStart, periodEnd, valueField) {
  const warnings = [];
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
    period: selectedPeriod ? { start: selectedPeriod.data_start, end: selectedPeriod.data_koniec } : null,
    docs: { balance: balanceDoc?.id || null, pnl: pnlDoc?.id || null },
    warnings,
    sections,
    metrics,
    kpis
  };
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
      columns: results.map(r => ({ id: r.display, orgId: r.orgId, kind: r.kind, error: r.error || null })),
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
