"""高德 Key 诊断. 跑一次就知道手上的 Key 是哪一种、能不能用、要不要填安全密钥.

注意: 这个脚本测的是「Web服务」类型 Key（REST 接口）。
个人开发者账号在高德控制台通常申请不到这种 Key，只能申请「Web端(JS API)」类型。
如果你的控制台里确实只有 Web端(JS API) 选项，这个脚本对你没用，
不用跑了，直接用网页版 index.html（走的是 Web端(JS API) + AMap.Transfer），
或者用 Python 版的本地估算 (COMMUTE_PROVIDER = 'offline')。
只有企业认证过、能申请到 Web服务 Key 的账号才需要这个脚本。

用法:
    python3 check_key.py                  # 读 config.py 里的 AMAP_KEY / AMAP_SECRET
    python3 check_key.py <key>            # 临时测一个 key
    python3 check_key.py <key> <secret>   # 连数字签名私钥一起测

最多消耗 3 次调用配额.
"""

import hashlib
import json
import sys
import urllib.parse
import urllib.request

import config

ENDPOINT = 'https://restapi.amap.com/v3/direction/transit/integrated'
# 上海火车站 -> 虹口足球场, 3 号线直达, 真实时长在 8 分钟上下
ORIGIN, DEST = '121.455270,31.249162', '121.482852,31.270598'


def call(key, secret=None):
    params = {'key': key, 'origin': ORIGIN, 'destination': DEST,
              'city': '021', 'cityd': '021', 'strategy': '0', 'extensions': 'base'}
    if secret:
        raw = '&'.join(f'{k}={params[k]}' for k in sorted(params))
        params['sig'] = hashlib.md5((raw + secret).encode('utf-8')).hexdigest()
    url = ENDPOINT + '?' + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=15) as r:
            return json.loads(r.read().decode('utf-8'))
    except Exception as e:
        return {'status': '0', 'info': f'请求异常 {e}', 'infocode': 'NETWORK'}


def describe(d):
    return f"status={d.get('status')} info={d.get('info')} infocode={d.get('infocode')}"


def main():
    key = sys.argv[1] if len(sys.argv) > 1 else config.AMAP_KEY
    secret = sys.argv[2] if len(sys.argv) > 2 else getattr(config, 'AMAP_SECRET', '')

    print('=' * 62)
    print('高德 Key 诊断')
    print('=' * 62)
    if not key:
        print('\n没有拿到 Key。请把 Key 填进 config.py 的 AMAP_KEY，或者直接:')
        print('    python3 check_key.py 你的key')
        return 1
    print(f'Key      长度 {len(key)}，前 4 位 {key[:4]}…')
    print(f'安全密钥 {"已提供，长度 " + str(len(secret)) if secret else "未提供"}')

    print('\n[1/2] 不带数字签名直接请求…')
    a = call(key)
    print('      ' + describe(a))

    if str(a.get('status')) == '1':
        t = ((a.get('route') or {}).get('transits') or [{}])[0]
        mins = float(t.get('duration', 0)) / 60
        print('\n' + '─' * 62)
        print('结论：这是一个可用的「Web服务」Key，不需要填安全密钥。')
        print('─' * 62)
        print(f'  上海火车站 → 虹口足球场 实测 {mins:.1f} 分钟（参考值 8 分钟上下）')
        print('\n  config.py 这样填：')
        print("      AMAP_KEY = '你的key'")
        print("      AMAP_SECRET = ''            # 留空")
        print("      COMMUTE_PROVIDER = 'amap'   # 别忘了改这行")
        print('\n  网页版：把同一个 Key 填在页面的输入框里即可，安全密钥不用管。')
        return 0

    code = str(a.get('infocode'))

    if code in ('10007', '10009') and not secret:
        print('\n[2/2] 看起来这个 Key 开了数字签名，但没给私钥，跳过第二步。')
        print('\n' + '─' * 62)
        print('结论：这是「Web服务」Key，但控制台开启了「数字签名」。')
        print('─' * 62)
        print('  两种处理方式，任选其一：')
        print('    A. 控制台关掉数字签名（推荐，网页版只能用这种）')
        print('       高德控制台 → 应用管理 → 对应 Key → 关闭「数字签名」')
        print("    B. 把私钥填进 config.py 的 AMAP_SECRET（只有 Python 版能用）")
        print('       然后重跑 python3 check_key.py 确认')
        return 1

    if secret:
        print('\n[2/2] 带数字签名再请求一次…')
        b = call(key, secret)
        print('      ' + describe(b))
        if str(b.get('status')) == '1':
            t = ((b.get('route') or {}).get('transits') or [{}])[0]
            mins = float(t.get('duration', 0)) / 60
            print('\n' + '─' * 62)
            print('结论：Key 与数字签名私钥都正确，需要一起用。')
            print('─' * 62)
            print(f'  上海火车站 → 虹口足球场 实测 {mins:.1f} 分钟（参考值 8 分钟上下）')
            print('\n  config.py 这样填：')
            print("      AMAP_KEY = '你的key'")
            print("      AMAP_SECRET = '你的私钥'")
            print("      COMMUTE_PROVIDER = 'amap'")
            print('\n  注意：网页版不支持数字签名（私钥不能放进浏览器）。')
            print('        要用网页版，请在控制台关掉这个 Key 的数字签名。')
            return 0
        print(f'      带签名仍然失败：{describe(b)}')

    print('\n' + '─' * 62)
    if code == '10001':
        print('结论：这个 Key 不能用于 Web服务 接口。')
        print('─' * 62)
        print('  最可能的原因：它是「Web端(JS API)」类型的 Key。')
        print('  这种 Key 配的是 securityJsCode，只能在高德 JS SDK 里用，')
        print('  调 restapi.amap.com 一定返回 INVALID_USER_KEY，密钥填在哪都没用。')
        print('\n  怎么办：高德控制台 → 应用管理 → 添加 Key →')
        print('          服务平台选「Web服务」→ 用新生成的 Key。')
        print('          一个应用下可以同时有多个不同平台的 Key，不用删旧的。')
        print('\n  但如果控制台里根本没有「Web服务」这个选项可选（个人开发者账号常见），')
        print('  说明这条路对你不可用，不是操作问题。请改用网页版 index.html，')
        print('  或者 Python 版切换 COMMUTE_PROVIDER = \'offline\' 用本地估算。')
    elif code == '10003':
        print('结论：Key 有效，但今日调用量已用完。明天再试。')
    elif code == '10012':
        print('结论：Key 有效，但没有开通「路径规划」服务权限。')
        print('─' * 62)
        print('  控制台 → 应用管理 → 该 Key → 检查已开通的服务列表。')
    elif code == '10005':
        print('结论：Key 绑定了 IP 白名单，当前 IP 不在名单内。')
        print('─' * 62)
        print('  控制台把 IP 白名单清空，或加上你的公网 IP。')
    elif code == 'NETWORK':
        print('结论：网络请求本身就失败了，不是 Key 的问题。')
    else:
        print(f'结论：高德返回了 {code}（{a.get("info")}），不在常见清单里。')
        print('─' * 62)
        print('  错误码含义见 https://lbs.amap.com/api/webservice/guide/tools/info')
    return 1


if __name__ == '__main__':
    sys.exit(main())
