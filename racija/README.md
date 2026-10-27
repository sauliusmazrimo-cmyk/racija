# Racija v0.3

Push-to-talk racija: laikai mygtuką ir kalbi, kiti girdi realiu laiku.

## Funkcijos
- Grupės (kanalai) su slaptažodžiais. Kvietimas: QR kodas, nuoroda arba pavadinimas ir slaptažodis.
- Kūrėjai (👑): gali valyti istoriją visiems, keisti slaptažodį, ištrinti kanalą, paskirti kitus kūrėjus (paspaudus nario vardą).
- Administratorius (🛡️): mato visus kanalus, įeina be slaptažodžio, keičia slaptažodžius, nuima kūrėjus, trina kanalus.
- Įrašai automatiškai trinami po 48 val.

## Railway kintamieji (Variables)
- `ADMIN_KEY`: administratoriaus raktas (būtinas admin režimui).
- `RETENTION_HOURS`: po kiek valandų trinti įrašus (numatyta 48).

## Railway Volume
Ctrl+K → "Volume" → servisas `racija` → Mount path `/data`. Be jo duomenys dings po kiekvieno deploy.
Patikrinti: /health → `"persistent": true`.
