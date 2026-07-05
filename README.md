# Porównywarka bilansu, RZiS i KPI — Rejestr.io

Aplikacja Next.js gotowa do wdrożenia na Vercel. Działa jako jedna strona + backend `/api/compare`, który trzyma klucz API po stronie serwera.

## Co robi

- wpisanie do 20 numerów KRS,
- pobranie z Rejestr.io bilansu i rachunku zysków i strat dla wskazanego okresu,
- tabela: opis | suma | spółka 1 | spółka 2 | ...,
- osobne tabele: Aktywa, Pasywa, RZiS,
- tabela KPI: EBITDA, EBIT, EBT, kapitał własny/suma bilansowa, RoS, RoE, rotacja zapasów itd.,
- eksport CSV dla każdej tabeli,
- wczytanie aktualnie powiązanych spółek po ID/linku osoby z Rejestr.io i automatyczne uzupełnienie pól KRS.


## Wczytywanie spółek po osobie z Rejestr.io

Nad polami KRS jest sekcja **Osoba z Rejestr.io — ID albo link**. Możesz wkleić np.:

```text
123456
https://rejestr.io/osoby/123456/jan-kowalski
```

Aplikacja odpytuje endpoint `GET /api/v2/osoby/{id}/krs-powiazania?aktualnosc=aktualne`, pomija spółki wykreślone oraz te bez dokumentów finansowych w wybranym okresie, a następnie uzupełnia maksymalnie 20 pól KRS. Jeśli powiązanych spółek jest więcej niż 20, pozostałe można dopisać ręcznie.

## Identyfikatory spółek: KRS

Od tej wersji porównywarka przyjmuje w polach wyłącznie numery KRS. Możesz wpisać KRS z zerami lub bez zer, np.:

- `0000957242`
- `957242`
- `KRS 0000957242`

Import spółek z powiązań osoby również uzupełnia pola numerami KRS. Dzięki temu unikamy błędu 409 z Rejestr.io, który może wystąpić, gdy jeden NIP jest przypisany do więcej niż jednej organizacji.

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

Nagłówki kolumn pokazują aktualną nazwę spółki pobraną z podstawowego endpointu Rejestr.io `/org/{id}` oraz poniżej identyfikator użyty w zapytaniu, np. `KRS: 0000956152`.
