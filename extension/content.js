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
// Scans are bound to the exact Instagram profile currently open in this tab.
// The viewer cookie is NEVER a substitute for a different profile's ID.
function profileFromURL(){
 const match=location.pathname.match(/^\/([A-Za-z0-9._]{1,30})\/?$/);
 const username=match?.[1]||'';
 const reserved=new Set(['accounts','explore','direct','reels','stories','p','reel','tv','about','developer','legal','privacy','challenge','api','web','graphql','static']);
 if(!validUsername(username)||reserved.has(username.toLowerCase()))
  throw Error('Taramak istediğin Instagram profilini aç (instagram.com/kullaniciadi/). Ana sayfa veya gönderi sayfası taranamaz.');
 return username;
}
function ownProfileInNavigation(username){
 for(const link of document.querySelectorAll('a[href]')){
  const href=link.getAttribute('href')||'';
  let p;
  try{const u=new URL(href,location.origin);if(u.origin!==location.origin)continue;p=u.pathname}
  catch{continue}
  if(p.toLowerCase()!=='/'+username.toLowerCase()+'/')continue;
  const icon=link.querySelector('svg[aria-label="Profile"],svg[aria-label="Profil"]');
  const label=link.getAttribute('aria-label')||'';
  if(icon||/^(Profile|Profil)$/i.test(label))return true;
 }
 // Instagram's own-profile header often contains an Edit Profile control.
 // Its presence is useful confirmation but absence must not be guessed at.
 const header=document.querySelector('main header');
 if(!header)return false;
 for(const el of header.querySelectorAll('a[href],button')){
  const href=el.getAttribute('href')||'';
  const label=((el.getAttribute('aria-label')||'')+' '+(el.textContent||'')).trim();
  if(/^\/accounts\/edit\/?/.test(href)||/^(edit profile|profili düzenle)$/i.test(label))return true;
 }
 return false;
}
async function resolveTargetAccount(){
 const username=profileFromURL();
 const viewerID=decodeURIComponent(cookie('ds_user_id')||'');
 if(!validID(viewerID))throw Error('Önce Instagram hesabına giriş yap.');
 if(ownProfileInNavigation(username))return {id:viewerID,username};
 // A visited profile is not necessarily the signed-in profile.
 // Resolve target ID by username instead of accidentally assigning viewerID.
 const result=await igJSON('/api/v1/users/web_profile_info/?username='+encodeURIComponent(username),'profil');
 const user=result?.data?.user;
 const id=String(user?.id??user?.pk??'');
 const canonical=String(user?.username??'');
 if(!validID(id)||!validUsername(canonical)||canonical.toLowerCase()!==username.toLowerCase())
  throw Error('Açık profilin Instagram ID ve kullanıcı adı doğrulanamadı; yanlış hesaba kayıt yapılmadı.');
 return {id,username:canonical};
}
async function igJSON(path,purpose="takip listesi"){
 const res=await fetch('https://www.instagram.com'+path,{credentials:'include',headers:headers()});
 if(res.status===429){
  const after=res.headers.get('retry-after');
  const hint=after&&/^\d{1,6}$/.test(after)?' Instagram '+after+' saniye beklenmesini istiyor.':'';
  throw Error('Instagram '+purpose+' isteğini 429 (hız sınırı) ile reddetti.'+hint+' Tarama durduruldu, eksik veri kaydedilmedi.');
 }
 if(!res.ok)throw Error('Instagram '+purpose+' HTTP '+res.status+'; oturum veya erişim reddedildi.');
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
async function runScan(report){
 // Lock the visible profile before awaiting ID resolution or network requests.
 const initialPath=location.pathname;
 const account=await resolveTargetAccount();
 const {id}=account;
 if(location.pathname!==initialPath)
  throw Error('Profil sayfası tarama başlamadan değişti; kayıt yapılmadı.');
 const following=await fetchList(id,'following',report);
 await wait(1500);
 const followers=await fetchList(id,'followers',report);
 // Without an independent profile count, an empty page cannot be distinguished
 // from Instagram silently blocking a private endpoint. Do not publish it as truth.
 if(!following.length||!followers.length)
  throw Error('Instagram boş liste döndürdü; eksik veri riskinden dolayı geçmişe kaydedilmedi.');
 if(location.pathname!==initialPath)
  throw Error('Tarama sırasında profil sayfası değişti; veriler kaydedilmedi.');
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
   const data=await runScan(progress=>notify({type:'SCAN_PROGRESS',progress}));
   const answer=await notify({type:'SAVE_SCAN',snapshot:data});
   if(answer?.error)throw Error(answer.error);
  }catch(err){
   await notify({type:'SCAN_ERROR',error:String(err?.message||err).slice(0,350)});
  }finally{scanning=false}
 })();
});
