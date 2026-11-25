import { useEffect, useState } from 'react';
import { collection, doc, limit, onSnapshot, orderBy, query, where, writeBatch } from 'firebase/firestore';
import { httpsCallable } from 'firebase/functions';
import { db, functions } from './firebase';
import { applyProposal, overlaps, validateItem, type Capture, type Item, type Proposal } from '../functions/src/domain';
import { exampleWorkspace } from './demo';
import { DEVICE_OWNER, draftItems, localEntries, removeDraftItem, saveDraftItem, saveLocal } from './outbox';

export function useWorkspace(uid: string | null, demo: boolean, deviceOnly = false) {
  const [items,setItems] = useState<Item[]>([]);
  const [captures,setCaptures] = useState<Capture[]>([]);
  const [proposals,setProposals] = useState<Proposal[]>([]);
  const [error,setError] = useState('');
  const [loading,setLoading] = useState(true);
  const [captureLimit,setCaptureLimit] = useState(100);
  useEffect(() => {
    setError('');setItems([]);setCaptures([]);setProposals([]);
    if (demo) {
      const sample = exampleWorkspace();
      setItems(sample.items);setCaptures(sample.captures);setProposals(sample.proposals);setLoading(false);
      return;
    }
    if (deviceOnly) {
      let active = true;
      const refresh = async () => {
        try {
          const [drafts, originals] = await Promise.all([draftItems(), localEntries(DEVICE_OWNER)]);
          if (!active) return;
          setItems(drafts);
          setCaptures(originals.map(entry => ({id:entry.id,source:entry.source,text:entry.text,mimeType:entry.mimeType,createdAt:entry.createdAt,updatedAt:entry.updatedAt,timezone:entry.timezone,status:'queued',localOnly:true,reviewedAt:entry.reviewedAt})));
          setLoading(false);
        } catch {if(active){setError('Device storage is unavailable. Your thought has not been saved.');setLoading(false);}}
      };
      void refresh(); window.addEventListener('outbox-change',refresh);
      return () => {active=false;window.removeEventListener('outbox-change',refresh);};
    }
    if (!uid || !db) {setLoading(false);return;}
    setLoading(true);
    let remaining = 3;
    const ready = () => {remaining--;if (remaining <= 0) setLoading(false);};
    const failure = () => {setError('Could not reach your workspace. Your unsynced captures remain on this device.');setLoading(false);};
    const subscriptions = [
      onSnapshot(query(collection(db,'users',uid,'items'),limit(500)),snap => {setItems(snap.docs.map(d => ({...d.data(),id:d.id} as Item)));ready();},failure),
      onSnapshot(query(collection(db,'users',uid,'captures'),orderBy('createdAt','desc'),limit(captureLimit)),snap => {setCaptures(snap.docs.map(d => ({...d.data(),id:d.id} as Capture)));ready();},failure),
      onSnapshot(query(collection(db,'users',uid,'proposals'),where('status','==','pending'),limit(200)),snap => {setProposals(snap.docs.map(d => ({...d.data(),id:d.id} as Proposal)));ready();},failure)
    ];
    return () => subscriptions.forEach(unsub => unsub());
  },[uid,demo,deviceOnly,captureLimit]);
  const call = async (name: string, data: unknown) => {
    if (!uid || !functions) throw new Error('Sign in to your cloud workspace.');
    return (await httpsCallable(functions,name)(data)).data;
  };
  async function save(item: Partial<Item> & Pick<Item,'kind'|'title'>) {
    const id = item.id || crypto.randomUUID();
    const values = validateItem({detail:'',state:'open',priority:'normal',projectId:null,startsAt:null,durationMinutes:30,...item});
    if (demo || deviceOnly) {
      const previous = items.find(i => i.id === id);
      if (values.startsAt !== null && values.state !== 'done' && items.some(i => i.id !== id && i.state !== 'done' && overlaps(values,i))) throw new Error('That time overlaps another thought, task, or event. Choose an open time.');
      const saved = {...values,id,createdAt:previous?.createdAt || Date.now(),updatedAt:Date.now(),version:(previous?.version || 0)+1,sourceCaptureId:item.sourceCaptureId || null};
      if (deviceOnly) await saveDraftItem(saved);
      setItems(old => [...old.filter(i => i.id !== id),saved]);
    } else await call('saveItem',{id,item:values,version:item.version ?? null,sourceCaptureId:item.sourceCaptureId || null});
  }
  async function remove(item: Item) {
    if (demo || deviceOnly) {
      if (items.some(i => i.projectId === item.id)) throw new Error('Move this project’s items before deleting it.');
      if (deviceOnly) await removeDraftItem(item.id);
      setItems(old => old.filter(i => i.id !== item.id));
    } else await call('deleteItem',{id:item.id,version:item.version});
  }
  async function review(ids: string[], action: 'approve'|'dismiss') {
    if (demo) {
      const selected = proposals.filter(p => ids.includes(p.id) && p.status === 'pending');
      const next = new Map(items.map(i => [i.id,i]));
      if (action === 'approve') for (const proposal of selected) {
        const item = applyProposal(proposal,next.get(proposal.targetId || ''),Date.now());
        if (item.startsAt !== null && [...next.values()].some(i => i.id !== item.id && i.state !== 'done' && overlaps(i,item))) throw new Error('This time overlaps your plan. Schedule the thought individually.');
        next.set(item.id,item);
      }
      setItems([...next.values()]);
      setProposals(old => old.filter(p => !ids.includes(p.id)));
    } else await call('reviewProposals',{ids,action});
  }
  async function markReviewed() {
    if (deviceOnly) {
      for (const entry of await localEntries(DEVICE_OWNER)) await saveLocal({...entry,reviewedAt:Date.now()});
      return;
    }
    const unread = captures.filter(c => !c.reviewedAt && c.status === 'ready');
    if (demo) setCaptures(old => old.map(c => unread.some(u => u.id === c.id) ? {...c,reviewedAt:Date.now()} : c));
    else if (db && uid) {
      // Only mark the exact ready thoughts currently visible, never a timestamp watermark.
      for (let start = 0; start < unread.length; start += 400) {
        const batch = writeBatch(db);
        unread.slice(start,start+400).forEach(c => batch.update(doc(db!,'users',uid,'captures',c.id),{reviewedAt:Date.now()}));
        await batch.commit();
      }
    }
  }
  function addDemoCapture(text: string) {
    setCaptures(old => [{id:crypto.randomUUID(),source:'text',text,mimeType:'',createdAt:Date.now(),updatedAt:Date.now(),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,status:'ready',summary:'Example thought · AI processing is available in a connected workspace.'},...old]);
  }
  return {items,captures,proposals,error,loading,save,remove,review,markReviewed,addDemoCapture,
    retry:(id:string) => call('retryCapture',{id}),loadMore:() => setCaptureLimit(n => n+100),hasMore:captures.length >= captureLimit};
}
