import { openDB, type IDBPDatabase } from 'idb';
import { auth, db, storage, functions } from './firebase';
import { httpsCallable } from 'firebase/functions';
import { doc, getDocFromServer, setDoc } from 'firebase/firestore';
import { getMetadata, ref, uploadBytesResumable } from 'firebase/storage';
import type { Capture, Item } from '../functions/src/domain';

export interface OutboxEntry {
  id: string; uid: string; source: 'voice' | 'text'; text: string; blob?: Blob; mimeType: string;
  createdAt: number; updatedAt: number; timezone: string;
  phase: 'recording' | 'queued'; attempts: number; nextAttemptAt: number; error?: string; reviewedAt?: number;
}
export interface DraftItem extends Item { uid: string; error?: string; }
export const DEVICE_OWNER = 'device-drafts';
let connection: Promise<IDBPDatabase> | undefined;
const STORAGE_BLOCKED = 'Device storage is waiting for an older tab. Your text is still here. Reload this page; close other ThoughtSplat tabs if needed.';
function database(): Promise<IDBPDatabase> {
  if (connection) return connection;
  connection = new Promise((resolve, reject) => {
    let abandoned = false;
    let opened: IDBPDatabase | undefined;
    const fail = (error: Error) => {abandoned=true;clearTimeout(timer);connection=undefined;reject(error);};
    const timer = setTimeout(() => fail(new Error(STORAGE_BLOCKED)),5000);
    openDB('audiograffiti-outbox',2,{
      upgrade(db) {
        if (!db.objectStoreNames.contains('captures')) db.createObjectStore('captures',{keyPath:'id'});
        if (!db.objectStoreNames.contains('draft-items')) db.createObjectStore('draft-items',{keyPath:'id'});
      },
      blocked() {fail(new Error(STORAGE_BLOCKED));},
      blocking() {opened?.close();connection=undefined;},
      terminated() {connection=undefined;}
    }).then(db => {opened=db;if(abandoned){db.close();return;}clearTimeout(timer);resolve(db);}).catch(fail);
  });
  return connection;
}
if (import.meta.hot) import.meta.hot.dispose(() => {
  void connection?.then(db => db.close()).catch(() => {});
  connection=undefined;
});
const changed = () => window.dispatchEvent(new Event('outbox-change'));
export async function saveLocal(entry: OutboxEntry) {
  const databaseInstance = await database();
  await databaseInstance.put('captures',entry);
  changed();
}
export async function localEntries(uid: string): Promise<OutboxEntry[]> {
  const databaseInstance = await database();
  return (await databaseInstance.getAll('captures')).filter((e: OutboxEntry) => e.uid === uid).sort((a,b) => b.createdAt-a.createdAt);
}
export async function removeLocal(id: string) {
  const databaseInstance = await database();
  await databaseInstance.delete('captures',id); changed();
}
export async function draftItems(uid = DEVICE_OWNER): Promise<DraftItem[]> {
  return (await (await database()).getAll('draft-items')).filter((item: DraftItem) => item.uid === uid);
}
export async function saveDraftItem(item: Item, uid = DEVICE_OWNER) {
  await (await database()).put('draft-items', {...item, uid}); changed();
}
export async function removeDraftItem(id: string) {
  await (await database()).delete('draft-items', id); changed();
}
// Explicit import binds device-only drafts to one signed-in account. Until each
// server acknowledgement arrives, the outbox remains the temporary recovery copy.
export async function adoptDeviceDrafts(uid: string) {
  if (auth?.currentUser?.uid !== uid) throw new Error('Sign in before moving these drafts.');
  const databaseInstance = await database();
  const tx = databaseInstance.transaction(['captures', 'draft-items'], 'readwrite');
  for (const storeName of ['captures', 'draft-items']) {
    const store = tx.objectStore(storeName);
    for (const entry of await store.getAll()) {
      if (entry.uid === DEVICE_OWNER) await store.put({...entry, uid, nextAttemptAt:0});
    }
  }
  await tx.done; changed();
}
async function syncDraftItems(uid: string) {
  if (!functions || !db || auth?.currentUser?.uid !== uid) return;
  const drafts = (await draftItems(uid)).sort((a,b) => Number(b.kind === 'project') - Number(a.kind === 'project'));
  for (const item of drafts) {
    if (auth?.currentUser?.uid !== uid) return;
    try {
      const existing = await getDocFromServer(doc(db,'users',uid,'items',item.id));
      if (existing.exists()) {
        const fields = ['kind','title','detail','projectId','state','priority','startsAt','durationMinutes','sourceCaptureId'] as const;
        if (!fields.every(key => existing.data()[key] === item[key])) throw new Error('A cloud item with this ID changed. Keep the device copy for review.');
      } else {
        await httpsCallable(functions,'saveItem')({id:item.id,item,version:null,sourceCaptureId:item.sourceCaptureId});
      }
      await removeDraftItem(item.id);
    } catch {
      await (await database()).put('draft-items',{...item,error:'Waiting to import. Resolve calendar conflicts in your workspace and try again.'});
    }
  }
}
export async function retryLocal(entry: OutboxEntry) {
  await saveLocal({...entry,phase:'queued',attempts:0,nextAttemptAt:0,error:''});
}
export function newEntry(uid: string, source: 'voice' | 'text', text = ''): OutboxEntry {
  return {id:crypto.randomUUID(),uid,source,text,mimeType:'',createdAt:Date.now(),updatedAt:Date.now(),
    timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,phase:'queued',attempts:0,nextAttemptAt:0};
}
export async function requestDurableStorage() {
  try { return await navigator.storage?.persist?.() ?? false; } catch { return false; }
}
let syncing = false;
export async function syncOutbox(uid: string) {
  if (syncing || !navigator.onLine || !auth || auth.currentUser?.uid !== uid || !db || !storage) return;
  syncing = true;
  try {
    for (const entry of await localEntries(uid)) {
      if (auth.currentUser?.uid !== uid) break;
      if (entry.phase === 'recording' || entry.nextAttemptAt > Date.now()) continue;
      try {
        if (entry.source === 'voice' && !entry.blob?.size) throw new Error('No audio was recovered. Keep or discard this capture.');
        const document = doc(db,'users',uid,'captures',entry.id);
        const remote = await getDocFromServer(document);
        if (auth.currentUser?.uid !== uid) break;
        if (!remote.exists()) {
          const data: Omit<Capture,'id'> = {
            source:entry.source,text:entry.text,mimeType:entry.mimeType,
            createdAt:entry.createdAt,updatedAt:Date.now(),timezone:entry.timezone,
            status:entry.source === 'voice' ? 'uploading' : 'queued'
          };
          await setDoc(document,data);
        }
        if (entry.source === 'voice' && (!remote.exists() || remote.data()?.status === 'uploading')) {
          const object = ref(storage,'users/' + uid + '/captures/' + entry.id + '/audio');
          let exists = false;
          try { await getMetadata(object); exists = true; }
          catch (error) { if ((error as {code?:string}).code !== 'storage/object-not-found') throw error; }
          if (!exists) {
            if (auth.currentUser?.uid !== uid) break;
            await uploadBytesResumable(object,entry.blob!,{contentType:entry.mimeType});
          }
        }
        // Delete only after Firestore acknowledgement and, for voice, object acknowledgement.
        await removeLocal(entry.id);
      } catch (error) {
        const attempts = entry.attempts + 1;
        const code = (error as {code?:string}).code || '';
        const message = code.includes('unauth') ? 'Sign in again to sync this thought.'
          : code.includes('permission') ? 'Sync was denied. This thought is still on this device.'
          : 'Waiting to sync. We will try again when this app is open.';
        await saveLocal({...entry,attempts,nextAttemptAt:Date.now()+Math.min(300000,2000*2**Math.min(attempts,7)),error:message});
      }
    }
    await syncDraftItems(uid);
  } finally { syncing = false; }
}
