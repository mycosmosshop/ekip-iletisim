/* Ekip İletişim — Drive dosya yükleme (Google Apps Script web uygulaması)
   Kurulum: script.google.com → Yeni proje → bu kodu yapıştır →
   Dağıt → Yeni dağıtım → Web uygulaması; "Şu kullanıcı olarak çalıştır: Ben", "Erişim: Herkes".
   Çıkan /exec adresini index.html içindeki DOSYA_URL'ye yaz.
   Yükleme yalnız ERP'de onaylı kullanıcıya açık: istekteki Supabase oturumu burada doğrulanır. */

const SUPA_URL = 'https://chchaielttnimuuezazb.supabase.co';
const SUPA_KEY = 'sb_publishable_S2ywbq7TkgcZKiVif3td-A_oAuQL3QT';
const KLASOR_ADI = 'Ekip İletişim Dosyaları';
const SINIR = 25 * 1024 * 1024;

function doPost(e) {
  try {
    const g = JSON.parse(e.postData.contents);
    const kullanici = kullaniciDogrula(g.token);
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

function kullaniciDogrula(token) {
  if (!token) throw new Error('ERP oturumu yok');
  const basliklar = { apikey: SUPA_KEY, Authorization: 'Bearer ' + token };
  const u = UrlFetchApp.fetch(SUPA_URL + '/auth/v1/user', { headers: basliklar, muteHttpExceptions: true });
  if (u.getResponseCode() !== 200) throw new Error('Oturum geçersiz, ERP\'ye yeniden giriş yapın');
  const kul = JSON.parse(u.getContentText());
  const r = UrlFetchApp.fetch(SUPA_URL + '/rest/v1/erp_users?select=approved&id=eq.' + encodeURIComponent(kul.id),
                              { headers: basliklar, muteHttpExceptions: true });
  const satir = JSON.parse(r.getContentText())[0];
  if (!satir || !satir.approved) throw new Error('ERP onayı yok');
  return kul;
}

function klasor() {
  const it = DriveApp.getFoldersByName(KLASOR_ADI);
  return it.hasNext() ? it.next() : DriveApp.createFolder(KLASOR_ADI);
}

function yanit(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
