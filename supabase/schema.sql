-- Mina böcker – databasschema för Supabase.
-- Kör hela filen i Supabase: SQL Editor → New query → klistra in → Run.
--
-- Modell: ett inloggat konto = ett hushåll (familjen). Familjemedlemmar är profiler
-- inom hushållet (som profiler på en streamingtjänst), så barnen behöver ingen e-post.

create table if not exists public.members (
  id           text primary key,
  household_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  name         text not null,
  color        text,
  updated_at   timestamptz not null default now()
);

create table if not exists public.books (
  id           text primary key,
  household_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  title        text not null,
  authors      text,
  year         text,
  isbn         text,
  cover        text,
  pages        integer,
  owned        boolean not null default false,
  spine        jsonb,   -- bokryggen: { img (foto), ratio, color, h, w (cm) }
  added_at     date,
  updated_at   timestamptz not null default now()
);

-- En persons förhållande till en bok: önskar sig den, läser den (med sida) eller har läst den.
create table if not exists public.entries (
  id           text primary key,
  household_id uuid not null default auth.uid() references auth.users (id) on delete cascade,
  book_id      text not null references public.books (id) on delete cascade,
  member_id    text not null references public.members (id) on delete cascade,
  status       text not null check (status in ('wishlist', 'reading', 'read')),
  page         integer,
  rating       smallint check (rating between 0 and 5),
  notes        text,
  started_at   date,
  finished_at  date,
  updated_at   timestamptz not null default now()
);

-- För databaser skapade med en tidigare version av den här filen:
alter table public.books add column if not exists spine jsonb;

create index if not exists books_household_idx   on public.books (household_id);
create index if not exists members_household_idx on public.members (household_id);
create index if not exists entries_household_idx on public.entries (household_id);
create index if not exists entries_book_idx      on public.entries (book_id);
create index if not exists entries_member_idx    on public.entries (member_id);

-- Radnivåsäkerhet: man ser och ändrar bara sitt eget hushålls data.
alter table public.members enable row level security;
alter table public.books   enable row level security;
alter table public.entries enable row level security;

drop policy if exists "eget hushåll" on public.members;
drop policy if exists "eget hushåll" on public.books;
drop policy if exists "eget hushåll" on public.entries;

create policy "eget hushåll" on public.members for all to authenticated
  using (household_id = auth.uid()) with check (household_id = auth.uid());
create policy "eget hushåll" on public.books for all to authenticated
  using (household_id = auth.uid()) with check (household_id = auth.uid());
create policy "eget hushåll" on public.entries for all to authenticated
  using (household_id = auth.uid()) with check (household_id = auth.uid());

-- Realtid: andra enheter uppdateras direkt när någon ändrar något.
do $$
begin
  alter publication supabase_realtime add table public.members, public.books, public.entries;
exception when duplicate_object then null;
end $$;
