"""通勤时间供给层.

对外只暴露一个接口:
    provider.pair(origin_stations, dest_stations) -> (分钟, 换乘次数, 起点站, 终点站)

两种实现:
    OfflineProvider  用本地地铁拓扑图估算, 不需要 API key
    AmapProvider     调高德「公交路径规划」REST 接口拿真实时间, 需要「Web服务」类型 key

切换只需改 config.COMMUTE_PROVIDER, 上层的清洗层和求解器完全不用动.

注意: AmapProvider 需要的是「Web服务」类型 Key, 而个人开发者账号在高德控制台
通常只能申请到「Web端(JS API)」类型（企业认证账号才有 Web服务 选项）。
如果你申请不到 Web服务 Key, 这个 Provider 就用不了, 老老实实用 offline 估算即可,
或者去用网页版 index.html —— 那边走的是 Web端(JS API) + AMap.Transfer 插件，
是个人账号能用的路子。
"""

import hashlib
import json
import os
import time
import urllib.parse
import urllib.request

import config
from metro import TravelTimeEngine


class OfflineProvider:
    """基于地铁拓扑图的估算. 精度约 ±15%, 用于没有 key 时先跑通全流程."""

    name = 'offline(地铁拓扑估算)'
    accurate = False

    def __init__(self, engine):
        self.engine = engine

    def pair(self, origins, dests):
        return self.engine.best_pair(origins, dests)

    def stats(self):
        return {}


class AmapProvider:
    """高德公交路径规划 v3.

    接口文档: https://lbs.amap.com/api/webservice/guide/api/direction#t9
    请求示例:
      https://restapi.amap.com/v3/direction/transit/integrated
        ?key=你的KEY
        &origin=121.385373,31.111152        经度,纬度
        &destination=121.480539,31.236882
        &city=021&cityd=021
        &strategy=0
        &extensions=base

    返回里我们只取三个东西:
      route.transits[0].duration        全程秒数, 即「他在地铁里的时间」
      route.transits[0].walking_distance 站内与两端步行米数
      segments 中的轨道段数 - 1          换乘次数

    结果按「起点站-终点站」缓存到本地 JSON. 项目点站点固定, 志愿者留存率 60% 至 70%,
    所以每学期只需为新增站点增量调用, 实际调用量很小.
    """

    name = 'amap(高德公交路径规划)'
    accurate = True
    ENDPOINT = 'https://restapi.amap.com/v3/direction/transit/integrated'

    # 这些错误码继续重试没有意义, 必须立刻停下来, 而不是白跑几百次
    FATAL = {
        '10001': 'Key 无效。最常见原因是用了「Web端(JS API)」类型的 Key，'
                 '本接口只认「Web服务」类型。跑 python3 check_key.py 可以确认。'
                 '如果高德控制台里根本申请不到 Web服务 类型（个人账号常见），'
                 '这条路对你不可用，改用网页版 index.html 或 offline 估算',
        '10002': '没有权限使用这个接口',
        '10003': '今日调用量已达上限',
        '10005': 'IP 白名单出错, Key 绑定的 IP 与当前不符',
        '10008': 'Key 与绑定的 SHA1/包名不匹配',
        '10009': 'Key 与绑定的域名不匹配',
        '10012': '权限不足, 该 Key 没有开通公交路径规划服务',
        '10007': '数字签名未通过验证。控制台开了「数字签名」但 config.AMAP_SECRET 没填或填错',
        '10029': '该 Key 未开启数字签名, 但请求里带了 sig。把 config.AMAP_SECRET 清空',
        '10044': '账号维度当日调用量已超限',
        '10047': '账号维度并发量已超限',
    }
    FLUSH_EVERY = 10       # 每取这么多条就落一次盘, 中途出错不会白跑

    def __init__(self, engine, key, cache_path=None, secret=None):
        cache_path = cache_path or config.AMAP_CACHE   # 运行时读, 不在类定义时固化
        if not key:
            raise ValueError('config.AMAP_KEY 为空, 无法使用高德接口')
        self.engine = engine
        self.api_key = key
        # 只有控制台开了「数字签名」才需要, 默认为空
        self.secret = (secret if secret is not None else getattr(config, 'AMAP_SECRET', '')) or ''
        self.cache_path = cache_path
        self.cache = {}
        if os.path.exists(cache_path):
            self.cache = json.load(open(cache_path, encoding='utf-8'))
        self.calls = 0
        self.errors = []
        self._last = 0.0
        self._since_flush = 0

    # ---------- 单站对 ----------
    def query(self, o, d):
        if o == d:
            return 0.0, 0
        ck = self.ck(o, d)
        if ck in self.cache:
            v = self.cache[ck]
            return (v['minutes'], v['transfers']) if v else None

        oc, dc = self.engine.coord.get(o), self.engine.coord.get(d)
        if not oc or not dc:
            return None

        params = {
            'key': self.api_key,
            'origin': f'{oc[0]:.6f},{oc[1]:.6f}',
            'destination': f'{dc[0]:.6f},{dc[1]:.6f}',
            'city': config.AMAP_CITY,
            'cityd': config.AMAP_CITY,
            'strategy': config.AMAP_STRATEGY,
            'extensions': 'base',
        }
        url = self.ENDPOINT + '?' + urllib.parse.urlencode(self.sign(params))

        gap = 1.0 / max(config.AMAP_QPS, 1)
        wait = gap - (time.time() - self._last)
        if wait > 0:
            time.sleep(wait)
        self._last = time.time()

        data = None
        for attempt in range(4):
            try:
                with urllib.request.urlopen(url, timeout=15) as r:
                    data = json.loads(r.read().decode('utf-8'))
            except Exception as e:
                self.errors.append(f'{ck}: 请求失败 {e}')
                return None
            # 10004 是调用过快, 退避重试而不是放弃
            if str(data.get('infocode')) == '10004' and attempt < 3:
                time.sleep(0.7 * (attempt + 1))
                continue
            break
        self.calls += 1
        self._since_flush += 1
        if self._since_flush >= self.FLUSH_EVERY:
            self.flush()
            self._since_flush = 0

        if str(data.get('status')) != '1':
            code = str(data.get('infocode'))
            if code in self.FATAL:
                self.flush()   # 已经花掉的调用要留住
                raise RuntimeError(f'高德接口报错 {code}: {self.FATAL[code]}')
            self.errors.append(f"{ck}: 高德返回 {data.get('info')} ({code})")
            self.cache[ck] = None
            return None

        transits = (data.get('route') or {}).get('transits') or []
        if not transits:
            self.errors.append(f'{ck}: 无公交方案')
            self.cache[ck] = None
            return None

        t = transits[0]
        minutes = float(t.get('duration', 0)) / 60.0
        rail = 0
        for seg in t.get('segments', []):
            for bl in (seg.get('bus') or {}).get('buslines', []):
                if '地铁' in str(bl.get('type', '')) or '号线' in str(bl.get('name', '')):
                    rail += 1
                    break
        transfers = max(0, rail - 1)
        self.cache[ck] = {'minutes': round(minutes, 1), 'transfers': transfers,
                          'walk_m': int(float(t.get('walking_distance', 0)))}
        return minutes, transfers

    # ---------- 预取: 给出进度, 别让用户对着黑屏等两分钟 ----------
    def prefetch(self, station_pairs, on_progress=None):
        todo = [(o, d) for o, d in station_pairs
                if o != d and self.ck(o, d) not in self.cache]
        for i, (o, d) in enumerate(todo, 1):
            self.query(o, d)
            if on_progress:
                on_progress(i, len(todo), len(self.errors))
        self.flush()
        return {'fetched': len(todo), 'total': len(station_pairs)}

    def sign(self, params):
        """数字签名: 参数名 ASCII 升序拼接后接私钥, MD5 取 32 位小写.
        没开数字签名时原样返回, 多传一个 sig 反而会被高德拒绝."""
        if not self.secret:
            return params
        raw = '&'.join(f'{k}={params[k]}' for k in sorted(params))
        sig = hashlib.md5((raw + self.secret).encode('utf-8')).hexdigest()
        out = dict(params)
        out['sig'] = sig
        return out

    @staticmethod
    def ck(o, d):
        return f'{o}=>{d}'

    # ---------- 多站对取最优 ----------
    def pair(self, origins, dests):
        best = None
        for o in origins:
            for d in dests:
                r = self.query(o, d)
                if r is None:
                    continue
                cand = (r[0], r[1], o, d)
                if best is None or cand[0] < best[0]:
                    best = cand
        return best

    def flush(self):
        json.dump(self.cache, open(self.cache_path, 'w', encoding='utf-8'),
                  ensure_ascii=False, indent=1)

    def stats(self):
        return {'实际调用次数': self.calls, '缓存条数': len(self.cache),
                '失败条数': len(self.errors)}


def build(engine):
    """按 config 选择实现. 高德不可用时自动退回离线估算, 并把原因说清楚."""
    if config.COMMUTE_PROVIDER == 'amap':
        try:
            return AmapProvider(engine, config.AMAP_KEY), None
        except Exception as e:
            return OfflineProvider(engine), f'高德接口不可用, 已退回离线估算: {e}'
    return OfflineProvider(engine), None
