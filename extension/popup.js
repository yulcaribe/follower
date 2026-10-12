'use strict';
const $=id=>document.getElementById(id);
const defaultServer='';
let server=defaultServer;
function info(id,value,error=false){
 const el=$(id);el.textContent=value;el.className='note'+(error?' error':'');
}
function validate(raw){
 const u=new URL(raw.trim());
 if(!['http:','https:'].includes(u.protocol)||u.username||u.password||u.search||u.hash||u.pathname!=='/')
  throw Error('Geçerli bir Follower adresi gir (ör. http://IP:3101).');
 return u.origin;
}
function hostPermission(origin){
 const u=new URL(origin);
 return u.protocol+'//'+u.hostname+'/*'; // Chrome host permissions do not include port.
}
async function updateStatus(){
 const {scanStatus}=await chrome.storage.session.get('scanStatus');
 $('scan').disabled=!!scanStatus?.running;
 if(!scanStatus){info('status','Hazır.');return}
 const phase=scanStatus.phase==='following'?'Takip edilenler':scanStatus.phase==='followers'?'Takipçiler':scanStatus.phase;
 info('status',scanStatus.error||scanStatus.success||
  (phase?phase+' • '+(scanStatus.count||0)+' kişi, '+(scanStatus.pages||0)+' sayfa':'Hazır.'),!!scanStatus.error);
}
async function load(){
 const value=await chrome.storage.local.get('server');
 server=value.server||defaultServer;
 $('server').value=server;
 info('connection','Sadece admin şifrenle giriş yapman yeterli.');
 await updateStatus();
}
$('save').onclick=async()=>{
 try{
  const origin=validate($('server').value);
  const allowed=await chrome.permissions.request({origins:[hostPermission(origin)]});
  if(!allowed)throw Error('Sunucu sekmesinde işlem yapabilmek için Chrome erişim izni gerekli.');
  server=origin;
  await chrome.storage.local.set({server});
  info('connection','Sunucu adresi kaydedildi.');
 }catch(err){info('connection',err.message,true)}
};
$('panel').onclick=async()=>{
 try{
  server=validate($('server').value);
  await chrome.tabs.create({url:server});
 }catch(err){info('connection',err.message,true)}
};
$('scan').onclick=async()=>{
 try{
  server=validate($('server').value);
  const permission=await chrome.permissions.contains({origins:[hostPermission(server)]});
  if(!permission)throw Error('Önce "Adresi kaydet" düğmesine bas.');
  const check=await chrome.runtime.sendMessage({type:'CHECK_ADMIN'});
  if(!check?.ok)throw Error(check?.error||'Follower admin panelini açıp şifrenle giriş yap.');
  const tabs=await chrome.tabs.query({url:['https://www.instagram.com/*']});
  const tab=tabs.find(t=>t.active)||tabs[0];
  if(!tab?.id)throw Error('Önce Instagram sekmesini açıp hesabına giriş yap.');
  await chrome.storage.session.set({scanStatus:{running:true,phase:'Başlıyor',at:Date.now()}});
  await updateStatus();
  const result=await chrome.tabs.sendMessage(tab.id,{type:'START_SCAN'});
  if(!result?.ok)throw Error(result?.error||'Instagram sekmesini yenileyip tekrar dene.');
 }catch(err){
  await chrome.storage.session.set({scanStatus:{running:false,error:String(err.message||err),at:Date.now()}});
  await updateStatus();
 }
};
setInterval(updateStatus,1500);
load().catch(err=>info('connection',err.message,true));
