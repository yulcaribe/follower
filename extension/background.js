'use strict';

// The panel's authenticated browser session is the only permission to write snapshots.
// No extension token, Instagram password or Instagram session cookie goes to the server.
const status=async value=>chrome.storage.session.set({scanStatus:{...value,at:Date.now()}});
function serverOrigin(raw){
 const u=new URL(raw||'');
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')
  throw Error('Follower sunucu adresi geçersiz.');
 return u.origin;
}
async function findPanel(){
 const {server}=await chrome.storage.local.get('server');
 if(!server)throw Error('Önce Follower sunucu adresini kaydet.');
 const origin=serverOrigin(server);
 const tabs=await chrome.tabs.query({});
 const panel=tabs.find(t=>{
  try{const u=new URL(t.url||'');return u.origin===origin && u.pathname==='/'}
  catch{return false}
 });
 if(!panel?.id)throw Error('Follower panelini açıp admin şifrenle giriş yap. Tarama sonucunu o sekme kaydedecek.');
 return panel;
}
async function runOnPanel(func,args=[]){
 const panel=await findPanel();
 try{
  const results=await chrome.scripting.executeScript({
   target:{tabId:panel.id},world:'MAIN',func,args
  });
  if(!results?.length)throw Error('Admin paneli yanıt vermedi.');
  return results[0].result;
 }catch(err){
  throw Error('Follower paneline erişilemiyor. Sekme açık ve admin girişi yapılmış olmalı. '+String(err?.message||err).slice(0,100));
 }
}
async function adminReady(){
 const value=await runOnPanel(async()=>{
  try{
   const res=await fetch('/api/auth',{credentials:'same-origin',cache:'no-store'});
   const data=await res.json();
   return {ok:res.ok&&data.authenticated===true};
  }catch{return {ok:false}}
 });
 return value?.ok===true;
}
async function save(snapshot){
 const result=await runOnPanel(async data=>{
  try{
   const authResponse=await fetch('/api/auth',{credentials:'same-origin',cache:'no-store'});
   const auth=await authResponse.json();
   if(!authResponse.ok||auth.authenticated!==true)return {error:'Admin oturumu kapanmış; Follower paneline tekrar giriş yap.'};
   const response=await fetch('/api/scan',{
    method:'POST',credentials:'same-origin',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify(data),cache:'no-store'
   });
   const parsed=await response.json();
   return response.ok?{ok:true,id:parsed.id}:{error:parsed.error||'Kaydedilemedi: HTTP '+response.status};
  }catch(err){return {error:String(err?.message||err)}}
 },[snapshot]);
 if(!result?.ok)throw Error(result?.error||'Sunucu kayıt işlemini kabul etmedi.');
 return result;
}
chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
 if(msg?.type==='CHECK_ADMIN'&&sender.id===chrome.runtime.id){
  adminReady().then(ok=>sendResponse({ok}),err=>sendResponse({ok:false,error:err.message}));
  return true;
 }
 if(!sender.url?.startsWith('https://www.instagram.com/'))return;
 if(msg?.type==='SCAN_PROGRESS'){
  status({phase:msg.progress?.phase,pages:msg.progress?.pages,count:msg.progress?.count,running:true})
   .then(()=>sendResponse({ok:true}),e=>sendResponse({error:e.message}));
  return true;
 }
 if(msg?.type==='SCAN_ERROR'){
  status({running:false,error:String(msg.error||'Tarama başarısız').slice(0,350)})
   .then(()=>sendResponse({ok:true}),e=>sendResponse({error:e.message}));
  return true;
 }
 if(msg?.type==='SAVE_SCAN'){
  (async()=>{
   try{
    await status({running:true,phase:'Sunucuya kaydediliyor',count:msg.snapshot?.followers?.length});
    const result=await save(msg.snapshot);
    await status({running:false,success:'@'+msg.snapshot.account.username+' kaydedildi',id:result.id});
    sendResponse({ok:true});
   }catch(err){
    const message=String(err?.message||err);
    await status({running:false,error:message});
    sendResponse({error:message});
   }
  })();
  return true;
 }
});
