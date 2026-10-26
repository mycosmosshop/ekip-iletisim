// Ekip İletişim bildirim gönderici (Cloudflare Worker): sayfa kapalıyken telefona/bilgisayara Web Push.
// POST /gonder {kanal, kisiler?, haric?, baslik, govde, url, etiket?, cagri?}  — Authorization: Bearer <Supabase oturumu>
// Alıcıları Supabase'teki ekip_push_hedefler, gönderenin kendi oturumuyla verir: kanala erişimi olmayan kimseye bildirim
// gidemez. Şifreleme RFC 8291 (aes128gcm), gönderici kimliği RFC 8292 (VAPID, ES256); yalnız WebCrypto.
// Gizli anahtar: wrangler secret put VAPID_JWK (özel anahtarın JWK'si). Açık anahtar index.html'deki VAPID_ACIK.

const SUPA_URL = 'https://chchaielttnimuuezazb.supabase.co';
const SUPA_KEY = 'sb_publishable_S2ywbq7TkgcZKiVif3td-A_oAuQL3QT';
const IZINLI_KOKEN = ['https://mycosmosshop.github.io', 'http://localhost:8810'];
const UYGULAMA = 'https://mycosmosshop.github.io/ekip-iletisim/';
const ILETISIM = 'mailto:volkanpekatik@gmail.com';

const metinBayt = (s) => new TextEncoder().encode(s);
const b64u = (b) => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64uCoz = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
const birlestir = (...p) => { const t = new Uint8Array(p.reduce((n, x) => n + x.length, 0)); let i = 0; for (const x of p) { t.set(x, i); i += x.length; } return t; };

async function hkdf(tuz, gizli, bilgi, uzunluk) {
  const k = await crypto.subtle.importKey('raw', gizli, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: tuz, info: bilgi }, k, uzunluk * 8));
}

// RFC 8291: alıcının açık anahtarı (p256dh) ve auth sırrıyla tek kayıtlık aes128gcm gövdesi.
async function sifrele(veri, p256dh, authSir) {
  const aliciAcik = b64uCoz(p256dh), auth = b64uCoz(authSir);
  const gecici = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const geciciAcik = new Uint8Array(await crypto.subtle.exportKey('raw', gecici.publicKey));
  const alici = await crypto.subtle.importKey('raw', aliciAcik, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ortak = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: alici }, gecici.privateKey, 256));
  const ikm = await hkdf(auth, ortak, birlestir(metinBayt('WebPush: info\0'), aliciAcik, geciciAcik), 32);
  const tuz = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(tuz, ikm, metinBayt('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(tuz, ikm, metinBayt('Content-Encoding: nonce\0'), 12);
  const anahtar = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const sifreli = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, anahtar, birlestir(veri, new Uint8Array([2]))));
  const ust = new Uint8Array(21); ust.set(tuz); new DataView(ust.buffer).setUint32(16, 4096); ust[20] = geciciAcik.length;
  return birlestir(ust, geciciAcik, sifreli);
}

// RFC 8292: bildirim servisine "bu bildirimi açık anahtarı VAPID_ACIK olan uygulama gönderiyor" imzası.
async function vapid(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const ozel = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const ust = b64u(metinBayt(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const govde = b64u(metinBayt(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: ILETISIM })));
  const imza = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ozel, metinBayt(ust + '.' + govde));
  const acik = b64u(birlestir(new Uint8Array([4]), b64uCoz(jwk.x), b64uCoz(jwk.y)));
  return `vapid t=${ust}.${govde}.${b64u(imza)}, k=${acik}`;
}

async function bildirimGonder(abone, veri, env, acil) {
  const r = await fetch(abone.endpoint, {
    method: 'POST',
    headers: { Authorization: await vapid(abone.endpoint, env), 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
               TTL: acil ? '60' : '86400', Urgency: acil ? 'high' : 'normal' },
    body: await sifrele(veri, abone.p256dh, abone.auth),
  });
  return r.status;
}

const supa = (yol, token, govde) => fetch(SUPA_URL + '/rest/v1/rpc/' + yol, {
  method: 'POST', headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify(govde),
});

// 5 dakikada bir (wrangler.jsonc crons): 5–15 dakika içinde başlayacak planlı toplantıları kanala erişenlerin cihazlarına
// hatırlatır. Supabase işlevi her toplantıyı bir kez verir. Gizli anahtar: wrangler secret put HATIRLATMA_GIZLI.
async function toplantilariHatirlat(env) {
  const r = await fetch(SUPA_URL + '/rest/v1/rpc/ekip_toplanti_hatirlat', {
    method: 'POST', headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + SUPA_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ gizli: env.HATIRLATMA_GIZLI }),
  });
  if (!r.ok) { console.log('hatırlatma sorgusu', r.status, await r.text()); return; }
  const satirlar = await r.json();
  // ponytail: cron'da oturum yok, ölü abonelik silinmez; gönderen birinin bildirim isteğinde silinir.
  await Promise.all(satirlar.map((s) => {
    const dk = Math.max(1, Math.round((Date.parse(s.bas) - Date.now()) / 60000));
    const url = typeof s.link === 'string' && s.link.startsWith(UYGULAMA) ? s.link : UYGULAMA;
    const veri = metinBayt(JSON.stringify({ baslik: `📅 ${String(s.konu || 'Toplantı').slice(0, 60)} · ${dk} dakika sonra`, govde: 'Katılmak için dokun',
                                            url, etiket: 't-' + s.mesaj_id, cagri: false }));
    return bildirimGonder(s, veri, env, true).catch(() => 0);
  }));
}

export default {
  async scheduled(olay, env, ctx) { ctx.waitUntil(toplantilariHatirlat(env)); },
  async fetch(istek, env) {
    const koken = istek.headers.get('Origin') || '';
    const cors = { 'Access-Control-Allow-Origin': IZINLI_KOKEN.includes(koken) ? koken : IZINLI_KOKEN[0],
                   'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'POST, OPTIONS', Vary: 'Origin' };
    const yanit = (o, durum = 200) => new Response(JSON.stringify(o), { status: durum, headers: { ...cors, 'Content-Type': 'application/json' } });
    if (istek.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (istek.method !== 'POST' || new URL(istek.url).pathname !== '/gonder') return yanit({ ok: false, hata: 'Bulunamadı' }, 404);
    const token = (istek.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    if (!token) return yanit({ ok: false, hata: 'ERP oturumu yok' }, 401);
    let g;
    try { g = await istek.json(); } catch (e) { return yanit({ ok: false, hata: 'Geçersiz istek' }, 400); }
    let aboneler;
    if (g.deneme) {
      // Ayarlardaki "Deneme bildirimi": yalnız gönderenin kendi cihazları (tablo kuralı başkasınınkini göstermez).
      const h = await fetch(SUPA_URL + '/rest/v1/ekip_push?select=endpoint,p256dh,auth', { headers: { apikey: SUPA_KEY, Authorization: 'Bearer ' + token } });
      if (!h.ok) return yanit({ ok: false, hata: 'Yetki yok (' + h.status + ')' }, 403);
      aboneler = await h.json();
    } else {
      if (typeof g.kanal !== 'string' || !g.kanal || g.kanal.length > 120) return yanit({ ok: false, hata: 'Kanal yok' }, 400);
      const uuidler = (a) => (Array.isArray(a) ? a.filter((x) => /^[0-9a-f-]{36}$/.test(x)).slice(0, 100) : null);
      const h = await supa('ekip_push_hedefler', token, { k: g.kanal, kisiler: uuidler(g.kisiler), haric: uuidler(g.haric) || [] });
      if (!h.ok) return yanit({ ok: false, hata: 'Yetki yok (' + h.status + ')' }, 403);
      aboneler = await h.json();
    }
    // Bildirim yalnız uygulamanın kendi sayfasını açabilir; başka adrese yönlendirme yok.
    const url = typeof g.url === 'string' && g.url.startsWith(UYGULAMA) ? g.url : UYGULAMA;
    const veri = metinBayt(JSON.stringify({ baslik: String(g.baslik || 'Ekip İletişim').slice(0, 80), govde: String(g.govde || '').slice(0, 240),
                                            url, etiket: String(g.etiket || '').slice(0, 64), cagri: !!g.cagri }));
    const sonuc = await Promise.all(aboneler.map((a) => bildirimGonder(a, veri, env, !!g.cagri).catch(() => 0)));
    const olu = aboneler.filter((a, i) => sonuc[i] === 404 || sonuc[i] === 410);
    await Promise.all(olu.map((a) => supa('ekip_push_sil', token, { e: a.endpoint }).catch(() => {})));
    return yanit({ ok: true, gonderilen: sonuc.filter((s) => s >= 200 && s < 300).length, alici: aboneler.length, silinen: olu.length });
  },
};
