'use strict';
// Works inside the user's logged-in instagram.com tab. No cookies are uploaded.
let scanning=false;
const cookie=name=>(document.cookie.split('; ').find(v=>v.startsWith(name+'='))||'').slice(name.length+1);
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const headers=()=>({
 'x-ig-app-id':'936619743392459',
 'x-csrftoken':decodeURIComponent(cookie('csrftoken')||''),
 'x-requested-with':'XMLHttpRequest',
 'accept':'application/json',
});
async function igJSON(path) {
 const res=await fetch('https://www.instagram.com'+path,{credentials:'include',headers:headers()});
 if(!res.ok){
  if(res.status===429)throw Error('Instagram hız sınırı (429). Bir süre sonra yeniden dene.');
  throw Error('Instagram HTTP '+res.status+'; oturum veya erişim reddedildi.');
 }
 const type=res.headers.get('content-type')||'';
 if(!type.toLowerCase().includes('json'))throw Error('Instagram JSON yerine giriş/doğrulama sayfası döndürdü.');
 const result=await res.json();
 if(!result||typeof result!=='object')throw Error('Instagram boş yanıt döndürdü');
 return result;
}
function validID(id){return /^[0-9]{1,30}$/.test(String(id||''));}
async function accountInfo(id){
 try{
  const r=await igJSON('/api/v1/users/'+id+'/info/');
  if(!r.user||String(r.user.pk??id)!==id)return null;
  return {
   username:typeof r.user.username==='string'?r.user.username:'',
   followers:Number.isSafeInteger(r.user.follower_count)?r.user.follower_count:null,
   following:Number.isSafeInteger(r.user.following_count)?r.user.following_count:null
  };
 }catch{return null}
}
function normalize(u){
 const ids=[u.pk,u.pk_id,u.id].map(x=>x==null?'':String(x)).filter(validID);
 if(!ids.length||typeof u.username!=='string'||!u.username)return null;
 return {id:ids[0],username:u.username,fullName:String(u.full_name||'').slice(0,200)};
}
async function fetchList(id,kind,report){
 const users=new Map(),seenCursors=new Set();
 let cursor='',rank='';
 for(let page=0;page<2000;page++){
  let path='/api/v1/friendships/'+id+'/'+kind+'/?count=50&search_surface=follow_list_page';
  if(cursor)path+='&max_id='+encodeURIComponent(cursor);
  if(rank)path+='&rank_token='+encodeURIComponent(rank);
  const r=await igJSON(path);
  if(!Array.isArray(r.users))throw Error(kind+' listesi Instagram tarafından verilmedi.');
  for(const u of r.users){
   const user=normalize(u);if(user&&!users.has(user.id))users.set(user.id,user);
  }
  await report({phase:kind,pages:page+1,count:users.size});
  if(typeof r.follow_ranking_token==='string')rank=r.follow_ranking_token;
  let next=r.next_max_id??null;
  if(next==null&&r.has_more===true){
   const last=r.users[r.users.length-1];
   next=last?.pk??last?.pk_id??last?.id??null;
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
 const id=decodeURIComponent(cookie('ds_user_id')||'');
 if(!validID(id))throw Error('Instagram oturumu bulunamadı. instagram.com üzerinden normal giriş yap.');
 const profile=await accountInfo(id);
 if(!profile||!profile.username)throw Error('Instagram profil bilgisi okunamadı; sonuçların doğruluğu için tarama durduruldu.');
 const account={id,username:profile.username};
 const following=await fetchList(id,'following',report);
 const followers=await fetchList(id,'followers',report);
 if(profile.followers!==null&&profile.followers>0&&followers.length<Math.ceil(profile.followers*.95))
  throw Error('Eksik takipçi listesi; geçmişe kayıt yapılmadı.');
 if(profile.following!==null&&profile.following>0&&following.length<Math.ceil(profile.following*.95))
  throw Error('Eksik takip edilen listesi; geçmişe kayıt yapılmadı.');
 if((followers.length===0&&profile.followers===null)||(following.length===0&&profile.following===null))
  throw Error('Boş liste doğrulanamadı; geçmişe kayıt yapılmadı.');
 const counts=profile.followers!==null&&profile.following!==null?
  {followers:profile.followers,following:profile.following}:null;
 return {account,followers,following,profileCounts:counts};
}
const notify=async message=>{
 try{return await chrome.runtime.sendMessage(message)}catch(err){return {error:String(err?.message||err)}}
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
