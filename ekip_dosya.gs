/* Ekip İletişim — Google Apps Script web uygulaması: Drive dosya yükleme, TURN kimliği, LiveKit bileti, Claude özeti/çevirisi
   Kurulum: script.google.com → Yeni proje → bu kodu yapıştır →
   Dağıt → Yeni dağıtım → Web uygulaması; "Şu kullanıcı olarak çalıştır: Ben", "Erişim: Herkes".
   Çıkan /exec adresini index.html içindeki DOSYA_URL'ye yaz. Kod değişince: Dağıtımları yönet → düzenle → Yeni sürüm.
   Yükleme ve Claude yalnız ERP'de onaylı kullanıcıya açık: istekteki Supabase oturumu burada doğrulanır.
   İki yükleme yolu: küçük dosya tek istekte {veri}; büyük dosya ve görüşme kaydı Drive'ın devam ettirilebilir
   yüklemesiyle parça parça {islem:'baslat'} → {islem:'parca'} (her parça 256 KB'nin katı, son parça hariç).
   Gizli anahtarlar koda yazılmaz (depo herkese açık): Proje ayarları → Komut dosyası özellikleri:
     CF_TURN_ID, CF_TURN_TOKEN                    Cloudflare → Realtime → TURN Server anahtarı
     LIVEKIT_URL, LIVEKIT_KEY, LIVEKIT_SECRET     LiveKit Cloud → Settings → API keys (URL wss://….livekit.cloud)
     ANTHROPIC_API_KEY                            console.anthropic.com → API keys
   Eksik olan özellik kapalı kalır; istemci yalnız STUN / herkes-herkese bağlantıyla devam eder.
   denemeAyarlar() editörden çalıştırılınca hangilerinin çalıştığını günlüğe yazar (değerleri yazmaz). */

const SUPA_URL = 'https://chchaielttnimuuezazb.supabase.co';
const SUPA_KEY = 'sb_publishable_S2ywbq7TkgcZKiVif3td-A_oAuQL3QT';
const KLASOR_ADI = 'Ekip İletişim Dosyaları';
const SINIR = 25 * 1024 * 1024;
const OTURUM_ONEK = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable';
// Misafir görüşme odası (ve alt odaları): ERP oturumu olmadan TURN/LiveKit alabilir, oda kodu tahmin edilemez.
const MISAFIR_ODA = /^misafir-[a-z0-9]{16,40}(~oda[1-9])?$/;
const DILLER = { tr: 'Türkçe', en: 'İngilizce', de: 'Almanca', fr: 'Fransızca', ar: 'Arapça', ru: 'Rusça' };
const ayar = (ad) => PropertiesService.getScriptProperties().getProperty(ad);

function doPost(e) {
  try {
    const g = JSON.parse(e.postData.contents);
    if (g.islem === 'ice' || g.islem === 'livekit') {
      siniriDenetle();
      const kullanici = MISAFIR_ODA.test(String(g.oda)) ? null : odaErisimi(g);
      return yanit(g.islem === 'ice' ? iceSunuculari() : livekitBileti(g, kullanici));
    }
    const kullanici = kullaniciDogrula(g.token);
    if (g.islem === 'ozet') return yanit(toplantiOzeti(g));
    if (g.islem === 'kacirdiklar') return yanit(kacirdiklar(g));
    if (g.islem === 'sor') return yanit(kanalaSor(g));
    if (g.islem === 'claude-durum') return yanit({ ok: true, var: !!ayar('ANTHROPIC_API_KEY') });
    if (g.islem === 'claude-anahtar') return yanit(claudeAnahtarKaydet(g, kullanici));
    if (g.islem === 'cevir') return yanit(cevir(g));
    if (g.islem === 'baslat') return yanit(oturumBaslat(g, kullanici));
    if (g.islem === 'parca') return yanit(parcaGonder(g));
    const bayt = Utilities.base64Decode(g.veri);
    if (bayt.length > SINIR) throw new Error('Dosya 25 MB sınırını aşıyor');
    const ad = String(g.ad || 'dosya').slice(0, 200);
    const dosya = klasor().createFile(Utilities.newBlob(bayt, g.tur || 'application/octet-stream', ad));
    dosya.setDescription('Yükleyen: ' + kullanici.email + ' · kanal: ' + String(g.kanal || '').slice(0, 120));
    // Alıcıların Google hesabı olmayabilir: bağlantıya sahip olan görüntüler, bağlantı yalnız sohbette paylaşılır.
    dosya.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    return yanit({ ok: true, url: dosya.getUrl(), boyut: bayt.length });
  } catch (err) {
    return yanit({ ok: false, hata: String(err && err.message || err) });
  }
}

// ERP görüşmesinde oda kanalın adıdır: birebir ve özel kanalın odasına yalnız erişimi olan girer.
// Karar veritabanındaki ekip_kanala_erisir kuralına kullanıcının kendi oturumuyla sorulur (kurulum.sql 8).
function odaErisimi(g) {
  const k = kullaniciDogrula(g.token);
  const r = UrlFetchApp.fetch(SUPA_URL + '/rest/v1/rpc/ekip_kanala_erisir', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify({ k: String(g.oda || '') }),
    headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + g.token }, muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200 || r.getContentText().trim() !== 'true') throw new Error('Bu görüşmeye erişimin yok');
  return k;
}

// Misafire açık uçlar kötüye kullanılmasın diye.
// ponytail: tek genel sayaç (dakikada 300); kötüye kullanım görülürse IP/oda başına sınır eklenir.
function siniriDenetle() {
  const c = CacheService.getScriptCache(), k = 'sinir' + Math.floor(Date.now() / 60000);
  const n = Number(c.get(k) || 0) + 1;
  if (n > 300) throw new Error('Çok fazla istek, biraz sonra yeniden dene');
  c.put(k, String(n), 120);
}

// Cloudflare TURN: 6 saatlik kimlik; farklı ağlardaki (kurumsal, mobil) kişilerin bağlanabilmesi için.
function iceSunuculari() {
  const id = ayar('CF_TURN_ID'), anahtar = ayar('CF_TURN_TOKEN');
  if (!id || !anahtar) throw new Error('TURN ayarlı değil');
  const r = UrlFetchApp.fetch('https://rtc.live.cloudflare.com/v1/turn/keys/' + encodeURIComponent(id) + '/credentials/generate-ice-servers', {
    method: 'post', contentType: 'application/json', headers: { Authorization: 'Bearer ' + anahtar },
    payload: JSON.stringify({ ttl: 6 * 3600 }), muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 201 && r.getResponseCode() !== 200) throw new Error('TURN kimliği alınamadı (' + r.getResponseCode() + ')');
  // 53 numaralı port tarayıcılarda zaman aşımına düşebiliyor (Cloudflare belgesi): ayıklanır
  const sunucular = JSON.parse(r.getContentText()).iceServers.map((s) =>
    Object.assign({}, s, { urls: [].concat(s.urls).filter((u) => !/:53(\?|$)/.test(u)) }));
  return { ok: true, iceServers: sunucular };
}

// LiveKit erişim bileti (JWT, HS256). Oda adı görüşme kanalıdır; kimlik ERP'de doğrulanmış kullanıcı kimliği.
function livekitBileti(g, kullanici) {
  const url = ayar('LIVEKIT_URL'), anahtar = ayar('LIVEKIT_KEY'), gizli = ayar('LIVEKIT_SECRET');
  if (!url || !anahtar || !gizli) throw new Error('LiveKit ayarlı değil');
  const kimlik = kullanici ? kullanici.id : String(g.kimlik || '');
  if (!/^[0-9a-f-]{36}$/.test(kimlik)) throw new Error('Geçersiz kimlik');
  const simdi = Math.floor(Date.now() / 1000);
  const bilet = jwt({
    iss: anahtar, sub: kimlik, name: String(g.ad || 'Katılımcı').slice(0, 60), nbf: simdi - 10, exp: simdi + 6 * 3600,
    video: { room: 'ekip-' + String(g.oda), roomJoin: true, canPublish: true, canSubscribe: true, canPublishData: true },
  }, gizli);
  return { ok: true, url: url, token: bilet };
}

function jwt(govde, gizli) {
  const b64 = (v) => Utilities.base64EncodeWebSafe(v).replace(/=+$/, '');
  const metin = (o) => Utilities.newBlob(JSON.stringify(o)).getBytes(); // UTF-8 (ad Türkçe karakter içerebilir)
  const ust = b64(metin({ alg: 'HS256', typ: 'JWT' })) + '.' + b64(metin(govde));
  return ust + '.' + b64(Utilities.computeHmacSha256Signature(ust, gizli));
}

// Claude Messages API (Apps Script'te resmî SDK yok, doğrudan HTTP). Reddedilen istek sunucu tarafında
// Anthropic'in önerdiği modele yönlendirilir (fallbacks: "default").
function claude(sistem, metin) {
  const anahtar = ayar('ANTHROPIC_API_KEY');
  if (!anahtar) throw new Error('Claude anahtarı ayarlı değil');
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post', contentType: 'application/json', muteHttpExceptions: true,
    headers: { 'x-api-key': anahtar, 'anthropic-version': '2026-10-21', 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    payload: JSON.stringify({
      model: 'claude-opus-5-5', max_tokens: 16000, output_config: { effort: 'low' }, fallbacks: 'default',
      system: sistem, messages: [{ role: 'user', content: metin }],
    }),
  });
  const j = JSON.parse(r.getContentText());
  if (r.getResponseCode() !== 200) throw new Error('Claude hatası: ' + ((j.error && j.error.message) || r.getResponseCode()));
  if (j.stop_reason === 'refusal') throw new Error('Claude bu isteği yanıtlamadı');
  return j.content.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
}

function toplantiOzeti(g) {
  const metin = String(g.metin || '');
  if (!metin.trim()) throw new Error('Özetlenecek döküm yok');
  const sistem = 'Bir iş toplantısının otomatik konuşma dökümünü ve toplantı içi sohbetini alacaksın. Döküm konuşma tanımadan ' +
    'geldiği için yazım ve duyma hataları olabilir; bağlamdan anlamı çıkar. Toplantı konusu: ' + String(g.konu || '-').slice(0, 120) + '.\n' +
    'Türkçe, en fazla 3000 karakter yaz. Markdown kullanma; başlıkları büyük harfle, maddeleri "• " ile yaz. Bölümler:\n' +
    'ÖZET (3-6 madde)\nKARARLAR\nAKSİYONLAR (her biri: kim — ne — ne zaman; dökümde yoksa "belirtilmedi")\nAÇIK KALAN SORULAR\n' +
    'Dökümde geçmeyen bilgi, kişi, tarih ekleme. Bir bölüm boşsa "Yok" yaz.';
  return { ok: true, ozet: claude(sistem, metin) };
}

// Kanala geç gelen kişi için okumadığı mesajların özeti (yalnız ona gösterilir, kanala yazılmaz).
function kacirdiklar(g) {
  const metin = String(g.metin || '').slice(0, 120000);
  if (!metin.trim()) throw new Error('Özetlenecek mesaj yok');
  const sistem = 'Bir iş ekibinin sohbet kanalında, kullanıcı yokken yazılmış mesajları alacaksın. Kanal: ' + String(g.konu || '-').slice(0, 120) +
    '. Kullanıcının adı: ' + String(g.ben || '-').slice(0, 60) + '.\n' +
    'Kullanıcının hızlıca neyi kaçırdığını anlaması için Türkçe, en fazla 1500 karakter yaz. Markdown kullanma; maddeleri "• " ile yaz.\n' +
    'Önce 2-5 maddede ne konuşulduğu. Sonra varsa "SENDEN BEKLENEN" (kullanıcıya soru, istek, görev) ve "KARARLAR" bölümleri; yoksa o bölümü yazma.\n' +
    'Kimin ne dediğini adıyla belirt. Mesajlarda geçmeyen bilgi ekleme.';
  return { ok: true, ozet: claude(sistem, metin) };
}

// Kanal hafızası: istemci soruyla ilgili mesaj ve kayıt konuşması alıntılarını seçip gönderir; yanıt yalnız bunlardan verilir.
function kanalaSor(g) {
  const soru = String(g.soru || '').slice(0, 500), baglam = String(g.metin || '').slice(0, 80000);
  if (!soru.trim() || !baglam.trim()) throw new Error('Soru ya da kanal geçmişi yok');
  const sistem = 'Bir iş ekibinin sohbet kanalındaki mesajlardan ve görüşme kayıtlarının konuşma dökümlerinden seçilmiş alıntıları alacaksın. ' +
    'Kanal: ' + String(g.konu || '-').slice(0, 120) + '. Soruyu YALNIZ bu alıntılara dayanarak Türkçe, en fazla 1200 karakterle yanıtla. ' +
    'Markdown kullanma; maddeleri "• " ile yaz. Her bilginin yanında kim söyledi ve ne zaman olduğunu yaz (örn. "Ayşe, 12.10"). ' +
    'Alıntılarda cevap yoksa bunu açıkça söyle; tahmin etme, bilgi uydurma. Konuşma dökümleri sesten yazıya çevrildiği için yazım hataları olabilir.';
  return { ok: true, cevap: claude(sistem, 'SORU: ' + soru + '\n\nALINTILAR:\n' + baglam) };
}

// Uygulamadaki Ayarlar'dan Claude anahtarı: yalnız ERP yöneticisi; önce Anthropic'e denenir, sonra komut dosyası özelliğine yazılır.
// Anahtar hiçbir yanıtta geri dönmez.
function claudeAnahtarKaydet(g, kullanici) {
  if (!kullanici.yonetici) throw new Error('Anahtarı yalnız ERP yöneticisi değiştirebilir');
  const a = String(g.anahtar || '').trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(a)) throw new Error('Anahtar "sk-ant-" ile başlamalı');
  const r = UrlFetchApp.fetch('https://api.anthropic.com/v1/models?limit=1', {
    headers: { 'x-api-key': a, 'anthropic-version': '2026-10-21' }, muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) throw new Error('Anahtar Anthropic tarafından kabul edilmedi (' + r.getResponseCode() + ')');
  PropertiesService.getScriptProperties().setProperty('ANTHROPIC_API_KEY', a);
  return { ok: true };
}

function cevir(g) {
  const dil = DILLER[g.dil];
  if (!dil) throw new Error('Desteklenmeyen dil');
  const sistem = 'Kullanıcının gönderdiği toplantı konuşması satırını ' + dil + ' diline çevir. Yalnız çeviriyi yaz, açıklama ekleme. ' +
    'Satır zaten ' + dil + ' ise aynen yaz.';
  return { ok: true, metin: claude(sistem, String(g.metin || '').slice(0, 500)) };
}

// Drive'da devam ettirilebilir yükleme oturumu açar; dönen adrese parçalar sırayla gönderilir.
function oturumBaslat(g, kullanici) {
  const r = UrlFetchApp.fetch(OTURUM_ONEK + '&fields=id', {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'X-Upload-Content-Type': g.tur || 'application/octet-stream' },
    payload: JSON.stringify({
      name: String(g.ad || 'dosya').slice(0, 200),
      parents: [klasor().getId()],
      description: 'Yükleyen: ' + kullanici.email + ' · kanal: ' + String(g.kanal || '').slice(0, 120),
    }),
    muteHttpExceptions: true,
  });
  if (r.getResponseCode() !== 200) throw new Error('Drive yükleme oturumu açılamadı (' + r.getResponseCode() + ')');
  const basliklar = r.getHeaders();
  return { ok: true, oturum: basliklar.Location || basliklar.location };
}

function parcaGonder(g) {
  // Yalnız Drive'ın yükleme adresine yazılır; başka adrese istek atılmaz.
  if (typeof g.oturum !== 'string' || g.oturum.indexOf(OTURUM_ONEK) !== 0) throw new Error('Geçersiz yükleme oturumu');
  const bayt = Utilities.base64Decode(g.veri || '');
  const bas = Number(g.bas) || 0;
  const toplam = g.son ? bas + bayt.length : '*';
  const aralik = bayt.length ? 'bytes ' + bas + '-' + (bas + bayt.length - 1) + '/' + toplam : 'bytes */' + bas;
  const r = UrlFetchApp.fetch(g.oturum, {
    method: 'put',
    contentType: g.tur || 'application/octet-stream',
    headers: { 'Content-Range': aralik },
    payload: bayt,
    muteHttpExceptions: true,
  });
  const kod = r.getResponseCode();
  if (kod === 308) return { ok: true, devam: true };
  if (kod !== 200 && kod !== 201) throw new Error('Drive parça yüklemesi başarısız (' + kod + ')');
  const dosya = DriveApp.getFileById(JSON.parse(r.getContentText()).id);
  dosya.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { ok: true, url: dosya.getUrl(), boyut: dosya.getSize() };
}

// Her parçada Supabase'e sormamak için doğrulanmış oturum 5 dakika önbellekte tutulur.
function kullaniciDogrula(token) {
  if (!token) throw new Error('ERP oturumu yok');
  const anahtar = 'k' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token));
  const onbellek = CacheService.getScriptCache();
  const kayitli = onbellek.get(anahtar);
  if (kayitli) return JSON.parse(kayitli);
  const basliklar = { apikey: SUPA_KEY, Authorization: 'Bearer ' + token };
  const u = UrlFetchApp.fetch(SUPA_URL + '/auth/v1/user', { headers: basliklar, muteHttpExceptions: true });
  if (u.getResponseCode() !== 200) throw new Error('Oturum geçersiz, ERP\'ye yeniden giriş yapın');
  const kul = JSON.parse(u.getContentText());
  const r = UrlFetchApp.fetch(SUPA_URL + '/rest/v1/erp_users?select=approved,is_admin&id=eq.' + encodeURIComponent(kul.id),
                              { headers: basliklar, muteHttpExceptions: true });
  const satir = JSON.parse(r.getContentText())[0];
  if (!satir || !satir.approved) throw new Error('ERP onayı yok');
  const sonuc = { id: kul.id, email: kul.email, yonetici: !!satir.is_admin };
  onbellek.put(anahtar, JSON.stringify(sonuc), 300);
  return sonuc;
}

function klasor() {
  const it = DriveApp.getFoldersByName(KLASOR_ADI);
  return it.hasNext() ? it.next() : DriveApp.createFolder(KLASOR_ADI);
}

function yanit(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

// Editörden elle çalıştırılan deneme: parçalı yüklemeyi doğrular, deneme dosyasını çöpe atar.
function denemeParcali() {
  const o = oturumBaslat({ ad: 'parcali-deneme.bin', tur: 'application/octet-stream', kanal: 'deneme' }, { email: 'deneme' });
  const p1 = Utilities.base64Encode(Utilities.newBlob(new Array(262145).join('x')).getBytes());
  const ara = parcaGonder({ oturum: o.oturum, bas: 0, veri: p1, son: false });
  const son = parcaGonder({ oturum: o.oturum, bas: 262144, veri: Utilities.base64Encode(Utilities.newBlob('son').getBytes()), son: true });
  Logger.log('ara: ' + JSON.stringify(ara) + ' | son: ' + JSON.stringify(son));
  DriveApp.getFileById(son.url.match(/[-\w]{25,}/)[0]).setTrashed(true);
}

// Editörden elle çalıştırılan deneme: hangi anahtarların çalıştığını yazar (anahtar değerlerini yazmaz).
function denemeAyarlar() {
  const sonuc = {};
  const dene = (ad, fn) => { try { sonuc[ad] = fn(); } catch (e) { sonuc[ad] = 'HATA: ' + e.message; } };
  dene('TURN', () => iceSunuculari().iceServers.length + ' sunucu grubu');
  dene('LiveKit', () => {
    const url = ayar('LIVEKIT_URL'), simdi = Math.floor(Date.now() / 1000);
    if (!url) throw new Error('ayarlı değil');
    const bilet = jwt({ iss: ayar('LIVEKIT_KEY'), sub: 'deneme', nbf: simdi - 10, exp: simdi + 300, video: { roomList: true } }, ayar('LIVEKIT_SECRET'));
    const r = UrlFetchApp.fetch(url.replace(/^wss:/, 'https:') + '/twirp/livekit.RoomService/ListRooms', {
      method: 'post', contentType: 'application/json', payload: '{}', headers: { Authorization: 'Bearer ' + bilet }, muteHttpExceptions: true,
    });
    return r.getResponseCode() === 200 ? 'çalışıyor' : 'HATA ' + r.getResponseCode();
  });
  dene('Claude', () => claude('Yalnız "tamam" yaz.', 'deneme').slice(0, 20));
  Logger.log(JSON.stringify(sonuc));
}
