import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Lightbulb, Check, CalendarDays, Folder, FileText, X, Clock3, Mic, Keyboard, Download, RotateCw, Square, Plus } from 'lucide-react';
import { emailLogin, loginWithGoogle, resetPassword } from './services/authService';
import { configured } from './firebase';
import { DEVICE_OWNER, draftItems, localEntries, newEntry, removeDraftItem, removeLocal, retryLocal, saveLocal, syncOutbox, type DraftItem, type OutboxEntry } from './outbox';
import { useRecorder } from './useRecorder';
import { localTranscriptionAvailable, retryDeviceTranscription } from './localTranscription';
import type { Capture, Item, ItemKind } from '../functions/src/domain';

export const kindLabel = (kind: string) => ({idea:'Thought',task:'To-do',event:'Event',note:'Note',project:'Project'}[kind] || kind);
export const kindIcon = (kind: string) => kind === 'idea' ? Lightbulb : kind === 'task' ? Check : kind === 'event' ? CalendarDays : kind === 'project' ? Folder : FileText;
export const itemColorClass = (kind: string, startsAt?: number | null) => kind + (kind === 'idea' && startsAt != null ? ' scheduled-thought' : '');
export const friendlyError = (error: unknown) => (error as Error)?.message?.replace(/^Firebase: /,'').replace(/\s*\(auth\/[^)]+\)\.?/,'') || 'Something went wrong. Please try again.';
export function dateKey(date: Date) {
  return date.getFullYear() + '-' + String(date.getMonth()+1).padStart(2,'0') + '-' + String(date.getDate()).padStart(2,'0');
}
export function timeLabel(time: number) { return new Date(time).toLocaleTimeString([],{hour:'numeric',minute:'2-digit'}); }
export function dateLabel(time: number) { return new Date(time).toLocaleDateString([],{month:'short',day:'numeric'}); }
export function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob); const link = document.createElement('a');link.href=url;link.download=name;link.click();setTimeout(() => URL.revokeObjectURL(url),30000);
}
export function Badge({kind,startsAt}: {kind: string;startsAt?: number | null}) { const Icon = kindIcon(kind);return <span className={'badge ' + itemColorClass(kind,startsAt)}><Icon size={13}/>{kindLabel(kind)}</span>; }
export function Empty({children,icon}: {children:ReactNode;icon?:ReactNode}) {return <div className="empty">{icon}<p>{children}</p></div>;}
export function Modal({title,children,onClose}: {title:string;children:ReactNode;onClose:()=>void}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {ref.current?.showModal();},[]);
  return <dialog ref={ref} className="dialog" onCancel={event => {event.preventDefault();onClose();}} onClick={event => {if(event.target === event.currentTarget) onClose();}}>
    <div className="dialog-inner"><div className="section-heading"><h2>{title}</h2><button className="icon-button" aria-label="Close dialog" onClick={onClose}><X size={20}/></button></div>{children}</div>
  </dialog>;
}
export function Login({onClose}: {onClose:()=>void}) {
  const [mode,setMode] = useState<'signin'|'signup'|'reset'>('signin');
  const [email,setEmail] = useState('');const [password,setPassword] = useState('');const [name,setName] = useState('');
  const [error,setError] = useState('');const [busy,setBusy] = useState(false);const [info,setInfo] = useState('');
  async function submit(action: () => Promise<unknown>) {
    setBusy(true);setError('');
    try {await action();if(mode === 'reset') setInfo('Check your email for a reset link.');else onClose();}
    catch(error) {setError(friendlyError(error));}finally{setBusy(false);}
  }
  return <Modal title={mode === 'signup' ? 'A little space for your thoughts' : mode === 'reset' ? 'Reset your password' : 'Welcome back'} onClose={onClose}>
    <p className="muted">Sign in on your phone and desktop to find everything in one place.</p>
    {!configured ? <p className="notice">The cloud workspace hasn’t been connected yet. You can explore the example while setup is completed.</p> : <>
      <button className="button secondary full" disabled={busy} onClick={() => submit(loginWithGoogle)}>Continue with Google</button>
      <div className="divider-label">or use your email</div>
      <form onSubmit={event => {event.preventDefault();void submit(() => mode === 'reset' ? resetPassword(email) : emailLogin(email,password,mode === 'signup' ? name : undefined));}}>
        {mode === 'signup' && <label>Your name<input autoComplete="name" value={name} onChange={e => setName(e.target.value)} required maxLength={80}/></label>}
        <label>Email<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} required/></label>
        {mode !== 'reset' && <label>Password<input type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} value={password} onChange={e => setPassword(e.target.value)} required minLength={6}/></label>}
        <button className="button primary full" disabled={busy}>{busy ? 'One moment…' : mode === 'signup' ? 'Create my workspace' : mode === 'reset' ? 'Send reset link' : 'Sign in'}</button>
      </form>
      <div className="inline-actions"><button className="text-button" onClick={() => {setMode(mode === 'signup' ? 'signin' : 'signup');setError('');}}>{mode === 'signup' ? 'Already have an account?' : 'Create an account'}</button><button className="text-button" onClick={() => setMode('reset')}>Forgot password?</button></div>
    </>}
    {error && <p role="alert" className="error">{error}</p>}{info && <p role="status" className="notice">{info}</p>}
  </Modal>;
}
export function ItemEditor({initial,projects,onSave,onDelete,onClose}: {
  initial:Partial<Item>;projects:Item[];onSave:(item:Partial<Item> & Pick<Item,'kind'|'title'>)=>Promise<void>;
  onDelete?:(item:Item)=>Promise<void>;onClose:()=>void
}) {
  const [kind,setKind] = useState<ItemKind>(initial.kind || 'idea');
  const [title,setTitle] = useState(initial.title || '');const [detail,setDetail] = useState(initial.detail || '');
  const [projectId,setProjectId] = useState(initial.projectId || '');const [priority,setPriority] = useState(initial.priority || 'normal');
  const [day,setDay] = useState(initial.startsAt ? dateKey(new Date(initial.startsAt)) : '');
  const [time,setTime] = useState(initial.startsAt ? new Date(initial.startsAt).toTimeString().slice(0,5) : '09:00');
  const [minutes,setMinutes] = useState(initial.durationMinutes || 30);
  const [error,setError] = useState('');const [busy,setBusy] = useState(false);const [confirmDelete,setConfirmDelete] = useState(false);
  const schedulable = ['idea','task','event'].includes(kind);
  const scheduled = schedulable && day ? new Date(day+'T'+time).getTime() : null;
  async function submit() {
    setBusy(true);setError('');
    try {await onSave({...initial,kind,title,detail,projectId:projectId || null,priority,startsAt:scheduled,durationMinutes:minutes});onClose();}
    catch(error) {setError(friendlyError(error));}finally{setBusy(false);}
  }
  return <Modal title={initial.id ? 'Make a little adjustment' : initial.sourceCaptureId ? 'Give this thought some time' : 'Add something'} onClose={onClose}>
    <form onSubmit={event => {event.preventDefault();void submit();}}>
      {!initial.id && !initial.sourceCaptureId && <div className="kind-picker" role="group" aria-label="Item type">{(['idea','task','event','note','project'] as ItemKind[]).map(k => <button key={k} type="button" className={'chip '+(kind===k?'selected '+k:'')} aria-pressed={kind===k} onClick={() => setKind(k)}>{kindLabel(k)}</button>)}</div>}
      <label>{kind === 'idea' ? 'What’s the thought?' : kind === 'event' ? 'What’s happening?' : 'Title'}<input value={title} onChange={e => setTitle(e.target.value)} required maxLength={160} autoFocus/></label>
      <label>A little context <span className="optional">(optional)</span><textarea rows={3} value={detail} onChange={e => setDetail(e.target.value)} maxLength={20000}/></label>
      {schedulable && <fieldset className="schedule-fields"><legend><Clock3 size={15}/>{kind === 'idea' ? 'Follow up on this thought' : kind === 'task' ? 'Make time for this to-do' : 'Event time'}</legend>
        {kind === 'idea' && <p className="muted small">It stays a thought. This just gives you a moment to revisit it.</p>}
        <div className="form-row"><label>Date{kind !== 'event' && <span className="optional"> (optional)</span>}<input type="date" value={day} onChange={e => setDay(e.target.value)} required={kind === 'event'}/></label><label>Time<input type="time" value={time} onChange={e => setTime(e.target.value)} disabled={!day} required={Boolean(day)}/></label></div>
        <div className="form-row"><label>Minutes<input type="number" min={5} max={480} step={5} value={minutes} onChange={e => setMinutes(Number(e.target.value))}/></label>{day && kind !== 'event' && <button type="button" className="text-button" onClick={() => setDay('')}>Leave unscheduled</button>}</div>
      </fieldset>}
      <details className="extra-options"><summary>More options</summary>
        {kind !== 'project' && <label>Project<select value={projectId} onChange={e => setProjectId(e.target.value)}><option value="">No project needed</option>{projects.map(p => <option key={p.id} value={p.id}>{p.title}</option>)}</select></label>}
        {kind === 'task' && <label className="checkbox-label"><input type="checkbox" checked={priority==='high'} onChange={e => setPriority(e.target.checked?'high':'normal')}/>A priority for today</label>}
      </details>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="dialog-actions">
        {initial.id && onDelete && <button type="button" className="text-button danger" disabled={busy} onClick={async () => {if(!confirmDelete){setConfirmDelete(true);return;}setBusy(true);try{await onDelete(initial as Item);onClose();}catch(e){setError(friendlyError(e));}finally{setBusy(false);}}}>{confirmDelete ? 'Confirm delete' : 'Delete'}</button>}
        <button type="submit" className="button primary" disabled={busy}>{busy?'Saving…':kind==='idea' && day?'Save follow-up':kind==='task' && day?'Save to plan':'Save '+kindLabel(kind).toLowerCase()}</button>
      </div>
    </form>
  </Modal>;
}
export function ItemCard({item,onEdit,onToggle}: {item:Item;onEdit:()=>void;onToggle?:()=>void}) {
  const Icon = kindIcon(item.kind);
  return <article className={'item-card '+itemColorClass(item.kind,item.startsAt)+(item.state==='done'?' completed':'')}>
    {item.kind==='task' && onToggle ? <button className="task-check" aria-label={item.state==='done'?'Reopen '+item.title:'Complete '+item.title} onClick={onToggle}>{item.state==='done'&&<Check size={14}/>}</button> : <span className={'item-symbol '+item.kind}><Icon size={18}/></span>}
    <button className="item-main" onClick={onEdit}><span className="item-title">{item.title}</span><span className="item-meta">{kindLabel(item.kind)}{item.startsAt ? ' · '+dateLabel(item.startsAt)+' · '+timeLabel(item.startsAt) : item.kind==='idea'?' · No rush':item.priority==='high'?' · Priority':''}</span></button>
    <button className="icon-button muted" onClick={onEdit} aria-label={(item.kind==='idea'?'Follow up on ':'Edit ')+item.title}><Clock3 size={17}/></button>
  </article>;
}
export function CapturePanel({uid,demo,onDemoCapture,onNotice}: {uid:string|null;demo:boolean;onDemoCapture:(text:string)=>void;onNotice:(text:string)=>void}) {
  const owner = demo ? 'example-workspace' : uid || DEVICE_OWNER;
  const composeKey = 'thoughtsplat-compose:' + owner;
  const [text,setText] = useState(() => {try{return sessionStorage.getItem(composeKey)||'';}catch{return '';}});
  const [busy,setBusy] = useState(false);const [error,setError] = useState('');
  const [lastSaved,setLastSaved] = useState('');
  const textEntry = useRef<OutboxEntry | null>(null);
  const [pending,setPending] = useState<OutboxEntry[]>([]);const [online,setOnline] = useState(navigator.onLine);
  const [pendingImports,setPendingImports] = useState<DraftItem[]>([]);
  const [localSpeech,setLocalSpeech] = useState(false);
  useEffect(() => {if(!uid&&!demo)void localTranscriptionAvailable().then(available=>setLocalSpeech(Boolean(available)));},[uid,demo]);
  const latestVoice = !uid&&!demo ? pending.find(entry=>entry.source==='voice'&&entry.phase==='queued') : undefined;
  useEffect(() => {try{if(text)sessionStorage.setItem(composeKey,text);else sessionStorage.removeItem(composeKey);}catch{}},[text,composeKey]);
  const refresh = () => {if(owner) void localEntries(owner).then(setPending).catch(() => setError('This browser could not open device storage.'));if(uid&&!demo)void draftItems(uid).then(setPendingImports).catch(()=>{});};
  const recorded = () => {refresh();if(uid&&!demo)void syncOutbox(uid);onNotice(demo?'Recording saved on this device. Example mode does not transcribe or sync.':'Thought saved on this device. You can return to your day.');};
  const audio = useRecorder(owner,recorded);
  useEffect(() => {
    refresh();
    const sync = () => {setOnline(navigator.onLine);refresh();if(uid&&!demo)void syncOutbox(uid);};
    const interval = setInterval(sync,15000);
    window.addEventListener('outbox-change',refresh);window.addEventListener('online',sync);window.addEventListener('offline',sync);
    return () => {clearInterval(interval);window.removeEventListener('outbox-change',refresh);window.removeEventListener('online',sync);window.removeEventListener('offline',sync);};
  },[owner,uid,demo]);
  async function saveText() {
    if(!text.trim() || busy)return;setBusy(true);setError('');
    try {
      if(demo){onDemoCapture(text.trim());onNotice('Added to the example. Example text resets when you refresh.');}
      else {
        if(!textEntry.current || textEntry.current.text!==text.trim())textEntry.current=newEntry(owner,'text',text.trim());
        await saveLocal(textEntry.current);
        if(uid)void syncOutbox(uid);
        onNotice(uid?'Thought saved. No need to organize it now.':'Thought saved on this device. Cloud sync is not connected yet.');
      }
      setLastSaved(text.trim());textEntry.current=null;
      setText('');refresh();
    }catch(error){setError(friendlyError(error));}finally{setBusy(false);}
  }
  return <div className="capture-layout">
    <section className="capture-card">
      <div className="capture-orbit" aria-hidden="true"><img src="/thoughtsplat-mark.svg" width="68" height="68" alt=""/></div>
      <p className="eyebrow">A little space for your mind</p><h1>What’s on your mind?</h1>
      <p className="capture-description">A half-formed idea. Something to do.<br/>Something you don’t want to forget.</p>
      <button className={'record-button '+(audio.recording?'recording':'')} onClick={audio.recording?audio.stop:audio.start} disabled={audio.starting || !owner}>
        {audio.recording?<Square size={24} fill="currentColor"/>:<Mic size={26}/>}<span>{audio.starting?'Opening microphone…':audio.recording?'Save my thought':'Tap to speak'}</span>
        {audio.recording&&<span className="record-time">{Math.floor(audio.seconds/60)}:{String(audio.seconds%60).padStart(2,'0')}</span>}
      </button>
      <p className="microcopy">{audio.recording?'Tap to finish. No review needed.':!uid&&!demo?(localSpeech?'Your transcript appears here after you stop.':'Audio stays saved here. Transcription is not connected yet.'):'Speak naturally. We’ll help you make sense of it later.'}</p>
      <div className="divider-label"><Keyboard size={14}/>or type or paste</div>
      <form onSubmit={e => {e.preventDefault();void saveText();}}>
        <label className="sr-only" htmlFor="thought-text">Your thought</label>
        <textarea id="thought-text" className="thought-input" placeholder="Let it out. It doesn’t have to be organized…" rows={4} value={text} onChange={e=>setText(e.target.value)} maxLength={20000}/>
        <div className="capture-footer"><span>No categories. No decisions.</span><button className="button primary" disabled={!text.trim()||busy}>{busy?'Saving…':'Save thought'}</button></div>
      </form>
      {lastSaved&&<div className="saved-confirmation"><strong><Check size={16}/>{demo?'Added to example':'Thought saved'}</strong><p>{lastSaved}</p><span>Find it in Today or Saved. No need to organize it now.</span></div>}
      {latestVoice&&<div className="saved-confirmation voice-transcript" aria-live="polite">
        <strong><Mic size={16}/>{latestVoice.text?'Voice thought':latestVoice.transcription==='transcribing'?'Transcribing your thought…':'Voice thought saved'}</strong>
        {latestVoice.text?<p>{latestVoice.text}</p>:<p>{latestVoice.transcriptionError||(localSpeech?'Your words will appear here when transcription finishes.':'Transcription is not connected. Your audio is still saved.')}</p>}
        {latestVoice.transcription==='failed'&&<button className="text-button" onClick={()=>void retryDeviceTranscription(latestVoice.id)}>Retry transcription</button>}
        <span>Find this thought in Today or Saved.</span>
      </div>}
      {(error||audio.error)&&<p className="error" role="alert">{error||audio.error}</p>}
      {error&&<div className="inline-actions"><button className="text-button" onClick={()=>{try{sessionStorage.setItem(composeKey,text);}catch{}location.reload();}}>Reload safely</button>{text&&<button className="text-button" onClick={()=>download(new Blob([text],{type:'text/plain'}),'my-thought.txt')}>Download my text</button>}</div>}
      {audio.rescue&&<button className="button secondary full" onClick={()=>download(audio.rescue!,'my-thought.'+(audio.rescue!.type.includes('mp4')?'m4a':'webm'))}><Download size={16}/>Download recording</button>}
    </section>
    {(pending.length>0||pendingImports.length>0)&&<details className="capture-queue" open={pending.some(entry=>Boolean(entry.error)||entry.phase==='recording'&&!audio.recording)||pendingImports.length>0}>
      <summary>{pending.length+pendingImports.length} {pending.length+pendingImports.length===1?'thought':'thoughts'} saved on this device</summary>
      <div className="sync-card">{!online&&<span className="pill">Offline</span>}
        {pendingImports.map(item=><div className="local-entry" key={item.id}><Clock3 size={15}/><div><strong>{item.title}</strong><small>{item.error||'Waiting to import into your cloud workspace.'}</small><div className="inline-actions"><button className="text-button" onClick={()=>void syncOutbox(uid!).then(refresh)}>Retry import</button><button className="text-button" onClick={()=>download(new Blob([JSON.stringify(item,null,2)],{type:'application/json'}),'thoughtsplat-draft.json')}>Download copy</button><button className="text-button danger" onClick={()=>{if(window.confirm('Discard this device draft?'))void removeDraftItem(item.id).then(refresh);}}>Discard</button></div></div></div>)}
        {pending.map(entry=><div className="local-entry" key={entry.id}>
          <span>{entry.source==='voice'?<Mic size={15}/>:<Keyboard size={15}/>}</span><div><strong>{entry.source==='voice'?'Voice thought':entry.text.slice(0,50)}</strong><small>{entry.phase==='recording'?(audio.recording?'Recording…':'Unfinished recording'):entry.transcription==='transcribing'?'Transcribing…':entry.transcriptionError||entry.error||(entry.transcription==='ready'?'Transcript saved on this device':'Saved on this device · waiting to sync')}</small>
          <div className="inline-actions">{entry.phase==='recording'&&!audio.recording&&entry.blob?.size ? <button className="text-button" onClick={()=>void retryLocal(entry).then(recorded)}>Recover recording</button>:null}
            {entry.phase==='queued'&&!demo&&uid&&<button className="text-button" onClick={()=>void retryLocal(entry).then(()=>syncOutbox(uid!))}><RotateCw size={13}/>Retry</button>}
            {entry.blob&&<button className="text-button" onClick={()=>download(entry.blob!,'thought.'+(entry.mimeType==='audio/mp4'?'m4a':'webm'))}>Download</button>}
            <button className="text-button danger" onClick={()=>{if(window.confirm('Discard this unsynced thought from this device?'))void removeLocal(entry.id);}}>Discard</button>
          </div></div>
        </div>)}
      </div>
    </details>}
  </div>;
}
