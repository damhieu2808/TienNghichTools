// Popup chỉ là giao diện: nạp tn.js vào frame game rồi gọi các hàm trong window.TN.

const out = document.getElementById('out');
const status = document.getElementById('status');
const setStatus = (text, state) => { status.textContent = text; status.dataset.state = state; };

async function getTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab.id;
}

// Nạp tn.js vào game nếu chưa có hoặc file đã đổi (so mã băm), để không phá log/hành động đang chạy.
async function ensureTN(tabId) {
  const src = await (await fetch('tn.js')).text();
  let h = 0;
  for (let i = 0; i < src.length; i++) h = (h * 31 + src.charCodeAt(i)) | 0;
  const target = { tabId, allFrames: true };
  const checks = await chrome.scripting.executeScript({
    target, world: 'MAIN', args: [h],
    func: h => (typeof NetMgr !== 'undefined' && !(window.TN && window.TN.__hash === h)),
  });
  if (!checks.some(r => r.result)) return;
  await chrome.scripting.executeScript({ target, world: 'MAIN', files: ['tn.js'] });
  await chrome.scripting.executeScript({
    target, world: 'MAIN', args: [h],
    func: h => { if (window.TN) window.TN.__hash = h; },
  });
}

// Gọi window.TN[name](...args) trong frame có game.
async function callTN(name, args = []) {
  setStatus('Đang chạy...', 'run');
  out.value = '';
  try {
    const tabId = await getTabId();
    await ensureTN(tabId);
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      world: 'MAIN',
      // Bắt lỗi ngay trong frame: lỗi ném ra ngoài làm result rỗng, popup sẽ tưởng là không có game.
      func: async (name, args) => {
        if (!window.TN) return null;
        try {
          return { ok: await window.TN[name](...args) };
        } catch (e) {
          return { ok: `LỖI ${name}: ${(e && e.stack) || e}` };
        }
      },
      args: [name, args],
    });
    const hit = results.find(r => r.result);
    if (!hit) {
      setStatus('Không tìm thấy game trong tab này (đã vào game chưa?)', 'err');
      return;
    }
    const res = hit.result.ok;
    out.value = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
    setStatus('Xong', 'ok');
  } catch (e) {
    setStatus('Lỗi', 'err');
    out.value = String(e && e.message || e);
  }
}

// Chế độ Prod/Dev: Dev hiện thêm khung ghi log + chạy code; nhớ lựa chọn trong localStorage của extension.
function setMode(mode) {
  document.body.className = `mode-${mode}`;
  document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
  try { localStorage.setItem('mode', mode); } catch {}
}
let savedMode = 'prod';
try { savedMode = localStorage.getItem('mode') || 'prod'; } catch {}
setMode(savedMode);
document.querySelectorAll('input[name=mode]').forEach(r => (r.onchange = () => setMode(r.value)));

const bind = (id, fn) => (document.getElementById(id).onclick = fn);
bind('btnAll', () => callTN('runAll'));
bind('btnTasks', () => callTN('readDailyTasks'));
bind('btnClaim', () => callTN('claimAll'));
bind('btnGift', () => callTN('giftFriends'));
bind('btnArena', () => callTN('arena'));
bind('btnFete', () => callTN('guildFete'));
bind('btnHelp', () => callTN('guildHelp'));
bind('btnRecruit', () => callTN('recruit'));
bind('btnEndless', () => callTN('endlessTrial'));
bind('btnDungeon', () => callTN('guildDungeon'));
bind('btnTravel', () => callTN('travel'));
bind('btnDaily', () => callTN('dailyDungeon'));
bind('btnTower', () => callTN('tower'));
bind('btnQuick', () => callTN('quickFight'));
bind('btnDice', () => callTN('dice'));
bind('btnSnatch', () => callTN('gldSnatch'));
bind('btnAbyss', () => callTN('abyss'));
bind('btnClimb', () => callTN('towerClimb', [Number(document.getElementById('climbTimes').value) || 20]));
bind('btnPb', () => callTN('dungeonFight', [
  Number(document.getElementById('pbType').value),
  Number(document.getElementById('pbTimes').value) || 20,
]));
bind('btnSpirit', () => callTN('spiritHarvest'));
bind('btnKfLol', () => callTN('kfLol'));
bind('btnYin', () => callTN('extremeYin'));
bind('btnMwPreview', () => callTN('mwPreview'));
bind('btnMwOpt', () => callTN('mwOptimize'));
bind('btnMwRestore', () => callTN('mwRestore'));
const benchTimes = () => Number(document.getElementById('benchTimes').value) || 10;
bind('btnMwLab', () => callTN('mwLab', [benchTimes()]));
bind('btnMwBest', () => callTN('mwApplyBest'));
bind('btnStop', () => callTN('stop'));
bind('btnPeek', () => callTN('peek'));
bind('btnRecStart', () => callTN('startRecord'));
bind('btnRecStop', () => callTN('stopRecord'));
bind('btnRun', () => callTN('runCode', [document.getElementById('code').value]));
bind('btnCopy', async () => {
  await navigator.clipboard.writeText(out.value);
  setStatus('Đã copy', 'ok');
});
