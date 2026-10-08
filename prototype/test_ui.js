/* 用 jsdom 把 index.html 真跑一遍, 走完「载入示例 -> 校验 -> 计算 -> 渲染 -> 导出」
   整条交互路径. 目的是抓 DOM 选择器写错、事件没绑上、渲染函数崩掉这类问题.
   跑法: node test_ui.js  */

const fs = require('fs');
const { JSDOM } = require('jsdom');

let fails = 0;
const ok = (cond, label, extra) => {
  console.log(`  ${cond ? '✓' : '✗'} ${label}${extra ? '  ' + extra : ''}`);
  if (!cond) fails++;
};

const html = fs.readFileSync('index.html', 'utf8');
const vc = new (require('jsdom').VirtualConsole)();
// jsdom 不实现 blob 下载导航, 这类报错是环境限制不是代码问题
vc.on('jsdomError', e => {
  if (/navigation to another Document|Not implemented/.test(e.message)) return;
  console.log('  ✗ 页面脚本报错: ' + e.message); fails++;
});
vc.on('error', (...a) => console.log('  [console.error]', ...a));
const dom = new JSDOM(html, { runScripts: 'dangerously', url: 'http://localhost/', virtualConsole: vc });
const { window } = dom;
const doc = window.document;

// 剪贴板与弹窗打桩
let alerts = [];
window.alert = m => alerts.push(String(m));
window.confirm = () => true;
let downloads = [];
window.URL.createObjectURL = b => { downloads.push(b); return 'blob:stub'; };
window.URL.revokeObjectURL = () => {};

function main() {
  console.log('初始化');
  // 页面里的 CORE / TOPO 是顶层 const, 不会挂到 window 上, 要通过 window.eval 取
  const CORE = window.eval('CORE'), TOPO = window.eval('TOPO');
  ok(!!CORE && typeof CORE.solve === 'function', 'CORE 已注入');
  ok(!!TOPO && TOPO.lines.length === 24, '地铁拓扑已内嵌', `${TOPO.lines.length} 条线`);
  ok(doc.querySelector('#topoInfo').textContent.includes('416'), '拓扑信息已渲染',
    doc.querySelector('#topoInfo').textContent);
  ok(doc.querySelector('#runBtn').disabled === true, '空数据时计算按钮是禁用的');

  console.log('\n载入示例数据');
  doc.querySelector('#exampleBtn').click();
  const volInputs = doc.querySelectorAll('#volTable input');
  const siteInputs = doc.querySelectorAll('#siteTable input');
  ok(volInputs.length === 40 * 4, '志愿者表渲染出 40 行', `${volInputs.length} 个输入框`);
  ok(siteInputs.length === 30 * 5, '班级表渲染出 30 行', `${siteInputs.length} 个输入框`);
  ok(doc.querySelector('#volCount').textContent === '40', '志愿者计数正确');
  ok(doc.querySelector('#siteCount').textContent === '30', '班级计数正确');
  ok(doc.querySelector('#runBtn').disabled === false, '有数据后计算按钮解禁');

  const pf = doc.querySelector('#preflight').textContent;
  ok(pf.includes('40') && pf.includes('30') && pf.includes('60'), '录入即校验显示了人数班数名额');
  ok(pf.includes('结构性缺口 20'), '结构性缺口算对了');
  ok(pf.includes('5 条提醒'), '5 条 WARN 提示出来了');
  ok(!pf.includes('条错误'), '没有 ERROR');

  console.log('\n站名别名');
  ok(doc.querySelectorAll('#aliasTable tbody tr').length === 3, '预置了 3 条别名');

  console.log('\n改参数');
  const comfortInput = doc.querySelector('[data-p=comfort]');
  ok(!!comfortInput, '参数输入框已渲染');
  ok(doc.querySelectorAll('#params input').length === 3, '3 个参数字段');

  console.log('\n人工锁定界面');
  doc.querySelector('#addLock').click();
  ok(doc.querySelectorAll('[data-lk]').length === 2, '锁定行已加出来');
  ok(doc.querySelector('#clsList').children.length === 30, '班级下拉候选已填充');
  doc.querySelector('[data-dellk="0"]').click();
  ok(doc.querySelectorAll('[data-lk]').length === 0, '锁定行可以删掉');

  console.log('\n计算（本地估算，无锁定）');
  doc.querySelector('#runBtn').click();
  return new Promise(r => setTimeout(r, 400)).then(() => {
    ok(alerts.length === 0, '计算没有报错', alerts.join(' | '));
    ok(doc.querySelector('#resultCard').style.display === 'block', '结果区已显示');

    const cards = [...doc.querySelectorAll('#cards .card')].map(c =>
      c.querySelector('.k').textContent + '=' + c.querySelector('.v').textContent);
    ok(cards.length === 8, '8 张指标卡', cards.length + '');
    const placed = cards.find(x => x.startsWith('安置志愿者'));
    ok(placed === '安置志愿者=36 / 40', '安置人数与 Python 版一致', placed);
    ok(cards.find(x => x.startsWith('至少 1 人的班级')) === '至少 1 人的班级=27 / 30', '覆盖班级一致');

    const rows = doc.querySelectorAll('#tab-assign table.res tbody tr');
    ok(rows.length === 36, '分配明细 36 行', rows.length + '');
    const first = [...rows[0].querySelectorAll('td')].map(t => t.textContent);
    ok(first.length === 10, '分配明细 10 列');

    console.log('\n各结果页签都能渲染');
    for (const id of ['tab-assign', 'tab-gap', 'tab-unplaced', 'tab-slot', 'tab-back', 'tab-warn']) {
      const el = doc.querySelector('#' + id);
      ok(el && el.innerHTML.length > 60, id + ' 有内容', (el ? el.innerHTML.length : 0) + ' 字符');
    }
    ok(doc.querySelector('#tab-gap').textContent.includes('定向招募'),
      '缺口页解释了 0 可行人数的班级要靠招募');
    ok(doc.querySelector('#tab-slot').textContent.includes('周二上午'), '时段供需含周二上午');

    console.log('\n页签切换');
    doc.querySelector('[data-tab=gap]').click();
    ok(doc.querySelector('[data-panel=gap]').style.display === 'block', '切到缺口页');
    ok(doc.querySelector('[data-panel=assign]').style.display === 'none', '分配页已隐藏');

    console.log('\n导出');
    downloads = [];
    doc.querySelector('#exportCsv').click();
    ok(downloads.length === 1, 'CSV 导出触发了下载');
    alerts = [];
    doc.querySelector('#exportCache').click();
    ok(alerts.length === 1 && alerts[0].includes('还没有'), '没有高德缓存时给了提示', alerts[0]);

    console.log('\n人工锁定生效');
    doc.querySelector('#addLock').click();
    const lk = doc.querySelectorAll('[data-lk]');
    lk[0].value = 'Vol 5';
    lk[0].dispatchEvent(new window.Event('input', { bubbles: true }));
    lk[1].value = '3-class 1';
    lk[1].dispatchEvent(new window.Event('input', { bubbles: true }));
    alerts = [];
    doc.querySelector('#runBtn').click();
    return new Promise(r => setTimeout(r, 400));
  }).then(() => {
    ok(alerts.length === 0, '带锁定计算没有报错', alerts.join(' | '));
    const rows2 = [...doc.querySelectorAll('#tab-assign table.res tbody tr')];
    const v5 = rows2.find(r => r.querySelectorAll('td')[3].textContent === 'Vol 5');
    const cells = v5 ? [...v5.querySelectorAll('td')].map(t => t.textContent) : [];
    ok(v5 && cells[0] === '3' && cells[1] === 'class 1', 'Vol 5 被钉到 3-class 1',
      cells.slice(0, 4).join(' / '));
    ok(v5 && cells[9] === '是', '锁定行标了「是」');
    // Vol 5 原本在周日上午零通勤, 硬锁到人手过剩的周五晚上会挤掉只有该时段可用的人,
    // 所以总安置数下降 1 是正确行为而不是 bug
    const placed2 = [...doc.querySelectorAll('#cards .card')]
      .find(c => c.querySelector('.k').textContent === '安置志愿者').querySelector('.v').textContent;
    ok(placed2 === '35 / 40', '锁定造成的安置数下降符合预期', placed2);

    console.log('\n无效锁定会报出来');
    const lk2 = doc.querySelectorAll('[data-lk]');
    lk2[0].value = 'Vol 999';
    lk2[0].dispatchEvent(new window.Event('input', { bubbles: true }));
    alerts = [];
    doc.querySelector('#runBtn').click();
    return new Promise(r => setTimeout(r, 400));
  }).then(() => {
    ok(doc.querySelector('#srcNote').textContent.includes('找不到志愿者 Vol 999'),
      '不存在的志愿者编号被报出来而不是静默忽略');
    // 收拾干净, 继续后面的测试
    doc.querySelector('[data-dellk="0"]').click();

    console.log('\n高德数据源界面');
    const amapRadio = [...doc.querySelectorAll('input[name=src]')].find(r => r.value === 'amap');
    amapRadio.checked = true;
    amapRadio.dispatchEvent(new window.Event('change', { bubbles: true }));
    ok(doc.querySelector('#amapBox').style.display === 'block', '选高德后 Key 输入区展开');
    ok(!!doc.querySelector('#amapKey'), 'Key 输入框在');
    ok(!!doc.querySelector('#amapCode'), '安全密钥输入框在（Web端 JS API 需要）');
    ok(doc.querySelector('#amapBox').textContent.includes('Web端(JS API)'), '标明了 Key 类型要求');
    ok(!!doc.querySelector('#testKeyBtn'), '测试 Key 按钮在');
    alerts = [];
    doc.querySelector('#runBtn').click();
    return new Promise(r => setTimeout(r, 300));
  }).then(() => {
    ok(alerts.some(a => a.includes('Key')), '没填 Key 时给出明确报错', alerts.join(' | '));

    console.log('\n本地保存');
    const store = window.localStorage.getItem('puluoshi.allocation.v1');
    ok(!!store, 'localStorage 里已写入数据');
    const saved = JSON.parse(store || '{}');
    ok(saved.vols && saved.vols.length === 40, '志愿者数据已落盘', (saved.vols||[]).length + ' 行');
    ok(saved.sites && saved.sites.length === 30, '班级数据已落盘', (saved.sites||[]).length + ' 行');
    ok(!('amapKey' in saved) && !JSON.stringify(saved).includes('amapKey'), 'Key 没有被保存');
    ok(doc.querySelector('#saveState').textContent.includes('已保存'), '界面显示了保存状态',
      doc.querySelector('#saveState').textContent);

    console.log('\n粘贴录入');
    doc.querySelector('#clearBtn').click();
    ok(doc.querySelectorAll('#volTable input').length === 0, '清空生效');
    doc.querySelector('#addVol').click();
    const cell = doc.querySelector('#volTable input');
    ok(!!cell, '加行后出现输入框');
    const ev = new window.Event('paste', { bubbles: true });
    ev.clipboardData = { getData: () => 'V1\t10号线 五角场\t10号线 国权路\t周六上午\nV2\t2号线 陆家嘴\t\t周六上午' };
    cell.dispatchEvent(ev);
    ok(doc.querySelectorAll('#volTable input').length === 8, '粘贴出 2 行 4 列',
      doc.querySelectorAll('#volTable input').length + ' 个输入框');
    ok(doc.querySelector('#volCount').textContent === '2', '粘贴后计数更新');

    console.log(`\n${fails === 0 ? '✓ 全部通过' : '✗ ' + fails + ' 项失败'}`);
    process.exit(fails ? 1 : 0);
  });
}

// 不挂在 DOMContentLoaded 上跑, 否则测试自身的异常会被当成页面脚本错误
setTimeout(() => { main().catch(e => { console.log('  ✗ 测试异常: ' + e.stack); process.exit(1); }); }, 120);
