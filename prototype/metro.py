"""上海地铁通勤时间引擎.

数据源: 高德地图公开地铁拓扑 JSON (sh_metro_raw.json)
  https://map.amap.com/service/subway?srhdata=3100_drw_shanghai.json

本模块给出「在地铁里的时间」的离线估算, 不是高德实时公交路径规划的返回值.
估算方式: 站间距离按经纬度直线距离折算, 除以平均运行速度, 加停站时间; 换乘按固定惩罚计.
接入高德 API 后, 只需替换 TravelTimeEngine.query 一个方法, 其余代码不变.
"""

import json
import math
import re
from heapq import heappush, heappop
from collections import defaultdict

# ---- 可调参数 ----
# 速度随站间距递增: 市区站距短则慢, 郊区快线站距长则快.
# v(km/h) = min(V_MAX, V_BASE + V_SLOPE * 站间距km)
V_BASE = 29.0
V_SLOPE = 8.0
V_MAX = 78.0
DWELL_MIN = 0.5          # 每站停站时间
DIST_DETOUR = 1.13       # 直线距离到实际轨道距离的折算系数
TRANSFER_MIN = 5.5       # 跨线换乘: 站内步行 + 候车
BRANCH_TRANSFER_MIN = 1.5  # 同线不同支线之间的衔接


def segment_minutes(km):
    v = min(V_MAX, V_BASE + V_SLOPE * km)
    return km / v * 60 + DWELL_MIN


def haversine(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    R = 6371.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(h))


def norm_station(name):
    """站名归一化: 去空格与括号内容. 注意不能剥离尾字「站」,
    否则「上海火车站」「虹桥火车站」「上海西站」会被破坏."""
    s = str(name).strip()
    s = re.sub(r'[（(].*?[)）]', '', s)
    return s.replace(' ', '').replace('　', '')


def name_variants(s):
    """生成候选写法: 原样、去尾「站」、加尾「站」."""
    out = [s]
    if len(s) > 3 and s.endswith('站') and not s.endswith('火车站'):
        out.append(s[:-1])
    else:
        out.append(s + '站')
    return out


class TravelTimeEngine:
    def __init__(self, json_path):
        raw = json.load(open(json_path, encoding='utf-8'))
        self.lines = []                    # [{key, no, label, stations:[(name, lonlat)]}]
        self.coord = {}                    # station -> (lon, lat)
        self.station_lines = defaultdict(set)
        self.pinyin = {}                   # 拼音小写 -> station
        self.line_of_station = defaultdict(set)  # station -> {line_no}

        for li in raw['l']:
            no = str(li.get('ln', '')).replace('号线', '')
            label = li.get('la') or ''
            key = f"{li.get('ln')}|{label}"
            sts = []
            for st in li['st']:
                nm = norm_station(st['n'])
                lon, lat = [float(x) for x in st['sl'].split(',')]
                self.coord[nm] = (lon, lat)
                sts.append((nm, (lon, lat)))
                self.station_lines[nm].add(key)
                self.line_of_station[nm].add(no)
                sp = str(st.get('sp', '')).lower()
                if sp:
                    self.pinyin.setdefault(sp, nm)
                en = str(st.get('en', '')).lower().replace(' ', '')
                if en:
                    self.pinyin.setdefault(en, nm)
            self.lines.append({'key': key, 'no': no, 'label': label, 'stations': sts})

        self._build_graph()
        self._cache = {}

    # ---------------- 建图 ----------------
    def _build_graph(self):
        self.adj = defaultdict(list)       # (station, line_key) -> [(node, minutes, is_transfer)]
        for li in self.lines:
            sts = li['stations']
            for i in range(len(sts) - 1):
                (n1, c1), (n2, c2) = sts[i], sts[i + 1]
                if n1 == n2:
                    continue
                km = haversine(c1, c2) * DIST_DETOUR
                t = segment_minutes(km)
                a, b = (n1, li['key']), (n2, li['key'])
                self.adj[a].append((b, t, False))
                self.adj[b].append((a, t, False))
        # 换乘边
        for st, keys in self.station_lines.items():
            ks = list(keys)
            for i in range(len(ks)):
                for j in range(i + 1, len(ks)):
                    same_no = ks[i].split('|')[0] == ks[j].split('|')[0]
                    t = BRANCH_TRANSFER_MIN if same_no else TRANSFER_MIN
                    self.adj[(st, ks[i])].append(((st, ks[j]), t, not same_no))
                    self.adj[(st, ks[j])].append(((st, ks[i]), t, not same_no))

    # ---------------- 查询 ----------------
    def query(self, origin, dest):
        """返回 (分钟, 换乘次数). 站名需已归一化且存在于网络中."""
        if origin == dest:
            return 0.0, 0
        key = (origin, dest)
        if key in self._cache:
            return self._cache[key]
        if origin not in self.station_lines or dest not in self.station_lines:
            return None
        dist = {}
        pq = []
        for k in self.station_lines[origin]:
            n = (origin, k)
            dist[n] = (0.0, 0)
            heappush(pq, (0.0, 0, n))
        best = None
        while pq:
            d, tr, node = heappop(pq)
            if dist.get(node, (1e9, 0))[0] < d - 1e-9:
                continue
            if node[0] == dest:
                best = (d, tr)
                break
            for nxt, w, is_tr in self.adj[node]:
                nd, ntr = d + w, tr + (1 if is_tr else 0)
                if nd < dist.get(nxt, (1e9, 0))[0] - 1e-9:
                    dist[nxt] = (nd, ntr)
                    heappush(pq, (nd, ntr, nxt))
        self._cache[key] = best
        return best

    def best_pair(self, origins, dests):
        """多起点多终点: 返回 (分钟, 换乘, 起点站, 终点站) 中耗时最短的组合."""
        out = None
        for o in origins:
            for d in dests:
                r = self.query(o, d)
                if r is None:
                    continue
                cand = (r[0], r[1], o, d)
                if out is None or cand[0] < out[0]:
                    out = cand
        return out

    # ---------------- 站名解析 ----------------
    def resolve(self, raw_name, line_no=None, aliases=None):
        """把原始表里的站名文本解析成网络中的站名. 返回 (station, how) 或 (None, reason)."""
        aliases = aliases or {}
        s = str(raw_name).strip()
        n = norm_station(s)
        # 别名查表: 原样、去空格、去掉所有非字母并转小写, 三种键都试
        alias_keys = [s, n, re.sub(r'[^a-z一-鿿]', '', s.lower())]
        for k in alias_keys:
            if k in aliases:
                return aliases[k], 'alias'
        for v in name_variants(n):
            if v in self.station_lines:
                return v, 'exact'
        # 中文子串匹配: 长片段优先, 同时尝试加/去尾字「站」
        zh = re.findall(r'[一-鿿·]+', n)
        for frag in sorted(zh, key=len, reverse=True):
            for v in name_variants(norm_station(frag)):
                if v in self.station_lines:
                    return v, 'zh-substr'
        # 拼音 / 英文匹配
        latin = re.sub(r'[^a-z]', '', s.lower())
        if latin:
            for k, v in self.pinyin.items():
                kk = re.sub(r'[^a-z]', '', k)
                if kk and (kk == latin or (len(kk) > 5 and kk in latin)):
                    if line_no is None or line_no in self.line_of_station[v]:
                        return v, 'pinyin'
        # 同线内中文模糊
        if line_no is not None:
            cands = [st for st, nos in self.line_of_station.items() if line_no in nos]
            for c in cands:
                if c and c in n:
                    return c, 'line-scan'
        return None, 'unresolved'


if __name__ == '__main__':
    import sys
    eng = TravelTimeEngine(sys.argv[1] if len(sys.argv) > 1 else 'sh_metro_raw.json')
    print(f"线路 {len(eng.lines)} 条, 站点 {len(eng.station_lines)} 个\n")
    # 参考值来自公开线路图的常识区间, 用于判断参数是否离谱, 不是精确真值
    checks = [
        ('人民广场', '徐家汇', '1号线直达4站', '10-13'),
        ('陆家嘴', '静安寺', '2号线直达4站', '10-13'),
        ('国权路', '五角场', '10号线相邻站', '2-3'),
        ('人民广场', '虹桥火车站', '2号线直达', '30-36'),
        ('莘庄', '人民广场', '1号线直达', '32-38'),
        ('人民广场', '嘉定北', '换1次, 客户提到11号线全程约60分', '60-75'),
        ('上海火车站', '虹口足球场', '3号线直达2站', '4-7'),
        ('永德路', '殷高东路', '一南一北穿城', '80-100'),
        ('惠南', '紫竹高新区', '两个远郊对角', '100-135'),
        ('世纪公园', '港城路', '浦东内部', '40-55'),
        ('延安西路', '北新泾', '同在西区', '13-20'),
        ('龙阳路', '上海火车站', '穿城', '35-45'),
    ]
    print(f"{'起点':11}{'终点':11}{'分钟':>7}{'换乘':>5}  {'参考区间':10} 备注")
    for a, b, note, ref in checks:
        r = eng.query(a, b)
        if r:
            lo, hi = [float(x) for x in ref.split('-')]
            flag = 'ok ' if lo <= r[0] <= hi else '偏差'
            print(f"{a:11}{b:11}{r[0]:7.1f}{r[1]:5d}  {ref+'分':10} {flag} {note}")
        else:
            print(f"{a:11}{b:11}{'解析失败':>7}      {ref:10}      {note}")
