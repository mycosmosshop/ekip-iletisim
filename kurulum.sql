-- ============================================================
-- Ekip İletişim — Supabase kurulum SQL'i
-- Proje: ERP portal projesi (chchaielttnimuuezazb)
-- Çalıştırma: Supabase Dashboard > SQL Editor > New query > yapıştır > Run
-- Tekrar çalıştırmak güvenli (idempotent).
-- ============================================================

-- 1) Mesaj tablosu ------------------------------------------------------------
create table if not exists public.ekip_mesaj (
  id        uuid primary key,
  kanal     text not null check (char_length(kanal) between 1 and 120),  -- 'genel' | 'dm:<uid>:<uid>'
  yazar_id  uuid not null default auth.uid(),
  yazar_ad  text not null check (char_length(yazar_ad) between 1 and 120),
  metin     text not null check (char_length(metin) between 1 and 4000),
  olusma    timestamptz not null default now()
);
create index if not exists ekip_mesaj_kanal_olusma on public.ekip_mesaj (kanal, olusma desc);
-- Drive'a yüklenen dosyanın bilgisi: {ad, url, boyut}; dosyanın kendisi Supabase'e girmez
alter table public.ekip_mesaj add column if not exists dosya jsonb;

-- 2) Yalnız ERP'de onaylı kullanıcılar ----------------------------------------
create or replace function public.ekip_onayli() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.erp_users where id = auth.uid() and approved)
$$;

-- birebir kanalı ise kullanıcı taraflardan biri mi
create or replace function public.ekip_kanala_erisir(k text) returns boolean
language sql stable as $$
  select k not like 'dm:%' or k like '%' || auth.uid()::text || '%'
$$;

alter table public.ekip_mesaj enable row level security;

drop policy if exists "ekip_mesaj oku" on public.ekip_mesaj;
create policy "ekip_mesaj oku" on public.ekip_mesaj for select to authenticated
  using (public.ekip_onayli() and public.ekip_kanala_erisir(kanal));

drop policy if exists "ekip_mesaj yaz" on public.ekip_mesaj;
create policy "ekip_mesaj yaz" on public.ekip_mesaj for insert to authenticated
  with check (public.ekip_onayli() and yazar_id = auth.uid() and public.ekip_kanala_erisir(kanal));
-- güncelleme/silme politikası yok: mesajlar değiştirilemez

-- 3) Yeni mesajlar canlı gelsin (postgres_changes RLS'e uyar) --------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ekip_mesaj') then
    alter publication supabase_realtime add table public.ekip_mesaj;
  end if;
end $$;

-- 4) Özel Realtime kanalları: çevrimiçi listesi ve görüşme sinyali -----------------
--    ekip-lobi              : onaylı herkes
--    ekip-cagri:<kanal>     : onaylı herkes; 'ekip-cagri:dm:...' yalnız iki taraf
drop policy if exists "ekip realtime oku" on realtime.messages;
create policy "ekip realtime oku" on realtime.messages for select to authenticated
  using (
    public.ekip_onayli() and (
      realtime.topic() = 'ekip-lobi'
      or (realtime.topic() like 'ekip-cagri:%' and public.ekip_kanala_erisir(substr(realtime.topic(), 12)))
    )
  );

drop policy if exists "ekip realtime yaz" on realtime.messages;
create policy "ekip realtime yaz" on realtime.messages for insert to authenticated
  with check (
    public.ekip_onayli() and (
      realtime.topic() = 'ekip-lobi'
      or (realtime.topic() like 'ekip-cagri:%' and public.ekip_kanala_erisir(substr(realtime.topic(), 12)))
    )
  );

notify pgrst, 'reload schema';
