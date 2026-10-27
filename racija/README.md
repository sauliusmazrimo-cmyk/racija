# Racija v0.2

Push-to-talk racija vairuotojams: laikai mygtuką ir kalbi, kiti girdi realiu laiku.

## Funkcijos
- Grupės (kanalai) su slaptažodžiais. Kūrėjas (👑) gali išvalyti istoriją visiems, keisti slaptažodį ir ištrinti kanalą.
- Kvietimas: QR kodas, nuoroda (WhatsApp/Viber) arba pavadinimas ir slaptažodis.
- Istoriją galima išvalyti tik sau arba visiems (kūrėjui).
- Atsijungimas, kanalų sąrašas telefone.
- Kanalai ir įrašai saugomi diske (`data/`), todėl išlieka po perkrovimo.

## Railway: duomenų išsaugojimas
Be Volume disko duomenys dings po kiekvieno deploy. Ką padaryti:
Ctrl+K → "Volume" → pasirink servisą `racija` → Mount path `/data`.
Railway pats nustatys `RAILWAY_VOLUME_MOUNT_PATH`, ir serveris ten saugos duomenis.

## Lokaliai
    npm install
    npm start
