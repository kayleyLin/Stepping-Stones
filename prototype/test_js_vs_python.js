/* 一致性比对: JS 最小费用流的结果必须和 Python CP-SAT 的分层求解结果一致.
   跑法: node test_js_vs_python.js  */

const fs = require('fs');
const core = require('./app_core.js');

const topo = JSON.parse(fs.readFileSync('metro_topo.min.json', 'utf8'));
const ex = JSON.parse(fs.readFileSync('example_data.json', 'utf8'));

const engine = new core.MetroEngine(topo);

// ---- 通勤引擎校准: 与 Python metro.py 的输出逐条比对 ----
const pyMetro = [
  ['人民广场', '徐家汇', 12.6], ['陆家嘴', '静安寺', 10.8], ['国权路', '五角场', 2.4],
  ['人民广场', '虹桥火车站', 29.0], ['莘庄', '人民广场', 33.4], ['人民广场', '嘉定北', 63.6],
  ['上海火车站', '虹口足球场', 8.1], ['永德路', '殷高东路', 89.3],
  ['惠南', '紫竹高新区', 113.3], ['世纪公园', '港城路', 50.9],
  ['延安西路', '北新泾', 16.1], ['龙阳路', '上海火车站', 30.9],
];
let metroFail = 0;
for (const [a, b, expect] of pyMetro) {
  const r = engine.query(a, b);
  const got = r ? Math.round(r.min * 10) / 10 : null;
  if (got === null || Math.abs(got - expect) > 0.15) {
    console.log(`  ✗ ${a} -> ${b}: JS ${got} vs Python ${expect}`);
    metroFail++;
  }
}
console.log(`通勤引擎: ${pyMetro.length - metroFail}/${pyMetro.length} 条与 Python 一致`);

// ---- 清洗层 ----
const { vols, classes, warn } = core.cleanInput(engine, ex.vols, ex.sites);
console.log(`清洗层: 志愿者 ${vols.length}, 班级 ${classes.length}, ` +
  `ERROR ${warn.filter(w => w[0] === 'ERROR').length}, WARN ${warn.filter(w => w[0] === 'WARN').length}`);
for (const [lv, m] of warn) console.log(`  [${lv}] ${m}`);

// ---- 求解 ----
const res = core.solve(vols, classes, engine, {});
const sm = core.summarize(vols, classes, res.assign, res.pairs, res.feasCount, {});

// 表格顺序优先目标下的基准输出. totalMinutes 允许 1 分钟误差:
// JS 最小费用流与 Python CP-SAT 使用同一套三层目标, 具体人员可能因并列最优互换.
const py = { placed: 36, covered: 27, full: 9, unplaced: 4, totalMinutes: 934,
             avgMinutes: 25.9, maxMinutes: 61.7, overComfort: 1, zeroTransfer: 16 };
const TOL = { totalMinutes: 1.5 };
const s = sm.stat;
console.log('\n指标比对 (JS vs Python CP-SAT)');
let fail = 0;
for (const k in py) {
  const ok = Math.abs(s[k] - py[k]) < (TOL[k] || 0.3);
  if (!ok) fail++;
  console.log(`  ${ok ? '✓' : '✗'} ${k.padEnd(14)} JS ${String(s[k]).padStart(7)}   Python ${String(py[k]).padStart(7)}`);
}

// ---- 硬约束独立校验 ----
const V = new Map(vols.map(v => [v.id, v]));
const C = new Map(classes.map(c => [c.site + '-' + c.cls, c]));
const cnt = {}, per = {};
let hard = 0;
for (const a of res.assign) {
  const c = C.get(a.site + '-' + a.cls);
  if (!V.get(a.vol).slots.includes(c.slot)) { console.log(`  ✗ ${a.vol} 时段不匹配`); hard++; }
  const r = engine.bestPair(V.get(a.vol).stations, c.stations);
  if (Math.abs(r.min - a.minutes) > 0.15) { console.log(`  ✗ ${a.vol} 通勤时间重算不一致`); hard++; }
  cnt[a.vol] = (cnt[a.vol] || 0) + 1;
  per[a.site + '-' + a.cls] = (per[a.site + '-' + a.cls] || 0) + 1;
}
for (const v in cnt) if (cnt[v] > 1) { console.log(`  ✗ ${v} 被分配 ${cnt[v]} 个班`); hard++; }
for (const k in per) if (per[k] > C.get(k).need) { console.log(`  ✗ ${k} 超员`); hard++; }
if (res.assign.length + sm.gaps.reduce((a, g) => a + g.short, 0) !== s.needTotal) {
  console.log('  ✗ 名额不闭合'); hard++;
}
if (s.placed + s.unplaced !== vols.length) { console.log('  ✗ 人数不闭合'); hard++; }
console.log(`\n硬约束独立校验: ${hard === 0 ? '✓ 全部通过' : `✗ ${hard} 处问题`}`);

// ---- 人工锁定 ----
const locked = core.solve(vols, classes, engine, {}, { 'Vol 5': '3-class 1', 'Vol 99': '3-class 1' });
const l5 = locked.assign.find(a => a.vol === 'Vol 5');
console.log(`\n人工锁定: Vol 5 -> ${l5 ? l5.site + '-' + l5.cls : '未生效'} ` +
  `${l5 && l5.locked ? '(已标记为锁定)' : ''}`);
console.log(`  无效锁定被捕获: ${locked.lockWarn.length ? '✓ ' + locked.lockWarn[0] : '✗ 未捕获'}`);

process.exit(fail + hard + metroFail === 0 ? 0 : 1);
