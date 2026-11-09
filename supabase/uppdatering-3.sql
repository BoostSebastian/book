-- Uppdatering 3: genre, stämning, ljudbok och baksidestext.
-- Kör i Supabase: SQL Editor → New query → klistra in → Run. (Går bra att köra flera gånger.)
alter table public.books   add column if not exists genres      jsonb;
alter table public.books   add column if not exists moods       jsonb;
alter table public.books   add column if not exists description text;
alter table public.entries add column if not exists audio       boolean not null default false;
