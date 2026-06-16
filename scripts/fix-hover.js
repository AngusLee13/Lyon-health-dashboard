const fs = require('fs');
let h = fs.readFileSync('dashboard/index.html', 'utf8');

const handler = `
  var _vG=null, _hl=[];
  function _unhl(){
    for(var i=0;i<_hl.length;i++){
      var o=_hl[i];
      o.el.setAttribute('fill', o.of);
      o.el.style.fontSize=o.fs;
      o.el.style.fontWeight=o.fw;
    }
    _hl=[];
  }
  document.addEventListener('mouseover',function(e){
    try{
      var t=e.target; if(!t||!t.tagName)return;
      if(t.tagName!=='rect'&&t.tagName!=='circle'&&t.tagName!=='path')return;
      // 跳过全宽背景色区（钠图的zone rect）和面积path
      if(t.tagName==='rect'){
        var w=parseFloat(t.getAttribute('width'));
        if(w&&w>200)return; // 全宽背景rect，非数据柱
      }
      var svg=t; while(svg&&svg.tagName!=='svg')svg=svg.parentNode;
      // 仅分析页图表生效
      if(!svg||!svg.classList.contains('cht'))return;
      var page=svg.closest('#page-analytics');
      if(!page||!page.classList.contains('on'))return;
      if(!_vG)_vG=document.getElementById('vGuide');
      if(!_vG)return;
      var pr=page.getBoundingClientRect();
      var sr=svg.getBoundingClientRect();
      var tr=t.getBoundingClientRect();
      var cx=tr.left+tr.width/2;
      // 虚线限制在图表SVG范围内
      _vG.style.left=cx+'px';
      _vG.style.top=(sr.top+2)+'px';
      _vG.style.height=(sr.height*0.82)+'px'; // 不超过底部标签区
      _vG.style.display='block';
      _unhl();
      var ts=svg.querySelectorAll('text');
      var bv=null,bd=null,bvd=45,bdd=65;
      var plotTop=sr.top+14, plotBot=sr.top+sr.height-14;
      for(var i=0;i<ts.length;i++){
        var tx=ts[i], r=tx.getBoundingClientRect();
        var dx=Math.abs(r.left+r.width/2-cx);
        // 数值标签：在绘图区上方半区，小字号
        if(r.top<sr.top+sr.height*0.55&&r.top>plotTop&&dx<bvd){
          var fz=parseInt(tx.getAttribute('font-size')||tx.style.fontSize||'0');
          if(fz>=8&&fz<=22){bvd=dx;bv=tx;}
        }
        // 日期标签：接近底部
        if(r.top>sr.top+sr.height*0.55&&r.top<plotBot&&dx<bdd){bdd=dx;bd=tx;}
      }
      if(bv){
        _hl.push({el:bv, of:bv.getAttribute('fill')||'', fs:bv.style.fontSize, fw:bv.style.fontWeight});
        bv.setAttribute('fill','#fbbf24');
        bv.style.fontSize='13px'; bv.style.fontWeight='800';
      }
      if(bd){
        _hl.push({el:bd, of:bd.getAttribute('fill')||'', fs:bd.style.fontSize, fw:bd.style.fontWeight});
        bd.setAttribute('fill','#fbbf24');
        bd.style.fontSize='10px'; bd.style.fontWeight='700';
      }
    }catch(e){}
  },true);
  document.addEventListener('mouseout',function(e){
    try{
      var t=e.target; if(!t||!t.tagName)return;
      if(t.tagName==='rect'||t.tagName==='circle'||t.tagName==='path'){
        var svg=t; while(svg&&svg.tagName!=='svg')svg=svg.parentNode;
        if(svg&&svg.classList.contains('cht')){
          var page=svg.closest('#page-analytics');
          if(page&&page.classList.contains('on'))return;
        }
      }
      if(_vG)_vG.style.display='none';
      _unhl();
    }catch(e){}
  },true);
`;

h = h.replace('// 图表悬浮暂时禁用', handler);
fs.writeFileSync('dashboard/index.html', h);
console.log('ok');
