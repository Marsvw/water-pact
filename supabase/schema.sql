-- Water Pact: shared database for the installable app.
-- Paste this whole file into the Supabase SQL editor and run it once.
-- It is safe to run again after an update.
--
-- How access works
--   * Every table lives in the private "water_pact" schema, which the API does not expose.
--   * Phones only call the wp_* functions in "public".
--   * Reading a pact needs its invite code. Writing needs the caller's device key,
--     which is issued when they join and stored here only as a hash.

create schema if not exists water_pact;

-- ---------------------------------------------------------------- tables

create table if not exists water_pact.pacts (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z2-9]{10}$'),
  rev bigint not null default 1,
  created_at timestamptz not null default now()
);

-- Added after the first release. "create table if not exists" does not add columns to an existing table.
alter table water_pact.pacts add column if not exists last_active timestamptz not null default now();
create index if not exists pacts_last_active_idx on water_pact.pacts (last_active);

create table if not exists water_pact.members (
  id uuid primary key default gen_random_uuid(),
  pact_id uuid not null references water_pact.pacts (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 24),
  goal_ml integer not null check (goal_ml between 500 and 8000),
  tz text not null default 'UTC',
  nudged_by uuid references water_pact.members (id) on delete set null,
  nudged_at timestamptz,
  joined_at timestamptz not null default now()
);
create index if not exists members_pact_idx on water_pact.members (pact_id);

create table if not exists water_pact.member_keys (
  key_hash text primary key,
  member_id uuid not null references water_pact.members (id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists member_keys_member_idx on water_pact.member_keys (member_id);

create table if not exists water_pact.drinks (
  id uuid primary key,
  member_id uuid not null references water_pact.members (id) on delete cascade,
  ml integer not null check (ml between 10 and 3000),
  goal_ml integer not null check (goal_ml between 500 and 8000),
  at timestamptz not null,
  day date not null
);
create index if not exists drinks_member_day_idx on water_pact.drinks (member_id, day);

create table if not exists water_pact.link_codes (
  code text primary key,
  member_id uuid not null references water_pact.members (id) on delete cascade,
  expires_at timestamptz not null
);

alter table water_pact.pacts enable row level security;
alter table water_pact.members enable row level security;
alter table water_pact.member_keys enable row level security;
alter table water_pact.drinks enable row level security;
alter table water_pact.link_codes enable row level security;

-- ---------------------------------------------------------------- private helpers

create or replace function water_pact.random_code(p_len integer)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  -- No I, L, O, 0 or 1, so a code read aloud or typed by hand is unambiguous.
  v_alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  v_bytes bytea := sha256(uuid_send(gen_random_uuid()) || uuid_send(gen_random_uuid()));
  v_out text := '';
begin
  for i in 0..(least(p_len, 32) - 1) loop
    v_out := v_out || substr(v_alphabet, 1 + (get_byte(v_bytes, i) % length(v_alphabet)), 1);
  end loop;
  return v_out;
end;
$$;

create or replace function water_pact.norm_code(p_code text)
returns text
language sql
immutable
set search_path = ''
as $$
  select upper(regexp_replace(left(coalesce(p_code, ''), 64), '[^A-Za-z0-9]', '', 'g'));
$$;

create or replace function water_pact.hash_key(p_key text)
returns text
language sql
immutable
set search_path = ''
as $$
  select encode(sha256(convert_to(left(coalesce(p_key, ''), 256), 'UTF8')), 'hex');
$$;

create or replace function water_pact.clean_tz(p_tz text)
returns text
language sql
immutable
set search_path = ''
as $$
  select case when length(p_tz) <= 64 and p_tz ~ '^[A-Za-z0-9_+/-]+$' then p_tz else 'UTC' end;
$$;

-- Returns the tidied name, or raises wp_invalid.
create or replace function water_pact.check_profile(p_name text, p_goal_ml integer)
returns text
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_name text;
begin
  if p_name is null or length(p_name) > 200 then
    raise exception 'wp_invalid';
  end if;
  -- Drop control and invisible formatting characters, which could make one name pass for another.
  v_name := regexp_replace(p_name, '[\u0001-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]', '', 'g');
  v_name := btrim(regexp_replace(v_name, '\s+', ' ', 'g'));
  if char_length(v_name) < 1 or char_length(v_name) > 24
     or p_goal_ml is null or p_goal_ml < 500 or p_goal_ml > 8000 then
    raise exception 'wp_invalid';
  end if;
  return v_name;
end;
$$;

-- Returns the member the device key belongs to, or raises wp_auth.
create or replace function water_pact.auth(p_member_id uuid, p_key text)
returns water_pact.members
language plpgsql
stable
set search_path = ''
as $$
declare
  v_member water_pact.members;
begin
  select m.* into v_member
    from water_pact.members m
    join water_pact.member_keys k on k.member_id = m.id
   where m.id = p_member_id
     and k.key_hash = water_pact.hash_key(p_key);
  if not found then
    raise exception 'wp_auth';
  end if;
  return v_member;
end;
$$;

create or replace function water_pact.touch(p_pact_id uuid)
returns void
language sql
volatile
set search_path = ''
as $$
  update water_pact.pacts set rev = rev + 1, last_active = now() where id = p_pact_id;
$$;

-- Issues a fresh device key for a member and keeps their five newest devices.
create or replace function water_pact.issue_key(p_member_id uuid)
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_key text := replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', '');
begin
  insert into water_pact.member_keys (key_hash, member_id)
  values (water_pact.hash_key(v_key), p_member_id);

  delete from water_pact.member_keys
   where member_id = p_member_id
     and key_hash not in (
       select k.key_hash from water_pact.member_keys k
        where k.member_id = p_member_id
        order by k.created_at desc
        limit 5
     );
  return v_key;
end;
$$;

create or replace function water_pact.add_member(p_pact_id uuid, p_name text, p_goal_ml integer, p_tz text)
returns jsonb
language plpgsql
volatile
set search_path = ''
as $$
declare
  v_name text := water_pact.check_profile(p_name, p_goal_ml);
  v_member_id uuid;
begin
  insert into water_pact.members (pact_id, name, goal_ml, tz)
  values (p_pact_id, v_name, p_goal_ml, water_pact.clean_tz(p_tz))
  returning id into v_member_id;
  perform water_pact.touch(p_pact_id);
  return jsonb_build_object('member_id', v_member_id, 'member_key', water_pact.issue_key(v_member_id));
end;
$$;

-- ---------------------------------------------------------------- public API

create or replace function public.wp_create_pact(p_name text, p_goal_ml integer, p_tz text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pact_id uuid;
  v_code text;
begin
  -- Housekeeping: forget pacts nobody has written to in six months, and ones that
  -- never logged a drink in their first two weeks. A few at a time keeps this call quick.
  delete from water_pact.pacts
   where id in (
     select p.id
       from water_pact.pacts p
      where p.last_active < now() - interval '180 days'
         or (p.last_active < now() - interval '14 days'
             and not exists (
               select 1
                 from water_pact.drinks d
                 join water_pact.members m on m.id = d.member_id
                where m.pact_id = p.id))
      order by p.last_active
      limit 100);

  -- A ceiling so a runaway script cannot fill the database.
  if (select count(*) from water_pact.pacts) >= 20000 then
    raise exception 'wp_busy';
  end if;
  perform water_pact.check_profile(p_name, p_goal_ml);

  loop
    v_code := water_pact.random_code(10);
    begin
      insert into water_pact.pacts (code) values (v_code) returning id into v_pact_id;
      exit;
    exception when unique_violation then
      null; -- astronomically rare; draw again
    end;
  end loop;

  return water_pact.add_member(v_pact_id, p_name, p_goal_ml, p_tz) || jsonb_build_object('code', v_code);
end;
$$;

create or replace function public.wp_join_pact(p_code text, p_name text, p_goal_ml integer, p_tz text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pact water_pact.pacts;
begin
  -- Lock the pact row so two people joining at once cannot exceed the limit.
  select * into v_pact from water_pact.pacts where code = water_pact.norm_code(p_code) for update;
  if not found then
    raise exception 'wp_not_found';
  end if;
  if (select count(*) from water_pact.members where pact_id = v_pact.id) >= 8 then
    raise exception 'wp_full';
  end if;
  return water_pact.add_member(v_pact.id, p_name, p_goal_ml, p_tz) || jsonb_build_object('code', v_pact.code);
end;
$$;

-- The app calls wp_peek_pact and wp_get_pact by POST, which keeps invite codes out of URLs
-- and server logs. Supabase's API also answers GET for these two read-only functions; any
-- function that writes fails over GET because GET runs in a read-only transaction.
create or replace function public.wp_peek_pact(p_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pact_id uuid;
begin
  select id into v_pact_id from water_pact.pacts where code = water_pact.norm_code(p_code);
  if not found then
    raise exception 'wp_not_found';
  end if;
  return jsonb_build_object('names', coalesce(
    (select jsonb_agg(m.name order by m.joined_at, m.id) from water_pact.members m where m.pact_id = v_pact_id),
    '[]'::jsonb));
end;
$$;

-- Everything a phone needs to draw the pact. Days before p_recent_from come back
-- as one total per person per day; newer days come back drink by drink.
create or replace function public.wp_get_pact(p_code text, p_since date, p_recent_from date, p_rev bigint default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pact water_pact.pacts;
  v_since date := greatest(coalesce(p_since, current_date - 70), current_date - 100);
  v_recent date := greatest(coalesce(p_recent_from, current_date - 2), current_date - 7);
begin
  select * into v_pact from water_pact.pacts where code = water_pact.norm_code(p_code);
  if not found then
    raise exception 'wp_not_found';
  end if;
  if p_rev is not null and p_rev = v_pact.rev then
    return jsonb_build_object('rev', v_pact.rev, 'unchanged', true);
  end if;

  return jsonb_build_object(
    'rev', v_pact.rev,
    'since', v_since,
    'recent_from', v_recent,
    'members', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', m.id, 'name', m.name, 'goal_ml', m.goal_ml, 'tz', m.tz,
               'joined_at', m.joined_at, 'nudged_by', m.nudged_by, 'nudged_at', m.nudged_at)
             order by m.joined_at, m.id)
        from water_pact.members m
       where m.pact_id = v_pact.id), '[]'::jsonb),
    'days', coalesce((
      select jsonb_agg(jsonb_build_object(
               'member_id', t.member_id, 'day', t.day, 'total_ml', t.total_ml, 'goal_ml', t.goal_ml)
             order by t.day, t.member_id)
        from (
          select d.member_id, d.day, sum(d.ml)::integer as total_ml,
                 (array_agg(d.goal_ml order by d.at desc))[1] as goal_ml
            from water_pact.drinks d
            join water_pact.members m on m.id = d.member_id
           where m.pact_id = v_pact.id and d.day >= v_since and d.day < v_recent
           group by d.member_id, d.day
        ) t), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', d.id, 'member_id', d.member_id, 'ml', d.ml, 'goal_ml', d.goal_ml, 'at', d.at, 'day', d.day)
             order by d.at, d.id)
        from water_pact.drinks d
        join water_pact.members m on m.id = d.member_id
       where m.pact_id = v_pact.id and d.day >= v_recent), '[]'::jsonb)
  );
end;
$$;

-- p_id comes from the phone, so a retry after a dropped connection stores the drink once.
create or replace function public.wp_log_drink(
  p_member_id uuid, p_key text, p_id uuid, p_ml integer, p_at timestamptz, p_day date)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member water_pact.members := water_pact.auth(p_member_id, p_key);
begin
  if p_id is null or p_ml is null or p_ml < 10 or p_ml > 3000
     or p_at is null or p_at < now() - interval '9 days' or p_at > now() + interval '2 days'
     or p_day is null or p_day < current_date - 8 or p_day > current_date + 2 then
    raise exception 'wp_invalid';
  end if;
  if (select count(*) from water_pact.drinks where member_id = v_member.id and day = p_day) >= 60 then
    raise exception 'wp_limit';
  end if;
  -- A ceiling on the whole table, read from the planner's estimate so the check costs nothing.
  if (select c.reltuples from pg_catalog.pg_class c where c.oid = 'water_pact.drinks'::regclass) > 1500000 then
    raise exception 'wp_busy';
  end if;

  insert into water_pact.drinks (id, member_id, ml, goal_ml, at, day)
  values (p_id, v_member.id, p_ml, v_member.goal_ml, p_at, p_day)
  on conflict (id) do nothing;

  -- History reaches back 100 days at most, so anything older is dead weight.
  delete from water_pact.drinks where member_id = v_member.id and day < current_date - 120;

  -- Drinking answers a nudge.
  update water_pact.members set nudged_by = null, nudged_at = null where id = v_member.id;
  perform water_pact.touch(v_member.pact_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.wp_remove_drink(p_member_id uuid, p_key text, p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member water_pact.members := water_pact.auth(p_member_id, p_key);
begin
  delete from water_pact.drinks where id = p_id and member_id = v_member.id;
  perform water_pact.touch(v_member.pact_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.wp_update_member(
  p_member_id uuid, p_key text, p_name text, p_goal_ml integer, p_tz text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member water_pact.members := water_pact.auth(p_member_id, p_key);
  v_name text := water_pact.check_profile(p_name, p_goal_ml);
begin
  update water_pact.members
     set name = v_name, goal_ml = p_goal_ml, tz = water_pact.clean_tz(p_tz)
   where id = v_member.id;
  perform water_pact.touch(v_member.pact_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.wp_send_nudge(p_member_id uuid, p_key text, p_to uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member water_pact.members := water_pact.auth(p_member_id, p_key);
begin
  update water_pact.members
     set nudged_by = v_member.id, nudged_at = now()
   where id = p_to and pact_id = v_member.pact_id and id <> v_member.id;
  if not found then
    raise exception 'wp_invalid';
  end if;
  perform water_pact.touch(v_member.pact_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.wp_clear_nudge(p_member_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member water_pact.members := water_pact.auth(p_member_id, p_key);
begin
  update water_pact.members set nudged_by = null, nudged_at = null where id = v_member.id;
  perform water_pact.touch(v_member.pact_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function public.wp_leave_pact(p_member_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member water_pact.members := water_pact.auth(p_member_id, p_key);
begin
  -- Lock the pact so a friend joining at the same moment is not caught half-way.
  perform 1 from water_pact.pacts where id = v_member.pact_id for update;
  delete from water_pact.members where id = v_member.id;
  if exists (select 1 from water_pact.members where pact_id = v_member.pact_id) then
    perform water_pact.touch(v_member.pact_id);
  else
    delete from water_pact.pacts where id = v_member.pact_id;
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

-- A short-lived code that lets the same person open their log on another device,
-- for example after adding the app to their home screen.
create or replace function public.wp_create_link_code(p_member_id uuid, p_key text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member water_pact.members := water_pact.auth(p_member_id, p_key);
  v_code text;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  delete from water_pact.link_codes where member_id = v_member.id or expires_at < now();
  loop
    v_code := water_pact.random_code(10);
    begin
      insert into water_pact.link_codes (code, member_id, expires_at) values (v_code, v_member.id, v_expires);
      exit;
    exception when unique_violation then
      null; -- astronomically rare; draw again
    end;
  end loop;
  return jsonb_build_object('link_code', v_code, 'expires_at', v_expires);
end;
$$;

create or replace function public.wp_redeem_link_code(p_link_code text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member_id uuid;
  v_pact_code text;
begin
  delete from water_pact.link_codes
   where code = water_pact.norm_code(p_link_code) and expires_at > now()
  returning member_id into v_member_id;
  if not found then
    raise exception 'wp_not_found';
  end if;
  select p.code into v_pact_code
    from water_pact.members m
    join water_pact.pacts p on p.id = m.pact_id
   where m.id = v_member_id;
  return jsonb_build_object(
    'code', v_pact_code,
    'member_id', v_member_id,
    'member_key', water_pact.issue_key(v_member_id));
end;
$$;

-- ---------------------------------------------------------------- permissions

revoke all on schema water_pact from public, anon, authenticated;
revoke all on all tables in schema water_pact from public, anon, authenticated;
revoke all on all functions in schema water_pact from public, anon, authenticated;

do $$
declare
  f record;
begin
  for f in
    select p.oid::regprocedure as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like 'wp\_%'
  loop
    execute format('revoke all on function %s from public', f.signature);
    execute format('grant execute on function %s to anon, authenticated', f.signature);
  end loop;
end;
$$;
