// Key dùng tool.
// - Admin: nhập đúng ADMIN_PASSWORD trong admin.js (file chỉ có ở máy admin, KHÔNG gửi kèm khi chia sẻ).
// - User: key 10 ký tự "XXXXX-XXXXX" = 4 ký tự giờ hết hạn + 1 ký tự ngẫu nhiên + 5 ký tự mã kiểm tra
//   (HMAC-SHA256 với LIC_SECRET). Key chứa sẵn hạn dùng nên không cần server; hạn tính từ lúc admin tạo key.
// Giờ dùng để xét hạn: giờ server game (người dùng không sửa được), không có game thì giờ máy; luôn lấy
// max với giờ lớn nhất từng thấy để chỉnh lùi đồng hồ máy không gia hạn được key.

const LIC_SECRET = 'tn-tool:7f3c9a1e-5b2d-4e8f-a6c4-91d0b7e25f38';
const LIC_STORE = 'licenseKey';
const LAST_SEEN = 'licLastSeen';
const ALPHA = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // 32 ký tự, bỏ 0/1/O/I dễ nhầm
const EPOCH = Date.UTC(2026, 0, 1);
const HOUR = 3600000;
const FOREVER = 32 ** 4 - 1; // giờ hết hạn đặc biệt = vĩnh viễn

const store = {
  get: k => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
};

const toChars = (n, len) => {
  let s = '';
  for (let i = 0; i < len; i++, n = Math.floor(n / 32)) s = ALPHA[n % 32] + s;
  return s;
};
const fromChars = s => [...s].reduce((n, c) => n * 32 + ALPHA.indexOf(c), 0);

async function macOf(body) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(LIC_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body)));
  return [...sig.slice(0, 5)].map(b => ALPHA[b % 32]).join('');
}

// Giờ tin cậy: giờ server game (nếu popup đọc được) hoặc giờ máy, không bao giờ lùi so với lần trước.
async function trustedNow(serverMs) {
  const last = Number(store.get(LAST_SEEN)) || 0;
  const now = Math.max(serverMs || Date.now(), last);
  store.set(LAST_SEEN, String(now));
  return now;
}

// Kiểm tra key: trả {role, exp, label} hoặc {error}. exp = 0 là vĩnh viễn.
async function verifyKey(key, now) {
  key = String(key || '').trim();
  if (!key) return { error: 'Chưa nhập key' };
  if (typeof ADMIN_PASSWORD === 'string' && ADMIN_PASSWORD && key === ADMIN_PASSWORD) {
    return { role: 'admin', exp: 0, label: 'admin' };
  }
  const k = key.toUpperCase().replace(/[\s-]/g, '');
  if (k.length !== 10 || [...k].some(c => !ALPHA.includes(c))) return { error: 'Key không đúng' };
  if ((await macOf(k.slice(0, 5))) !== k.slice(5)) return { error: 'Key không đúng' };
  const hours = fromChars(k.slice(0, 4));
  const exp = hours === FOREVER ? 0 : EPOCH + hours * HOUR;
  if (exp && now > exp) return { error: `Key đã hết hạn lúc ${new Date(exp).toLocaleString('vi-VN')}` };
  return { role: 'user', exp, label: `${k.slice(0, 5)}-${k.slice(5)}` };
}

// Tạo key user hết hạn sau `days` ngày tính từ `now` (làm tròn lên giờ). days 0 = vĩnh viễn.
async function makeKey(days, now) {
  const hours = days > 0 ? Math.ceil((now - EPOCH + days * 24 * HOUR) / HOUR) : FOREVER;
  const body = toChars(hours, 4) + ALPHA[crypto.getRandomValues(new Uint8Array(1))[0] % 32];
  const key = body + (await macOf(body));
  return { key: `${key.slice(0, 5)}-${key.slice(5)}`, exp: hours === FOREVER ? 0 : EPOCH + hours * HOUR };
}
