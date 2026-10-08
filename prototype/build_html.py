"""把 app_core.js / app_ui.js / 地铁拓扑 / 示例数据 打包成单文件 index.html.

app_core.js 是唯一的逻辑来源, 既被 index.html 内联, 也被 test_js_vs_python.js 引用,
所以界面里跑的和测试里验过的是同一份代码.
"""

import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))


def read(p):
    return open(os.path.join(HERE, p), encoding='utf-8').read()


CSS = None  # 见 style.css

BODY = """
<div class="wrap">
<div class="hero">
<h1>铺路石志愿者调配助手</h1>
<p class="sub">录入志愿者与班级数据，自动排出通勤总时长最短的分配方案。
<b>硬约束</b>是时段完全匹配、每人只带一个班、班级人数不超需求；
<b>优先级</b>是按上传表格里的教学点与班级顺序优先安排，再尽量配满，最后压通勤时间。</p>
</div>

<!-- ===== 1 数据 ===== -->
<div class="card-box">
  <div class="card-hd"><span class="step">1</span><h2>录入数据</h2>
    <span class="spacer"></span>
    <span class="savestate" id="saveState"></span>
    <label class="filelbl">上传 Excel<input type="file" id="xlsxFile" accept=".xlsx,.xls"></label>
    <button id="exampleBtn">载入 25 Spring 示例</button>
    <button id="clearBtn">清空</button>
  </div>
  <div class="card-bd">
    <p class="hint">三种录入方式任选：上传原始 Excel（自动识别 vol info / site info 两张表，
      合并单元格会向下填充）、从 Excel 复制一片区域直接粘贴到表格里、或者手工逐行填。
      时段可以写「周六上午」也可以写「Saturday morning」。地铁站多个用分号隔开；
      若还有其他就近地铁站，或最近站点可换乘的其他线路，请写在补充地铁站列。</p>
    <div class="tabs" data-scope="in">
      <button data-tab="vol" class="on">志愿者（<span id="volCount">0</span>）</button>
      <button data-tab="site">项目点与班级（<span id="siteCount">0</span>）</button>
      <button data-tab="alias">站名别名</button>
    </div>
    <div data-panel="vol" data-scope="in">
      <div class="toolbar"><button id="addVol">＋ 加一行</button></div>
      <div class="tablewrap" id="volTable"></div>
    </div>
    <div data-panel="site" data-scope="in" style="display:none">
      <div class="toolbar"><button id="addSite">＋ 加一行</button></div>
      <div class="tablewrap" id="siteTable"></div>
    </div>
    <div data-panel="alias" data-scope="in" style="display:none">
      <p class="hint">只填英文的站名、或者写法和官方站名不一致的，在这里建立对应关系。
        表里已经预置了三条来自 25 Spring 数据的映射。</p>
      <div class="toolbar"><button id="addAlias">＋ 加一条</button></div>
      <div class="tablewrap" id="aliasTable"></div>
    </div>
    <div id="preflight"></div>
  </div>
</div>

<!-- ===== 2 规则 ===== -->
<div class="card-box">
  <div class="card-hd"><span class="step">2</span><h2>规则参数</h2></div>
  <div class="card-bd">
    <p class="hint">默认值来自需求沟通记录，一般不用改。</p>
    <div id="params"></div>
  </div>
</div>

<!-- ===== 3 人工锁定 ===== -->
<div class="card-box">
  <div class="card-hd"><span class="step">3</span><h2>人工锁定（可选）</h2>
    <span class="spacer"></span><button id="addLock">＋ 加一条</button></div>
  <div class="card-bd">
    <p class="hint">已经想好去哪的老志愿者可以先钉死，他们和占用的名额会在计算前扣掉，
      模型只排剩下的人。如果锁定的组合本身时段不匹配或通勤超限，会报出来而不是默默接受。</p>
    <div class="tablewrap" id="lockTable"></div>
  </div>
</div>

<!-- ===== 4 通勤来源 ===== -->
<div class="card-box">
  <div class="card-hd"><span class="step">4</span><h2>通勤时间来源</h2>
    <span class="spacer"></span><span class="hint" id="topoInfo" style="margin:0"></span></div>
  <div class="card-bd">
    <label class="srcopt"><input type="radio" name="src" value="offline" checked><span class="t">本地估算（不需要 Key）</span>
      <div class="d">用内置的上海地铁拓扑算最短在途时间，换乘按固定惩罚计。
        和常识区间对比 12 组里 9 组吻合，精度约 ±15%。够判断结构性缺口，不够当正式排班依据。</div></label>
    <label class="srcopt"><input type="radio" name="src" value="amap"><span class="t">高德地图（真实换乘时间）</span>
      <div class="d">调高德公交路径规划，拿真实在途时间和换乘次数。
        两个站地理距离近但不同线时，实际换乘可能绕一大圈，只有真实路径规划能算准这个。</div></label>
    <div id="amapBox">
      <label>高德 Key
        <input type="text" id="amapKey" placeholder="在这里粘贴 Key" autocomplete="off" spellcheck="false"></label>
      <label>安全密钥（securityJsCode）
        <input type="text" id="amapCode" placeholder="创建 Key 时一起生成的安全密钥" autocomplete="off" spellcheck="false"></label>
      <div class="toolbar" style="margin:2px 0 12px">
        <button id="testKeyBtn" type="button">测试 Key</button>
        <span id="amapTestResult" class="testresult"></span>
      </div>
      <p class="hint" style="margin:2px 0 0">
        <b>Key 的类型。</b>在
        <a href="https://console.amap.com/dev/key/app" target="_blank" rel="noopener">高德控制台</a>
        创建应用后添加 Key，服务平台选 <code>Web端(JS API)</code>，会同时生成一个安全密钥，两个都要填。<br>
        高德的 <code>Web服务</code> 类型面向企业/服务端场景，个人开发者账号通常申请不到，
        所以这里走的是 <code>Web端(JS API)</code> 这条路：加载高德 JS SDK，用内置的
        <code>AMap.Transfer</code> 公交换乘插件查询。<br>
        <b>先点「测试 Key」</b>，一次调用就知道能不能用，不用等跑完一整批才发现填错了。<br>
        <b>Key 和安全密钥都不会被保存</b>，每次要重新填。录入的数据和通勤缓存会自动存在本机。<br>
        <b>调用量。</b>只查时段能匹配上的站对，40 人 30 班约 236 次。
        结果自动缓存，项目点站点固定不变，下学期只需为新增的志愿者站点补算。<br>
        连续失败会自动停下并说明原因，不会白跑几百次。个别站对查不到时退回本地估算，并在结果里标出来。<br>
        <b>字段名尚未用真实数据核实过</b>，浏览器控制台会打印前几条原始返回
        （<code>[高德原始返回]</code> 开头），如果换乘次数看起来不对，把控制台内容发给我核对。
      </p>
      <div class="toolbar" style="margin:14px 0 0">
        <button id="exportCache">导出通勤缓存</button>
        <label class="filelbl">导入通勤缓存<input type="file" id="cacheFile" accept=".json"></label>
        <button id="clearCache">清空通勤缓存</button>
      </div>
    </div>
  </div>
</div>

<!-- ===== 计算 ===== -->
<div class="card-box runcard"><div class="card-bd">
  <div class="runrow">
    <button class="primary" id="runBtn" disabled>开始计算</button>
    <button id="cancelBtn" style="display:none">取消</button>
    <span class="hint" style="margin:0">数据录入后按钮才会亮。40 人 30 班的规模，本地估算是瞬时的；
      走高德约需一分半，中途可以取消，已经调用过的不会浪费。</span>
  </div>
  <div id="progress"></div>
</div></div>

<!-- ===== 结果 ===== -->
<div class="card-box" id="resultCard" style="display:none">
  <div class="card-hd"><span class="step">5</span><h2>分配方案</h2>
    <span class="spacer"></span><button id="exportCsv">下载 CSV</button></div>
  <div class="card-bd">
    <div id="srcNote"></div>
    <div class="cards" id="cards"></div>
    <div class="tabs" data-scope="out">
      <button data-tab="assign" class="on">分配方案</button>
      <button data-tab="gap">未填补名额</button>
      <button data-tab="unplaced">未安置志愿者</button>
      <button data-tab="slot">时段供需</button>
      <button data-tab="back">回填格式</button>
      <button data-tab="warn">数据告警</button>
    </div>
    <div data-panel="assign" data-scope="out" id="tab-assign"></div>
    <div data-panel="gap" data-scope="out" id="tab-gap" style="display:none"></div>
    <div data-panel="unplaced" data-scope="out" id="tab-unplaced" style="display:none"></div>
    <div data-panel="slot" data-scope="out" id="tab-slot" style="display:none"></div>
    <div data-panel="back" data-scope="out" id="tab-back" style="display:none"></div>
    <div data-panel="warn" data-scope="out" id="tab-warn" style="display:none"></div>
  </div>
</div>

<div class="foot">
  求解方法：带凸费用弧的最小费用流，等价于「表格顺序覆盖率 → 安置人数 → 总通勤代价」三层字典序目标，
  结果是全局最优且可复现。已与 Python 版 CP-SAT 求解器在同一份数据上比对，三层目标值完全一致。<br>
  地铁拓扑数据来自高德地图公开接口快照，含 15、17、18 号线。<br>
  录入的数据与通勤缓存自动保存在本机浏览器，刷新不丢；高德 Key 不保存。<br>
  单文件离线可用。上传 Excel 需要联网加载解析库；如果离线打开，请用复制粘贴方式录入。
</div>
</div>
"""


def build():
    topo = json.load(open(os.path.join(HERE, 'metro_topo.min.json'), encoding='utf-8'))
    example = json.load(open(os.path.join(HERE, 'example_data.json'), encoding='utf-8'))
    css = read('style.css')
    core = read('app_core.js')
    ui = read('app_ui.js')

    # 去掉 core 尾部的 node 导出, 换成浏览器全局
    core = re.sub(r"if \(typeof module.*?\n\}\n?$", '', core, flags=re.S)
    exports = ['PARAMS_DEFAULT', 'ALL_SLOTS', 'STATION_ALIASES', 'MetroEngine', 'MinCostFlow',
               'cleanInput', 'solve', 'summarize', 'normSlot', 'normTransport',
               'splitStationTokens', 'resolveStations']
    core += '\nconst CORE = {' + ', '.join(exports) + '};\n'

    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>铺路石志愿者调配助手</title>
<script src="https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js"></script>
<style>{css}</style>
</head>
<body>
{BODY}
<script>
const TOPO = {json.dumps(topo, ensure_ascii=False, separators=(',', ':'))};
const EXAMPLE = {json.dumps(example, ensure_ascii=False, separators=(',', ':'))};
</script>
<script>
{core}
</script>
<script>
{ui}
</script>
</body>
</html>
"""
    out = os.path.join(HERE, 'index.html')
    open(out, 'w', encoding='utf-8').write(html)
    print(f'index.html  {len(html.encode())/1024:.0f} KB')
    return out


if __name__ == '__main__':
    build()
