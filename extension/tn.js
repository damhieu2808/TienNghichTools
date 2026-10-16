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

  // NV 4: Đấu Tiên Đài — đánh đủ ARENA_DAILY trận/ngày (nhiều hơn mức 3 của nhiệm vụ), chọn đối thủ lực chiến
  // thấp nhất. Server không cho biết số trận hôm nay nên lấy max(tiến độ nhiệm vụ, số trận tool đã đánh hôm nay);
  // tiến độ nhiệm vụ có thể dừng ở 3 nên tool tự đếm trong localStorage của game.
  const ARENA_DAILY = 5;
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
    const ctrl = ArenaCtrl.gInst();
    for (let n = 1; n <= need; n++) {
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

  // NV 16: Kiếm Hành (DiceCtrl) — đổ xúc xắc tới khi chặng đạt 100%. Như clickDice của game: dùng lượt
  // miễn phí, hết thì dùng xúc xắc nếu đủ; thiếu xúc xắc thì dừng (game sẽ mở bảng mua bằng Tiên Ngọc).
  async function dice() {
    const ctrl = DiceCtrl.gInst();
    ctrl.sd20501();
    if (!(await waitRecv(20501))) return log('Kiếm Hành: không lấy được thông tin');
    for (let n = 1; n <= 60; n++) {
      const dt = ctrl.infoDt;
      if (!dt) return log('Kiếm Hành: không có dữ liệu');
      if (dt.percent >= 100) return log(`Kiếm Hành: chặng đã đạt 100% (đổ ${n - 1} lần)`);
      let how;
      if (dt.freeTimes > 0) {
        how = `miễn phí (còn ${dt.freeTimes - 1})`;
      } else {
        const have = PropsCtrl.gInst().findGoodsNum(ctrl.getInfoByKey('dice_id'));
        const cost = ctrl.getCostCfg(dt.buyTimes + 1);
        const needNum = cost ? cost.quantity : 0;
        if (!cost || have < needNum) return log(`Kiếm Hành: hết lượt miễn phí và hết xúc xắc (có ${have}, cần ${needNum}), dừng ở ${dt.percent}% sau ${n - 1} lần đổ`);
        how = `dùng ${needNum} xúc xắc (còn ${have - needNum})`;
      }
      ctrl.sd20502();
      const r = await waitRecv(20502);
      if (!r || r.res != 1) return log(`Kiếm Hành lần ${n}: lỗi ${errText(r)}`);
      log(`Kiếm Hành lần ${n}: ${how}, được ${r.point} điểm, tiến độ ${r.percent}%`);
      await sleep(1500);
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
    for (let n = 1; n <= times; n++) {
      if (stopFlag) return log(`${label}: đã dừng sau ${n - 1} lần (thắng ${win})`);
      ctrl.send11004(type);
      const info = await waitRecv(11004);
      if (!info) return log(`${label}: không lấy được thông tin`);
      const id = (info.max_pass_dungoen_id || base) + 1;
      const stage = id - base;
      await waitNotFighting();
      const fight = waitRecv(14002, 10000); // kết quả trận: result 1 = thắng, 2 = thua
      ctrl.send11001(id, 0);
      const r = await waitRecv(11001, 10000);
      if (!r || r.res != 1) return log(`${label} lần ${n}: ${unit} ${stage} lỗi ${errText(r)}`);
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

  // Khiêu chiến phó bản ngày theo type: 2 Linh Thạch, 3 EXP, 4 Tu Sĩ, 5 Pháp Bảo (tên lấy từ config).
  const dungeonFight = (type, times = 20) =>
    dungeonClimb(type, times, (DailyDungeonCtrl.gInst().gDgnTypeCfg(type) || {}).name || `PB loại ${type}`);

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
  async function extremeYin() {
    const ctrl = ExtremeYinCtrl.gInst();
    const builds = ctrl.getCurlModel().getBuildConfig();
    const me = RoleCtrl.gInst().getRoleInfo();
    const myFc = longVal(me.fc);
    const maxFc = Math.floor(myFc * YIN_FC_RATIO);
    const name = id => (builds[id] && builds[id].name) || `địa điểm ${id}`;
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

    let st = await status();
    log(`Cực Âm: đang ở ${name(st.landId)}${st.seated ? ' (đang tu luyện)' : ' (chưa có chỗ)'}, lực chiến ${myFc}`);
    const ids = Object.keys(builds).map(Number).sort((a, b) => a - b);
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

  // Bọc các hành động: chạy rồi trả về log dạng text cho popup.
  const action = fn => async (...a) => {
    try { await fn(...a); } catch (e) { log('LỖI: ' + (e && e.stack || e)); }
    return takeLog();
  };

  // "Làm tất cả": chạy lần lượt mọi nhiệm vụ ngày (mỗi bước tự bỏ qua nếu đã xong), lỗi một bước không dừng
  // cả lượt. Việc nhanh trước, Đoạt Bách Tông (chờ hồi chiêu ~2 phút/lần) sau cùng, rồi nhận thưởng + rương.
  async function runAll() {
    const steps = [
      ['Tặng tình bạn', giftFriends],
      ['Cung phụng', guildFete],
      ['Viện trợ', guildHelp],
      ['Chiêu mộ', recruit],
      ['Đấu Tiên Đài', arena],
      ['Thủ Vệ Tứ Phái', endlessTrial],
      ['Bí Cảnh', guildDungeon],
      ['Treo Thưởng', travel],
      ['PB Ngày', dailyDungeon],
      ['Thông Thiên Tháp', tower],
      ['Tác chiến nhanh', quickFight],
      ['Kiếm Hành', dice],
      ['Vực U Minh', abyss],
      ['Đoạt Bách Tông', gldSnatch],
      ['Nhận thưởng', claimAll],
    ];
    stopFlag = false;
    for (const [name, fn] of steps) {
      if (stopFlag) return log('== Đã dừng ==');
      log(`== ${name} ==`);
      try {
        await fn();
      } catch (e) {
        log(`LỖI ${name}: ${(e && e.message) || e}`);
      }
      await waitNotFighting();
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
    arena: action(arena),
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
    gldSnatch: action(gldSnatch),
    abyss: action(abyss),
    towerClimb: action(towerClimb),
    dungeonFight: action(dungeonFight),
    listDungeonTypes,
    mwPreview,
    mwOptimize: action(mwOptimize),
    mwRestore: action(mwRestore),
    mwLab: action(mwLab),
    mwApplyBest: action(mwApplyBest),
    spiritHarvest: action(spiritHarvest),
    kfLol: action(kfLol),
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
