# Mina böcker

En webbapp (PWA) för hela familjen:

- **Läser** – vad var och en läser just nu, och **hur långt man kommit** (sida, procent, stapel per person)
- **Bokhylla** – familjens gemensamma bokhylla, med vem som har läst vad
- **Önskelista** – per person (t.ex. Klaras önskelista)
- **Läst** – med datum, betyg och anteckningar per person

Dessutom:

- **Visuell bokhylla** – bokhyllan visas som bokryggar på hyllplan (färgen hämtas från omslaget, tjockleken från antal sidor). Tryck på en bok för att se den.
- **Riktiga bokryggar** – fota hyllan och dra en ruta runt varje bokrygg (📷 *Rygg* i bokvyn), så ser hyllan i appen ut som din riktiga.
  Ta gärna en bild på hela hyllan och välj *Använd förra bilden* för nästa bok. Under *Redigera → Bokrygg* kan du också sätta färg och mått (cm).
- **Omslag** – hämtas automatiskt (Google Books / Open Library). Under *Redigera → Byt omslag* kan du välja bland flera omslag eller ta en bild på din egen bok.
- **Läs epub** – importera dina epub-filer (＋ → *Importera epub-filer*, eller *＋ Epub* på en bok) och läs direkt i appen.
  Appen kommer ihåg var du är och uppdaterar hur långt du kommit, så resten av familjen ser det.
  Epub-filerna sparas på den enhet där du importerar dem (de synkas inte).

Välj **Alla** eller en person (Sebastian, Matilda, Melker, Klara…) överst för att se vad just den läser.
Läser flera samma bok syns allas framsteg på samma kort.

Fungerar i mobilen och på datorn, kan installeras på hemskärmen och fungerar offline.
Ändringar synkas mellan enheterna via [Supabase](https://supabase.com) (gratis).

## Hur familjen fungerar

- Familjen delar **ett konto** (en e-post + lösenord). Barnen behöver alltså ingen egen e-post.
- Varje person är en **profil** i familjen. På varje enhet väljer man vem man är (tryck på bilden uppe till höger för att byta).
- Man kan uppdatera även andras läsning – t.ex. fylla i hur långt barnen kommit.
- Allt sparas först lokalt och skickas sedan till servern, så appen fungerar utan nät och synkar när nätet är tillbaka.
  Andra enheter uppdateras direkt (realtid).

## Kom igång med synk (ca 10 min, en gång)

1. Skapa ett gratiskonto på <https://supabase.com> och ett nytt projekt (välj region *Stockholm/EU*).
2. Öppna **SQL Editor → New query**, klistra in hela innehållet i [`supabase/schema.sql`](supabase/schema.sql) och tryck **Run**.
3. Gå till **Project Settings → API** (eller knappen **Connect**) och kopiera
   - *Project URL*
   - *anon / publishable key*

   in i [`config.js`](config.js). Nyckeln är publik och får ligga i repot – datan skyddas av radnivåsäkerheten i databasen.
4. *(Valfritt men enklast)* **Authentication → Sign In / Providers → Email**: stäng av *Confirm email*,
   så slipper du bekräfta via mejl.
5. Publicera appen (se nedan), öppna den, skriv ditt namn och lägg till familjen under **⋯**.
   Tryck sedan **Skapa familjekonto** under **⋯ → Synk**.
6. På Matildas telefon: öppna appen → *Logga in först* → samma e-post och lösenord → välj **Matilda**.
7. *(Valfritt)* När kontot är skapat: **Authentication → Sign In / Providers** → stäng av
   *Allow new users to sign up*, så kan ingen annan skapa konton i ditt projekt.

Utan `config.js` ifyllt fungerar appen precis som innan, fast bara lokalt i webbläsaren.
Data från den första versionen flyttas automatiskt till din profil.

## Publicera gratis med GitHub Pages

1. Repo → **Settings → Pages**
2. *Source*: **Deploy from a branch**, välj branchen och mappen `/ (root)`
3. Öppna adressen (t.ex. `https://<användare>.github.io/book/`) i mobilen
4. **iPhone:** Dela → *Lägg till på hemskärmen*. **Android:** menyn → *Installera app*

## Köra lokalt

Ingen byggprocess behövs:

```sh
python3 -m http.server 8000
```

och öppna <http://localhost:8000>.

## Filer

| Fil | Innehåll |
| --- | --- |
| `index.html` | Sidan och dialogerna |
| `styles.css` | Utseende (mobil först, ljust/mörkt läge) |
| `app.js` | All logik: lagring, synk, familjeprofiler, sök, skanning, export/import |
| `config.js` | Supabase-adress och publik nyckel |
| `supabase/schema.sql` | Databastabeller och behörigheter |
| `vendor/` | Supabase-klienten (2.118) och epub-läsaren (epub.js + JSZip), lokala kopior så allt fungerar offline |
| `sw.js` | Service worker för offlinestöd |
| `manifest.webmanifest`, `icon*` | Gör appen installerbar |
