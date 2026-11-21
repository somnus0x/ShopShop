// Each supplied post contributes once. Race and gym belong to the same fitness topic.
const topics = {
  race: ['ฟิตเนส', '#dfff69'], gym: ['ฟิตเนส', '#dfff69'],
  travel: ['เดินทาง', '#c4afff'], trip: ['เดินทาง', '#c4afff'], dogs: ['น้องหมา', '#ffb899'],
  plaid: ['แฟชั่น', '#88dce4'], flowers: ['ดอกไม้', '#ffb2d6'], place: ['สถานที่', '#fff0ba']
};
const placeLabels = {favorite:'ชอบไป', visited:'เคยไป', planned:'อยากไป'};
function recapModel(data) {
  const counts = new Map();
  for (const [index,story] of data.stories.entries()) {
    const [label,color] = topics[story.cue];
    const topic = counts.get(label) || {label,color,count:0,posts:[]};
    topic.count++;
    topic.posts.push(index);
    counts.set(label,topic);
  }
  const overview = data.overview;
  const place = overview.places.find(p=>p.relation==='favorite') || overview.places[0];
  const pick = overview.pick;
  return {
    demo:data.demo, mockGifts:data.mock_gifts, total:data.stories.length, headline:overview.headline,
    groups:[...counts.values()].sort((a,b)=>b.count-a.count),
    place:place ? placeLabels[place.relation]+' · '+place.name : '',
    gift:pick ? {item:pick.item,name:pick.product, brand:pick.brand, price:pick.price, reason:pick.short_reason} : null
  };
}
// Work in logical poster coordinates. Both the browser and the preview generator use this painter.
function paintRecap(context, model, avatar, productImage) {
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
    rows.slice(0,maxLines).forEach((row,i)=>{
      c.fillText(row+(i===maxLines-1 && rows.length>maxLines?'…':''),x,y,width);
      y+=size*step;
    });
    return y;
  }
  rect(0,0,720,900,ink);
  label('shopshop',32,60,44,900,lime,300);
  c.textAlign='right';
  label(model.demo?'จูน  /  โปรไฟล์สมมติ':'จากโพสต์ที่แชร์',688,56,22,700,paper,285);
  c.textAlign='left';
  rect(32,82,656,2,'#618269');

  const hasModel = model.demo && avatar;
  const chartX = hasModel ? 367 : 34;
  const chartW = 688-chartX;
  if(hasModel){
    const w=(avatar.naturalWidth||avatar.width)/4;
    const h=(avatar.naturalHeight||avatar.height)/2;
    c.drawImage(avatar,0,0,w,h,32,103,314,419);
  }
  label('Vibe mix',chartX,136,26,800,lime,chartW);
  block(model.headline,chartX,179,chartW,hasModel?35:48,27,3,800,paper,1.17);

  const chartY = 310;
  const step = model.groups.length>4 ? 31 : 45;
  model.groups.forEach((group,i)=>{
    const y=chartY+i*step;
    label(group.label,chartX,y,22,700,paper,chartW-67);
    c.textAlign='right';
    label(group.count+' / '+model.total,688,y,22,700,group.color,64);
    c.textAlign='left';
    rect(chartX,y+7,chartW,5,'#3b574b');
    rect(chartX,y+7,chartW*group.count/model.total,5,group.color);
  });
  if(model.place)label(model.place,chartX,521,20,700,'#ffcfb4',chartW);
  rect(0,545,720,294,lilac);
  // The perforated edge makes the recommendation read like a detachable gift ticket.
  for(let i=0;i<720;i+=24){c.fillStyle=ink;c.beginPath();c.arc(i+12,545,5,0,Math.PI);c.fill();}
  if(model.gift){
    const gift=model.gift;
    const textX = productImage ? 265 : 35;
    const textW = 685-textX;
    if(productImage){
      c.drawImage(productImage,32,576,210,210);
      label('ภาพจำลองสินค้า',33,815,19,700,ink,210);
    }
    label(gift.brand,textX,598,22,700,ink,textW);
    const end=block(gift.name,textX,641,textW,productImage?34:45,26,2,800,ink,1.10);
    label('฿'+gift.price.toLocaleString('th-TH')+(model.mockGifts?' · ราคาตัวอย่าง':' · ราคาแคตตาล็อก'),textX,end+5,22,700,ink,textW);
    block(gift.reason,textX,end+41,textW,23,20,3,400,ink,1.26);
  }else{
    label('ของขวัญที่เลือกให้',35,613,26,700,ink,640);
    block('ยังไม่มีของที่เข้ากับโพสต์และงบนี้',35,696,640,45,32,2,800,ink,1.2);
  }
  label(model.gift?'ชิ้นนี้ใช่เธอกี่เต็มสิบ?':'เห็นโพสต์นี้แล้ว นึกถึงของขวัญอะไร?',38,874,25,700,lime,600);
  c.restore();
}
