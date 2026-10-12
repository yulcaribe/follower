'use strict';
const $=id=>document.getElementById(id);
let state=null,selected='',tab='notFollowingBack';
const show=(id,visible)=>$(id).classList.toggle('hidden',!visible);
const msg=(id,value)=>{$(id).textContent=String(value||'')};
async function api(path,body){
 const res=await fetch(path,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),cache:'no-store'});
 let data;try{data=await res.json()}catch{throw Error('Sunucu JSON yanıtı vermedi')}
 if(!res.ok)throw Error(data.error||'HTTP '+res.status);
 return data;
}
async function enter(){
 try{
  const r=await api('/api/auth');
  show('setup',r.setupRequired);show('login',!r.setupRequired&&!r.authenticated);
  show('dashboard',r.authenticated);show('logout',r.authenticated);
  if(r.authenticated)await refresh();
 }catch(err){msg('loginError',err.message);msg('setupError',err.message)}
}
$('setupForm').onsubmit=async e=>{
 e.preventDefault();
 const pass=$('setupPass').value;
 if(pass!==$('setupConfirm').value){msg('setupError','Şifreler aynı olmalı');return}
 try{await api('/api/admin/setup',{password:pass});$('setupForm').reset();msg('setupError','');await enter()}
 catch(err){msg('setupError',err.message)}
};
$('loginForm').onsubmit=async e=>{
 e.preventDefault();
 try{await api('/api/admin/login',{password:$('password').value});$('loginForm').reset();msg('loginError','');await enter()}
 catch(err){msg('loginError',err.message)}
};
$('logout').onclick=async()=>{await api('/api/admin/logout',{});state=null;selected='';await enter()};
$('changeForm').onsubmit=async e=>{
 e.preventDefault();
 if($('newPass').value!==$('newConfirm').value){msg('changeMsg','Yeni şifreler uyuşmuyor');return}
 try{await api('/api/admin/change-password',{oldPassword:$('oldPass').value,newPassword:$('newPass').value});$('changeForm').reset();msg('changeMsg','Admin şifresi değişti.');await enter()}
 catch(err){msg('changeMsg',err.message)}
};
const toDate=v=>v?new Date(v).toLocaleString('tr-TR'):'–';
function listItems(){
 if(!state)return [];
 if(tab==='notFollowingBack')return state.notFollowingBack||[];
 if(tab==='followers'||tab==='following')return state.snapshot?.[tab]||[];
 return state.report?.[tab]||[];
}
function renderList(){
 const query=$('search').value.toLocaleLowerCase('tr-TR').trim();
 const users=listItems().filter(u=>!query||String(u.username).toLocaleLowerCase('tr-TR').includes(query));
 msg('listCount',users.length+' hesap');
 $('list').replaceChildren();
 if(!users.length){const li=document.createElement('li');li.textContent='Kayıt yok';$('list').append(li)}
 for(const u of users){
  const li=document.createElement('li'),a=document.createElement('a');
  a.href='https://www.instagram.com/'+encodeURIComponent(u.username)+'/';a.target='_blank';a.rel='noopener noreferrer';
  a.textContent='@'+u.username;
  li.append(a);
  if(u.fullName)li.append(document.createTextNode(' • '+u.fullName));
  $('list').append(li)
 }
}
function render(){
 const accounts=state.accounts||[],snap=state.snapshot,report=state.report;
 $('account').replaceChildren();
 if(!accounts.length){const opt=document.createElement('option');opt.value='';opt.textContent='Henüz kayıt yok';$('account').append(opt)}
 for(const acc of accounts){const opt=document.createElement('option');opt.value=acc.id;opt.textContent='@'+acc.username+' ('+acc.id+')';$('account').append(opt)}
 selected=state.selectedId||'';$('account').value=selected;
 for(const [name,value] of [
  ['nFollowers',snap?.followers?.length??'–'],['nFollowing',snap?.following?.length??'–'],
  ['nBack',state.notFollowingBack?.length??'–'],['nLost',report?.unfollowedYou?.length??'–'],
 ])msg(name,value);
 msg('range',report?toDate(report.from)+' → '+toDate(report.to):snap?'İlk kayıt: '+toDate(snap.takenAt):'Henüz tarama yapılmadı');
 $('history').replaceChildren();
 for(const row of [...(state.history||[])].reverse()){
  const tr=document.createElement('tr');
  for(const value of [toDate(row.takenAt),row.followers,row.following,row.first?'–':row.unfollowedYou,row.first?'–':row.newFollowers]){
   const td=document.createElement('td');td.textContent=value;tr.append(td)
  }$('history').append(tr)
 }
 renderList()
}
async function refresh(){
 try{state=await api('/api/state'+(selected?'?id='+encodeURIComponent(selected):''));render()}
 catch(err){if(err.message.includes('Admin şifresi'))await enter();else msg('range',err.message)}
}
$('refresh').onclick=async()=>{
 msg('refreshMessage','Yenileniyor...');
 await refresh();
 msg('refreshMessage','Kayıtlar yenilendi.');
};
$('account').onchange=()=>{selected=$('account').value;refresh()};
$('tabs').onclick=e=>{
 const btn=e.target.closest('button[data-tab]');if(!btn)return;
 tab=btn.dataset.tab;
 for(const b of $('tabs').querySelectorAll('button'))b.classList.toggle('on',b===btn);
 renderList()
};
$('search').oninput=renderList;
$('export').onclick=()=>{if(selected)location.href='/api/csv?id='+encodeURIComponent(selected)+'&kind='+encodeURIComponent(tab)};
enter();
