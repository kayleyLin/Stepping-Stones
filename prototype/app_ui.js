/* ============================================================
   界面层. 逻辑全部来自 app_core.js, 这里只负责录入、调用、渲染.
   ============================================================ */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const VOL_COLS = [
  { k: 'id', label: '志愿者编号', w: 110, ph: 'Vol 1' },
  { k: 'station', label: '最近地铁站', w: 300, ph: '10号线 殷高东路   多个站用分号隔开' },
  { k: 'extraStation', label: '其他就近地铁站 / 换乘线路', w: 260, ph: '若还有其他就近地铁站或可换乘线路，请一并写明' },
  { k: 'slots', label: '可用时段', w: 320, ph: '周三下午; 周六上午' },
];
const SITE_COLS = [
  { k: 'site', label: '项目点编号', w: 100, ph: '1' },
  { k: 'station', label: '项目点地铁站', w: 260, ph: '10号线 港城路   多个站用分号隔开' },
  { k: 'cls', label: '班级', w: 100, ph: 'class 1' },
  { k: 'slot', label: '上课时段', w: 150, ph: '周六上午' },
  { k: 'need', label: '需要人数', w: 90, ph: '2' },
];

const state = {
  vols: [], sites: [], locks: [],
  aliases: Object.assign({}, CORE.STATION_ALIASES),
  params: Object.assign({}, CORE.PARAMS_DEFAULT),
  amapQps: 3,
  engine: null, provider: null, providerName: '离线估算（本地地铁拓扑）',
  result: null, summary: null, cleaned: null,
  amapCache: {},
};

/* ---------------- 本地保存 ----------------
   录入的数据和通勤缓存存在浏览器里, 刷新或关掉标签页都不会丢.
   高德 Key 不保存, 每次要重填, 免得明文留在共用电脑上.
   浏览器禁用存储时全部静默降级, 不影响任何功能.                       */

const STORE_KEY = 'puluoshi.allocation.v1';
let storeOK = true;
let persistTimer = null;

function persist() {
  if (!storeOK) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, at: Date.now(),
        vols: state.vols, sites: state.sites, locks: state.locks,
        aliases: state.aliases, params: state.params, amapQps: state.amapQps,
        amapCache: state.amapCache,
      }));
      showSaved();
    } catch (e) {
      storeOK = false;
      const el = $('#saveState');
      if (el) el.textContent = '浏览器不允许本地保存，数据仅存在当前页面';
    }
  }, 400);
}

function restore() {
  let raw = null;
  try { raw = localStorage.getItem(STORE_KEY); } catch (e) { storeOK = false; return false; }
  if (!raw) return false;
  try {
    const d = JSON.parse(raw);
    if (d.vols) state.vols = d.vols;
    if (d.sites) state.sites = d.sites;
    if (d.locks) state.locks = d.locks;
    if (d.aliases) state.aliases = d.aliases;
    if (d.params) state.params = Object.assign({}, CORE.PARAMS_DEFAULT, d.params);
    if (d.amapQps) state.amapQps = d.amapQps;
    if (d.amapCache) state.amapCache = d.amapCache;
    return { at: d.at, cache: Object.keys(state.amapCache).length };
  } catch (e) { return false; }
}

function clearStore() { try { localStorage.removeItem(STORE_KEY); } catch (e) { /* ignore */ } }

let savedTimer = null;
function showSaved() {
  const el = $('#saveState');
  if (!el) return;
  const n = Object.keys(state.amapCache).length;
  el.textContent = '已保存到本机' + (n ? `　通勤缓存 ${n} 条` : '');
  el.style.opacity = '1';
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => { el.style.opacity = '.45'; }, 1600);
}

/* ---------------- 表格 ---------------- */

function blankRow(cols) { const o = {}; for (const c of cols) o[c.k] = ''; return o; }

function renderTable(host, cols, rows, onChange) {
  const th = cols.map(c => `<th style="min-width:${c.w}px">${esc(c.label)}</th>`).join('');
  const body = rows.map((r, i) => '<tr>' + cols.map(c =>
    `<td><input data-r="${i}" data-k="${c.k}" value="${esc(r[c.k])}" placeholder="${esc(c.ph)}"></td>`
  ).join('') + `<td class="act"><button class="mini del" data-del="${i}" title="删除本行">✕</button></td></tr>`).join('');
  host.innerHTML = `<table class="grid"><thead><tr>${th}<th class="act"></th></tr></thead>
    <tbody>${body || `<tr><td colspan="${cols.length + 1}" class="empty">还没有数据。点上方「载入示例数据」或「上传 Excel」，也可以直接从 Excel 复制一片区域粘贴到这里。</td></tr>`}</tbody></table>`;

  host.oninput = e => {
    const t = e.target;
    if (t.tagName !== 'INPUT') return;
    rows[+t.dataset.r][t.dataset.k] = t.value;
    onChange(false);
  };
  host.onclick = e => {
    const b = e.target.closest('[data-del]');
    if (!b) return;
    rows.splice(+b.dataset.del, 1);
    onChange(true);
  };
  /* 从 Excel 直接粘贴一片区域 */
  host.onpaste = e => {
    const txt = (e.clipboardData || window.clipboardData).getData('text');
    if (!txt || !txt.includes('\t')) return;
    e.preventDefault();
    const t = e.target;
    const r0 = +t.dataset.r, c0 = cols.findIndex(c => c.k === t.dataset.k);
    const lines = txt.replace(/\r/g, '').split('\n').filter(l => l.trim() !== '');
    lines.forEach((line, di) => {
      const cells = line.split('\t');
      const ri = r0 + di;
      while (rows.length <= ri) rows.push(blankRow(cols));
      cells.forEach((val, dj) => {
        const ci = c0 + dj;
        if (ci < cols.length) rows[ri][cols[ci].k] = val.trim();
      });
    });
    onChange(true);
  };
}

function refresh(rebuild) {
  if (rebuild !== false) {
    renderTable($('#volTable'), VOL_COLS, state.vols, refresh);
    renderTable($('#siteTable'), SITE_COLS, state.sites, refresh);
  }
  $('#volCount').textContent = state.vols.filter(r => r.id || r.station).length;
  $('#siteCount').textContent = state.sites.filter(r => r.site || r.cls).length;
  renderLocks();
  renderAliases();
  liveCheck();
  persist();
}

/* 录入即校验, 不用等到点计算 */
function liveCheck() {
  const volRows = state.vols.map(r => [r.id, r.station, r.extraStation || r.transport, r.slots]);
  const siteRows = state.sites.map(r => [r.site, r.station, r.cls, r.slot, r.need]);
  if (!volRows.length && !siteRows.length) { $('#preflight').innerHTML = ''; return; }
  const c = CORE.cleanInput(state.engine, volRows, siteRows, state.aliases);
  state.cleaned = c;
  const err = c.warn.filter(w => w[0] === 'ERROR');
  const wrn = c.warn.filter(w => w[0] === 'WARN');
  const need = c.classes.reduce((s, x) => s + x.need, 0);
  let h = `<div class="pf">已识别 <b>${c.vols.length}</b> 名志愿者、<b>${c.classes.length}</b> 个班级、
    共 <b>${need}</b> 个名额。`;
  if (c.vols.length && need > c.vols.length * state.params.maxClassPerVolunteer)
    h += ` 每人只带 ${state.params.maxClassPerVolunteer} 个班，所以最多只能填满 <b>${c.vols.length}</b> 个名额，
      <b class="neg">结构性缺口 ${need - c.vols.length} 个</b>。`;
  h += '</div>';
  if (err.length) h += `<div class="msg err"><b>${err.length} 条错误，这些数据无法参与计算</b><ul>` +
    err.slice(0, 12).map(w => `<li>${esc(w[1])}</li>`).join('') +
    (err.length > 12 ? `<li>… 另有 ${err.length - 12} 条</li>` : '') + '</ul></div>';
  if (wrn.length) h += `<div class="msg warn"><b>${wrn.length} 条提醒，靠推断补上的，建议人工确认</b><ul>` +
    wrn.map(w => `<li>${esc(w[1])}</li>`).join('') + '</ul></div>';
  if (!err.length && !wrn.length) h += `<div class="msg ok">数据格式检查通过。</div>`;
  $('#preflight').innerHTML = h;
  $('#runBtn').disabled = !(c.vols.length && c.classes.length);
}

/* ---------------- 站名别名 ---------------- */

function renderAliases() {
  const rows = Object.entries(state.aliases).map(([k, v]) =>
    `<tr><td><code>${esc(k)}</code></td><td>${esc(v)}</td>
     <td class="act"><button class="mini del" data-al="${esc(k)}">✕</button></td></tr>`).join('');
  $('#aliasTable').innerHTML = `<table class="grid"><thead><tr>
    <th style="min-width:340px">原始写法（自动忽略大小写、空格、标点）</th>
    <th style="min-width:160px">对应地铁站</th><th class="act"></th></tr></thead>
    <tbody>${rows}</tbody></table>`;
  $('#aliasTable').onclick = e => {
    const b = e.target.closest('[data-al]');
    if (b) { delete state.aliases[b.dataset.al]; refresh(false); }
  };
}

/* ---------------- 人工锁定 ---------------- */

function renderLocks() {
  const opts = (state.cleaned ? state.cleaned.classes : [])
    .map(c => `${c.site}-${c.cls}`);
  const rows = state.locks.map((l, i) => `<tr>
    <td><input data-lk="${i}" data-f="vol" value="${esc(l.vol)}" placeholder="Vol 5"></td>
    <td><input data-lk="${i}" data-f="cls" value="${esc(l.cls)}" placeholder="3-class 1" list="clsList"></td>
    <td class="act"><button class="mini del" data-dellk="${i}">✕</button></td></tr>`).join('');
  $('#lockTable').innerHTML = `<datalist id="clsList">${opts.map(o => `<option value="${esc(o)}">`).join('')}</datalist>
    <table class="grid"><thead><tr><th style="min-width:140px">志愿者编号</th>
    <th style="min-width:200px">钉死到哪个班（项目点编号-班级）</th><th class="act"></th></tr></thead>
    <tbody>${rows || '<tr><td colspan="3" class="empty">没有锁定任何人。老志愿者想固定回原项目点的，在这里加一行。</td></tr>'}</tbody></table>`;
  $('#lockTable').oninput = e => {
    const t = e.target;
    if (t.dataset.lk !== undefined) state.locks[+t.dataset.lk][t.dataset.f] = t.value;
  };
  $('#lockTable').onclick = e => {
    const b = e.target.closest('[data-dellk]');
    if (b) { state.locks.splice(+b.dataset.dellk, 1); renderLocks(); }
  };
}

/* ---------------- 参数 ---------------- */

const PARAM_FIELDS = [
  ['maxClassPerVolunteer', '每人最多带几个班', '沟通中确认一学期只带一个班'],
  ['comfort', '单程舒适阈值（分钟）', '时段匹配时, 优先分配单程通勤时间更短的志愿者'],
  ['overagePenalty', '超时惩罚倍数', '超过单程舒适阈值的每分钟按几倍计入代价'],
];

function renderParams() {
  $('#params').innerHTML = PARAM_FIELDS.map(([k, label, help]) => `<label class="pf-row">
    <span class="pf-lb">${esc(label)}</span>
    <input type="number" step="any" data-p="${k}" value="${state.params[k]}">
    <span class="pf-hp">${esc(help)}</span></label>`).join('');
  $('#params').oninput = e => {
    const k = e.target.dataset.p;
    if (!k) return;
    const v = parseFloat(e.target.value);
    if (!isNaN(v)) { state.params[k] = v; liveCheck(); }
  };
}

/* ---------------- 通勤数据来源 ---------------- */

/* ============================================================
   ▼▼▼ 高德接口接入位 ▼▼▼

   走的是「Web端(JS API)」这条路: 加载高德 JS SDK, 用内置的 AMap.Transfer
   公交换乘插件查询. 原因是高德的「Web服务」类型 Key 面向企业/服务端场景,
   个人开发者账号通常申请不到, 只能创建「Web端(JS API)」类型的 Key.
   这种 Key 没法直接调 restapi.amap.com（会返回 INVALID_USER_KEY）,
   必须通过浏览器里的 JS SDK 使用.

   控制台: https://console.amap.com/dev/key/app
           创建应用 → 添加 Key → 服务平台选「Web端(JS API)」
           会同时生成一个「安全密钥」(securityJsCode), 两个都要填.
   插件文档: https://lbs.amap.com/api/javascript-api-v2/documentation#transfer

   重要: AMap.Transfer 返回的 result.plans[].segments[] 具体字段名,
   我没有真实浏览器环境可以核实, 是照着高德历史文档写的, 可能和当前
   SDK 版本的实际字段对不上。_isRailSegment 用了比较宽松的启发式匹配
   (对整段结果做正则)兜底, 但换乘次数的准确性需要你打开浏览器控制台
   核实一次: 计算时会把每个站对的原始 result 打印出来 (console.log
   前缀 "[高德原始返回]"), 麻烦复制几条给我核对字段。
   ============================================================ */

function loadAmapSDK(key, jscode) {
  return new Promise((res, rej) => {
    if (window.AMap && window.AMap.Transfer) return res();
    window._AMapSecurityConfig = { securityJsCode: jscode || '' };
    const s = document.createElement('script');
    s.src = `https://webapi.amap.com/maps?v=2.0&key=${encodeURIComponent(key)}&plugin=AMap.Transfer`;
    s.onload = () => (window.AMap && window.AMap.Transfer) ? res()
      : rej(new Error('SDK 已加载但 AMap.Transfer 插件不可用'));
    s.onerror = () => rej(new Error('SDK 脚本加载失败，检查网络，或 Key／安全密钥是否正确'));
    document.head.appendChild(s);
  });
}

/* 已知会一直失败、不该继续重试的错误关键词 */
const AMAP_FATAL_HINTS = [
  ['INVALID_USER_KEY', 'Key 无效'],
  ['INVALID_USER_SCODE', '安全密钥（securityJsCode）不对'],
  ['USERKEY_PLAT_NOMATCH', 'Key 的平台类型不对，请确认创建时选的是「Web端(JS API)」'],
  ['DAILY_QUERY_OVER_LIMIT', '今日调用量已达上限'],
  ['INSUFFICIENT_PRIVILEGES', 'Key 没有开通公交路径规划权限'],
  ['CUQPS_HAS_EXCEEDED_THE_LIMIT', '调用过于频繁'],
];

class AmapProvider {
  constructor(engine, cache) {
    this.engine = engine;
    this.cache = cache || {};
    this.transfer = null;   // run() 里等 SDK 加载完成后再赋值
    this.calls = 0; this.errors = []; this.abort = false;
    this.consecutiveFail = 0;
    this.debugSamples = 0;  // 只把前几条原始返回打进控制台, 不刷屏
  }
  ck(o, d) { return o + '>' + d; }

  _isRailSegment(seg) {
    /* 字段名未经真实环境验证, 用宽松匹配兜底: 只要这一段的原始数据里
       出现"地铁"或"号线"字样, 就算作一段轨道交通 */
    return /地铁|号线/.test(JSON.stringify(seg));
  }

  /* 单站对. 返回 {minutes, transfers, walk} 或 null */
  fetchPair(o, d) {
    const oc = this.engine.coord.get(o), dc = this.engine.coord.get(d);
    if (!oc || !dc) return Promise.resolve(null);
    return new Promise(resolve => {
      this.transfer.search(new AMap.LngLat(oc[0], oc[1]), new AMap.LngLat(dc[0], dc[1]),
        (status, result) => {
          this.calls++;
          if (this.debugSamples < 5) {
            this.debugSamples++;
            console.log(`[高德原始返回 ${this.debugSamples}/5] ${o} → ${d}`, status, result);
          }
          if (status !== 'complete' || !result || !result.plans || !result.plans.length) {
            const info = String((result && result.info) || status || '未知错误');
            this.errors.push(`${o} → ${d}: ${info}`);
            const hit = AMAP_FATAL_HINTS.find(([k]) => info.includes(k));
            this.consecutiveFail = hit ? 999 : this.consecutiveFail + 1;
            return resolve(null);
          }
          this.consecutiveFail = 0;
          const p = result.plans[0];
          let rail = 0;
          for (const seg of (p.segments || [])) if (this._isRailSegment(seg)) rail++;
          resolve({
            minutes: Math.round((p.time || 0) / 60 * 10) / 10,
            transfers: Math.max(0, rail - 1),
            walk: p.walking_distance || p.distance || 0,
          });
        });
    });
  }

  /* 求解器要求同步取值, 所以先把用得到的站对全部预取进缓存.
     连续失败达到阈值就中断整个流程, 不白跑几百次 */
  async prefetch(stationPairs, onProgress) {
    const todo = stationPairs.filter(([o, d]) => o !== d && !(this.ck(o, d) in this.cache));
    for (let i = 0; i < todo.length; i++) {
      if (this.abort) throw new Error('已取消');
      const [o, d] = todo[i];
      this.cache[this.ck(o, d)] = await this.fetchPair(o, d);
      onProgress(i + 1, todo.length, this.errors.length);
      if (this.consecutiveFail >= 5) {
        throw new Error(`连续 ${this.consecutiveFail} 次调用失败，最近一条：` +
          `${this.errors[this.errors.length - 1]}。已停止后续调用，避免浪费额度。`);
      }
      await sleep(150);
    }
    return { fetched: todo.length, total: stationPairs.length };
  }

  pair(origins, dests) {
    let best = null;
    for (const o of origins) for (const d of dests) {
      const v = (o === d) ? { minutes: 0, transfers: 0 } : this.cache[this.ck(o, d)];
      if (!v) continue;
      if (!best || v.minutes < best.min) best = { min: v.minutes, tr: v.transfers, from: o, to: d };
    }
    /* 高德没返回结果的站对退回离线估算, 并在报告里标注出来 */
    if (!best) { const r = this.engine.bestPair(origins, dests); if (r) { r.fallback = true; return r; } }
    return best;
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* 提交计算前先测一次, 一次调用就知道 Key／安全密钥能不能用,
   不用等跑完一整批才发现填错了 */
async function testAmapKey(key, jscode) {
  await loadAmapSDK(key, jscode);
  const transfer = new AMap.Transfer({ city: '上海', policy: AMap.TransferPolicy.LEAST_TIME });
  return new Promise(resolve => {
    // 人民广场 -> 徐家汇, 1 号线 4 站直达, 真实值大约 10~13 分钟
    transfer.search(new AMap.LngLat(121.469689, 31.231566), new AMap.LngLat(121.436220, 31.194637),
      (status, result) => {
        console.log('[高德原始返回] 测试 Key', status, result);
        if (status === 'complete' && result && result.plans && result.plans.length) {
          resolve({ ok: true, minutes: Math.round(result.plans[0].time / 60 * 10) / 10 });
        } else {
          resolve({ ok: false, info: String((result && result.info) || status) });
        }
      });
  });
}

/** 枚举求解真正需要的站对: 只算时段能匹配上的组合, 大幅减少 API 调用 */
function neededStationPairs(vols, classes) {
  const set = new Set(), out = [];
  for (const v of vols) for (const c of classes) {
    if (!v.slots.includes(c.slot)) continue;
    for (const o of v.stations) for (const d of c.stations) {
      const k = o + '>' + d;
      if (o !== d && !set.has(k)) { set.add(k); out.push([o, d]); }
    }
  }
  return out;
}

/* ---------------- 主流程 ---------------- */

async function run() {
  const btn = $('#runBtn');
  btn.disabled = true;
  const src = $('input[name=src]:checked').value;
  const prog = $('#progress');
  let note = '';

  try {
    const volRows = state.vols.map(r => [r.id, r.station, r.extraStation || r.transport, r.slots]);
    const siteRows = state.sites.map(r => [r.site, r.station, r.cls, r.slot, r.need]);
    const c = CORE.cleanInput(state.engine, volRows, siteRows, state.aliases);

    let provider = state.engine;
    state.providerName = '离线估算（本地地铁拓扑，精度约 ±15%）';

    if (src === 'amap') {
      const key = $('#amapKey').value.trim();
      const jscode = $('#amapCode').value.trim();
      if (!key) throw new Error('请先填入高德 Key');
      const pairs = neededStationPairs(c.vols, c.classes);
      const ap = new AmapProvider(state.engine, state.amapCache);

      prog.style.display = 'block';
      prog.textContent = '正在加载高德 JS SDK…';
      await loadAmapSDK(key, jscode);
      ap.transfer = new AMap.Transfer({ city: '上海', policy: AMap.TransferPolicy.LEAST_TIME });

      const cached = pairs.filter(([o, d]) => ap.ck(o, d) in ap.cache).length;
      prog.innerHTML = `共需要 ${pairs.length} 个站对，其中 ${cached} 个已有缓存，` +
        `本次要调用 ${pairs.length - cached} 次…`;
      $('#cancelBtn').style.display = 'inline-block';
      $('#cancelBtn').onclick = () => { ap.abort = true; };

      const t0 = Date.now();
      try {
        const r = await ap.prefetch(pairs, (i, n, errs) => {
          const eta = Math.round((Date.now() - t0) / i * (n - i) / 1000);
          prog.innerHTML = `正在调用高德公交换乘：<b>${i} / ${n}</b>` +
            `　剩余约 ${eta} 秒` + (errs ? `　已有 ${errs} 个站对没结果` : '');
          /* 每取一条就落盘, 中途出错也不会白跑 */
          if (i % 10 === 0) { state.amapCache = ap.cache; persist(); }
        });
        state.providerName = `高德公交换乘（本次新调用 ${r.fetched} 次，` +
          `缓存复用 ${r.total - r.fetched} 次）`;
      } finally {
        /* 无论成功、失败还是中途取消, 已经花掉的调用都要留住 */
        state.amapCache = ap.cache;
        persist();
        $('#cancelBtn').style.display = 'none';
        prog.style.display = 'none';
      }

      provider = ap;
      if (ap.errors.length) note = `高德有 ${ap.errors.length} 个站对没返回结果，这些已退回离线估算。` +
        `第一条：${ap.errors[0]}`;
    }

    const locks = {};
    for (const l of state.locks) if (l.vol && l.cls) locks[l.vol.trim()] = l.cls.trim();

    const res = CORE.solve(c.vols, c.classes, provider, state.params, locks);
    const sm = CORE.summarize(c.vols, c.classes, res.assign, res.pairs, res.feasCount, state.params);

    state.result = res; state.summary = sm; state.cleaned = c;
    renderResult(c, res, sm, note);
    const box = $('#resultCard');
    box.style.display = 'block';
    /* 滚动只是锦上添花, 浏览器不支持时绝不能让它变成一句「计算失败」 */
    try { box.scrollIntoView && box.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (_) { /* ignore */ }
  } catch (err) {
    prog.style.display = 'none';
    alert('计算失败：' + err.message);
    console.error(err);
  }
  btn.disabled = false;
}

/* ---------------- 结果渲染 ---------------- */

function tbl(headers, rows, numCols = [], rowClass) {
  const th = headers.map((h, i) => `<th class="${numCols.includes(i) ? 'n' : ''}">${esc(h)}</th>`).join('');
  const tb = rows.map((r, ri) => `<tr class="${rowClass ? rowClass(r, ri) : ''}">` + r.map((v, i) =>
    `<td class="${numCols.includes(i) ? 'n' : ''}">${typeof v === 'string' && v.startsWith('<') ? v : esc(v)}</td>`
  ).join('') + '</tr>').join('');
  return `<div class="restable"><div class="tablescroll">
    <table class="res"><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div></div>`;
}

const pill = (txt, kind) => `<span class="pill ${kind}">${esc(txt)}</span>`;

function renderResult(c, res, sm, note) {
  const s = sm.stat;
  const cards = [
    ['安置志愿者', `${s.placed} / ${s.volTotal}`],
    ['至少 1 人的班级', `${s.covered} / ${s.classTotal}`],
    ['配满的班级', `${s.full} / ${s.classTotal}`],
    ['未填补名额', s.shortSeats],
    ['平均单程通勤', s.avgMinutes + ' 分'],
    ['最长单程通勤', s.maxMinutes + ' 分'],
    [`超过 ${state.params.comfort} 分钟`, s.overComfort + ' 条'],
    ['零换乘', `${s.zeroTransfer} / ${s.placed}`],
  ];
  $('#cards').innerHTML = cards.map(([k, v]) =>
    `<div class="card"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('');

  let src = `<div class="msg ${state.providerName.startsWith('高德') ? 'ok' : 'warn'}">
    <b>通勤时间来源：${esc(state.providerName)}</b>`;
  if (!state.providerName.startsWith('高德'))
    src += `<br>离线估算的换乘惩罚是个固定值，而真实换乘时间在不同站差别很大。
      这个精度够判断结构性缺口，但正式排班前建议切到高德。`;
  src += '</div>';
  if (note) src += `<div class="msg warn">${esc(note)}</div>`;
  if (res.lockWarn.length) src += `<div class="msg err"><b>人工锁定有问题</b><ul>` +
    res.lockWarn.map(w => `<li>${esc(w)}</li>`).join('') + '</ul></div>';
  const fb = res.assign.filter(a => a.fallback).length;
  if (fb) src += `<div class="msg warn">其中 ${fb} 条分配的通勤时间是离线估算的。</div>`;
  $('#srcNote').innerHTML = src;

  const mx = Math.max(1, ...sm.slotRows.map(r => Math.max(r.demand, r.supply)));
  const barRow = (label, val, color) => `<div class="barrow">
    <span class="bar" style="width:${val / mx * 118}px;background:${color}"></span>
    <span>${label} ${val}</span></div>`;
  $('#tab-slot').innerHTML = `<p class="hint">差额为负的时段是真瓶颈，无论怎么排都填不满，只能定向招募；
    为正的时段志愿者过剩。这张表可以直接拿去指导下一期招募。</p>` +
    tbl(['时段', '需求名额', '可用志愿者', '差额', '已安置', '需求 / 供给'],
      sm.slotRows.map(r => [r.slot, r.demand, r.supply,
        `<span class="${r.gap < 0 ? 'neg' : 'pos'}">${r.gap > 0 ? '+' : ''}${r.gap}</span>`,
        r.placed,
        `<div class="barwrap">${barRow('需求', r.demand, 'linear-gradient(90deg,#E5686C,#DC2F35)')}
          ${barRow('可用', r.supply, 'linear-gradient(90deg,#3FC49A,#0E9F6E)')}</div>`]),
      [1, 2, 3, 4], r => (r[1] > r[2] ? 'hot' : ''));

  const cf = state.params.comfort;
  $('#tab-assign').innerHTML = `<p class="hint">共 ${res.assign.length} 条。
    <b>底色标黄</b>的是单程超过 ${cf} 分钟的，人工微调时重点看这几行。</p>` +
    tbl(['项目点', '班级', '时段', '志愿者', '单程分钟', '换乘', '起点站', '终点站', '候选起点站', '锁定'],
      res.assign.map(a => [a.site, a.cls, a.slot, a.vol, a.minutes.toFixed(1),
        a.transfers === 0 ? pill('直达', 'g') : pill(a.transfers + ' 次', a.transfers >= 2 ? 'a' : 'n'),
        a.from, a.to, a.transport, a.locked ? '是' : '']),
      [4], r => (parseFloat(r[4]) > cf ? 'hot' : ''));

  $('#tab-gap').innerHTML = `<p class="hint">共缺 ${sm.gaps.reduce((x, g) => x + g.short, 0)} 个名额，
    涉及 ${sm.gaps.length} 个班级。<b>「可行人数」为 0</b> 的班级是招募问题，不是排班能解决的。</p>` +
    tbl(['项目点', '班级', '时段', '地铁站', '缺口', '该时段可行人数', '说明'],
      sm.gaps.map(g => [g.site, g.cls, g.slot, g.station, g.short,
        g.feasible === 0 ? pill('0', 'r') : g.feasible, g.reason]),
      [4, 5], r => (r[5] && r[5].includes && r[5].includes('pill') ? 'hot' : ''));

  $('#tab-unplaced').innerHTML = `<p class="hint">共 ${sm.unplacedRows.length} 人。
    原因写「名额已被通勤更短的人占用」的，是供需问题而不是他们本身不合适。</p>` +
    tbl(['志愿者', '候选起点站', '可用时段', '原因'],
      sm.unplacedRows.map(u => [u.vol, u.station, u.slots, u.reason]));

  const back = c.classes.map(x => {
    const got = sm.byClass.get(x.site + '-' + x.cls) || [];
    return [x.site, x.cls, x.rawSlot || x.slot, x.need, got.join(', '),
      got.length < x.need ? '未配满，需人工处理' : ''];
  });
  $('#tab-back').innerHTML = `<p class="hint">这张表的列结构和原始 site info 一致，可以直接覆盖回填。
    <button class="mini" onclick="copyBackfill()">复制推荐列</button></p>` +
    tbl(['Serial number', 'Class number', 'Class time', 'number needed',
      'Volunteer recommendations', 'Other remarks'], back, [3],
      r => (r[5] ? 'hot' : ''));

  const err = c.warn.filter(w => w[0] === 'ERROR'), wrn = c.warn.filter(w => w[0] === 'WARN');
  $('#tab-warn').innerHTML = `<p class="hint">ERROR ${err.length} 条，WARN ${wrn.length} 条。
    每一条都对应一处可以在采集阶段用下拉选项或固定分隔符消除的格式问题。</p>` +
    (c.warn.length ? tbl(['级别', '说明'],
      c.warn.map(w => [w[0] === 'ERROR' ? pill('ERROR', 'r') : pill('WARN', 'a'), w[1]]))
      : '<p class="hint">无</p>');
}

function copyBackfill() {
  const c = state.cleaned, sm = state.summary;
  const txt = c.classes.map(x => (sm.byClass.get(x.site + '-' + x.cls) || []).join(', ')).join('\n');
  navigator.clipboard.writeText(txt).then(
    () => alert(`已复制 ${c.classes.length} 行推荐结果，可直接粘贴到 Excel 的 Volunteer recommendations 列。`),
    () => alert('复制失败，请手动从表格里选取。'));
}

/* ---------------- 导入导出 ---------------- */

function download(name, text, mime) {
  const b = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function toCSV(rows) {
  return '﻿' + rows.map(r => r.map(v => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\r\n');
}

function exportCSV() {
  const res = state.result, sm = state.summary, c = state.cleaned;
  if (!res) return alert('请先计算。');
  const rows = [['# 铺路石志愿者调配结果'], ['# 通勤数据来源', state.providerName], [],
    ['分配方案'], ['项目点', '班级', '时段', '志愿者', '单程分钟', '换乘', '起点站', '终点站', '候选起点站', '锁定']];
  for (const a of res.assign) rows.push([a.site, a.cls, a.slot, a.vol, a.minutes, a.transfers,
    a.from, a.to, a.transport, a.locked ? '是' : '']);
  rows.push([], ['未填补名额'], ['项目点', '班级', '时段', '地铁站', '缺口', '可行人数', '说明']);
  for (const g of sm.gaps) rows.push([g.site, g.cls, g.slot, g.station, g.short, g.feasible, g.reason]);
  rows.push([], ['未安置志愿者'], ['志愿者', '候选起点站', '可用时段', '原因']);
  for (const u of sm.unplacedRows) rows.push([u.vol, u.station, u.slots, u.reason]);
  rows.push([], ['时段供需'], ['时段', '需求', '可用', '差额', '已安置']);
  for (const r of sm.slotRows) rows.push([r.slot, r.demand, r.supply, r.gap, r.placed]);
  rows.push([], ['数据清洗告警'], ['级别', '说明']);
  for (const w of c.warn) rows.push([w[0], w[1]]);
  download('铺路石_分配结果.csv', toCSV(rows), 'text/csv;charset=utf-8');
}

function exportCache() {
  const n = Object.keys(state.amapCache).length;
  if (!n) return alert('还没有高德查询缓存。用高德数据源计算一次之后再导出。');
  download('高德通勤缓存.json', JSON.stringify(state.amapCache), 'application/json');
}

function importCache(file) {
  const fr = new FileReader();
  fr.onload = () => {
    try {
      Object.assign(state.amapCache, JSON.parse(fr.result));
      persist();
      alert(`已导入 ${Object.keys(state.amapCache).length} 条通勤缓存，这些站对不会再调用高德。`);
    } catch (e) { alert('缓存文件解析失败：' + e.message); }
  };
  fr.readAsText(file);
}

/* Excel 上传: 自动找 vol info / site info 两个工作表 */
function importXlsx(file) {
  if (typeof XLSX === 'undefined')
    return alert('Excel 解析库没加载成功（可能是离线打开的）。可以改用从 Excel 复制粘贴的方式录入。');
  const fr = new FileReader();
  fr.onload = () => {
    try {
      const wb = XLSX.read(new Uint8Array(fr.result), { type: 'array' });
      const pick = kw => wb.SheetNames.find(n => n.toLowerCase().replace(/\s/g, '').includes(kw));
      const vs = pick('vol') || wb.SheetNames[0];
      const ss = pick('site') || wb.SheetNames[1];
      const grid = n => XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, blankrows: false, defval: '' });

      const vgAll = grid(vs);
      const oldTransportCol = /transport|交通方式/.test(String((vgAll[0] || [])[2] || '').toLowerCase());
      const vg = vgAll.slice(1);
      state.vols = vg.filter(r => String(r[0] || '').trim()).map(r => ({
        id: String(r[0]).trim(), station: String(r[1] || '').replace(/\n/g, ' ; '),
        extraStation: oldTransportCol ? '' : String(r[2] || '').replace(/\n/g, ' ; '),
        slots: String(r[3] || '').replace(/┋/g, '; '),
      }));

      const sg = grid(ss).slice(1);
      let curSite = '', curSt = '';
      state.sites = [];
      for (const r of sg) {
        if (String(r[0] || '').trim()) { curSite = String(r[0]).trim(); curSt = String(r[1] || '').replace(/\n/g, ' ; '); }
        if (!String(r[2] || '').trim()) continue;
        state.sites.push({ site: curSite, station: curSt, cls: String(r[2]).trim(),
                           slot: String(r[3] || ''), need: String(r[4] || 2) });
      }
      refresh(true);
      alert(`已读入：志愿者 ${state.vols.length} 人（工作表「${vs}」），班级 ${state.sites.length} 个（工作表「${ss}」）。\n合并单元格已自动向下填充。`);
    } catch (e) { alert('Excel 解析失败：' + e.message); }
  };
  fr.readAsArrayBuffer(file);
}

function loadExample() {
  state.vols = EXAMPLE.vols.map(r => ({ id: r[0], station: r[1], extraStation: '',
                                        slots: String(r[3]).replace(/┋/g, '; ') }));
  state.sites = EXAMPLE.sites.map(r => ({ site: r[0], station: r[1], cls: r[2],
                                          slot: r[3], need: String(r[4]) }));
  refresh(true);
}

/* ---------------- 初始化 ---------------- */

function boot() {
  state.engine = new CORE.MetroEngine(TOPO, state.params);
  $('#topoInfo').textContent =
    `已内置上海地铁 ${TOPO.lines.length} 条线路、${state.engine.stationLines.size} 个站点`;

  const had = restore();
  renderParams();
  refresh(true);
  if (had) {
    const when = new Date(had.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit' });
    $('#saveState').textContent = `已恢复 ${when} 的数据` + (had.cache ? `　通勤缓存 ${had.cache} 条` : '');
    $('#saveState').style.opacity = '1';
  } else if (!storeOK) {
    $('#saveState').textContent = '浏览器不允许本地保存，数据仅存在当前页面';
  }

  $('#runBtn').onclick = run;
  $('#exampleBtn').onclick = loadExample;
  $('#clearBtn').onclick = () => {
    const n = Object.keys(state.amapCache).length;
    if (!confirm(`清空所有已录入的数据？\n\n通勤缓存${n ? `（${n} 条，是花了 API 额度换来的）` : ''}会保留，` +
      `不会浪费已经调用过的次数。`)) return;
    state.vols = []; state.sites = []; state.locks = [];
    $('#resultCard').style.display = 'none';
    refresh(true);
  };
  $('#clearCache').onclick = () => {
    const n = Object.keys(state.amapCache).length;
    if (!n) return alert('还没有通勤缓存。');
    if (!confirm(`清空 ${n} 条通勤缓存？下次计算需要重新调用高德，会消耗 API 额度。`)) return;
    state.amapCache = {};
    persist();
    alert('通勤缓存已清空。');
  };
  $('#addVol').onclick = () => { state.vols.push(blankRow(VOL_COLS)); refresh(true); };
  $('#addSite').onclick = () => { state.sites.push(blankRow(SITE_COLS)); refresh(true); };
  $('#addLock').onclick = () => { state.locks.push({ vol: '', cls: '' }); renderLocks(); };
  $('#addAlias').onclick = () => {
    const k = prompt('原始写法（例如 fengpu avenue）'); if (!k) return;
    const v = prompt('对应的地铁站中文名（例如 奉浦大道）'); if (!v) return;
    if (!state.engine.stationLines.has(v)) return alert(`网络里没有「${v}」这个站，请检查写法。`);
    state.aliases[k.toLowerCase().replace(/[^a-z一-鿿]/g, '')] = v;
    refresh(false);
  };
  $('#xlsxFile').onchange = e => e.target.files[0] && importXlsx(e.target.files[0]);
  $('#cacheFile').onchange = e => e.target.files[0] && importCache(e.target.files[0]);
  $('#exportCsv').onclick = exportCSV;
  $('#exportCache').onclick = exportCache;

  $$('input[name=src]').forEach(r => r.onchange = () => {
    $('#amapBox').style.display = $('input[name=src]:checked').value === 'amap' ? 'block' : 'none';
  });

  $('#testKeyBtn').onclick = async () => {
    const key = $('#amapKey').value.trim();
    const jscode = $('#amapCode').value.trim();
    const out = $('#amapTestResult');
    if (!key) { out.textContent = '请先填 Key'; out.className = 'testresult err'; return; }
    out.textContent = '测试中…（人民广场 → 徐家汇）';
    out.className = 'testresult';
    try {
      const r = await testAmapKey(key, jscode);
      if (r.ok) {
        out.textContent = `可以用。实测 ${r.minutes} 分钟（参考值 10~13 分钟）。` +
          '打开浏览器控制台能看到原始返回，方便核对字段。';
        out.className = 'testresult ok';
      } else {
        out.textContent = `不可用：${r.info}`;
        out.className = 'testresult err';
      }
    } catch (e) {
      out.textContent = `不可用：${e.message}`;
      out.className = 'testresult err';
    }
  };

  $$('.tabs').forEach(box => box.onclick = e => {
    const b = e.target.closest('[data-tab]');
    if (!b) return;
    box.querySelectorAll('[data-tab]').forEach(x => x.classList.toggle('on', x === b));
    const scope = box.dataset.scope;
    $$(`[data-panel][data-scope="${scope}"]`).forEach(p =>
      p.style.display = p.dataset.panel === b.dataset.tab ? 'block' : 'none');
  });
}

window.copyBackfill = copyBackfill;
document.addEventListener('DOMContentLoaded', boot);
