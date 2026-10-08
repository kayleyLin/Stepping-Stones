import os
import openpyxl
from openpyxl.styles import Font, Alignment, PatternFill, Border, Side
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.utils import get_column_letter

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '铺路石_数据采集模板_v1.xlsx')

thin = Side(style='thin', color='808080')
BORDER = Border(left=thin, right=thin, top=thin, bottom=thin)
HDR_FILL = PatternFill('solid', fgColor='D9D9D9')
HDR_FONT = Font(bold=True, size=10)
BODY_FONT = Font(size=10)
NOTE_FONT = Font(size=9, italic=True, color='595959')

wb = openpyxl.Workbook()

# ---------------- 说明页 ----------------
ws = wb.active
ws.title = '填写说明'
ws.column_dimensions['A'].width = 4
ws.column_dimensions['B'].width = 22
ws.column_dimensions['C'].width = 95

rows = [
    ('T', '铺路石志愿者调配优化项目  数据采集模板 v1.0', ''),
    ('', '', ''),
    ('H', '本模板用途', ''),
    ('P', '', '本模板对应《铺路石_数据需求规格书_v1.docx》，三张表的表头、下拉选项和格式均已按规格书配置。'),
    ('P', '', '请直接在对应工作表中填写。每张表第 2 行是填写示例，正式填写时可以整行删除。'),
    ('', '', ''),
    ('H', '格式硬性要求', ''),
    ('P', '1', '一个单元格只放一个值。多值统一用英文分号 ; 分隔，不要用换行、不要用 or 或 and、不要用中文分号。'),
    ('P', '2', '不要使用合并单元格。同一项目点下的多个班级请逐行重复填写 site_id 和项目点相关字段。'),
    ('P', '3', '带下拉箭头的列请一律用下拉选择，不要手工输入。'),
    ('P', '4', '日期统一用 YYYY-MM-DD，例如 2026-09-15。不要写成 9月15日 或 2026/9/15。'),
    ('P', '5', '时间统一用 24 小时制 HH:MM-HH:MM，例如 09:00-10:30。'),
    ('P', '6', '地铁站请填站名本身，不要填小区名、学校名或路名。线路号统一用阿拉伯数字。'),
    ('P', '7', '数值列只填数字，不要带单位。单位已写在表头里。'),
    ('P', '8', '不要在数据行之间插入小标题行、空行或备注行。'),
    ('P', '9', '志愿者一律使用编号，不要出现真实姓名。编号与姓名的对照表请由机构自行保管。'),
    ('', '', ''),
    ('H', '地铁站字段的填写格式', ''),
    ('P', '', '固定格式为「线路号|站名」，多个站用英文分号分隔。'),
    ('P', '正确', '10|殷高东路;18|上海财经大学'),
    ('P', '错误', 'Line 10-殷高东路 Yin\'ao East Road  和  Line 18 Shanghai university of finance and economics station'),
    ('P', '说明', '志愿者填多个站，按到各项目点的最短通勤时间计算，属于加分项，不会因为多填而被扣分。'),
    ('', '', ''),
    ('H', '时段枚举清单（两张表必须用同一份用词）', ''),
    ('P', '', '周一上午 周一下午 周一晚上 周二上午 周二下午 周二晚上 周三上午 周三下午 周三晚上'),
    ('P', '', '周四上午 周四下午 周四晚上 周五上午 周五下午 周五晚上 周六上午 周六下午 周六晚上'),
    ('P', '', '周日上午 周日下午 周日晚上'),
    ('P', '说明', '上午 下午 晚上 的具体钟点由「上课精确起止时间」列给出，不要写在时段列里。'),
    ('', '', ''),
    ('H', '关于科目字段', ''),
    ('P', '', '表 A 的「可教科目」和表 B 的「班级科目与年级」两列目前留空，等待确认科目约束是否真实存在。'),
    ('P', '', '若存在，请提供科目清单，我们会更新模板并加上下拉选项。这两列必须同时确认，单独确认一方没有意义。'),
    ('', '', ''),
    ('H', '有疑问时', ''),
    ('P', '', '若某个字段的收集成本过高，请直接反馈，我们评估该字段的实际权重后判断能否省略或替代。'),
]

r = 1
for kind, b, c in rows:
    if kind == 'T':
        ws.cell(r, 2, b).font = Font(bold=True, size=14)
    elif kind == 'H':
        ws.cell(r, 2, b).font = Font(bold=True, size=11)
    elif kind == 'P':
        ws.cell(r, 2, b).font = Font(size=10, bold=True)
        cell = ws.cell(r, 3, c)
        cell.font = BODY_FONT
        cell.alignment = Alignment(wrap_text=True, vertical='top')
    r += 1
ws.sheet_view.showGridLines = False

# ---------------- 枚举清单页（下拉数据源） ----------------
wl = wb.create_sheet('枚举清单')
SLOTS = [f'周{d}{t}' for d in '一二三四五六日' for t in ('上午', '下午', '晚上')]
YESNO = ['是', '否']
STATUS = ['在办', '暂停', '关闭']
EXITMODE = ['步行', '需打车', '需换乘公交']
EXITREASON = ['无', '通勤过远', '时间冲突', '个人原因', '其他']

lists = [('时段', SLOTS), ('是否', YESNO),
         ('项目点状态', STATUS), ('出站方式', EXITMODE),
         ('退出原因', EXITREASON)]
for ci, (name, vals) in enumerate(lists, start=1):
    col = get_column_letter(ci)
    ws_cell = wl.cell(1, ci, name)
    ws_cell.font = HDR_FONT
    ws_cell.fill = HDR_FILL
    wl.column_dimensions[col].width = 16
    for ri, v in enumerate(vals, start=2):
        wl.cell(ri, ci, v).font = BODY_FONT
wl.sheet_state = 'visible'
wl['J1'] = '本页是下拉选项的数据源，请不要修改或删除。'
wl['J1'].font = NOTE_FONT


def build_sheet(title, cols, example, validations, note):
    s = wb.create_sheet(title)
    s.cell(1, 1, note).font = NOTE_FONT
    s.freeze_panes = 'A3'
    for ci, (name, width) in enumerate(cols, start=1):
        c = s.cell(2, ci, name)
        c.font = HDR_FONT
        c.fill = HDR_FILL
        c.border = BORDER
        c.alignment = Alignment(wrap_text=True, vertical='center', horizontal='center')
        s.column_dimensions[get_column_letter(ci)].width = width
    s.row_dimensions[2].height = 32
    for ci, v in enumerate(example, start=1):
        c = s.cell(3, ci, v)
        c.font = Font(size=10, italic=True, color='808080')
        c.border = BORDER
        c.alignment = Alignment(vertical='top')
    for ci in range(1, len(cols) + 1):
        for ri in range(4, 84):
            s.cell(ri, ci).border = BORDER
            s.cell(ri, ci).font = BODY_FONT
    for col_idx, (src_col, n) in validations.items():
        dv = DataValidation(type='list',
                            formula1=f"=枚举清单!${src_col}$2:${src_col}${n+1}",
                            allow_blank=True, showDropDown=False)
        dv.error = '请从下拉列表中选择'
        s.add_data_validation(dv)
        L = get_column_letter(col_idx)
        dv.add(f'{L}3:{L}83')
    return s


# ---------------- 表 A ----------------
colsA = [
    ('volunteer_id', 13), ('最近地铁站\n线路号|站名，多站用;分隔', 26),
    ('步行至该站\n时间(分钟)', 12), ('其他就近地铁站或换乘线路\n线路号|站名，多站用;分隔', 28),
    ('可用时段\n下拉，多选用;分隔', 24), ('服务起始日期\nYYYY-MM-DD', 14),
    ('服务结束日期\nYYYY-MM-DD', 14), ('是否老志愿者', 12),
    ('已服务学期数', 12), ('历史服务项目点\nsite_id，多个用;分隔', 18),
    ('是否已人工锁定', 13), ('锁定的班级\nsite_id-class_id', 16),
    ('偏好项目点\nsite_id，多个用;分隔', 16), ('可教科目\n待确认', 14), ('备注', 20),
]
exA = ['V001', '10|殷高东路', 6, '18|上海财经大学', '周三下午;周六上午',
       '2026-09-13', '2027-01-11', '是', 3, '1;5', '否', '', '5', '', '']
build_sheet('表A_志愿者信息', colsA, exA,
            {5: ('A', len(SLOTS)), 8: ('B', 2), 11: ('B', 2)},
            '表 A：志愿者信息。每名志愿者一行，不要使用合并单元格。第 3 行为示例，正式填写时可整行删除。')

# ---------------- 表 B ----------------
colsB = [
    ('site_id', 9), ('site_status\n下拉', 11), ('项目点名称', 20),
    ('项目点详细地址\n精确到门牌号', 28), ('最近地铁站\n线路号|站名，多站用;分隔', 26),
    ('出站至项目点方式\n下拉', 15), ('出站至项目点\n耗时(分钟)', 13),
    ('class_id', 10), ('上课时段\n下拉', 13), ('上课精确起止时间\nHH:MM-HH:MM', 16),
    ('需要志愿者\n人数', 11), ('最少可开班\n人数', 11),
    ('班级科目与年级\n待确认', 14), ('学期起始日期\nYYYY-MM-DD', 14),
    ('学期结束日期\nYYYY-MM-DD', 14), ('学期总上课周次', 13), ('备注', 20),
]
exB = [1, '在办', '港城路项目点', '上海市浦东新区XX路XX号', '6|港城路', '步行', 8,
       'class 1', '周六上午', '09:00-10:30', 2, 1, '', '2026-09-13', '2027-01-11', 16, '']
build_sheet('表B_项目点与班级', colsB, exB,
            {2: ('C', len(STATUS)), 6: ('D', len(EXITMODE)), 9: ('A', len(SLOTS))},
            '表 B：项目点与班级信息。每个班级一行，同一项目点的多个班级请逐行重复填写 site_id 及项目点字段，不要使用合并单元格。第 3 行为示例。')

# ---------------- 表 C ----------------
colsC = [
    ('学期标识', 16), ('site_id', 9), ('class_id', 10),
    ('实际分配的志愿者\nvolunteer_id', 18),
    ('该志愿者当时的地铁站\n线路号|站名，多站用;分隔', 28),
    ('是否完整服务到学期末\n下拉', 16), ('中途退出原因\n下拉', 16), ('备注', 24),
]
exC = ['2025 Spring', 3, 'class 2', 'V017', '13|江宁路', '否', '通勤过远', '']
build_sheet('表C_历史分配结果', colsC, exC,
            {6: ('B', 2), 7: ('E', len(EXITREASON))},
            '表 C：历史分配结果，用于验证模型效果。若能提供最近一到两个学期即可。「中途退出原因」一列价值最高，用于校准通勤时长阈值。第 3 行为示例。')

wb.save(OUT)
print('saved', OUT)
