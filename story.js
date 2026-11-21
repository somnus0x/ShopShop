const $ = id => document.getElementById(id);
const embedded = window.parent !== window;
let output = null, index = 0, expanded = false, equipped = false;
let drafts = {}, sent = {}, signature = '';
let inquiry = {}, inquiryControl = null, inquiryPending = false, inquiryTimer;
let avatarJob = {}, avatarControl = null, avatarPolling = false, giftChoice = 0;
const sampleAvatarSource = $('avatarSheet').src;
const pending = new Map();
let serial = 0;
let posterFile = null, posterData = null;
function clearShare() {
  posterFile=null;posterData=null;
  $('sharePreview').hidden=true;$('shareStatus').textContent='';
  $('shareCard').setAttribute('aria-expanded','false');
  $('shareCard').textContent='Preparing share card…';
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
  $('shareCard').textContent='Share this card ↗';
  paper.toBlob?.(blob=>{
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
  $('sharePreview').hidden=false;
  $('shareCard').setAttribute('aria-expanded','true');
  $('downloadCard').focus();
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
  window.openai?.setWidgetState?.({signature,index,expanded,equipped,drafts,sent,inquiry,avatarJob,giftChoice});
}
let imageRefs={}, localPhotos=new Map(), showingPhoto='', photoRequest=0;
function toolMetadata(meta){
  return meta?.mcp_tool_result?._meta || meta?.call_tool_result?._meta || meta;
}
function hostImages(meta){
  return meta?.post_images ?? toolMetadata(meta)?.post_images;
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
    if(remotePhoto)displayPhoto(remotePhoto,'Photo from Instagram');
    return;
  }
  $('attachPhoto').textContent=local || ref || remotePhoto?'Replace post photo':'Add post photo ＋';
  if(local){displayPhoto(local.url,'Photo attached to post '+(index+1));return;}
  if(ref && window.openai?.getFileDownloadUrl){
    try{
      const result=await window.openai.getFileDownloadUrl({fileId:ref});
      if(token!==photoRequest)return;
      const raw=typeof result==='string'?result:result?.downloadUrl;
      if(new URL(raw).protocol!=='https:')throw new Error();
      displayPhoto(raw,'Photo shared in chat');return;
    }catch{if(token===photoRequest)$('photoStatus').textContent='We couldn’t open the chat photo. You can attach it here.';}
  }else if(remotePhoto)displayPhoto(remotePhoto,'Photo from Instagram');
  else if(output.demo && index===0)displayPhoto($('juneArt').src,'Illustration for June’s demo profile');
}
$('postPhoto').onerror=()=>{
  if(!$('sourceMedia').hidden){
    $('sourceMedia').hidden=true;$('photoStatus').textContent='We couldn’t display this photo. Try attaching it again.';
  }
};
$('attachPhoto').onclick=()=>$('photoInput').click();
$('photoInput').onchange=async()=>{
  const file=$('photoInput').files[0];$('photoInput').value='';
  if(!file)return;
  const selected=index, data=output;
  if(!['image/png','image/webp','image/jpeg','image/avif','image/gif'].includes(file.type)||file.size>12*1024*1024){
    $('photoStatus').textContent='Choose a PNG, JPEG, WebP, GIF, or AVIF under 12 MB.';return;
  }
  const reader=new FileReader();
  reader.onload=()=>{
    if(output!==data)return;
    const previous=localPhotos.get(selected);
    localPhotos.set(selected,{url:reader.result,version:(previous?.version||0)+1});
    if(index===selected)showPostPhoto();
  };
  reader.onerror=()=>{if(output===data && index===selected)$('photoStatus').textContent='We couldn’t read this file. Choose another image.';};
  reader.readAsDataURL(file);
};
$('sourceLink').onclick=e=>{
  if(embedded && window.openai?.openExternal){e.preventDefault();window.openai.openExternal({href:$('sourceLink').href});}
};
function receive(data,meta){
  if(!data?.status)return;
  const key=JSON.stringify(data);
  const refs=hostImages(meta);
  const control=meta?.avatar_control ?? toolMetadata(meta)?.avatar_control;
  const inquiryMeta=meta?.inquiry_control ?? toolMetadata(meta)?.inquiry_control;
  if(key===signature){
    if(inquiryMeta){inquiryControl=inquiryMeta;renderInquiry();}
    if(control){
      avatarControl=control;
      if(control.job && !avatarPolling && avatarJob.status!=='ready'){
        avatarJob=control.job;renderAvatar();
        if(avatarJob.status==='pending')updateAvatar(true);
      }
    }
    if(refs && JSON.stringify(imageRefs)!==JSON.stringify(refs)){
      imageRefs=refs;if(data.status==='ready')showPostPhoto();
    }
    return;
  }
  imageRefs=refs||{};localPhotos.clear();showingPhoto='';photoRequest++;
  signature=key;output=data;index=data.overview?-1:0;expanded=false;equipped=false;drafts={};sent={};inquiry={};avatarJob={};avatarPolling=false;giftChoice=0;
  avatarControl=control;
  inquiryControl=inquiryMeta;
  inquiryPending=false;clearTimeout(inquiryTimer);
  $('inquiryReceipt').removeAttribute('data-celebrate');
  inquiryFeedback('');
  const state=window.openai?.widgetState;
  if(state?.signature===key && (data.stories?.[state.index] || (data.overview && state.index===-1))){
    index=state.index;expanded=!!state.expanded;equipped=!!state.equipped;drafts=state.drafts||{};sent=state.sent||{};inquiry=state.inquiry||{};avatarJob=state.avatarJob||{};giftChoice=state.giftChoice||0;
  }
  const initialJob=data.avatar_job ?? control?.job;
  if(initialJob && (initialJob.status!=='pending' || initialJob.job_id!==avatarJob.job_id || avatarJob.status!=='ready')){
    avatarJob=initialJob;
  }
  $('ready').hidden=data.status!=='ready';$('waiting').hidden=!$('ready').hidden;
  clearShare();$('shareCard').disabled=true;
  if($('ready').hidden){$('message').textContent=data.message;return;}
  render();
  if(inquiry.ticket)scheduleInquiryCheck();
  if(avatarJob.status==='pending')updateAvatar(true);
  if(data.overview)preparePoster(data).catch(()=>{
    if(output!==data)return;
    $('shareCard').textContent='Share this card ↗';
    $('shareStatus').textContent='This device couldn’t create the share image.';
  });
}
function giftOptions(){
  const context=index===-1?output.overview:output.stories[index];
  return context?.gifts || (context?.pick?[context.pick]:(context?.product?[context]:[]));
}
function activePick(){
  const gifts=giftOptions();
  return gifts[giftChoice] || gifts[0];
}
function giftSlot(){
  return index+':'+(activePick()?.item||'');
}
function renderGiftOptions(show){
  const panel=$('giftOptions');
  const gifts=giftOptions();
  panel.hidden=!show || gifts.length<2;
  if(panel.hidden)return;
  panel.replaceChildren(...gifts.map((gift, option)=>{
    const button=document.createElement('button');
    button.type='button';
    button.setAttribute('aria-pressed',String(option===giftChoice));
    const name=document.createElement('strong');
    name.textContent=gift.product;
    const price=document.createElement('span');
    const detail=gift.over_budget_thb?' · Over budget by ฿'+gift.over_budget_thb:(gift.catalog_fallback?' · Catalog option':'');
    price.textContent='฿'+gift.price.toLocaleString('en-TH')+detail;
    button.append(name,price);
    if(gift.evidence?.length){
      const posts=document.createElement('small');
      posts.textContent='Matched to '+gift.evidence.map(i=>'Post '+(i+1)).join(' · ');
      button.append(posts);
    }
    button.onclick=()=>{
      if(giftChoice===option)return;
      giftChoice=option;equipped=false;render();persist();
      $('product').tabIndex=-1;$('product').focus();
    };
    return button;
  }));
}
function jump(to){
  index=to;giftChoice=0;expanded=to>=0 && !!output.stories[to]?.gifts?.length;equipped=false;render();persist();
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
  showPostPhoto();
  $('meta').textContent=output.demo?'Demo profile':(output.from_instagram?'From Instagram posts':'From posts shared in chat');
  $('handle').textContent=(output.profile.startsWith('@') || output.demo ? output.profile+' · ' : '')+output.network;
  $('counter').textContent=summary?'Overview · '+total+' posts':(index+1)+' / '+total;
  $('segments').replaceChildren(...output.stories.map((_,i)=>{const bar=document.createElement('i');if(summary||i<=index)bar.className='on';return bar;}));
  $('quote').textContent=summary?overview.headline:source.caption;
  $('vibe').hidden=!summary || !overview?.vibe_summary;
  $('vibeSummary').textContent=summary ? (overview.vibe_summary || '') : '';
  $('breakdown').hidden=!summary;
  $('sticker').hidden=summary;
  $('sticker').textContent=summary?'':source.glyph;
  $('surface').setAttribute('aria-labelledby',summary?'quote viewSources':'quote');
  $('viewSources').hidden=!summary;
  $('cue').hidden=summary;
  $('cue').textContent=source?.title||'';
  $('handle').textContent=summary?'Overview for '+output.profile:$('handle').textContent;
  const story=document.querySelector('.story');story.dataset.tone=summary?'summary':String(index%3);
  $('summary').hidden=!summary;$('overviewBack').hidden=summary||!overview;
  if(summary){
    $('likes').replaceChildren(...overview.likes.map(like=>{
      const button=evidenceButton(like.label,like.posts);
      const count=document.createElement('small');
      count.textContent=like.posts.length+' / '+total+' posts';
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
      tag.textContent=placeLabels[place.relation]+' · '+place.posts.length+' posts ↗';
      const tile=document.createElement('div');tile.className='place-tile';
      if(['Chiang Mai','เชียงใหม่'].includes(place.name))tile.classList.add('chiangmai');
      button.textContent=place.name;button.append(tag);
      const map=document.createElement('a');
      map.href='https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(place.name);
      map.target='_blank';map.rel='noopener noreferrer';map.textContent='Open map ↗';
      map.onclick=e=>{if(embedded && window.openai?.openExternal){e.preventDefault();window.openai.openExternal({href:map.href});}};
      tile.append(button,map);return tile;
    }));
  }
  const hasGift=!!s?.product;
  $('open').textContent=hasGift?'What gift fits this post? ↗':(summary?'No gifts found for these posts and budget.':'This post mentions a place.');
  $('open').disabled=!hasGift;
  const showGift=hasGift && (expanded || summary);
  renderGiftOptions(showGift);
  $('makeGiftImage').hidden=!(embedded && showGift && hasGift);
  const clover=s?.item==='clover', livePhoto=s?.image_url;
  const giftPhoto=$('liveGiftArt');
  $('giftVisual').hidden=!clover && !livePhoto;
  $('giftLayout').classList.toggle('with-photo',clover || !!livePhoto);
  giftPhoto.hidden=!livePhoto;
  if(livePhoto){giftPhoto.src=livePhoto;giftPhoto.alt=s.product;}else giftPhoto.removeAttribute('src');
  $('cloverArt').hidden=!clover;$('cloverContext').hidden=!clover;
  $('giftPhotoCredit').textContent=livePhoto?'Merchant photo':'Mockup · On a backpack';
  $('open').hidden=showGift;$('expanded').hidden=!showGift;
  $('expanded').classList.toggle('featured',summary);
  $('close').hidden=summary;
  $('giftLabel').hidden=!summary && !output.mock_gifts;
  $('giftLabel').textContent=s?.over_budget_thb?'Over budget':s?.catalog_fallback?'Catalog option':(output.mock_gifts?'Sample gift':'Gift pick');
  $('shortReason').hidden=!summary;
  $('shortReason').textContent=summary && s ? s.short_reason : '';
  if($('reasonDetail').dataset.pick!==String(index)){
    $('reasonDetail').open=!summary;$('reasonDetail').dataset.pick=String(index);
  }
  $('portrait').hidden=!summary;
  renderAvatar();
  $('profileTop').classList.toggle('with-model',summary);
  if(!hasGift){$('expanded').hidden=true;$('notePanel').hidden=true;$('status').textContent='';return;}
  $('brand').textContent=s.brand;$('product').textContent=s.product;$('price').textContent='฿'+s.price.toLocaleString('en-TH')+(output.mock_gifts?' · Sample price':' · Listed price');
  const posts=s.evidence||[];
  $('citations').hidden=!posts.length;
  const label=document.createElement('span');
  label.textContent='Matched to';
  $('citations').replaceChildren(label,...posts.map(i=>evidenceButton('Post '+(i+1),[i])));
  const demoInquiry=embedded && output.demo_inquiry;
  const overage=s.eligible?'':'Over budget by ฿'+(s.price-output.budget).toLocaleString('en-TH');
  if(overage)$('price').textContent+=' · '+overage;
  $('reason').textContent=s.reason;$('equip').disabled=!s.eligible && !demoInquiry;
  $('equip').textContent=s.eligible?(equipped?'✓ Gift selected · Edit note':'Choose this gift ＋'):(demoInquiry?'Try demo inquiry ↗':overage);
  $('notePanel').hidden=!equipped||!showGift;$('note').value=drafts[giftSlot()]??s.note;
  renderInquiry();
  $('status').textContent=sent[giftSlot()]?'Gift saved for this session.':'';
}
const avatarMessages = {
  pending: 'Creating the avatar. You can keep browsing gifts.',
  ready: 'Drag or use the arrows to rotate',
  failed: 'Couldn’t create the avatar.',
  expired: 'This avatar is unavailable. Create it again.',
  unavailable: 'Avatar generation is unavailable.',
  busy: 'Another avatar is generating. Try again in a moment.',
  limit_reached: 'The demo has reached its avatar limit.',
  grant_expired: 'This avatar link expired. Open a new ShopShop card.',
  disconnected: 'Couldn’t check the avatar. Try again.',
  image_unavailable: 'Couldn’t load the avatar. Try again.',
};
function renderAvatar(){
  const live=embedded && !!output?.avatar_enabled;
  const available=live && index===-1;
  const finished=avatarJob.status==='ready';
  const pending=avatarJob.status==='pending';
  $('generateAvatar').hidden=!available || finished || pending;
  $('avatarLook').hidden=!available || finished || pending;
  $('avatarLookLabel').hidden=!available || finished || pending;
  $('avatarLook').disabled=avatarPolling;
  $('avatarEmpty').hidden=!live || finished;
  $('avatarEmpty').textContent=pending?'Creating the profile avatar…':avatarMessages[avatarJob.status] || 'Create an avatar from the profile photo';
  $('scene').hidden=live && !finished;
  $('prev').parentElement?.toggleAttribute('hidden',live && !finished);
  $('generateAvatar').disabled=avatarPolling;
  $('generateAvatar').textContent=avatarJob.job_id && !finished?'Check avatar status ↗':'Create avatar ↗';
  $('avatarStatus').hidden=!available || !avatarJob.status;
  $('avatarStatus').textContent=avatarMessages[avatarJob.status]||'';
  const sheet=$('avatarSheet');
  const src=finished?avatarJob.image_url:sampleAvatarSource;
  if(src && sheet.src!==src)sheet.src=src;
}
$('avatarSheet').onerror=()=>{
  if(avatarJob.status!=='ready')return;
  avatarJob={...avatarJob,status:'image_unavailable'};
  renderAvatar();persist();
};
async function avatarTool(name,args){
  const checking=name==='profile_avatar_status';
  const url=(checking && avatarJob.status_url) || avatarControl?.endpoint;
  if(url){
    const endpoint=new URL(url);
    const options={signal:AbortSignal.timeout(8000),credentials:'omit'};
    if(checking){
      endpoint.searchParams.set('id',args.job_id);
    }else{
      options.method='POST';
      options.body=JSON.stringify({grant:avatarControl.grant,look:args.look});
    }
    const response=await fetch(endpoint,options);
    const result=await response.json();
    if(result?.status)return result;
    throw new Error('Railway returned no avatar status');
  }
  let response;
  try{
    response=await request('tools/call',{name,arguments:args});
  }catch(error){
    if(!window.openai?.callTool)throw error;
    response=await window.openai.callTool(name,args);
  }
  const result=response?.structuredContent ?? response;
  if(response?.isError || !result?.status)throw new Error('Missing avatar status');
  return result;
}
async function updateAvatar(resume=false){
  if(!output?.avatar_enabled || avatarPolling)return;
  avatarPolling=true;
  const current=output;
  renderAvatar();
  try{
    let result=resume?{...avatarJob,status:'pending'}:await avatarTool('generate_profile_avatar',{
      profile_url:current.profile_url,cues:current.stories.map(story=>story.cue),
      look:$('avatarLook').value||'neutral',
    });
    for(let attempt=0;current===output;attempt++){
      avatarJob=result;renderAvatar();persist();
      if(result.status!=='pending')break;
      if(attempt>=34)throw new Error('Avatar status timeout');
      await new Promise(resolve=>setTimeout(resolve,4000));
      if(current!==output)return;
      result=await avatarTool('profile_avatar_status',{job_id:result.job_id});
    }
  }catch{
    if(current===output){avatarJob={...avatarJob,status:'disconnected'};persist();}
  }finally{
    if(current===output){avatarPolling=false;renderAvatar();}
  }
}
$('generateAvatar').onclick=()=>updateAvatar(!!avatarJob.job_id && ['pending','disconnected','image_unavailable'].includes(avatarJob.status));
const inquiryStates = {
  queued: ['Inquiry queued', 'We’ll show the reply here when Supason responds.'],
  claimed: ['Inquiry in progress', 'The demo operator is preparing the message.'],
  sent: ['Inquiry sent', 'Waiting for Supason to reply.'],
  needs_attention: ['Inquiry needs attention', 'The demo operator needs to check this request.'],
};
const inquiryErrors = {
  expired: 'This inquiry link has expired. Open a new ShopShop card to try again.',
  denied: 'This inquiry could not be authorized. Open a new ShopShop card to try again.',
  unavailable: 'We couldn’t confirm the inquiry. Try again to check the same request.',
};
function renderInquiry(){
  const demo=embedded && !!output?.demo_inquiry;
  const save=$('save');
  $('inquiryDetails').hidden=!demo;
  save.hidden=demo && !!inquiry.ticket;
  save.disabled=inquiryPending || (demo ? !inquiryControl : embedded || !!sent[giftSlot()]);
  save.textContent=demo?(inquiryPending?'Sending inquiry…':'Send demo inquiry ↗'):(sent[giftSlot()]?'✓ Saved':(embedded?'Inquiry unavailable':'Save gift'));
  const receipt=$('inquiryReceipt');
  receipt.hidden=!demo || !inquiry.ticket;
  if(receipt.hidden)return;
  const replies=inquiry.replies||[];
  const [title,message]=inquiryStates[inquiry.status]||inquiryStates.queued;
  $('inquiryTitle').textContent=replies.length?'Supason replied':title;
  $('inquiryMessage').textContent=replies.length?'':message;
  $('inquiryRefresh').hidden=!!replies.length || inquiry.status==='needs_attention';
  $('inquiryRefresh').disabled=inquiryPending;
  $('inquiryReplies').replaceChildren(...replies.map(reply=>{
    const element=document.createElement('div');
    const message=document.createElement('p');
    message.textContent=reply.text;
    element.append(message);
    if(reply.qr_image_url){
      const qr=document.createElement('img');
      qr.src=reply.qr_image_url;qr.alt='QR code from Supason';
      element.append(qr);
    }
    return element;
  }));
}
function inquiryFeedback(message){
  const feedback=$('inquiryFeedback');
  feedback.textContent=message;
  feedback.hidden=!message;
}
function scheduleInquiryCheck(){
  clearTimeout(inquiryTimer);
  if(!inquiry.ticket || inquiry.replies?.length || inquiry.status==='needs_attention' || (inquiry.checks||0)>=30)return;
  inquiryTimer=setTimeout(()=>{inquiry.checks=(inquiry.checks||0)+1;sendInquiry('status',true);},2000);
}
async function sendInquiry(action, automatic=false){
  if(inquiryPending || !inquiryControl?.endpoint)return;
  const current=inquiry;
  const control=current.control ||= inquiryControl;
  const body=action==='submit'
    ? {action,request_id:control.request_id,grant:control.grant}
    : {action,ticket:current.ticket};
  inquiryPending=true;renderInquiry();persist();
  if(!automatic)inquiryFeedback(action==='submit'?'Sending your demo inquiry…':'Checking for a reply…');
  try{
    const response=await fetch(control.endpoint,{
      method:'POST',body:JSON.stringify(body),credentials:'omit',signal:AbortSignal.timeout(12000),
    });
    const result=await response.json();
    if(current!==inquiry)return;
    if(!response.ok || inquiryErrors[result.status]){
      if(!automatic)inquiryFeedback(inquiryErrors[result.status]||inquiryErrors.unavailable);
      if(result.status==='expired')clearTimeout(inquiryTimer);
      else if(action==='status')scheduleInquiryCheck();
      return;
    }
    if(action==='submit' && !result.ticket)throw new Error('Missing inquiry ticket');
    const accepted=action==='submit' && !current.ticket;
    if(result.ticket)current.ticket=result.ticket;
    current.status=result.status;current.replies=result.replies||[];
    renderInquiry();persist();
    if(accepted)$('inquiryReceipt').setAttribute('data-celebrate','');
    if(action==='submit')inquiryFeedback('');
    else if(!automatic || current.replies.length)inquiryFeedback(current.replies.length?'Supason replied.':'No reply yet.');
    scheduleInquiryCheck();
  }catch{
    if(current===inquiry){
      if(!automatic)inquiryFeedback(inquiryErrors.unavailable);
      if(action==='status')scheduleInquiryCheck();
    }
  }finally{
    if(current===inquiry){inquiryPending=false;renderInquiry();}
  }
}
$('inquiryRefresh').onclick=()=>sendInquiry('status');

function move(by){
  const length=output.stories.length+(output.overview?1:0);
  const offset=output.overview?1:0;
  jump((index+offset+by+length)%length-offset);
  const story=document.querySelector('.story');story.classList.remove('pulse');void story.offsetWidth;story.classList.add('pulse');
}
$('overviewBack').onclick=()=>jump(-1);
$('viewSources').onclick=()=>{move(1);$('surface').focus();};
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
  const prompt='Create a vertical gift card image in jade and lavender inspired by '+gift.product+' by '+gift.brand+'. Use an original product illustration. Keep the card focused on the gift.';
  try{
    if(window.openai?.sendFollowUpMessage)await window.openai.sendFollowUpMessage({prompt});
    else{
      const reply=await request('ui/message',{role:'user',content:[{type:'text',text:prompt}]});
      if(reply?.isError)throw new Error('Host declined');
    }
  }catch{$('status').textContent='Couldn’t open the image request. Try asking ChatGPT in the conversation.';}
  finally{button.disabled=false;}
};
$('equip').onclick=()=>{equipped=true;render();persist();$('note').focus();};
$('note').oninput=()=>{
  drafts[giftSlot()]=$('note').value;
  if(sent[giftSlot()])delete sent[giftSlot()];
  $('status').textContent='';renderInquiry();persist();
};
$('save').onclick=()=>{
  if(inquiryPending || (!activePick()?.eligible && !output?.demo_inquiry))return;
  if(embedded){
    if(!inquiry.ticket)return sendInquiry('submit');
    return;
  }
  sent[giftSlot()]=$('note').value.trim() || true;
  render();persist();
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
    .catch(()=>{if(!output)$('message').textContent='Open ShopShop from its response in ChatGPT.';});
  receive(window.openai?.toolOutput,window.openai?.toolResponseMetadata);
}else receive(fixture);
