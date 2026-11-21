const canvas=$('scene'),ctx=canvas.getContext('2d'),sheet=$('avatarSheet') || new Image();
const thaiPortrait=document.documentElement.lang==='th';
let yaw=0, pan=0, start=null, downYaw=0, animation=0;
const reduce=window.matchMedia('(prefers-reduced-motion: reduce)');
function draw(){
  animation=0;
  if(!sheet.naturalWidth||!canvas.clientWidth||!canvas.clientHeight)return;
  const w=canvas.clientWidth,h=canvas.clientHeight,dpr=Math.min(window.devicePixelRatio||1,2);
  if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr);}
  ctx.setTransform(dpr,0,0,dpr,0,0);
  const fw=sheet.naturalWidth/4,fh=sheet.naturalHeight/2,frame=(Math.round(yaw)%8+8)%8;
  const sx=frame%4*fw,sy=Math.floor(frame/4)*fh;
  const dw=h*fw/fh,left=(w-dw)/2+(reduce.matches?0:pan*7);
  // Continue the empty studio sweep to the edges of a wide view.
  if(left>0)ctx.drawImage(sheet,sx+1,sy,2,fh,0,0,left+1,h);
  if(w>left+dw)ctx.drawImage(sheet,sx+fw-3,sy,2,fh,left+dw-1,0,w-left-dw+1,h);
  ctx.drawImage(sheet,sx,sy,fw,fh,left,0,dw,h);
  $('pin').style.transform='translateX('+(reduce.matches?0:pan*16)+'px)';
  canvas.setAttribute('aria-label',thaiPortrait?'ตัวละครตัวอย่าง มุมที่ '+(frame+1)+' จาก 8':'Style portrait, view '+(frame+1)+' of 8');
}
function redraw(){if(!animation)animation=requestAnimationFrame(draw);}
sheet.onload=redraw;
if(!sheet.getAttribute('src'))sheet.src='assets/turntable.webp';
if(sheet.complete)redraw();
new ResizeObserver(redraw).observe(canvas);
canvas.onpointerdown=e=>{if(e.button!==0)return;start=e.clientX;downYaw=yaw;canvas.setPointerCapture(e.pointerId);};
canvas.onpointermove=e=>{
  const rect=canvas.getBoundingClientRect();pan=Math.max(-1,Math.min(1,2*(e.clientX-rect.left)/rect.width-1));
  if(start!==null){yaw=downYaw+(e.clientX-start)/Math.max(20,rect.width/12);$('spinlabel').textContent=(thaiPortrait?'ปล่อยเพื่อหยุด':'Release to settle');}
  redraw();
};
function settle(){start=null;yaw=Math.round(yaw);pan=0;$('spinlabel').textContent=(thaiPortrait?'ลากเพื่อหมุน':'Drag to rotate');redraw();}
canvas.onpointerup=settle;canvas.onpointercancel=settle;canvas.onlostpointercapture=settle;
canvas.onpointerleave=()=>{if(start===null){pan=0;redraw();}};
function step(size){yaw=Math.round(yaw)+size;redraw();}
$('prev').onclick=()=>step(-1);$('next').onclick=()=>step(1);
$('portrait').addEventListener('keydown',e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();step(e.key==='ArrowLeft'?-1:1);}});
