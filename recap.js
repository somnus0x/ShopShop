// Each supplied post contributes once. Race and gym belong to the same fitness topic.
const topics = {
  race: ['ฟิตเนส', '#dfff69'], gym: ['ฟิตเนส', '#dfff69'],
  travel: ['เดินทาง', '#c4afff'], dogs: ['น้องหมา', '#ffb899'],
  plaid: ['แฟชั่น', '#88dce4'], flowers: ['ดอกไม้', '#ffb2d6'], place: ['สถานที่', '#fff0ba']
};
const placeLabels = {favorite:'ชอบไป', visited:'เคยไป', planned:'อยากไป'};
function recapModel(data) {
  const counts = new Map();
  for (const story of data.stories) {
    const [label,color] = topics[story.cue];
    const topic = counts.get(label) || {label,color,count:0};
    topic.count++;
    counts.set(label,topic);
  }
  const overview = data.overview;
  const place = overview.places.find(p=>p.relation==='favorite') || overview.places[0];
  const pick = overview.pick;
  return {
    demo:data.demo, total:data.stories.length, headline:overview.headline,
    groups:[...counts.values()].sort((a,b)=>b.count-a.count),
    place:place ? placeLabels[place.relation]+' · '+place.name : '',
    gift:pick ? {name:pick.product, brand:pick.brand, price:pick.price, reason:pick.short_reason} : null
  };
}
function ringGradient(model) {
  let angle = 0;
  return 'conic-gradient(from -90deg,'+model.groups.map(g=>{
    const start = angle;
    angle += 360*g.count/model.total;
    return g.color+' '+start+'deg '+angle+'deg';
  }).join(',')+')';
}
// Work in logical poster coordinates. Both the browser and the preview generator use this painter.
function paintRecap(context, model, art) {
  const c=context, ink='#102d25', lime='#dfff69', paper='#f9f7eb', lilac='#d4c3ff';
  c.save();
  c.scale(c.canvas.width/720,c.canvas.height/900);
  function rect(x,y,w,h,color){c.fillStyle=color;c.fillRect(x,y,w,h);}
  function font(size,weight){c.font=weight+' '+size+'px Thonburi, "Noto Sans Thai", Arial, sans-serif';}
  function label(str,x,y,size,weight,color,maxWidth){
    font(size,weight);c.fillStyle=color;c.fillText(str,x,y,maxWidth);
  }
  function lines(str,width) {
    const tokens=typeof Intl.Segmenter==='function'
      ? Array.from(new Intl.Segmenter('th',{granularity:'word'}).segment(str),s=>s.segment) : Array.from(str);
    const result=[];let line='';
    for (const token of tokens){
      if(line && c.measureText(line+token).width>width){result.push(line.trim());line=token.trimStart();}
      else line+=token;
    }
    if(line.trim())result.push(line.trim());
    return result;
  }
  function block(str,x,y,width,size,minSize,maxLines,weight,color,step){
    let rows;
    for(;;size--){font(size,weight);rows=lines(str,width);if(rows.length<=maxLines || size<=minSize)break;}
    c.fillStyle=color;
    for(const row of rows){c.fillText(row,x,y,width);y+=size*step;}
    return y;
  }
  rect(0,0,720,900,ink);
  label('shopshop',38,65,44,900,lime,300);
  c.textAlign='right';label(model.demo?'จูน  /  โปรไฟล์สมมติ':'จากโพสต์ที่แชร์',682,59,22,700,paper,290);c.textAlign='left';
  rect(38,85,644,2,'#618269');
  const clauses=model.headline.split(' ');
  if(clauses.length===2 && clauses.every(t=>t.length>5)){
    label(clauses[0],38,147,50,800,paper,640);
    label(clauses[1],38,207,50,800,paper,640);
  }else block(model.headline,38,154,646,50,36,2,800,paper,1.21);
  label('Vibe mix',40,253,31,800,lime,265);
  label(model.total+' โพสต์ที่แชร์',40,286,20,500,paper,275);
  model.groups.forEach((g,i)=>{
    const sparse=model.groups.length<=3;
    const y=(sparse?343:325)+i*(sparse?54:31);
    rect(41,y-13,14,14,g.color);
    label(g.label,67,y,sparse?29:20,700,paper,145);
    label(String(g.count),237,y,sparse?37:21,700,g.color,62);
  });
  const x=510,y=352,r=132;
  let angle=-Math.PI/2;
  for(const g of model.groups){
    const span=2*Math.PI*g.count/model.total;
    c.beginPath();c.arc(x,y,r,angle+.012,angle+span-.012);c.lineWidth=30;c.strokeStyle=g.color;c.stroke();angle+=span;
  }
  c.save();c.beginPath();c.arc(x,y,109,0,2*Math.PI);c.clip();
  if(art){
    const w=art.naturalWidth||art.width,h=art.naturalHeight||art.height;
    const side=Math.min(w,h)*(model.demo ? 0.81 : 1);
    c.drawImage(art,(w-side)/2,model.demo?0:(h-side)/2,side,side,x-109,y-109,218,218);
  }else{rect(x-110,y-110,220,220,'#235944');label('S',x-32,y+32,91,800,lime,80);}
  c.restore();
  if(model.place)label(model.place,40,514,21,700,paper,640);
  rect(0,540,720,288,lilac);
  // The perforated edge makes the recommendation read like a detachable gift ticket.
  for(let i=0;i<720;i+=24){c.fillStyle=ink;c.beginPath();c.arc(i+12,540,5,0,Math.PI);c.fill();}
  if(model.gift){
    const gift=model.gift;
    label('ของขวัญที่เลือกให้',38,588,23,800,ink,310);
    c.textAlign='right';label('฿'+gift.price.toLocaleString('th-TH')+' · ราคาแคตตาล็อก',682,588,20,700,ink,290);c.textAlign='left';
    label(gift.brand,38,637,24,700,ink,640);
    const end=block(gift.name.replace(' · ',' / '),36,696,700,49,32,2,800,ink,1.08);
    block(gift.reason,38,Math.max(748,end+5),640,23,19,2,400,ink,1.36);
  }else{
    label('ของขวัญที่เลือกให้',38,616,26,700,ink,640);
    block('ยังไม่มีของที่เข้ากับโพสต์และงบนี้',38,705,640,45,32,2,800,ink,1.2);
  }
  label(model.gift?'ชิ้นนี้ใช่เธอกี่เต็มสิบ?':'เห็นโพสต์นี้แล้ว นึกถึงของขวัญอะไร?',38,874,25,700,lime,600);
  c.restore();
}
