-- Uppdatering 4: serie/universum (t.ex. Star Wars) och nummer i serien.
-- Innehåller även tidigare uppdateringar. Kör i Supabase: SQL Editor → New query → Run. (Går bra att köra flera gånger.)
alter table public.books   add column if not exists genres      jsonb;
alter table public.books   add column if not exists moods       jsonb;
alter table public.books   add column if not exists description text;
alter table public.books   add column if not exists series      text;
alter table public.books   add column if not exists series_no   numeric;
alter table public.entries add column if not exists audio       boolean not null default false;
