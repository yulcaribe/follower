'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
const source=fs.readFileSync(path.join(__dirname,'content.js'),'utf8');
const response=(data,status=200)=>({
 ok:status===200,status,
 headers:{get:key=>key==='content-type'?'application/json':null},
 json:async()=>data
});
const sampleUsers=[{pk:'42',username:'test_follower',full_name:'Test Follower'}];
const page=(users=sampleUsers,extra={})=>response({users,...extra});
const identity=(id,username)=>response({data:{user:{id,username}}});
function harness({pathname='/my_account/',viewerID='123456',navUsername='',ownHeader=false,replies=[]}={}){
 const requested=[],messages=[];
 const nav={
  getAttribute:key=>key==='href'?'/'+navUsername+'/':null,
  querySelector:selector=>selector.includes('svg[aria-label="Profile"]')?{}:null
 };
 const header={
  querySelectorAll:()=>[{getAttribute:key=>key==='href'?'/accounts/edit/':'',textContent:'Edit profile'}]
 };
 const document={
  cookie:'ds_user_id='+viewerID+'; csrftoken=test',
  querySelectorAll:selector=>selector==='a[href]'&&navUsername?[nav]:[],
  querySelector:selector=>selector==='main header'&&ownHeader?header:null
 };
 const location={origin:'https://www.instagram.com',pathname};
 const context=vm.createContext({
  document,location,URL,
  setTimeout:cb=>{cb();return 1},
  fetch:async url=>{
   requested.push(url);
   const reply=replies.shift();
   if(!reply)throw Error('Unexpected request: '+url);
   return reply;
  },
  chrome:{runtime:{onMessage:{addListener:()=>{}},sendMessage:async x=>{messages.push(x);return {ok:true}}}}
 });
 vm.runInContext(source,context);
 return {requested,messages,location,scan:()=>vm.runInContext('runScan(async()=>{})',context)};
}
test('own profile uses verified profile navigation and viewer ID, not an info endpoint',async()=>{
 const h=harness({navUsername:'my_account',replies:[page(),page()]});
 const result=await h.scan();
 assert.equal(result.account.id,'123456');
 assert.equal(result.account.username,'my_account');
 assert.equal(h.requested.length,2);
 assert(h.requested.every(url=>url.includes('/api/v1/friendships/123456/')));
});
test('own profile can be verified using Edit Profile in the header',async()=>{
 const h=harness({ownHeader:true,replies:[page(),page()]});
 const result=await h.scan();
 assert.equal(result.account.id,'123456');
 assert.equal(h.requested.length,2);
});
test('another profile resolves its own ID and never scans viewer ID',async()=>{
 const h=harness({pathname:'/celalemirzor/',navUsername:'my_account',replies:[
  identity('987654','celalemirzor'),page(),page()
 ]});
 const result=await h.scan();
 assert.equal(result.account.id,'987654');
 assert.equal(result.account.username,'celalemirzor');
 assert.match(h.requested[0],/web_profile_info\/\?username=celalemirzor/);
 assert(h.requested.slice(1).every(url=>url.includes('/api/v1/friendships/987654/')));
 assert(h.requested.slice(1).every(url=>!url.includes('/123456/')));
});
test('no trusted own-page marker means even my own path must resolve ID',async()=>{
 const h=harness({pathname:'/my_account/',replies:[identity('123456','my_account'),page(),page()]});
 const result=await h.scan();
 assert.equal(result.account.id,'123456');
 assert.equal(h.requested.length,3);
});
test('rejects a profile page mismatch before requesting friendship lists',async()=>{
 const h=harness({pathname:'/celalemirzor/',replies:[identity('987654','another_account')]});
 await assert.rejects(h.scan(),/doğrulanamadı/);
 assert.equal(h.requested.length,1);
});
test('rejects a missing/invalid numeric target ID before lists',async()=>{
 const h=harness({pathname:'/celalemirzor/',replies:[identity('','celalemirzor')]});
 await assert.rejects(h.scan(),/doğrulanamadı/);
 assert.equal(h.requested.length,1);
});
test('429 on profile resolution fails instead of treating viewerID as target ID',async()=>{
 const h=harness({pathname:'/celalemirzor/',replies:[response(null,429)]});
 await assert.rejects(h.scan(),/profil.*429/);
 assert.equal(h.requested.length,1);
});
test('rejects Instagram feed and non-profile URLs without making requests',async()=>{
 for(const pathname of ['/','/explore/','/p/foo/','/reels/','/accounts/edit/']){
  const h=harness({pathname});
  await assert.rejects(h.scan(),/profilini aç/);
  assert.equal(h.requested.length,0);
 }
});
test('429 on other-account first list request aborts and does not try viewer lists',async()=>{
 const h=harness({pathname:'/celalemirzor/',replies:[identity('987654','celalemirzor'),response(null,429)]});
 await assert.rejects(h.scan(),/429/);
 assert.equal(h.requested.length,2);
});
test('private/forbidden following list returns error and cannot write a snapshot',async()=>{
 const h=harness({pathname:'/private/',replies:[identity('999','private'),response(null,403)]});
 await assert.rejects(h.scan(),/403/);
 assert.equal(h.requested.length,2);
});
test('zero users in either list does not produce a snapshot',async()=>{
 const h=harness({navUsername:'my_account',replies:[page(),page([])]});
 await assert.rejects(h.scan(),/boş liste/);
});
test('changing target profile while scanning aborts',async()=>{
 const h=harness({navUsername:'my_account',replies:[page(),page()]});
 const resultPromise=h.scan();
 h.location.pathname='/another/';
 await assert.rejects(resultPromise,/profil sayfası değişti/);
});
test('pagination keeps target ID on all pages',async()=>{
 const h=harness({pathname:'/celalemirzor/',replies:[
  identity('987654','celalemirzor'),
  page(sampleUsers,{next_max_id:'next'}),
  page([{pk:'43',username:'other_person'}]),
  page()
 ]});
 const result=await h.scan();
 assert.equal(result.following.length,2);
 assert.equal(result.followers.length,1);
 assert.equal(h.requested.length,4);
 assert.match(h.requested[2],/max_id=next/);
 assert(h.requested.slice(1).every(url=>url.includes('/987654/')));
});
