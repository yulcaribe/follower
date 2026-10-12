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
function harness(replies,profileName='my_account'){
 const requested=[];
 const link={
  getAttribute:key=>key==='href'?'/'+profileName+'/':null,
  querySelector:selector=>selector.includes('svg[aria-label="Profile"]')?{}:null,
  closest:()=>null
 };
 const document={
  cookie:'ds_user_id=123456; csrftoken=test',
  querySelectorAll:()=>profileName?[link]:[]
 };
 const context=vm.createContext({
  document,location:{origin:'https://www.instagram.com'},URL,
  setTimeout:cb=>{cb();return 1},
  fetch:async url=>{
   requested.push(url);
   const reply=replies.shift();
   if(!reply)throw Error('Unexpected request: '+url);
   return reply;
  },
  chrome:{runtime:{onMessage:{addListener:()=>{}},sendMessage:async()=>({ok:true})}},
 });
 vm.runInContext(source,context);
 return {
  requested,
  scan:(name='')=>vm.runInContext('runScan(async()=>{},'+JSON.stringify(name)+')',context)
 };
}
test('scans without any /users/{id}/info/ request',async()=>{
 const h=harness([response({users:sampleUsers}),response({users:sampleUsers})]);
 const result=await h.scan();
 assert.equal(result.account.id,'123456');
 assert.equal(result.account.username,'my_account');
 assert.equal(result.following.length,1);
 assert.equal(result.followers.length,1);
 assert.equal(result.profileCounts,undefined);
 assert.equal(h.requested.length,2);
 assert(h.requested.every(url=>url.includes('/api/v1/friendships/123456/')));
});
test('manual username works if profile navigation is unavailable',async()=>{
 const h=harness([response({users:sampleUsers}),response({users:sampleUsers})],'');
 const result=await h.scan('own_handle');
 assert.equal(result.account.username,'own_handle');
 assert.equal(h.requested.length,2);
});
test('rejects scans when username cannot be resolved, before making requests',async()=>{
 const h=harness([],'');
 await assert.rejects(h.scan(),/kullanıcı adı/i);
 assert.equal(h.requested.length,0);
});
test('rejects mismatched manual username',async()=>{
 const h=harness([],'my_account');
 await assert.rejects(h.scan('different_name'),/eşleşmiyor/);
 assert.equal(h.requested.length,0);
});
test('429 at first list request aborts and does not retry',async()=>{
 const h=harness([response(null,429)]);
 await assert.rejects(h.scan(),/429/);
 assert.equal(h.requested.length,1);
});
test('429 at second list request aborts and does not retry',async()=>{
 const h=harness([response({users:sampleUsers}),response(null,429)]);
 await assert.rejects(h.scan(),/429/);
 assert.equal(h.requested.length,2);
});
test('zero users from either list cannot be accepted as a completed scan',async()=>{
 const h=harness([response({users:sampleUsers}),response({users:[]})]);
 await assert.rejects(h.scan(),/boş liste/);
});
test('follows pagination while preserving existing data',async()=>{
 const h=harness([
  response({users:sampleUsers,next_max_id:'next'}),
  response({users:[{pk:'43',username:'nextperson'}]}),
  response({users:sampleUsers})
 ]);
 const result=await h.scan();
 assert.equal(result.following.length,2);
 assert.equal(result.followers.length,1);
 assert.match(h.requested[1],/max_id=next/);
});
