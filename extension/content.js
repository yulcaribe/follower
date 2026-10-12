'use strict';
// Runs on a normal, signed-in Instagram tab; no Instagram cookies are uploaded.
let scanning=false;
const cookie=name=>(document.cookie.split('; ').find(v=>v.startsWith(name+'='))||'').slice(name.length+1);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const validID=id=>/^[0-9]{1,30}$/.test(String(id||''));
const validUsername=name=>/^[A-Za-z0-9._]{1,30}$/.test(String(name||''));
const headers=()=>({
 'x-ig-app-id':'936619743392459',
 'x-csrftoken':decodeURIComponent(cookie('csrftoken')||''),
 'x-requested-with':'XMLHttpRequest',
 'accept':'application/json'
});

// Never require /api/v1/users/{id}/info/ to begin a scan: it can return 429
// even when a regular Instagram login is still valid.
function usernameInNavigation(){
 for(const a of document.querySelectorAll('a[href]')){
  const icon=a.querySelector('svg[aria-label="Profile"], svg[aria-label="Profil"]');
  const label=a.getAttribute('aria-label')||'';
  // Restrict image-based detection to the navigation area to avoid feed avatars.
  const image=a.closest('nav') ? a.querySelector('img[alt]') : null;
  if(!icon&&!/^(Profile|Profil)$/i.test(label)&&!image)continue;
  const href=a.getAttribute('href')||'';
  let pathname;
  try{const u=new URL(href,location.origin);if(u.origin!==location.origin)continue;pathname=u.pathname}
  catch{continue}
  const match=pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
  if(!match)continue;
  const username=match[1];
  if(['accounts','explore','direct','reels','stories','p'].includes(username.toLowerCase()))continue;
  if(icon||/^(Profile|Profil)$/i.test(label))return username;
  if(image){
   const alt=image.getAttribute('alt')||'';
   if(/profile picture|profil fotoğraf|profil resmi/i.test(alt))return username;
  }
 }
 return '';
}
function resolveUsername(provided){
 const fromPanel=String(provided||'').trim().replace(/^@/,'');
 if(fromPanel&&!validUsername(fromPanel))throw Error('Instagram kullanıcı adı geçersiz.');
 const fromNavigation=usernameInNavigation();
 if(fromPanel&&fromNavigation&&fromPanel.toLowerCase()!==fromNavigation.toLowerCase())
  throw Error('Yazdığın kullanıcı adı Instagram oturumunun profil bağlantısıyla eşleşmiyor.');
 const name=fromNavigation||fromPanel;
 if(!name)throw Error('Instagram kullanıcı adı sayfadan okunamadı. Eklentide kullanıcı adını girip yeniden dene.');
 return name;
}
async function igJSON(path){
 const res=await fetch('https://www.instagram.com'+path,{credentials:'include',headers:headers()});
 if(res.status===429){
  const after=res.headers.get('retry-after');
  const hint=after&&/^\d{1,6}$/.test(after)?' Instagram '+after+' saniye beklenmesini istiyor.':'';
  throw Error('Instagram takip listesi isteğini 429 (hız sınırı) ile reddetti.'+hint+' Tarama durduruldu, eksik veri kaydedilmedi.');
 }
 if(!res.ok)throw Error('Instagram takip listesi HTTP '+res.status+'; oturum veya erişim reddedildi.');
 const type=res.headers.get('content-type')||'';
 if(!type.toLowerCase().includes('json'))throw Error('Instagram JSON yerine doğrulama/engelleme sayfası döndürdü; tarama kaydedilmedi.');
 const result=await res.json();
 if(!result||typeof result!=='object')throw Error('Instagram boş yanıt döndürdü.');
 return result;
}
function normalize(u){
 const ids=[u.pk,u.pk_id,u.id].map(x=>x==null?'':String(x)).filter(validID);
 if(!ids.length||typeof u.username!=='string'||!validUsername(u.username))return null;
 return {id:ids[0],username:u.username,fullName:String(u.full_name||'').slice(0,200)};
}
async function fetchList(id,kind,report){
 const users=new Map(),seenCursors=new Set();
 let cursor='',rank='';
 await report({phase:kind,pages:0,count:0});
 for(let page=0;page<2000;page++){
  let path='/api/v1/friendships/'+id+'/'+kind+'/?count=50&search_surface=follow_list_page';
  if(cursor)path+='&max_id='+encodeURIComponent(cursor);
  if(rank)path+='&rank_token='+encodeURIComponent(rank);
  const r=await igJSON(path);
  if(!Array.isArray(r.users))throw Error(kind+' listesi Instagram tarafından verilmedi; tarama kaydedilmedi.');
  for(const u of r.users){
   const user=normalize(u);if(user&&!users.has(user.id))users.set(user.id,user);
  }
  await report({phase:kind,pages:page+1,count:users.size});
  if(typeof r.follow_ranking_token==='string')rank=r.follow_ranking_token;
  let next=r.next_max_id??null;
  if(next==null&&r.has_more===true){
   const last=r.users[r.users.length-1];
   next=last?.pk??last?.pk_id??last?.id??null;
   if(next==null)throw Error(kind+' için Instagram sayfalama verisi eksik; tarama kaydedilmedi.');
  }
  if(next==null||next==='')return [...users.values()];
  next=typeof next==='object'?JSON.stringify(next):String(next);
  if(next===cursor||seenCursors.has(next))throw Error(kind+' sayfalaması tekrar etti, kayıt yapılmadı.');
  seenCursors.add(next);cursor=next;
  await wait(1300+Math.floor(Math.random()*1200));
  if(page%5===4)await wait(2500);
 }
 throw Error('Instagram liste sayfalama sınırı aşıldı; eksik sonuç reddedildi.');
}
async function runScan(report,providedUsername=''){
 const id=decodeURIComponent(cookie('ds_user_id')||'');
 if(!validID(id))throw Error('Instagram oturumu bulunamadı. instagram.com üzerinden normal giriş yap.');
 const username=resolveUsername(providedUsername);
 // The ID is taken from the actual signed-in Instagram session, never from the user input.
 const account={id,username};
 const following=await fetchList(id,'following',report);
 await wait(1500);
 const followers=await fetchList(id,'followers',report);
 // Without an independent profile count, an empty page cannot be distinguished
 // from Instagram silently blocking a private endpoint. Do not publish it as truth.
 if(!following.length||!followers.length)
  throw Error('Instagram boş liste döndürdü; eksik veri riskinden dolayı geçmişe kaydedilmedi.');
 return {account,followers,following};
}
const notify=async message=>{
 try{return await chrome.runtime.sendMessage(message)}
 catch(err){return {error:String(err?.message||err)}}
};
chrome.runtime.onMessage.addListener((message,_sender,respond)=>{
 if(message?.type!=='START_SCAN')return;
 if(scanning){respond({ok:false,error:'Tarama zaten çalışıyor'});return}
 scanning=true;
 respond({ok:true});
 (async()=>{
  try{
   const data=await runScan(progress=>notify({type:'SCAN_PROGRESS',progress}),message.username);
   const answer=await notify({type:'SAVE_SCAN',snapshot:data});
   if(answer?.error)throw Error(answer.error);
  }catch(err){
   await notify({type:'SCAN_ERROR',error:String(err?.message||err).slice(0,350)});
  }finally{scanning=false}
 })();
});
