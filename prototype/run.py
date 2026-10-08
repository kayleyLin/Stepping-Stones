"""主流程: 读原始表 -> 清洗 -> 算通勤 -> 求解 -> 输出 Excel 与 HTML 报告.

用法:
    python3 run.py "25 Spring- SET Allocation Survey_40_40.xlsx"
"""

import sys
import os
import time
import json
import html
from collections import Counter, defaultdict

import openpyxl
from openpyxl.styles import Font, PatternFill, Alignment, Border, Side
from openpyxl.utils import get_column_letter

import config
import commute
import solve as solver
from metro import TravelTimeEngine
from parse_input import load

HERE = os.path.dirname(os.path.abspath(__file__))
TOPO = os.path.join(HERE, 'sh_metro_raw.json')


def needed_station_pairs(vols, classes):
    """求解真正会用到的站对: 只算时段能匹配上的组合."""
    seen, out = set(), []
    for v in vols:
        for c in classes:
            if c['slot'] not in v['slots']:
                continue
            for o in v['stations']:
                for d in c['stations']:
                    if o != d and (o, d) not in seen:
                        seen.add((o, d))
                        out.append((o, d))
    return out


def main(xlsx_path):
    engine = TravelTimeEngine(TOPO)
    vols, classes, sites, warn = load(xlsx_path, engine)
    provider, prov_note = commute.build(engine)

    # 走高德时先预取, 一边跑一边报进度, 不要让人对着黑屏等两分钟
    if hasattr(provider, 'prefetch'):
        pairs = needed_station_pairs(vols, classes)
        cached = sum(1 for o, d in pairs if provider.ck(o, d) in provider.cache)
        print(f'需要 {len(pairs)} 个站对, 已有缓存 {cached} 个, '
              f'本次调用 {len(pairs) - cached} 次')
        t0 = time.time()

        def show(i, n, errs):
            eta = (time.time() - t0) / i * (n - i)
            msg = f'\r  高德调用 {i}/{n}  剩余约 {eta:.0f} 秒'
            if errs:
                msg += f'  已有 {errs} 个站对无结果'
            sys.stdout.write(msg.ljust(64))
            sys.stdout.flush()
        try:
            provider.prefetch(pairs, show)
            print()
        except RuntimeError as e:
            print(f'\n{e}\n已花掉的调用结果已保存, 本次退回离线估算。')
            provider, prov_note = commute.OfflineProvider(engine), str(e)

    res = solver.solve(vols, classes, provider, config.MANUAL_LOCKS)
    if hasattr(provider, 'flush'):
        provider.flush()

    # ---------- 汇总 ----------
    assign = res['assign']
    by_class = defaultdict(list)
    for a in assign:
        by_class[(a['site'], a['cls'])].append(a['vol'])

    need_total = sum(c['need'] for c in classes)
    covered = sum(1 for c in classes if by_class.get((c['site'], c['cls'])))
    fullstaff = sum(1 for c in classes
                    if len(by_class.get((c['site'], c['cls']), [])) >= c['need'])
    placed = len(assign)
    unplaced = [v for v in vols if v['id'] not in {a['vol'] for a in assign}]
    times = [a['minutes'] for a in assign]

    summary = {
        '通勤数据来源': provider.name,
        '志愿者总数': len(vols),
        '班级总数': len(classes),
        '所需名额': need_total,
        '实际安置志愿者': placed,
        '至少1人的班级': f'{covered} / {len(classes)}',
        '配满2人的班级': f'{fullstaff} / {len(classes)}',
        '未安置志愿者': len(unplaced),
        '未填补名额': need_total - placed,
        '平均单程通勤': f'{sum(times)/len(times):.1f} 分钟' if times else '-',
        '最长单程通勤': f'{max(times):.1f} 分钟' if times else '-',
        '超过60分钟的分配': sum(1 for t in times if t > config.COMFORT_MIN),
        '零换乘的分配': sum(1 for a in assign if a['transfers'] == 0),
        '总通勤时间': f'{sum(times):.0f} 分钟',
    }

    # 缺口清单
    gaps = []
    for c in classes:
        got = len(by_class.get((c['site'], c['cls']), []))
        if got < c['need']:
            n_feas = res['feas_count'].get(classes.index(c), 0)
            gaps.append({
                'site': c['site'], 'cls': c['cls'], 'slot': c['slot'],
                'need': c['need'], 'got': got, 'short': c['need'] - got,
                'feasible': n_feas,
                'reason': ('该时段无任何可行志愿者' if n_feas == 0
                           else f'该时段仅 {n_feas} 人可行, 且被表格中更靠前的班级占用'),
                'station': '/'.join(c['stations']),
            })
    gaps.sort(key=lambda g: (-g['short'], g['feasible']))

    # 未安置志愿者及原因
    unplaced_rows = []
    slot_demand = Counter()
    for c in classes:
        slot_demand[c['slot']] += c['need']
    for v in unplaced:
        vi = vols.index(v)
        n_pairs = sum(1 for (a, b) in res['pairs'] if a == vi)
        if not v['stations']:
            reason = '站点无法解析'
        elif n_pairs == 0:
            same_slot = [c for c in classes if c['slot'] in v['slots']]
            if not same_slot:
                reason = f"可用时段 {'/'.join(v['slots'])} 没有对应班级"
            else:
                reason = f"时段有课, 但对应班级名额已被表格中更靠前或通勤更短的人占用"
        else:
            reason = f'有 {n_pairs} 个可行班级, 但名额已被通勤更短的人占用'
        unplaced_rows.append({
            'vol': v['id'], 'slots': '/'.join(v['slots']),
            'station': '/'.join(v['stations']) or v['raw_station'][:30],
            'reason': reason,
        })

    # 时段供需
    slot_supply = Counter()
    for v in vols:
        for s in set(v['slots']):
            slot_supply[s] += 1
    slot_rows = []
    for s in sorted(set(list(slot_demand) + list(slot_supply)),
                    key=lambda s: ('一二三四五六日'.index(s[1]), s[2:])):
        slot_rows.append({'slot': s, 'demand': slot_demand.get(s, 0),
                          'supply': slot_supply.get(s, 0),
                          'gap': slot_supply.get(s, 0) - slot_demand.get(s, 0),
                          'placed': sum(1 for a in assign if a['slot'] == s)})

    out_xlsx = os.path.join(HERE, 'output_分配结果.xlsx')
    out_html = os.path.join(HERE, 'output_分配报告.html')
    write_xlsx(out_xlsx, xlsx_path, vols, classes, sites, by_class, assign,
               gaps, unplaced_rows, slot_rows, summary, warn, res, prov_note)
    write_html(out_html, summary, assign, gaps, unplaced_rows, slot_rows,
               warn, res, prov_note, provider)

    # ---------- 终端报告 ----------
    print('=' * 68)
    print('铺路石志愿者调配  求解结果')
    print('=' * 68)
    if prov_note:
        print('!! ' + prov_note)
    for k, v in summary.items():
        print(f'  {k:16} {v}')
    print('\n求解日志')
    for l in res['log']:
        print('  ' + l)
    for w in res['lock_warn']:
        print('  !! ' + w)

    print('\n时段供需与实际安置')
    print(f"  {'时段':10}{'需求':>5}{'可用':>5}{'差额':>6}{'已安置':>7}")
    for r in slot_rows:
        print(f"  {r['slot']:10}{r['demand']:5}{r['supply']:5}{r['gap']:+6}{r['placed']:7}")

    print('\n分配明细')
    print(f"  {'项目点':>5} {'班级':9}{'时段':10}{'志愿者':9}{'通勤':>6}{'换乘':>5}  路线")
    for a in assign:
        route = f"{a['from']} -> {a['to']}"
        print(f"  {a['site']:>5} {a['cls']:9}{a['slot']:10}{a['vol']:9}"
              f"{a['minutes']:6.1f}{a['transfers']:5}  {route}")

    print(f"\n未填补名额 {sum(g['short'] for g in gaps)} 个, 涉及 {len(gaps)} 个班级")
    print(f"  {'项目点':>5} {'班级':9}{'时段':10}{'缺':>3}{'可行人数':>9}  说明")
    for g in gaps:
        print(f"  {g['site']:>5} {g['cls']:9}{g['slot']:10}{g['short']:3}{g['feasible']:9}  {g['reason']}")

    print(f"\n未安置志愿者 {len(unplaced_rows)} 人")
    for u in unplaced_rows:
        print(f"  {u['vol']:9}{u['station']:14}{u['slots']:30} {u['reason']}")

    print(f"\n清洗告警 ERROR {sum(1 for l,_ in warn if l=='ERROR')} 条, "
          f"WARN {sum(1 for l,_ in warn if l=='WARN')} 条")
    for lv, msg in warn:
        print(f'  [{lv}] {msg}')

    print(f'\n输出文件\n  {out_xlsx}\n  {out_html}')


# ================= Excel 输出 =================
THIN = Side(style='thin', color='808080')
BORDER = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HDR = PatternFill('solid', fgColor='D9D9D9')


def _sheet(wb, title, headers, rows, widths=None, note=None):
    ws = wb.create_sheet(title)
    r0 = 1
    if note:
        ws.cell(1, 1, note).font = Font(size=9, italic=True, color='595959')
        r0 = 2
    for ci, h in enumerate(headers, 1):
        c = ws.cell(r0, ci, h)
        c.font = Font(bold=True, size=10)
        c.fill = HDR
        c.border = BORDER
        c.alignment = Alignment(wrap_text=True, vertical='center')
        ws.column_dimensions[get_column_letter(ci)].width = (widths or [14] * len(headers))[ci - 1]
    for ri, row in enumerate(rows, r0 + 1):
        for ci, v in enumerate(row, 1):
            c = ws.cell(ri, ci, v)
            c.font = Font(size=10)
            c.border = BORDER
            c.alignment = Alignment(vertical='top', wrap_text=isinstance(v, str) and len(str(v)) > 24)
    ws.freeze_panes = ws.cell(r0 + 1, 1)
    return ws


def write_xlsx(path, src_path, vols, classes, sites, by_class, assign, gaps,
               unplaced_rows, slot_rows, summary, warn, res, prov_note):
    wb = openpyxl.Workbook()
    wb.remove(wb.active)

    _sheet(wb, '汇总', ['指标', '数值'],
           [[k, str(v)] for k, v in summary.items()]
           + [['', '']]
           + [['求解日志', l] for l in res['log']]
           + ([['提示', prov_note]] if prov_note else []),
           [22, 40])

    _sheet(wb, '推荐结果回填格式',
           ['Serial number', 'Nearest subway station of teaching sites', 'Class number',
            'Class time', 'number of volunteers needed', 'Volunteer recommendations',
            'Other remarks'],
           [[c['site'], sites[c['site']]['raw_station'], c['cls'], c['raw_slot'], c['need'],
             ', '.join(by_class.get((c['site'], c['cls']), [])) or '',
             '未配满, 需人工处理' if len(by_class.get((c['site'], c['cls']), [])) < c['need'] else '']
            for c in classes],
           [12, 34, 10, 16, 12, 20, 20],
           '列结构与原始 site info 保持一致, 可直接覆盖回填. Volunteer recommendations 列为模型输出.')

    _sheet(wb, '分配理由',
           ['项目点', '班级', '时段', '志愿者', '单程通勤(分钟)', '换乘次数',
            '起点站', '终点站', '候选起点站', '是否人工锁定'],
           [[a['site'], a['cls'], a['slot'], a['vol'], a['minutes'], a['transfers'],
             a['from'], a['to'], a['transport'], '是' if a['locked'] else ''] for a in assign],
           [9, 10, 11, 9, 14, 10, 14, 14, 14, 12],
           '给排班负责人做人工微调用. 通勤时间来源: ' + summary['通勤数据来源'])

    _sheet(wb, '未填补名额',
           ['项目点', '班级', '时段', '项目点地铁站', '需求', '已分配', '缺口',
            '该时段可行志愿者数', '说明'],
           [[g['site'], g['cls'], g['slot'], g['station'], g['need'], g['got'],
             g['short'], g['feasible'], g['reason']] for g in gaps],
           [9, 10, 11, 18, 8, 9, 8, 16, 34],
           '直接给招募用: 缺口集中在哪些时段, 就定向招哪个时段的志愿者.')

    _sheet(wb, '未安置志愿者',
           ['志愿者', '候选起点站', '可用时段', '未被安置的原因'],
           [[u['vol'], u['station'], u['slots'], u['reason']]
            for u in unplaced_rows],
           [10, 24, 32, 40],
           '这批人本学期排不进去. 原因写「名额已被通勤更短的人占用」的, 说明是供需问题而不是他们本身不合适.')

    _sheet(wb, '时段供需',
           ['时段', '需求名额', '可用志愿者', '差额', '实际安置'],
           [[r['slot'], r['demand'], r['supply'], r['gap'], r['placed']] for r in slot_rows],
           [12, 11, 12, 9, 11],
           '差额为负的时段是真瓶颈, 为正的时段志愿者过剩.')

    _sheet(wb, '数据清洗告警', ['级别', '说明'],
           [[lv, msg] for lv, msg in warn], [9, 90],
           'ERROR 会导致该条数据无法参与计算, WARN 是靠推断补上的, 请人工确认.')

    wb.save(path)


# ================= HTML 报告 =================
CSS = """
body{font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;
 max-width:1180px;margin:0 auto;padding:32px 24px;color:#1a1a1a;line-height:1.6;background:#fff}
h1{font-size:24px;margin:0 0 4px}h2{font-size:17px;margin:34px 0 10px;
 padding-bottom:6px;border-bottom:1px solid #ddd}
.sub{color:#666;font-size:13px;margin-bottom:24px}
table{border-collapse:collapse;width:100%;font-size:13px;margin:10px 0}
th,td{border:1px solid #d0d0d0;padding:6px 9px;text-align:left;vertical-align:top}
th{background:#f2f2f2;font-weight:600}
td.n,th.n{text-align:right}
.cards{display:flex;flex-wrap:wrap;gap:10px;margin:14px 0}
.card{border:1px solid #d0d0d0;padding:10px 14px;min-width:132px}
.card .k{font-size:11px;color:#666}.card .v{font-size:19px;font-weight:600;margin-top:2px}
.neg{color:#b00020}.pos{color:#0a6}
.note{background:#f7f7f7;border-left:3px solid #999;padding:10px 14px;font-size:13px;margin:14px 0}
.bar{display:inline-block;height:9px;background:#666;vertical-align:middle}
code{background:#f2f2f2;padding:1px 4px;font-size:12px}
"""


def _tbl(headers, rows, numcols=()):
    h = ''.join(f'<th class="{"n" if i in numcols else ""}">{html.escape(str(x))}</th>'
                for i, x in enumerate(headers))
    body = ''
    for r in rows:
        body += '<tr>' + ''.join(
            f'<td class="{"n" if i in numcols else ""}">{x if isinstance(x, str) and x.startswith("<") else html.escape(str(x))}</td>'
            for i, x in enumerate(r)) + '</tr>'
    return f'<table><thead><tr>{h}</tr></thead><tbody>{body}</tbody></table>'


def write_html(path, summary, assign, gaps, unplaced_rows, slot_rows, warn, res,
               prov_note, provider):
    cards = ''.join(
        f'<div class="card"><div class="k">{html.escape(k)}</div>'
        f'<div class="v">{html.escape(str(v))}</div></div>'
        for k, v in summary.items() if k != '通勤数据来源')

    acc_note = ('<div class="note"><b>通勤时间来源: ' + html.escape(provider.name) + '</b><br>'
                + ('本次使用的是本地地铁拓扑估算, 精度约 ±15%, 用于验证整条流程能跑通。'
                   '在 <code>config.py</code> 填入 <code>AMAP_KEY</code> 并把 '
                   '<code>COMMUTE_PROVIDER</code> 改成 <code>amap</code>, '
                   '即可换成高德公交路径规划的真实换乘时间, 其余代码不需要改动。'
                   if not provider.accurate else
                   '通勤时间来自高德公交路径规划接口的真实返回值。')
                + '</div>')
    if prov_note:
        acc_note += f'<div class="note"><b>注意</b><br>{html.escape(prov_note)}</div>'

    mx = max([r['demand'] for r in slot_rows] + [r['supply'] for r in slot_rows] + [1])
    slot_tbl = _tbl(['时段', '需求名额', '可用志愿者', '差额', '实际安置', '供需对比'],
                    [[r['slot'], r['demand'], r['supply'],
                      f'<span class="{"neg" if r["gap"]<0 else "pos"}">{r["gap"]:+d}</span>',
                      r['placed'],
                      f'<span class="bar" style="width:{r["demand"]/mx*130:.0f}px;background:#b00020"></span>'
                      f'&nbsp;{r["demand"]}<br>'
                      f'<span class="bar" style="width:{r["supply"]/mx*130:.0f}px;background:#0a6"></span>'
                      f'&nbsp;{r["supply"]}']
                     for r in slot_rows], numcols=(1, 2, 3, 4))

    a_tbl = _tbl(['项目点', '班级', '时段', '志愿者', '单程分钟', '换乘', '起点站', '终点站', '候选起点站'],
                 [[a['site'], a['cls'], a['slot'], a['vol'], f"{a['minutes']:.1f}",
                   a['transfers'], a['from'], a['to'], a['transport']] for a in assign],
                 numcols=(4, 5))

    g_tbl = _tbl(['项目点', '班级', '时段', '地铁站', '缺口', '该时段可行人数', '说明'],
                 [[g['site'], g['cls'], g['slot'], g['station'], g['short'],
                   g['feasible'], g['reason']] for g in gaps], numcols=(4, 5))

    u_tbl = _tbl(['志愿者', '候选起点站', '可用时段', '原因'],
                 [[u['vol'], u['station'], u['slots'], u['reason']]
                  for u in unplaced_rows])

    w_tbl = _tbl(['级别', '说明'], [[lv, msg] for lv, msg in warn]) if warn else '<p>无</p>'

    doc = f"""<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<title>铺路石志愿者调配结果</title><style>{CSS}</style></head><body>
<h1>铺路石志愿者调配  求解结果</h1>
<div class="sub">原型运行报告 · 硬约束: 时间完全匹配、每人一班、班级人数不超需求 ·
分层目标: 表格顺序覆盖率 → 安置人数 → 总通勤代价</div>
{acc_note}
<h2>总览</h2><div class="cards">{cards}</div>
<div class="note">求解日志<br>{'<br>'.join(html.escape(l) for l in res['log'])}</div>
<h2>时段供需</h2>
<p>差额为负的时段是真瓶颈, 无论算法怎么排都填不满; 为正的时段志愿者过剩。
这张表可以直接拿去指导下一期定向招募。</p>
{slot_tbl}
<h2>分配明细</h2>
<p>共 {len(assign)} 条。给排班负责人做人工微调时, 重点看通勤分钟数偏高的几条。</p>
{a_tbl}
<h2>未填补名额</h2>
<p>共缺 {sum(g['short'] for g in gaps)} 个名额, 涉及 {len(gaps)} 个班级。
「该时段可行人数」为 0 的班级需要定向招募, 不是排班能解决的。</p>
{g_tbl}
<h2>未安置志愿者</h2>
<p>共 {len(unplaced_rows)} 人。</p>
{u_tbl}
<h2>数据清洗告警</h2>
<p>ERROR {sum(1 for l,_ in warn if l=='ERROR')} 条, WARN {sum(1 for l,_ in warn if l=='WARN')} 条。
每一条都对应一处可以在采集阶段用下拉选项或固定分隔符消除的格式问题。</p>
{w_tbl}
</body></html>"""
    open(path, 'w', encoding='utf-8').write(doc)


if __name__ == '__main__':
    main(sys.argv[1] if len(sys.argv) > 1 else 'input_25spring.xlsx')
