import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({documents:new Map<string,unknown>(),objects:new Set<string>(),loseDocAck:false,loseAudioAck:false,auth:{currentUser:{uid:'alice'}}}));
vi.mock('../../src/firebase',()=>({auth:state.auth,db:{},storage:{},functions:null}));
vi.mock('firebase/firestore',()=>({
  doc:(_db:unknown,...path:string[])=>path.join('/'),
  getDocFromServer:vi.fn(async(path:string)=>({exists:()=>state.documents.has(path),data:()=>state.documents.get(path)})),
  setDoc:vi.fn(async(path:string,data:unknown)=>{state.documents.set(path,data);if(state.loseDocAck){state.loseDocAck=false;throw new Error('Connection lost after commit');}})
}));
vi.mock('firebase/storage',()=>({
  ref:(_storage:unknown,path:string)=>path,
  getMetadata:vi.fn(async(path:string)=>{if(!state.objects.has(path))throw{code:'storage/object-not-found'};return{};}),
  uploadBytesResumable:vi.fn(async(path:string)=>{state.objects.add(path);if(state.loseAudioAck){state.loseAudioAck=false;throw new Error('Upload acknowledged late');}})
}));
import {DEVICE_OWNER,adoptDeviceDrafts,draftItems,localEntries,newEntry,removeDraftItem,removeLocal,retryLocal,saveDraftItem,saveLocal,syncOutbox} from '../../src/outbox';
import {setDoc} from 'firebase/firestore';
import {uploadBytesResumable} from 'firebase/storage';
beforeEach(async()=>{
  vi.stubGlobal('window',new EventTarget());
  vi.stubGlobal('navigator',{onLine:true});
  state.auth.currentUser.uid='alice';state.documents.clear();state.objects.clear();state.loseAudioAck=false;state.loseDocAck=false;
  vi.clearAllMocks();
  for(const uid of ['alice','bob',DEVICE_OWNER]) {
    for(const entry of await localEntries(uid))await removeLocal(entry.id);
    for(const item of await draftItems(uid))await removeDraftItem(item.id);
  }
});
describe('durable capture outbox',()=>{
  it('keeps personal device captures until the user explicitly binds them to an account',async()=>{
    const entry=newEntry(DEVICE_OWNER,'text','My own thought');await saveLocal(entry);
    await syncOutbox('alice');expect(setDoc).not.toHaveBeenCalled();
    await expect(adoptDeviceDrafts('bob')).rejects.toThrow('Sign in');
    await adoptDeviceDrafts('alice');
    expect(await localEntries(DEVICE_OWNER)).toHaveLength(0);
    expect((await localEntries('alice'))[0].id).toBe(entry.id);
    await syncOutbox('alice');expect(state.documents.size).toBe(1);
  });
  it('preserves the thought type, follow-up and original reference when importing a device draft',async()=>{
    const item={id:'my-idea',kind:'idea' as const,title:'My idea',detail:'Keep this as a thought',projectId:null,state:'open' as const,priority:'normal' as const,startsAt:Date.now()+86400000,durationMinutes:30,version:1,createdAt:Date.now(),updatedAt:Date.now(),sourceCaptureId:'my-capture'};
    await saveDraftItem(item);expect((await draftItems())[0].kind).toBe('idea');
    await adoptDeviceDrafts('alice');
    expect(await draftItems()).toHaveLength(0);
    expect((await draftItems('alice'))[0]).toMatchObject({...item,uid:'alice'});
  });
  it('preserves three independent overnight recordings and isolates them by account',async()=>{
    for(let i=0;i<3;i++)await saveLocal({...newEntry('alice','voice'),mimeType:'audio/webm',blob:new Blob(['recording-'+i])});
    expect(await localEntries('alice')).toHaveLength(3);expect(await localEntries('bob')).toHaveLength(0);
  });
  it('keeps offline thoughts until a successful server acknowledgement',async()=>{
    const entry=newEntry('alice','text','A thought between dreams');await saveLocal(entry);
    vi.stubGlobal('navigator',{onLine:false});await syncOutbox('alice');
    expect(await localEntries('alice')).toHaveLength(1);expect(setDoc).not.toHaveBeenCalled();
    vi.stubGlobal('navigator',{onLine:true});await syncOutbox('alice');
    expect(await localEntries('alice')).toHaveLength(0);expect(state.documents.size).toBe(1);
  });
  it('prevents duplicate text submissions after a lost acknowledgement',async()=>{
    await saveLocal(newEntry('alice','text','Do not lose me'));state.loseDocAck=true;await syncOutbox('alice');
    const [retry]=await localEntries('alice');expect(retry).toBeDefined();expect(state.documents.size).toBe(1);
    await retryLocal(retry);await syncOutbox('alice');
    expect(await localEntries('alice')).toHaveLength(0);expect(setDoc).toHaveBeenCalledTimes(1);
  });
  it('retains audio when the upload acknowledgement is lost, then avoids reuploading it',async()=>{
    await saveLocal({...newEntry('alice','voice'),text:'A local preview transcript',mimeType:'audio/webm',blob:new Blob(['audio'])});state.loseAudioAck=true;
    await syncOutbox('alice');const [retry]=await localEntries('alice');expect(retry.blob?.size).toBe(5);
    expect([...state.documents.values()][0]).toMatchObject({source:'voice',text:'',status:'uploading'});
    await retryLocal(retry);await syncOutbox('alice');
    expect(uploadBytesResumable).toHaveBeenCalledTimes(1);expect(await localEntries('alice')).toHaveLength(0);
  });
  it('does not upload a recording still in progress or another account’s queue',async()=>{
    await saveLocal({...newEntry('alice','voice'),phase:'recording',mimeType:'audio/webm',blob:new Blob(['partial'])});
    await saveLocal(newEntry('bob','text','Private'));
    await syncOutbox('alice');await syncOutbox('bob');
    expect(setDoc).not.toHaveBeenCalled();expect(await localEntries('bob')).toHaveLength(1);
  });
});
