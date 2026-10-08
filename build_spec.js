const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType,
  Table, TableRow, TableCell, WidthType, ShadingType, BorderStyle,
  TableOfContents, PageBreak, LevelFormat, convertInchesToTwip
} = require('docx');
const fs = require('fs');
const path = require('path');

const W = 9700;
const GRAY = 'D9D9D9';
const THIN = { style: BorderStyle.SINGLE, size: 4, color: '808080' };
const BORDERS = { top: THIN, bottom: THIN, left: THIN, right: THIN,
                  insideHorizontal: THIN, insideVertical: THIN };

function p(text, opts = {}) {
  const runs = Array.isArray(text) ? text : [{ text }];
  return new Paragraph({
    children: runs.map(r => new TextRun({
      text: r.text, bold: r.bold, italics: r.italics, size: r.size || 21,
      font: { ascii: 'Times New Roman', eastAsia: 'PingFang SC', hAnsi: 'Times New Roman' }
    })),
    spacing: { after: opts.after === undefined ? 120 : opts.after, line: 300 },
    alignment: opts.align,
    indent: opts.indent,
    numbering: opts.numbering,
    border: opts.border,
    keepNext: opts.keepNext
  });
}

function h(text, level) {
  return new Paragraph({
    heading: level,
    spacing: { before: level === HeadingLevel.HEADING_1 ? 320 : 240, after: 140 },
    children: [new TextRun({
      text, bold: true,
      size: level === HeadingLevel.HEADING_1 ? 26 : 23,
      color: '000000',
      font: { ascii: 'Times New Roman', eastAsia: 'PingFang SC', hAnsi: 'Times New Roman' }
    })]
  });
}

function bullet(text, lvl = 0) {
  return new Paragraph({
    numbering: { reference: 'dots', level: lvl },
    spacing: { after: 80, line: 300 },
    children: [new TextRun({
      text, size: 21,
      font: { ascii: 'Times New Roman', eastAsia: 'PingFang SC', hAnsi: 'Times New Roman' }
    })]
  });
}

function cellPara(text, bold) {
  const lines = String(text).split('\n');
  return lines.map((ln, i) => new Paragraph({
    spacing: { after: i === lines.length - 1 ? 40 : 40, line: 280 },
    children: [new TextRun({
      text: ln, bold, size: 19,
      font: { ascii: 'Times New Roman', eastAsia: 'PingFang SC', hAnsi: 'Times New Roman' }
    })]
  }));
}

function table(widths, rows, opts = {}) {
  const total = widths.reduce((a, b) => a + b, 0);
  return new Table({
    width: { size: total, type: WidthType.DXA },
    columnWidths: widths,
    borders: BORDERS,
    rows: rows.map((cells, ri) => new TableRow({
      tableHeader: ri === 0,
      children: cells.map((c, ci) => new TableCell({
        width: { size: widths[ci], type: WidthType.DXA },
        shading: ri === 0 ? { type: ShadingType.CLEAR, fill: GRAY, color: 'auto' } : undefined,
        margins: { top: 60, bottom: 60, left: 90, right: 90 },
        children: cellPara(c, ri === 0)
      }))
    }))
  });
}

const spacer = () => new Paragraph({ spacing: { after: 160 }, children: [] });

// ============ 字段表列宽 ============
const FW = [1750, 2600, 620, 4730];
const FHDR = ['字段名称', '格式与取值范围', '必填', '算法用途与缺失后果'];

// ---------- 表 A ----------
const tableA = [
  FHDR,
  ['volunteer_id',
   '文本，形如 V001。\n全学期内唯一，不重复使用',
   '是',
   '结果回填与姓名对照表的唯一键。沿用现有 Vol 1 至 Vol 40 的做法即可，但建议补零对齐，避免排序时 Vol 10 排在 Vol 2 前面'],
  ['最近地铁站',
   '结构化文本，格式固定为\n「线路号|站名」，\n多个站用英文分号分隔。\n示例：\n10|殷高东路;18|上海财经大学',
   '是',
   '通勤时间矩阵的起点，整个模型的地理输入。\n务必只填地铁站名，不要填小区名、学校名或路名。线路号统一用阿拉伯数字，不要写「Line 10」和「10号线」两种形式混用。\n填多个站的志愿者按到各项目点的最短通勤时间计算，等价于更灵活，不会因为多填而被扣分'],
  ['步行至该站时间',
   '整数，单位分钟。\n多个站按分号顺序一一对应',
   '建议',
   '计入总通勤时间。缺失时按统一默认值 8 分钟估算，会让住在站点旁和走 15 分钟的志愿者被同等对待，影响近距离分配的精度'],
  ['其他就近地铁站或换乘线路',
   '结构化文本，格式同「最近地铁站」。\n若还有其他就近地铁站，或最近站点可换乘的其他地铁线路，请一并写明。\n多个站用英文分号分隔',
   '选填',
   '作为志愿者的补充候选起点，与最近地铁站合并后取到各教学点的最短通勤时间。\n这个字段不需要接入新的地图 API，依赖志愿者自行写明可接受的补充站点或线路。若留空，仅使用最近地铁站计算'],
  ['可用时段',
   '多选，枚举值为\n星期 + 上午/下午/晚上，\n多选用英文分号分隔。\n示例：\n周三下午;周五晚上',
   '是',
   '硬约束，时间不匹配的分配直接排除。\n现有格式 Wednesday Afternoon┋Friday Evening (After 6pm) 中的括号说明需要去掉，括号内容应作为时段定义写在说明页，而不是混在数据里'],
  ['服务起始日期',
   '日期，YYYY-MM-DD',
   '是',
   '本次新增字段，当前最大数据缺口。\n沟通中明确提到「服务周期越长越应该排在最前」，以及上纽大或高中的志愿者放假后无法继续服务。没有这两个日期，目标函数中的稳定性权重完全无法计算，只能退化为所有志愿者一视同仁'],
  ['服务结束日期',
   '日期，YYYY-MM-DD。\n若能坚持整学期则填学期末日期',
   '是',
   '同上。同时用于识别「只能服务前四周」这类志愿者，这类人不适合分配到偏远且难招人的项目点，否则中途空缺的补位成本更高'],
  ['是否老志愿者',
   '布尔，是 / 否',
   '是',
   '用于稳定性加权，以及区分哪些人适合人工劝说去偏远点。\n沟通中提到留存率约 60% 至 70%，这批人是排班时最可靠的资源'],
  ['已服务学期数',
   '整数，0 表示新志愿者',
   '建议',
   '比布尔值更细的稳定性度量。若统计成本高，可只填是否老志愿者'],
  ['历史服务项目点',
   '文本，填 site_id，\n多个用英文分号分隔',
   '老志愿者\n必填',
   '沟通中提到老志愿者与原项目点的学生已有感情，愿意接受更远的通勤。这个字段让模型可以对「回到原项目点」的分配给予奖励，而不是机械地按最短通勤重排'],
  ['是否已人工锁定',
   '布尔，是 / 否',
   '是',
   '沟通中提出希望先手工安排好确定的老志愿者，只让模型算剩下的人。标记为是的志愿者及其占用的班级名额会在求解前直接剔除，既尊重人工判断也减少计算规模'],
  ['锁定的班级',
   '文本，格式 site_id-class_id',
   '锁定者\n必填',
   '同上。用于在求解前扣减对应班级的剩余名额'],
  ['偏好项目点',
   '文本，填 site_id，\n多个用英文分号分隔',
   '选填',
   '作为目标函数中的低权重奖励项。沟通中认为这项也可以完全交给人工微调，因此不设为必填'],
  ['可教科目',
   '待确认，见第五节',
   '待确认',
   '需求描述中提到「老师教不同的科目」，但现有志愿者表和项目点表均无科目字段。若科目约束真实存在，模型需要从单层匹配改为带类型的匹配，结构差异较大']
];

// ---------- 表 B ----------
const tableB = [
  FHDR,
  ['site_id',
   '整数，连续编号',
   '是',
   '项目点唯一键。\n现有表格中编号 12 和 13 直接消失，无法从数据本身判断是录入遗漏还是项目点已关闭，需要口头确认才能解读。建议保留编号，用状态字段表达关闭'],
  ['site_status',
   '单选：在办 / 暂停 / 关闭',
   '是',
   '配合上一条使用。关闭的项目点保留行但不参与求解，既保留历史可追溯性，也消除编号断档带来的歧义'],
  ['项目点名称',
   '文本',
   '是',
   '人工阅读用，不参与计算'],
  ['项目点详细地址',
   '文本，精确到门牌号',
   '是',
   '本次新增字段。用于计算出站后的最后一公里。\n差旅政策只报销出地铁站后 20 至 30 元以内的打车费，说明各项目点的出站成本存在实质差异，仅用地铁站代表项目点位置会系统性低估偏远点的通勤负担'],
  ['最近地铁站',
   '结构化文本，格式与表 A\n完全一致，多站用分号分隔',
   '是',
   '通勤矩阵的终点。项目点填多个站时按最短通勤时间计算，志愿者到达其中任一站即视为匹配。\n现有表格中「Line 15 永德路 or Line 8 沈杜公路」使用单元格内换行加 or 表达，解析脆弱，需要改为分号分隔'],
  ['出站至项目点方式',
   '单选：\n步行 / 需打车 / 需换乘公交',
   '是',
   '与详细地址配合，量化最后一公里成本'],
  ['出站至项目点耗时',
   '整数，单位分钟',
   '是',
   '计入总通勤时间。这段时间在现有数据中完全缺失'],
  ['class_id',
   '文本，形如 class 1，\n在同一项目点内唯一',
   '是',
   '班级唯一键，与 site_id 组合成分配单元'],
  ['上课时段',
   '单选，枚举值必须与表 A\n的可用时段用词完全一致',
   '是',
   '硬约束的匹配依据。\n现有两张表用词不完全对齐，志愿者表写 Friday Evening (After 6pm)，项目点表写 Friday evening，大小写和括号都不一致，必须统一到同一份枚举清单'],
  ['上课精确起止时间',
   '文本，形如 09:00-10:30',
   '是',
   '本次新增字段。上午班是 9 点还是 10 点开始，直接决定 90 分钟通勤的志愿者是否需要 7 点前出门，影响可行性判断和退出风险评估'],
  ['需要志愿者人数',
   '整数，通常为 2',
   '是',
   '班级名额上限'],
  ['最少可开班人数',
   '整数，默认 1',
   '是',
   '沟通中确认单人也可以开班，两人是最优配置，学生难管的项目点可以放三到四人。这个字段让模型能在资源紧张时优先保证覆盖率而不是配满每个班'],
  ['班级科目与年级',
   '待确认，见第五节',
   '待确认',
   '同表 A 的可教科目字段，两者必须同时确认，单独确认一方没有意义'],
  ['学期起止日期',
   '日期，两个字段',
   '是',
   '与志愿者的服务起止日期做区间重叠计算，得出该志愿者实际能覆盖的课次比例'],
  ['学期总上课周次',
   '整数',
   '是',
   '同上，用于把服务周期折算成课次覆盖率']
];

// ---------- 表 C ----------
const tableC = [
  FHDR,
  ['学期标识',
   '文本，如 2025 Spring',
   '是',
   '区分不同学期的历史记录'],
  ['site_id 与 class_id',
   '同表 B',
   '是',
   '定位到具体班级'],
  ['实际分配的志愿者',
   '文本，填当时的 volunteer_id',
   '是',
   '人工排班的实际结果，作为模型效果的对照基准。\n没有这份数据，我们无法证明模型排出来的方案比人工更好，只能主观判断'],
  ['该志愿者当时的地铁站',
   '同表 A 格式',
   '是',
   '用于反算人工方案的总通勤时间。这是唯一能量化「模型节省了多少通勤时间」的方式'],
  ['是否完整服务到学期末',
   '布尔，是 / 否',
   '是',
   '识别中途退出的样本'],
  ['中途退出原因',
   '单选：\n通勤过远 / 时间冲突 /\n个人原因 / 其他 / 无',
   '退出者\n必填',
   '这一列的价值高于表 C 的其他所有字段。\n如果历史上因通勤过远退出的样本集中在某几个项目点或某个通勤时长区间，我们就能用真实数据校准「多长的通勤是不可接受的」，而不是沿用 60 分钟这个凭经验设定的阈值']
];

// ---------- 供需缺口表 ----------
const gapRows = [
  ['时段', '需求名额', '可用志愿者', '缺口'],
  ['周日上午', '16', '11', '-5'],
  ['周六下午', '14', '12', '-2'],
  ['周二上午', '2', '0', '-2'],
  ['周六上午', '8', '11', '+3'],
  ['周一下午', '4', '10', '+6'],
  ['周四下午', '2', '8', '+6'],
  ['周三下午', '4', '11', '+7'],
  ['周日下午', '8', '19', '+11'],
  ['周五晚上', '2', '13', '+11'],
  ['合计', '60', '40 人（每人仅带一班）', '-20']
];

// ---------- 待确认问题 ----------
const qRows = [
  ['编号', '待确认事项', '为什么必须先确认'],
  ['Q1',
   '科目维度是否真实存在。\n若存在，请提供科目清单，以及志愿者与班级两侧的科目字段',
   '优先级最高。这不是一个补充字段，而是决定模型结构的问题。有科目约束时匹配问题从单层二部图变为带类型的多层匹配，求解器建模方式和数据结构都不同。在这一点明确前动手写代码，有较大概率需要推倒重做'],
  ['Q2',
   '地图 API 账号归属。\nkey 由机构申请还是我方提供，费用由谁承担',
   '通勤时间矩阵依赖高德或百度的公交路径规划接口。项目点站点固定，志愿者留存率约 60% 至 70%，因此每学期只需为新增站点增量调用，实际调用量很小，但账号归属需要在开工前定下来，涉及后续运维交接'],
  ['Q3',
   '隐私合规边界。\n将志愿者的地铁站信息发送给第三方地图 API 是否在机构 AI 使用规则允许范围内',
   '机构已明确说明有严格的 AI 使用规则，志愿者姓名一律不出机构。地铁站虽不是姓名，但属于可推断居住区域的信息，需要按同一套规则书面确认一次。若不允许，替代方案是改用本地离线地铁网络图计算，精度略低但数据完全不出机构'],
  ['Q4',
   '能否提供至少一个学期的历史分配结果，含中途退出记录',
   '这是验证模型的唯一途径，也是校准通勤时长阈值的唯一真实数据来源。若确实无法提供，模型仍可交付，但效果好坏只能凭主观感受判断，迭代方向会缺少依据']
];

// ---------- 文档 ----------
const doc = new Document({
  numbering: {
    config: [{
      reference: 'dots',
      levels: [
        { level: 0, format: LevelFormat.BULLET, text: '●', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 420, hanging: 240 } } } },
        { level: 1, format: LevelFormat.BULLET, text: '○', alignment: AlignmentType.LEFT,
          style: { paragraph: { indent: { left: 840, hanging: 240 } } } }
      ]
    }]
  },
  styles: {
    default: {
      document: { run: { size: 21, font: 'Times New Roman' } }
    }
  },
  sections: [{
    properties: {
      page: {
        margin: { top: 1200, bottom: 1200, left: 1080, right: 1080 }
      }
    },
    children: [
      // 封面区
      new Paragraph({
        spacing: { before: 200, after: 100 },
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: '铺路石志愿者调配优化项目', bold: true, size: 34,
          font: { ascii: 'Times New Roman', eastAsia: 'PingFang SC', hAnsi: 'Times New Roman' }
        })]
      }),
      new Paragraph({
        spacing: { after: 240 },
        alignment: AlignmentType.CENTER,
        children: [new TextRun({
          text: '数据需求规格书', bold: true, size: 34,
          font: { ascii: 'Times New Roman', eastAsia: 'PingFang SC', hAnsi: 'Times New Roman' }
        })]
      }),
      new Paragraph({
        spacing: { after: 400 },
        alignment: AlignmentType.CENTER,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: '000000', space: 6 } },
        children: [new TextRun({
          text: '版本 v1.0　　2026 年 7 月 26 日', size: 20,
          font: { ascii: 'Times New Roman', eastAsia: 'PingFang SC', hAnsi: 'Times New Roman' }
        })]
      }),

      h('一、本文档的目的', HeadingLevel.HEADING_1),
      p('本文档面向铺路石项目的需求提出方与排班负责人，用途是明确一件事：要把目前手工完成的志愿者与班级调配工作交给算法来做，机构侧需要提供哪些数据、以什么格式提供、以及哪几个问题必须先给出答复。'),
      p('之所以先出这份文档而不是直接开发，原因是我们收到的《25 Spring SET Allocation Survey》是一份历史样本表。它足以让我们理解业务逻辑，但不足以作为建模依据，且其中缺少若干直接决定模型结构的字段。这些内容在第二节和第五节展开。'),
      p('本文档配有一份空白的 Excel 采集模板，三张表的表头、下拉选项和填写说明均已按本文档设定好，可以直接分发填写。'),

      h('二、为什么不能直接沿用现有表格', HeadingLevel.HEADING_1),
      h('2.1 历史数据的供需结构不代表未来', HeadingLevel.HEADING_2),
      p('我们对现有表格做了一次供需核算。30 个班级、每班需要 2 名志愿者，共 60 个名额；志愿者 40 人，且沟通中确认每人一学期只带一个班。也就是说这份数据的分配上限是 40 个名额，无论算法多好，都有 20 个名额结构性无法填满。分时段看：'),
      spacer(),
      table([1900, 1900, 3000, 1400], gapRows),
      spacer(),
      p('这张表说明周末上午和周六下午是真实瓶颈，周五晚上和周日下午则严重过剩。同时有 14 名志愿者只填了一个可用时段，其中落在过剩时段的人几乎注定闲置。'),
      p('这些结论对当期排班很有价值，但它们完全是这一份历史表的算术结果。沟通中已说明志愿者按春季、暑期、秋季三个学期招募，每学期约有 30% 至 40% 是全新的人，来源随机。下一学期的供需结构可能与此完全不同。把这份表的缺口特征当作模型的设计依据，是有风险的。'),
      p('因此我们需要的是即将实际使用的那一期数据，或者至少是一份按本文档格式补全的历史数据。'),

      h('2.2 缺少三个决定模型结构的字段', HeadingLevel.HEADING_2),
      p('现有表格缺失的字段中，以下三项不属于「有则更好」的补充信息，而是会改变建模方式的关键输入：'),
      bullet('服务起止日期。沟通中反复强调服务周期越长的志愿者应当优先安排，并举例说明高校志愿者放假后无法继续服务。但现有表格中完全没有这两个字段，导致目标函数里的稳定性维度无从计算。'),
      bullet('科目。需求描述中提到志愿者教授不同科目，但志愿者表和项目点表两侧都没有科目字段。若约束真实存在，问题性质从单层匹配变为带类型的匹配。'),
      bullet('老志愿者标记与历史服务项目点。这是实现「人工先锁定老志愿者、模型只算剩余人员」这一诉求的前提，同时也是评估模型效果的对照基准。'),

      h('2.3 现有格式的清洗成本可以一次性消除', HeadingLevel.HEADING_2),
      p('现有表格中有几处格式问题会让每一期数据都产生固定的人工清洗量，这些问题在采集阶段用下拉选项和固定分隔符就能根治，不必留到后端去猜：'),
      bullet('志愿者可补充其他就近地铁站或可换乘线路。该列必须继续使用「线路号|站名」和英文分号分隔，否则程序只能把它当普通文本猜测。'),
      bullet('项目点表用合并单元格表示同一项目点下的多个班级，程序读取时 site 编号一列大量为空，需要向下填充才能还原，容易出错。'),
      bullet('多个地铁站用单元格内换行加 or 或 and 表达，例如「Line 15 永德路 or Line 8 沈杜公路」，解析脆弱。'),
      bullet('两张表的时段用词不一致，志愿者表写 Friday Evening (After 6pm)，项目点表写 Friday evening。'),
      bullet('项目点编号从 11 直接跳到 14，从数据本身无法判断是录入遗漏还是项目点已关闭。'),

      new Paragraph({ children: [new PageBreak()] }),

      h('三、数据交付清单', HeadingLevel.HEADING_1),
      p('以下三张表构成完整的数据交付。表 A 和表 B 是模型运行的必要输入，表 C 用于验证模型效果，重要性略低但强烈建议提供。'),
      p('「必填」一列的含义是：标注为「是」的字段若缺失，该行数据无法参与计算；标注为「建议」的字段缺失时模型会使用默认值，结果仍可产出但精度下降。'),

      h('3.1 表 A：志愿者信息', HeadingLevel.HEADING_2),
      p('每名志愿者一行，不使用合并单元格。'),
      spacer(),
      table(FW, tableA),

      h('3.2 表 B：项目点与班级信息', HeadingLevel.HEADING_2),
      p('每个班级一行。同一项目点下的多个班级需要逐行重复填写 site_id 及项目点相关字段，不使用合并单元格。这样每一行都是一条完整独立的记录，程序读取时不需要做任何还原。'),
      spacer(),
      table(FW, tableB),

      h('3.3 表 C：历史分配结果（用于验证）', HeadingLevel.HEADING_2),
      p('若能提供最近一到两个学期的实际人工排班结果，我们就可以把模型结果与人工结果做直接对比，量化总通勤时间的下降幅度和班级覆盖率的变化。这也是后续迭代的依据。'),
      spacer(),
      table(FW, tableC),

      new Paragraph({ children: [new PageBreak()] }),

      h('四、表格格式的硬性要求', HeadingLevel.HEADING_1),
      p('以下要求与字段内容同等重要。它们的作用是把数据清洗成本从每学期一次降为零次。配套的 Excel 模板已按这些要求配置完毕。'),
      bullet('一个单元格只放一个值。表达多值时统一使用英文分号分隔，不使用换行、不使用 or 或 and、不使用中文分号。'),
      bullet('不使用合并单元格。同一项目点的多个班级逐行重复填写。'),
      bullet('枚举字段一律使用下拉选择，不手工输入。涉及可用时段、上课时段、状态、退出原因等所有单选和多选字段。'),
      bullet('两张表中含义相同的枚举字段必须使用同一份选项清单，用词完全一致，包括大小写和空格。'),
      bullet('所有日期使用 YYYY-MM-DD 格式，不使用「3月1日」或「2026/3/1」等写法。'),
      bullet('所有时间使用 24 小时制 HH:MM，例如 09:00-10:30。'),
      bullet('地铁站一律填写站名本身，不填小区名、学校名或路名。线路号统一使用阿拉伯数字。'),
      bullet('数值字段只填数字，不带单位。单位已在表头中说明。'),
      bullet('不在数据行中插入小标题行、空行或备注行。备注写在专门的备注列里。'),
      bullet('志愿者一律使用编号，不出现真实姓名。编号与姓名的对照表由机构自行保管，不需要提供给我们。'),

      h('五、需要方向性确认的四个问题', HeadingLevel.HEADING_1),
      p('以下四个问题不是数据字段，而是需要机构给出明确答复的决策项。其中 Q1 在答复前不建议开始编码。'),
      spacer(),
      table([760, 2900, 6040], qRows),

      h('六、时间节点', HeadingLevel.HEADING_1),
      p('沟通中提到志愿者招募的时间规律是：春季学期约在 2 月完成收集，暑期在 6 月下旬招募，秋季学期在 7 月底至 8 月初招募与培训。这意味着秋季学期的招募窗口就在当下。'),
      p('由此产生两个可选路径，需要机构选择其一：'),
      bullet('路径一，赶秋季学期。表 A 中新增的字段需要在秋季招募问卷发出前定稿并并入问卷，数据源头一次就是干净的。这条路径时间紧，且需要立刻答复 Q1。'),
      bullet('路径二，目标定在 2027 春季学期。秋季学期先用现有问卷正常招募，我们同期完成通勤矩阵和求解器的开发，用补全后的历史数据做验证；到 2 月春季招募时问卷已改造完成，直接进入实际使用。这条路径更稳妥，也留出了模型迭代的时间。'),
      p('我们的建议是路径二。理由是模型的第一版几乎必然需要一轮迭代，而秋季招募窗口不足以容纳「改问卷、收数据、建模、验证、调整」的完整周期。若在秋季强行上线，反而可能因为效果不佳而影响机构对这套工具的信心。'),

      h('七、后续流程', HeadingLevel.HEADING_1),
      p('数据到位并且四个问题得到答复后，我们的工作按以下顺序推进：'),
      bullet('数据清洗层与通勤时间矩阵。这两块最耗时，但项目点站点固定，矩阵一次算好可以跨学期复用，每学期只需为新增志愿者的新站点做增量补算。'),
      bullet('求解器。采用最小费用流或整数规划，在硬约束下按「班级覆盖率优先、总通勤时间次之、超长通勤惩罚最后」的分层顺序求最优解。规模为几十人对几十个班，求解时间在秒级，且结果可复现、每一条分配都能给出理由。'),
      bullet('结果输出。除了在项目点表的志愿者推荐列回填编号，额外产出两张表：未匹配缺口清单，直接说明哪个项目点哪个时段还缺几人，供招募使用；分配理由表，列出每条分配的通勤时间与换乘次数，供排班负责人做人工微调。'),
      bullet('验证与迭代。用表 C 的历史人工结果做对照，比较总通勤时间与覆盖率，据此调整权重。'),
      spacer(),
      p('本文档中的任何字段，若在实际操作中收集成本过高，请直接反馈。我们可以评估该字段的实际权重，判断是否有替代方案或可以先行省略。'),
      p([{ text: '如需补充或修改本文档，请直接在对应条目上批注后回传。', italics: true }])
    ]
  }]
});

Packer.toBuffer(doc).then(buf => {
  fs.writeFileSync(path.join(__dirname, '铺路石_数据需求规格书_v1.docx'), buf);
  console.log('ok', buf.length);
});
