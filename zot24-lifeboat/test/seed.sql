-- FAKE data for the local proof. Every name, email and file is made up.
\set ON_ERROR_STOP on

create table public.residents (
  id bigint generated always as identity primary key,
  full_name text not null,
  email text unique,
  notes text,
  joined_on date,
  profile jsonb
);
insert into public.residents (full_name, email, notes, joined_on, profile)
select 'Fake Resident ' || g, 'fake.resident' || g || '@example.test',
  case when g % 10 = 0 then E'multi\nline\tnote, "quoted", back\\slash' when g % 7 = 0 then 'ünïcödé ✓ 日本語' end,
  date '2025-01-01' + g, jsonb_build_object('room', g % 40, 'tags', jsonb_build_array('fake', g % 3))
from generate_series(1, 500) g;

create table public.rooms (id int primary key, label text, floor int);
insert into public.rooms select g, 'Fake Room ' || g, g / 10 from generate_series(1, 40) g;

-- RLS hides these rows from API users; the backup role bypasses RLS.
create table public.bookings (
  id uuid primary key default extensions.uuid_generate_v4(),
  resident_id bigint references public.residents (id),
  room int references public.rooms (id),
  starts timestamptz,
  nights int
);
alter table public.bookings enable row level security;
create policy bookings_none on public.bookings for select to authenticated using (false);
insert into public.bookings (resident_id, room, starts, nights)
select 1 + g % 500, 1 + g % 40, timestamptz '2026-01-01' + g * interval '3 hours', 1 + g % 9
from generate_series(1, 2000) g;

create schema app;
create table app.audit_events (id bigserial primary key, at timestamptz default now(), payload bytea);
insert into app.audit_events (payload) select decode(md5(g::text), 'hex') from generate_series(1, 300) g;

create table public."Weird Table" ("odd col" text);
insert into public."Weird Table" values ('a|b'), (E'tab\there'), (null);

-- COPY of a parent table holds only its own rows.
create table public.parent_log (id int, msg text);
create table public.child_log () inherits (public.parent_log);
insert into public.parent_log select g, 'parent' from generate_series(1, 5) g;
insert into public.child_log select g, 'child' from generate_series(1, 7) g;

create table public.empty_table (id int);

-- The backup user may read objects and buckets, and nothing else.
create policy lifeboat_backup_read on storage.objects for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'backup@lifeboat.test');
create policy lifeboat_backup_read on storage.buckets for select to authenticated
  using ((select auth.jwt() ->> 'email') = 'backup@lifeboat.test');
