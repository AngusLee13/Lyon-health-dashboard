// 生成纯静态健康看板 HTML（自包含，无需服务器）
const fs = require('fs');
const path = require('path');

// 读取预生成的数据
const data = JSON.parse(fs.readFileSync(path.join(__dirname, '../dashboard/standalone-data.json'), 'utf-8'));

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0,user-scalable=no">
<title>健康看板 · ${data.stats.dateRange}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh}
.h{background:linear-gradient(135deg,#1e293b,#0f172a);padding:20px 16px;text-align:center;border-bottom:1px solid #1e293b}
.h h1{font-size:20px;font-weight:700}
.h p{font-size:12px;color:#94a3b8;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;padding:12px 16px}
.stat{background:#1e293b;border-radius:12px;padding:12px 8px;text-align:center}
.stat .v{font-size:22px;font-weight:800}
.stat .l{font-size:10px;color:#94a3b8;margin-top:2px}
.section{padding:16px}
.section h2{font-size:14px;font-weight:600;margin-bottom:12px;color:#94a3b8;text-transform:uppercase;letter-spacing:1px}
.chart{background:#1e293b;border-radius:12px;padding:12px;margin-bottom:12px;overflow-x:auto}
.chart svg{display:block;min-width:320px}
.day{background:#1e293b;border-radius:12px;padding:14px;margin-bottom:10px}
.day .d{font-size:13px;font-weight:600;margin-bottom:8px;color:#94a3b8}
.day .row{display:flex;gap:10px;flex-wrap:wrap}
.day .m{font-size:12px;line-height:1.5}
.day .meals{font-size:11px;color:#94a3b8;margin-top:6px;line-height:1.6}
.day .cal-bar{height:4px;border-radius:2px;margin-top:4px;background:#334155;overflow:hidden}
.day .cal-bar-fill{height:100%;border-radius:2px}
.fasting{display:inline-block;background:rgba(59,130,246,0.2);color:#93c5fd;font-size:10px;padding:1px 6px;border-radius:4px;margin-left:6px;vertical-align:2px}
.red{color:#f87171}.green{color:#34d399}.yellow{color:#fbbf24}.blue{color:#60a5fa}.purple{color:#a78bfa}
.f{text-align:center;padding:20px;font-size:11px;color:#475569}
.mbar{display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:11px}
.mbar-fill{height:4px;border-radius:2px;min-width:1px}
</style>
</head>
<body>
<div class="h">
  <h1>健康看板</h1>
  <p>${data.stats.dateRange} · 共 ${data.stats.totalDays} 天 · 训练 ${data.stats.trainingDays} 天 · 体重变化 ${data.stats.weightChange}kg</p>
</div>

<div class="stats">
  <div class="stat"><div class="v blue">${data.stats.avgSleep}h</div><div class="l">平均睡眠</div></div>
  <div class="stat"><div class="v green">${data.stats.avgWeight}kg</div><div class="l">平均体重</div></div>
  <div class="stat"><div class="v yellow">${data.stats.trainingDays}天</div><div class="l">训练天数</div></div>
</div>

<div class="section">
  <h2>体重趋势</h2>
  <div class="chart" id="weightChart"></div>
</div>

<div class="section">
  <h2>热量 & 缺口</h2>
  <div class="chart" id="calorieChart"></div>
</div>

<div class="section">
  <h2>睡眠</h2>
  <div class="chart" id="sleepChart"></div>
</div>

<div class="section">
  <h2>每日明细</h2>
  <div id="dailyList"></div>
</div>

<div class="f">离线看板 · 生成于 ${new Date(data.generatedAt).toLocaleString('zh-CN')} · 数据更新需重新生成</div>

<script>
var D = ${JSON.stringify(data)};

var SP = ['▁','▂','▃','▄','▅','▆','▇','█'];
function spark(vals) {
  var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
  if (max === min) return SP[3].repeat(vals.length);
  return vals.map(function(v) { return SP[Math.round((v-min)/(max-min)*(SP.length-1))]; }).join('');
}

function drawChart(el, series, opts) {
  opts = opts || {};
  var W = Math.max(el.clientWidth - 24, 320);
  var H = opts.height || 150;
  var pad = {t:20, r:12, b:28, l:40};
  var pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
  var allX = series[0].labels;
  if (allX.length < 2) { el.innerHTML = '<span style="color:#64748b;font-size:12px">数据不足</span>'; return; }

  var allVals = [];
  series.forEach(function(s) { allVals = allVals.concat(s.data.filter(function(v){ return v>0 || !opts.skipZero; })); });
  if (allVals.length === 0) { el.innerHTML = '<span style="color:#64748b;font-size:12px">暂无数据</span>'; return; }

  var min = opts.min !== undefined ? opts.min : Math.min.apply(null, allVals);
  var max = opts.max !== undefined ? opts.max : Math.max.apply(null, allVals);
  var range = max - min || 1;
  min -= range * 0.05;
  max += range * 0.05;

  function xPos(i) { return pad.l + (i / (allX.length - 1)) * pw; }
  function yPos(v) { return pad.t + ph - ((v - min) / (max - min)) * ph; }

  var svg = '<svg width="' + W + '" height="' + H + '">';

  for (var i = 0; i <= 4; i++) {
    var y = pad.t + (ph / 4) * i;
    var val = max - ((max - min) / 4) * i;
    svg += '<line x1="' + pad.l + '" y1="' + y.toFixed(1) + '" x2="' + (pad.l + pw).toFixed(1) + '" y2="' + y.toFixed(1) + '" stroke="#334155" stroke-width="0.5"/>';
    svg += '<text x="' + (pad.l - 4) + '" y="' + (y + 4) + '" text-anchor="end" fill="#64748b" font-size="9">' + (opts.int ? Math.round(val) : val.toFixed(1)) + '</text>';
  }

  series.forEach(function(s) {
    var d = s.data, pts = '';
    for (var i = 0; i < allX.length; i++) {
      if (d[i] === 0 && opts.skipZero) continue;
      pts += xPos(i).toFixed(1) + ',' + yPos(d[i]).toFixed(1) + ' ';
    }
    svg += '<polyline points="' + pts.trim() + '" fill="none" stroke="' + s.color + '" stroke-width="2" stroke-linejoin="round" opacity="0.9"/>';
    for (var i = 0; i < allX.length; i++) {
      if (d[i] === 0 && opts.skipZero) continue;
      svg += '<circle cx="' + xPos(i).toFixed(1) + '" cy="' + yPos(d[i]).toFixed(1) + '" r="3" fill="' + s.color + '"/>';
    }
  });

  if (opts.refLine !== undefined) {
    var ry = yPos(opts.refLine);
    svg += '<line x1="' + pad.l + '" y1="' + ry.toFixed(1) + '" x2="' + (pad.l + pw) + '" y2="' + ry.toFixed(1) + '" stroke="#f87171" stroke-width="1" stroke-dasharray="4,3" opacity="0.6"/>';
    svg += '<text x="' + (pad.l + pw + 2) + '" y="' + (ry + 4) + '" fill="#f87171" font-size="9">' + (opts.refLabel || '') + '</text>';
  }

  for (var i = 0; i < allX.length; i++) {
    if (allX.length <= 14 || i % Math.ceil(allX.length / 8) === 0 || i === allX.length - 1) {
      svg += '<text x="' + xPos(i).toFixed(1) + '" y="' + (H - 8) + '" text-anchor="middle" fill="#64748b" font-size="9">' + allX[i].slice(5) + '</text>';
    }
  }
  svg += '</svg>';
  el.innerHTML = svg;
}

// Weight
(function() {
  var wd = D.allData.filter(function(r){ return r.weight; });
  if (wd.length < 2) { document.getElementById('weightChart').innerHTML='<span style="color:#64748b">需至少2天体重数据</span>'; return; }
  drawChart(document.getElementById('weightChart'), [
    { labels: wd.map(function(r){return r.date}), data: wd.map(function(r){return r.weight}), color: '#34d399' }
  ], { height: 140, refLine: 115, refLabel: '目标115kg' });
})();

// Calories
(function() {
  var cd = D.trends30.filter(function(r){ return r.consumed > 0; });
  if (cd.length < 2) { document.getElementById('calorieChart').innerHTML=''; return; }
  drawChart(document.getElementById('calorieChart'), [
    { labels: cd.map(function(r){return r.date}), data: cd.map(function(r){return r.consumed}), color: '#fbbf24' }
  ], { height: 150, int: true, refLine: 2000, refLabel: '目标2000' });
})();

// Sleep
(function() {
  var sd = D.trends30.filter(function(r){ return r.sleepDuration > 0; });
  if (sd.length < 2) return;
  drawChart(document.getElementById('sleepChart'), [
    { labels: sd.map(function(r){return r.date}), data: sd.map(function(r){return r.sleepDuration}), color: '#a78bfa' }
  ], { height: 140, refLine: 8, refLabel: '目标8h' });
})();

// Daily list
(function() {
  var days = D.allData.slice().reverse();
  var h = '';
  var WD = ['日','一','二','三','四','五','六'];
  days.forEach(function(d) {
    var cal = d.calorieSummary;
    var parts = [];
    if (d.sleep.duration > 0) { var sc = d.sleep.sleepScore ? ' '+d.sleep.sleepScore+'分' : ''; parts.push('<span>😴'+d.sleep.duration+'h'+sc+'</span>'); }
    if (d.training) parts.push('<span>💪'+d.training.calories+'kcal '+d.training.bodyPart+'</span>');
    if (d.cardio) parts.push('<span>🏃'+d.cardio.calories+'kcal '+d.cardio.bodyPart+'</span>');
    if (cal.consumed > 0) {
      var pct = cal.percentage;
      var pctColor = pct > 100 ? '#f87171' : pct > 85 ? '#fbbf24' : '#34d399';
      parts.push('<span>🍽<span style="color:'+pctColor+'">'+cal.consumed+'</span>/'+cal.adjustedTarget+'kcal</span>');
    }
    if (d.weight) {
      var wPrev = null;
      var idx = days.indexOf(d);
      if (idx < days.length - 1) { wPrev = days[idx+1].weight; }
      var wDiff = wPrev ? (d.weight - wPrev) : 0;
      var wArrow = wDiff > 0.1 ? '↑' : wDiff < -0.1 ? '↓' : '';
      parts.push('<span>⚖️'+d.weight+'kg '+wArrow+'</span>');
    }
    if (d.steps) parts.push('<span>👣'+(d.steps/1000).toFixed(1)+'k</span>');

    var mealsH = '';
    if (d.diet && d.diet.meals.length > 0) {
      var lb = {breakfast:'早',lunch:'午',dinner:'晚',snack:'加'};
      mealsH = '<div class="meals">' + d.diet.meals.map(function(m) {
        return (lb[m.time]||m.time) + ':' + m.content + ' ' + Math.round(m.calories) + 'kcal';
      }).join(' · ') + '</div>';
    }

    var calBar = '';
    if (cal.consumed > 0) {
      var barPct = Math.min(cal.percentage, 120);
      var barColor = cal.percentage > 100 ? 'background:#f87171' : cal.percentage > 85 ? 'background:#fbbf24' : 'background:#34d399';
      calBar = '<div class="cal-bar"><div class="cal-bar-fill" style="width:'+barPct+'%;'+barColor+'"></div></div>';
    }

    h += '<div class="day">' +
      '<div class="d">' + d.date + ' 周' + WD[new Date(d.date).getDay()] + (d.fastingDay ? '<span class="fasting">断食</span>' : '') + '</div>' +
      '<div class="row">' + parts.join('') + '</div>' +
      calBar +
      mealsH +
      '</div>';
  });
  document.getElementById('dailyList').innerHTML = h;
})();
</script>
</body>
</html>`;

const outPath = path.join(__dirname, '../dashboard/standalone.html');
fs.writeFileSync(outPath, html);
console.log('静态看板已生成: dashboard/standalone.html');
console.log('大小: ' + (fs.statSync(outPath).size / 1024).toFixed(1) + ' KB');
