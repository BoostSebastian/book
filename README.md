# Mina böcker

En webbapp (PWA) för hela familjen:

- **Läser** – vad var och en läser just nu, och **hur långt man kommit** (sida, procent, stapel per person)
- **Bokhylla** – familjens gemensamma bokhylla, med vem som har läst vad
- **Önskelista** – per person (t.ex. Klaras önskelista)
- **Läst** – med datum, betyg och anteckningar per person

Dessutom:

- **Visuell bokhylla** – bokhyllan visas som bokryggar på hyllplan (färgen hämtas från omslaget, tjockleken från antal sidor). Tryck på en bok för att se den.
- **Statistik (📊)** – läsåret per person eller för hela familjen: antal böcker och sidor, per månad, genrer, stämning, högst betyg, längsta/kortaste och alla omslag.
- **Ljudböcker** – markera 🎧 när någon lyssnat på en bok. De får en egen hylla (*Bokhylla → 🎧 Ljudböcker*) och räknas för sig i statistiken.
- **Genre och sidantal** fylls i automatiskt från Google Books och kan ändras under *Redigera*.
- **Riktiga bokryggar** – fota hyllan och dra en ruta runt varje bokrygg (📷 *Rygg* i bokvyn), så ser hyllan i appen ut som din riktiga.
  Ta gärna en bild på hela hyllan och välj *Använd förra bilden* för nästa bok. Under *Redigera → Bokrygg* kan du också sätta färg och mått (cm).
- **Omslag** – hämtas automatiskt (Google Books / Open Library). Under *Redigera → Byt omslag* kan du välja bland flera omslag eller ta en bild på din egen bok.
- **Lyssna på egna ljudböcker** – importera DRM-fria ljudfiler (mp3, m4b, m4a …) via *＋ → 🎧 Importera ljudbok* eller *＋ Ljudfiler* på en bok.
  Filerna sparas på enheten och fungerar offline. Spelaren har minispelare, låsskärmskontroller, hastighet, insomningstimer och kapitel,
  och kommer ihåg var du var. Filerna synkas inte mellan enheter.
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

Har du kört `schema.sql` före november 2026: kör även [`supabase/uppdatering-2.sql`](supabase/uppdatering-2.sql) (genre, stämning och ljudbok).

Utan `config.js` ifyllt fungerar appen precis som innan, fast bara lokalt i webbläsaren.
Data från den första versionen flyttas automatiskt till din profil.

## Egen nyckel till Google Books (rekommenderas)

Utan nyckel delar appen en gemensam dygnskvot hos Google med alla andra, och den tar ofta slut.
Då hämtas uppgifter bara från LIBRIS och Open Library. En egen nyckel är gratis (1 000 sökningar/dag):

1. Gå till <https://console.cloud.google.com/> och skapa ett projekt (t.ex. "Mina böcker").
2. **APIs & Services → Library** → sök "Books API" → **Enable**.
3. **APIs & Services → Credentials → Create credentials → API key**.
4. Klicka på nyckeln → **Application restrictions: Websites** → lägg till `https://boostsebastian.github.io/*`,
   och **API restrictions: Books API**. Spara.
5. Klistra in nyckeln som `googleBooksKey` i `config.js`.

Nyckeln syns i appens källkod, men med begränsningarna ovan fungerar den bara från er sida och bara för Books API.

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
