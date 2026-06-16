// 重写 loadBody() 函数，对齐分析页图表规范
const fs = require('fs');
const html = fs.readFileSync('dashboard/index.html', 'utf-8');

const oldFnStart = '  function loadBody(){\n    fetch(\'/api/health/trends?days=30\')';
const oldFnEnd = "    }).catch(function(e){ $('wtLog').textContent='加载失败'; });\n  }";

const startIdx = html.indexOf(oldFnStart);
const endIdx = html.indexOf(oldFnEnd, startIdx);

if (startIdx === -1 || endIdx === -1) {
  console.error('未找到 loadBody 函数');
  process.exit(1);
}

const endPos = endIdx + oldFnEnd.length;

const newFn = `  function loadBody(){
    fetch('/api/health/trends?days=30').then(function(r){return r.json()}).then(function(res){
      var trAll=(res.trends||[]);
      var el=$('wtLog');
      var validWt=trAll.filter(function(t){return t.weight>0});
      if(validWt.length<2){ el.innerHTML='<div style="text-align:center;padding:16px;color:var(--text-muted)">'+I('weight','ico-xl')+'<div style="margin-top:4px">需要至少2天体重记录</div></div>'; return; }
      var l=validWt[validWt.length-1], f=validWt[0], ch=l.weight-f.weight;
      var arr=ch>0?'↑':ch<0?'↓':'→';
      var chCl=ch>0?'var(--danger)':'var(--success)';
      var trendBg=ch>0?'var(--danger-dim)':'var(--success-dim)';

      // ── 体重趋势图：对齐分析页规范（动态宽度、Y轴网格、数据点、均匀X标签）──
      var svgEl=document.createElementNS('http://www.w3.org/2000/svg','svg');
      el.innerHTML='';
      el.appendChild(svgEl);
      var W=el.clientWidth-4||340, H=180;
      svgEl.setAttribute('viewBox','0 0 '+W+' '+H);
      svgEl.classList.add('cht');
      var pad={t:16,r:10,b:28,l:50}, pw=W-pad.l-pad.r, ph=H-pad.t-pad.b, totalN=trAll.length;
      var wMin=Math.min.apply(null,validWt.map(function(t){return t.weight}));
      var wMax=Math.max.apply(null,validWt.map(function(t){return t.weight}));
      var yPad2=Math.max(1.2,(wMax-wMin)*0.25);
      var yMin=wMin-yPad2, yMax=wMax+yPad2, yR=yMax-yMin||1;
      function xPos(i){var iw=pw*0.94,ox=pad.l+pw*0.03;return ox+(totalN===1?iw/2:(i/(totalN-1))*iw);}
      function yPos(w){return pad.t+ph-((w-yMin)/yR)*ph;}

      // 分段（连续有效数据）
      var segments=[], cur=null;
      trAll.forEach(function(t,i){
        if(t.weight>0){
          if(!cur){cur=[];segments.push(cur);}
          cur.push({x:xPos(i),y:yPos(t.weight),date:t.date,w:t.weight,idx:i});
        }else{cur=null;}
      });

      // 连线 + 面积 + 虚线桥接
      var solidLines='', areaPolys='', dashLines='';
      segments.forEach(function(seg){
        var pts=seg.map(function(p){return p.x.toFixed(1)+','+p.y.toFixed(1)}).join(' ');
        solidLines+='<polyline points="'+pts+'" fill="none" stroke="var(--primary)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>';
        var first=seg[0], last=seg[seg.length-1];
        areaPolys+='<polygon points="'+first.x.toFixed(1)+','+(pad.t+ph).toFixed(1)+' '+pts+' '+last.x.toFixed(1)+','+(pad.t+ph).toFixed(1)+'" fill="url(#wtAreaGrad)" opacity="0.35"/>';
      });
      for(var i=1;i<segments.length;i++){
        var prev=segments[i-1][segments[i-1].length-1];
        var next=segments[i][0];
        dashLines+='<line x1="'+prev.x.toFixed(1)+'" y1="'+prev.y.toFixed(1)+'" x2="'+next.x.toFixed(1)+'" y2="'+next.y.toFixed(1)+'" stroke="var(--text-muted)" stroke-width="1.2" stroke-dasharray="3,4" opacity="0.5"/>';
      }

      // Y轴网格线 + 标签（4条均匀分布）
      var yGrid='';
      for(var j=0;j<=4;j++){
        var val=yMin+(yR*j/4);
        var y=yPos(val);
        yGrid+='<line x1="'+pad.l+'" y1="'+y.toFixed(1)+'" x2="'+(pad.l+pw)+'" y2="'+y.toFixed(1)+'" stroke="var(--divider)" stroke-width="0.5"/>';
        yGrid+='<text x="'+(pad.l-6)+'" y="'+(y+3)+'" text-anchor="end" fill="var(--text-muted)" font-size="9">'+val.toFixed(1)+'</text>';
      }

      // X轴日期标签（均匀分布）
      var maxLabels=Math.max(3,Math.floor(pw/28)),gap=Math.max(1,(totalN-1)/(maxLabels-1));
      var labelSet={};
      for(var j=0;j<maxLabels;j++){var idx=Math.round(j*gap);if(idx<totalN)labelSet[idx]=true;}
      if(segments.length>0){
        labelSet[segments[0][0].idx]=true;
        labelSet[segments[segments.length-1][segments[segments.length-1].length-1].idx]=true;
      }
      var xLabels='';
      for(var idx=0;idx<totalN;idx++){
        if(!labelSet[idx])continue;
        var x=xPos(idx),dl=trAll[idx].date.slice(5);
        xLabels+='<text x="'+x.toFixed(1)+'" y="'+(pad.t+ph+12)+'" text-anchor="middle" fill="var(--text-muted)" font-size="8" transform="rotate(-45, '+x.toFixed(1)+', '+(pad.t+ph+12)+')">'+dl+'</text>';
      }

      // 数据点 + 数值标注
      var dots='';
      validWt.forEach(function(t){
        var idx=trAll.indexOf(t);
        var x=xPos(idx),y=yPos(t.weight);
        dots+='<circle cx="'+x.toFixed(1)+'" cy="'+y.toFixed(1)+'" r="3.5" fill="var(--primary)" stroke="#fff" stroke-width="1.5"/>';
        dots+='<text x="'+x.toFixed(1)+'" y="'+(y-7)+'" text-anchor="middle" fill="var(--text-primary)" font-size="9" font-weight="600">'+t.weight.toFixed(1)+'</text>';
      });

      // 坐标轴
      var axis='<line x1="'+pad.l+'" y1="'+pad.t+'" x2="'+pad.l+'" y2="'+(pad.t+ph)+'" stroke="var(--border-strong)" stroke-width="1"/>';
      axis+='<line x1="'+pad.l+'" y1="'+(pad.t+ph)+'" x2="'+(pad.l+pw)+'" y2="'+(pad.t+ph)+'" stroke="var(--border-strong)" stroke-width="1"/>';

      svgEl.innerHTML='<defs><linearGradient id="wtAreaGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="var(--primary)" stop-opacity="0.6"/><stop offset="100%" stop-color="var(--primary)" stop-opacity="0"/></linearGradient></defs>'+axis+yGrid+areaPolys+dashLines+solidLines+dots+xLabels;

      // ── Hero 数值 + 历史列表 ──
      var bmi=(l.weight/1.81/1.81).toFixed(1);
      var listTr=validWt.slice().reverse();
      var heroHtml=
        '<div class="wt-hero">'+
        '<div><span class="wt-hero-num">'+l.weight+'</span><span class="wt-hero-unit"> kg</span></div>'+
        '<div class="wt-trend" style="background:'+trendBg+';color:'+chCl+'">'+arr+' '+Math.abs(ch).toFixed(1)+' kg（30天）</div>'+
        '<div style="font-size:11px;color:var(--text-muted);margin-top:2px">'+l.date+' 最新 · BMI '+bmi+'</div>'+
        '</div>';
      var listHtml=
        '<div style="border-top:1px solid var(--divider);padding-top:8px;max-height:280px;overflow-y:auto">'+
        listTr.map(function(t,i){
          var diff='';
          if(i<listTr.length-1){var d=t.weight-listTr[i+1].weight;if(Math.abs(d)>0.05)diff='<span style="font-size:10px;color:'+(d>0?'var(--danger)':'var(--success)')+'">'+(d>0?'+'+d.toFixed(1):d.toFixed(1))+'</span>';}
          return '<div class="mr"><span class="ml">'+t.date+'</span><span class="mv"><b style="margin-right:6px">'+t.weight+'</b> kg'+diff+'</span></div>';
        }).join('')+'</div>';
      el.innerHTML=heroHtml+svgEl.outerHTML+listHtml;
    }).catch(function(e){ $('wtLog').textContent='加载失败'; });
  }`;

const result = html.slice(0, startIdx) + newFn + html.slice(endPos);
fs.writeFileSync('dashboard/index.html', result);
console.log('✅ loadBody 已重写');
console.log('旧函数长度: ' + (endPos - startIdx) + ' 字符');
console.log('新函数长度: ' + newFn.length + ' 字符');
