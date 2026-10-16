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

  // NV 4: Đấu Tiên Đài — đánh đủ số trận còn thiếu, chọn đối thủ lực chiến thấp nhất.
  async function arena() {
    const need = taskRemain(4);
    if (!need) return log('Đấu Tiên Đài: nhiệm vụ đã đủ');
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
      await waitNotFighting();
      ctrl.reqChnlgeEmy(enemy.order, enemy.id);
      const r = await waitRecv(14202, 10000);
      if (!r || r.res != 1) return log(`Đấu Tiên Đài trận ${n}: lỗi ${errText(r)}`);
      log(`Đấu Tiên Đài trận ${n}/${need}: đánh ${enemy.name} (LC ${longVal(enemy.fc)}) - xong`);
      await sleep(1500);
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

  // NV 6: Thông Thiên Tháp (DailyDungeon type 1) — quét tầng cao nhất đã qua bằng lượt miễn phí; thiếu thì
  // mua lượt + quét (11007 type 2, game tự gửi lệnh quét), chỉ đủ nhiệm vụ và giá <= MAX_BUY_GOLD Tiên Ngọc.
  async function tower() {
    const MAX_BUY_GOLD = 20;
    const TOWER = 1;
    const need = taskRemain(6);
    if (!need) return log('Thông Thiên Tháp: nhiệm vụ đã đủ');
    const ctrl = DailyDungeonCtrl.gInst();
    for (let n = 1; n <= need; n++) {
      ctrl.send11004(TOWER);
      const info = await waitRecv(11004);
      if (!info || !info.max_pass_dungoen_id) return log('Thông Thiên Tháp: không lấy được thông tin (chưa qua tầng nào?)');
      const id = info.max_pass_dungoen_id;
      const free = ctrl.gDgnTypeCfg(TOWER).count - info.enter_count;
      let how;
      if (free > 0) {
        ctrl.send11005(id);
        how = `quét (còn ${free - 1} lượt miễn phí)`;
      } else {
        if (!(info.total_buy_count > info.buy_count)) return log(`Thông Thiên Tháp: hết lượt và hết lượt mua, còn thiếu ${need - n + 1} lần`);
        const item = (ctrl.getDungeonDataList(TOWER) || []).find(x => x.dungeon_baseVo && x.dungeon_baseVo.dungeon_id == id);
        const cost = item ? item.cost_money : undefined;
        if (cost == null) return log('Thông Thiên Tháp: hết lượt, không đọc được giá mua nên không mua');
        if (cost > MAX_BUY_GOLD) return log(`Thông Thiên Tháp: hết lượt, mua thêm giá ${cost} Tiên Ngọc > giới hạn ${MAX_BUY_GOLD}, còn thiếu ${need - n + 1} lần`);
        ctrl.send11007(id, TOWER, 2);
        const b = await waitRecv(11007);
        if (!b || b.res != 1) return log(`Thông Thiên Tháp: mua lượt lỗi ${errText(b)}`);
        how = `mua lượt (${cost} Tiên Ngọc) + quét`;
      }
      const r = await waitRecv(11005);
      if (!r || r.res != 1) return log(`Thông Thiên Tháp tầng ${id} lần ${n}: lỗi ${errText(r)}`);
      log(`Thông Thiên Tháp tầng ${id} lần ${n}/${need}: ${how} - OK`);
      await sleep(400);
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

  // Leo Thông Thiên Tháp: đánh tầng kế tiếp (max_pass + 1) `times` lần, thua thì đánh lại, thắng thì lên tầng.
  // Đánh không tốn tài nguyên. Dừng giữa chừng bằng TN.stop().
  async function towerClimb(times = 20) {
    const ctrl = DailyDungeonCtrl.gInst();
    stopFlag = false;
    let win = 0;
    for (let n = 1; n <= times; n++) {
      if (stopFlag) return log(`Leo tháp: đã dừng sau ${n - 1} lần (thắng ${win})`);
      ctrl.send11004(1);
      const info = await waitRecv(11004);
      if (!info || !info.max_pass_dungoen_id) return log('Leo tháp: không lấy được thông tin');
      const id = info.max_pass_dungoen_id + 1;
      const floor = id - 1010000; // dungeon_id tháp = 1010000 + số tầng (vd 1011692 = tầng 1692)
      await waitNotFighting();
      const fight = waitRecv(14002, 10000); // kết quả trận: result 1 = thắng, 2 = thua
      ctrl.send11001(id, 0);
      const r = await waitRecv(11001, 10000);
      if (!r || r.res != 1) return log(`Leo tháp lần ${n}: tầng ${floor} lỗi ${errText(r)}`);
      const f = await fight;
      const won = f && f.result == 1;
      if (won) win++;
      log(`Lần ${n}: tầng ${floor} - ${won ? 'thắng' : 'thua'}`);
      await sleep(800);
      await waitNotFighting();
    }
    log(`Leo tháp: xong ${times} lần, thắng ${win}`);
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
    const safe = (v, depth = 0) => {
      if (v === null || typeof v !== 'object') return typeof v === 'function' ? '[fn]' : v;
      if (depth > 5) return '[...]';
      if (Array.isArray(v)) {
        const a = v.slice(0, 2).map(x => safe(x, depth + 1));
        if (v.length > 2) a.push(`+${v.length - 2}`);
        return a;
      }
      const o = {};
      for (const k of Object.keys(v).slice(0, 40)) o[k] = safe(v[k], depth + 1);
      return o;
    };
    const cut = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
    const t0 = entries.length ? entries[0].t : 0;
    return entries.map(e => {
      const t = `+${((e.t - t0) / 1000).toFixed(1)}s`;
      const data = cut(JSON.stringify(safe(e.data)), e.dir === 'SEND' ? 800 : 400);
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
    dice: action(dice),
    gldSnatch: action(gldSnatch),
    abyss: action(abyss),
    towerClimb: action(towerClimb),
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
