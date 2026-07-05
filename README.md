# Porównywarka bilansu, RZiS i KPI — Rejestr.io

Aplikacja Next.js gotowa do wdrożenia na Vercel. Działa jako jedna strona + backend `/api/compare`, który trzyma klucz API po stronie serwera.

## Co robi

- wpisanie do 10 numerów NIP albo KRS,
- pobranie z Rejestr.io bilansu i rachunku zysków i strat dla wskazanego okresu,
- tabela: opis | suma | spółka 1 | spółka 2 | ...,
- osobne tabele: Aktywa, Pasywa, RZiS,
- tabela KPI: EBITDA, EBIT, EBT, kapitał własny/suma bilansowa, RoS, RoE, rotacja zapasów itd.,
- eksport CSV dla każdej tabeli.


## NIP czy KRS

W polach możesz wpisać:

- `5882421573` — aplikacja potraktuje 10 cyfr najpierw jako NIP,
- `NIP 5882421573` — wymusza NIP,
- `956152` — traktowane jako KRS,
- `KRS 0000956152` — wymusza KRS, również z zerami wiodącymi.

Jeżeli wpiszesz 10 cyfr bez prefiksu, aplikacja spróbuje najpierw wariantu NIP, a jeśli Rejestr.io nie zwróci dokumentów, automatycznie spróbuje wariantu KRS.

## Wdrożenie na Vercel — najprościej

1. Załóż konto na https://vercel.com.
2. Utwórz nowe repozytorium GitHub, np. `rejestr-finance-comparator`.
3. Wrzuć do niego wszystkie pliki z tej paczki.
4. W Vercel kliknij **Add New → Project** i wybierz repozytorium.
5. W sekcji **Environment Variables** dodaj:

   ```text
   REJESTR_API_KEY = twój_klucz_api_rejestr_io
   ```

6. Kliknij **Deploy**.

Po wdrożeniu dostaniesz adres w stylu:

```text
https://twoj-projekt.vercel.app
```

## Uruchomienie lokalne do testu

```bash
npm install
cp .env.example .env.local
# wpisz REJESTR_API_KEY do .env.local
npm run dev
```

## Ważne

- Klucz Rejestr.io musi być ustawiony jako zmienna środowiskowa `REJESTR_API_KEY`.
- Nie wpisuj klucza w kod frontendu.
- Pobieranie dokumentów finansowych JSON może generować koszt po stronie Rejestr.io.
- Aplikacja ma prosty cache pamięciowy na ok. 6 godzin, ale na Vercel free/hobby cache nie jest trwały między zimnymi startami funkcji.

## Jak liczone są KPI

- EBIT: pozycja „Zysk/strata z działalności operacyjnej”.
- EBITDA: EBIT + amortyzacja, jeśli pozycja amortyzacji jest w RZiS.
- EBT: „Zysk/strata brutto”.
- RoS netto: zysk netto / przychody.
- RoE: zysk netto / średni kapitał własny, jeśli dostępny poprzedni rok.
- Rotacja zapasów: koszt własny sprzedaży / średnie zapasy; jeśli nie ma kosztu własnego sprzedaży, używa przychodów / średnie zapasy.

Wskaźniki są rozpoznawane po etykietach pozycji w sprawozdaniach. Przy nietypowych schematach warto sprawdzić ręcznie pozycje źródłowe.

## Kolumny z nazwami spółek

Nagłówki kolumn pokazują aktualną nazwę spółki pobraną z podstawowego endpointu Rejestr.io `/org/{id}` oraz poniżej identyfikator użyty w zapytaniu, np. `NIP: 5882421573` albo `KRS: 0000956152`.
