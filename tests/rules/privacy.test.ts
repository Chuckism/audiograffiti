import {readFileSync} from 'node:fs';
import {afterAll,beforeAll,beforeEach,describe,it} from 'vitest';
import {assertFails,assertSucceeds,initializeTestEnvironment,type RulesTestEnvironment} from '@firebase/rules-unit-testing';
import {collection,doc,getDoc,getDocs,setDoc,updateDoc} from 'firebase/firestore';
import {ref,uploadBytes,getBytes} from 'firebase/storage';
let env:RulesTestEnvironment;
const capture={source:'text',text:'My private thought',mimeType:'',createdAt:Date.now(),updatedAt:Date.now(),timezone:'America/Chicago',status:'queued'};
beforeAll(async()=>{env=await initializeTestEnvironment({projectId:'demo-audiograffiti',firestore:{rules:readFileSync('firestore.rules','utf8')},storage:{rules:readFileSync('storage.rules','utf8')}});});
afterAll(async()=>{await env?.cleanup();});
beforeEach(async()=>{await env.clearFirestore();await env.clearStorage();});
describe('private workspace boundary',()=>{
  it('accepts owner capture but rejects another account, anonymous reads and server-field injection',async()=>{
    const alice=env.authenticatedContext('alice').firestore();const bob=env.authenticatedContext('bob').firestore();
    await assertSucceeds(setDoc(doc(alice,'users/alice/captures/a'),capture));
    await assertFails(getDoc(doc(bob,'users/alice/captures/a')));
    await assertFails(getDocs(collection(bob,'users/alice/captures')));
    await assertFails(getDoc(doc(env.unauthenticatedContext().firestore(),'users/alice/captures/a')));
    await assertFails(setDoc(doc(alice,'users/alice/captures/b'),{...capture,status:'ready'}));
    await assertFails(setDoc(doc(alice,'users/alice/captures/c'),{...capture,leaseUntil:0}));
    await assertFails(updateDoc(doc(alice,'users/alice/captures/a'),{text:'overwrite original'}));
  });
  it('keeps proposals and commitments server-controlled',async()=>{
    const db=env.authenticatedContext('alice').firestore();
    await assertFails(setDoc(doc(db,'users/alice/items/item'),{kind:'event',title:'Tampered'}));
    await assertFails(setDoc(doc(db,'users/alice/proposals/proposal'),{status:'approved'}));
  });
  it('permits reviewed markers only on finished captures',async()=>{
    const db=env.authenticatedContext('alice').firestore();
    await assertSucceeds(setDoc(doc(db,'users/alice/captures/a'),capture));
    await assertFails(updateDoc(doc(db,'users/alice/captures/a'),{reviewedAt:Date.now()}));
    await env.withSecurityRulesDisabled(async ctx=>{await updateDoc(doc(ctx.firestore(),'users/alice/captures/a'),{status:'ready'});});
    await assertSucceeds(updateDoc(doc(db,'users/alice/captures/a'),{reviewedAt:Date.now()}));
  });
  it('protects audio and denies overwrites and unsupported payloads',async()=>{
    const alice=env.authenticatedContext('alice');
    await assertSucceeds(setDoc(doc(alice.firestore(),'users/alice/captures/voice'),{...capture,source:'voice',text:'',mimeType:'audio/webm',status:'uploading'}));
    const path='users/alice/captures/voice/audio';
    await assertSucceeds(uploadBytes(ref(alice.storage(),path),new Uint8Array([1,2,3]),{contentType:'audio/webm'}));
    await assertFails(uploadBytes(ref(alice.storage(),path),new Uint8Array([4,5]),{contentType:'audio/webm'}));
    await assertFails(getBytes(ref(env.authenticatedContext('bob').storage(),path)));
    await assertFails(uploadBytes(ref(alice.storage(),'users/alice/captures/missing/audio'),new Uint8Array([1]),{contentType:'text/html'}));
  });
});
