import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,describe,expect,it,vi} from 'vitest';
import {initializeTestEnvironment,type RulesTestEnvironment} from '@firebase/rules-unit-testing';
import {collection,doc,getDoc,getDocs,setDoc,updateDoc} from 'firebase/firestore';
import type {Capture,Item} from '../../functions/src/domain';

let env:RulesTestEnvironment;
let processCapture:typeof import('../../functions/src/index')['processCapture'];
beforeAll(async()=>{
  process.env.GCLOUD_PROJECT='demo-audiograffiti';
  env=await initializeTestEnvironment({projectId:'demo-audiograffiti',firestore:{rules:readFileSync('firestore.rules','utf8')}});
  ({processCapture}=await import('../../functions/src/index'));
});
beforeEach(async()=>{await env.clearFirestore();});
afterAll(async()=>{await env?.cleanup();});
const now=Date.now();
async function seed(id:string,extra:Record<string,unknown>={}) {
  await env.withSecurityRulesDisabled(async ctx=>{
    await setDoc(doc(ctx.firestore(),'users/alice/captures/'+id),{
      source:'voice',text:'',mimeType:'audio/webm',createdAt:now,updatedAt:now,timezone:'America/Chicago',status:'queued',...extra
    });
  });
}
const read=async(id:string)=>(await getDoc(doc(env.authenticatedContext('alice').firestore(),'users/alice/captures/'+id))).data()!;
describe('durable overnight server processing with stubbed AI and real Firestore transactions',()=>{
  it('processes three independent submitted recordings for a second device without converting ideas or committing suggestions',async()=>{
    const context:Item={id:'idea',kind:'idea',title:'Weekly letter',detail:'Keep this as a thought.',projectId:null,state:'open',priority:'normal',startsAt:null,durationMinutes:30,version:1,createdAt:now,updatedAt:now,sourceCaptureId:null};
    await env.withSecurityRulesDisabled(ctx=>setDoc(doc(ctx.firestore(),'users/alice/items/idea'),context));
    for(const id of ['night-1','night-2','night-3'])await seed(id);
    const transcribe=vi.fn(async(c:Capture)=>({
      'night-1':'An idea for a reading group.',
      'night-2':'Send Jamie the outline.',
      'night-3':'Follow up on the weekly letter idea tomorrow.'
    }[c.id] || ''));
    const analyze=vi.fn(async(text:string,items:Item[],c:Capture)=>{
      expect(items.some(i=>i.id==='idea')).toBe(true);
      return {summary:text,proposals:[c.id==='night-1'?{kind:'idea',title:'Reading group'}:c.id==='night-2'?{kind:'task',title:'Send Jamie the outline'}:{kind:'schedule',title:'Revisit the letter',targetId:'idea',startsAt:now+86400000,durationMinutes:30}]};
    });
    await Promise.all(['night-1','night-2','night-3'].map(id=>processCapture('alice',id,{transcribe,analyze})));
    const desktop=env.authenticatedContext('alice').firestore();
    const captures=await getDocs(collection(desktop,'users/alice/captures'));
    expect(captures.size).toBe(3);
    expect(captures.docs.every(d=>d.data().status==='ready'&&d.data().text&&d.data().summary)).toBe(true);
    const proposals=await getDocs(collection(desktop,'users/alice/proposals'));
    expect(proposals.size).toBe(3);expect(proposals.docs.every(d=>d.data().status==='pending')).toBe(true);
    expect(proposals.docs.map(d=>d.data().kind).sort()).toEqual(['idea','schedule','task']);
    const unchanged=await getDoc(doc(desktop,'users/alice/items/idea'));
    expect(unchanged.data()?.kind).toBe('idea');expect(unchanged.data()?.startsAt).toBeNull();
    expect(transcribe).toHaveBeenCalledTimes(3);
  });
  it('handles duplicate event deliveries without duplicate AI work or proposals',async()=>{
    await seed('duplicate');
    const transcribe=vi.fn(async()=> 'A private idea.');
    const analyze=vi.fn(async()=>({summary:'A private idea.',proposals:[{kind:'idea',title:'Keep this idea'}]}));
    await Promise.all([processCapture('alice','duplicate',{transcribe,analyze}),processCapture('alice','duplicate',{transcribe,analyze})]);
    await processCapture('alice','duplicate',{transcribe,analyze});
    expect(transcribe).toHaveBeenCalledTimes(1);expect(analyze).toHaveBeenCalledTimes(1);
    expect((await read('duplicate')).attempts).toBe(1);
    expect((await getDocs(collection(env.authenticatedContext('alice').firestore(),'users/alice/proposals'))).size).toBe(1);
  });
  it('retains the transcript through an AI failure and retries without retranscribing',async()=>{
    await seed('retry');
    const transcribe=vi.fn(async()=> 'Follow up on this thought.');
    const analyze=vi.fn().mockRejectedValueOnce(new Error('Temporary upstream outage')).mockResolvedValue({summary:'Return to the thought.',proposals:[{kind:'idea',title:'A thought for later'}]});
    await processCapture('alice','retry',{transcribe,analyze});
    const failed=await read('retry');
    expect(failed.status).toBe('queued');expect(failed.text).toBe('Follow up on this thought.');expect(failed.nextAttemptAt).toBeGreaterThan(now);
    await env.withSecurityRulesDisabled(ctx=>updateDoc(doc(ctx.firestore(),'users/alice/captures/retry'),{nextAttemptAt:0}));
    await processCapture('alice','retry',{transcribe,analyze});
    expect((await read('retry')).status).toBe('ready');expect(transcribe).toHaveBeenCalledTimes(1);
  });
  it('recovers an expired worker lease and caps repeated processing failures',async()=>{
    await seed('expired',{status:'organizing',leaseId:'lost-worker',leaseUntil:now-1000,text:'Preserved transcript'});
    const providers={transcribe:vi.fn(),analyze:vi.fn(async()=>({summary:'Recovered thought.',proposals:[]}))};
    await processCapture('alice','expired',providers);expect((await read('expired')).status).toBe('ready');
    await seed('exhausted',{attempts:5});
    await processCapture('alice','exhausted',providers);expect((await read('exhausted')).status).toBe('failed');
    expect(providers.analyze).toHaveBeenCalledTimes(1);
  });
});
