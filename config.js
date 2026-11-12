// Fyll i från Supabase: Project Settings → API (eller "Connect").
// Nyckeln är den publika "anon"/"publishable"-nyckeln – den får ligga öppet,
// databasen skyddas av radnivåsäkerheten i supabase/schema.sql.
// Lämna tomt för att använda appen utan synk (bara lokalt i webbläsaren).
// googleBooksKey (valfri): egen nyckel till Google Books. Utan nyckel delar appen en gemensam
// dygnskvot med alla andra och får ofta inga svar. Se README → "Egen nyckel till Google Books".
window.BOOKS_CONFIG = {
  supabaseUrl: 'https://kzanjcdojvokoholmzis.supabase.co',
  supabaseKey: 'sb_publishable_ZUIYX6MrhUWdHHEBOqL1MQ_1QJh5yhb',
  googleBooksKey: '',
  // googleClientId (valfri): OAuth-klient för Google Drive, så att ljudböcker kan sparas i och hämtas från Drive.
  // Se README → "Google Drive för ljudböcker". Formatet är 1234-abc.apps.googleusercontent.com (publikt, inte hemligt).
  googleClientId: '',
};
