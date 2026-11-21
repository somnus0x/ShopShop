const $ = id => document.getElementById(id);
const embedded = window.parent !== window;
let output = null, index = 0, expanded = false, equipped = false, sending = false;
let drafts = {}, sent = {}, signature = '';
let inquiry = {}, inquiryPending = false;
const pending = new Map();
let serial = 0;
let posterFile = null, posterData = null;
function clearShare() {
  posterFile=null;posterData=null;
  $('sharePreview').hidden=true;$('shareStatus').textContent='';
  $('saveImage').removeAttribute('src');$('downloadCard').removeAttribute('href');
}
async function preparePoster(data) {
  const model=recapModel(data);
  const avatar = model.demo ? $('avatarSheet') : null;
  const giftArt = model.gift?.item==='clover' ? $('cloverArt') : null;
  const loadImage = photo => photo?.decode().then(()=>photo,()=>null);
  const [avatarImage,giftImage] = await Promise.all([loadImage(avatar),loadImage(giftArt)]);
  if(output!==data)return;
  const paper=document.createElement('canvas');paper.width=1080;paper.height=1350;
  paintRecap(paper.getContext('2d'),model,avatarImage,giftImage);
  const png=paper.toDataURL('image/png');
  if(output!==data)return;
  posterData=png;
  $('shareCard').disabled=false;
  paper.toBlob(blob=>{
    if(output===data && blob && typeof File==='function')posterFile=new File([blob],'shopshop-gift-mix.png',{type:'image/png'});
  },'image/png');
}
$('shareCard').onclick=async()=>{
  if(!posterData)return;
  const data=output;
  try{
    if(posterFile && navigator.canShare?.({files:[posterFile]})){
      await navigator.share({files:[posterFile]});
      return;
    }
  }catch(error){if(error.name==='AbortError')return;}
  if(output!==data)return;
  $('saveImage').src=posterData;$('downloadCard').href=posterData;
  $('sharePreview').hidden=false;$('downloadCard').focus();
};
function notify(method,params) {
  window.parent.postMessage({jsonrpc:'2.0',method,params},'*');
}
function request(method,params) {
  return new Promise((resolve,reject)=>{
    const id=++serial;
    const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Host timeout'));},6000);
    pending.set(id,{resolve,reject,timer});
    window.parent.postMessage({jsonrpc:'2.0',id,method,params},'*');
  });
}
function persist(){
  window.openai?.setWidgetState?.({signature,index,expanded,equipped,drafts,sent,inquiry});
}
let imageRefs={}, localPhotos=new Map(), showingPhoto='', photoRequest=0;
function hostImages(meta){
  return meta?.post_images ?? meta?.mcp_tool_result?._meta?.post_images ?? meta?.call_tool_result?._meta?.post_images;
}
function displayPhoto(url,credit){
  $('postPhoto').src=url;$('postPhoto').alt=credit;
  $('photoCredit').textContent=credit;$('sourceMedia').hidden=false;
}
async function showPostPhoto(){
  const summary = index === -1;
  const photoIndex = summary ? output.stories.findIndex((_, i) => imageRefs[i]?.image_url) : index;
  const {file_id:ref,image_url:remotePhoto} = imageRefs[photoIndex] || {};
  const local = localPhotos.get(photoIndex);
  const key = JSON.stringify([index,photoIndex,ref,remotePhoto,local?.version]);
  if(showingPhoto===key)return;
  showingPhoto=key;
  const token=++photoRequest;
  $('sourceMedia').hidden=true;$('postPhoto').removeAttribute('src');
  $('photoStatus').textContent='';$('mediaActions').hidden=summary;
  const link=output.stories[index]?.source_url;
  $('sourceLink').hidden=!link;
  if(link)$('sourceLink').href=link;else $('sourceLink').removeAttribute('href');
  if(summary){
    if(remotePhoto)displayPhoto(remotePhoto,'ภาพจากโพสต์ Instagram');
    return;
  }
  $('attachPhoto').textContent=local || ref || remotePhoto?'เปลี่ยนภาพของโพสต์นี้':'เพิ่มภาพของโพสต์นี้ ＋';
  if(local){displayPhoto(local.url,'ภาพที่แนบกับโพสต์ '+(index+1));return;}
  if(ref && window.openai?.getFileDownloadUrl){
    try{
      const result=await window.openai.getFileDownloadUrl({fileId:ref});
      if(token!==photoRequest)return;
      const raw=typeof result==='string'?result:result?.downloadUrl;
      if(new URL(raw).protocol!=='https:')throw new Error();
      displayPhoto(raw,'ภาพต้นทางจากไฟล์ที่แชร์ในแชต');return;
    }catch{if(token===photoRequest)$('photoStatus').textContent='เปิดภาพจากแชตไม่ได้ แนบภาพของโพสต์นี้ได้';}
  }else if(remotePhoto)displayPhoto(remotePhoto,'ภาพจากโพสต์ Instagram');
  else if(output.demo && index===0)displayPhoto($('juneArt').src,'ภาพประกอบโปรไฟล์สมมติของจูน');
}
$('postPhoto').onerror=()=>{
  if(!$('sourceMedia').hidden){
    $('sourceMedia').hidden=true;$('photoStatus').textContent='แสดงภาพไม่ได้ ลองแนบภาพของโพสต์นี้อีกครั้ง';
  }
};
$('attachPhoto').onclick=()=>$('photoInput').click();
$('photoInput').onchange=async()=>{
  const file=$('photoInput').files[0];$('photoInput').value='';
  if(!file)return;
  const selected=index, data=output;
  if(!['image/png','image/webp','image/jpeg','image/avif','image/gif'].includes(file.type)||file.size>12*1024*1024){
    $('photoStatus').textContent='เลือกรูป PNG, JPG, WebP, GIF หรือ AVIF ขนาดไม่เกิน 12 MB';return;
  }
  const reader=new FileReader();
  reader.onload=()=>{
    if(output!==data)return;
    const previous=localPhotos.get(selected);
    localPhotos.set(selected,{url:reader.result,version:(previous?.version||0)+1});
    if(index===selected)showPostPhoto();
  };
  reader.onerror=()=>{if(output===data && index===selected)$('photoStatus').textContent='อ่านไฟล์ไม่ได้ กรุณาเลือกรูปอีกครั้ง';};
  reader.readAsDataURL(file);
};
$('sourceLink').onclick=e=>{
  if(embedded && window.openai?.openExternal){e.preventDefault();window.openai.openExternal({href:$('sourceLink').href});}
};
function receive(data,meta){
  if(!data?.status)return;
  const key=JSON.stringify(data);
  const refs=hostImages(meta);
  if(key===signature){
    if(refs && JSON.stringify(imageRefs)!==JSON.stringify(refs)){
      imageRefs=refs;if(data.status==='ready')showPostPhoto();
    }
    return;
  }
  imageRefs=refs||{};localPhotos.clear();showingPhoto='';photoRequest++;
  signature=key;output=data;index=data.overview?-1:0;expanded=false;equipped=false;drafts={};sent={};inquiry={};
  const state=window.openai?.widgetState;
  if(state?.signature===key && (data.stories?.[state.index] || (data.overview && state.index===-1))){
    index=state.index;expanded=!!state.expanded;equipped=!!state.equipped;drafts=state.drafts||{};sent=state.sent||{};inquiry=state.inquiry||{};
  }
  $('ready').hidden=data.status!=='ready';$('waiting').hidden=!$('ready').hidden;
  $('merchantStatus').textContent='';
  $('merchantReplies').replaceChildren();
  clearShare();$('shareCard').disabled=true;
  if($('ready').hidden){$('message').textContent=data.message;return;}
  render();
  if(data.overview)preparePoster(data).catch(()=>{$('shareStatus').textContent='สร้างภาพแชร์ไม่ได้ในอุปกรณ์นี้';});
}
function activePick(){
  return index===-1 ? output.overview.pick : output.stories[index];
}
function jump(to){
  if(sending)return;
  index=to;expanded=false;equipped=false;render();persist();
}
function evidenceButton(label, indices){
  const btn=document.createElement('button');
  btn.textContent=label+' ↗';
  btn.onclick=()=>{jump(indices[0]);$('surface').focus();};
  return btn;
}
function render(){
  const overview=output.overview, summary=index===-1, total=output.stories.length;
  const s=activePick(), source=output.stories[index];
  renderInquiry();
  showPostPhoto();
  $('meta').textContent=output.demo?'โปรไฟล์สมมติ · เดโม':(output.from_instagram?'จากโพสต์ Instagram':'จากโพสต์ที่แชร์ในแชต');
  $('handle').textContent=(output.profile.startsWith('@') || output.demo ? output.profile+' · ' : '')+output.network;
  $('counter').textContent=summary?'ภาพรวม · '+total+' โพสต์':(index+1)+' / '+total;
  $('segments').replaceChildren(...output.stories.map((_,i)=>{const bar=document.createElement('i');if(summary||i<=index)bar.className='on';return bar;}));
  $('quote').textContent=summary?overview.headline:source.caption;
  $('breakdown').hidden=!summary;$('sharing').hidden=!summary;
  $('sticker').hidden=summary;
  $('sticker').textContent=summary?'':source.glyph;
  $('surface').setAttribute('aria-labelledby',summary?'quote cue':'quote');
  $('cue').textContent=summary?'แตะเพื่อดูโพสต์ที่มา':source.title;
  $('handle').textContent=summary?'ภาพรวมของ '+output.profile:$('handle').textContent;
  const story=document.querySelector('.story');story.dataset.tone=summary?'summary':String(index%3);
  $('summary').hidden=!summary;$('overviewBack').hidden=summary||!overview;
  if(summary){
    $('likes').replaceChildren(...overview.likes.map(like=>{
      const button=evidenceButton(like.label,like.posts);
      const count=document.createElement('small');
      count.textContent=like.posts.length+' / '+total+' โพสต์';
      const bar=document.createElement('span');bar.className='post-meter';
      bar.style.setProperty('--count',total);
      for(let i=0;i<total;i++){
        const part=document.createElement('i');
        if(like.posts.includes(i))part.style.background=topics[output.stories[i].cue][1];
        bar.append(part);
      }
      const cue=output.stories[like.posts[0]].cue;
      const thumb=document.createElement('span');thumb.className='interest-thumb '+cue;
      thumb.setAttribute('aria-hidden','true');
      if(!['race','travel','gym'].includes(cue))thumb.textContent=output.stories[like.posts[0]].glyph;
      const name=document.createElement('b');name.textContent=like.label;
      button.textContent='';button.append(thumb,name,count,bar);
      return button;
    }));
    $('likesTitle').hidden=!overview.likes.length;
    const model=recapModel(output);
    const destination=overview.places.find(p=>p.relation==='favorite') || overview.places[0];
    const placeButton=$('recapDetail');
    placeButton.hidden=!destination;
    placeButton.textContent=model.place;
    placeButton.onclick=()=>{jump(destination.posts[0]);$('surface').focus();};
    $('mixLegend').replaceChildren(...model.groups.map(group=>{
      const bar=evidenceButton(group.label,group.posts);
      const count=document.createElement('strong');
      count.textContent=group.count+' / '+model.total;
      const meter=document.createElement('span');
      meter.className='vibe-meter';
      meter.setAttribute('aria-hidden','true');
      meter.style.setProperty('--share',group.count/model.total*100+'%');
      meter.style.setProperty('--topic',group.color);
      bar.append(count,meter);
      return bar;
    }));
    $('whereTitle').hidden=!overview.places.length;
    $('places').replaceChildren(...overview.places.map(place=>{
      const button=evidenceButton(place.name,place.posts);
      const tag=document.createElement('small');
      tag.textContent=placeLabels[place.relation]+' · '+place.posts.length+' โพสต์ ↗';
      const tile=document.createElement('div');tile.className='place-tile';
      if(place.name==='เชียงใหม่')tile.classList.add('chiangmai');
      button.textContent=place.name;button.append(tag);
      const map=document.createElement('a');
      map.href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(place.name);
      map.target='_blank';map.rel='noopener noreferrer';map.textContent='เปิดแผนที่ ↗';
      map.onclick=e=>{if(embedded && window.openai?.openExternal){e.preventDefault();window.openai.openExternal({href:map.href});}};
      tile.append(button,map);return tile;
    }));
  }
  const hasGift=!!s?.product;
  $('open').textContent=hasGift?'เห็นโพสต์นี้แล้ว ให้อะไรดี? ↗':(summary?'ยังไม่มีของที่เข้ากับโพสต์และงบนี้':'โพสต์นี้ให้เบาะแสเรื่องสถานที่');
  $('open').disabled=!hasGift;
  const showGift=expanded || (summary && hasGift);
  $('makeGiftImage').hidden=!(embedded && showGift && hasGift);
  $('giftVisual').hidden=s?.item!=='clover';
  $('giftLayout').classList.toggle('with-photo',s?.item==='clover');
  $('open').hidden=showGift;$('expanded').hidden=!showGift;
  $('expanded').classList.toggle('featured',summary);
  $('close').hidden=summary;
  $('giftLabel').hidden=!summary && !output.mock_gifts;
  $('giftLabel').textContent=s?.over_budget_thb?'ของขวัญตัวอย่างที่ใกล้งบที่สุด':(output.mock_gifts?'ของขวัญตัวอย่าง':'ของขวัญที่เลือกให้');
  $('shortReason').hidden=!summary;
  $('shortReason').textContent=summary && s ? s.short_reason : '';
  if($('reasonDetail').dataset.pick!==String(index)){
    $('reasonDetail').open=!summary;$('reasonDetail').dataset.pick=String(index);
  }
  $('portrait').hidden=!summary;
  $('pin').textContent=output.demo?'สไตล์ของจูน':'โมเดลสไตล์ตัวอย่าง';
  $('profileTop').classList.toggle('with-model',summary);
  if(!hasGift){$('expanded').hidden=true;$('notePanel').hidden=true;$('status').textContent='';return;}
  $('brand').textContent=s.brand;$('product').textContent=s.product;$('price').textContent='฿'+s.price.toLocaleString('th-TH')+(output.mock_gifts?' · ราคาตัวอย่าง':' · ราคาในแคตตาล็อก');
  $('citations').replaceChildren(...(summary?s.evidence:[]).map(i=>evidenceButton('โพสต์ '+(i+1),[i])));
  $('reason').textContent=s.reason;$('equip').disabled=!s.eligible;
  $('equip').textContent=s.eligible?(equipped?'✓ อยู่ในช่องของขวัญ · แก้โน้ต':'ใส่ช่องของขวัญ ＋'):'เกินงบ ฿'+(s.price-output.budget).toLocaleString('th-TH');
  $('notePanel').hidden=!equipped||!showGift;$('note').value=drafts[index]??s.note;
  $('save').disabled=sending||!!sent[index];
  $('save').textContent=sent[index]?'✓ เก็บแล้ว':saveLabel();
  const confirmation=output.mock_gifts
    ? '✓ เลือก '+s.product+' แล้วในโหมดทดลอง'
    : (embedded?'ส่งตัวเลือกนี้เข้าแชตแล้ว':'ตัวอย่างข้อความในแชต · '+sent[index]);
  $('status').textContent=sent[index]?confirmation:'';
}
function saveLabel(){
  return output?.mock_gifts?'ยืนยันของขวัญตัวอย่าง':'ส่งของที่เลือกกับโน้ตเข้าแชต ↗';
}
function renderInquiry(){
  $('merchantDemo').hidden=!(embedded && output?.merchant_demo && index===-1);
  $('merchantForm').hidden=!!inquiry.ticket;
  $('merchantRefresh').hidden=!inquiry.ticket;
}
const merchantStatus = {
  queued:'รอร้านตอบ',claimed:'กำลังดำเนินการ',sent:'ส่งคำถามแล้ว · รอร้านตอบ',
  needs_attention:'ให้ผู้ดูแลตรวจสอบ',expired:'ลิงก์ทดสอบหมดอายุ',
  denied:'รหัสทดสอบไม่ถูกต้อง',unavailable:'เชื่อมต่อคิวร้านไม่ได้ ลองอีกครั้ง'
};
async function callInquiryTool(name, args){
  if(inquiryPending)return;
  inquiryPending=true;
  const current=inquiry;
  $('merchantStatus').textContent='กำลังเชื่อมต่อร้าน…';
  try{
    const response=window.openai?.callTool
      ? await window.openai.callTool(name,args)
      : await request('tools/call',{name,arguments:args});
    if(current!==inquiry)return;
    const result=response?.structuredContent;
    if(response?.isError || !result?.status)throw new Error('Missing inquiry status');
    if(result.ticket){inquiry.ticket=result.ticket;persist();}
    const replies=result.replies||[];
    $('merchantStatus').textContent=replies.length?'ร้านตอบแล้ว':(merchantStatus[result.status]||result.status);
    $('merchantReplies').replaceChildren(...replies.map(reply=>{
      const card=document.createElement('div');
      const message=document.createElement('p');
      message.textContent=reply.text;
      card.append(message);
      if(reply.qr_image_url){
        const qr=document.createElement('img');
        qr.src=reply.qr_image_url;qr.alt='ตัวอย่าง QR จากร้าน';
        card.append(qr);
      }
      return card;
    }));
    renderInquiry();
  }catch{
    if(current===inquiry)$('merchantStatus').textContent=merchantStatus.unavailable;
  }finally{inquiryPending=false;}
}
$('merchantForm').onsubmit=event=>{
  event.preventDefault();
  if(inquiryPending || inquiry.ticket || !output?.merchant_demo)return;
  inquiry.requestId ||= crypto.randomUUID();
  persist();
  const code=$('merchantCode').value;
  $('merchantCode').value='';
  callInquiryTool('start_demo_inquiry',{request_id:inquiry.requestId,demo_code:code});
};
$('merchantRefresh').onclick=()=>{if(inquiry.ticket)callInquiryTool('refresh_demo_inquiry',{ticket:inquiry.ticket});};
function move(by){
  if(sending)return;
  const length=output.stories.length+(output.overview?1:0);
  const offset=output.overview?1:0;
  jump((index+offset+by+length)%length-offset);
  const story=document.querySelector('.story');story.classList.remove('pulse');void story.offsetWidth;story.classList.add('pulse');
}
$('overviewBack').onclick=()=>jump(-1);
$('back').onclick=()=>move(-1);$('forward').onclick=$('surface').onclick=()=>move(1);
$('surface').onkeydown=e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();move(e.key==='ArrowLeft'?-1:1);}};
$('open').onclick=()=>{
  expanded=true;render();persist();$('product').tabIndex=-1;$('product').focus();
  if(embedded)request('ui/request-display-mode',{mode:'fullscreen'}).catch(()=>{});
};
$('close').onclick=()=>{
  expanded=false;render();persist();$('open').focus();
  if(embedded)request('ui/request-display-mode',{mode:'inline'}).catch(()=>{});
};
$('makeGiftImage').onclick=async()=>{
  const gift=activePick();
  if(!embedded || !gift?.product)return;
  const button=$('makeGiftImage');
  button.disabled=true;
  const prompt='ช่วยสร้างภาพการ์ดของขวัญแนวตั้ง โทนเขียวหยกและลาเวนเดอร์ ได้แรงบันดาลใจจาก '+gift.product+' ของ '+gift.brand+' ใช้ภาพประกอบแบบคอนเซปต์ ไม่ใช้ภาพบุคคลหรือข้อความจากโพสต์';
  try{
    if(window.openai?.sendFollowUpMessage)await window.openai.sendFollowUpMessage({prompt});
    else{
      const reply=await request('ui/message',{role:'user',content:[{type:'text',text:prompt}]});
      if(reply?.isError)throw new Error('Host declined');
    }
  }catch{$('status').textContent='ส่งคำขอไม่ได้ ลองขอให้ ChatGPT สร้างภาพการ์ดในแชต';}
  finally{button.disabled=false;}
};
$('equip').onclick=()=>{equipped=true;render();persist();$('note').focus();};
$('note').oninput=()=>{drafts[index]=$('note').value;delete sent[index];$('save').disabled=sending;$('save').textContent=saveLabel();$('status').textContent='';persist();};
$('save').onclick=async()=>{
  if(sending || sent[index] || !activePick()?.eligible)return;
  const s=activePick(), note=$('note').value.trim(), current=signature, selected=index;
  const citations=(index===-1?s.evidence:[index]).map(i=>'“'+output.stories[i].caption+'”').join(' · ');
  const message='เลือก '+s.product+' จาก '+s.brand+' (฿'+s.price+') '+s.reason+'\nจากโพสต์ '+citations+(note?'\nโน้ตที่จะให้: '+note:'');
  sending=true;$('save').disabled=true;$('note').disabled=true;
  try{
    if(embedded && !output.mock_gifts){
      const reply=await request('ui/message',{role:'user',content:[{type:'text',text:message}]});
      if(reply?.isError)throw new Error('Host declined');
    }
    if(signature===current)sent[selected]=message;
  }catch{if(signature===current)$('status').textContent='ยังยืนยันการส่งไม่ได้ เช็กข้อความในแชตก่อนลองใหม่';}
  finally{sending=false;$('note').disabled=false;if(signature===current && sent[selected]){render();persist();}else $('save').disabled=false;}
};
if(embedded){
  window.addEventListener('message',e=>{
    if(e.source!==window.parent||e.data?.jsonrpc!=='2.0')return;
    const m=e.data;
    if(pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(m.error):p.resolve(m.result);return;}
    if(m.method==='ui/notifications/tool-result')receive(m.params?.structuredContent,m.params?._meta);
  });
  window.addEventListener('openai:set_globals',e=>receive(e.detail?.globals?.toolOutput??window.openai?.toolOutput,e.detail?.globals?.toolResponseMetadata??window.openai?.toolResponseMetadata));
  request('ui/initialize',{appInfo:{name:'shopshop',version:'0.1.0'},appCapabilities:{},protocolVersion:'2026-01-26'})
    .then(()=>{notify('ui/notifications/initialized',{});new ResizeObserver(()=>notify('ui/notifications/size-changed',{height:$('app').offsetHeight})).observe($('app'));})
    .catch(()=>{if(!output)$('message').textContent='เปิด shopshop จากคำตอบใน ChatGPT อีกครั้ง';});
  receive(window.openai?.toolOutput,window.openai?.toolResponseMetadata);
}else receive(fixture);
