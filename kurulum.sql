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
-- silme politikası yok; düzenleme ve "silindi" işareti 4. bölümde, yalnız yazarına

-- 3) Yeni mesajlar canlı gelsin (postgres_changes RLS'e uyar) --------------------
do $$
begin
  if not exists (select 1 from pg_publication_tables
                 where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ekip_mesaj') then
    alter publication supabase_realtime add table public.ekip_mesaj;
  end if;
end $$;

-- 4) Mesaj işlemleri: yanıt, toplantı kartı, düzenleme ve silme (yalnız yazarı) ----------
alter table public.ekip_mesaj add column if not exists yanit jsonb;
alter table public.ekip_mesaj add column if not exists toplanti jsonb;
alter table public.ekip_mesaj add column if not exists duzenlendi timestamptz;
alter table public.ekip_mesaj add column if not exists silindi boolean not null default false;
-- silinen mesajın metni boşaltılır
alter table public.ekip_mesaj drop constraint if exists ekip_mesaj_metin_check;
alter table public.ekip_mesaj add constraint ekip_mesaj_metin_check
  check (char_length(metin) <= 4000 and (silindi or char_length(metin) >= 1));

drop policy if exists "ekip_mesaj duzenle" on public.ekip_mesaj;
create policy "ekip_mesaj duzenle" on public.ekip_mesaj for update to authenticated
  using (public.ekip_onayli() and yazar_id = auth.uid())
  with check (public.ekip_onayli() and yazar_id = auth.uid());
-- yazar yalnız metni/silindi/düzenlendi/dosya alanlarını değiştirebilir (kanal, yazar, tarih sabit)
revoke update on public.ekip_mesaj from authenticated;
grant update (metin, silindi, duzenlendi, dosya) on public.ekip_mesaj to authenticated;

create or replace function public.ekip_mesaja_erisir(mid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.ekip_mesaj m where m.id = mid and public.ekip_kanala_erisir(m.kanal))
$$;

-- 5) Mesaja emoji tepkisi (geri alma = aktif false; silme yok) --------------------------
create table if not exists public.ekip_tepki (
  mesaj_id     uuid not null references public.ekip_mesaj(id) on delete cascade,
  kullanici_id uuid not null default auth.uid(),
  ad           text not null check (char_length(ad) between 1 and 120),
  emoji        text not null check (emoji in ('👍', '❤️', '😂', '😮', '😢', '🙏')),
  aktif        boolean not null default true,
  guncel       timestamptz not null default now(),
  primary key (mesaj_id, kullanici_id, emoji)
);
alter table public.ekip_tepki enable row level security;
drop policy if exists "ekip_tepki oku" on public.ekip_tepki;
create policy "ekip_tepki oku" on public.ekip_tepki for select to authenticated
  using (public.ekip_onayli() and public.ekip_mesaja_erisir(mesaj_id));
drop policy if exists "ekip_tepki ekle" on public.ekip_tepki;
create policy "ekip_tepki ekle" on public.ekip_tepki for insert to authenticated
  with check (public.ekip_onayli() and kullanici_id = auth.uid() and public.ekip_mesaja_erisir(mesaj_id));
drop policy if exists "ekip_tepki degistir" on public.ekip_tepki;
create policy "ekip_tepki degistir" on public.ekip_tepki for update to authenticated
  using (kullanici_id = auth.uid())
  with check (public.ekip_onayli() and kullanici_id = auth.uid() and public.ekip_mesaja_erisir(mesaj_id));

-- 6) Okundu bilgisi: kullanıcının kanaldaki son okuduğu an -------------------------------
create table if not exists public.ekip_okundu (
  kullanici_id uuid not null default auth.uid(),
  kanal        text not null check (char_length(kanal) between 1 and 120),
  ad           text not null check (char_length(ad) between 1 and 120),
  son          timestamptz not null,
  primary key (kullanici_id, kanal)
);
alter table public.ekip_okundu enable row level security;
drop policy if exists "ekip_okundu oku" on public.ekip_okundu;
create policy "ekip_okundu oku" on public.ekip_okundu for select to authenticated
  using (public.ekip_onayli() and public.ekip_kanala_erisir(kanal));
drop policy if exists "ekip_okundu ekle" on public.ekip_okundu;
create policy "ekip_okundu ekle" on public.ekip_okundu for insert to authenticated
  with check (public.ekip_onayli() and kullanici_id = auth.uid() and public.ekip_kanala_erisir(kanal));
drop policy if exists "ekip_okundu degistir" on public.ekip_okundu;
create policy "ekip_okundu degistir" on public.ekip_okundu for update to authenticated
  using (kullanici_id = auth.uid())
  with check (public.ekip_onayli() and kullanici_id = auth.uid() and public.ekip_kanala_erisir(kanal));

do $$
declare t text;
begin
  foreach t in array array['ekip_tepki', 'ekip_okundu'] loop
    if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 7) Özel Realtime kanalları: lobi, görüşme ve kişisel kanal (ekip-kutu:<uid> okumak yalnız sahibine) --
drop policy if exists "ekip realtime oku" on realtime.messages;
create policy "ekip realtime oku" on realtime.messages for select to authenticated
  using (
    public.ekip_onayli() and (
      realtime.topic() = 'ekip-lobi'
      or (realtime.topic() like 'ekip-cagri:%' and public.ekip_kanala_erisir(substr(realtime.topic(), 12)))
      or realtime.topic() = 'ekip-kutu:' || auth.uid()::text
    )
  );
drop policy if exists "ekip realtime yaz" on realtime.messages;
create policy "ekip realtime yaz" on realtime.messages for insert to authenticated
  with check (
    public.ekip_onayli() and (
      realtime.topic() = 'ekip-lobi'
      or (realtime.topic() like 'ekip-cagri:%' and public.ekip_kanala_erisir(substr(realtime.topic(), 12)))
      or realtime.topic() like 'ekip-kutu:%'
    )
  );

notify pgrst, 'reload schema';
