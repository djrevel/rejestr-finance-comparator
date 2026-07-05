'use client';

import { useMemo, useState } from 'react';

const MAX_COMPANIES = 20;
const DEFAULT_IDS = Array.from({ length: MAX_COMPANIES }, () => '');

function toNumber(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/\s/g, '').replace(',', '.'));
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function formatMoney(v) {
  const n = toNumber(v);
  if (n === null) return <span className="empty">—</span>;
  return n.toLocaleString('pl-PL', { maximumFractionDigits: 0 });
}

function formatValue(v, type = 'money') {
  const n = toNumber(v);
  if (n === null) return <span className="empty">—</span>;
  if (type === 'percent') return `${(n * 100).toLocaleString('pl-PL', { maximumFractionDigits: 1 })}%`;
  if (type === 'ratio') return n.toLocaleString('pl-PL', { maximumFractionDigits: 2 });
  if (type === 'days') return n.toLocaleString('pl-PL', { maximumFractionDigits: 0 });
  return n.toLocaleString('pl-PL', { maximumFractionDigits: 0 });
}

function downloadCsv(filename, rows, columns, isKpi = false) {
  const esc = (x) => `"${String(x ?? '').replaceAll('"', '""')}"`;
  const header = ['Opis', 'Suma', ...columns.map(c => c.name ? `${c.name} (KRS: ${c.id})` : `KRS: ${c.id}`)].map(esc).join(';');
  const lines = rows.map(r => {
    const vals = [
      `${'  '.repeat(r.depth || 0)}${r.label}${isKpi && r.note ? ` (${r.note})` : ''}`,
      r.sum ?? '',
      ...columns.map(c => r.values?.[c.id] ?? '')
    ];
    return vals.map(esc).join(';');
  });
  const blob = new Blob(['\ufeff' + [header, ...lines].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function ColumnHeader({ column }) {
  return (
    <div className="col-head">
      {column.name ? <div className="company-name">{column.name}</div> : null}
      <div className="company-id">KRS: {column.id}</div>
    </div>
  );
}

function FinanceTable({ title, rows = [], columns = [], filename }) {
  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2>{title}</h2>
        <button className="secondary" onClick={() => downloadCsv(filename, rows, columns)} disabled={!rows.length}>CSV</button>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="desc">Opis</th>
              <th className="sum">Suma</th>
              {columns.map(c => <th key={c.id}><ColumnHeader column={c} /></th>)}
            </tr>
          </thead>
          <tbody>
            {!rows.length && (
              <tr><td className="desc" colSpan={2 + columns.length}>Brak danych do wyświetlenia.</td></tr>
            )}
            {rows.map((r, idx) => (
              <tr key={`${r.key}-${idx}`}>
                <td className={`desc depth-${Math.min(r.depth || 0, 2)}`}>
                  <span className="row-label" style={{ paddingLeft: `${(r.depth || 0) * 18}px` }}>{r.label}</span>
                </td>
                <td className="sum">{formatMoney(r.sum)}</td>
                {columns.map(c => <td key={c.id}>{formatMoney(r.values?.[c.id])}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function KpiTable({ rows = [], columns = [] }) {
  return (
    <section>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
        <h2>KPI finansowe</h2>
        <button className="secondary" onClick={() => downloadCsv('kpi.csv', rows, columns, true)} disabled={!rows.length}>CSV</button>
      </div>
      <p className="kpi-note">KPI są liczone automatycznie po etykietach pozycji ze sprawozdań. EBITDA jest dostępna tylko wtedy, gdy w RZiS występuje amortyzacja. Rotacja zapasów używa kosztu własnego sprzedaży, jeśli został znaleziony, a w przeciwnym razie przychodów.</p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th className="desc">Wskaźnik</th>
              <th className="sum">Suma / grupa</th>
              {columns.map(c => <th key={c.id}><ColumnHeader column={c} /></th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.key}>
                <td className="desc">
                  <strong>{r.label}</strong>
                  {r.note ? <div className="small">{r.note}</div> : null}
                </td>
                <td className="sum">{formatValue(r.sum, r.type)}</td>
                {columns.map(c => <td key={c.id}>{formatValue(r.values?.[c.id], r.type)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default function Page() {
  const [ids, setIds] = useState(DEFAULT_IDS);
  const [personInput, setPersonInput] = useState('');
  const [personLoading, setPersonLoading] = useState(false);
  const [personError, setPersonError] = useState('');
  const [personResult, setPersonResult] = useState(null);
  const [periodStart, setPeriodStart] = useState('2024-01-01');
  const [periodEnd, setPeriodEnd] = useState('2024-12-31');
  const [valueField, setValueField] = useState('pln_rok_obrotowy_biezacy');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [data, setData] = useState(null);

  const activeCount = useMemo(() => ids.filter(x => x.trim()).length, [ids]);
  const warnings = useMemo(() => {
    if (!data?.companies) return [];
    return data.companies.flatMap(c => [
      ...(c.error ? [`${c.kind || ''} ${c.display}: ${c.error}`] : []),
      ...(c.warnings || []).map(w => `${c.kind || ''} ${c.display}: ${w}`)
    ]);
  }, [data]);

  async function loadPersonCompanies() {
    setPersonLoading(true);
    setPersonError('');
    setPersonResult(null);
    try {
      const res = await fetch('/api/person-companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ personInput, periodStart, periodEnd, max: MAX_COMPANIES })
      });
      const json = await res.json();
      if (!res.ok) {
        setPersonError(json.error ? `${json.error}${json.details ? `\n${JSON.stringify(json.details, null, 2)}` : ''}` : 'Błąd pobierania powiązań osoby.');
        return;
      }

      const next = Array.from({ length: MAX_COMPANIES }, (_, i) => json.companies?.[i]?.krs || json.companies?.[i]?.preferredId || '');
      setIds(next);
      setPersonResult(json);
    } catch (e) {
      setPersonError(e?.message || String(e));
    } finally {
      setPersonLoading(false);
    }
  }

  async function compare() {
    setLoading(true);
    setError('');
    setData(null);
    try {
      const res = await fetch('/api/compare', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, periodStart, periodEnd, valueField })
      });
      const json = await res.json();
      if (!res.ok) {
        setError(json.error ? `${json.error}${json.details ? `\n${JSON.stringify(json.details, null, 2)}` : ''}` : 'Błąd pobierania danych.');
        return;
      }
      setData(json);
    } catch (e) {
      setError(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  }

  return (
    <main>
      <h1>Porównywarka bilansu, RZiS i KPI — Rejestr.io</h1>
      <p className="lead">Wpisz do 20 numerów KRS. Możesz wpisać KRS z zerami albo bez zer, np. 0000957242 albo 957242. Możesz też wkleić ID albo link osoby z Rejestr.io — aplikacja wypełni pola aktualnie powiązanymi spółkami po numerach KRS, które mają dokumenty finansowe w wybranym okresie.</p>

      <div className="card">
        <div className="person-loader">
          <div className="control person-input">
            <label>Osoba z Rejestr.io — ID albo link</label>
            <input
              value={personInput}
              placeholder="np. 123456 albo https://rejestr.io/osoby/123456/jan-kowalski"
              onChange={e => setPersonInput(e.target.value)}
            />
          </div>
          <button onClick={loadPersonCompanies} disabled={personLoading || !personInput.trim()}>
            {personLoading ? 'Szukam spółek…' : 'Wczytaj spółki osoby'}
          </button>
        </div>

        {personError ? <pre className="error">{personError}</pre> : null}
        {personResult ? (
          <div className="person-result">
            Wczytano <strong>{personResult.companies.length}</strong> z <strong>{personResult.totalWithReports}</strong> aktualnie powiązanych spółek z dokumentami dla okresu.
            {personResult.truncated ? ` Pokazuję pierwsze ${MAX_COMPANIES}; pozostałe można dopisać ręcznie.` : ''}
            {personResult.skipped?.length ? <div className="small">Pominięto {personResult.skipped.length} spółek bez dokumentów w wybranym okresie albo z błędem odczytu.</div> : null}
          </div>
        ) : null}

        <div className="form-grid">
          {ids.map((id, idx) => (
            <input
              key={idx}
              value={id}
              placeholder={`KRS #${idx + 1}`}
              onChange={(e) => {
                const next = [...ids];
                next[idx] = e.target.value;
                setIds(next);
              }}
            />
          ))}
        </div>

        <div className="controls">
          <div className="control">
            <label>Data od</label>
            <input value={periodStart} onChange={e => setPeriodStart(e.target.value)} />
          </div>
          <div className="control">
            <label>Data do</label>
            <input value={periodEnd} onChange={e => setPeriodEnd(e.target.value)} />
          </div>
          <div className="control">
            <label>Wartości</label>
            <select value={valueField} onChange={e => setValueField(e.target.value)}>
              <option value="pln_rok_obrotowy_biezacy">Rok bieżący z dokumentu</option>
              <option value="pln_rok_obrotowy_poprzedni">Rok poprzedni z dokumentu</option>
            </select>
          </div>
          <button onClick={compare} disabled={loading || activeCount === 0}>{loading ? 'Pobieram…' : 'Pobierz i porównaj'}</button>
        </div>
      </div>

      {error ? <pre className="error">{error}</pre> : null}

      {data ? (
        <>
          <div className="meta">
            <span className="badge">Okres żądany: {data.periodStart} – {data.periodEnd}</span>
            <span className="badge">Kolumny: {data.columns.length}</span>
            <span className="badge">Pole wartości: {data.valueField}</span>
          </div>

          {warnings.length ? (
            <div className="warn">
              <strong>Uwagi:</strong>
              <ul>
                {warnings.map((w, i) => <li key={i}>{w}</li>)}
              </ul>
            </div>
          ) : null}

          <FinanceTable title="Aktywa" rows={data.tables.assets} columns={data.columns} filename="aktywa.csv" />
          <FinanceTable title="Pasywa" rows={data.tables.liabilities} columns={data.columns} filename="pasywa.csv" />
          <FinanceTable title="Rachunek zysków i strat" rows={data.tables.pnl} columns={data.columns} filename="rzis.csv" />
          <KpiTable rows={data.tables.kpis} columns={data.columns} />
        </>
      ) : null}
    </main>
  );
}
