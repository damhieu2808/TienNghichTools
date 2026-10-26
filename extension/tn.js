// Nạp vào frame game (world MAIN). Tạo window.TN chứa toàn bộ logic chạy trong game.
(() => {
  if (typeof NetMgr === 'undefined') return;

  const IGNORE = { 10010: 1, 10012: 1 }; // heartbeat
  const waiters = []; // { cmd, resolve, timer }
  let recLog = null;

  // ---- Hook cổng gửi/nhận của NetMgr ----
  // Giữ hàm gốc ở __tnOrig để nạp lại tn.js (sau khi sửa extension) không bọc hook chồng lên nhau.
  const P = NetMgr.prototype;
  P.__tnOrig = P.__tnOrig || { send: P.sendMsg, dispatch: P.dispatchEvent };
  const origSend = P.__tnOrig.send;
  const origDispatch = P.__tnOrig.dispatch;
  // Log phải chụp bản sao ngay lúc gửi/nhận: code game sửa trực tiếp object sau đó
  // (vd đặt free_famous=0 sau khi chiêu mộ), giữ tham chiếu sẽ in ra giá trị đã bị sửa.
  const snapshot = v => {
    try { return JSON.parse(JSON.stringify(v)); } catch { return v; }
  };
  P.sendMsg = function (cmd, data) {
    if (recLog && !IGNORE[cmd]) {
      // Tên hàm gọi tới (vd "e.send30503") để biết lệnh đến từ Ctrl nào.
      const from = (new Error().stack || '').split('\n').slice(2, 6)
        .map(l => (l.match(/at ([\w$.]+) /) || [])[1]).filter(Boolean);
      recLog.push({ t: Date.now(), dir: 'SEND', cmd, data: snapshot(data), from });
    }
    return origSend.apply(this, arguments);
  };
  P.dispatchEvent = function (ev) {
    if (ev instanceof NetEvent && !IGNORE[ev.type]) {
      if (recLog) recLog.push({ t: Date.now(), dir: 'RECV', cmd: ev.type, data: snapshot(ev.netData) });
      // waitRecv nhận object gốc (không sao chép): các id Long trong đó còn được gửi lại server.
      for (let i = waiters.length - 1; i >= 0; i--) {
        const w = waiters[i];
        if (w.cmd == ev.type) {
          waiters.splice(i, 1);
          bg.cancel(w.timer);
          w.resolve(ev.netData);
        }
      }
    }
    return origDispatch.apply(this, arguments);
  };

  // ---- Chạy ngầm khi tab bị ẩn / cửa sổ thu nhỏ ----
  // Chrome dừng requestAnimationFrame (thứ đẩy egret.ticker) và hãm setTimeout của tab ẩn xuống 1 lần/giây,
  // ẩn lâu còn 1 lần/phút. Hẹn giờ trong Web Worker không bị hãm, nên Worker vừa đẩy nhịp game khi tab ẩn,
  // vừa lo các hẹn giờ của tool. Worker giữ ở window.__tnBg để nạp lại tn.js không tạo thêm Worker.
  const bg = window.__tnBg || (window.__tnBg = (() => {
    const cbs = {};
    let seq = 0;
    try {
      const src = 'const T={};onmessage=e=>{const d=e.data;if(d.ms!=null)T[d.id]=setTimeout(()=>{delete T[d.id];postMessage(d.id)},d.ms);else{clearTimeout(T[d.id]);delete T[d.id]}};setInterval(()=>postMessage(0),33);';
      const worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = e => {
        const id = e.data;
        if (id === 0) {
          if (document.hidden) egret.ticker.update();
          return;
        }
        const cb = cbs[id];
        delete cbs[id];
        if (cb) cb();
      };
      return {
        ok: true,
        later: (fn, ms) => { const id = ++seq; cbs[id] = fn; worker.postMessage({ id, ms }); return id; },
        cancel: id => { delete cbs[id]; worker.postMessage({ id }); },
      };
    } catch (e) {
      console.warn('[TN] không tạo được Worker, tab ẩn sẽ chạy chậm', e);
      return { ok: false, later: (fn, ms) => setTimeout(fn, ms), cancel: id => clearTimeout(id) };
    }
  })());

  // ---- Tiện ích ----
  const sleep = ms => new Promise(r => bg.later(r, ms));
  // Chờ server trả về lệnh cmd; hết giờ thì trả null.
  const waitRecv = (cmd, timeout = 5000) => new Promise(resolve => {
    const w = { cmd, resolve };
    w.timer = bg.later(() => {
      waiters.splice(waiters.indexOf(w), 1);
      resolve(null);
    }, timeout);
    waiters.push(w);
  });
  // Dịch phản hồi lỗi của server (mã số ở msg, có lệnh để ở code) sang câu chữ của game.
  const errText = r => {
    if (!r) return 'không phản hồi';
    const id = r.msg != null && r.msg !== '' ? r.msg : r.code;
    const text = id != null && GlobalCtrl.gInst().getNetErrorMsg(id);
    return text ? `"${text}" (${id})` : JSON.stringify(r);
  };
  const longVal = v => (v && typeof v === 'object' ? v.m_highInt * 4294967296 + (v.m_lowInt >>> 0) : Number(v) || 0);
  const isFighting = () => EntityMgr.gInst().getIsFighting();
  // Chờ trận đấu kết thúc; trong lúc đó bấm "Bỏ qua" (fightPass tự kiểm tra game có cho bỏ qua không).
  const waitNotFighting = async (timeout = 60000) => {
    const end = Date.now() + timeout;
    while (isFighting() && Date.now() < end) {
      EntityMgr.gInst().fightPass();
      await sleep(500);
    }
  };

  // Cờ dừng cho các hành động lặp dài (vd leo tháp); bật bằng TN.stop().
  let stopFlag = false;

  const out = [];
  const log = msg => {
    out.push(msg);
    console.log('[TN]', msg);
  };
  const takeLog = () => out.splice(0).join('\n');

  // ---- Nhiệm vụ ngày (AcvCtrl) ----
  const TASK_STATUS = { 0: 'đang làm', 1: 'xong - chưa nhận', 2: 'đã nhận' };
  const getTask = id => (AcvCtrl.gInst().taskDt || []).find(t => t.task_id == id);
  const taskCfg = id => AcvCtrl.gInst().getCurlModel().gTaskCfg(id) || {};
  // Số lần còn phải làm của nhiệm vụ id.
  const taskRemain = id => {
    const t = getTask(id);
    if (!t || t.status != 0) return 0;
    return Math.max(0, (taskCfg(id).value || 0) - t.progress);
  };

  function readDailyTasks() {
    const ctrl = AcvCtrl.gInst();
    return {
      active: `${ctrl.curActive}/${ctrl.maxActive}`,
      boxes: ctrl.tskStateLs,
      tasks: (ctrl.taskDt || []).map(t => {
        const cfg = taskCfg(t.task_id);
        return {
          id: t.task_id,
          name: String(cfg.name || '').replace(/<[^>]+>/g, ''),
          progress: `${t.progress}/${cfg.value}`,
          status: TASK_STATUS[t.status] ?? t.status,
        };
      }),
    };
  }

  // Nhận thưởng mọi nhiệm vụ đã xong + mở các rương sôi nổi đã đạt.
  async function claimAll() {
    const ctrl = AcvCtrl.gInst();
    const done = (ctrl.taskDt || []).filter(t => t.status == 1);
    for (const t of done) {
      ctrl.send30503(t.task_id);
      const r = await waitRecv(30503);
      log(`Nhận NV ${t.task_id} "${String(taskCfg(t.task_id).name || '').replace(/<[^>]+>/g, '')}": ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
      await sleep(300);
    }
    const boxes = ctrl.tskStateLs || [];
    for (let i = 0; i < boxes.length; i++) {
      if (ctrl.tskStateLs[i] != AcvConst.ETaskState.finish) continue;
      ctrl.send30504(i);
      const r = await waitRecv(30504);
      log(`Mở rương ${[25, 50, 75, 100][i]}: ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
      await sleep(300);
    }
    if (!done.length && !boxes.some(s => s == AcvConst.ETaskState.finish)) log('Không có gì để nhận');
    log(`Sôi nổi: ${ctrl.curActive}/${ctrl.maxActive}`);
    await claimAchievements();
  }

  // Thành tựu: 12501 danh sách {id, progress, status} (status 1 = xong chưa nhận), 12503 {id} nhận. Nhận xong
  // server mở mốc kế của chuỗi (vd 121 -> 122) có thể cũng đã xong, nên đọc lại tới khi hết.
  async function claimAchievements() {
    let got = 0;
    const failed = new Set();
    for (let round = 0; round < 20; round++) {
      NetMgr.gInst().sendMsg(12501, {});
      const r = await waitRecv(12501);
      const ready = ((r && r.achieve_list) || []).filter(a => a.status == 1 && !failed.has(a.id));
      if (!ready.length) break;
      for (const a of ready) {
        NetMgr.gInst().sendMsg(12503, { id: a.id });
        const c = await waitRecv(12503);
        if (c && c.res == 1) got++;
        else {
          failed.add(a.id);
          log(`Thành tựu ${a.id}: lỗi ${errText(c)}`);
        }
        await sleep(200);
      }
    }
    log(`Thành tựu: nhận ${got} mốc`);
  }

  // NV 2: Tặng điểm tình bạn cho mọi bạn chưa được tặng.
  async function giftFriends() {
    const ctrl = FriendCtrl.gInst();
    ctrl.send11801Msg();
    const data = await waitRecv(11801);
    if (!data) return log('Không lấy được danh sách bạn bè');
    // Server giới hạn 30 lượt tặng/ngày (lỗi 1013019 "đã đạt giới hạn"); client không có hằng số này.
    const GIVE_MAX = 30;
    const left = GIVE_MAX - data.energy_give_count;
    const notGiven = (data.list || []).filter(f => f.energy_give_status == 0);
    log(`Bạn bè: ${(data.list || []).length} người, chưa tặng ${notGiven.length}, đã tặng hôm nay ${data.energy_give_count}/${GIVE_MAX}`);
    if (left <= 0) return log('Đã tặng đủ giới hạn hôm nay');
    if (!notGiven.length) return log('Đã tặng hết');
    const list = notGiven.slice(0, left);
    ctrl.send11812Msg(list);
    const r = await waitRecv(11812);
    log(`Tặng tình bạn cho ${list.length} người: ${r && r.res != 0 ? 'OK' : 'lỗi ' + errText(r)}`);
  }

  // Nhận điểm tình bạn bạn bè đã tặng: 11813 {ids:[{id}]} như nút getAndSendLove. Cờ "đã được tặng" trong
  // danh sách 11801 chưa rõ tên nên lấy trường energy_*_status khác energy_give_status, 1 = chờ nhận.
  async function acceptFriends() {
    const ctrl = FriendCtrl.gInst();
    ctrl.send11801Msg();
    const data = await waitRecv(11801);
    if (!data) return log('Nhận tình bạn: không lấy được danh sách bạn bè');
    const list = data.list || [];
    const key = Object.keys(list[0] || {}).find(k => /^energy_.*_status$/.test(k) && k != 'energy_give_status');
    if (!key) return log('Nhận tình bạn: không tìm thấy cờ nhận trong danh sách bạn bè');
    const pending = list.filter(f => f[key] == 1);
    if (!pending.length) return log('Nhận tình bạn: không có ai tặng chờ nhận');
    NetMgr.gInst().sendMsg(11813, { ids: pending.map(f => ({ id: f.id })) });
    const r = await waitRecv(11813);
    log(`Nhận tình bạn từ ${pending.length} người: ${r && r.res == 1 ? `OK (đã nhận ${r.energy_accept_count} hôm nay)` : 'lỗi ' + errText(r)}`);
  }

  // NV 4: Đấu Tiên Đài — đánh đủ ARENA_DAILY trận/ngày (nhiều hơn mức 3 của nhiệm vụ), chọn đối thủ lực chiến
  // thấp nhất. Server không cho biết số trận hôm nay nên lấy max(tiến độ nhiệm vụ, số trận tool đã đánh hôm nay);
  // tiến độ nhiệm vụ có thể dừng ở 3 nên tool tự đếm trong localStorage của game.
  const ARENA_DAILY = 10;
  const arenaKey = 'tnArenaDaily';
  const today = () => new Date().toDateString();
  const arenaDoneByTool = () => {
    try {
      const s = JSON.parse(localStorage.getItem(arenaKey) || '{}');
      return s.day === today() ? s.count || 0 : 0;
    } catch { return 0; }
  };
  const arenaCountUp = () => {
    try { localStorage.setItem(arenaKey, JSON.stringify({ day: today(), count: arenaDoneByTool() + 1 })); } catch {}
  };
  async function arena() {
    const t = getTask(4);
    const done = Math.max(t ? t.progress || 0 : 0, arenaDoneByTool());
    const need = ARENA_DAILY - done;
    if (need <= 0) return log(`Đấu Tiên Đài: hôm nay đã đánh đủ ${ARENA_DAILY} trận`);
    log(`Đấu Tiên Đài: hôm nay đã đánh ${done}/${ARENA_DAILY}, đánh thêm ${need} trận`);
    await arenaFight(need);
  }

  // Đánh `times` trận Đấu Tiên Đài liên tiếp (dùng cho nhiệm vụ ngày và hành động đặc biệt). Dừng bằng TN.stop().
  async function arenaFight(times) {
    const ctrl = ArenaCtrl.gInst();
    const need = times;
    for (let n = 1; n <= need; n++) {
      if (stopFlag) return log(`Đấu Tiên Đài: đã dừng sau ${n - 1} trận`);
      await jobGate();
      ctrl.send14201();
      const info = await waitRecv(14201);
      const enemies = (info && info.enemy_list) || [];
      if (!enemies.length) return log('Đấu Tiên Đài: không lấy được danh sách đối thủ');
      if (n == 1) {
        // Tick "Bỏ qua chiến đấu" như trên UI: chỉ khi tổng số trận đã đánh đạt ngưỡng của game.
        const cfg = ctrl.getArenaBaseCofVo(ArenaConst.EArenaType.arena_skip_fight);
        const minCount = (cfg && Number(cfg.val)) || 30;
        if (info.his_total_count >= minCount) {
          ctrl.skipArenaFight = true;
          log(`Đấu Tiên Đài: bật bỏ qua chiến đấu (đã đánh ${info.his_total_count} trận)`);
        } else {
          log(`Đấu Tiên Đài: chưa được tick bỏ qua (${info.his_total_count}/${minCount} trận), sẽ bấm "Bỏ qua" trong trận`);
        }
      }
      const enemy = enemies.reduce((a, b) => (longVal(b.fc) < longVal(a.fc) ? b : a));
      // Server chặn bấm liên tục ("Thao tác nhanh quá rồi~", 100009): chờ rồi thử lại.
      let r;
      for (let tries = 0; tries < 4; tries++) {
        await waitNotFighting();
        ctrl.reqChnlgeEmy(enemy.order, enemy.id);
        r = await waitRecv(14202, 10000);
        if (!r || r.res == 1 || (r.msg != 100009 && r.code != 100009)) break;
        await sleep(3000);
      }
      if (!r || r.res != 1) return log(`Đấu Tiên Đài trận ${n}: lỗi ${errText(r)}`);
      arenaCountUp();
      log(`Đấu Tiên Đài trận ${n}/${need}: đánh ${enemy.name} (LC ${longVal(enemy.fc)}) - xong`);
      await sleep(3000);
      await waitNotFighting();
    }
  }

  // NV 8: Cung phụng Tổ Sư Đường. type 1 tốn Bạc; type 2, 3 tốn Tiên Ngọc nên không dùng.
  async function guildFete() {
    const ctrl = GuildCtrl.gInst();
    ctrl.send18035Msg();
    const info = await waitRecv(18035);
    if (!info) return log('Cung phụng: không lấy được thông tin (chưa vào Tông Môn?)');
    if (info.fate_type != 0) return log(`Cung phụng: hôm nay đã cung phụng (mức ${info.fate_type})`);
    ctrl.send18036Msg(1);
    const r = await waitRecv(18036);
    log(`Cung phụng mức 1 (Bạc): ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
  }

  // NV 12: Viện Trợ Tông Môn — chỉ dùng 7 lượt miễn phí mỗi ngày: info.count là số lượt miễn phí đã dùng,
  // info.max_count là giới hạn. Dừng khi đã dùng hết, server báo lỗi, hoặc hết ô cần viện trợ.
  async function guildHelp() {
    const ctrl = GuildCtrl.gInst();
    let done = 0;
    for (let guard = 0; guard < 30; guard++) {
      ctrl.send18040Msg();
      const info = await waitRecv(18040);
      if (!info) return log('Viện trợ: không lấy được danh sách (chưa vào Tông Môn?)');
      if (guard == 0) {
        log(`Viện trợ: count=${info.count}/${info.max_count}, vip=${info.vip_count}/${info.max_vip_count}, ${(info.list || []).length} ô cần viện trợ`);
      }
      if (info.count >= info.max_count) return log(`Viện trợ: xong ${done} lượt, đã dùng hết ${info.max_count} lượt miễn phí hôm nay`);
      const target = (info.list || []).find(x => x.be_count < x.max_count);
      if (!target) return log(`Viện trợ: xong ${done} lượt, hết người cần viện trợ`);
      ctrl.send18042Msg(target.id, target.pos);
      const r = await waitRecv(18042);
      if (!r || r.res != 1) return log(`Viện trợ: xong ${done} lượt, dừng vì server báo ${errText(r)}`);
      done++;
      log(`Viện trợ ${target.name} (ô ${target.pos}): OK`);
      await sleep(400);
    }
  }

  // NV 3: Chiêu mộ Tu Sĩ — chỉ dùng lượt miễn phí và vé, KHÔNG tiêu Tiên Ngọc
  // (chiêu mộ danh tiếng không có vé sẽ trừ 250 Tiên Ngọc).
  async function recruit() {
    const need = taskRemain(3);
    if (!need) return log('Chiêu mộ: nhiệm vụ đã đủ');
    const ctrl = RecruitCtrl.gInst();
    const WAR = 1, FAMOUS = 3;
    for (let n = 1; n <= need; n++) {
      ctrl.reqRecruitInfo();
      const info = await waitRecv(30401);
      if (!info) return log('Chiêu mộ: không lấy được thông tin');
      if (n == 1) {
        log(`Chiêu mộ: miễn phí thường=${info.free_war}, miễn phí danh tiếng=${info.free_famous}, vé thường=${info.war_item_count}, vé danh tiếng=${info.famous_item_count}`);
      }
      const [type, how] =
        info.free_famous ? [FAMOUS, 'danh tiếng miễn phí'] :
        info.free_war ? [WAR, 'thường miễn phí'] :
        info.famous_item_count > 0 ? [FAMOUS, 'vé danh tiếng'] :
        info.war_item_count > 0 ? [WAR, 'vé thường'] : [];
      if (!type) return log(`Chiêu mộ: hết lượt miễn phí và vé, còn thiếu ${need - n + 1} lần (không dùng Tiên Ngọc)`);
      ctrl.reqRecruitHero(type, 1);
      const r = await waitRecv(30402);
      if (!r || r.res != 1) return log(`Chiêu mộ lần ${n} (${how}): lỗi ${errText(r)}`);
      log(`Chiêu mộ lần ${n}/${need} (${how}): OK`);
      await sleep(1500);
    }
  }

  // NV 7: Bí Cảnh Tông Môn — lần đầu đánh thật (quét cần đã có sát thương), sau đó quét.
  // Hết lượt miễn phí thì mua thêm, chỉ đủ cho nhiệm vụ và chỉ khi giá <= MAX_BUY_GOLD Tiên Ngọc.
  async function guildDungeon() {
    const MAX_BUY_GOLD = 20;
    const need = taskRemain(7);
    if (!need) return log('Bí Cảnh: nhiệm vụ đã đủ');
    const ctrl = GuildCtrl.gInst();
    ctrl.send18050Msg();
    const list = await waitRecv(18050);
    if (!list || !list.cur_id) return log('Bí Cảnh: không lấy được danh sách (chưa vào Tông Môn?)');
    const id = list.cur_id;
    for (let n = 1; n <= need; n++) {
      ctrl.send18052Msg();
      const info = await waitRecv(18052);
      if (!info) return log('Bí Cảnh: không lấy được thông tin lượt');
      const hasFree = info.max_count - info.fight_count > 0;
      const canSweep = longVal(info.max_hurt) > 0;
      let how;
      if (hasFree && !canSweep) {
        // Đánh thật lần đầu.
        await waitNotFighting();
        ctrl.saveGuildDungeonFightData(id);
        ctrl.send18053Msg(id);
        const r = await waitRecv(18053, 10000);
        if (!r || r.res != 1) return log(`Bí Cảnh ${id} lần ${n}: lỗi ${errText(r)}`);
        how = `đánh, sát thương ${longVal(r.hurt)}`;
        await sleep(1000);
        await waitNotFighting();
      } else if (hasFree) {
        ctrl.send18054Msg(id);
        const r = await waitRecv(18054);
        if (!r || r.res != 1) return log(`Bí Cảnh ${id} lần ${n}: quét lỗi ${errText(r)}`);
        how = 'quét';
      } else {
        const cost = ctrl.getCurlModel().getDungeonBuyLoss(info.buy_count);
        if (!cost) return log(`Bí Cảnh: hết lượt và không mua thêm được, còn thiếu ${need - n + 1} lần`);
        if (cost > MAX_BUY_GOLD) return log(`Bí Cảnh: hết lượt, mua thêm giá ${cost} Tiên Ngọc > giới hạn ${MAX_BUY_GOLD}, còn thiếu ${need - n + 1} lần`);
        if (!canSweep) return log('Bí Cảnh: hết lượt và chưa đánh lần nào nên không quét được');
        // type 2 = mua lượt + quét. Khi giao diện Bí Cảnh đang mở, game tự gửi lệnh quét; không thì tool gửi.
        const sweep = waitRecv(18054, 1500);
        ctrl.send18057Msg(2);
        const r = await waitRecv(18057);
        if (!r || r.res != 1) return log(`Bí Cảnh: mua lượt lỗi ${errText(r)}`);
        let s = await sweep;
        if (!s) {
          ctrl.send18054Msg(id);
          s = await waitRecv(18054);
        }
        if (!s || s.res != 1) return log(`Bí Cảnh ${id} lần ${n}: quét sau khi mua lỗi ${errText(s)}`);
        how = `mua lượt (${cost} Tiên Ngọc) + quét`;
      }
      log(`Bí Cảnh ${id} lần ${n}/${need}: ${how} - OK`);
      await sleep(500);
    }
  }

  // NV 10: Treo Thưởng (TravelCtrl) — nhận thưởng việc đã xong, rồi phái tu sĩ (như khi tick "tự ủy phái")
  // cho các việc cấp cao tới khi hết điểm thưởng. Hết việc cấp cao thì làm mới: server tự trừ theo thứ tự
  // lượt miễn phí > thẻ làm mới > Tiên Ngọc; làm mới bằng Tiên Ngọc giới hạn MAX_GOLD_REFRESH lần. Không dùng "tăng tốc".
  async function travel() {
    const MIN_RARE = 4; // Sử Thi trở lên — game dùng đúng ngưỡng này trong isShiShiUp()
    const MAX_GOLD_REFRESH = 10;
    const REFRESH_CARD = 1000160; // PropsConst.BASE_ID_REFRESH_GOODS
    let goldRefreshes = 0;
    const gold0 = RoleCtrl.gInst().getRoleInfo().gold;
    const ctrl = TravelCtrl.gInst();
    // Nhận thưởng treo máy tích lũy (14110 xem, 14103 nhận) trước khi phái việc.
    const hang = await evReq(14110, {});
    if (hang && (hang.list || []).length) {
      const r = await evReq(14103, {});
      log(`Treo Thưởng: nhận thưởng treo máy (${hang.list.length} loại): ${evOk(r) ? 'OK' : 'lỗi ' + errText(r)}`);
    } else {
      log('Treo Thưởng: chưa có thưởng treo máy');
    }
    // Dữ liệu 30201 thô không có travel_value/rare_id/event_name; game ghép từ config vào ctrl.travelInfo
    // khi xử lý (chạy trước khi await trả về), nên luôn đọc travelInfo.
    const refresh = async () => {
      ctrl.send30201();
      return (await waitRecv(30201)) && ctrl.travelInfo;
    };
    let info = await refresh();
    if (!info) return log('Treo Thưởng: không lấy được danh sách');
    const now = NetMgr.gInst().getTime();
    if ((info.event_list || []).some(e => e.finish_time > 0 && e.finish_time <= now)) {
      ctrl.send30205();
      const r = await waitRecv(30205);
      log(`Treo Thưởng: nhận thưởng việc đã xong: ${r && r.res == 1 ? `OK (${(r.finish_list || []).length} việc)` : 'lỗi ' + errText(r)}`);
      info = await refresh();
      if (!info) return;
    }
    const cfgOf = e => ctrl.getEventConfigByBaseId(e.base_id) || {};
    const rareOf = e => (e.rare_id != null ? e.rare_id : cfgOf(e).rare_id);
    const rareName = e => {
      const c = ctrl.getRareConfigById(rareOf(e));
      return String((c && c.name) || `cấp ${rareOf(e)}`).replace(/<[^>]+>/g, '');
    };
    const evName = e => String(e.event_name || cfgOf(e).name || e.id).replace(/<[^>]+>/g, '');
    log(`Treo Thưởng: các việc hiện có: ${(info.event_list || []).map(e => `${evName(e)} [${rareName(e)}, rare_id=${rareOf(e)}]${e.finish_time ? ' (đang làm)' : ''}`).join('; ')}`);

    const skipped = new Set();
    let sent = 0;
    for (let guard = 0; guard < 40; guard++) {
      const point = RoleCtrl.gInst().getRoleInfo().travel;
      // Cấp cao nhất phái trước, phòng khi điểm thưởng không đủ cho tất cả.
      const todo = (info.event_list || [])
        .filter(e => e.finish_time == 0 && !skipped.has(e.id) && rareOf(e) >= MIN_RARE)
        .sort((a, b) => rareOf(b) - rareOf(a));
      const ev = todo.find(e => e.travel_value <= point);
      if (!ev) {
        if (todo.length) return log(`Treo Thưởng: phái ${sent} việc, hết điểm thưởng (còn ${point})`);
        // Không còn việc cấp cao chưa phái: làm mới nếu còn đủ điểm để phái tiếp.
        const minCost = Math.min(...(info.event_list || []).map(e => e.travel_value));
        const spent = () => gold0 - RoleCtrl.gInst().getRoleInfo().gold;
        if (point < minCost) return log(`Treo Thưởng: phái ${sent} việc, hết điểm thưởng (còn ${point}). Tiên Ngọc đã dùng: ${spent()}`);
        const cards = PropsCtrl.gInst().findGoodsNum(REFRESH_CARD);
        let how;
        if (info.left_ref_times > 0) how = `miễn phí (còn ${info.left_ref_times - 1} lượt)`;
        else if (cards > 0) how = `dùng thẻ (còn ${cards - 1} thẻ)`;
        else if (goldRefreshes < MAX_GOLD_REFRESH) how = `dùng Tiên Ngọc (lần ${++goldRefreshes}/${MAX_GOLD_REFRESH})`;
        else return log(`Treo Thưởng: phái ${sent} việc, dừng vì đã làm mới bằng Tiên Ngọc ${MAX_GOLD_REFRESH} lần (điểm thưởng còn ${point}). Tiên Ngọc đã dùng: ${spent()}`);
        const next = waitRecv(30201); // on30204 tự gửi lại 30201
        ctrl.send30204();
        const r = await waitRecv(30204);
        if (!r || r.res != 1) return log(`Treo Thưởng: làm mới ${how} lỗi ${errText(r)}`);
        await sleep(200);
        log(`Treo Thưởng: làm mới ${how}${goldRefreshes ? `, Tiên Ngọc đã dùng: ${spent()}` : ''}`);
        info = ((await next) && ctrl.travelInfo) || (await refresh());
        log(`Treo Thưởng: sau làm mới: ${(info.event_list || []).map(e => `${evName(e)} [${rareName(e)}]${e.finish_time ? ' (đang làm)' : ''}`).join('; ')}`);
        if (!info) return;
        continue;
      }
      const ids = [...new Set((ctrl.getHeroList(ev.cond_list) || []).map(h => h.id))].map(id => ({ id }));
      // Hết tu sĩ rảnh thì dừng hẳn, không làm mới tiếp (tránh tốn thẻ/Tiên Ngọc vô ích).
      if (!ids.length) return log(`Treo Thưởng: phái ${sent} việc, hết tu sĩ rảnh (điểm thưởng còn ${point})`);
      ctrl.send30202(ev.id, ids);
      const r = await waitRecv(30202);
      if (!r || r.res != 1) {
        log(`Treo Thưởng: phái "${evName(ev)}" lỗi ${errText(r)}`);
        skipped.add(ev.id);
      } else {
        sent++;
        log(`Treo Thưởng: phái "${evName(ev)}" [${rareName(ev)}] - OK`);
      }
      await sleep(400);
      info = await refresh();
      if (!info) return log('Treo Thưởng: không lấy lại được danh sách');
    }
  }

  // NV 6: Thông Thiên Tháp (DailyDungeon type 1) — còn lượt miễn phí thì quét tầng cao nhất đã qua; hết lượt
  // (thường do PB Ngày đã quét nhanh) thì mua lượt + quét (11007 type 2, game tự gửi lệnh quét), chỉ khi giá
  // <= MAX_BUY_GOLD Tiên Ngọc. getDungeonDataList của game có lúc lỗi "reading 'length'", khi đó không đọc được
  // giá thì chỉ mua lượt đầu tiên trong ngày (giá FIRST_BUY_GOLD).
  async function tower() {
    const TOWER = 1;
    const BASE = 1010000;
    const MAX_BUY_GOLD = 20;
    const FIRST_BUY_GOLD = 20;
    const need = taskRemain(6);
    if (!need) return log('Thông Thiên Tháp: nhiệm vụ đã đủ');
    const ctrl = DailyDungeonCtrl.gInst();
    for (let n = 1; n <= need; n++) {
      ctrl.send11004(TOWER);
      const info = await waitRecv(11004);
      if (!info) return log('Thông Thiên Tháp: không lấy được thông tin');
      const free = ((ctrl.gDgnTypeCfg(TOWER) || {}).count || 0) - (info.enter_count || 0);
      if (!info.max_pass_dungoen_id) return log('Thông Thiên Tháp: chưa qua tầng nào, không quét được');
      const id = info.max_pass_dungoen_id;
      await waitNotFighting();
      let how;
      if (free > 0) {
        ctrl.send11005(id);
        how = `quét (còn ${free - 1} lượt miễn phí)`;
      } else {
        if (!(info.total_buy_count > (info.buy_count || 0))) return log(`Thông Thiên Tháp: hết lượt và hết lượt mua, còn thiếu ${need - n + 1} lần`);
        let cost;
        try {
          const item = (ctrl.getDungeonDataList(TOWER) || []).find(x => x.dungeon_baseVo && x.dungeon_baseVo.dungeon_id == id);
          cost = item ? item.cost_money : undefined;
        } catch {}
        if (cost == null && !info.buy_count) cost = FIRST_BUY_GOLD;
        if (cost == null) return log(`Thông Thiên Tháp: hết lượt, không đọc được giá mua (đã mua ${info.buy_count} lần) nên không mua`);
        if (cost > MAX_BUY_GOLD) return log(`Thông Thiên Tháp: mua thêm giá ${cost} Tiên Ngọc > giới hạn ${MAX_BUY_GOLD}, còn thiếu ${need - n + 1} lần`);
        ctrl.send11007(id, TOWER, 2);
        const b = await waitRecv(11007);
        if (!b || b.res != 1) return log(`Thông Thiên Tháp: mua lượt lỗi ${errText(b)}`);
        how = `mua lượt (${cost} Tiên Ngọc) + quét`;
      }
      const r = await waitRecv(11005);
      if (!r || r.res != 1) return log(`Thông Thiên Tháp tầng ${id - BASE} lần ${n}: lỗi ${errText(r)}`);
      log(`Thông Thiên Tháp tầng ${id - BASE} lần ${n}/${need}: ${how} - OK`);
      await sleep(500);
    }
  }

  // NV 5: Tác chiến nhanh (nút quickBtnClick, lệnh 14105 không tham số). Giá theo lượt trong ngày: miễn phí,
  // 50, 100 Tiên Ngọc; server trả left_free_count / left_buy_count / next_cost cho lượt sau.
  // Lượt đầu chưa biết giá nên suy từ tiến độ nhiệm vụ (đã làm p lượt -> lượt kế giá QUICK_COST[p]).
  async function quickFight() {
    const QUICK_COST = [0, 50, 100];
    const MAX_GOLD = 100;
    const need = taskRemain(5);
    if (!need) return log('Tác chiến nhanh: nhiệm vụ đã đủ');
    const t = getTask(5);
    let cost = QUICK_COST[t ? t.progress : 0];
    for (let n = 1; n <= need; n++) {
      if (cost == null || cost > MAX_GOLD) return log(`Tác chiến nhanh: lượt kế giá ${cost ?? '?'} Tiên Ngọc > giới hạn ${MAX_GOLD}, còn thiếu ${need - n + 1} lần`);
      await waitNotFighting();
      NetMgr.gInst().sendMsg(14105, {});
      const r = await waitRecv(14105, 10000);
      if (!r || r.res != 1) return log(`Tác chiến nhanh lần ${n}: lỗi ${errText(r)}`);
      log(`Tác chiến nhanh lần ${n}/${need}: ${cost ? cost + ' Tiên Ngọc' : 'miễn phí'} - OK`);
      cost = r.left_free_count > 0 ? 0 : r.left_buy_count > 0 ? r.next_cost : null;
      await sleep(1000);
    }
  }

  // Di tích tiên giới (RainRuinsCtrl): mỗi đội rảnh thu thập 1 ô. Chọn ô cấp cao nhất (cùng cấp lấy ô trên cùng);
  // nếu mọi ô trống đều cấp 1 và còn lượt đổi miễn phí (base cfg free_refresh) thì đổi ô (32702) rồi xét lại,
  // hết lượt miễn phí thì vẫn thu thập ô cấp 1. Lệnh: 32700 {flag:1} thông tin, 32703 {index, team_id} thu thập.
  async function ruinsGather() {
    const ctrl = RainRuinsCtrl.gInst();
    const model = ctrl.getCurlModel();
    const net = NetMgr.gInst();
    const base = model.getBaseCfg() || {};
    const freeRefresh = base.free_refresh || 0;
    // getSelfFieldCfg() trả cả bảng ô (ruins_data_json[3]) theo field_id; cấp ô (Lv trên UI) là quality.
    const fieldTable = model.getSelfFieldCfg() || {};
    const fieldCfg = id => fieldTable[id];
    const lvOf = id => {
      const e = fieldCfg(id);
      return e && e.quality != null ? Number(e.quality) : null;
    };

    net.sendMsg(32700, { flag: 1 });
    const info = await waitRecv(32700);
    if (!info) return log('Di tích: không lấy được thông tin');
    let fields = info.field_list || [];
    let refreshed = info.daily_refresh_times || 0;
    let essence = info.essence || 0;
    const cost = base.gather_cost || 1;
    let teams = [];
    try { teams = ctrl.getIdleTeamIdArr() || []; } catch {}
    log(`Di tích: tinh lực ${essence}, đã đổi ${refreshed}/${freeRefresh} lượt miễn phí, đội rảnh: ${teams.join(', ') || 'không có'}`);
    if (!teams.length) return log('Di tích: không có đội rảnh');

    const free = () => fields.filter(f => f.field_id > 0 && f.team_id == 0 && f.state == 0).sort((a, b) => a.index - b.index);
    // index ô: 1-2 hàng trên (1 phải, 2 trái), 3-4 hàng giữa, 5-6 hàng dưới, nên index nhỏ = ở trên.
    const desc = f => `ô ${f.index} ${(fieldCfg(f.field_id) || {}).orefield_desc || f.field_id} (lv ${lvOf(f.field_id) ?? '?'})`;
    for (const team of teams) {
      if (essence < cost) return log(`Di tích: hết tinh lực (${essence})`);
      let pick;
      for (;;) {
        const cands = free();
        if (!cands.length) return log('Di tích: không còn ô trống để thu thập');
        if (cands.some(f => lvOf(f.field_id) == null)) {
          return log(`Di tích: không đọc được cấp của ô, config: ${JSON.stringify(fieldCfg(cands[0].field_id))}`);
        }
        log(`Di tích: các ô trống: ${cands.map(desc).join(', ')}`);
        // sort ổn định: cùng cấp giữ thứ tự ô trên cùng trước.
        const best = [...cands].sort((a, b) => lvOf(b.field_id) - lvOf(a.field_id))[0];
        if (lvOf(best.field_id) > 1 || refreshed >= freeRefresh) { pick = best; break; }
        net.sendMsg(32702, {});
        const r = await waitRecv(32702);
        if (!r || r.res != 1) return log(`Di tích: đổi ô lỗi ${errText(r)}`);
        refreshed = r.daily_refresh_times ?? refreshed + 1;
        // 32702 chỉ trả các ô được đổi: gộp theo index.
        const byIdx = Object.fromEntries((r.field_list || []).map(f => [f.index, f]));
        fields = fields.map(f => byIdx[f.index] || f);
        log(`Di tích: toàn ô lv 1, đổi miễn phí (${refreshed}/${freeRefresh})`);
        await sleep(500);
      }
      net.sendMsg(32703, { index: pick.index, team_id: team });
      const r = await waitRecv(32703);
      if (!r || r.res != 1) return log(`Di tích: đội ${team} thu thập ${desc(pick)} lỗi ${errText(r)}`);
      essence = r.essence ?? essence - cost;
      const byIdx = Object.fromEntries((r.field_list || []).map(f => [f.index, f]));
      fields = fields.map(f => byIdx[f.index] || f);
      log(`Di tích: đội ${team} thu thập ${desc(pick)} - OK (còn ${essence} tinh lực)`);
      await sleep(500);
    }
  }

  // Di tích 2 - chiếm đoạt (liên server, cùng RainRuinsCtrl): mỗi đội rảnh chiếm 1 ô. Ưu tiên ô lv 2 chưa ai
  // chiếm (đánh Di Tích Thủ Vệ), rồi đoạt ô lv 2 của người lực chiến thấp hơn mình (tối đa KF_ROB_MAX lần/ngày),
  // cuối cùng ô lv 1 trống. Mở KF_OPEN_H giờ. Lệnh: 32710 {flag:1} đội + lượt đoạt, 32711 {layer} ô của tầng,
  // 32712 {layer, index} chi tiết ô (người chiếm, fc), 32713 {layer, index, team_id} chiếm/đoạt -> trận 14002.
  // Nút "Di tích": thu thập (Di tích 1) rồi chiếm (Di tích 2); lỗi phần này không chặn phần kia.
  async function ruinsAll() {
    for (const [name, fn] of [['Di tích 1 - Thu', ruinsGather], ['Di tích 2 - Chiếm', kfRuins]]) {
      log(`== ${name} ==`);
      try {
        await fn();
      } catch (e) {
        log(`LỖI ${name}: ${(e && e.message) || e}`);
      }
      await waitNotFighting();
    }
  }

  const KF_LAYERS = 10;
  const KF_ROB_MAX = 2;
  const KF_OPEN_H = [10, 22];
  async function kfRuins() {
    const model = RainRuinsCtrl.gInst().getCurlModel();
    const net = NetMgr.gInst();
    const ask = async (cmd, data, timeout) => {
      net.sendMsg(cmd, data);
      return waitRecv(cmd, timeout);
    };
    const hour = new Date(net.getTime() * 1000).getHours();
    if (hour < KF_OPEN_H[0] || hour >= KF_OPEN_H[1]) return log(`Di tích 2: ngoài giờ mở (${KF_OPEN_H[0]}h - ${KF_OPEN_H[1]}h)`);

    // Bảng ô liên server: thử hàm config có "kf" + "field" trong tên, không có thì dùng bảng ô Di tích 1.
    // Cấp ô (Lv trên UI) là quality như Di tích 1.
    let fieldTable = null;
    for (let o = model; o && o !== Object.prototype && !fieldTable; o = Object.getPrototypeOf(o)) {
      for (const k of Object.getOwnPropertyNames(o)) {
        if (!/kf/i.test(k) || !/field/i.test(k) || !/cfg|config/i.test(k)) continue;
        try {
          const t = typeof model[k] == 'function' ? model[k]() : model[k];
          if (t && typeof t == 'object' && Object.values(t).some(e => e && e.quality != null)) { fieldTable = t; break; }
        } catch {}
      }
    }
    fieldTable = fieldTable || model.getSelfFieldCfg() || {};
    const lvOf = id => {
      const e = fieldTable[id];
      return e && e.quality != null ? Number(e.quality) : null;
    };

    const me = RoleCtrl.gInst().getRoleInfo();
    const myId = longVal(me.id);
    const myGuild = longVal(me.guild_id);
    const myFc = longVal(me.fc);
    // kf_ruins_team_list chỉ chứa đội đang ngồi ô, nên đội rảnh = mọi đội đã mở khóa trừ các đội đó.
    const ctrl = RainRuinsCtrl.gInst();
    let allTeams = [];
    try { allTeams = ctrl.getAllTeamId() || []; } catch {}
    allTeams = allTeams.filter(id => {
      try { return ctrl.checkTeamUnLock(id) !== false; } catch { return true; }
    });
    const status = async () => {
      const s = await ask(32710, { flag: 1 });
      if (!s) return null;
      const busy = new Set((s.kf_ruins_team_list || []).filter(t => t.layer).map(t => t.team_id));
      return {
        rob: s.daily_rob_times || 0,
        idle: allTeams.filter(id => !busy.has(id)),
      };
    };
    let st = await status();
    if (!st) return log('Di tích 2: không lấy được thông tin');
    log(`Di tích 2: lực chiến ${myFc}, đã đoạt ${st.rob}/${KF_ROB_MAX}, đội: ${allTeams.join(', ') || '?'}, đội rảnh: ${st.idle.join(', ') || 'không có'}`);
    if (!st.idle.length) return log('Di tích 2: không có đội rảnh');

    // Quét 10 tầng.
    let fields = [];
    for (let layer = 1; layer <= KF_LAYERS; layer++) {
      const r = await ask(32711, { layer });
      if (!r) { log(`Di tích 2: không đọc được tầng ${layer}`); continue; }
      (r.kf_field_list || []).forEach(f => fields.push({ ...f, layer }));
      await sleep(200);
    }
    if (fields.some(f => f.field_id > 0 && lvOf(f.field_id) == null)) {
      const f = fields.find(f => lvOf(f.field_id) == null);
      return log(`Di tích 2: không đọc được cấp của ô ${f.field_id}, config: ${JSON.stringify(fieldTable[f.field_id])}`);
    }
    const isEmpty = f => !longVal(f.role_id);
    const isEnemy = f => !isEmpty(f) && longVal(f.role_id) != myId && !(myGuild && longVal(f.guild_id) == myGuild);
    const desc = f => `tầng ${f.layer} ô ${f.index} (lv ${lvOf(f.field_id)})`;
    const count = (lv, fn) => fields.filter(f => lvOf(f.field_id) == lv && fn(f)).length;
    log(`Di tích 2: lv 2 trống ${count(2, isEmpty)}, lv 2 có người ${count(2, f => !isEmpty(f))}, lv 1 trống ${count(1, isEmpty)}`);

    const tried = new Set();
    const detail = async f => {
      const d = await ask(32712, { layer: f.layer, index: f.index });
      return d ? { name: d.occupy_name || '?', fc: longVal(d.fc) } : null;
    };
    // Chiếm/đoạt ô f bằng đội team; trả true nếu đội đã ngồi ô.
    const attack = async (team, f, who) => {
      tried.add(`${f.layer}-${f.index}`);
      await waitNotFighting();
      const fight = waitRecv(14002, 10000);
      const r = await ask(32713, { layer: f.layer, index: f.index, team_id: team }, 10000);
      if (!r || r.res != 1) { log(`Di tích 2: đội ${team} -> ${desc(f)} lỗi ${errText(r)}`); return false; }
      const b = await fight;
      await sleep(1000);
      await waitNotFighting();
      st = (await status()) || st;
      const won = !st.idle.includes(team);
      log(`Di tích 2: đội ${team} ${who} ${desc(f)} - ${won ? 'THẮNG, đã chiếm' : b && b.result == 2 ? 'thua' : 'chưa chiếm được'}`);
      return won;
    };
    // Ô trống cấp lv: đánh thủ vệ lực chiến thấp hơn mình, tầng thấp trước.
    const takeEmpty = async (team, lv) => {
      const cands = fields.filter(f => lvOf(f.field_id) == lv && isEmpty(f) && !tried.has(`${f.layer}-${f.index}`));
      for (const f of cands) {
        const d = await detail(f);
        if (!d || d.fc >= myFc) { tried.add(`${f.layer}-${f.index}`); continue; }
        if (await attack(team, f, `chiếm (thủ vệ LC ${d.fc})`)) return true;
      }
      return false;
    };
    // Ô lv 2 có người khác chiếm: đoạt người lực chiến thấp nhất (thấp hơn mình).
    const rob = async team => {
      const cands = [];
      for (const f of fields.filter(f => lvOf(f.field_id) == 2 && isEnemy(f) && !tried.has(`${f.layer}-${f.index}`))) {
        const d = await detail(f);
        if (d && d.fc < myFc) cands.push({ f, d });
        await sleep(100);
      }
      cands.sort((a, b) => a.d.fc - b.d.fc);
      for (const { f, d } of cands) {
        if (st.rob >= KF_ROB_MAX) return false;
        if (await attack(team, f, `đoạt ${d.name} (LC ${d.fc})`)) return true;
      }
      return false;
    };

    for (const team of [...st.idle]) {
      if (await takeEmpty(team, 2)) continue;
      if (st.rob < KF_ROB_MAX && await rob(team)) continue;
      if (await takeEmpty(team, 1)) continue;
      log(`Di tích 2: đội ${team} không tìm được ô phù hợp`);
    }
  }

  // Việc hằng ngày ngoài nhiệm vụ: mô bái top 1 ba bảng xếp hạng, nhận quà miễn phí, điểm danh VIP, thẻ tháng,
  // thư, nhận tình bạn, điểm danh.
  // Gửi lệnh thô như các nút trong game; mục nào đã làm hôm nay thì bỏ qua (xem cờ is_reward / is_sign).
  async function dailyExtra() {
    const net = NetMgr.gInst();
    const ask = async (cmd, data = {}) => {
      net.sendMsg(cmd, data);
      return waitRecv(cmd);
    };
    const res = r => (r && r.res == 1 ? 'OK' : `lỗi ${errText(r)}`);

    // Mô bái (nút onmoBaiBtn ở bảng xếp hạng): type 2, 1, 3 như thứ tự game gửi.
    for (const type of [2, 1, 3]) {
      log(`Mô bái BXH loại ${type}: ${res(await ask(15006, { type, rank: 1 }))}`);
      await sleep(500);
    }

    const gift = await ask(30108);
    if (!gift) log('Quà miễn phí: không lấy được thông tin');
    else if (gift.is_reward) log('Quà miễn phí: hôm nay đã nhận');
    else log(`Quà miễn phí: ${res(await ask(30115))}`);
    await sleep(500);

    const vip = await ask(12407);
    if (!vip) log('Điểm danh VIP: không lấy được thông tin');
    else if (vip.is_sign) log('Điểm danh VIP: hôm nay đã điểm danh');
    else log(`Điểm danh VIP: ${res(await ask(12408))}`);
    await sleep(500);

    // Thẻ tháng (30105 danh sách, 30107 {card_id} nhận): nhận thẻ còn hạn (expire > giờ server) chưa nhận hôm nay.
    const cards = await ask(30105);
    const now = net.getTime();
    const activeCards = ((cards && cards.card_list) || []).filter(c => c.expire > now);
    if (!cards) log('Thẻ tháng: không lấy được thông tin');
    else if (!activeCards.length) log('Thẻ tháng: không có thẻ còn hạn');
    for (const c of activeCards) {
      if (c.is_award) log(`Thẻ tháng ${c.card_id}: hôm nay đã nhận`);
      else log(`Thẻ tháng ${c.card_id}: ${res(await ask(30107, { card_id: c.card_id }))}`);
      await sleep(300);
    }
    await sleep(500);

    // Thư (16000 danh sách, 16007 {type:1} nhận hết đính kèm -> {error_code 1}, 16001 {ids:[{id}]} xóa): nhận hết
    // rồi xóa các thư đã đọc (status 1) như nút "Xóa hết" của game.
    const mails = await ask(16000);
    if (!mails) log('Thư: không lấy được danh sách');
    else if (!(mails.mails || []).length) log('Thư: hộp thư trống');
    else {
      const c = await ask(16007, { type: 1 });
      log(`Thư: nhận hết đính kèm: ${c && c.error_code == 1 ? 'OK' : `lỗi ${errText(c)}`}`);
      await sleep(500);
      const read = ((await ask(16000)) || {}).mails?.filter(m => m.status == 1) || [];
      if (read.length) {
        const d = await ask(16001, { ids: read.map(m => ({ id: m.id })) });
        log(`Thư: xóa ${read.length} thư đã đọc: ${d && d.code == 1 ? 'OK' : `lỗi ${errText(d)}`}`);
      }
    }
    await sleep(500);

    await acceptFriends();
    await sleep(500);

    // Hợp thành tự động (nút cliAuBtnHdr, tốn xu): 17052 {group 1, type 1..4} xem trước -> {coin, list kết quả},
    // list rỗng = không có gì để hợp; 17053 {group, type} hợp.
    for (const type of [1, 2, 3, 4]) {
      const p = await ask(17052, { group: 1, type });
      if (!p || !(p.list || []).length) {
        log(`Hợp thành loại ${type}: không có gì để hợp`);
        continue;
      }
      log(`Hợp thành loại ${type} (${p.list.length} món): ${res(await ask(17053, { group: 1, type }))}`);
      await sleep(300);
    }
    await sleep(500);

    // Tông môn - mặc cả (18070 xem, 18071 chém giá 1 lần/ngày; đã chém thì server từ chối).
    log(`Tông môn mặc cả: ${res(await ask(18071))}`);
    await sleep(500);

    // Tông môn - nhận thưởng mốc cống hiến (18035 -> {fate_num, raward_list [{num}] đã nhận}, 18037 {num}). Chưa biết
    // danh sách mốc nên thử các mốc FATE_STEPS ≤ fate_num chưa nhận; mốc không tồn tại server từ chối.
    const fate = await ask(18035);
    if (!fate) log('Tông môn cống hiến: không lấy được thông tin');
    else {
      const done = new Set((fate.raward_list || []).map(r => r.num));
      let got = 0;
      for (const num of FATE_STEPS.filter(n => n <= fate.fate_num && !done.has(n))) {
        if ((await ask(18037, { num }) || {}).res == 1) got++;
        await sleep(300);
      }
      log(`Tông môn cống hiến (${fate.fate_num}): nhận ${got} mốc`);
    }
    await sleep(500);

    // Tông môn - nhờ giúp (18040 -> my_list [{pos, be_count, max_count, reward_count}], 18043 {pos} nhận ô đã được
    // giúp đủ, 18044 nhận thưởng cuối khi is_final_reward = 0; chưa đủ server từ chối).
    const help = await ask(18040);
    if (!help) log('Tông môn nhờ giúp: không lấy được thông tin');
    else {
      for (const m of (help.my_list || []).filter(m => m.be_count > 0 && !m.reward_count)) {
        log(`Tông môn nhờ giúp ô ${m.pos} (${m.be_count}/${m.max_count}): ${res(await ask(18043, { pos: m.pos }))}`);
        await sleep(300);
      }
      if (!help.is_final_reward) log(`Tông môn nhờ giúp - thưởng cuối: ${res(await ask(18044))}`);
    }
    await sleep(500);

    // Tỉ thí tông môn - rương (18134 -> {has_box}, 18131 -> {all_num, award_list đã mở}, 18132 {pos} mở 1 ô):
    // mở ô đầu tiên chưa ai mở (award_list chưa rõ cấu trúc, lấy theo trường pos).
    const gwBox = await ask(18134);
    if (!gwBox || !gwBox.has_box) log('Rương Tỉ thí tông môn: không có rương');
    else {
      const aw = await ask(18131);
      const taken = new Set(((aw && aw.award_list) || []).map(a => a.pos));
      const all = (aw && aw.all_num) || 12;
      const pos = Array.from({ length: all }, (_, i) => i + 1).find(p => !taken.has(p));
      if (!pos) log('Rương Tỉ thí tông môn: hết ô');
      else {
        const r = await ask(18132, { pos });
        log(`Rương Tỉ thí tông môn ô ${pos}: ${r && r.code == 1 ? 'OK' : `lỗi ${errText(r)}`}`);
      }
    }
    await sleep(500);

    const sign = await ask(30101);
    if (!sign) log('Điểm danh: không lấy được thông tin');
    else if (sign.is_sign) log('Điểm danh: hôm nay đã điểm danh');
    else log(`Điểm danh: ${res(await ask(30102))}`);
    await sleep(500);

    // Thưởng mốc bảng xếp hạng (cùng 3 loại với mô bái): 15009 {type} danh sách mốc {id,...} (mới nhất trước),
    // 15011 {type, ids:[{id}]} nhận. Chưa rõ cờ đã nhận trong danh sách nên thử từ mốc mới nhất, gặp
    // RANK_MISS_STOP lần bị từ chối liên tiếp thì coi như các mốc cũ hơn đã nhận rồi.
    const RANK_MISS_STOP = 3;
    for (const type of [2, 1, 3]) {
      const list = await ask(15009, { type });
      let got = 0, miss = 0;
      for (const p of (list && list.progress_list) || []) {
        if (miss >= RANK_MISS_STOP) break;
        const r = await ask(15011, { type, ids: [{ id: p.id }] });
        if (r && r.res == 1) {
          got++;
          miss = 0;
        } else miss++;
        await sleep(200);
      }
      log(`Thưởng mốc BXH loại ${type}: nhận ${got} mốc`);
    }
    await sleep(500);

    // Thu thuế (30701 xem, 30702 {type} thu): chỉ thu loại 1 (miễn phí, ra xu); các loại khác chưa rõ có tốn
    // Tiên Ngọc không nên bỏ qua.
    const tax = await ask(30701);
    const tax1 = ((tax && tax.tax_list) || []).find(t => t.type == 1);
    if (!tax) log('Thu thuế: không lấy được thông tin');
    else if (!tax1 || !(tax1.left_times > 0)) log('Thu thuế: hết lượt');
    else log(`Thu thuế: ${res(await ask(30702, { type: 1 }))}`);
    await sleep(500);

    // Quà giới hạn ngày (30120 {type} xem, 30121 {gift_id} mua; mỗi gói 1 lần/ngày): mỗi loại 1 gói miễn phí
    // + 1 gói 300 Tiên Ngọc. Gói đã mua hôm nay server từ chối.
    for (const [type, gifts] of LIMIT_GIFTS) {
      await ask(30120, { type });
      for (const [i, gift_id] of gifts.entries()) {
        log(`Quà giới hạn loại ${type}, gói ${gift_id}${i == 0 ? ' (miễn phí)' : ' (Tiên Ngọc)'}: ${res(await ask(30121, { gift_id }))}`);
        await sleep(300);
      }
    }

    // Quà theo ngày (31501 xem, 31502 {id} nhận): gift_list mỗi ngày một gói, status 1 = nhận được, 2 = đã nhận.
    const dayGift = await ask(31501);
    if (!dayGift || dayGift.status != 1) log('Quà theo ngày: sự kiện chưa mở');
    else {
      const ready = (dayGift.gift_list || []).filter(g => g.status == 1);
      if (!ready.length) log('Quà theo ngày: không có gói nhận được');
      for (const g of ready) {
        log(`Quà theo ngày ${g.day}: ${res(await ask(31502, { id: g.id }))}`);
        await sleep(300);
      }
    }

    // Quay 1 lần/ngày rồi nhận mốc tích lũy (stage_list status 1 = nhận được, 2 = đã nhận): 30611 xem / 30612 quay /
    // 30613 {stage} nhận mốc, 19305 xem / 19308 quay / 19309 {stage} nhận mốc. Server không cho biết đã quay hôm nay
    // chưa (left_free_times = 0 vẫn quay được) nên tool tự đánh dấu trong localStorage của game.
    for (const [infoCmd, drawCmd, stageCmd, name] of DAILY_DRAWS) {
      let info = await ask(infoCmd);
      if (!info || info.status != 1) {
        log(`${name}: sự kiện chưa mở`);
        continue;
      }
      if (dailyDrawDone(drawCmd)) log(`${name}: hôm nay đã quay`);
      else {
        const r = await ask(drawCmd, { times: 1 });
        log(`${name}: quay 1 lần: ${res(r)}`);
        if (r && r.res == 1) {
          dailyDrawMark(drawCmd);
          info = r;
        }
        await sleep(300);
      }
      let got = 0;
      for (const s of info.stage_list || []) {
        if (s.status != 1) continue;
        if ((await ask(stageCmd, { stage: s.stage }) || {}).res == 1) got++;
        await sleep(300);
      }
      log(`${name}: nhận ${got} mốc tích lũy (đang ở mốc ${info.cur_stage})`);
    }
  }
  const FATE_STEPS = [100, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 5000];
  const LIMIT_GIFTS = [[1, [3799, 3798]], [2, [3899, 3898]], [3, [30001, 30002]]];
  const DAILY_DRAWS = [[30611, 30612, 30613, 'Quay 30612'], [19305, 19308, 19309, 'Quay 19308']];
  const dailyDrawKey = 'tnDailyDraw';
  const dailyDrawList = () => {
    try {
      const s = JSON.parse(localStorage.getItem(dailyDrawKey) || '{}');
      return s.day === today() ? s.done || [] : [];
    } catch { return []; }
  };
  const dailyDrawDone = cmd => dailyDrawList().includes(cmd);
  const dailyDrawMark = cmd => {
    try { localStorage.setItem(dailyDrawKey, JSON.stringify({ day: today(), done: [...dailyDrawList(), cmd] })); } catch {}
  };

  // Cổ Thần Địa (AdvCtrl): đánh liên tục từng tầng tới khi kẹt (hết tướng, hết việc làm được) hoặc TN.stop().
  // Mỗi tầng 25 ô: 4 tướng thường mở ra boss (ô 13); thắng boss thì 11063 ô boss để sang tầng. Ô đã mở thì
  // tương tác hết như AdvCtrl.eventHandler của game, trừ Tiệm Cổ Thần (EVT24, 11067 mở / 11068 mua) không mua gì.
  // Lệnh: 11060 {sign} thông tin, 11065 {list:[{id}]} chọn tướng vào, 11075 {hero_id} đổi tướng ra trận,
  // 11077 {grid_id} xem địch, 11066 {hero_id, grid_id, is_skip} đánh, 11079 {grid_id} Cấm Tuyệt Mệnh,
  // 11063 {grid_id} nhận/mở ô, 11072/11073 hội thoại, 11074 oẳn tù tì, 11091 {grid_id} sự kiện EVT25.
  // floors: số tầng vượt qua trong lần chạy này, đủ thì dừng dù tướng còn sống.
  async function ancientLand(floors = 6) {
    const MAX_FLOORS = Math.max(1, Number(floors) || 6);
    let cleared = 0;
    const net = NetMgr.gInst();
    const C = AdvConst;
    const model = AdvCtrl.gInst().getCurlModel();
    const ask = async (cmd, data = {}, recv = cmd) => {
      net.sendMsg(cmd, data);
      return waitRecv(recv, 10000);
    };
    const ok = r => r && r.res != 0;
    const MAX_LOSS = 5; // thua cùng 1 tướng địch 5 lần thì dùng Cấm Tuyệt Mệnh
    const MORRA = { bet: 2, guess: 2 };
    const BOSS_GRID = 13; // game đánh dấu ô 13 là ô boss (isBsGrid)
    const BOX_KEY = 1001080; // chìa mở rương (boxOpen của game kiểm tra vật phẩm này)
    const FIGHT = new Set([C.EVT1_SGC, C.EVT2_SGC, C.EVT3_SGC, C.EVT4_SGC, C.EVT100_SGC]);
    const evtName = eid => {
      try {
        const c = model.getEvtCfg(eid) || model.getEvtCfgVo(eid) || {};
        return String(c.name || c.desc || c.title || '').replace(/<[^>]+>/g, '');
      } catch { return ''; }
    };
    const label = g => `ô ${g.id} ${evtName(g.eid) || ''} (etype ${g.etype})`.replace(/\s+/g, ' ');
    const losses = {};
    const skipped = new Set();
    let bossWon = null; // thắng boss xong game chờ bấm OK (11063 ô boss), ô có thể chưa is_fin
    stopFlag = false;

    // sign 1 làm game mở giao diện chính, các lần sau dùng 2 (chỉ cập nhật).
    const refresh = () => ask(11060, { sign: 2 });
    let info = await ask(11060, { sign: 1 });
    if (!info) return log('Cổ Thần Địa: không lấy được thông tin');
    if (!(info.hero_list || []).length) {
      // Như nút tự động chọn: 6 tướng lực chiến cao nhất.
      const heroes = [...(HeroCtrl.gInst().getHeroDataByRealm(0) || [])].sort((a, b) => longVal(b.fc) - longVal(a.fc)).slice(0, 6);
      const r = await ask(11065, { list: heroes.map(h => ({ id: h.id })) });
      if (!ok(r)) return log(`Cổ Thần Địa: chọn tướng lỗi ${errText(r)} - hãy chọn tướng tay trong game rồi chạy lại`);
      log(`Cổ Thần Địa: chọn tướng ${heroes.map(h => h.name).join(', ')}`);
      info = await refresh();
      if (!info) return log('Cổ Thần Địa: không lấy được thông tin');
    }
    log(`Cổ Thần Địa: tầng ${info.cur_layer}, đã giết ${info.kill_num}`);

    // Tương tác 1 ô không phải tướng địch. Trả về true nếu đã gửi lệnh.
    async function interact(g) {
      let r;
      if (g.auto_open) {
        r = await ask(11063, { grid_id: g.id });
      } else if (g.etype == C.EVT14_SGC || g.etype == C.EVT15_SGC) {
        const t = await ask(11072, { grid_id: g.id });
        const opt = ((t && t.list) || [])[0];
        if (!opt) { skipped.add(g.id); log(`Cổ Thần Địa: ${label(g)}: không đọc được hội thoại ${JSON.stringify(t)}`); return true; }
        r = await ask(11073, { grid_id: g.id, index: opt.index });
      } else if (g.etype == C.EVT17_SGC) {
        if (!(PropsCtrl.gInst().findGoodsNum(BOX_KEY) > 0)) { skipped.add(g.id); log(`Cổ Thần Địa: ${label(g)}: hết chìa mở rương`); return false; }
        r = await ask(11063, { grid_id: g.id });
      } else if (g.etype == C.EVT22_SGC) {
        r = await ask(11074, { grid_id: g.id, ...MORRA });
      } else if (g.etype == C.EVT23_SGC) {
        r = await ask(11063, { grid_id: g.id });
      } else if (g.etype == C.EVT25_SGC) {
        // Cổ Thần Ban Phước: 11091 mở bảng quay (lottery_list), 11092 = nút "Bắt đầu" (trả gain_pos).
        const open = await ask(11091, { grid_id: g.id });
        if (!ok(open)) { skipped.add(g.id); log(`Cổ Thần Địa: ${label(g)} mở Ban Phước lỗi ${errText(open)}`); return true; }
        r = await ask(11092, { grid_id: g.id });
        const won = ok(r) && (open.lottery_list || []).find(x => x.pos == r.gain_pos);
        if (won) log(`Cổ Thần Địa: Ban Phước quay trúng vật phẩm ${won.item_bid} x${won.num}`);
        try { AdvCtrl.gInst().closeLtryUi(); } catch {}
      } else if (g.etype == C.EVT24_SGC) {
        skipped.add(g.id);
        log(`Cổ Thần Địa: bỏ qua ${label(g)} (Tiệm Cổ Thần, không mua)`);
        return false;
      } else {
        // EVT9/EVT10 (openEnterUi) và loại lạ: chưa biết lệnh, để lại.
        skipped.add(g.id);
        log(`Cổ Thần Địa: chưa biết cách tương tác ${label(g)}, bỏ qua`);
        return false;
      }
      skipped.add(g.id); // dù lỗi cũng không thử lại trong tầng này
      log(`Cổ Thần Địa: ${label(g)} - ${ok(r) ? 'OK' : 'lỗi ' + errText(r)}`);
      await sleep(300);
      return true;
    }

    for (let step = 0; step < 500; step++) {
      if (stopFlag) return log('Cổ Thần Địa: đã dừng');
      await jobGate();
      const grids = (info.grid_list || []).filter(g => g.is_open && !g.is_fin && !skipped.has(g.id) && g.etype != C.NULL_SGC);
      const enemies = grids.filter(g => FIGHT.has(g.etype) && g.id != bossWon);
      const items = grids.filter(g => !FIGHT.has(g.etype) && g.etype != C.NEXT_SGC);

      // 1. Tương tác ô vật phẩm/sự kiện.
      let acted = false;
      for (const g of items) if (await interact(g)) acted = true;
      if (acted) { info = await refresh(); if (!info) return log('Cổ Thần Địa: mất thông tin'); continue; }

      // 2. Đánh tướng địch (4 tướng thường trước, boss ô 13 sau cùng).
      const g = enemies.sort((a, b) => (a.id == BOSS_GRID) - (b.id == BOSS_GRID))[0];
      if (g) {
        const isBoss = g.id == BOSS_GRID || g.etype == C.EVT100_SGC;
        if ((losses[g.id] || 0) >= MAX_LOSS) {
          if (!(info.left_soul_potion > 0 && info.soul_potion > 0)) { skipped.add(g.id); log(`Cổ Thần Địa: ô ${g.id} thua ${MAX_LOSS} lần, hết Cấm Tuyệt Mệnh`); continue; }
          const r = await ask(11079, { grid_id: g.id });
          if (!ok(r)) { skipped.add(g.id); log(`Cổ Thần Địa: Cấm Tuyệt Mệnh ô ${g.id} lỗi ${errText(r)}`); continue; }
          if (isBoss) bossWon = g.id;
          log(`Cổ Thần Địa: dùng Cấm Tuyệt Mệnh giết ô ${g.id}`);
        } else {
          const alive = (info.hero_list || []).filter(h => h.hp > 0);
          if (!alive.length) return log('Cổ Thần Địa: hết tướng còn sống, dừng');
          let hero = alive.find(h => h.id == info.select_hero_id);
          if (!hero) {
            hero = alive.reduce((a, b) => (longVal(b.fc) > longVal(a.fc) ? b : a));
            const r = await ask(11075, { hero_id: hero.id });
            if (!ok(r)) return log(`Cổ Thần Địa: đổi tướng ${hero.name} lỗi ${errText(r)}`);
          }
          const e = await ask(11077, { grid_id: g.id });
          const foe = ((e && e.hero_list) || [])[0] || {};
          await waitNotFighting();
          const fight = waitRecv(14002, 10000);
          const r = await ask(11066, { hero_id: hero.id, grid_id: g.id, is_skip: info.is_skip || 0 });
          if (!ok(r)) { skipped.add(g.id); log(`Cổ Thần Địa: đánh ô ${g.id} lỗi ${errText(r)}`); continue; }
          const f = await fight;
          const won = f && f.result == 1;
          if (!won) losses[g.id] = (losses[g.id] || 0) + 1;
          else if (isBoss) bossWon = g.id;
          log(`Cổ Thần Địa: ${hero.name} đánh ${foe.name || 'ô ' + g.id}${isBoss ? ' (boss)' : ''} - ${won ? 'thắng' : `thua (${losses[g.id]}/${MAX_LOSS})`}`);
          await sleep(800);
          await waitNotFighting();
        }
        info = await refresh();
        if (!info) return log('Cổ Thần Địa: mất thông tin');
        continue;
      }

      // 3. Hết việc trong tầng: sang tầng qua ô NEXT hoặc ô boss đã hạ.
      const next = (info.grid_list || []).find(x => x.is_open && !x.is_fin && x.etype == C.NEXT_SGC) || (bossWon && { id: bossWon });
      if (!next) {
        const rest = (info.grid_list || []).filter(x => x.is_open && !x.is_fin).map(label);
        return log(`Cổ Thần Địa: không còn việc làm được ở tầng ${info.cur_layer}${rest.length ? ` (còn: ${rest.join(', ')})` : ''}`);
      }
      const layer = info.cur_layer;
      const r = await ask(11063, { grid_id: next.id }, 11060);
      if (!r || r.cur_layer == layer) return log(`Cổ Thần Địa: không sang được tầng mới (ô ${next.id})`);
      info = r;
      skipped.clear();
      bossWon = null;
      for (const k in losses) delete losses[k];
      cleared++;
      log(`Cổ Thần Địa: sang tầng ${info.cur_layer} (đã qua ${cleared}/${MAX_FLOORS} tầng)`);
      if (cleared >= MAX_FLOORS) return log(`Cổ Thần Địa: đã qua đủ ${MAX_FLOORS} tầng, dừng`);
      await sleep(500);
    }
  }

  // Ảo cảnh trận pháp: lật 2 thẻ giống nhau. 32061 {action:0} bắt đầu, server đẩy 32060 có cards_list kèm
  // base_id (2 thẻ cùng base_id là 1 cặp); 32062 {list:[{uid},{uid}]} lật 1 cặp; xong hết server gửi 32063.
  // Lật rải đều để cả ván mất khoảng TOTAL_MS (làm quá nhanh dễ bị nghi).
  async function mirageMatch(seconds = 15) {
    const TOTAL_MS = Math.max(1, Number(seconds) || 15) * 1000;
    const net = NetMgr.gInst();
    stopFlag = false;
    net.sendMsg(32060, {});
    let info = await waitRecv(32060);
    if (!info) return log('Ảo cảnh: không lấy được thông tin');
    if (!longVal(info.begin_ms)) {
      const started = waitRecv(32060);
      net.sendMsg(32061, { action: 0 });
      info = await started;
      if (!info || !longVal(info.begin_ms)) return log(`Ảo cảnh: không bắt đầu được ván ${errText(info)}`);
      log('Ảo cảnh: bắt đầu ván');
    }
    const groups = {};
    for (const c of info.cards_list || []) if (c.status == 0) (groups[c.base_id] = groups[c.base_id] || []).push(c.uid);
    const pairs = [];
    for (const uids of Object.values(groups)) for (let i = 0; i + 1 < uids.length; i += 2) pairs.push([uids[i], uids[i + 1]]);
    if (!pairs.length) return log('Ảo cảnh: không còn cặp nào để lật');
    // Trộn thứ tự cặp cho giống người chơi.
    for (let i = pairs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pairs[i], pairs[j]] = [pairs[j], pairs[i]];
    }
    const gap = TOTAL_MS / pairs.length;
    const done = waitRecv(32063, TOTAL_MS + 15000);
    for (let n = 0; n < pairs.length; n++) {
      if (stopFlag) return log(`Ảo cảnh: đã dừng sau ${n} cặp`);
      await sleep(gap * (0.7 + Math.random() * 0.6));
      const [a, b] = pairs[n];
      net.sendMsg(32062, { list: [{ uid: a }, { uid: b }] });
      const r = await waitRecv(32062);
      if (!r || r.res != 1) return log(`Ảo cảnh: lật cặp ${a}-${b} lỗi ${errText(r)}`);
    }
    const end = await done;
    log(end ? `Ảo cảnh: xong ${pairs.length} cặp trong ${(end.pass_ms / 1000).toFixed(1)}s, điểm ${end.scores}` : `Ảo cảnh: đã lật ${pairs.length} cặp, chưa thấy kết quả`);
  }

  // NV 16: Kiếm Hành (DiceCtrl) — đổ xúc xắc tới khi chặng đạt 100%. Như clickDice của game: dùng lượt
  // miễn phí, hết thì dùng xúc xắc; thiếu xúc xắc thì mua như bảng mua của game (buyDice: ShopCtrl.quickBuy
  // món 1501001, giá mỗi viên = config dice_price Tiên Ngọc), tổng tiền mua mỗi lần chạy <= MAX_BUY_GOLD.
  async function dice() {
    const MAX_BUY_GOLD = 1000;
    const DICE_SHOP_ID = 1501001;
    let spent = 0;
    const ctrl = DiceCtrl.gInst();
    ctrl.sd20501();
    if (!(await waitRecv(20501))) return log('Kiếm Hành: không lấy được thông tin');
    for (let n = 1; n <= 60; n++) {
      await jobGate();
      const dt = ctrl.infoDt;
      if (!dt) return log('Kiếm Hành: không có dữ liệu');
      if (dt.percent >= 100) return log(`Kiếm Hành: chặng đã đạt 100% (đổ ${n - 1} lần)`);
      let how;
      if (dt.freeTimes > 0) {
        how = `miễn phí (còn ${dt.freeTimes - 1})`;
      } else {
        const diceId = ctrl.getInfoByKey('dice_id');
        let have = PropsCtrl.gInst().findGoodsNum(diceId);
        const cost = ctrl.getCostCfg(dt.buyTimes + 1);
        const needNum = cost ? cost.quantity : 0;
        if (!cost) return log(`Kiếm Hành: không đọc được giá đổ, dừng ở ${dt.percent}%`);
        if (have < needNum) {
          const buyNum = needNum - have;
          const price = Number(ctrl.getInfoByKey('dice_price')) || 0;
          const gold = buyNum * price;
          if (!price) return log(`Kiếm Hành: hết xúc xắc, không đọc được giá mua, dừng ở ${dt.percent}%`);
          if (spent + gold > MAX_BUY_GOLD) return log(`Kiếm Hành: đã mua ${spent} Tiên Ngọc, mua thêm ${gold} sẽ vượt giới hạn ${MAX_BUY_GOLD}, dừng ở ${dt.percent}%`);
          ShopCtrl.gInst().quickBuy(DICE_SHOP_ID, buyNum);
          // Không biết lệnh trả về của cửa hàng: chờ số xúc xắc trong túi tăng.
          for (let w = 0; w < 25 && have < needNum; w++) {
            await sleep(200);
            have = PropsCtrl.gInst().findGoodsNum(diceId);
          }
          if (have < needNum) return log(`Kiếm Hành: mua ${buyNum} xúc xắc (${gold} Tiên Ngọc) không thành công (thiếu Tiên Ngọc?), dừng ở ${dt.percent}%`);
          spent += gold;
          log(`Kiếm Hành: mua ${buyNum} xúc xắc (${gold} Tiên Ngọc, tổng ${spent})`);
        }
        how = `dùng ${needNum} xúc xắc (còn ${have - needNum})`;
      }
      ctrl.sd20502();
      const r = await waitRecv(20502);
      if (!r || r.res != 1) return log(`Kiếm Hành lần ${n}: lỗi ${errText(r)}`);
      log(`Kiếm Hành lần ${n}: ${how}, được ${r.point} điểm, tiến độ ${r.percent}%`);
      await sleep(3000); // clickDice của game chặn bấm dưới 3 giây
    }
  }

  // NV 13: Bách Tông Phạt Nghịch - khiêu chiến boss (GldBsCtrl) trong khung giờ khiêu chiến, chờ hết hồi chiêu
  // (~2 phút/lần) giữa các lần, tới khi đủ nhiệm vụ. Thắng/thua đều tính lượt (boss chỉ để gây sát thương).
  async function gldBoss() {
    const need = taskRemain(13);
    if (!need) return log('Bách Phạt Tông: nhiệm vụ đã đủ');
    const ctrl = GldBsCtrl.gInst();
    const hhmm = sec => new Date(sec * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    for (let n = 1; n <= need; n++) {
      ctrl.send31201();
      const info = await waitRecv(31201);
      if (!info) return log('Bách Phạt Tông: không lấy được thông tin');
      const now = NetMgr.gInst().getTime();
      if (now < info.challenge_stime || now > info.challenge_etime) {
        return log(`Bách Phạt Tông: ngoài giờ khiêu chiến (${hhmm(info.challenge_stime)} - ${hhmm(info.challenge_etime)}), còn thiếu ${need - n + 1} lần`);
      }
      // next_boss_time là mốc thời gian khi đang hồi chiêu (giá trị nhỏ như 120 nghĩa là chưa đánh lần nào).
      const wait = info.next_boss_time > 1e9 ? info.next_boss_time - now : 0;
      if (wait > 0) {
        log(`Bách Phạt Tông: chờ hồi chiêu ${wait} giây...`);
        await sleep((wait + 2) * 1000);
      }
      await waitNotFighting();
      ctrl.send31204();
      const r = await waitRecv(31204, 10000);
      if (!r || r.res != 1) return log(`Bách Phạt Tông lần ${n}: lỗi ${errText(r)}`);
      log(`Bách Phạt Tông lần ${n}/${need}: sát thương ${longVal(r.damage)}, được ${longVal(r.get_boss_score)} điểm`);
      await sleep(1500);
      await waitNotFighting();
    }
  }

  // NV 14: Đoạt Bách Tông Phạt Nghịch (GldBsCtrl) — trong khung giờ đoạt, chờ hết hồi chiêu (~2 phút/lần),
  // đoạt người có lực chiến thấp nhất tới khi đủ nhiệm vụ.
  async function gldSnatch() {
    const need = taskRemain(14);
    if (!need) return log('Đoạt Bách Tông: nhiệm vụ đã đủ');
    const ctrl = GldBsCtrl.gInst();
    const hhmm = sec => new Date(sec * 1000).toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' });
    const me = RoleCtrl.gInst().getRoleInfo();
    for (let n = 1; n <= need; n++) {
      ctrl.send31201();
      const info = await waitRecv(31201);
      if (!info) return log('Đoạt Bách Tông: không lấy được thông tin');
      let now = NetMgr.gInst().getTime();
      if (now < info.snatch_stime || now > info.snatch_etime) {
        return log(`Đoạt Bách Tông: ngoài giờ đoạt (${hhmm(info.snatch_stime)} - ${hhmm(info.snatch_etime)}), còn thiếu ${need - n + 1} lần`);
      }
      // next_snatch_time là mốc thời gian khi đang hồi chiêu (giá trị nhỏ như 120 nghĩa là chưa đoạt lần nào).
      const wait = info.next_snatch_time > 1e9 ? info.next_snatch_time - now : 0;
      if (wait > 0) {
        log(`Đoạt Bách Tông: chờ hồi chiêu ${wait} giây...`);
        await sleep((wait + 2) * 1000);
      }
      ctrl.send31205();
      const list = await waitRecv(31205);
      const enemies = ((list && list.snatch_list) || []).filter(x => longVal(x.id) != longVal(me.id));
      if (!enemies.length) return log('Đoạt Bách Tông: không có ai để đoạt');
      const target = enemies.reduce((a, b) => (longVal(b.fc) < longVal(a.fc) ? b : a));
      await waitNotFighting();
      ctrl.send31206(target.id);
      const r = await waitRecv(31206, 10000);
      if (!r || r.res != 1) return log(`Đoạt Bách Tông lần ${n}: đoạt ${target.name} lỗi ${errText(r)}`);
      log(`Đoạt Bách Tông lần ${n}/${need}: đoạt ${target.name} (LC ${longVal(target.fc)}), được ${longVal(r.get_snatch_score)} điểm`);
      await sleep(1500);
      await waitNotFighting();
    }
  }

  // Phó bản ngày (DailyDungeonCtrl): đánh ải kế tiếp (max_pass + 1) của loại `type` `times` lần, thua thì đánh
  // lại, thắng thì lên ải. Đánh không tốn lượt/tài nguyên (log: thua xong enter_count không đổi).
  // dungeon_id = 1000000 + type*10000 + số ải (vd tháp type 1: 1011692 = tầng 1692; PB Linh Thạch type 2:
  // 1020103 = ải 103). Dừng giữa chừng bằng TN.stop().
  async function dungeonClimb(type, times, label, unit = 'ải') {
    const ctrl = DailyDungeonCtrl.gInst();
    const base = 1000000 + type * 10000;
    stopFlag = false;
    let win = 0;
    let fails = 0;
    // Lỗi tạm (vd vừa chạy job xong, game còn ở màn hình hoạt động khác): về Đạo Thành, chờ rồi thử lại
    // đúng lần đó; lỗi liên tiếp quá MAX_FAILS lần mới dừng hẳn.
    const MAX_FAILS = 3;
    const retry = async (n, why) => {
      fails++;
      if (fails > MAX_FAILS) return false;
      log(`${label} lần ${n}: ${why}, thử lại (${fails}/${MAX_FAILS})`);
      await goCity();
      await sleep(3000);
      return true;
    };
    for (let n = 1; n <= times; n++) {
      if (stopFlag) return log(`${label}: đã dừng sau ${n - 1} lần (thắng ${win})`);
      await jobGate();
      ctrl.send11004(type);
      const info = await waitRecv(11004);
      if (!info) {
        if (await retry(n, 'không lấy được thông tin')) { n--; continue; }
        return log(`${label}: không lấy được thông tin, dừng sau ${n - 1} lần (thắng ${win})`);
      }
      const id = (info.max_pass_dungoen_id || base) + 1;
      const stage = id - base;
      await waitNotFighting();
      const fight = waitRecv(14002, 10000); // kết quả trận: result 1 = thắng, 2 = thua
      ctrl.send11001(id, 0);
      const r = await waitRecv(11001, 10000);
      if (!r || r.res != 1) {
        if (await retry(n, `${unit} ${stage} lỗi ${errText(r)}`)) { n--; continue; }
        return log(`${label} lần ${n}: ${unit} ${stage} lỗi ${errText(r)}, dừng (thắng ${win})`);
      }
      fails = 0;
      const f = await fight;
      const won = f && f.result == 1;
      if (won) win++;
      log(`${label} lần ${n}: ${unit} ${stage} - ${won ? 'thắng' : 'thua'}`);
      await sleep(800);
      await waitNotFighting();
    }
    log(`${label}: xong ${times} lần, thắng ${win}`);
  }

  const towerClimb = (times = 20) => dungeonClimb(1, times, 'Leo tháp', 'tầng');

  // Tháp phái (vd Ma Linh Tháp type 8): mỗi ngày mở loại khác nhau, 11021 dungeon_list cho biết loại nào
  // is_open (type 1 là Thông Thiên Tháp, làm riêng). Mỗi loại leo tối đa CAMP_DAILY tầng/ngày (today_pass) bằng
  // 11001 tầng kế tiếp, thua thì dừng loại đó; xong thì quét (11005 tầng cao nhất) hết lượt miễn phí.
  const CAMP_DAILY = 10;
  const CAMP_FREE_SWEEP = 2;
  async function campTowers() {
    const ctrl = DailyDungeonCtrl.gInst();
    const list = ((await evReq(11021)) || {}).dungeon_list || [];
    const open = list.filter(d => d.is_open == 1 && d.type != 1);
    if (!open.length) return log('Tháp phái: hôm nay không có tháp nào mở');
    for (const d of open) {
      const type = d.type;
      const base = 1000000 + type * 10000;
      const name = (ctrl.gDgnTypeCfg(type) || {}).name || `Tháp loại ${type}`;
      let info;
      let climbed = 0;
      let stopWhy = '';
      while (!stopFlag) {
        await jobGate();
        ctrl.send11004(type);
        info = await waitRecv(11004);
        if (!info) return log(`${name}: không lấy được thông tin`);
        if ((info.today_pass || 0) >= CAMP_DAILY) break;
        const id = (info.max_pass_dungoen_id || base) + 1;
        await waitNotFighting();
        const fight = waitRecv(14002, 10000);
        ctrl.send11001(id, 0);
        const r = await waitRecv(11001, 10000);
        if (!r || r.res != 1) {
          stopWhy = `lỗi ở tầng ${id - base}: ${errText(r)}`;
          log(`${name} tầng ${id - base}: lỗi ${errText(r)}`);
          break;
        }
        const f = await fight;
        const won = f && f.result == 1;
        log(`${name} tầng ${id - base}: ${won ? 'thắng' : 'thua'}`);
        await sleep(800);
        await waitNotFighting();
        if (!won) {
          stopWhy = `THUA tầng ${id - base}, không leo tiếp (cần mạnh hơn rồi leo tay)`;
          break;
        }
        climbed++;
      }
      if (stopFlag) return log(`${name}: đã dừng`);
      ctrl.send11004(type);
      info = await waitRecv(11004);
      if (!info) return log(`${name}: không lấy được thông tin`);
      log(`${name}: leo thêm ${climbed} tầng, hôm nay qua ${info.today_pass}/${CAMP_DAILY}${stopWhy ? ` - ${stopWhy}` : ''}`);
      if (!info.max_pass_dungoen_id) {
        log(`${name}: chưa qua tầng nào, không quét được`);
        continue;
      }
      const free = ((ctrl.gDgnTypeCfg(type) || {}).count || CAMP_FREE_SWEEP) - (info.enter_count || 0);
      for (let i = 0; i < free && !stopFlag; i++) {
        ctrl.send11005(info.max_pass_dungoen_id);
        const r = await waitRecv(11005);
        log(`${name}: quét tầng ${info.max_pass_dungoen_id - base} lần ${i + 1}/${free}: ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
        if (!r || r.res != 1) break;
        await sleep(500);
      }
      if (free <= 0) log(`${name}: hết lượt quét miễn phí`);
      await goCity();
      await sleep(500);
    }
  }

  // Khiêu chiến phó bản ngày theo type: 2 Linh Thạch, 3 EXP, 4 Tu Sĩ, 5 Pháp Bảo (tên lấy từ config).
  // type 0 = tất cả: lần lượt từng loại theo thứ tự trong popup, mỗi loại `times` lần.
  const PB_ALL = [5, 4, 3, 2];
  async function dungeonFight(type, times = 20) {
    const pbName = t => (DailyDungeonCtrl.gInst().gDgnTypeCfg(t) || {}).name || `PB loại ${t}`;
    if (type != 0) return dungeonClimb(type, times, pbName(type));
    for (const t of PB_ALL) {
      log(`== ${pbName(t)} ==`);
      await dungeonClimb(t, times, pbName(t));
      // dungeonClimb tự đặt lại stopFlag khi bắt đầu, nên kiểm tra ngay sau mỗi loại để Dừng dừng cả lượt.
      if (stopFlag) return log('Phó bản ngày (tất cả): đã dừng');
    }
  }

  // Debug: xem ải đã qua của từng loại phó bản để đối chiếu type với tên trong game.
  async function listDungeonTypes() {
    const ctrl = DailyDungeonCtrl.gInst();
    const res = [];
    for (let type = 1; type <= 8; type++) {
      ctrl.send11004(type);
      const info = await waitRecv(11004, 2000);
      res.push(`type ${type}: ${info ? `đã qua ${info.max_pass_dungoen_id}, lượt ${info.enter_count}` : 'không có'}, cfg ${JSON.stringify(ctrl.gDgnTypeCfg(type) || null)}`);
    }
    return res.join('\n');
  }

  // Linh thú (SpiritAnimalCtrl): thu hoạch tất cả chuồng (32022) nếu có sản phẩm đang chờ.
  async function spiritHarvest() {
    const ctrl = SpiritAnimalCtrl.gInst();
    ctrl.send32019();
    const info = await waitRecv(32019);
    if (!info) return log('Linh thú: không lấy được thông tin');
    const ready = (info.enclosure_list || []).reduce((n, e) => n + (e.list || []).length, 0);
    if (!ready) return log('Linh thú: chưa có gì để thu hoạch');
    ctrl.send32022();
    const r = await waitRecv(32022);
    log(`Linh thú: thu hoạch ${ready} loại sản phẩm: ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
  }

  // Núi cấm: 20101 thông tin các ô đào (item_id 0 = ô trống, end_time = giây đào xong), 20106 thu hoạch hết
  // ô đã xong, 20102 {shovel_id, id} đào ô trống. Dùng xẻng tốt (4000002) trước, hết thì dùng xẻng thường.
  const SHOVELS = [4000002, 4000001];
  const MOUNTAIN_FREE_SLOTS = 4;
  async function forbiddenMountain() {
    const net = NetMgr.gInst();
    const props = PropsCtrl.gInst();
    let privilege = false;
    const info = async () => {
      net.sendMsg(20101, {});
      const r = await waitRecv(20101);
      if (r) privilege = r.is_active_privilege == 1;
      return r && r.list;
    };
    let slots = await info();
    if (!slots) return log('Núi cấm: không lấy được thông tin');
    const now = Date.now() / 1000;
    const ready = slots.filter(s => s.item_id > 0 && s.end_time <= now).length;
    if (ready) {
      net.sendMsg(20106, {});
      const r = await waitRecv(20106);
      log(`Núi cấm: thu hoạch ${ready} ô: ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
      await sleep(500);
      slots = (await info()) || slots;
    } else {
      log('Núi cấm: chưa có ô nào đào xong');
    }
    // Ô đặc quyền (id > MOUNTAIN_FREE_SLOTS) chỉ đào được khi đang có đặc quyền, nếu không server báo lỗi 210010.
    const empty = slots.filter(s => !(s.item_id > 0) && (privilege || s.id <= MOUNTAIN_FREE_SLOTS));
    if (!empty.length) return log('Núi cấm: không còn ô trống');
    let dug = 0;
    for (const s of empty) {
      const shovel = SHOVELS.find(id => props.findGoodsNum(id) > 0);
      if (!shovel) {
        log('Núi cấm: hết xẻng');
        break;
      }
      net.sendMsg(20102, { shovel_id: shovel, id: s.id });
      const r = await waitRecv(20102);
      if (r && r.res == 1) dug++;
      log(`Núi cấm: đào ô ${s.id} bằng xẻng ${shovel} (còn ${props.findGoodsNum(shovel)}): ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
      await sleep(500);
    }
    log(`Núi cấm: đào ${dug}/${empty.length} ô trống`);
  }

  // ---- Sự kiện (chỉ chạy khi đang mở) ----
  const evOk = r => r && r.res == 1;
  // Sự kiện chưa mở: không phản hồi, hoặc server trả lỗi 100032 "Sự kiện chưa mở".
  const evClosed = r => !r || r.msg == 100032 || r.code == 100032;
  const evReq = async (cmd, data, timeout) => {
    NetMgr.gInst().sendMsg(cmd, data);
    return waitRecv(cmd, timeout);
  };
  // Nhiệm vụ sự kiện (30040/30041 theo type): nhận mọi nhiệm vụ đã xong (status 1), trả số nhiệm vụ đã nhận.
  async function evTasks(type, label) {
    const tasks = await evReq(30040, { type });
    let got = 0;
    for (const t of (tasks && tasks.task_list) || []) {
      if (t.status != 1) continue;
      if (evOk(await evReq(30041, { type, id: t.id }))) got++;
      await sleep(300);
    }
    if (got) log(`${label}: nhận ${got} nhiệm vụ`);
    return got;
  }
  // Chiến lệnh sự kiện (12321/12322 theo type): nhận thưởng thường của mọi kỳ, trả true nếu nhận được gì.
  // Có sự kiện đọc chiến lệnh bằng lệnh khác (12328 theo kỳ): truyền sẵn terms thì bỏ qua 12321.
  async function evPass(type, label, terms) {
    if (!terms) {
      const zl = await evReq(12321, { type });
      terms = ((zl && zl.list) || []).map(t => t.term_id);
    }
    let got = false;
    for (const term_id of terms) {
      if (!evOk(await evReq(12322, { type, term_id }))) continue;
      got = true;
      log(`${label}: chiến lệnh kỳ ${term_id}: nhận OK`);
    }
    return got;
  }
  // Lưu đội hình đánh boss sự kiện (14012 đọc, 14010 lưu). Chưa từng xếp (rỗng) thì chép đội hình chính (type 1).
  async function evTeam(type) {
    let team = await evReq(14012, { type, sign: 0 });
    let list = (team && team.pos_list) || [];
    if (!list.length) {
      team = await evReq(14012, { type: 1, sign: 21 });
      list = (team && team.pos_list) || [];
    }
    if (list.length) await evReq(14010, { type, list, sign: 0 });
  }

  // Quà sự kiện (12323): gifts = [gói miễn phí, gói Tiên Ngọc], mua mỗi gói tới khi hết lượt trong ngày.
  async function evGifts(gifts, label) {
    for (const [i, gift] of gifts.entries()) {
      let bought = 0;
      for (let n = 0; n < 10; n++) {
        if (!evOk(await evReq(12323, { gift_id: gift }))) break;
        bought++;
        await sleep(300);
      }
      log(`${label}: quà ${gift}${i == 0 ? ' (miễn phí)' : ' (Tiên Ngọc)'}: mua ${bought} lần`);
    }
  }

  // Kim Thu Thập Quang (activity_type 86): 19480 thông tin boss (không phản hồi = sự kiện chưa mở),
  // 19481 đánh boss (đội hình type 38: 14012 đọc, 14010 lưu), 19482 nhận thưởng sát thương,
  // 12323 quà: 34302 miễn phí, 34303 mua bằng Tiên Ngọc — mua tới khi hết lượt trong ngày,
  // 19487 {type:1} rút thưởng bằng vé 1000031, nhiệm vụ type 15, chiến lệnh type 17.
  const KT_ACT = 86;
  const KT_GIFTS = [34302, 34303];
  const KT_TICKET = 1000031;
  async function kimThu() {
    const boss = await evReq(19480, { activity_type: KT_ACT }, 3000);
    if (evClosed(boss)) return log('Kim Thu: sự kiện chưa mở');
    log(`Kim Thu: sát thương cao nhất ${longVal(boss.his_hurt)}`);

    // Boss đánh không giới hạn lượt và 1 trận đã vượt mốc thưởng sát thương cao nhất (20 triệu): đánh 1 lần.
    await evTeam(38);
    await waitNotFighting();
    const fight = await evReq(19481, { activity_type: KT_ACT }, 10000);
    log(`Kim Thu: đánh boss ${evOk(fight) ? `- sát thương ${longVal(fight.hurt)}` : 'lỗi ' + errText(fight)}`);
    await sleep(800);
    await waitNotFighting();
    const award = await evReq(19482, { activity_type: KT_ACT });
    log(`Kim Thu: nhận thưởng sát thương: ${evOk(award) ? `OK (${(award.hurt_award_ids || []).length} mốc)` : 'không có / ' + errText(award)}`);

    await evGifts(KT_GIFTS, 'Kim Thu');

    // Rút thưởng bằng hết vé.
    let draws = 0;
    while (PropsCtrl.gInst().findGoodsNum(KT_TICKET) > 0 && draws < 200 && !stopFlag) {
      const r = await evReq(19487, { activity_type: KT_ACT, type: 1 });
      if (!evOk(r)) {
        log(`Kim Thu: rút thưởng lỗi ${errText(r)}`);
        break;
      }
      draws++;
      await sleep(300);
    }
    if (draws) log(`Kim Thu: rút thưởng ${draws} lần`);

    await evTasks(15, 'Kim Thu');
    await evPass(17, 'Kim Thu');
  }

  // Uy Chấn Ý Vũ: 19528 thông tin (unique_id, left_times; không phản hồi = sự kiện chưa mở),
  // 19529 {unique_id, times:1} rút thưởng bằng vật phẩm 1004301. Nhiệm vụ type 20 có mốc chiêu mộ nên
  // chiêu mộ (30407 type 1) bằng lệnh chiêu mộ 1000240 trong túi — chỉ khi còn lệnh, không tốn Tiên Ngọc.
  // Chiến lệnh type 19 trả thêm vật phẩm rút / lệnh chiêu mộ, nên lặp tới khi không còn gì để làm.
  // Quà 40011 miễn phí, 40012 mua bằng Tiên Ngọc (đều cho vật phẩm rút), mua trước khi rút.
  const UC_GIFTS = [40011, 40012];
  const UC_DRAW_ITEM = 1004301;
  const UC_RECRUIT_ITEM = 1000240;
  async function uyChan() {
    const props = PropsCtrl.gInst();
    const info = await evReq(19528, {}, 3000);
    if (evClosed(info)) return log('Uy Chấn: sự kiện chưa mở');
    await evGifts(UC_GIFTS, 'Uy Chấn');
    let left = info.left_times;
    let recruits = 0, draws = 0;
    for (let round = 0; round < 10 && !stopFlag; round++) {
      let did = false;
      while (props.findGoodsNum(UC_RECRUIT_ITEM) > 0 && recruits < 200 && !stopFlag) {
        const r = await evReq(30407, { type: 1 });
        if (!evOk(r)) {
          log(`Uy Chấn: chiêu mộ lỗi ${errText(r)}`);
          break;
        }
        recruits++;
        did = true;
        await sleep(500);
      }
      while (props.findGoodsNum(UC_DRAW_ITEM) > 0 && left > 0 && draws < 500 && !stopFlag) {
        const r = await evReq(19529, { unique_id: info.unique_id, times: 1 });
        if (!evOk(r)) {
          log(`Uy Chấn: rút thưởng lỗi ${errText(r)}`);
          left = 0;
          break;
        }
        left = r.left_times;
        draws++;
        did = true;
        await sleep(300);
      }
      if (await evTasks(20, 'Uy Chấn')) did = true;
      if (await evPass(19, 'Uy Chấn')) did = true;
      if (!did) break;
    }
    log(`Uy Chấn: chiêu mộ ${recruits} lần, rút thưởng ${draws} lần, còn ${left} lượt rút`);
  }

  // Hỏa Thụ Ngân Hoa:
  // - 19731 quà ngày (is_get 0 = chưa nhận) -> 19733 nhận.
  // - Boss: 19734 thông tin (không phản hồi = sự kiện chưa mở), 19735 đánh (đội hình type 77), mỗi trận cho
  //   1 xẻng 1011001; 19736 nhận thưởng sát thương.
  // - Quà 12323: 72001 miễn phí, 72002 Tiên Ngọc.
  // - Đào: 19726 thông tin (id 0 = chưa chọn phần thưởng lớn -> 19727 {id, is_default:0}), 19728 {grid_id:0} đào
  //   1 ô bằng 1 xẻng, 19730 nhận rương tiến độ (box_val) khi đủ, cho thêm xẻng.
  // - Nhiệm vụ type 1016, chiến lệnh type 37 kỳ 1. Chiến lệnh cho thêm xẻng nên lặp tới khi hết việc.
  const HT_GIFTS = [72001, 72002];
  const HT_SHOVEL = 1011001;
  const HT_MAX_FIGHTS = 3;
  async function hoaThu() {
    const props = PropsCtrl.gInst();
    const boss = await evReq(19734, {}, 3000);
    if (evClosed(boss)) return log('Hỏa Thụ: sự kiện chưa mở');

    const daily = await evReq(19731, {});
    if (daily && daily.is_get == 0) {
      const r = await evReq(19733, {});
      log(`Hỏa Thụ: quà ngày: ${evOk(r) ? 'OK' : 'lỗi ' + errText(r)}`);
    }
    await evGifts(HT_GIFTS, 'Hỏa Thụ');

    // Nhiệm vụ type 47 (cho vật phẩm 1005216): NV 4 = đánh Đấu Tiên Đài ARENA_DAILY trận trong ngày, value là số
    // trận hôm nay (tính cả trận đánh tay) nên đánh thêm cho đủ rồi nhận.
    const t47 = await evReq(30040, { type: 47 });
    const arenaTask = ((t47 && t47.task_list) || []).find(t => t.id == 4);
    if (arenaTask && arenaTask.status == 0 && arenaTask.value < ARENA_DAILY) {
      log(`Hỏa Thụ: NV Đấu Tiên Đài ${arenaTask.value}/${ARENA_DAILY}, đánh thêm ${ARENA_DAILY - arenaTask.value} trận`);
      await arenaFight(ARENA_DAILY - arenaTask.value);
      await waitNotFighting();
    }
    await evTasks(47, 'Hỏa Thụ');

    // Đánh boss HT_MAX_FIGHTS lần (mỗi trận cho 1 xẻng), dừng sớm nếu server từ chối.
    await evTeam(77);
    let fights = 0;
    while (fights < HT_MAX_FIGHTS && !stopFlag) {
      await waitNotFighting();
      const r = await evReq(19735, {}, 10000);
      if (!evOk(r)) {
        log(`Hỏa Thụ: dừng đánh boss: ${errText(r)}`);
        break;
      }
      fights++;
      log(`Hỏa Thụ: đánh boss lần ${fights}, sát thương ${longVal(r.hurt)}`);
      await sleep(800);
      await waitNotFighting();
    }
    const award = await evReq(19736, {});
    if (evOk(award)) log(`Hỏa Thụ: nhận thưởng sát thương (${(award.hurt_award_ids || []).length} mốc)`);

    let digs = 0, boxes = 0;
    for (let round = 0; round < 10 && !stopFlag; round++) {
      let did = false;
      let info = await evReq(19726, {});
      while (info && props.findGoodsNum(HT_SHOVEL) > 0 && digs < 500 && !stopFlag) {
        if (!info.id) {
          // Chưa chọn phần thưởng lớn của tầng: chọn ô đầu tiên server nhận.
          let picked = 0;
          for (let id = 1; id <= 10 && !picked; id++) {
            if (evOk(await evReq(19727, { id, is_default: 0 }))) picked = id;
          }
          if (!picked) {
            log(`Hỏa Thụ: tầng ${info.layer} không chọn được phần thưởng lớn, dừng đào`);
            break;
          }
          log(`Hỏa Thụ: tầng ${info.layer} chọn phần thưởng lớn ${picked}`);
        }
        const r = await evReq(19728, { grid_id: 0 });
        if (!evOk(r)) {
          log(`Hỏa Thụ: đào lỗi ${errText(r)}`);
          break;
        }
        digs++;
        did = true;
        await sleep(300);
        // Thử nhận rương tiến độ (server từ chối nếu chưa đủ).
        if (evOk(await evReq(19730, {}))) {
          boxes++;
          await sleep(300);
        }
        info = await evReq(19726, {});
      }
      if (await evTasks(1016, 'Hỏa Thụ')) did = true;
      if (await evTasks(47, 'Hỏa Thụ')) did = true;
      if (await evPass(37, 'Hỏa Thụ', [1])) did = true;
      if (!did) break;
    }
    log(`Hỏa Thụ: đánh boss ${fights} lần, đào ${digs} ô, nhận ${boxes} rương, còn ${props.findGoodsNum(HT_SHOVEL)} xẻng`);
  }

  // Thiên Thuẫn: nhiệm vụ type 200 (không có nhiệm vụ = sự kiện chưa mở); 101/102 là mốc tổng (đủ 5/6 nhiệm vụ)
  // nên nhận lặp tới khi hết. 11211 thưởng ngày. Cửa hàng type 3: 12110 xem, 12112 đổi hàng (dùng hết lượt miễn
  // phí), 12111 {type, pos, id} mua — chỉ mua hàng bán bằng xu (lable "coin") để xong NV mua hàng / tiêu xu.
  // NV tiêu Tiên Ngọc: theo log của user, quay hết lượt ngày của 30611/30612 và 19305/19308 (10 lần ~2000 Tiên Ngọc).
  const TT_SHOP = 3;
  const TT_DRAWS = [[30611, 30612, 'Quay 30612'], [19305, 19308, 'Quay 19308']];
  async function thienThuan() {
    const tasks = await evReq(30040, { type: 200 });
    if (!tasks || !(tasks.task_list || []).length) return log('Thiên Thuẫn: sự kiện chưa mở');
    const claimTasks = async () => {
      while ((await evTasks(200, 'Thiên Thuẫn')) && !stopFlag) await sleep(300);
    };

    const daily = await evReq(11211, {});
    if (evOk(daily)) log('Thiên Thuẫn: nhận thưởng ngày OK');
    await claimTasks();

    // Cửa hàng: mua hàng bằng xu, đổi hàng bằng lượt miễn phí rồi mua tiếp.
    let shop = await evReq(12110, { type: TT_SHOP });
    let bought = 0, refreshed = 0;
    while (shop && !stopFlag) {
      for (const g of shop.list || []) {
        if (g.is_buy || g.lable != 'coin') continue;
        const r = await evReq(12111, { type: TT_SHOP, pos: g.pos, id: g.id });
        if (evOk(r) || (r && r.code == 1)) bought++;
        else log(`Thiên Thuẫn: mua hàng ${g.id} lỗi ${errText(r)}`);
        await sleep(200);
      }
      if (!(shop.free__count_left > 0)) break;
      const next = waitRecv(12110);
      NetMgr.gInst().sendMsg(12112, { type: TT_SHOP });
      shop = await next;
      if (shop) refreshed++;
    }
    log(`Thiên Thuẫn: cửa hàng đổi ${refreshed} lần (miễn phí), mua ${bought} món bằng xu`);

    // Quay hết lượt trong ngày (tốn Tiên Ngọc).
    for (const [infoCmd, drawCmd, name] of TT_DRAWS) {
      const info = await evReq(infoCmd, {});
      let left = (info && info.remain_draw_num) || 0;
      let n = 0;
      while (left > 0 && !stopFlag) {
        const times = left >= 10 ? 10 : 1;
        const r = await evReq(drawCmd, { times });
        if (!evOk(r)) {
          log(`Thiên Thuẫn: ${name} lỗi ${errText(r)}`);
          break;
        }
        n += times;
        left = r.remain_draw_num;
        await sleep(500);
      }
      log(`Thiên Thuẫn: ${name}: ${n} lần`);
    }

    await claimTasks();
  }

  // Hành Trình Tiên Nghịch: chiến lệnh type 13 (không có kỳ nào = sự kiện chưa mở), quà miễn phí 20001,
  // nhiệm vụ type 8 và 9, 19447 {} mở rương bằng điểm (mỗi lần 50 điểm) — mở tới khi server từ chối.
  async function tienNghich() {
    const zl = await evReq(12321, { type: 13 }, 3000);
    if (!zl || !(zl.list || []).length) return log('Tiên Nghịch: sự kiện chưa mở');
    await evGifts([20001], 'Tiên Nghịch');
    await evTasks(8, 'Tiên Nghịch');
    await evTasks(9, 'Tiên Nghịch');
    let boxes = 0, scores = null;
    while (boxes < 200 && !stopFlag) {
      const r = await evReq(19447, {});
      if (!evOk(r)) break;
      boxes++;
      scores = r.scores;
      await sleep(300);
    }
    log(`Tiên Nghịch: mở ${boxes} rương${scores != null ? `, còn ${scores} điểm` : ''}`);
    await evPass(13, 'Tiên Nghịch', zl.list.map(t => t.term_id));
  }

  // Tôn Hồn Toái Uyên: 19532 thông tin (left_times; không phản hồi = sự kiện chưa mở), 19534 {times:1} rút
  // bằng vật phẩm 1005011. Quà 53012 miễn phí, 53013 Tiên Ngọc (đều cho vật phẩm rút), mua trước khi rút.
  // Nhiệm vụ type 29, chiến lệnh type 27 cho thêm vật phẩm rút, nên lặp tới khi hết việc.
  const TH_GIFTS = [53012, 53013];
  const TH_DRAW_ITEM = 1005011;
  async function tonHon() {
    const props = PropsCtrl.gInst();
    const info = await evReq(19532, {}, 3000);
    if (evClosed(info)) return log('Tôn Hồn: sự kiện chưa mở');
    await evGifts(TH_GIFTS, 'Tôn Hồn');
    let left = info.left_times;
    let draws = 0;
    for (let round = 0; round < 10 && !stopFlag; round++) {
      let did = false;
      while (props.findGoodsNum(TH_DRAW_ITEM) > 0 && left > 0 && draws < 500 && !stopFlag) {
        const r = await evReq(19534, { times: 1 });
        if (!evOk(r)) {
          log(`Tôn Hồn: rút thưởng lỗi ${errText(r)}`);
          left = 0;
          break;
        }
        left = r.left_times;
        draws++;
        did = true;
        await sleep(300);
      }
      if (await evTasks(29, 'Tôn Hồn')) did = true;
      if (await evPass(27, 'Tôn Hồn')) did = true;
      if (!did) break;
    }
    log(`Tôn Hồn: rút thưởng ${draws} lần, còn ${left} lượt rút`);
  }

  // Vạn Hợp Tu Hành: 19462 thông tin (type_list = các mốc đã nhận, acc_charge = đã nạp; không phản hồi = sự kiện
  // chưa mở), 19463 {type} nhận mốc. Mốc 1 miễn phí, các mốc khác cần nạp tiền nên chỉ nhận mốc 1.
  async function vanHop() {
    const info = await evReq(19462, {}, 3000);
    if (evClosed(info)) return log('Vạn Hợp: sự kiện chưa mở');
    const got = (info.type_list || []).map(t => (typeof t === 'object' ? t.type : t));
    if (got.includes(1)) return log('Vạn Hợp: hôm nay đã nhận quà miễn phí');
    const r = await evReq(19463, { type: 1 });
    log(`Vạn Hợp: nhận quà miễn phí: ${evOk(r) ? 'OK' : 'lỗi ' + errText(r)}`);
  }

  // Dục Ấn Thiên Chiếu / Đế Hồn Anh Phách: cùng một bộ lệnh, mỗi kỳ một unique_id và vật phẩm rút riêng.
  // 19390 thông tin (unique_id, left_times; không phản hồi = sự kiện chưa mở).
  // Boss: 19394 {unique_id} đánh 1 lần (đội hình type 39), 19395 nhận thưởng sát thương (cho vật phẩm rút).
  // 19391 {unique_id, times:1} rút bằng vật phẩm của kỳ. Nhiệm vụ type 3, chiến lệnh type 5 cho thêm vật phẩm
  // rút, nên lặp tới khi hết việc. Quà của kỳ (12323, [miễn phí, Tiên Ngọc], cho vật phẩm rút) mua trước khi rút;
  // kỳ chưa biết mã quà thì bỏ qua.
  const DA_TERMS = {
    1056006: ['Dục Ấn', 1001351, [9502, 9503]],
    1056007: ['Đế Hồn', 1001361, [9602, 9603]],
  };
  async function ducAn() {
    const props = PropsCtrl.gInst();
    const info = await evReq(19390, {}, 3000);
    if (evClosed(info)) return log('Dục Ấn / Đế Hồn: sự kiện chưa mở');
    const uid = info.unique_id;
    const [label, drawItem, gifts] = DA_TERMS[uid] || [`Sự kiện ${uid}`, 0, []];
    if (!drawItem) log(`${label}: kỳ mới chưa biết vật phẩm rút, chỉ đánh boss / nhận nhiệm vụ / chiến lệnh`);
    if (gifts.length) await evGifts(gifts, label);

    await evTeam(39);
    await waitNotFighting();
    const fight = await evReq(19394, { unique_id: uid }, 10000);
    log(`${label}: đánh boss ${evOk(fight) ? `- sát thương ${longVal(fight.hurt)}` : 'lỗi ' + errText(fight)}`);
    await sleep(800);
    await waitNotFighting();
    const award = await evReq(19395, { unique_id: uid });
    if (evOk(award)) log(`${label}: nhận thưởng sát thương (${(award.hurt_award_ids || []).length} mốc)`);

    let left = info.left_times;
    let draws = 0;
    for (let round = 0; round < 10 && !stopFlag; round++) {
      let did = false;
      while (drawItem && props.findGoodsNum(drawItem) > 0 && left > 0 && draws < 500 && !stopFlag) {
        const r = await evReq(19391, { unique_id: uid, times: 1 });
        if (!evOk(r)) {
          log(`${label}: rút thưởng lỗi ${errText(r)}`);
          left = 0;
          break;
        }
        left = r.left_times;
        draws++;
        did = true;
        await sleep(300);
      }
      if (await evTasks(3, label)) did = true;
      if (await evPass(5, label)) did = true;
      if (!did) break;
    }
    log(`${label}: rút thưởng ${draws} lần, còn ${left} lượt rút`);
  }

  // Ma Hải Mịch Bảo: 19370 thông tin (không phản hồi = sự kiện chưa mở). Boss: 19375 thông tin, 19376 đánh
  // (đội hình type 37), 19377 nhận thưởng sát thương. 12323 quà: 7101 miễn phí, 7102 Tiên Ngọc (cho vé 1000040).
  // 19371 {times} mở ô bằng vé 1000040 (1 vé / lần). Nhiệm vụ type 1, chiến lệnh type 3 cho thêm vé,
  // nên lặp tới khi hết việc.
  const MH_GIFTS = [7101, 7102];
  const MH_TICKET = 1000040;
  async function maHai() {
    const props = PropsCtrl.gInst();
    const info = await evReq(19370, {}, 3000);
    if (evClosed(info)) return log('Ma Hải: sự kiện chưa mở');
    await evGifts(MH_GIFTS, 'Ma Hải');

    await evTeam(37);
    await waitNotFighting();
    const fight = await evReq(19376, {}, 10000);
    log(`Ma Hải: đánh boss ${evOk(fight) ? `- sát thương ${longVal(fight.hurt)}` : 'lỗi ' + errText(fight)}`);
    await sleep(800);
    await waitNotFighting();
    const award = await evReq(19377, {});
    if (evOk(award)) log(`Ma Hải: nhận thưởng sát thương (${(award.hurt_award_ids || []).length} mốc)`);

    let draws = 0;
    for (let round = 0; round < 10 && !stopFlag; round++) {
      let did = false;
      while (props.findGoodsNum(MH_TICKET) > 0 && draws < 500 && !stopFlag) {
        const r = await evReq(19371, { times: 1 });
        if (!evOk(r)) {
          log(`Ma Hải: mở ô lỗi ${errText(r)}`);
          round = 10;
          break;
        }
        draws++;
        did = true;
        await sleep(300);
      }
      if (await evTasks(1, 'Ma Hải')) did = true;
      if (await evPass(3, 'Ma Hải')) did = true;
      if (!did) break;
    }
    log(`Ma Hải: mở ô ${draws} lần, còn ${props.findGoodsNum(MH_TICKET)} vé`);
  }

  // Tiên Di Địa: vé rút 1001314. 19408 quà đăng nhập {day_list}, 19409 nhận hết (server trả lại 19408).
  // Quà 12323: 13001 miễn phí, 13002 Tiên Ngọc. Boss: 19411 thông tin (không phản hồi = sự kiện chưa mở),
  // 19412 đánh (đội hình type 41), 19413 nhận thưởng sát thương. 19402 {count} rút bằng vé (trả {list}).
  // Nhiệm vụ type 4, chiến lệnh type 9 cho thêm vé, nên lặp tới khi hết việc.
  // Ba Ngàn Mộng Cảnh (lật thẻ): 19405 bảng {cards_list[{id, base_id}], count = số ván đã chơi, time = giờ bắt
  // đầu, 0 = chưa chơi}; 19406 {type:0} bắt đầu, 19407 {list:[{id},{id}]} lật 1 cặp — cả hai lệnh đều trả 19405.
  // cards_list chứa sẵn base_id mọi thẻ còn lại, cặp đúng thì 2 thẻ biến mất; hết thẻ thì server trả bảng mới
  // (time 0) và 19414 thưởng ván.
  const TD_GIFTS = [13001, 13002];
  const TD_TICKET = 1001314;
  const TD_GAMES = 3; // số ván mỗi lần chạy; ván không có thưởng thì dừng
  const TD_GAME_MS = 10000; // mỗi ván kéo dài khoảng 10 giây: chờ đủ rồi mới lật cặp cuối
  async function tienDi() {
    const props = PropsCtrl.gInst();
    const boss = await evReq(19411, {}, 3000);
    if (evClosed(boss)) return log('Tiên Di: sự kiện chưa mở');

    const login = await evReq(19408, {});
    const had = ((login && login.day_list) || []).length;
    const claimed = waitRecv(19408, 3000);
    NetMgr.gInst().sendMsg(19409, {});
    const after = await claimed;
    const got = ((after && after.day_list) || []).length - had;
    if (got > 0) log(`Tiên Di: nhận quà đăng nhập ${got} ngày`);

    await evGifts(TD_GIFTS, 'Tiên Di');

    // Gửi lệnh rồi chờ bảng 19405 (lỗi thì server trả chính lệnh đó).
    const cardReq = async (cmd, data) => {
      const reply = Promise.race([waitRecv(19405, 3000), waitRecv(cmd, 3000)]);
      NetMgr.gInst().sendMsg(cmd, data);
      return reply;
    };
    let games = 0;
    for (let g = 0; g < TD_GAMES && !stopFlag; g++) {
      let board = await cardReq(19406, { type: 0 });
      if (!board || !board.cards_list || !board.time) {
        log(`Ba Ngàn Mộng Cảnh: không bắt đầu được ván ${errText(board)}`);
        break;
      }
      const reward = waitRecv(19414, TD_GAME_MS + 15000);
      const t0 = Date.now();
      for (let n = 0; n < 50 && board && board.time && (board.cards_list || []).length && !stopFlag; n++) {
        const byBase = {};
        board.cards_list.forEach(c => (byBase[c.base_id] = byBase[c.base_id] || []).push(c.id));
        const pair = Object.values(byBase).find(ids => ids.length >= 2);
        if (!pair) {
          log(`Ba Ngàn Mộng Cảnh: không còn cặp thẻ giống nhau (${board.cards_list.length} thẻ)`);
          break;
        }
        if (board.cards_list.length <= 2) await sleep(Math.max(0, TD_GAME_MS - (Date.now() - t0)));
        board = await cardReq(19407, { list: [{ id: pair[0] }, { id: pair[1] }] });
        await sleep(1000);
      }
      const r = await reward;
      if (!r) {
        log('Ba Ngàn Mộng Cảnh: ván không có thưởng, dừng');
        break;
      }
      games++;
      log(`Ba Ngàn Mộng Cảnh: xong ván ${games} (${r.time} giây)`);
      await sleep(500);
    }

    await evTeam(41);
    await waitNotFighting();
    const fight = await evReq(19412, {}, 10000);
    log(`Tiên Di: đánh boss ${evOk(fight) ? `- sát thương ${longVal(fight.hurt)}` : 'lỗi ' + errText(fight)}`);
    await sleep(800);
    await waitNotFighting();
    const award = await evReq(19413, {});
    if (evOk(award)) log(`Tiên Di: nhận thưởng sát thương (${(award.hurt_award_ids || []).length} mốc)`);

    let draws = 0;
    for (let round = 0; round < 10 && !stopFlag; round++) {
      let did = false;
      while (props.findGoodsNum(TD_TICKET) > 0 && draws < 500 && !stopFlag) {
        const r = await evReq(19402, { count: 1 });
        if (!r || !r.list) {
          log(`Tiên Di: rút thưởng lỗi ${errText(r)}`);
          round = 10;
          break;
        }
        draws++;
        did = true;
        await sleep(300);
      }
      if (await evTasks(4, 'Tiên Di')) did = true;
      if (await evPass(9, 'Tiên Di')) did = true;
      if (!did) break;
    }
    log(`Tiên Di: rút thưởng ${draws} lần, còn ${props.findGoodsNum(TD_TICKET)} vé`);
  }

  // Vòng quay may mắn: nhiệm vụ type 38 (không có nhiệm vụ = sự kiện chưa mở) cho vé quay 1001904,
  // 19645 {} quay 1 lần bằng 1 vé — quay tới khi hết vé.
  const LW_TICKET = 1001904;
  async function luckyWheel() {
    const props = PropsCtrl.gInst();
    const tasks = await evReq(30040, { type: 38 }, 3000);
    if (!tasks || !(tasks.task_list || []).length) return log('Vòng quay: sự kiện chưa mở');
    await evTasks(38, 'Vòng quay');
    let spins = 0;
    while (props.findGoodsNum(LW_TICKET) > 0 && spins < 200 && !stopFlag) {
      const r = await evReq(19645, {});
      if (!evOk(r)) {
        log(`Vòng quay: quay lỗi ${errText(r)}`);
        break;
      }
      spins++;
      await sleep(300);
    }
    log(`Vòng quay: quay ${spins} lần, còn ${props.findGoodsNum(LW_TICKET)} vé`);
  }

  // Cứu Uyển Nhi (MzCtrl, bản đồ nhiều ô, đi từ cột này sang cột kế): 20201 bản đồ {layer, event_list[{event_id,
  // index, status, relic_list, fc}]}; index = cột * 10 + hàng. status (MzConst.EEvtSt): 0 chưa chọn, 1 đã vào,
  // 2 thắng - chờ chọn bảo vật, 3 xong, 4 bỏ (nhánh không chọn). Loại ô = model.gETypeCfg(event_id) (MzConst.EEvtTp,
  // xử lý theo MzCtrl.oprEvt): 1, 2, 8, 10 đánh; 3, 4 quán thuê tướng; 5, 6 hồi máu; 7 Sự kiện phường (cửa hàng).
  // Vào ô: 20202 {index, op_type (EEvtOp: 1 đánh, 2 dùng, 3 thuê, 4 cửa hàng), arg_list}. Đánh: 20205 {index}
  // (đội hình type 25 đã lưu) -> 20212 {index, relic_index} chọn bảo vật. Thuê: 20210 {index} xem -> op 3 arg = id
  // tướng -> 20205. Hồi máu: op 2 -> 20215 {index, use 1}. Cửa hàng: op 4 -> 20213 xem -> 20205 từ bỏ (không mua).
  // Hết tầng: 20219 nhận thưởng tầng, 20204 {is_diff} sang tầng sau (tầng 3 là cuối).
  // Đường đi: chỉ sang cột kế, ô cùng hàng hoặc chéo liền kề (hàng ±1); cột chỉ có 1 ô (ô boss) đi được từ mọi
  // hàng. Chọn đường qua nhiều Sự kiện phường nhất; bằng nhau thì ưu tiên ô đánh LC thấp, rồi hồi máu, rồi thuê.
  const UN_FIGHT = [1, 2, 8, 10];
  const UN_HIRE = [3, 4];
  const UN_HP = [5, 6];
  const UN_SHOP = 7;
  // Hóa Phàm Thành Thần: nhiệm vụ type 1001 (30040/30041, mỗi nhiệm vụ cộng điểm val chiến lệnh) rồi chiến lệnh
  // type 24 kỳ 1 (12328 {type, term_id} xem, 12322 nhận thưởng thường). 30040 không có task_list = chưa mở.
  async function hoaPham() {
    const tasks = await evReq(30040, { type: 1001 });
    if (evClosed(tasks) || !tasks.task_list) return log('Hóa Phàm: sự kiện chưa mở');
    await evTasks(1001, 'Hóa Phàm');
    const zl = await evReq(12328, { type: 24, term_id: 1 });
    if (zl) log(`Hóa Phàm: điểm chiến lệnh ${zl.val}`);
    if (!(await evPass(24, 'Hóa Phàm', [1]))) log('Hóa Phàm: chiến lệnh chưa có mốc mới');
  }

  // Ngũ Hành Mê Tung: 19473 thông tin {unique_id, left_times}, 19474 {unique_id, times 1} rút thưởng bằng vé
  // 80000101 (mỗi lần 1 vé), quà 12323: 34101 miễn phí, 34102 Tiên Ngọc; nhiệm vụ type 14 (nhận được cộng điểm và
  // rút thưởng lại mở nhiệm vụ mới) nên lặp tới khi không còn gì làm; chiến lệnh type 16 kỳ 1 (12321 rỗng khi chưa
  // nhận mốc nào nên truyền sẵn kỳ).
  const NH_GIFTS = [34101, 34102];
  const NH_TICKET = 80000101;
  async function nguHanh() {
    const info = await evReq(19473, {}, 3000);
    if (evClosed(info) || !info.unique_id) return log('Ngũ Hành: sự kiện chưa mở');
    await evGifts(NH_GIFTS, 'Ngũ Hành');
    let draws = 0;
    for (let round = 0; round < 10 && !stopFlag; round++) {
      let did = false;
      while (PropsCtrl.gInst().findGoodsNum(NH_TICKET) > 0 && draws < 200 && !stopFlag) {
        const r = await evReq(19474, { unique_id: info.unique_id, times: 1 });
        if (!evOk(r)) {
          log(`Ngũ Hành: rút thưởng lỗi ${errText(r)}`);
          break;
        }
        draws++;
        did = true;
        await sleep(300);
      }
      if (await evTasks(14, 'Ngũ Hành')) did = true;
      if (await evPass(16, 'Ngũ Hành', [1])) did = true;
      if (!did) break;
    }
    log(`Ngũ Hành: rút thưởng ${draws} lần, còn ${PropsCtrl.gInst().findGoodsNum(NH_TICKET)} vé`);
  }

  const UN_LAST_LAYER = 3;
  const UN_DIFF = 1; // sang tầng sau ở độ khó cao (như chơi tay); server từ chối thì thử độ thường
  async function uyenNhi() {
    const model = MzCtrl.gInst().getCurlModel();
    // event_id không có trong cấu hình thì gETypeCfg ném lỗi (đọc eType của undefined): coi là loại 0.
    const etype = e => {
      try {
        return Number(model.gETypeCfg(e.event_id)) || 0;
      } catch (err) {
        return 0;
      }
    };
    const col = i => Math.floor(i / 10);
    const map = async () => (await evReq(20201)) || null;
    const kind = e => {
      const t = etype(e);
      if (UN_FIGHT.includes(t)) return `đánh, LC ${longVal(e.fc)}`;
      if (UN_HIRE.includes(t)) return 'thuê tướng';
      if (UN_HP.includes(t)) return 'hồi máu';
      return t == UN_SHOP ? 'Sự kiện phường' : `loại ${t}, event ${e.event_id}`;
    };
    const tag = e => `ô ${e.index} (${kind(e)})`;
    const res = r => (evOk(r) ? 'OK' : 'lỗi ' + errText(r));
    let layer = '?';
    const L = msg => log(`Uyển Nhi T${layer}: ${msg}`);
    // Bản đồ 1 dòng để debug: theo cột, mỗi ô "index+loại+trạng thái". Loại: Đ đánh, B boss, T thuê, H hồi máu,
    // P Sự kiện phường. Trạng thái: ✓ xong, × bỏ, * đang làm / chờ chọn bảo vật.
    const ch = e => {
      const t = etype(e);
      return t == 8 ? 'B' : UN_FIGHT.includes(t) ? 'Đ' : UN_HIRE.includes(t) ? 'T' : UN_HP.includes(t) ? 'H' : t == UN_SHOP ? 'P' : `?${t}`;
    };
    const mapText = evs => {
      const cols = {};
      evs.forEach(e => (cols[col(e.index)] = cols[col(e.index)] || []).push(e));
      return Object.keys(cols).sort((a, b) => a - b)
        .map(c => cols[c].sort((a, b) => a.index - b.index).map(e => `${e.index}${ch(e)}${['', '*', '*', '✓', '×'][e.status] || ''}`).join(' '))
        .join(' | ');
    };
    let shownLayer = null;
    const fight = async e => {
      await waitNotFighting();
      const result = waitRecv(14002, 10000);
      const r = await evReq(20205, { index: e.index });
      if (!evOk(r)) {
        L(`${tag(e)} đánh ${res(r)}`);
        return false;
      }
      const f = await result;
      await sleep(800);
      await waitNotFighting();
      const won = f && f.result == 1;
      L(`${tag(e)} - ${won ? 'thắng' : 'thua'}`);
      return won;
    };
    let m = await map();
    if (evClosed(m)) return L('sự kiện chưa mở');
    for (let step = 0; step < 100 && !stopFlag; step++) {
      await jobGate();
      m = await map();
      if (!m) return L('không lấy được bản đồ');
      const evs = m.event_list || [];
      layer = m.layer;
      if (shownLayer !== layer) {
        shownLayer = layer;
        L(`bản đồ (Đ đánh, B boss, T thuê, H hồi máu, P phường; ✓ xong, × bỏ, * đang làm): ${mapText(evs)}`);
      }
      // Việc dở: chọn bảo vật (luôn lấy bảo vật 1) / làm nốt ô đã vào.
      const won = evs.find(e => e.status == 2);
      if (won) {
        L(`${tag(won)} chọn bảo vật 1: ${res(await evReq(20212, { index: won.index, relic_index: 1 }))}`);
        await sleep(300);
        continue;
      }
      const act = evs.find(e => e.status == 1);
      if (act) {
        const t = etype(act);
        if (UN_FIGHT.includes(t) || longVal(act.fc) > 0) {
          if (!(await fight(act))) return L('thua, dừng (cần mạnh hơn)');
        } else {
          let r;
          if (UN_HP.includes(t)) r = await evReq(20215, { index: act.index, use: 1 });
          else if (t == UN_SHOP) {
            const shop = await evReq(20213, { index: act.index });
            const goods = (shop && shop.goods_list) || [];
            if (goods.length) L(`cửa hàng có ${goods.length} món (không mua)`);
            r = await evReq(20205, { index: act.index });
          } else r = await evReq(20205, { index: act.index });
          L(`${tag(act)}${t == UN_SHOP ? ' bỏ qua' : ''}: ${res(r)}`);
          if (!evOk(r)) return L(`kẹt ở ${tag(act)}, làm tay ô này rồi chạy lại`);
        }
        await sleep(500);
        continue;
      }
      const done = evs.filter(e => e.status == 3);
      const curNode = done.length ? done.reduce((a, b) => (col(b.index) > col(a.index) ? b : a)) : null;
      const cur = curNode ? col(curNode.index) : 0;
      const ahead = evs.filter(e => e.status == 0 && col(e.index) > cur);
      if (!ahead.length) {
        // Hết ô: nhận thưởng tầng rồi sang tầng sau.
        const aw = await evReq(20219);
        // 218039 "Đã nhận thưởng rương rồi": tầng này đã xong từ trước.
        L(`xong tầng ${m.layer}, nhận thưởng: ${aw && (aw.msg == 218039 || aw.code == 218039) ? 'đã nhận từ trước' : res(aw)}`);
        if (m.layer >= UN_LAST_LAYER) return L('đã xong tầng cuối');
        await sleep(500);
        let r = await evReq(20204, { is_diff: UN_DIFF });
        if (!evOk(r) && UN_DIFF) {
          L(`sang tầng sau độ khó ${UN_DIFF} ${res(r)}, thử độ thường`);
          r = await evReq(20204, { is_diff: 0 });
        }
        if (!evOk(r)) return L(`sang tầng sau ${res(r)}`);
        const nm = await map();
        if (!nm || nm.layer == m.layer) return L('không sang được tầng sau, dừng');
        L(`sang tầng ${nm.layer}`);
        await sleep(500);
        continue;
      }
      const colsAll = {};
      evs.forEach(e => (colsAll[col(e.index)] = (colsAll[col(e.index)] || 0) + 1));
      const reach = (from, to) => !from || colsAll[col(to.index)] == 1 || Math.abs((from.index % 10) - (to.index % 10)) <= 1;
      const colIds = [...new Set(ahead.map(e => col(e.index)))].sort((a, b) => a - b);
      const val = new Map();
      for (let c = colIds.length - 1; c >= 0; c--) {
        const nextCol = ahead.filter(e => col(e.index) == colIds[c + 1]);
        for (const e of ahead.filter(x => col(x.index) == colIds[c])) {
          const after = nextCol.filter(n => reach(e, n)).map(n => val.get(n));
          val.set(e, (etype(e) == UN_SHOP ? 1000 : 0) + 1 + (after.length ? Math.max(...after) : 0));
        }
      }
      const rank = e => {
        const t = etype(e);
        if (UN_FIGHT.includes(t)) return longVal(e.fc);
        if (t == UN_SHOP) return 0;
        return UN_HP.includes(t) ? 1e15 : UN_HIRE.includes(t) ? 2e15 : 3e15;
      };
      const opts = ahead.filter(e => col(e.index) == colIds[0] && reach(curNode, e))
        .sort((a, b) => val.get(b) - val.get(a) || rank(a) - rank(b));
      if (!opts.length) return L(`không có ô nào ở cột ${colIds[0]} nối được với ô ${curNode && curNode.index}`);
      // Debug đường đi: ô hiện tại, các ô đi được (kèm số Sự kiện phường còn gom được nếu đi ô đó), đường dự tính.
      const plan = [opts[0]];
      for (let c = 1; c < colIds.length; c++) {
        const nx = ahead.filter(e => col(e.index) == colIds[c] && reach(plan[plan.length - 1], e));
        if (!nx.length) break;
        plan.push(nx.reduce((a, b) => (val.get(b) > val.get(a) ? b : a)));
      }
      L(`đang ở ô ${curNode ? curNode.index : 'xuất phát'}, ô đi được: ${opts.map(e => `${e.index}${ch(e)}(${Math.floor(val.get(e) / 1000)}P)`).join(' ')}` +
        ` -> đường dự tính ${plan.map(e => `${e.index}${ch(e)}`).join('→')}`);
      let moved = false;
      for (const e of opts) {
        const t = etype(e);
        let r;
        if (UN_FIGHT.includes(t)) r = await evReq(20202, { index: e.index, op_type: 1, arg_list: [] });
        else if (UN_HP.includes(t)) r = await evReq(20202, { index: e.index, op_type: 2, arg_list: [] });
        else if (t == UN_SHOP) r = await evReq(20202, { index: e.index, op_type: 4, arg_list: [] });
        else if (UN_HIRE.includes(t)) {
          const info = await evReq(20210, { index: e.index });
          const heroes = (info && info.hero_list) || [];
          if (!heroes.length) continue;
          const best = heroes.reduce((a, b) => (longVal(b.fc) > longVal(a.fc) ? b : a));
          r = await evReq(20202, { index: e.index, op_type: 3, arg_list: [{ arg: best.id }] });
          if (evOk(r)) L(`${tag(e)} thuê ${best.name}`);
        } else continue;
        if (evOk(r)) {
          moved = true;
          break;
        }
        L(`vào ${tag(e)} ${res(r)}`);
      }
      if (!moved) return L(`không vào được ô nào ở cột ${colIds[0]}: ${opts.map(tag).join(', ')}`);
      await sleep(500);
    }
  }

  // Tiên duyên: 32101 thông tin nhóm (không phản hồi = chưa có nhóm), 32121 {id} nhận thưởng mốc nhiệm vụ.
  // Chưa biết danh sách mốc trong 32101 nên thử nhận id 1..TD_MAX_ID; mốc chưa xong / đã nhận server từ chối.
  const TD_MAX_ID = 12;
  async function tienDuyen() {
    const info = await evReq(32101, {}, 3000);
    if (!info) return log('Tiên duyên: không lấy được thông tin (chưa có nhóm?)');
    let got = 0;
    for (let id = 1; id <= TD_MAX_ID && !stopFlag; id++) {
      if (evOk(await evReq(32121, { id }))) got++;
      await sleep(200);
    }
    log(`Tiên duyên: nhận ${got} mốc${got ? '' : ' (chưa có mốc nào xong)'}`);
    // Hòm điểm nhóm (nút onboxBtn): 32122 -> {res, score}; chưa đủ điểm / đã nhận server từ chối.
    const box = await evReq(32122, {});
    log(`Tiên duyên: mở hòm ${evOk(box) ? 'OK' : `lỗi ${errText(box)}`}`);
  }

  // Chư Thiên Luận Đạo: 14211 thông tin (my_rank_lev, remain_count = lượt miễn phí còn lại), 14216 top 3 BXH,
  // 14218 {index, rank, id} bái top (is_thumb 0 = chưa bái), 14213 làm mới đối thủ -> 14214 enemy_list,
  // 14212 {index, id} khiêu chiến -> 14219 kết quả (s_rank_change > 0 = thắng), 14222 quét 1 lượt.
  // Chỉ thứ 7, chủ nhật mới khiêu chiến được; ngày khác quét hết lượt. Mỗi lượt: xem danh sách 5 đối thủ đang hiện
  // (server đẩy 14214 kèm 14211, không có thì làm mới 14213), chọn người hạng cao hơn mình (rank nhỏ hơn) có lực
  // chiến ≤ CT_FC_RATIO lần mình, hạng cao nhất trước; không có ai thì làm mới tối đa CT_REFRESH lần, vẫn không có
  // (không leo được nữa) thì quét các lượt còn lại.
  // Khiêu chiến giống game: 14220 {id} xem đội hình rồi mới 14212. Lỗi 170002 (danh sách cũ) thì làm mới, thử lại.
  const CT_FC_RATIO = 1.2;
  const CT_RETRY = 3;
  const CT_REFRESH = 5;
  async function chuThien() {
    const myFc = longVal(RoleCtrl.gInst().getRoleInfo().fc);
    const maxFc = Math.floor(myFc * CT_FC_RATIO);
    const top = await evReq(14216);
    for (const t of (top && top.top_rank_list) || []) {
      if (t.is_thumb != 0) continue;
      const r = await evReq(14218, { index: t.index, rank: t.rank, id: t.id });
      log(`Luận Đạo: bái top ${t.rank} ${t.name}: ${evOk(r) ? 'OK' : 'lỗi ' + errText(r)}`);
      await sleep(500);
    }
    const net = NetMgr.gInst();
    const day = new Date(net.getTime() * 1000).getDay();
    // Ngày thường không khiêu chiến được: coi như không leo được nữa, quét luôn.
    let canClimb = day == 0 || day == 6;
    if (!canClimb) log('Luận Đạo: ngày thường chỉ quét được');
    let n = 1;
    let fails = 0;
    let refresh = false;
    const lost = new Set();
    while (n <= 30 && !stopFlag) {
      await jobGate();
      const waitList = waitRecv(14214, 3000);
      const info = await evReq(14211);
      if (!info) return log('Luận Đạo: không lấy được thông tin');
      if (!(info.remain_count > 0)) return log(`Luận Đạo: hết lượt miễn phí, hạng ${info.my_rank_lev}`);
      const myRank = info.my_rank_lev;
      let shown = await waitList;
      const pick = s => ((s && s.enemy_list) || [])
        .filter(e => e.rank < myRank && longVal(e.fc) <= maxFc && !lost.has(longVal(e.id)));
      let list = (shown && shown.enemy_list) || [];
      let ok = canClimb && !refresh ? pick(shown) : [];
      for (let i = 0; canClimb && !ok.length && i < CT_REFRESH && !stopFlag; i++) {
        const w = waitRecv(14214);
        net.sendMsg(14213, {});
        shown = await w;
        list = (shown && shown.enemy_list) || [];
        ok = pick(shown);
        await sleep(500);
      }
      refresh = false;
      if (canClimb && !ok.length) {
        canClimb = false;
        log(`Luận Đạo: làm mới ${CT_REFRESH} lần không có ai hạng cao hơn (hạng ${myRank}) với LC ≤ ${maxFc} ` +
          `(${CT_FC_RATIO * 100}%), quét các lượt còn lại. Danh sách cuối: ` +
          list.map(e => `hạng ${e.rank} LC ${longVal(e.fc)}`).join(', '));
      }
      if (ok.length) {
        const enemy = ok.reduce((a, b) => (b.rank < a.rank ? b : a));
        await waitNotFighting();
        await evReq(14220, { id: enemy.id });
        await sleep(500);
        // Server chặn bấm liên tục ("Thao tác nhanh quá rồi~", 100009): chờ rồi thử lại cùng đối thủ.
        let result, r;
        for (let tries = 0; tries < 4; tries++) {
          result = waitRecv(14219, 15000);
          r = await evReq(14212, { index: enemy.index, id: enemy.id });
          if (!r || r.res == 1 || (r.msg != 100009 && r.code != 100009)) break;
          await sleep(3000);
        }
        if (!evOk(r)) {
          log(`Luận Đạo lượt ${n}: khiêu chiến ${enemy.name} lỗi ${errText(r)}`);
          if (++fails >= CT_RETRY) return log('Luận Đạo: lỗi liên tục, dừng');
          refresh = true;
          await sleep(1000);
          continue;
        }
        fails = 0;
        const res = await result;
        const won = res && res.s_rank_change > 0;
        if (!won) lost.add(longVal(enemy.id)); // thua thì không chọn lại người này (danh sách thường giữ nguyên)
        log(`Luận Đạo lượt ${n}: đánh ${enemy.name} hạng ${enemy.rank} (LC ${longVal(enemy.fc)}) - ` +
          (won ? `thắng, hạng ${myRank} → ${res.s_rank}` : res ? 'thua' : 'không rõ kết quả'));
        n++;
        await sleep(3000);
        await waitNotFighting();
        continue;
      }
      const r = await evReq(14222);
      log(`Luận Đạo lượt ${n}: quét ${evOk(r) ? 'OK' : 'lỗi ' + errText(r)}`);
      n++;
      if (!evOk(r)) return;
      await sleep(500);
    }
  }

  // Thần Lâm Chiến: 31801 thông tin {status, end_time, enemy_list [{index, id, name, point, fc}]}, 31811 top BXH
  // (is_thumb 0 = chưa bái), 31812 {rank, id} bái, 31804 làm mới -> 31805 enemy_list, 31819 {order, id} xem đội
  // hình (lỗi 170002 = danh sách cũ), 31802 {order, id} khiêu chiến -> 31803 kết quả (all_result 1 = thắng) và
  // 31816 {total_num} số trận hôm nay, 31806 {num} nhận thưởng số trận. Mở theo đợt như Tỉ thí tông môn: đang mở
  // thì end_time > giờ server. Đánh đủ TL_DAILY trận, ưu tiên người lực chiến thấp hơn mình (thấp nhất trước),
  // không có thì làm mới tối đa TL_REFRESH lần rồi đánh người thấp nhất. 31801 chưa rõ có số trận hôm nay không
  // nên lấy max(total_num nếu có, số trận tool đã đánh hôm nay).
  const TL_DAILY = 5;
  const TL_REFRESH = 3;
  const tlKey = 'tnThanLamDaily';
  const tlDoneByTool = () => {
    try {
      const s = JSON.parse(localStorage.getItem(tlKey) || '{}');
      return s.day === today() ? s.count || 0 : 0;
    } catch { return 0; }
  };
  const tlSetDone = count => {
    try { localStorage.setItem(tlKey, JSON.stringify({ day: today(), count })); } catch {}
  };
  async function thanLam() {
    const info = await evReq(31801, {});
    if (!info) return log('Thần Lâm Chiến: không lấy được thông tin');
    if (info.status != 1 || !(info.end_time > NetMgr.gInst().getTime())) return log('Thần Lâm Chiến: chưa mở');
    const top = await evReq(31811, {});
    for (const t of (top && top.top_rank_list) || []) {
      if (t.is_thumb != 0) continue;
      const r = await evReq(31812, { rank: t.rank, id: t.id });
      log(`Thần Lâm Chiến: bái top ${t.rank} ${t.name}: ${evOk(r) ? 'OK' : 'lỗi ' + errText(r)}`);
      await sleep(500);
    }
    const myFc = longVal(RoleCtrl.gInst().getRoleInfo().fc);
    let done = Math.max(info.total_num || 0, tlDoneByTool());
    let list = info.enemy_list || [];
    log(`Thần Lâm Chiến: điểm ${info.point}, lực chiến ${myFc}, hôm nay đã đánh ${done}/${TL_DAILY}`);
    let fails = 0;
    while (done < TL_DAILY && !stopFlag) {
      await jobGate();
      let weaker = list.filter(e => longVal(e.fc) < myFc);
      for (let i = 0; !weaker.length && i < TL_REFRESH && !stopFlag; i++) {
        const fresh = waitRecv(31805);
        await evReq(31804, {});
        list = ((await fresh) || {}).enemy_list || list;
        weaker = list.filter(e => longVal(e.fc) < myFc);
        await sleep(500);
      }
      const pool = weaker.length ? weaker : list;
      if (!pool.length) return log('Thần Lâm Chiến: không có đối thủ');
      const enemy = pool.reduce((a, b) => (longVal(b.fc) < longVal(a.fc) ? b : a));
      await waitNotFighting();
      const view = await evReq(31819, { order: enemy.index, id: enemy.id });
      if (!view || !view.combat_list) {
        // Danh sách cũ: làm mới rồi chọn lại.
        if (++fails >= 3) return log('Thần Lâm Chiến: lỗi liên tục, dừng');
        const fresh = waitRecv(31805);
        await evReq(31804, {});
        list = ((await fresh) || {}).enemy_list || list;
        await sleep(500);
        continue;
      }
      await sleep(500);
      const result = waitRecv(31803, 15000);
      const total = waitRecv(31816, 15000);
      const next = waitRecv(31805, 15000);
      const r = await evReq(31802, { order: enemy.index, id: enemy.id });
      if (!evOk(r)) {
        log(`Thần Lâm Chiến: khiêu chiến ${enemy.name} lỗi ${errText(r)}`);
        if (++fails >= 3) return log('Thần Lâm Chiến: lỗi liên tục, dừng');
        await sleep(1000);
        continue;
      }
      fails = 0;
      const [res, tot, nx] = await Promise.all([result, total, next]);
      done = tot && tot.total_num ? tot.total_num : done + 1;
      tlSetDone(done);
      if (nx && nx.enemy_list) list = nx.enemy_list;
      log(`Thần Lâm Chiến trận ${done}: ${enemy.name} (LC ${longVal(enemy.fc)}) - ` +
        (res ? `${res.all_result == 1 ? 'thắng' : 'thua'}, điểm ${res.s_point} (${res.s_point_change >= 0 ? '+' : ''}${res.s_point_change})` : 'không rõ kết quả'));
      await sleep(2000);
      await waitNotFighting();
    }
    // Nhận thưởng số trận: chưa rõ danh sách mốc nên thử num 1..số trận; đã nhận / chưa đủ server từ chối.
    let got = 0;
    for (let num = 1; num <= Math.min(done, TL_DAILY); num++) {
      if (evOk(await evReq(31806, { num }))) got++;
      await sleep(300);
    }
    log(`Thần Lâm Chiến: đã đánh ${done}/${TL_DAILY}, nhận ${got} mốc thưởng`);
  }

  // "Hàng ngày nhiều lần" - Làm tất cả: chạy lần lượt mọi việc trong nhóm, lỗi một việc không dừng cả lượt.
  async function runAllRepeat() {
    const steps = [
      ['Linh thú', spiritHarvest],
      ['Di tích', ruinsAll],
      ['Cực Âm Địa', extremeYin],
      ['Núi cấm', forbiddenMountain],
      ['Treo Thưởng', travel],
    ];
    stopFlag = false;
    for (const [name, fn] of steps) {
      if (stopFlag) return log('== Đã dừng ==');
      await jobGate();
      log(`== ${name} ==`);
      try {
        await fn();
      } catch (e) {
        log(`LỖI ${name}: ${(e && e.message) || e}`);
      }
      await waitNotFighting();
      await goCity();
      await sleep(500);
    }
    log('== Xong tất cả ==');
  }

  // Tỉ thí tông môn (exeGldWrUi): đánh GW_FREE lượt miễn phí vào 1 vùng đất. 18125 trạng thái (challenge_times
  // = số lượt đã đánh), 18126 các vùng (city_occupy), 18127 {city_id} bảng xếp hạng vùng (my_rank > 0 = đã đánh ở
  // vùng này), 18133 {city_id} khiêu chiến (đội hình type 22 đã lưu) -> trận 14002, trả {code 1, damage}.
  // Chọn vùng đã đánh trước (có my_rank), chưa có thì vùng đầu tiên. Ngoài đợt mở thì bỏ qua.
  const GW_FREE = 5;
  async function guildWar() {
    const st = await evReq(18125, {});
    if (!st) return log('Tỉ thí tông môn: không lấy được thông tin');
    // Mở theo đợt (vài ngày 1 lần): đang mở thì challenge_etime = giờ đóng đợt này, challenge_stime = giờ mở đợt
    // sau (> etime); chưa mở thì stime = giờ mở sắp tới (< etime).
    const now = NetMgr.gInst().getTime();
    const fmt = t => new Date(t * 1000).toLocaleString('vi-VN');
    if (!(st.challenge_etime > now) || (st.challenge_stime < st.challenge_etime && now < st.challenge_stime)) {
      return log(`Tỉ thí tông môn: chưa mở, đợt sau ${fmt(st.challenge_stime)}`);
    }
    if (st.challenge_times >= GW_FREE) return log(`Tỉ thí tông môn: đã đánh ${st.challenge_times}/${GW_FREE} lượt`);
    const cities = (((await evReq(18126, {})) || {}).city_occupy || []).map(c => c.city_id).sort((a, b) => a - b);
    if (!cities.length) return log('Tỉ thí tông môn: không có vùng đất nào');
    let city = null;
    for (const id of cities) {
      const r = await evReq(18127, { city_id: id });
      if (r && r.my_rank > 0) { city = id; log(`Tỉ thí tông môn: vùng ${id} đã đánh trước, hạng ${r.my_rank}`); break; }
      await sleep(200);
    }
    if (city == null) { city = cities[0]; log(`Tỉ thí tông môn: chưa đánh vùng nào, chọn vùng ${city}`); }
    let times = st.challenge_times || 0;
    while (times < GW_FREE && !stopFlag) {
      await waitNotFighting();
      const fight = waitRecv(14002, 10000);
      const r = await evReq(18133, { city_id: city }, 10000);
      if (!r || r.code != 1) return log(`Tỉ thí tông môn: lượt ${times + 1} lỗi ${errText(r)}`);
      await fight;
      await sleep(1000);
      await waitNotFighting();
      const s = await evReq(18125, {});
      times = s ? s.challenge_times : times + 1;
      log(`Tỉ thí tông môn: lượt ${times}/${GW_FREE} vùng ${city} - sát thương ${longVal(r.damage)}`);
    }
  }

  // Event "Làm tất cả": chạy lần lượt mọi sự kiện; sự kiện chưa mở tự báo và bỏ qua, lỗi một sự kiện không dừng cả lượt.
  async function runAllEvents() {
    const events = [
      ['Kim Thu Thập Quang', kimThu],
      ['Uy Chấn Ý Vũ', uyChan],
      ['Hỏa Thụ Ngân Hoa', hoaThu],
      ['Thiên Thuẫn', thienThuan],
      ['Hành Trình Tiên Nghịch', tienNghich],
      ['Tôn Hồn Toái Uyên', tonHon],
      ['Vạn Hợp Tu Hành', vanHop],
      ['Dục Ấn Thiên Chiếu / Đế Hồn Anh Phách', ducAn],
      ['Ma Hải Mịch Bảo', maHai],
      ['Tiên Di Địa', tienDi],
      ['Vòng quay may mắn', luckyWheel],
      ['Cứu Uyển Nhi', uyenNhi],
      ['Tỉ thí tông môn', guildWar],
      ['Hóa Phàm Thành Thần', hoaPham],
      ['Ngũ Hành Mê Tung', nguHanh],
    ];
    stopFlag = false;
    for (const [name, fn] of events) {
      if (stopFlag) return log('== Đã dừng ==');
      await jobGate();
      log(`== ${name} ==`);
      try {
        await fn();
      } catch (e) {
        log(`LỖI ${name}: ${(e && e.message) || e}`);
      }
      await waitNotFighting();
      await goCity();
      await sleep(500);
    }
    log('== Xong tất cả sự kiện ==');
  }

  // Tỉ Thí Thiên Đạo (KfLolCtrl): chỉ dùng lượt miễn phí (free_count, thường 3/ngày). Mỗi lượt:
  // tìm đối thủ (14302) -> chờ ghép xong (14303 có field_end_time) -> đánh (14319) -> kết quả 14306.
  async function kfLol() {
    const ctrl = KfLolCtrl.gInst();
    for (let n = 1; n <= 10; n++) {
      ctrl.send14301();
      const info = await waitRecv(14301);
      if (!info) return log('Tỉ Thí: không lấy được thông tin');
      if (!(info.free_count > 0)) return log(`Tỉ Thí: hết lượt miễn phí (đã đánh ${n - 1} lần), điểm ${info.point}`);
      await waitNotFighting();
      const matched = (async () => {
        for (let i = 0; i < 12; i++) {
          const m = await waitRecv(14303, 5000);
          if (m && m.field_end_time > 0) return m;
        }
        return null;
      })();
      ctrl.send14302(0, info.is_skip);
      const r = await waitRecv(14302);
      if (!r || r.res != 1) return log(`Tỉ Thí lần ${n}: tìm đối thủ lỗi ${errText(r)}`);
      const m = await matched;
      if (!m) return log(`Tỉ Thí lần ${n}: chờ 60 giây vẫn chưa tìm được đối thủ`);
      const result = waitRecv(14306, 15000);
      ctrl.send14319();
      const f = await waitRecv(14319);
      if (!f || f.res != 1) return log(`Tỉ Thí lần ${n}: vào trận lỗi ${errText(f)}`);
      const res = await result;
      log(`Tỉ Thí lần ${n}: ${res ? (res.result == 1 ? 'thắng' : 'thua') : 'không rõ kết quả'}${res ? `, điểm ${res.old_point} → ${res.new_point}` : ''}`);
      await sleep(1500);
      await waitNotFighting();
    }
  }

  // Cực Âm Địa (ExtremeYinCtrl): giành chỗ tu luyện tốt nhất (id càng nhỏ càng tốt, ít chỗ, thưởng cao).
  // Xét các địa điểm từ tốt nhất: còn chỗ thì vào (32202, đánh lính canh luôn thắng) là xong; hết chỗ thì
  // xem trước người đang ngồi (32203, xem được từ ngoài) và chỉ vào khi có người lực chiến ≤ 115% của mình,
  // rồi khiêu chiến giành chỗ (32205). Thua thì xuống địa điểm thấp hơn, tới khi có chỗ ngồi.
  const YIN_FC_RATIO = 1.15;
  // Đoạt (trước khi giành chỗ): mỗi ngày đoạt YIN_ROB_DAILY lần người lực chiến thấp hơn mình. Ở địa điểm cấp
  // thấp (id lớn) nhiều người yếu nên xét từ thấp lên: vào địa điểm (32202), xem danh sách đoạt được
  // (32203 {id, type:2}), đoạt người yếu nhất (32206 {id, role_id}, đội hình type 40). Số lần đã đoạt hôm nay
  // lấy từ 32201 rob_times.
  const YIN_ROB_DAILY = 2;
  async function yinRob(ctrl, builds, ids, me, myFc, name, fight) {
    const robTimes = async () => {
      ctrl.send32201();
      const s = await waitRecv(32201);
      return s ? s.rob_times || 0 : null;
    };
    let done = await robTimes();
    if (done == null) return log('Cực Âm: không đọc được số lần đoạt');
    if (done >= YIN_ROB_DAILY) return log(`Cực Âm: hôm nay đã đoạt đủ ${YIN_ROB_DAILY} lần`);
    log(`Cực Âm: hôm nay đã đoạt ${done}/${YIN_ROB_DAILY}, tìm người lực chiến < ${myFc} để đoạt`);
    await evTeam(40);
    const tried = new Set();
    for (const id of [...ids].reverse()) {
      if (done >= YIN_ROB_DAILY || stopFlag) break;
      if (me.lev < builds[id].open_lv) continue;
      const list = async () => {
        ctrl.send32203(id, 2);
        const r = await waitRecv(32203);
        return ((r && r.role_list) || [])
          .filter(p => longVal(p.fc) < myFc && !tried.has(String(longVal(p.id))))
          .sort((a, b) => longVal(a.fc) - longVal(b.fc));
      };
      let targets = await list();
      if (!targets.length) continue;
      // Phải vào địa điểm mới đoạt được người trong đó.
      ctrl.send32201();
      const s = await waitRecv(32201);
      if (!s || s.id != id) {
        await waitNotFighting();
        ctrl.send32202(id);
        const r = await waitRecv(32202, 10000);
        if (!r || r.res != 1) {
          log(`Cực Âm: vào ${name(id)} để đoạt lỗi ${errText(r)}`);
          continue;
        }
        await fight();
        targets = await list();
      }
      for (const t of targets) {
        if (done >= YIN_ROB_DAILY || stopFlag) break;
        tried.add(String(longVal(t.id)));
        await waitNotFighting();
        const result = waitRecv(14002, 10000);
        const r = await evReq(32206, { id, role_id: t.id }, 10000);
        if (!evOk(r)) {
          log(`Cực Âm: đoạt ${t.name} ở ${name(id)} lỗi ${errText(r)}`);
          continue;
        }
        const f = await result;
        await fight();
        const now = await robTimes();
        if (now != null) done = now;
        log(`Cực Âm: đoạt ${t.name} (LC ${longVal(t.fc)}) ở ${name(id)} - ${f ? (f.result == 1 ? 'thắng' : 'thua') : 'không rõ kết quả'} (${done}/${YIN_ROB_DAILY})`);
      }
    }
    if (done < YIN_ROB_DAILY) log(`Cực Âm: không tìm đủ người yếu hơn để đoạt (${done}/${YIN_ROB_DAILY})`);
  }
  async function extremeYin() {
    const ctrl = ExtremeYinCtrl.gInst();
    const builds = ctrl.getCurlModel().getBuildConfig();
    const me = RoleCtrl.gInst().getRoleInfo();
    const myFc = longVal(me.fc);
    const maxFc = Math.floor(myFc * YIN_FC_RATIO);
    const name = id => (builds[id] && builds[id].name) || `địa điểm ${id}`;
    // Chiến lệnh Cực Âm (12321/12322 type 6): nhận các mốc đã đủ điểm.
    if (!(await evPass(6, 'Cực Âm'))) log('Cực Âm: chiến lệnh không có mốc mới để nhận');
    const status = async () => {
      ctrl.send32201();
      const s = await waitRecv(32201);
      ctrl.send32200();
      const lands = await waitRecv(32200);
      const num = {};
      ((lands && lands.land_list) || []).forEach(l => (num[l.id] = l.num));
      return { landId: s ? s.id : 0, seated: !!(s && s.start_time > 0), num };
    };
    const fight = async () => {
      await sleep(1000);
      await waitNotFighting();
    };

    const ids = Object.keys(builds).map(Number).sort((a, b) => a - b);
    await yinRob(ctrl, builds, ids, me, myFc, name, fight);

    let st = await status();
    log(`Cực Âm: đang ở ${name(st.landId)}${st.seated ? ' (đang tu luyện)' : ' (chưa có chỗ)'}, lực chiến ${myFc}`);
    for (const id of ids) {
      const b = builds[id];
      if (st.seated && id >= st.landId) return log(`Cực Âm: giữ chỗ ở ${name(st.landId)}, không giành được chỗ tốt hơn`);
      if (me.lev < b.open_lv) continue;
      const full = b.seat > 0 && (st.num[id] || 0) >= b.seat;
      let target = null;
      if (full) {
        for (let i = 0; i < 5 && !target; i++) {
          ctrl.send32203(id, 1);
          const list = await waitRecv(32203);
          const weak = ((list && list.role_list) || []).filter(r => longVal(r.fc) <= maxFc);
          if (weak.length) target = weak.reduce((a, c) => (longVal(c.fc) < longVal(a.fc) ? c : a));
          else await sleep(500);
        }
        if (!target) {
          log(`Cực Âm: ${name(id)} hết chỗ, không có ai lực chiến ≤ ${maxFc} (115%)`);
          continue;
        }
      }
      // Vào địa điểm (đánh lính canh) nếu chưa ở đó, hoặc đang ở đó mà chưa có chỗ và vẫn còn chỗ trống.
      if (st.landId != id || !full) {
        await waitNotFighting();
        ctrl.send32202(id);
        const r = await waitRecv(32202, 10000);
        if (!r || r.res != 1) {
          log(`Cực Âm: vào ${name(id)} lỗi ${errText(r)}`);
          continue;
        }
        await fight();
      }
      if (target) {
        await waitNotFighting();
        ctrl.send32205(id, target.id);
        const r = await waitRecv(32205, 10000);
        await fight();
        if (!r || r.res != 1) log(`Cực Âm: khiêu chiến ${target.name} ở ${name(id)} lỗi ${errText(r)}`);
      }
      st = await status();
      if (st.seated && st.landId == id) {
        return log(`Cực Âm: đã có chỗ ở ${name(id)}${target ? ` (thắng ${target.name}, LC ${longVal(target.fc)})` : ''}`);
      }
      log(`Cực Âm: chưa có chỗ ở ${name(id)}, thử địa điểm thấp hơn`);
    }
    log(`Cực Âm: kết thúc, đang ở ${name(st.landId)}${st.seated ? ' (đang tu luyện)' : ' (chưa có chỗ)'}`);
  }

  // NV 11: PB Ngày — quét nhanh mọi phó bản ngày bằng lượt miễn phí (như nút quét nhanh, lệnh 11002 type 0).
  async function dailyDungeon() {
    const ctrl = DailyDungeonCtrl.gInst();
    const free = ctrl.getAllMianFeiNum(true);
    if (!(free > 0)) return log('PB Ngày: hết lượt miễn phí');
    await waitNotFighting();
    ctrl.send11002(0);
    const r = await waitRecv(11002, 10000);
    log(`PB Ngày: quét nhanh (${free} lượt miễn phí): ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
  }

  // NV 18: Vực U Minh (YMAbyssCtrl) — đánh 1 trận ải kế tiếp, thắng thua đều tính nhiệm vụ.
  async function abyss() {
    if (!taskRemain(18)) return log('Vực U Minh: nhiệm vụ đã đủ');
    const ctrl = YMAbyssCtrl.gInst();
    ctrl.send32070();
    await waitRecv(32070);
    const cfg = ctrl.curChapterCfg;
    if (!cfg) return log('Vực U Minh: đã qua hết ải');
    await waitNotFighting();
    const fight = waitRecv(14002, 10000);
    ctrl.send32071(cfg.id);
    const r = await waitRecv(11001, 10000);
    if (!r || r.res != 1) return log(`Vực U Minh: đánh ải ${cfg.id} lỗi ${errText(r)}`);
    const f = await fight;
    await sleep(800);
    await waitNotFighting();
    log(`Vực U Minh: đánh ải ${cfg.id} - ${f && f.result == 1 ? 'thắng' : 'thua'}`);
  }

  // Nâng cấp (buff) của Tứ Phái, xếp theo ưu tiên của user: giảm sát thương > thủ > hồi máu > công.
  // Danh sách lấy từ config skill_buff_data_json (10001–10009); id lạ xếp cuối.
  const BUFF_PRIORITY = [
    10006, // Giảm S.Thương +10%
    10009, // Thủ +10%
    10005, // Kháng Bạo +10%
    10007, // Hồi HP +10%
    10004, // Trị Liệu Nhận +10%
    10001, // Công +10%
    10003, // S.Thương Bạo +10%
    10002, // Tỷ Lệ Bạo +10%
    10008, // Chính Xác +10%
  ];
  const buffRank = id => {
    const i = BUFF_PRIORITY.indexOf(Number(id));
    return i < 0 ? BUFF_PRIORITY.length : i;
  };
  const buffName = id => {
    const b = FightCtrl.gInst().getCurlModel().getBuffData(id) || {};
    return String(b.desc || b.name || id).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  };
  // Debug: liệt kê buff theo thứ tự ưu tiên.
  function listBuffs(from = 10001, to = 10030) {
    const ids = [];
    for (let id = from; id <= to; id++) if (FightCtrl.gInst().getCurlModel().getBuffData(id)) ids.push(id);
    ids.sort((a, b) => buffRank(a) - buffRank(b));
    return ids.map((id, i) => `${i + 1}. ${id} ${buffName(id)}`).join('\n') || '(không có buff nào trong khoảng này)';
  }

  // NV 9: Thủ Vệ Tứ Phái (ETCtrl) — cho mượn tướng mạnh nhất, rồi đánh liên tục (chọn nâng cấp theo
  // ưu tiên thủ > hồi máu > công, bỏ qua chiến đấu) tới khi thua. Phần thưởng nhiệm vụ nhận bằng nút "Nhận thưởng hết".
  async function endlessTrial() {
    const et = ETCtrl.gInst();
    et.sd11030(0);
    const info = await waitRecv(11030);
    if (!info) return log('Tứ Phái: không lấy được thông tin');
    if (info.status == 3) return log(`Tứ Phái: hôm nay đã đánh xong (qua ${info.today_max_count} ải)`);

    // Trợ trận: cho người khác mượn 1 tướng.
    et.sd14020(1);
    const help = await waitRecv(14020);
    const me = RoleCtrl.gInst().getRoleInfo();
    const lent = ((help && help.public_list) || []).some(h => longVal(h.role_id) == longVal(me.id) || h.role_name == me.name);
    if (lent) {
      log('Tứ Phái: đã cho mượn tướng từ trước');
    } else {
      const heroes = HeroCtrl.gInst().getHeroDataByRealm(0) || [];
      const best = heroes.reduce((a, b) => (!a || longVal(b.fc) > longVal(a.fc) ? b : a), null);
      if (best) {
        et.sd14021(1, best.id);
        const r = await waitRecv(14021);
        log(`Tứ Phái: cho mượn ${best.name} (LC ${longVal(best.fc)}): ${r && r.res == 1 ? 'OK' : 'lỗi ' + errText(r)}`);
      }
    }

    // Đánh các ải.
    et.opEBuffUi(null);
    let buffs = await waitRecv(11033);
    for (let round = 1; round <= 50; round++) {
      if (!buffs || !buffs.enter_id || !(buffs.buff_list || []).length) return log('Tứ Phái: không còn ải để đánh');
      const buff = buffs.buff_list.map(b => b.id).reduce((a, b) => (buffRank(b) < buffRank(a) ? b : a));
      // Sau mỗi trận game thường tự gửi 11033 (mở bảng nâng cấp) nên chờ sẵn trước khi đánh.
      const nextBuffs = waitRecv(11033, 30000);
      await waitNotFighting();
      et.choiceBuffId(buff);
      const r = await waitRecv(11031, 10000);
      if (!r || r.res != 1) return log(`Tứ Phái ải ${buffs.enter_id}: lỗi ${errText(r)}`);
      const ids = (r.ids || []).map(x => x.id);
      log(`Tứ Phái lượt ${round}: ải ${buffs.enter_id}, nâng cấp "${buffName(buff)}", ${r.is_win ? 'thắng' : 'thua'}, qua ${ids.join(',')}`);
      await sleep(1000);
      await waitNotFighting();
      if (r.is_quit) {
        await sleep(1000);
        et.sd11030(0);
        const end = await waitRecv(11030);
        return log(`Tứ Phái: kết thúc${end ? `, hôm nay qua ${end.today_max_count} ải` : ''}`);
      }
      buffs = await Promise.race([nextBuffs, sleep(3000).then(() => null)]);
      if (!buffs) {
        et.opEBuffUi(null);
        buffs = await waitRecv(11033);
      }
    }
  }

  // ---- Pháp bảo (HeroCtrl) ----
  // Pháp bảo sở hữu: HeroCtrl.magicWeaponDic {base_id: sao}; số tướng đang đeo: wearMagicWeaponDic {base_id: n}.
  // Config theo (base_id, sao) ở model.m_magicWeaponUpStarConfig: name, color, wear (số tướng được đeo cùng lúc),
  // talent_desc (hiệu ứng, chỉ có dạng chữ). Tướng đeo ở hero.magic_weapon_list, 8 ô (pos 1–8) mở theo sao tướng.
  // Tháo: 32006 {hero_id, list:[{item_id, pos}]}; đeo: 32005 {hero_id, type:1, list:[{item_id, pos}]}; item_id = base_id.
  const strip = s => String(s == null ? '' : s).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const mwCfg = (id, star) =>
    Object.values(HeroCtrl.gInst().getCurlModel().m_magicWeaponUpStarConfig).find(c => c.base_id == id && c.star == star) || {};

  // Nhãn theo câu chữ hiệu ứng. Nhãn không có ":" là loại giá trị (chấm theo vai trò); "cần:..." là điều kiện để món
  // có tác dụng, "khi:..." là lúc món kích hoạt — hai loại này chỉ nhân hệ số ở mwScore / lúc chọn.
  const MW_TAGS = [
    [/^Công \+/, 'Công'],
    [/^Thủ \+/, 'Thủ'],
    [/^HP \+/, 'HP'],
    [/^(Tỷ Lệ Bạo|ST Bạo) \+/, 'Bạo'],
    [/^(Buff S\.Thương|S\.Thương KN|ST) \+|S\.Thương tăng|S\.Thương gây cho mục tiêu tăng|Công Thường kèm|^ST \[Thiêu Hồn|Khi gây \[Thiêu Hồn/, 'Sát thương'],
    [/^(Giảm S\.Thương|Kháng Bạo|Miễn ST) \+|Khiên|miễn ST này|chịu tối đa|sẽ giảm 50%|ST giảm \d|S\.Thương lần này giảm|chặn hiệu quả|hồi mức HP|nguồn ST giảm/, 'Sống sót'],
    [/Trị Liệu/, 'Trị liệu'],
    [/gây S\.Thương cho nguồn|người tấn công thêm/, 'Phản đòn'],
    [/Nộ Khí của mục tiêu giảm|lấy từ mục tiêu|mất 1 điểm Nộ|trừ 1 điểm Nộ|giảm Nộ địch/, 'Khóa Nộ'],
    [/hồi 1 điểm Nộ|hồi cho .*Nộ|nhận 1 điểm Nộ|lấy từ mục tiêu 1 điểm Nộ/, 'Hồi Nộ'],
    [/Khi gây \[Thiêu Hồn|^ST \[Thiêu Hồn/, 'cần:Thiêu Hồn'],
    [/HP bản thân dưới/, 'cần:máu thấp'],
    [/Khi tấn công ngoài hiệp/, 'cần:ngoài hiệp'],
    [/Khi bạo kích/, 'cần:bạo'],
    [/Mỗi khi giảm Nộ địch/, 'cần:giảm Nộ'],
    [/Trị Liệu đơn/, 'cần:hồi đơn'],
    [/Khi gây ST đơn/, 'cần:đánh đơn'],
    [/^(Khi|Sau khi) (bị tấn công|chịu)|^Mỗi hiệp chịu|^Chịu ST|^Bản thân mỗi lần chịu|Khi bị diệt/, 'khi:bị đánh'],
    [/Thiêu Hồn/, 'hệ:Thiêu Hồn'],
  ];
  const mwTags = desc => MW_TAGS.filter(([re]) => re.test(desc)).map(([, t]) => t);
  const valueTags = tags => tags.filter(t => !t.includes(':'));

  // Vai trò theo career (phái); trọng số mỗi nhãn theo vai trò. Đây là đánh giá chủ quan, chỉnh ở đây.
  const ROLE = { 1: 'Sát thương', 2: 'Khống chế', 3: 'Đỡ đòn', 4: 'Hỗ trợ' };
  const ROLE_W = {
    'Sát thương': { Công: 1, Thủ: 0.2, HP: 0.3, Bạo: 1, 'Sát thương': 1, 'Sống sót': 0.5, 'Trị liệu': 0, 'Phản đòn': 0.1, 'Khóa Nộ': 0.7, 'Hồi Nộ': 1 },
    'Khống chế': { Công: 0.6, Thủ: 0.3, HP: 0.5, Bạo: 0.5, 'Sát thương': 0.6, 'Sống sót': 0.7, 'Trị liệu': 0, 'Phản đòn': 0.2, 'Khóa Nộ': 1.2, 'Hồi Nộ': 1 },
    'Đỡ đòn': { Công: 0.1, Thủ: 1, HP: 1, Bạo: 0.1, 'Sát thương': 0.2, 'Sống sót': 1.2, 'Trị liệu': 0, 'Phản đòn': 0.8, 'Khóa Nộ': 0.8, 'Hồi Nộ': 0.6 },
    'Hỗ trợ': { Công: 0.6, Thủ: 0.5, HP: 0.7, Bạo: 0.1, 'Sát thương': 0.1, 'Sống sót': 0.9, 'Trị liệu': 1.2, 'Phản đòn': 0.2, 'Khóa Nộ': 0.5, 'Hồi Nộ': 0.8 },
  };
  const COLOR_Q = { 3: 1, 4: 1.6, 5: 2.4, 6: 3.2 };
  // Độ mạnh của món: món chỉ số thuần ("X +n%" hoặc "X +n%, Y +m%") tính theo %, món hiệu ứng tính theo màu và sao.
  const mwPower = (cfg, star) => {
    const desc = strip(cfg.talent_desc);
    const pcts = (desc.match(/[\d.]+(?=%)/g) || []).map(Number);
    if (/^[^+,.]+ \+[\d.]+%(, [^+,.]+ \+[\d.]+%)*$/.test(desc)) return (Math.max(...pcts) / 5) * (1 + 0.5 * (pcts.length - 1));
    return (COLOR_Q[cfg.color] || 1) * (1 + 0.1 * star);
  };

  const skillOf = id => {
    try { return FightCtrl.gInst().getCurlModel().getSkillData(id) || {}; } catch { return {}; }
  };
  // Vị trí trong đội hình (14012): ô 1–3 hàng trước (chịu đòn trước), 4–6 hàng sau. Lỗi thì trả {} (không xét hàng).
  const mwFormation = async () => {
    const p = waitRecv(14012, 3000);
    NetMgr.gInst().sendMsg(14012, { type: 1, sign: 21 });
    const r = await p;
    const pos = {};
    ((r && r.pos_list) || []).forEach(x => (pos[x.id] = x.pos));
    return pos;
  };

  // Thiên phú đã mở của tướng + mô tả vai trò của game (base config "position", vd "S.Thương Vật Lý Hồi Nộ").
  // Thiên phú: model.getHeroTalentData() {id: {base_id, level, dec, active_talent_id}}, mở khi level <= cấp
  // thiên phú hiện tại (getHeroTalentLevDataByStarAndStage(sao, bậc).level). active_talent_id là skill nội tại.
  // Bỏ các dòng chỉ cộng chỉ số ("[Bậc 1 kích hoạt] Công +150."), chỉ giữ dòng có cơ chế.
  const mwHeroTalents = h => {
    const hc = HeroCtrl.gInst(), m = hc.getCurlModel();
    let position = '', talents = [];
    try {
      const base = (m.getHeroBaseData() || {})[h.base_id] || {};
      position = strip([base.position, base.position2].filter(Boolean).join(', '));
    } catch {}
    try {
      const lv = (hc.getHeroTalentLevDataByStarAndStage(h.star, h.stage) || {}).level || h.star;
      for (const t of Object.values(m.getHeroTalentData() || {})) {
        if (t.base_id != h.base_id || t.level > lv) continue;
        const dec = strip(t.dec).replace(/^\[[^\]]*\]\s*/, '');
        if (dec && !/^(Sau khi xuất chiến, )?([^,:]+ \+[\d.]+%?(, |\.?$))+$/.test(dec)) talents.push(dec);
        for (const id of String(t.active_talent_id || '').split(/[^\d]+/).filter(Boolean)) {
          const d = strip(skillOf(Number(id)).desc);
          if (d && !talents.includes(d)) talents.push(d);
        }
      }
    } catch {}
    return { position, talents };
  };

  // Đọc đặc điểm tướng từ mô tả đòn thường (N) và skill nộ (K); đòn thường dùng nhiều hơn nên nặng 70%.
  // Các đặc điểm chung (Thiêu Hồn, Nộ, phản kích...) đọc từ toàn bộ: 2 skill + thiên phú + mô tả vai trò.
  const mwHeroInfo = (h, maxFc, formation) => {
    const attrs = {};
    (h.attr_list || []).forEach(a => (attrs[a.key] = a.value));
    let N = '', K = '';
    try {
      (HeroCtrl.gInst().gHSkill(h.base_id) || []).forEach(s => {
        const d = skillOf(s.skillId);
        if (d.type == 2) K = strip(d.desc); else N = N || strip(d.desc);
      });
    } catch {}
    const { position, talents } = mwHeroTalents(h);
    const all = [N, K, position, ...talents].join(' ');
    const isHeal = t => /hồi phục|Trị liệu|hồi .{0,20}HP|lượng hồi/i.test(t);
    const healOne = t => isHeal(t) && /Trị liệu 1 |(hồi phục|hồi) cho 1 |1 đồng đội có lượng (máu|HP)/i.test(t);
    const isSingle = t => !isHeal(t) && /đơn thể|ngẫu nhiên 1 mục tiêu|^Tấn công 1 /i.test(t);
    const pos = formation[h.id];
    const f = {
      role: ROLE[h.career] || 'Sát thương',
      row: !pos ? '' : pos <= 3 ? 'trước' : 'sau',
      pos,
      heals: isHeal(N) || isHeal(K), // chỉ xét 2 skill: thiên phú tự hồi máu không làm tướng thành người hồi máu
      healOneShare: 0.7 * healOne(N) + 0.3 * healOne(K),
      healByAtk: /(hồi|Trị liệu|hồi phục).{0,80}bằng \d+% (công|tấn công)/i.test(`${N} ${K}`),
      singleShare: 0.7 * isSingle(N) + 0.3 * isSingle(K),
      angerKN: /Nộ cao hơn|cứ 1 điểm Nộ/i.test(all), // sát thương tăng theo Nộ
      cutsAnger: /(giảm|trừ|mất) .{0,15}Nộ/i.test(all),
      taunt: /Khiêu Khích/i.test(all),
      burn: (all.match(/Thiêu Hồn/g) || []).length, // số lần nhắc tới Thiêu Hồn trong skill + thiên phú
      outTurn: /phản kích|truy kích|ngoài hiệp|liên kích/i.test(all),
      crit: (attrs[77] || 0) / 10000, // TL Bạo
      alwaysCrit: /luôn bạo kích|tất bạo|chắc chắn (gây )?bạo/i.test(all),
      // Gây sát thương chủ yếu bằng đòn thường: game ghi trong vai trò, hoặc skill + thiên phú nhắc nhiều lần.
      normalFocus: /Công Thường/i.test(position) || (all.match(/Công Thường|đánh thường/gi) || []).length >= 3,
    };
    // Trọng số: theo vai trò; đứng hàng trước mà không phải tướng đỡ đòn thì lấy trung bình với trọng số đỡ đòn.
    const w = { ...ROLE_W[f.role] };
    if (f.row == 'trước' && f.role != 'Đỡ đòn') for (const k in w) w[k] = (w[k] + ROLE_W['Đỡ đòn'][k]) / 2;
    if (f.healByAtk) w.Công = Math.max(w.Công, 1);
    if (!f.heals) w['Trị liệu'] = 0;
    if (f.angerKN) { w['Hồi Nộ'] *= 1.3; w['Khóa Nộ'] *= 1.3; }
    return { h, ...f, w, N, K, position, talents, text: all, weight: 0.6 + 0.4 * longVal(h.fc) / maxFc }; // tướng mạnh hơn được lợi nhiều hơn
  };
  const heroTraits = hi => [
    hi.carry && 'CARRY',
    hi.row && `hàng ${hi.row} (ô ${hi.pos})`,
    hi.singleShare > 0 && `đánh đơn ${Math.round(hi.singleShare * 100)}%`,
    hi.heals && (hi.healOneShare > 0 ? `hồi 1 người ${Math.round(hi.healOneShare * 100)}%` : 'hồi cả đội'),
    hi.healByAtk && 'hồi theo Công',
    hi.angerKN && 'KN mạnh theo Nộ',
    hi.cutsAnger && 'skill giảm Nộ địch',
    hi.taunt && 'khiêu khích',
    hi.burn && `Thiêu Hồn (nhắc ${hi.burn} lần)`,
    hi.alwaysCrit && 'có lúc luôn bạo kích',
    hi.normalFocus && 'thiên về đòn thường',
  ].filter(Boolean).join(', ');

  // Trùng hiệu ứng: món có hiệu ứng mà tướng đã tự có trong skill/thiên phú thì gần như thừa.
  // [hiệu ứng món, hiệu ứng tướng, hệ số]
  const MW_OVERLAP = [
    [/dẫn đến Chí Mạng, miễn/, /chịu (sát thương|S\.Thương|ST) (chí mạng|bạo)[^.]{0,20}miễn/i, 0.2],
    [/chặn hiệu quả này/, /xóa bỏ toàn bộ khống chế|miễn (nhiễm )?(khống chế|debuff)/i, 0.6],
    [/Khi vào trận, nhận 1 điểm Nộ/, /(vào trận|xuất chiến|bắt đầu trận)[^.]{0,30}(nhận|hồi|tăng) \d+ điểm Nộ/i, 0.6],
  ];

  // Điểm cố định của món với tướng (chưa xét các món khác đã chọn).
  const mwScore = (item, hi, team) => {
    const tags = valueTags(item.tags);
    if (!tags.length) return 0;
    const has = t => item.tags.includes(t);
    // Món Thiêu Hồn trên tướng có Thiêu Hồn: sát thương Thiêu Hồn là cốt lõi bộ skill, nên tính đủ trọng số
    // như tướng sát thương dù đứng hàng nào.
    const burnCore = has('hệ:Thiêu Hồn') && hi.burn;
    let s = tags.reduce((a, t) => a + (burnCore ? Math.max(hi.w[t] || 0, ROLE_W['Sát thương'][t]) : hi.w[t] || 0), 0) / tags.length;
    if (has('cần:Thiêu Hồn') && !hi.burn) s = 0;
    // Cộng hưởng cả đội: mỗi tướng Thiêu Hồn trong đội (ngoài người đeo) làm món Thiêu Hồn mạnh thêm 20%.
    if (has('hệ:Thiêu Hồn') && team.burn) s *= 1 + 0.2 * (team.burn - (hi.burn ? 1 : 0));
    // Tướng xoay quanh Thiêu Hồn (nhắc ≥ 3 lần trong skill + thiên phú) cần món Thiêu Hồn hơn nữa.
    if (has('hệ:Thiêu Hồn') && hi.burn >= 3) s *= 1.3;
    for (const [itemRe, heroRe, k] of MW_OVERLAP) if (itemRe.test(item.desc) && heroRe.test(hi.text)) s *= k;
    // Tướng tự luôn bạo kích (vd Đằng Nhất khi Nộ ≥ 5): tỉ lệ bạo gần như thừa, chỉ còn phần ST Bạo có ích.
    if (hi.alwaysCrit && /Tỷ Lệ Bạo \+/.test(item.desc)) s *= /ST Bạo|S\.Thương Bạo/.test(item.desc) ? 0.7 : 0.3;
    // Tướng thiên về đòn thường: món tăng đòn thường mạnh hơn, món tăng sát thương KN yếu đi.
    if (hi.normalFocus && /^Công Thường|Khi Công Thường/.test(item.desc)) s *= 1.3;
    if (hi.normalFocus && /S\.Thương KN/.test(item.desc)) s *= 0.7;
    if (has('cần:máu thấp')) s *= 0.7;
    if (has('cần:ngoài hiệp') && !hi.outTurn) s *= 0.4;
    if (has('cần:hồi đơn')) s *= 0.3 + 0.7 * hi.healOneShare;
    if (has('cần:đánh đơn')) s *= 0.2 + 0.8 * hi.singleShare;
    if (has('khi:bị đánh')) s *= (hi.row == 'trước' ? 1.25 : hi.row == 'sau' ? 0.7 : 1) * (hi.taunt ? 1.2 : 1);
    if (tags.includes('Sống sót') && !team.healers) s *= 1.2; // đội không có ai hồi máu
    return s * item.power * hi.weight;
  };
  // Hệ số theo các món đã chọn cho cùng tướng: món cùng nhãn giảm dần (đồ cân đối), món cần nguồn giảm Nộ thì
  // chỉ đủ điểm khi tướng có skill giảm Nộ / là khống chế / đã có món Khóa Nộ, tỉ lệ bạo cộng thêm từ món Bạo đã chọn.
  const SAME_TAG_DECAY = 0.85;
  const CARRY_BONUS = 1.5;
  const mwDynamic = (x, hi, tagCount) => {
    let s = x.s * SAME_TAG_DECAY ** Math.max(0, ...valueTags(x.it.tags).map(t => tagCount[t] || 0));
    if (x.it.tags.includes('cần:giảm Nộ') && !(hi.cutsAnger || hi.role == 'Khống chế' || tagCount['Khóa Nộ'])) s *= 0.5;
    if (x.it.tags.includes('cần:bạo') && !hi.alwaysCrit) s *= Math.min(1, 0.3 + hi.crit + 0.1 * (tagCount['Bạo'] || 0));
    return s;
  };

  const mwItems = () => {
    const hc = HeroCtrl.gInst();
    return Object.keys(hc.magicWeaponDic).map(id => {
      const star = hc.magicWeaponDic[id];
      const cfg = mwCfg(id, star);
      const desc = strip(cfg.talent_desc);
      // Config ghi wear = 0 ở mức sao tối đa; các mức khác wear = sao + 1. Server từ chối thì coi như hết chỗ.
      return { id: Number(id), name: cfg.name || id, star, desc, tags: mwTags(desc), power: mwPower(cfg, star), cap: cfg.wear || star + 1 };
    });
  };
  // Mọi tướng (để tháo hết) và đội hình xếp theo lực chiến giảm dần (để đeo).
  const mwHeroes = () => {
    const hc = HeroCtrl.gInst();
    const ids = new Set([...(hc.getHeroDataByRealm(0) || []), ...(hc.szHeroList || [])].map(h => h.id));
    const all = [...ids].map(id => hc.getHeroDataByHeroId(id)).filter(Boolean);
    const team = (hc.szHeroList || []).map(x => hc.getHeroDataByHeroId(x.id) || x)
      .sort((a, b) => longVal(b.fc) - longVal(a.fc));
    return { all, team };
  };
  const openPos = h => [1, 2, 3, 4, 5, 6, 7, 8].filter(p => h.star >= HeroCtrl.gInst().getOpenPosNeedStar(p));

  // Điểm của cả bộ món trên một tướng: xét lần lượt từ món điểm gốc cao nhất, áp hệ số theo các món trước đó.
  const mwSetScore = (hi, xs) => {
    const tagCount = {};
    return xs.slice().sort((a, b) => b.s - a.s).map(x => {
      const s = mwDynamic(x, hi, tagCount);
      x.it.tags.forEach(t => (tagCount[t] = (tagCount[t] || 0) + 1));
      return { ...x, s };
    });
  };
  const sumS = xs => xs.reduce((a, x) => a + x.s, 0);

  // Lập phương án: (1) tướng lực chiến cao chọn trước, mỗi tướng lấy lần lượt món có điểm cao nhất còn chỗ;
  // (2) tối ưu cả đội: thử thay 1 món bằng món còn chỗ, hoặc đổi chéo 2 món giữa 2 tướng, giữ thay đổi nào làm
  // tổng điểm cả đội tăng, lặp tới khi hết cải thiện.
  const mwPlan = async () => {
    const items = mwItems();
    const { team } = mwHeroes();
    const formation = await mwFormation();
    const maxFc = Math.max(...team.map(h => longVal(h.fc)), 1);
    const infos = team.map(h => mwHeroInfo(h, maxFc, formation));
    // Carry: tướng gây sát thương (phái Sát thương/Khống chế, không hồi máu) không đứng hàng trước. Được ưu tiên
    // giành đồ (điểm × CARRY_BONUS, chọn trước); carry phái Khống chế coi trọng cả đồ sát thương như phái Sát thương.
    for (const hi of infos) {
      if (!['Sát thương', 'Khống chế'].includes(hi.role) || hi.heals || hi.row == 'trước') continue;
      hi.carry = true;
      hi.weight *= CARRY_BONUS;
      if (hi.role == 'Khống chế') for (const k in hi.w) hi.w[k] = Math.max(hi.w[k], ROLE_W['Sát thương'][k]);
    }
    infos.sort((a, b) => b.weight - a.weight);
    const teamCtx = { healers: infos.filter(hi => hi.heals).length, burn: infos.filter(hi => hi.burn).length };
    const left = {};
    items.forEach(it => (left[it.id] = it.cap));
    const P = infos.map(hi => {
      const ranked = items.map(it => ({ it, s: mwScore(it, hi, teamCtx) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s);
      const pos = openPos(hi.h);
      const sel = [];
      while (sel.length < pos.length) {
        let best = null, bestS = 0;
        const base = sumS(mwSetScore(hi, sel));
        for (const x of ranked) {
          if (!(left[x.it.id] > 0) || sel.includes(x)) continue;
          const gain = sumS(mwSetScore(hi, [...sel, x])) - base;
          if (gain > bestS) [best, bestS] = [x, gain];
        }
        if (!best) break;
        sel.push(best);
        left[best.it.id]--;
      }
      return { hi, pos, ranked, sel, score: sumS(mwSetScore(hi, sel)) };
    });

    const byId = (p, id) => p.ranked.find(x => x.it.id == id);
    const has = (p, id) => p.sel.some(x => x.it.id == id);
    for (let round = 0, improved = true; improved && round < 50; round++) {
      improved = false;
      for (const p of P) {
        for (let i = 0; i < p.sel.length; i++) {
          const a = p.sel[i];
          // Thay a bằng món còn chỗ.
          for (const b of p.ranked) {
            if (!(left[b.it.id] > 0) || has(p, b.it.id)) continue;
            const sel = p.sel.map((x, k) => (k == i ? b : x));
            const sc = sumS(mwSetScore(p.hi, sel));
            if (sc > p.score + 1e-6) {
              left[a.it.id]++; left[b.it.id]--;
              Object.assign(p, { sel, score: sc });
              improved = true;
              break;
            }
          }
          const a2 = p.sel[i];
          // Đổi chéo a2 của p với món của tướng q.
          for (const q of P) {
            if (q == p || has(q, a2.it.id)) continue;
            const qa = byId(q, a2.it.id);
            if (!qa) continue;
            for (let j = 0; j < q.sel.length; j++) {
              const b = q.sel[j];
              const pb = byId(p, b.it.id);
              if (!pb || has(p, b.it.id)) continue;
              const selP = p.sel.map((x, k) => (k == i ? pb : x));
              const selQ = q.sel.map((x, k) => (k == j ? qa : x));
              const sp = sumS(mwSetScore(p.hi, selP)), sq = sumS(mwSetScore(q.hi, selQ));
              if (sp + sq > p.score + q.score + 1e-6) {
                Object.assign(p, { sel: selP, score: sp });
                Object.assign(q, { sel: selQ, score: sq });
                improved = true;
                break;
              }
            }
            if (p.sel[i] != a2) break;
          }
        }
      }
    }
    return P.map(({ hi, pos, ranked, sel }) => {
      const pick = mwSetScore(hi, sel).sort((a, b) => b.s - a.s);
      // Thứ tự đeo thật: các món đã chọn, rồi tới các món còn lại để thế chỗ khi server từ chối.
      const order = [...pick, ...ranked.filter(x => !sel.includes(x))];
      return { hi, pos, pick, order };
    });
  };
  const planText = plan => plan.map(({ hi, pick }) =>
    `## ${hi.h.name} (${hi.role}${hi.position ? ` — game ghi: ${hi.position}` : ''}, LC ${longVal(hi.h.fc)})\n` +
    `  đọc được: ${heroTraits(hi) || '-'}\n` +
    hi.talents.map(t => `  · thiên phú: ${t.length > 140 ? t.slice(0, 140) + '…' : t}\n`).join('') +
    pick.map(x => `  ${x.s.toFixed(2)} ${x.it.name} ★${x.it.star} [${x.it.tags.join(', ')}]`).join('\n')).join('\n');

  async function mwPreview() {
    const plan = await mwPlan();
    const total = plan.reduce((a, p) => a + sumS(p.pick), 0);
    const burn = plan.filter(p => p.hi.burn).length;
    return `PHƯƠNG ÁN (chưa đeo gì, điểm càng cao càng hợp) — tổng điểm đội ${total.toFixed(2)}` +
      `${burn ? `, đội có ${burn} tướng Thiêu Hồn` : ''}:\n` + planText(plan);
  }

  // Tháo hết pháp bảo của mọi tướng. Lưu lại trạng thái cũ vào localStorage của trang game để khôi phục.
  async function mwUnequipAll() {
    const { all } = mwHeroes();
    const backup = {};
    for (const h of all) {
      const list = (h.magic_weapon_list || []).map(w => ({ item_id: w.base_id, pos: w.pos }));
      if (!list.length) continue;
      backup[h.id] = list;
      NetMgr.gInst().sendMsg(32006, { hero_id: h.id, list });
      const r = await waitRecv(32006);
      if (!r || r.res != 1) log(`Tháo PB của ${h.name}: lỗi ${errText(r)}`);
      await sleep(200);
    }
    return backup;
  }
  const mwEquip = async (h, item_id, pos) => {
    NetMgr.gInst().sendMsg(32005, { hero_id: h.id, type: 1, list: [{ item_id, pos }] });
    const r = await waitRecv(32005);
    await sleep(200);
    return r && r.res == 1 ? null : errText(r);
  };

  async function mwOptimize() {
    stopFlag = false;
    await mwApplyPlan(await mwPlan());
  }

  // Tháo hết (lưu bản khôi phục) rồi đeo theo phương án.
  async function mwApplyPlan(plan) {
    const backup = await mwUnequipAll();
    try { localStorage.setItem('__tnMwBackup', JSON.stringify(backup)); } catch {}
    log(`Đã tháo pháp bảo của ${Object.keys(backup).length} tướng (đã lưu để khôi phục)`);
    const left = {};
    mwItems().forEach(it => (left[it.id] = it.cap));
    // Đeo lại theo thứ tự lực chiến; món bị server từ chối thì coi như hết chỗ, lấy món kế tiếp.
    for (const { hi, pos, order } of plan) {
      const got = [];
      let i = 0;
      for (const p of pos) {
        if (stopFlag) return log('Tối ưu PB: đã dừng');
        while (i < order.length) {
          const x = order[i++];
          if (!(left[x.it.id] > 0)) continue;
          const err = await mwEquip(hi.h, x.it.id, p);
          if (err) {
            left[x.it.id] = 0;
            log(`  ${hi.h.name}: không đeo được ${x.it.name} (${err}), bỏ qua món này`);
            continue;
          }
          left[x.it.id]--;
          got.push(`${x.it.name} (${x.s.toFixed(2)})`);
          break;
        }
      }
      log(`${hi.h.name} [${hi.role}]: ${got.join(', ') || '(không có món nào)'}`);
    }
    log('Tối ưu PB: xong. Muốn trả lại như cũ thì bấm "Khôi phục PB"');
  }

  // ---- Đo sức mạnh bằng đánh tháp ----
  // Kết quả trận 14002: result 1 thắng / 2 thua, round_list (mỗi hiệp 1 phần tử), max_round, role_list (group 1 = ta,
  // khác = địch; hero_list có hp_max), hero_stat (mỗi tướng: total_dmg, total_heal, is_die...).
  const fightStat = f => {
    const enemyHp = (f.role_list || []).filter(r => r.group != 1)
      .flatMap(r => r.hero_list || []).reduce((a, h) => a + longVal(h.hp_max), 0);
    const mine = (f.hero_stat || []).filter(s => s.group == 1);
    const dmg = mine.reduce((a, s) => a + longVal(s.total_dmg), 0);
    const win = f.result == 1;
    const rounds = (f.round_list || []).length || f.round || 0;
    const dmgPct = enemyHp ? Math.min(1, dmg / enemyHp) : 0;
    // Điểm trận: thua = tỉ lệ máu địch bị hạ (0–1); thắng = 1 + thưởng thắng nhanh (tối đa +0.5).
    const score = win ? 1 + 0.5 * (1 - rounds / (f.max_round || 10)) : dmgPct;
    return { win, rounds, dmgPct, score, heroes: mine.map(s => ({ name: s.name, dmg: longVal(s.total_dmg), heal: longVal(s.total_heal), die: !!s.is_die })) };
  };

  // Đánh ải tháp kế tiếp `times` lần (không tốn tài nguyên), trả về thống kê từng trận.
  // Thắng thì tháp lên tầng (địch mạnh hơn) — điểm theo % máu địch nên vẫn so được giữa các tầng gần nhau.
  async function benchTower(times) {
    const ctrl = DailyDungeonCtrl.gInst();
    const res = [];
    for (let n = 1; n <= times; n++) {
      if (stopFlag) break;
      ctrl.send11004(1);
      const info = await waitRecv(11004);
      if (!info || !info.max_pass_dungoen_id) { log('Đo: không lấy được thông tin tháp'); break; }
      const id = info.max_pass_dungoen_id + 1;
      await waitNotFighting();
      const fight = waitRecv(14002, 15000);
      ctrl.send11001(id, 0);
      const r = await waitRecv(11001, 10000);
      if (!r || r.res != 1) { log(`Đo: tầng ${id - 1010000} lỗi ${errText(r)}`); break; }
      const f = await fight;
      await sleep(800);
      await waitNotFighting();
      if (!f) continue;
      const st = fightStat(f);
      res.push(st);
      log(`  trận ${n}: tầng ${id - 1010000} ${st.win ? 'THẮNG' : 'thua'}, ${st.rounds} hiệp, hạ ${(st.dmgPct * 100).toFixed(1)}% máu địch`);
    }
    return res;
  }
  const fmtNum = v => (v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(0) + 'K' : String(Math.round(v)));
  const benchSummary = (label, res) => {
    if (!res.length) return { score: -1, text: `${label}: không có trận nào` };
    const avg = f => res.reduce((a, x) => a + f(x), 0) / res.length;
    const per = {};
    res.forEach(x => x.heroes.forEach(h => {
      const p = per[h.name] || (per[h.name] = { dmg: 0, heal: 0, die: 0 });
      p.dmg += h.dmg; p.heal += h.heal; p.die += h.die ? 1 : 0;
    }));
    const score = avg(x => x.score);
    return {
      score,
      text: `${label}: điểm ${score.toFixed(3)}, thắng ${res.filter(x => x.win).length}/${res.length}, ` +
        `hạ TB ${(avg(x => x.dmgPct) * 100).toFixed(1)}% máu địch, TB ${avg(x => x.rounds).toFixed(1)} hiệp\n` +
        Object.entries(per).map(([n, p]) =>
          `    ${n}: ST TB ${fmtNum(p.dmg / res.length)}${p.heal ? `, hồi TB ${fmtNum(p.heal / res.length)}` : ''}, chết ${p.die}/${res.length}`).join('\n'),
    };
  };

  // ---- Thử nghiệm bộ đồ bằng đánh tháp ----
  // Bộ đồ (cfg) = {heroId: [base_id theo thứ tự ô mở]} cho các tướng đội hình. Kết quả lưu ở localStorage của trang
  // game ('__tnMwLab'), gắn với đội hình + pháp bảo sở hữu (đổi đội/lên sao pháp bảo thì bắt đầu lại).
  const LAB_KEY = '__tnMwLab';
  const cfgKey = cfg => Object.keys(cfg).sort().map(id => `${id}:${cfg[id].slice().sort().join(',')}`).join('|');
  const labSig = () => {
    const hc = HeroCtrl.gInst();
    const team = (hc.szHeroList || []).map(x => x.id).sort().join(',');
    const items = Object.keys(hc.magicWeaponDic).sort().map(id => `${id}*${hc.magicWeaponDic[id]}`).join(',');
    return `${team}|${items}`;
  };
  const labLoad = () => {
    let lab = null;
    try { lab = JSON.parse(localStorage.getItem(LAB_KEY)); } catch {}
    return lab && lab.sig == labSig() ? lab : { sig: labSig(), results: [] };
  };
  const labSave = lab => { try { localStorage.setItem(LAB_KEY, JSON.stringify(lab)); } catch {} };

  const curConfig = () => {
    const hc = HeroCtrl.gInst();
    const cfg = {};
    for (const x of hc.szHeroList || []) {
      const h = hc.getHeroDataByHeroId(x.id) || x;
      cfg[h.id] = (h.magic_weapon_list || []).slice().sort((a, b) => a.pos - b.pos).map(w => w.base_id);
    }
    return cfg;
  };
  const itemName = id => (mwItems().find(it => it.id == id) || {}).name || id;

  // Đeo bộ đồ cfg: chỉ đụng tới tướng có thay đổi — tháo hết các tướng đó trước (trả chỗ), rồi đeo lại.
  async function applyConfig(cfg) {
    const hc = HeroCtrl.gInst();
    const cur = curConfig();
    const changed = Object.keys(cfg).filter(id => cur[id] && cfgKey({ x: cur[id] }) != cfgKey({ x: cfg[id] }));
    for (const id of changed) {
      const h = hc.getHeroDataByHeroId(Number(id));
      const list = (h.magic_weapon_list || []).map(w => ({ item_id: w.base_id, pos: w.pos }));
      if (!list.length) continue;
      NetMgr.gInst().sendMsg(32006, { hero_id: h.id, list });
      const r = await waitRecv(32006);
      if (!r || r.res != 1) log(`  tháo PB ${h.name}: lỗi ${errText(r)}`);
      await sleep(200);
    }
    for (const id of changed) {
      const h = hc.getHeroDataByHeroId(Number(id));
      const pos = openPos(h);
      for (let i = 0; i < cfg[id].length && i < pos.length; i++) {
        const err = await mwEquip(h, cfg[id][i], pos[i]);
        if (err) log(`  ${h.name}: không đeo được ${itemName(cfg[id][i])} (${err})`);
      }
    }
  }

  // Biến đổi 1 bước từ bộ đồ base: thay 1 món của 1 tướng bằng món khác trong top điểm luật của tướng đó (còn chỗ),
  // hoặc (30%) đổi chéo 2 món giữa 2 tướng. Trả về [cfg mới, mô tả].
  const mutate = (base, plan, caps) => {
    const cfg = {};
    for (const id in base) cfg[id] = base[id].slice();
    const used = {};
    Object.values(cfg).flat().forEach(id => (used[id] = (used[id] || 0) + 1));
    const P = plan.filter(p => cfg[p.hi.h.id] && cfg[p.hi.h.id].length);
    const rnd = a => a[Math.floor(Math.random() * a.length)];
    for (let attempt = 0; attempt < 100; attempt++) {
      if (Math.random() < 0.3 && P.length > 1) {
        const p = rnd(P), q = rnd(P.filter(x => x != p));
        const A = cfg[p.hi.h.id], B = cfg[q.hi.h.id];
        const i = Math.floor(Math.random() * A.length), j = Math.floor(Math.random() * B.length);
        if (A[i] == B[j] || A.includes(B[j]) || B.includes(A[i])) continue;
        const desc = `đổi ${itemName(A[i])} (${p.hi.h.name}) ↔ ${itemName(B[j])} (${q.hi.h.name})`;
        [A[i], B[j]] = [B[j], A[i]];
        return [cfg, desc];
      }
      const p = rnd(P), A = cfg[p.hi.h.id];
      const i = Math.floor(Math.random() * A.length);
      const cands = p.order.slice(0, 15).map(x => x.it.id).filter(id => !A.includes(id) && (used[id] || 0) < (caps[id] || 0));
      if (!cands.length) continue;
      const b = rnd(cands);
      const desc = `${p.hi.h.name}: ${itemName(A[i])} → ${itemName(b)}`;
      A[i] = b;
      return [cfg, desc];
    }
    return [null, ''];
  };

  // Điểm 1 lần thử = trung bình điểm trận: sát thương quy ra % máu địch (thua), thắng = 1 + thưởng thắng nhanh.
  async function mwLab(times = 10) {
    stopFlag = false;
    const hc = HeroCtrl.gInst();
    // Tướng ngoài đội hình đang giữ pháp bảo thì tháo ra để trả chỗ (lưu bản khôi phục trước).
    const teamIds = new Set((hc.szHeroList || []).map(x => x.id));
    const others = mwHeroes().all.filter(h => !teamIds.has(h.id) && (h.magic_weapon_list || []).length);
    const backup = {};
    mwHeroes().all.forEach(h => {
      const list = (h.magic_weapon_list || []).map(w => ({ item_id: w.base_id, pos: w.pos }));
      if (list.length) backup[h.id] = list;
    });
    try { localStorage.setItem('__tnMwBackup', JSON.stringify(backup)); } catch {}
    for (const h of others) {
      NetMgr.gInst().sendMsg(32006, { hero_id: h.id, list: h.magic_weapon_list.map(w => ({ item_id: w.base_id, pos: w.pos })) });
      await waitRecv(32006);
      await sleep(200);
    }
    if (others.length) log(`Tháo PB của ${others.length} tướng ngoài đội hình`);

    const plan = await mwPlan();
    const caps = {};
    mwItems().forEach(it => (caps[it.id] = it.cap));
    const planCfg = {};
    plan.forEach(p => (planCfg[p.hi.h.id] = p.pick.map(x => x.it.id)));
    const lab = labLoad();
    const tested = new Set(lab.results.map(r => cfgKey(r.cfg)));
    const queue = [[curConfig(), 'đồ hiện tại'], [planCfg, 'phương án của tool']];
    log(`Thử nghiệm: đã có ${lab.results.length} lần thử trước đó. Bấm "Dừng" để ngừng, "Xem tiến trình" để xem log.`);

    for (let iter = 1; !stopFlag; iter++) {
      let cfg, desc;
      while (queue.length && !cfg) {
        const [c, d] = queue.shift();
        if (!tested.has(cfgKey(c))) [cfg, desc] = [c, d];
      }
      for (let k = 0; !cfg && k < 30; k++) {
        const best = lab.results.reduce((a, r) => (!a || r.score > a.score ? r : a), null);
        const [c, d] = mutate(best ? best.cfg : planCfg, plan, caps);
        if (c && !tested.has(cfgKey(c))) [cfg, desc] = [c, d];
      }
      if (!cfg) return log('Thử nghiệm: không tạo được bộ đồ mới để thử');
      log(`== Lần ${lab.results.length + 1}: ${desc} ==`);
      await applyConfig(cfg);
      const res = await benchTower(times);
      if (res.length < times) { log('Thử nghiệm: chưa đủ trận, không lưu lần này'); break; }
      const s = benchSummary('Kết quả', res);
      const dmg = res.reduce((a, x) => a + x.heroes.reduce((b, h) => b + h.dmg, 0), 0) / res.length;
      lab.results.push({ cfg: curConfig(), desc, score: s.score, dmg, wins: res.filter(x => x.win).length, n: res.length, t: Date.now() });
      tested.add(cfgKey(cfg));
      tested.add(cfgKey(curConfig()));
      labSave(lab);
      const best = Math.max(...lab.results.map(r => r.score));
      log(`${s.text}\n  => điểm ${s.score.toFixed(3)}${s.score >= best ? ' (TỐT NHẤT)' : `, tốt nhất ${best.toFixed(3)}`}`);
    }
    log('Thử nghiệm: đã dừng. Bấm "Áp dụng tốt nhất" để đeo bộ có điểm cao nhất.');
  }

  const cfgText = cfg => {
    const hc = HeroCtrl.gInst();
    return Object.keys(cfg).map(id => `    ${(hc.getHeroDataByHeroId(Number(id)) || {}).name || id}: ${cfg[id].map(itemName).join(', ')}`).join('\n');
  };

  async function mwApplyBest() {
    const lab = labLoad();
    if (!lab.results.length) return log('Chưa có lần thử nào (với đội hình + pháp bảo hiện tại)');
    const top = lab.results.slice().sort((a, b) => b.score - a.score);
    log(`TOP ${Math.min(5, top.length)}/${top.length} lần thử:`);
    top.slice(0, 5).forEach((r, i) => log(`  ${i + 1}. điểm ${r.score.toFixed(3)}, ST TB ${fmtNum(r.dmg)}, thắng ${r.wins}/${r.n} — ${r.desc}`));
    log('Đeo bộ tốt nhất:\n' + cfgText(top[0].cfg));
    await applyConfig(top[0].cfg);
    log('Xong');
  }

  async function mwRestore() {
    let backup;
    try { backup = JSON.parse(localStorage.getItem('__tnMwBackup')); } catch {}
    if (!backup) return log('Khôi phục PB: không có bản lưu');
    await mwUnequipAll();
    const hc = HeroCtrl.gInst();
    for (const id of Object.keys(backup)) {
      const h = hc.getHeroDataByHeroId(Number(id));
      if (!h) continue;
      const fails = [];
      for (const w of backup[id]) {
        const err = await mwEquip(h, w.item_id, w.pos);
        if (err) fails.push(`${w.item_id}: ${err}`);
      }
      log(`Khôi phục ${h.name}: ${backup[id].length - fails.length}/${backup[id].length} món${fails.length ? ' — lỗi ' + fails.join('; ') : ''}`);
    }
  }

  // ---- Debug ----
  async function runCode(code) {
    const safe = (v, depth = 0, seen = new WeakSet()) => {
      if (v === null || typeof v !== 'object') return typeof v === 'function' ? '[fn]' : v;
      if (seen.has(v)) return '[circular]';
      if (depth > 4) return '[...]';
      seen.add(v);
      if (Array.isArray(v)) return v.slice(0, 200).map(x => safe(x, depth + 1, seen));
      const o = {};
      for (const k of Object.keys(v).slice(0, 200)) o[k] = safe(v[k], depth + 1, seen);
      return o;
    };
    try {
      let fn;
      try { fn = new Function(`return (${code});`); } catch { fn = new Function(code); }
      return { result: safe(await fn()) }; // await để xem được kết quả Promise (vd TN._.sleep(100))
    } catch (e) {
      return { error: String(e && e.stack || e) };
    }
  }

  function startRecord() {
    recLog = [];
    return 'Đang ghi... hãy thao tác trong game rồi bấm "Dừng & xem log"';
  }

  function stopRecord() {
    const entries = recLog || [];
    recLog = null;
    // Mảng dài chỉ giữ 2 phần tử đầu để log gọn, đủ thấy cấu trúc.
    // seen: gói tin không sao chép được (vòng tham chiếu) là object sống của game, duyệt không chặn sẽ treo.
    const safe = (v, depth = 0, seen = new WeakSet()) => {
      if (v === null || typeof v !== 'object') return typeof v === 'function' ? '[fn]' : v;
      if (seen.has(v)) return '[circular]';
      if (depth > 5) return '[...]';
      seen.add(v);
      if (Array.isArray(v)) {
        const a = v.slice(0, 2).map(x => safe(x, depth + 1, seen));
        if (v.length > 2) a.push(`+${v.length - 2}`);
        return a;
      }
      const o = {};
      for (const k of Object.keys(v).slice(0, 40)) {
        try { o[k] = safe(v[k], depth + 1, seen); } catch { o[k] = '[lỗi]'; }
      }
      return o;
    };
    const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
    const t0 = entries.length ? entries[0].t : 0;
    return entries.map(e => {
      const t = `+${((e.t - t0) / 1000).toFixed(1)}s`;
      let data;
      try { data = cut(JSON.stringify(safe(e.data)) || '', e.dir === 'SEND' ? 800 : 400); } catch (err) { data = `[không đọc được: ${err && err.message}]`; }
      const from = e.from ? ` <- ${e.from.slice(1, 3).join(' < ')}` : '';
      return `${t} ${e.dir} ${e.cmd}${from} ${data}`;
    }).join('\n') || '(log rỗng)';
  }

  // Về Đạo Thành như game (showCityView, gửi 11203). Ctrl chứa hàm này tìm qua prototype lần đầu rồi nhớ lại.
  let cityCtrl;
  const goCity = async () => {
    try {
      if (cityCtrl === undefined) {
        const k = Object.keys(window).find(k => {
          try { return /Ctrl$/.test(k) && window[k] && window[k].prototype && typeof window[k].prototype.showCityView == 'function'; } catch { return false; }
        });
        cityCtrl = k || null;
      }
      if (!cityCtrl) return;
      await waitNotFighting();
      window[cityCtrl].gInst().showCityView();
    } catch (e) { console.warn('[TN] không về được Đạo Thành', e); }
  };

  // ---- Job định kỳ ----
  // Mỗi `minutes` phút chạy JOB_STEPS. Đến giờ chỉ bật jobPending: nếu đang có hành động chạy, hành động đó
  // gọi jobGate() ở đầu mỗi vòng lặp (leo tháp, Đấu Tiên Đài...) -> chạy job xen giữa rồi đi tiếp đúng lần
  // đang dở (biến đếm vòng lặp giữ nguyên). Hành động không có jobGate thì job chạy khi hành động xong.
  // Đang rảnh thì job chạy ngay, log giữ ở jobLast (xem bằng TN.jobStatus()).
  // Trạng thái để ở window.__tnJob để nạp lại tn.js vẫn giữ lịch (hẹn lại từ đầu chu kỳ).
  const JOB_STEPS = [
    ['Cực Âm Địa', () => extremeYin()],
    ['Di tích 1 - Thu', () => ruinsGather()],
    ['Di tích 2 - Chiếm', () => kfRuins()],
  ];
  const job = window.__tnJob || (window.__tnJob = { minutes: 0, timer: null, next: 0, last: '' });
  // Log của lần chạy vừa kết thúc (hành động hoặc job lúc rảnh): popup mở lại vẫn xem được dòng cuối.
  const finishLog = () => {
    const text = takeLog();
    job.lastText = text;
    job.lastAt = Date.now();
    return text;
  };
  let busy = 0;
  let jobPending = false;
  let jobRunning = false;
  async function runJob() {
    if (jobRunning) return;
    jobRunning = true;
    jobPending = false;
    try {
      await waitNotFighting();
      log(`== Job ${new Date().toLocaleTimeString()} ==`);
      for (const [name, fn] of JOB_STEPS) {
        log(`-- ${name} --`);
        try { await fn(); } catch (e) { log(`LỖI job ${name}: ${(e && e.message) || e}`); }
        await waitNotFighting();
        await sleep(500);
      }
      // Về Đạo Thành để hành động đang dở (vd leo tháp) không bị kẹt ở màn hình Cực Âm/Di tích.
      await goCity();
      await sleep(1000);
      log('== Hết job, tiếp tục việc đang làm ==');
    } finally {
      jobRunning = false;
    }
  }
  const jobGate = async () => {
    if (jobPending && !jobRunning) await runJob();
  };
  function scheduleJob() {
    if (job.timer) bg.cancel(job.timer);
    job.timer = null;
    if (!job.minutes) return;
    job.next = Date.now() + job.minutes * 60000;
    job.timer = bg.later(onJobTimer, job.minutes * 60000);
  }
  async function onJobTimer() {
    job.timer = null;
    scheduleJob();
    jobPending = true;
    if (busy || jobRunning) return; // hành động đang chạy sẽ tự gọi job ở jobGate / khi xong
    out.length = 0; // lúc rảnh: log job bắt đầu từ đầu để popup hiện trực tiếp
    await runJob();
    await goCity();
    job.last = finishLog();
  }
  scheduleJob(); // nạp lại tn.js: hủy hẹn giờ cũ (closure cũ), hẹn lại nếu job đang bật
  function jobStatus() {
    if (!job.minutes) return `Job: đang tắt${job.last ? `\n--- Lần chạy gần nhất ---\n${job.last}` : ''}`;
    const left = Math.max(0, Math.round((job.next - Date.now()) / 60000));
    return `Job: bật, mỗi ${job.minutes} phút, lần tới lúc ${new Date(job.next).toLocaleTimeString()} (còn ~${left} phút)` +
      `${jobRunning ? '\nĐang chạy job' : jobPending ? '\nĐang chờ hành động hiện tại tới điểm dừng' : ''}` +
      `\nViệc: ${JOB_STEPS.map(s => s[0]).join(', ')}${job.last ? `\n--- Lần chạy gần nhất (lúc rảnh) ---\n${job.last}` : ''}`;
  }
  function jobStart(minutes = 30) {
    job.minutes = Math.max(1, Number(minutes) || 30);
    scheduleJob();
    return jobStatus();
  }
  function jobStop() {
    job.minutes = 0;
    jobPending = false;
    scheduleJob();
    return jobStatus();
  }

  // Bọc các hành động: chờ job đang chạy xong, chạy, chạy job nếu tới giờ trong lúc đó, về Đạo Thành,
  // trả log dạng text cho popup.
  const action = fn => async (...a) => {
    while (jobRunning) await sleep(500);
    busy++;
    try { await fn(...a); } catch (e) { log('LỖI: ' + (e && e.stack || e)); } finally { busy--; }
    if (jobPending) await runJob();
    await goCity();
    return finishLog();
  };

  // "Làm tất cả": chạy lần lượt mọi nhiệm vụ ngày (mỗi bước tự bỏ qua nếu đã xong), lỗi một bước không dừng
  // cả lượt. Việc nhanh trước, Đoạt Bách Tông (chờ hồi chiêu ~2 phút/lần) sau cùng, rồi nhận thưởng + rương.
  // floors / seconds: số tầng Cổ Thần Địa và số giây Ảo cảnh trận pháp lấy từ ô nhập trong popup.
  async function runAll(floors = 6, seconds = 15) {
    const steps = [
      ['Việc hằng ngày khác', dailyExtra],
      ['Tặng tình bạn', giftFriends],
      ['Cung phụng', guildFete],
      ['Viện trợ', guildHelp],
      ['Chiêu mộ', recruit],
      ['Đấu Tiên Đài', arena],
      ['Thủ Vệ Tứ Phái', endlessTrial],
      ['Bí Cảnh', guildDungeon],
      ['PB Ngày', dailyDungeon],
      ['Thông Thiên Tháp', tower],
      ['Tháp phái', campTowers],
      ['Tác chiến nhanh', quickFight],
      ['Kiếm Hành', dice],
      ['Vực U Minh', abyss],
      ['Tỉ Thí Thiên Đạo', kfLol],
      ['Chư Thiên Luận Đạo', chuThien],
      ['Thần Lâm Chiến', thanLam],
      ['Tiên duyên', tienDuyen],
      ['Ảo cảnh trận pháp', () => mirageMatch(seconds)],
      ['Cổ Thần Địa', () => ancientLand(floors)],
      ['Bách Phạt Tông', gldBoss],
      ['Đoạt Bách Tông', gldSnatch],
      ['Nhận thưởng', claimAll],
    ];
    stopFlag = false;
    for (const [name, fn] of steps) {
      if (stopFlag) return log('== Đã dừng ==');
      await jobGate();
      log(`== ${name} ==`);
      try {
        await fn();
      } catch (e) {
        log(`LỖI ${name}: ${(e && e.message) || e}`);
      }
      await waitNotFighting();
      await goCity();
      await sleep(500);
    }
    log('== Xong tất cả ==');
  }

  window.TN = {
    runAll: action(runAll),
    // Xem log của hành động đang chạy (không xóa), dùng khi tool có vẻ bị kẹt.
    peek: () => `${out.join('\n') || '(chưa có log)'}\n--- đang trong trận: ${isFighting()}, Worker hẹn giờ: ${bg.ok}`,
    readDailyTasks,
    claimAll: action(claimAll),
    giftFriends: action(giftFriends),
    dailyExtra: action(dailyExtra),
    arena: action(arena),
    arenaFight: action(times => {
      stopFlag = false;
      return arenaFight(times);
    }),
    guildFete: action(guildFete),
    guildHelp: action(guildHelp),
    recruit: action(recruit),
    endlessTrial: action(endlessTrial),
    guildDungeon: action(guildDungeon),
    travel: action(travel),
    dailyDungeon: action(dailyDungeon),
    tower: action(tower),
    quickFight: action(quickFight),
    dice: action(dice),
    gldBoss: action(gldBoss),
    gldSnatch: action(gldSnatch),
    abyss: action(abyss),
    towerClimb: action(towerClimb),
    campTowers: action(() => {
      stopFlag = false;
      return campTowers();
    }),
    dungeonFight: action(dungeonFight),
    listDungeonTypes,
    mwPreview,
    mwOptimize: action(mwOptimize),
    mwRestore: action(mwRestore),
    mwLab: action(mwLab),
    mwApplyBest: action(mwApplyBest),
    spiritHarvest: action(spiritHarvest),
    ruinsGather: action(ruinsGather),
    kfRuins: action(kfRuins),
    ruinsAll: action(ruinsAll),
    runAllRepeat: action(runAllRepeat),
    tienDuyen: action(() => {
      stopFlag = false;
      return tienDuyen();
    }),
    ancientLand: action(ancientLand),
    mirageMatch: action(mirageMatch),
    jobStart,
    jobStop,
    jobStatus,
    // Popup hỏi định kỳ để hiện log trực tiếp khi hành động/job đang chạy.
    liveState: () => ({
      busy: busy > 0 || jobRunning,
      log: out.join('\n'),
      last: job.lastText || '',
      lastAt: job.lastAt ? new Date(job.lastAt).toLocaleTimeString() : '',
      job: job.minutes
        ? `Job: bật, mỗi ${job.minutes} phút, lần tới ${new Date(job.next).toLocaleTimeString()}${jobRunning ? ' - ĐANG CHẠY' : jobPending ? ' - chờ tới lượt' : ''}`
        : 'Job: tắt',
    }),
    // Chạy job ngay: bật cờ chờ, action tự chạy job khi kết thúc.
    jobRunNow: action(() => { jobPending = true; }),
    kfLol: action(kfLol),
    chuThien: action(() => {
      stopFlag = false;
      return chuThien();
    }),
    thanLam: action(() => {
      stopFlag = false;
      return thanLam();
    }),
    forbiddenMountain: action(forbiddenMountain),
    kimThu: action(() => {
      stopFlag = false;
      return kimThu();
    }),
    uyChan: action(() => {
      stopFlag = false;
      return uyChan();
    }),
    hoaThu: action(() => {
      stopFlag = false;
      return hoaThu();
    }),
    thienThuan: action(() => {
      stopFlag = false;
      return thienThuan();
    }),
    tienNghich: action(() => {
      stopFlag = false;
      return tienNghich();
    }),
    tonHon: action(() => {
      stopFlag = false;
      return tonHon();
    }),
    vanHop: action(vanHop),
    ducAn: action(() => {
      stopFlag = false;
      return ducAn();
    }),
    maHai: action(() => {
      stopFlag = false;
      return maHai();
    }),
    tienDi: action(() => {
      stopFlag = false;
      return tienDi();
    }),
    runAllEvents: action(runAllEvents),
    uyenNhi: action(() => {
      stopFlag = false;
      return uyenNhi();
    }),
    nguHanh: action(() => {
      stopFlag = false;
      return nguHanh();
    }),
    hoaPham: action(() => {
      stopFlag = false;
      return hoaPham();
    }),
    guildWar: action(() => {
      stopFlag = false;
      return guildWar();
    }),
    luckyWheel: action(() => {
      stopFlag = false;
      return luckyWheel();
    }),
    extremeYin: action(extremeYin),
    stop: () => {
      stopFlag = true;
      return 'Đã gửi lệnh dừng, sẽ dừng sau trận đang đánh';
    },
    listBuffs,
    runCode,
    startRecord,
    stopRecord,
    // Lộ ra để debug qua ô "Chạy code".
    _: { waitRecv, sleep, longVal, getTask, taskCfg, taskRemain, isFighting },
  };
})();
