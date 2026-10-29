import test from 'node:test';
import assert from 'node:assert/strict';
import {parseTrack, addTrack, handleUpdate, makeWorker} from './worker.mjs';

const env={YANDEX_TOKEN:'test-yandex',TELEGRAM_BOT_TOKEN:'123456:test-bot',SETUP_SECRET:'test-secret-abcdefghijklmnopqrstuvwxyz',ALLOWED_CHAT_IDS:'-100123',BOT_USERNAME:'pumpkin_test_bot'};
const track={id:'42',title:'Thriller',available:true,type:'music',artists:[{name:'Michael Jackson'}],albums:[{id:7}]};
function fixture({conflict=false,timeout=false,incomplete=false,wrongOwner=false}={}) {
  let list=[],revision=1,writes=0,replies=[],conflicted=false;
  const fetcher=async (url,options={})=>{
    assert.equal(options.redirect,'manual');
    const path=new URL(url).pathname;
    const ok=result=>Response.json({result});
    if(path.endsWith('/sendMessage')) {replies.push(JSON.parse(options.body));return Response.json({ok:true,result:{message_id:1}});}
    if(path==='/tracks') return ok([track]);
    if(path==='/account/status') return ok({account:{uid:123}});
    if(path.startsWith('/playlist/')) return ok({owner:{uid:wrongOwner?999:123},kind:1033});
    if(path.endsWith('/change')) {
      writes++;
      const data=new URLSearchParams(options.body);
      assert.equal(data.get('revision'),String(revision));
      if(conflict&&!conflicted){conflicted=true;revision++;return Response.json({error:{name:'revision-mismatch'}},{status:409});}
      const diff=JSON.parse(data.get('diff'));
      assert.deepEqual(diff,[{op:'insert',at:list.length,tracks:[{id:'42',albumId:'7'}]}]);
      list.push({id:'42'});revision++;
      if(timeout)throw new Error('ambiguous network failure after successful write');
      return ok({tracks:list,kind:1033,revision,trackCount:list.length});
    }
    if(path==='/users/123/playlists/1033')return ok({tracks:list,kind:1033,revision,trackCount:list.length+(incomplete?1:0)});
    throw new Error('Unexpected request: '+path);
  };
  return {fetcher,get writes(){return writes},replies};
}
test('only direct Yandex track links, one per command',()=>{
  assert.deepEqual(parseTrack('https://music.yandex.ru/album/7/track/42?utm_source=copy'),{trackId:'42',albumId:'7'});
  assert.deepEqual(parseTrack('https://music.yandex.ru/track/42'),{trackId:'42',albumId:null});
  for(const url of ['http://music.yandex.ru/track/42','https://music.yandex.ru.evil.test/track/42','https://music.yandex.ru@evil.test/track/42','https://music.yandex.ru:999/track/42','https://music.yandex.ru/album/7','https://evil.test','https://music.yandex.ru/track/42 https://music.yandex.ru/track/43'])assert.throws(()=>parseTrack(url));
});
test('verified insertion and replay never duplicate the track',async()=>{
  const f=fixture();
  assert.equal((await addTrack(env,{trackId:'42',albumId:'7'},f.fetcher)).duplicate,false);
  assert.equal((await addTrack(env,{trackId:'42',albumId:'7'},f.fetcher)).duplicate,true);
  assert.equal(f.writes,1);
});
test('revision conflict refreshes before retry',async()=>{
  const f=fixture({conflict:true});await addTrack(env,{trackId:'42',albumId:'7'},f.fetcher);assert.equal(f.writes,2);
});
test('successful write followed by timeout is not replayed',async()=>{
  const f=fixture({timeout:true});assert.equal((await addTrack(env,{trackId:'42',albumId:'7'},f.fetcher)).duplicate,true);assert.equal(f.writes,1);
});
test('wrong owner or incomplete playlist cannot be mutated',async()=>{
  for(const opts of [{wrongOwner:true},{incomplete:true}]){const f=fixture(opts);await assert.rejects(addTrack(env,{trackId:'42',albumId:'7'},f.fetcher));assert.equal(f.writes,0);}
});
test('unknown group and wrong command recipient do not trigger any API calls',async()=>{
  let calls=0;const f=()=>{calls++;throw Error('should not call')};
  for(const text of ['/add https://music.yandex.ru/track/42','/add@other_bot https://music.yandex.ru/track/42'])await handleUpdate({message:{chat:{id:-999},from:{id:7},text}},env,f);
  await handleUpdate({message:{chat:{id:-100123},from:{id:7},text:'/add https://music.yandex.ru/track/42'}},{...env,ALLOWED_CHAT_IDS:''},f);
  assert.equal(calls,0);
});
test('reply command and username route correctly',async()=>{
  const f=fixture();await handleUpdate({message:{chat:{id:-100123},from:{id:7},message_id:9,text:'/add@pumpkin_test_bot',reply_to_message:{text:'https://music.yandex.ru/album/7/track/42'}}},env,f.fetcher);
  assert.equal(f.writes,1);assert.match(f.replies[0].text,/Добавлено/);
});
test('webhook secret and admin secret are mandatory; no public write routes',async()=>{
  let calls=0;const worker=makeWorker(()=>{calls++;throw Error('no external calls')});
  for(const path of ['/telegram','/admin/webhook','/admin/check']){
    const r=await worker.fetch(new Request('https://bot.test'+path,{method:'POST',body:'{}'}),env);
    assert.ok([401,403].includes(r.status));
  }
  const malformed=await worker.fetch(new Request('https://bot.test/telegram',{method:'POST',headers:{'X-Telegram-Bot-Api-Secret-Token':env.SETUP_SECRET},body:'not-json'}),env);
  assert.equal(malformed.status,400);assert.equal(calls,0);
});
test('Yandex check runs even when Telegram token format is invalid',async()=>{
  const f=fixture();const worker=makeWorker(f.fetcher);
  const r=await worker.fetch(new Request('https://bot.test/admin/check',{method:'POST',headers:{Authorization:'Bearer '+env.SETUP_SECRET}}),{...env,TELEGRAM_BOT_TOKEN:'not a token'});
  const data=await r.json();assert.equal(data.telegram.ok,false);assert.equal(data.yandex.ok,true);assert.equal(f.writes,0);
});
