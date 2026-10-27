# Racija (MVP)

Push-to-talk racija vairuotojams: laikai mygtuką – kalbi, kiti girdi realiu laiku.

## Paleidimas lokaliai
    npm install
    npm start
Atidaryk http://localhost:3000 (mikrofonas veikia tik localhost arba HTTPS).

## Railway
1. Įkelk šį aplanką į naują GitHub repo.
2. Railway → New Project → Deploy from GitHub → pasirink repo.
3. Settings → Networking → Generate Domain.
4. Atidaryk gautą https adresą dviejuose telefonuose, įvesk vardus ir tą patį kanalą.

## Kaip veikia
- Balsas: 16 kHz mu-law (~16 KB/s kalbant), siunčiamas per WebSocket /ws.
- Kanale vienu metu kalba tik vienas, kiti mato „Užimta".
- Viena žinutė ilgiausiai 60 s; paskutinės 50 žinučių laikomos atmintyje (dingsta perkrovus serverį).
- Kompiuteryje kalbėti galima laikant tarpo klavišą.
