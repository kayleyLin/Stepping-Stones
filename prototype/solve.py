"""求解器: 志愿者与班级的带约束匹配.

硬约束
  1. 时间必须完全匹配 (沟通中的第一优先)
  2. 每个志愿者最多带一个班
  3. 每个班人数不超过需求数

分层目标 (字典序, 逐层求解并锁定上一层最优值)
  L1  最大化「至少有一名志愿者」的班级数, 按上传表格中的班级顺序加权
      表格越靠前的班级权重越高, 用来表达「按教学点顺序依次分配」
  L2  最大化实际安置的志愿者人数, 即尽量把班配满两人
  L3  最小化总通勤代价 = 在途分钟 + 超过单程舒适阈值部分的额外惩罚

分层而不是加权求和, 好处是不用调权重, 且优先级与反馈里的表述严格一致.
"""

from ortools.sat.python import cp_model
import config


def build_pairs(vols, classes, provider):
    """枚举所有可行的 (志愿者, 班级) 组合, 附通勤信息."""
    pairs = {}
    detail = {}
    for vi, v in enumerate(vols):
        if not v['stations']:
            continue
        for ci, c in enumerate(classes):
            if c['slot'] not in v['slots']:
                continue                      # 硬约束 1
            r = provider.pair(v['stations'], c['stations'])
            if r is None:
                continue
            minutes, transfers, o, d = r
            over = max(0.0, minutes - config.COMFORT_MIN)
            pairs[(vi, ci)] = int(round((minutes + config.OVERAGE_PENALTY * over) * 10))
            detail[(vi, ci)] = {'minutes': round(minutes, 1), 'transfers': transfers,
                                'from': o, 'to': d}
    return pairs, detail


def solve(vols, classes, provider, locks=None):
    locks = locks or {}
    pairs, detail = build_pairs(vols, classes, provider)

    cls_index = {f"{c['site']}-{c['cls']}": i for i, c in enumerate(classes)}
    vol_index = {v['id']: i for i, v in enumerate(vols)}

    # 人工锁定
    forced = {}
    lock_warn = []
    for vid, ckey in locks.items():
        if vid not in vol_index:
            lock_warn.append(f'锁定失败: 找不到志愿者 {vid}')
            continue
        if ckey not in cls_index:
            lock_warn.append(f'锁定失败: 找不到班级 {ckey}')
            continue
        forced[vol_index[vid]] = cls_index[ckey]

    feas_count = {ci: 0 for ci in range(len(classes))}
    for (vi, ci) in pairs:
        feas_count[ci] += 1
    # 表格顺序权重: 越靠前的班级权重越高. 用 2 的幂让任一靠前班级
    # 的覆盖优先级高于其后所有班级覆盖优先级之和.
    order_weight = {ci: 2 ** (len(classes) - ci - 1) for ci in range(len(classes))}

    m = cp_model.CpModel()
    x = {k: m.NewBoolVar(f'x{k}') for k in pairs}

    for vi in range(len(vols)):
        vv = [x[(vi, ci)] for ci in range(len(classes)) if (vi, ci) in x]
        if vv:
            m.Add(sum(vv) <= config.MAX_CLASS_PER_VOLUNTEER)
        if vi in forced:
            ci = forced[vi]
            if (vi, ci) in x:
                m.Add(x[(vi, ci)] == 1)
            else:
                lock_warn.append(f'锁定的组合不可行, 已忽略: {vols[vi]["id"]} -> '
                                 f'{classes[ci]["site"]}-{classes[ci]["cls"]}')

    covered, filled, headcount = {}, {}, {}
    for ci, c in enumerate(classes):
        vv = [x[(vi, ci)] for vi in range(len(vols)) if (vi, ci) in x]
        n = m.NewIntVar(0, c['need'], f'n{ci}')
        m.Add(n == sum(vv) if vv else n == 0)
        headcount[ci] = n
        cov = m.NewBoolVar(f'cov{ci}')
        m.Add(n >= 1).OnlyEnforceIf(cov)
        m.Add(n == 0).OnlyEnforceIf(cov.Not())
        covered[ci] = cov
        ful = m.NewBoolVar(f'ful{ci}')
        m.Add(n >= c['need']).OnlyEnforceIf(ful)
        m.Add(n <= c['need'] - 1).OnlyEnforceIf(ful.Not())
        filled[ci] = ful

    obj1 = sum(order_weight[ci] * covered[ci] for ci in covered)
    obj2 = sum(x.values())
    obj3 = sum(pairs[k] * x[k] for k in x)

    log = []

    def run(objective, sense):
        s = cp_model.CpSolver()
        s.parameters.max_time_in_seconds = 30
        s.parameters.num_workers = 8
        if sense == 'max':
            m.Maximize(objective)
        else:
            m.Minimize(objective)
        st = s.Solve(m)
        if st not in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            raise RuntimeError(f'求解失败: {s.StatusName(st)}')
        return s, int(round(s.ObjectiveValue())), s.StatusName(st)

    s1, v1, n1 = run(obj1, 'max')
    log.append(f'L1 表格顺序覆盖率  目标值={v1}  状态={n1}')
    m.Add(obj1 >= v1)

    s2, v2, n2 = run(obj2, 'max')
    log.append(f'L2 安置志愿者人数  目标值={v2}  状态={n2}')
    m.Add(obj2 >= v2)

    s3, v3, n3 = run(obj3, 'min')
    log.append(f'L3 总通勤代价      目标值={v3/10:.1f}  状态={n3}')

    assign = []
    for (vi, ci), var in x.items():
        if s3.Value(var):
            d = detail[(vi, ci)]
            assign.append({
                'vol': vols[vi]['id'], 'site': classes[ci]['site'],
                'cls': classes[ci]['cls'], 'slot': classes[ci]['slot'],
                'minutes': d['minutes'], 'transfers': d['transfers'],
                'from': d['from'], 'to': d['to'],
                'flexible': vols[vi]['flexible'],
                'transport': '/'.join(vols[vi]['stations']),
                'locked': vi in forced,
            })
    assign.sort(key=lambda a: (int(a['site']), a['cls'], a['vol']))

    return {
        'assign': assign,
        'pairs': pairs, 'detail': detail,
        'feas_count': feas_count,
        'headcount': {ci: s3.Value(headcount[ci]) for ci in headcount},
        'log': log, 'lock_warn': lock_warn,
    }
