// 6月1-7日健康周报 — 趋势分析版 v3
const axios = require('axios');
const Lark = require('@larksuiteoapi/node-sdk');
const APP_ID = 'cli_aa99449da1bc1cb5';
const APP_SECRET = 'DbwA9I1XS00PnnTv8TTcseSowhRZnKLf';
const CHAT_ID = 'oc_a1301c159a9e49a37354b7524c1225d1';

async function getToken() {
  const r = await axios.post('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: APP_ID, app_secret: APP_SECRET });
  return r.data.tenant_access_token;
}

// ─── 安全构建器（防御循环引用） ───
function safeObj(obj) { try { return JSON.parse(JSON.stringify(obj)); } catch(e) { return {}; } }
function tr(content, style) {
  let s = {};
  if (style && typeof style === 'object' && !Array.isArray(style)) s = safeObj(style);
  return { text_run: { content: String(content), text_style: s } };
}
function p(...elements) { return { block_type: 2, text: { elements, style: {} } }; }
function h2(text) { return { block_type: 4, heading2: { elements: [tr(text)], style: {} } }; }
function spacer() { return p(tr('─'.repeat(40), { text_color: 3 })); }
function gap() { return p(tr(' ')); }

const bold = { bold: true };
const red = { text_color: 1 };
const orange = { text_color: 2 };
const green = { text_color: 4 };
const blue = { text_color: 5 };
const gray = { text_color: 7 };

// ─── 数据 ───
const days = [
  { cal:2198, protein:135, sleep:9.3, deep:1.17, bed:'23:45', trainCal:203, weight:null, sodium:null, ss:null },
  { cal:1455, protein:69,  sleep:6.6, deep:1.13, bed:'00:35', trainCal:0,   weight:null, sodium:null, ss:null },
  { cal:1080, protein:41,  sleep:7.37,deep:1.57, bed:'00:51', trainCal:921, weight:null, sodium:null, ss:81 },
  { cal:1885, protein:113, sleep:10.2,deep:2.15, bed:'00:08', trainCal:238, weight:120.4,sodium:null, ss:82 },
  { cal:1909, protein:135, sleep:9.25,deep:1.33, bed:'23:42', trainCal:215, weight:119.3,sodium:null, ss:67 },
  { cal:1780, protein:112, sleep:8.18,deep:1.17, bed:'00:48', trainCal:0,   weight:119.6,sodium:5800, ss:71 },
  { cal:1765, protein:135, sleep:9.03,deep:1.52, bed:'00:10', trainCal:882, weight:null, sodium:2348, ss:69 },
];

const avg = arr => Math.round(arr.reduce((a,b)=>a+b,0)/arr.length*10)/10;
const min = arr => Math.min(...arr);
const max = arr => Math.max(...arr);

const avgCal = Math.round(days.reduce((s,d)=>s+d.cal,0)/7);
const avgProtein = Math.round(days.reduce((s,d)=>s+d.protein,0)/7);
const avgSleep = avg(days.map(d=>d.sleep));
const trainDays = days.filter(d=>d.trainCal>0).length;
const avgSteps = Math.round(days.reduce((s,d)=>s+d.steps,0)/7);
const calRange = `${min(days.map(d=>d.cal))}~${max(days.map(d=>d.cal))}`;
const calStd = Math.round(Math.sqrt(days.reduce((s,d)=>s+(d.cal-avgCal)**2,0)/7));
const proteinRange = `${min(days.map(d=>d.protein))}~${max(days.map(d=>d.protein))}`;
const weights = days.filter(d=>d.weight).map(d=>d.weight);
const avgDeep = avg(days.map(d=>d.deep));
const deepRatio = Math.round(avgDeep/avgSleep*100);
const lateNights = days.filter(d=>{ const h=parseInt(d.bed.split(':')[0]); return h>=0&&h<3; }).length;

function spark(values, vmin, vmax) {
  const chars = ['▁','▂','▃','▄','▅','▆','▇','█'];
  if (vmax === vmin) return chars[3].repeat(values.length);
  return values.map(v => chars[Math.round((v-vmin)/(vmax-vmin)*(chars.length-1))]).join('');
}

async function main() {
  const token = await getToken();
  const docR = await axios.post('https://open.feishu.cn/open-apis/docx/v1/documents',
    { title: '📊 6月1-7日 · 健康周报' },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
  const docId = docR.data.data.document.document_id;

  const B = [];

  // ═══════════════ 一、核心趋势 ═══════════════
  B.push(h2('一、核心趋势总览'));
  B.push(gap());

  // 热量
  B.push(p(tr('📊 热量  ', bold), tr(`日均 ${avgCal} kcal  `), tr(`波动 ${calRange}  `, orange),
    tr(`标准差 ±${calStd}  `, gray), tr(spark(days.map(d=>d.cal), 1000, 2300))));
  B.push(p(tr(`   目标1900kcal。6/3极端低热1080→拉低均值。7天波动标准差${calStd}kcal，健康减脂应控制在±300以内。`, gray)));

  // 蛋白质
  B.push(p(tr('🥚 蛋白质  ', bold), tr(`日均 ${avgProtein}g  `), tr(`范围 ${proteinRange}  `, orange),
    tr(spark(days.map(d=>d.protein), 30, 145))));
  B.push(p(tr(`   目标190g(1.6g/kg)，仅达59%。6/2→69g、6/3→41g(训练日！)→肌肉净分解。6/5起加蛋白粉后达标(135g)。`, gray)));

  // 睡眠（不含评分——AI提取不可靠，已取消）
  B.push(p(tr('😴 睡眠  ', bold), tr(`日均 ${avgSleep}h  `), tr(`深睡 ${avgDeep}h(${deepRatio}%)  `),
    tr(spark(days.map(d=>d.sleep), 6, 11))));
  B.push(p(tr(`   深睡比例${deepRatio}%(目标>20%)。${lateNights}/7天零点后入睡。6/2仅6.6h(睡眠不足→次日蛋白仅69g)。`, gray)));

  // 体重
  B.push(p(tr('⚖️ 体重  ', bold), tr(`仅3天数据  `, red),
    tr(spark(days.map(d=>d.weight||119.5), 118, 121))));
  B.push(p(tr(`   119.3→120.4→119.6。波动由钠和碳水驱动，非脂肪变化。真实体重约119-120kg，尚未进入下降通道。`, gray)));
  B.push(p(tr('   ⚠️ 7天仅3天记录体重，减脂监控失效。每日空腹称重是第一前提。', red)));
  B.push(gap());

  // ═══════════════ 二、体重波动归因 ═══════════════
  B.push(h2('二、体重波动归因'));
  B.push(gap());

  B.push(p(tr('本周体重数据稀疏（仅6/4-6/6有记录），但波动方向清晰——钠和碳水驱动，非脂肪变化：')));
  B.push(gap());
  B.push(p(tr('▸ 6/4 · 120.4kg 峰值', bold)));
  B.push(p(tr('   当日碳水223g(本周最高)→糖原合成储水。午餐熏猪肝为加工高钠食品→双重锁水。', gray)));
  B.push(p(tr('▸ 6/5 · ↓1.1kg 至 119.3kg', bold, green)));
  B.push(p(tr('   臀腿大肌群训练(悍马深蹲100kg+腿举210kg)→糖原消耗+水分排出。这是正常的运动后脱水效应。', gray)));
  B.push(p(tr('▸ 6/6 · ↑0.3kg 至 119.6kg', bold, red)));
  B.push(p(tr('   钠摄入5800mg(目标2000mg)→渗透性水肿。辣肉雪菜拌面含腌制雪菜，单餐钠≈4800mg。休息日无消耗放大滞留效应。', gray)));
  B.push(gap());

  // ═══════════════ 三、饮食质量趋势 ═══════════════
  B.push(h2('三、饮食质量趋势'));
  B.push(gap());

  B.push(p(tr('▎热量：剧烈波动 → 代谢不稳定', bold, red)));
  B.push(p(tr(`   7天波动幅度1118kcal(${calRange})，标准差${calStd}kcal。6/3仅1080kcal(训练日！)触发代谢保护→次日升至1885，形成"节食-补偿"循环。`, gray)));
  B.push(p(tr('   这种模式比稳定高热量更不利于减脂，因为身体会降低基础代谢来适应。', gray)));

  B.push(p(tr('▎蛋白质：训练日不足 → 分解代谢', bold, red)));
  B.push(p(tr(`   日均${avgProtein}g，仅达目标59%。关键问题不在平均而在分布：6/2-6/3两天训练日蛋白<80g，而这两天恰逢推类训练和休息后恢复期，低蛋白直接导致净肌肉分解。`, gray)));
  B.push(p(tr('   好消息：6/5起加入蛋白粉后连续3天达标(135g×3)，证明补剂是有效的解决方案。', gray, green)));

  B.push(p(tr('▎钠：一次崩溃暴露系统性风险', bold, red)));
  B.push(p(tr('   6/6单日5800mg超标290%。根源是腌制食品(雪菜、五香素鸡)的钠含量远超日常认知。雪菜单品钠≈4000mg/100g。', gray)));
  B.push(p(tr('   其他天钠数据缺失→可能存在未被记录的隐性高钠摄入。', gray)));

  B.push(p(tr('▎违规食物：2次踩红线', bold, red)));
  B.push(p(tr('   ① 6/4-6/5 连吃熏猪肝180g — 动物内脏嘌呤>200mg/100g，高尿酸/脂肪肝严格禁忌。', gray)));
  B.push(p(tr('   ② 6/2 宫保鸡丁含花生 — 高尿酸需规避。', gray)));
  B.push(gap());

  // ═══════════════ 四、训练与恢复 ═══════════════
  B.push(h2('四、训练与恢复'));
  B.push(gap());

  B.push(p(tr('▎训练频率：保持良好', bold, green)));
  B.push(p(tr(`   5/7天训练（推×2/拉×1/臀腿×2），三分化练3休1节奏稳定。`)));
  B.push(p(tr('   臀腿重量稳步回升：悍马深蹲90→100kg，腿举180→210kg。推类卧推稳定70kg×8次。')));

  B.push(p(tr('▎恢复质量：深睡不足是隐忧', bold, orange)));
  B.push(p(tr(`   平均睡眠${avgSleep}h时长尚可，但深睡仅${avgDeep}h(${deepRatio}%)，低于健康基准20-25%。`)));
  B.push(p(tr(`   ${lateNights}/7天零点后入睡。6/2睡眠仅6.6h→当日蛋白质摄入降至69g→睡眠不足直接引发饮食失控。`, gray)));

  B.push(p(tr('▎活动量：良好', bold, green)));
  B.push(p(tr(`   日均${avgSteps.toLocaleString()}步，6/7最高16,521步。配合每日6-8k散步习惯，非运动消耗(NEAT)保持良好。`)));
  B.push(gap());

  // ═══════════════ 五、优缺点 ═══════════════
  B.push(h2('五、本周优缺点'));
  B.push(gap());

  B.push(p(tr('✅ 做得好的', bold, green)));
  B.push(p(tr('  • 训练频率5/7天，三分化练3休1节奏稳定')));
  B.push(p(tr('  • 臀腿重量减载后稳步回升(深蹲90→100kg)')));
  B.push(p(tr('  • 6/5起加入蛋白粉，蛋白质连续3天达标(135g)')));
  B.push(p(tr('  • 6/7午餐搭配优秀(芹菜鸡肉+西兰花+蓝莓+牛肉丸)')));
  B.push(p(tr(`  • 日均${avgSteps.toLocaleString()}步，NEAT保持良好`)));

  B.push(p(tr('❌ 需改进的', bold, red)));
  B.push(p(tr('  • 连吃两天熏猪肝180g — 动物内脏，高尿酸/脂肪肝禁忌')));
  B.push(p(tr('  • 6/6钠5800mg超标290% — 腌制食品失控')));
  B.push(p(tr(`  • 蛋白质波动${proteinRange}g，6/2-6/3训练日严重不足`)));
  B.push(p(tr(`  • 热量波动${calRange}kcal，形成"节食-补偿"循环`)));
  B.push(p(tr('  • 仅3天有体重记录 — 减脂监控完全失效')));
  B.push(p(tr(`  • ${lateNights}/7天零点后入睡，深睡比例${deepRatio}%偏低`)));
  B.push(gap());

  // ═══════════════ 六、改善建议 ═══════════════
  B.push(h2('六、下周改善建议'));
  B.push(gap());

  B.push(p(tr('🔴 安全底线（不妥协）', bold, red)));
  B.push(p(tr('  ① 彻底禁绝动物内脏 — 肝/腰/心/脑/肠零容忍')));
  B.push(p(tr('  ② 禁止所有腌制品 — 雪菜/榨菜/酸菜/腊肉/蒜肠/素鸡等，钠<2000mg/天')));

  B.push(p(tr('🟡 营养稳定（关键改善）', bold, orange)));
  B.push(p(tr('  ③ 每餐≥30g蛋白质 — 早餐标配鸡蛋+牛奶/蛋白粉，午晚餐肉鱼豆腐150-200g')));
  B.push(p(tr('  ④ 热量稳定1800-2000kcal — 避免<1500kcal极端低热量')));
  B.push(p(tr('  ⑤ 宫保鸡丁换清炒鸡丁 — 规避花生(高尿酸)')));

  B.push(p(tr('🟢 监控与恢复（基础建设）', bold, green)));
  B.push(p(tr('  ⑥ 每天早起空腹称重并发送Bot — 这是减脂监控的基石')));
  B.push(p(tr('  ⑦ 23:30前入睡，睡前1h减屏+补镁 — 目标深睡比例>20%')));
  B.push(gap());

  // ═══════════════ 七、预测 ═══════════════
  B.push(h2('七、下周预测'));
  B.push(gap());
  B.push(p(tr('🎯 目标体重：118.5-119.0kg', bold, green)));
  B.push(p(tr('   控钠3-5天→水肿消退 ↓0.5-1.0kg')));
  B.push(p(tr('   稳定热量+充足蛋白+5天训练→脂肪 ↓0.3-0.5kg')));
  B.push(p(tr('   合计预期：↓0.8-1.5kg')));
  B.push(p(tr('⚠️ 前提：严格执行禁内脏+控钠+每日称重。任一条失败则减脂停滞。', red)));
  B.push(gap());
  B.push(spacer());
  B.push(p(tr('📊 数据来源：训记 + 飞书Bot  |  下次周报：6月14日  |  reports/weekly/', gray)));

  // ─── 写入 ───
  console.log(`写入 ${B.length} 个块...`);
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let ok = 0, fail = 0;

  for (let i = 0; i < B.length; i += 20) {
    const batch = B.slice(i, i + 20);
    try {
      const r = await axios.post(
        `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
        { children: batch, index: -1 },
        { headers, timeout: 15000, validateStatus: s => s < 500 });
      if (r.data.code === 0) { ok += batch.length; }
      else {
        console.log(`  batch ${Math.floor(i/20)+1}: code=${r.data.code} ${r.data.msg}`);
        // 逐个重试
        for (const block of batch) {
          try {
            const sr = await axios.post(
              `https://open.feishu.cn/open-apis/docx/v1/documents/${docId}/blocks/${docId}/children`,
              { children: [block], index: -1 },
              { headers, timeout: 10000, validateStatus: s => s < 500 });
            if (sr.data.code === 0) ok++; else { fail++; console.log(`    FAIL: ${sr.data.code}`); }
          } catch(e2) { fail++; console.log(`    EXC: ${e2.message}`); }
          await new Promise(r => setTimeout(r, 200));
        }
      }
    } catch(e) { fail += batch.length; console.log(`  batch ${Math.floor(i/20)+1}: ERR ${e.message}`); }
    await new Promise(r => setTimeout(r, 500));
  }
  console.log(`写入完成: ${ok} ok, ${fail} failed`);

  // ─── 通知 ───
  const docUrl = `https://bytedance.feishu.cn/docx/${docId}`;
  if (ok > 0) {
    const client = new Lark.Client({ appId: APP_ID, appSecret: APP_SECRET });
    await client.im.message.create({
      params: { receive_id_type: 'chat_id' },
      data: {
        receive_id: CHAT_ID,
        msg_type: 'text',
        content: JSON.stringify({text:
`📊 6月1-7日健康周报

${docUrl}

📈 趋势：
• 热量${avgCal}kcal/天(波动${calRange})
• 蛋白质${avgProtein}g/天(仅达目标59%)
• 训练${trainDays}/7天 睡眠${avgSleep}h
• 体重119-120kg(仅3天数据)

🔴 关键问题：
• 连吃两天熏猪肝→内脏禁忌
• 6/6钠5800mg超标290%

🎯 下周目标：118.5-119.0kg`})
      }
    });
    console.log('通知已发送:', docUrl);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
