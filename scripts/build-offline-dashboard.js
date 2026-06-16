// 基于原始看板 HTML 生成离线版本：嵌入健康数据 + fetch 拦截
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 1. 读取原始看板
const originalHtml = fs.readFileSync(path.join(ROOT, 'dashboard/index.html'), 'utf-8');

// 2. 读取预生成数据
const dataJson = fs.readFileSync(path.join(ROOT, 'dashboard/standalone-data.json'), 'utf-8');
const data = JSON.parse(dataJson);

// 3. 构建注入脚本
const injectScript = `
<script>
// ====== 离线数据注入（自动生成） ======
var __HEALTH_DATA__ = ${dataJson};

(function() {
  var _fetch = window.fetch;
  window.fetch = function(url, options) {
    var urlStr = typeof url === 'string' ? url : (url && url.url ? url.url : '');

    // /api/health/daily?date=YYYY-MM-DD
    var dailyMatch = urlStr.match(/\\/api\\/health\\/daily\\?.*date=(\\d{4}-\\d{2}-\\d{2})/);
    if (dailyMatch) {
      var date = dailyMatch[1];
      var record = __HEALTH_DATA__.allData.find(function(r) { return r.date === date; });
      return Promise.resolve({
        ok: true,
        json: function() {
          return Promise.resolve(record ? {
            date: date,
            record: record,
            calorieSummary: record.calorieSummary
          } : {
            date: date,
            record: null,
            calorieSummary: { target: 2000, adjustedTarget: 2000, exerciseBonus: 0, consumed: 0, remaining: 2000, meals: [], percentage: 0, carbs: 0, protein: 0, fat: 0, sodium: 0, sodiumTarget: 2000, sodiumPercentage: 0 }
          });
        }
      });
    }

    // /api/health/trends?days=N
    var trendsMatch = urlStr.match(/\\/api\\/health\\/trends\\?.*days=(\\d+)/);
    if (trendsMatch) {
      var days = parseInt(trendsMatch[1]);
      var trends = days <= 14 ? __HEALTH_DATA__.trends14
        : days <= 30 ? __HEALTH_DATA__.trends30
        : __HEALTH_DATA__.trends90;
      return Promise.resolve({
        ok: true,
        json: function() { return Promise.resolve({ trends: trends }); }
      });
    }

    // /api/health/foods — 食物库（离线不可用，返回空）
    if (urlStr.indexOf('/api/health/foods') !== -1) {
      return Promise.resolve({
        ok: true,
        json: function() { return Promise.resolve({ foods: [], total: 0 }); }
      });
    }

    // 其他请求走原生 fetch（会失败，看板有兜底）
    return _fetch.apply(window, arguments);
  };
})();
</script>`;

// 4. 找到 </body> 前插入
const bodyEnd = originalHtml.lastIndexOf('</body>');
if (bodyEnd === -1) {
  console.error('错误: 未在 index.html 中找到 </body>');
  process.exit(1);
}

const result = originalHtml.slice(0, bodyEnd) + injectScript + '\n</body>\n</html>';

// 5. 写入
fs.writeFileSync(path.join(ROOT, 'dashboard/standalone.html'), result);
fs.writeFileSync(path.join(ROOT, 'docs/index.html'), result);

const size = (fs.statSync(path.join(ROOT, 'docs/index.html')).size / 1024).toFixed(1);
console.log('✅ 离线看板已生成 (docs/index.html): ' + size + ' KB');
console.log('   基于原始 dashboard/index.html，嵌入 ' + data.allData.length + ' 天数据');
