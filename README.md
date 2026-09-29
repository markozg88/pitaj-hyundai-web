# Pitaj Hyundai – web modul

Statična stranica modula „Pitaj Hyundai” za aplikaciju vjernosti (ugovor: `docs/phoebe-modules.md` u glavnom repozitoriju `pitaj-hyundai`).

- `index.html` – modul (čita `window.__PHOEBE_MODULE__`; bez aplikacije radi u demo načinu s izbornikom modela)
- `manuals.js` – popis priručnika
- `index/<šifra>.json` – indeksi priručnika s hyundai.hr, učitavaju se po potrebi

Objavljeno preko GitHub Pages. Izvor i alat za obradu: `markozg88/pitaj-hyundai`.

## Poslužitelj modula (Vercel)

- `api/ask` – POST `{ token, model, question, image?, history? }` → `text/event-stream` (događaji `sources`, `status`, `delta`, `done`, `error`). Provjeri token na BFF-u, pretraži indeks, pozove Claude, javi `question_answered`.
- `api/health` – GET, stanje konfiguracije.

Varijable okruženja (Vercel → Settings → Environment Variables):

| Varijabla | Vrijednost |
| --- | --- |
| `ANTHROPIC_API_KEY` | ključ iz console.anthropic.com |
| `PHOEBE_BFF_URL` | `https://cms-staging.phoebesoft.app` (produkcija: drugi URL) |
| `PHOEBE_MACHINE_KEY` | strojni ključ `module:write` (`pvm_hyundai_…`) |
| `ALLOW_DEMO` | `1` dopušta upite bez tokena (obični preglednik, za test); u produkciji izostaviti |
| `ANTHROPIC_MODEL` | (opcionalno) model za odgovore, zadano `claude-sonnet-5-5` |
| `ANTHROPIC_QUICK_MODEL` | (opcionalno) model za opis fotografije, zadano `claude-haiku-4-5-20251001` |
| `DAILY_LIMIT` | (opcionalno) upita po korisniku dnevno, zadano 30 |

Bez `ANTHROPIC_API_KEY` stranica radi u načinu "samo odlomci".
