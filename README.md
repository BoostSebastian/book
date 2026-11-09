# Mina böcker

En liten webbapp (PWA) för att hålla koll på böcker:

- **Läser** – vad du läser just nu
- **Bokhylla** – böcker du äger
- **Önskelista** – böcker du vill införskaffa
- **Läst** – med datum, betyg och anteckningar

Fungerar i mobilen och på datorn, kan installeras på hemskärmen och fungerar offline.

## Funktioner

- Sök böcker på titel, författare eller ISBN (Google Books, med Open Library som reserv) – omslag och metadata fylls i automatiskt
- Skanna streckkoden (ISBN) med kameran i webbläsare som stödjer det (t.ex. Chrome på Android)
- Snabbknappar: *Köpt* (önskelista → bokhylla), *Börja läsa*, *Utläst*
- Betyg 1–5 och anteckningar
- Export/import som JSON (backup eller flytt mellan enheter)
- Ljust och mörkt läge

All data sparas lokalt i webbläsaren (`localStorage`) – inget konto, ingen server.

## Köra lokalt

Ingen byggprocess behövs. Starta valfri statisk webbserver i mappen, t.ex.:

```sh
python3 -m http.server 8000
```

och öppna <http://localhost:8000>.

## Publicera gratis med GitHub Pages

1. Repo → **Settings → Pages**
2. *Source*: **Deploy from a branch**, välj branchen och mappen `/ (root)`
3. Öppna adressen du får (t.ex. `https://<användare>.github.io/book/`) i mobilen
4. **iPhone:** Dela → *Lägg till på hemskärmen*. **Android:** menyn → *Installera app*

## Filer

| Fil | Innehåll |
| --- | --- |
| `index.html` | Sidan och dialogerna |
| `styles.css` | Utseende (mobil först, ljust/mörkt läge) |
| `app.js` | All logik: lagring, sök, skanning, redigering, export/import |
| `sw.js` | Service worker för offlinestöd |
| `manifest.webmanifest`, `icon*` | Gör appen installerbar |
