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

// Trạng thái trực tiếp trong game (log đang chạy, job). Không nạp tn.js: chưa có TN thì trả null.
async function readState(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, allFrames: true },
    world: 'MAIN',
    func: () => (window.TN && window.TN.liveState ? window.TN.liveState() : null),
  });
  const hit = results.find(r => r.result);
  return hit ? hit.result : null;
}

// Hỏi định kỳ: dòng job luôn cập nhật; khi game đang chạy việc thì hiện log trực tiếp, trừ vài giây ngay
// sau khi một nút trả kết quả (holdUntil) để kịp đọc kết quả đó.
const jobLine = document.getElementById('jobLine');
let holdUntil = 0;
let showingLive = false;
let firstPoll = true;
async function poll() {
  try {
    const st = await readState(await getTabId());
    if (!st) return;
    jobLine.textContent = st.job;
    if (st.busy && Date.now() > holdUntil) {
      out.value = st.log || '(chưa có log)';
      out.scrollTop = out.scrollHeight;
      setStatus('Đang chạy...', 'run');
      showingLive = true;
    } else if (!st.busy && (showingLive || (firstPoll && !out.value)) && st.last) {
      // Việc vừa xong (hoặc mở popup lúc rảnh): hiện trọn log lần chạy cuối, kể cả dòng báo dừng/lỗi.
      out.value = st.last;
      out.scrollTop = out.scrollHeight;
      setStatus(`Xong lúc ${st.lastAt}`, 'ok');
      showingLive = false;
    }
    firstPoll = false;
  } catch {}
}
setInterval(poll, 1500);
poll();

// Gọi window.TN[name](...args) trong frame có game.
async function callTN(name, args = []) {
  setStatus('Đang chạy...', 'run');
  out.value = '';
  holdUntil = 0;
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
    holdUntil = Date.now() + 5000;
    showingLive = false;
    const hit = results.find(r => r.result);
    if (!hit) {
      setStatus('Không tìm thấy game trong tab này (đã vào game chưa?)', 'err');
      return;
    }
    const res = hit.result.ok;
    out.value = typeof res === 'string' ? res : JSON.stringify(res, null, 2);
    setStatus('Xong', 'ok');
  } catch (e) {
    holdUntil = Date.now() + 5000;
    setStatus('Lỗi', 'err');
    out.value = String(e && e.message || e);
  }
}

// Chế độ Prod/Dev: Dev hiện thêm khung ghi log + chạy code; nhớ lựa chọn trong localStorage của extension.
function setMode(mode) {
  document.body.classList.remove('mode-prod', 'mode-dev');
  document.body.classList.add(`mode-${mode}`);
  document.querySelector(`input[name=mode][value=${mode}]`).checked = true;
  try { localStorage.setItem('mode', mode); } catch {}
}

let saved = 'prod';
try { saved = localStorage.getItem('mode') || 'prod'; } catch {}
setMode(saved);
document.querySelectorAll('input[name=mode]').forEach(r => (r.onchange = () => setMode(r.value)));

const bind = (id, fn) => (document.getElementById(id).onclick = fn);
bind('btnAll', () => callTN('runAll', [
  Number(document.getElementById('ancientFloors').value) || 6,
  Number(document.getElementById('mirageSec').value) || 15,
]));
bind('btnTasks', () => callTN('readDailyTasks'));
bind('btnClaim', () => callTN('claimAll'));
bind('btnExtra', () => callTN('dailyExtra'));
bind('btnGift',() => callTN('giftFriends'));
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
bind('btnBoss', () => callTN('gldBoss'));
bind('btnSnatch', () => callTN('gldSnatch'));
bind('btnAbyss', () => callTN('abyss'));
bind('btnClimb', () => callTN('towerClimb', [Number(document.getElementById('climbTimes').value) || 20]));
bind('btnArenaN', () => callTN('arenaFight', [Number(document.getElementById('arenaTimes').value) || 1]));
bind('btnPb',() => callTN('dungeonFight', [
  Number(document.getElementById('pbType').value),
  Number(document.getElementById('pbTimes').value) || 20,
]));
bind('btnSpirit', () => callTN('spiritHarvest'));
bind('btnRuins', () => callTN('ruinsAll'));
bind('btnAllRepeat', () => callTN('runAllRepeat'));
bind('btnTienDuyen', () => callTN('tienDuyen'));
bind('btnAncient', () => callTN('ancientLand', [Number(document.getElementById('ancientFloors').value) || 6]));
bind('btnMirage', () => callTN('mirageMatch', [Number(document.getElementById('mirageSec').value) || 15]));
bind('btnKfLol', () => callTN('kfLol'));
bind('btnChuThien', () => callTN('chuThien'));
bind('btnThanLam', () => callTN('thanLam'));
bind('btnCampTowers', () => callTN('campTowers'));
bind('btnYin', () => callTN('extremeYin'));
bind('btnMountain', () => callTN('forbiddenMountain'));
bind('btnKimThu', () => callTN('kimThu'));
bind('btnUyChan', () => callTN('uyChan'));
bind('btnHoaThu', () => callTN('hoaThu'));
bind('btnThienThuan', () => callTN('thienThuan'));
bind('btnTienNghich', () => callTN('tienNghich'));
bind('btnTonHon', () => callTN('tonHon'));
bind('btnVanHop', () => callTN('vanHop'));
bind('btnDucAn', () => callTN('ducAn'));
bind('btnMaHai', () => callTN('maHai'));
bind('btnTienDi', () => callTN('tienDi'));
bind('btnLuckyWheel', () => callTN('luckyWheel'));
bind('btnAllEvents', () => callTN('runAllEvents'));
bind('btnUyenNhi', () => callTN('uyenNhi'));
bind('btnGuildWar', () => callTN('guildWar'));
bind('btnHoaPham', () => callTN('hoaPham'));
bind('btnNguHanh', () => callTN('nguHanh'));
bind('btnMwPreview', () => callTN('mwPreview'));
bind('btnMwOpt', () => callTN('mwOptimize'));
bind('btnMwRestore', () => callTN('mwRestore'));
const benchTimes = () => Number(document.getElementById('benchTimes').value) || 10;
bind('btnMwLab', () => callTN('mwLab', [benchTimes()]));
bind('btnMwBest', () => callTN('mwApplyBest'));
bind('btnJobOn', () => callTN('jobStart', [Number(document.getElementById('jobMin').value) || 30]));
bind('btnJobOff', () => callTN('jobStop'));
bind('btnJobStatus', () => callTN('jobStatus'));
bind('btnJobNow', () => callTN('jobRunNow'));
bind('btnStop',() => callTN('stop'));
bind('btnPeek', () => callTN('peek'));
bind('btnRecStart', () => callTN('startRecord'));
bind('btnRecStop', () => callTN('stopRecord'));
bind('btnRun', () => callTN('runCode', [document.getElementById('code').value]));
bind('btnCopy', async () => {
  await navigator.clipboard.writeText(out.value);
  setStatus('Đã copy', 'ok');
});
