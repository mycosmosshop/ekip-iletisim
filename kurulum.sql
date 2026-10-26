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

-- 8) Özel (üyeli) kanallar -------------------------------------------------------------------
-- Açık kanalın satırı olmayabilir (eskisi gibi adıyla vardır). Özel kanal ekip_kanal'da ozel=true ile tanımlanır;
-- mesajlarını, görüşme kanalını ve LiveKit odasını yalnız oluşturan ve ekip_kanal_uye'deki üyeler görür.
create table if not exists public.ekip_kanal (
  ad        text primary key check (ad ~ '^[^:~[:space:]]{1,40}$' and ad not like 'misafir-%'),
  ozel      boolean not null default false,
  olusturan uuid not null default auth.uid(),
  olusma    timestamptz not null default now()
);
create table if not exists public.ekip_kanal_uye (
  kanal        text not null references public.ekip_kanal(ad) on delete cascade,
  kullanici_id uuid not null,
  primary key (kanal, kullanici_id)
);

-- Alt odalar ('<kanal>~odaN') ana kanalın kuralına uyar. Kurallar tablolara RLS'siz bakar (security definer).
create or replace function public.ekip_kanala_erisir(k text) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when k like 'dm:%' then k like '%' || auth.uid()::text || '%'
    else not exists (select 1 from ekip_kanal c where c.ad = split_part(k, '~', 1) and c.ozel)
         or exists (select 1 from ekip_kanal c where c.ad = split_part(k, '~', 1) and c.olusturan = auth.uid())
         or exists (select 1 from ekip_kanal_uye u where u.kanal = split_part(k, '~', 1) and u.kullanici_id = auth.uid())
  end
$$;

alter table public.ekip_kanal enable row level security;
alter table public.ekip_kanal_uye enable row level security;
drop policy if exists "ekip_kanal oku" on public.ekip_kanal;
create policy "ekip_kanal oku" on public.ekip_kanal for select to authenticated
  using (public.ekip_onayli() and public.ekip_kanala_erisir(ad));
-- Eski açık kanalın adıyla özel kanal açılamaz (eski mesajlar üyesizlere kapanmasın)
drop policy if exists "ekip_kanal ekle" on public.ekip_kanal;
create policy "ekip_kanal ekle" on public.ekip_kanal for insert to authenticated
  with check (public.ekip_onayli() and olusturan = auth.uid() and not exists (select 1 from public.ekip_mesaj m where m.kanal = ad));
drop policy if exists "ekip_kanal sil" on public.ekip_kanal;
create policy "ekip_kanal sil" on public.ekip_kanal for delete to authenticated using (olusturan = auth.uid());
drop policy if exists "ekip_kanal_uye oku" on public.ekip_kanal_uye;
create policy "ekip_kanal_uye oku" on public.ekip_kanal_uye for select to authenticated
  using (public.ekip_onayli() and public.ekip_kanala_erisir(kanal));
-- Üyeyi yalnız oluşturan ekler/çıkarır; üye kendisi ayrılabilir
drop policy if exists "ekip_kanal_uye ekle" on public.ekip_kanal_uye;
create policy "ekip_kanal_uye ekle" on public.ekip_kanal_uye for insert to authenticated
  with check (public.ekip_onayli() and exists (select 1 from public.ekip_kanal c where c.ad = kanal and c.olusturan = auth.uid()));
drop policy if exists "ekip_kanal_uye sil" on public.ekip_kanal_uye;
create policy "ekip_kanal_uye sil" on public.ekip_kanal_uye for delete to authenticated
  using (kullanici_id = auth.uid() or exists (select 1 from public.ekip_kanal c where c.ad = kanal and c.olusturan = auth.uid()));

-- Üye seçimi için onaylı kullanıcılar: ad = uygulamada son kullandığı ad, yoksa e-postanın baş kısmı.
create or replace function public.ekip_kisiler() returns table (id uuid, ad text)
language sql stable security definer set search_path = public as $$
  select e.id, coalesce(
           (select m.yazar_ad from ekip_mesaj m where m.yazar_id = e.id order by m.olusma desc limit 1),
           (select o.ad from ekip_okundu o where o.kullanici_id = e.id order by o.son desc limit 1),
           split_part(e.email, '@', 1)) as ad
  from erp_users e
  where e.approved and public.ekip_onayli()
  order by 2
$$;

-- Üye eklenince kanal listesi anında güncellensin
do $$
begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'ekip_kanal_uye') then
    alter publication supabase_realtime add table public.ekip_kanal_uye;
  end if;
end $$;

-- 9) Telefona / bilgisayara bildirim (Web Push) ----------------------------------------------
-- Her cihazın abonelik adresi burada; bildirimi Cloudflare Worker (bildirim/worker.js) gönderen kişinin
-- oturumuyla ekip_push_hedefler'e sorar: alıcı = kanala erişimi olan, onaylı, gönderenden başka kullanıcılar.
create table if not exists public.ekip_push (
  endpoint     text primary key check (endpoint like 'https://%' and char_length(endpoint) < 1000),
  kullanici_id uuid not null default auth.uid(),
  p256dh       text not null check (char_length(p256dh) < 200),
  auth         text not null check (char_length(auth) < 100),
  cihaz        text check (char_length(cihaz) < 200),
  olusma       timestamptz not null default now()
);
alter table public.ekip_push enable row level security;
drop policy if exists "ekip_push kendi" on public.ekip_push;
create policy "ekip_push kendi" on public.ekip_push for all to authenticated
  using (kullanici_id = auth.uid()) with check (public.ekip_onayli() and kullanici_id = auth.uid());

-- kisiler: yalnız bu kişiler (birebir, @bahsetme); null ise kanala erişen herkes. haric: şu an sayfası açık olanlar.
-- ponytail: alıcı adresleri onaylı çağırana döner; adres VAPID gizli anahtarı olmadan bildirim göndermeye yetmez.
create or replace function public.ekip_push_hedefler(k text, kisiler uuid[] default null, haric uuid[] default '{}')
returns table (endpoint text, p256dh text, auth text)
language sql stable security definer set search_path = public as $$
  select p.endpoint, p.p256dh, p.auth
  from ekip_push p join erp_users e on e.id = p.kullanici_id and e.approved
  where public.ekip_onayli() and public.ekip_kanala_erisir(k)
    and p.kullanici_id <> auth.uid() and not (p.kullanici_id = any(coalesce(haric, '{}')))
    and (kisiler is null or p.kullanici_id = any(kisiler))
    and case
      when k like 'dm:%' then k like '%' || p.kullanici_id::text || '%'
      when exists (select 1 from ekip_kanal c where c.ad = split_part(k, '~', 1) and c.ozel) then
           exists (select 1 from ekip_kanal c where c.ad = split_part(k, '~', 1) and c.olusturan = p.kullanici_id)
        or exists (select 1 from ekip_kanal_uye u where u.kanal = split_part(k, '~', 1) and u.kullanici_id = p.kullanici_id)
      else true
    end
  limit 300
$$;

-- 10) Planlanan toplantı hatırlatması (sayfa kapalıyken de) ------------------------------------
-- Worker 5 dakikada bir çağırır; 5–15 dakika içinde başlayacak, hatırlatılmamış toplantıları ve kanala erişimi olanların
-- cihazlarını verir, toplantıyı işaretler (bir kez). Çağrı Worker'daki gizli anahtar ister; burada yalnız SHA-256 özeti durur.
create table if not exists public.ekip_sistem (ad text primary key, deger text not null);
alter table public.ekip_sistem enable row level security;          -- kural yok: kimse okuyamaz
create table if not exists public.ekip_hatirlatilan (mesaj_id uuid primary key, zaman timestamptz not null default now());
alter table public.ekip_hatirlatilan enable row level security;

create or replace function public.ekip_toplanti_hatirlat(gizli text)
returns table (mesaj_id uuid, konu text, bas timestamptz, link text, endpoint text, p256dh text, auth text)
language plpgsql security definer set search_path = public as $$
begin
  if encode(sha256(convert_to(coalesce(gizli, ''), 'UTF8')), 'hex') is distinct from (select deger from ekip_sistem where ad = 'hatirlatma_ozet') then
    raise exception 'yetkisiz';
  end if;
  return query
  with yakin as (
    select m.id, m.kanal, m.toplanti from ekip_mesaj m
    where m.toplanti is not null and not m.silindi
      and (m.toplanti->>'bas')::timestamptz between now() + interval '5 minutes' and now() + interval '15 minutes'
      and not exists (select 1 from ekip_hatirlatilan h where h.mesaj_id = m.id)
  ), isaret as (
    insert into ekip_hatirlatilan (mesaj_id) select id from yakin on conflict do nothing returning ekip_hatirlatilan.mesaj_id
  )
  select y.id, y.toplanti->>'konu', (y.toplanti->>'bas')::timestamptz, y.toplanti->>'link', p.endpoint, p.p256dh, p.auth
  from yakin y join isaret i on i.mesaj_id = y.id
  join ekip_push p on true join erp_users e on e.id = p.kullanici_id and e.approved
  where case
    when y.kanal like 'dm:%' then y.kanal like '%' || p.kullanici_id::text || '%'
    when exists (select 1 from ekip_kanal c where c.ad = split_part(y.kanal, '~', 1) and c.ozel) then
         exists (select 1 from ekip_kanal c where c.ad = split_part(y.kanal, '~', 1) and c.olusturan = p.kullanici_id)
      or exists (select 1 from ekip_kanal_uye u where u.kanal = split_part(y.kanal, '~', 1) and u.kullanici_id = p.kullanici_id)
    else true
  end;
end $$;
-- Gizli anahtarın özeti bir kez yazılır (değer kurulum sırasında üretilir, burada yer almaz):
-- insert into public.ekip_sistem values ('hatirlatma_ozet', '<sha256 hex>') on conflict (ad) do update set deger = excluded.deger;

-- Bildirim servisi "abonelik yok" (404/410) derse Worker o adresi siler.
create or replace function public.ekip_push_sil(e text) returns void
language sql security definer set search_path = public as $$
  delete from ekip_push where endpoint = e and public.ekip_onayli()
$$;

notify pgrst, 'reload schema';

-- 11. Kanal arşivi (toplantı notları + paylaşılan dosyalar): özel kanalda sahibi kapatabilir. Açık kanalda ve birebir
--     yazışmada hep açıktır. Mesajlar sohbette durur; bu yalnız arayüzdeki Arşiv bölümünü gizler.
alter table public.ekip_kanal add column if not exists arsiv boolean not null default true;
drop policy if exists "ekip_kanal guncelle" on public.ekip_kanal;
create policy "ekip_kanal guncelle" on public.ekip_kanal for update to authenticated
  using (olusturan = auth.uid()) with check (olusturan = auth.uid());
notify pgrst, 'reload schema';
