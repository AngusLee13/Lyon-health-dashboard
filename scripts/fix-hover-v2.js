const fs = require('fs');
let h = fs.readFileSync('dashboard/index.html', 'utf8');

// 找到并删除旧的悬浮处理代码
// 替换从 "var _vG=null" 开始到 ",true);" 结束的两个 addEventListener 块
h = h.replace(/var _vG=null;document\.addEventListener\("mouseover"[^}]*},true\);document\.addEventListener\("mouseout"[^}]*},true\);/,
  '/* hover replaced by fix-hover-v2 */');

const handler = `
var _vg=null;
document.addEventListener('mouseover',function(e){
  try{
    var t=e.target, tag=t&&t.tagName;
    if(tag!=='rect'&&tag!=='circle')return;
    var w=parseFloat(t.getAttribute('width'));
    if(w&&w>200)return;
    var s=t; while(s&&s.tagName!=='svg')s=s.parentNode;
    if(!s||!s.classList.contains('cht'))return;
    var pg=document.getElementById('page-analytics');
    if(!pg||!pg.classList.contains('on'))return;
    if(!_vg)_vg=document.getElementById('vGuide');
    if(!_vg)return;
    var SR=s.getBoundingClientRect(), TR=t.getBoundingClientRect();
    var hh=SR.height*0.78;
    _vg.style.left=(TR.left+TR.width/2)+'px';
    _vg.style.top=(SR.top+SR.height*0.04)+'px';
    _vg.style.height=hh+'px';
    _vg.style.display='block';
  }catch(e){}
},true);
document.addEventListener('mouseout',function(e){
  try{
    var t=e.target, tag=t&&t.tagName;
    if(tag==='rect'||tag==='circle'){
      var s=t; while(s&&s.tagName!=='svg')s=s.parentNode;
      if(s&&s.classList.contains('cht')){
        var pg=document.getElementById('page-analytics');
        if(pg&&pg.classList.contains('on'))return;
      }
    }
    if(_vg)_vg.style.display='none';
  }catch(e){}
},true);
`;

h = h.replace('/* hover replaced by fix-hover-v2 */', handler);
fs.writeFileSync('dashboard/index.html', h);
console.log('ok');
