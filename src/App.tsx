import { useEffect, useRef, useState } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';
import { AudioLines, Sun, Moon, Mic, Lightbulb, Check, CalendarDays, Plus, Sparkles, BookOpen, LogOut, WifiOff, ChevronRight, CircleHelp, Clock3, Play, LoaderCircle, Keyboard } from 'lucide-react';
import { getBlob, ref } from 'firebase/storage';
import { useAuth } from './contexts/AuthContext';
import { configured, storage } from './firebase';
import { logout } from './services/authService';
import { useWorkspace } from './useWorkspace';
import { DEVICE_OWNER, adoptDeviceDrafts, draftItems, localEntries, syncOutbox } from './outbox';
import { Badge, CapturePanel, dateKey, dateLabel, Empty, friendlyError, ItemCard, itemColorClass, ItemEditor, Login, timeLabel } from './components';
import Calendar from './Calendar';
import type { Capture, Item, Proposal } from '../functions/src/domain';

type View = 'capture'|'today'|'calendar'|'saved';
const navigation = [{id:'capture' as const,label:'Capture',icon:Mic},{id:'today' as const,label:'Today',icon:Sun},{id:'calendar' as const,label:'Calendar',icon:CalendarDays},{id:'saved' as const,label:'Saved',icon:BookOpen}];
function ThoughtCard({capture,startsAt,demo,uid,onFollowUp,onRetry}: {capture:Capture;startsAt?:number|null;demo:boolean;uid:string|null;onFollowUp:()=>void;onRetry:()=>void}) {
  const [expanded,setExpanded]=useState(false);const [url,setUrl]=useState('');const [error,setError]=useState('');
  const audioUrl = useRef('');
  useEffect(()=>()=>{if(audioUrl.current)URL.revokeObjectURL(audioUrl.current);},[]);
  async function listen() {
    try {let blob:Blob;if(capture.localOnly){const local=(await localEntries(DEVICE_OWNER)).find(entry=>entry.id===capture.id);if(!local?.blob)throw new Error('Recording not found');blob=local.blob;}else{if(!uid||!storage)return;blob=await getBlob(ref(storage,'users/'+uid+'/captures/'+capture.id+'/audio'));}audioUrl.current=URL.createObjectURL(blob);setUrl(audioUrl.current);}
    catch{setError('Audio could not be loaded. Please try again.');}
  }
  const status = capture.localOnly ? capture.status==='transcribing'?'Transcribing':capture.status==='failed'?'Transcription needs another try':capture.source==='voice'&&!capture.text?'Audio saved · transcript pending':'Saved on this device' : {uploading:'Waiting for audio upload',queued:'Waiting to process',transcribing:'Transcribing',organizing:'Finding the useful pieces',ready:'Ready',failed:'Needs another try'}[capture.status];
  return <article className={'thought-card '+itemColorClass('idea',startsAt)}>
    <div className="thought-meta"><span className={capture.source==='voice'?'voice-source':undefined}>{capture.source==='voice'?<Mic size={13}/>:<Keyboard size={13}/>} {capture.source==='voice'?'Spoken':'Typed'} · {dateLabel(capture.createdAt)} · {timeLabel(capture.createdAt)}</span>{capture.status!=='ready'&&<span className="processing">{capture.localOnly&&capture.status!=='transcribing'?<Clock3 size={13}/>:capture.status==='failed'?<CircleHelp size={13}/>:<LoaderCircle className="spin" size={13}/>} {status}</span>}</div>
    <button className="thought-title" onClick={()=>setExpanded(!expanded)} aria-expanded={expanded}>{capture.summary||capture.text.slice(0,140)||(capture.source==='voice'?'Voice thought · audio saved':'A thought, safely captured')}</button>
    {startsAt!=null&&<span className="thought-follow-up"><Clock3 size={13}/>Follow-up · {dateLabel(startsAt)} · {timeLabel(startsAt)}</span>}
    {expanded&&<div className="thought-detail"><p>{capture.text||(capture.status==='transcribing'?'Transcribing your recording…':capture.localOnly?'Your recording is saved. Transcription needs a connected service. You can listen to the original below.':'The original recording is saved. Its transcript will appear here when processing finishes.')}</p>{demo&&capture.source==='voice'?<p className="small muted">Illustrative transcript. There is no example audio file.</p>:capture.source==='voice'&&<>{url?<audio src={url} controls/>:<button className="text-button" onClick={listen}><Play size={13}/>Listen to original</button>}</>}{error&&<p className="error" role="alert">{error}</p>}</div>}
    {capture.localOnly&&capture.error&&<p className="error" role="alert">{capture.error}</p>}
    <div className="thought-actions"><button className="text-button" onClick={onFollowUp}><Clock3 size={14}/>Follow up on this</button>{capture.status==='failed'&&<button className="text-button" onClick={onRetry}>{capture.localOnly?'Retry transcription':'Retry processing'}</button>}<button className="text-button muted" onClick={()=>setExpanded(!expanded)}>{expanded?'Less':'Original thought'}</button></div>
  </article>;
}
function ProposalCard({proposal,onApprove,onDismiss,busy}: {proposal:Proposal;onApprove:()=>void;onDismiss:()=>void;busy:boolean}) {
  const type = proposal.kind==='idea'?'idea':proposal.kind==='event'?'event':['task','reminder','update'].includes(proposal.kind)?'task':proposal.kind==='schedule'?'idea':'note';
  return <article className={'proposal-card '+type}><div className="proposal-content"><div className="inline-actions"><Badge kind={type}/><span className="proposal-label">{proposal.kind==='schedule'?'Suggested follow-up':proposal.kind==='question'?'A question for later':'Suggestion'}</span></div><h3>{proposal.title}</h3><p>{proposal.detail}</p>{proposal.startsAt&&<span className="proposed-time"><Clock3 size={14}/>{dateLabel(proposal.startsAt)} · {timeLabel(proposal.startsAt)} · {proposal.durationMinutes} min</span>}</div><div className="proposal-actions">{proposal.kind!=='question'&&<button className="button small-button secondary" disabled={busy} onClick={onApprove}><Check size={14}/>{proposal.kind==='schedule'?'Make time':'Keep this'}</button>}<button className="text-button muted" disabled={busy} onClick={onDismiss}>{proposal.kind==='question'?'Dismiss':'Not now'}</button></div></article>;
}
export default function App() {
  const {user,loading:authLoading}=useAuth();
  const [demo,setDemo]=useState(()=>new URLSearchParams(location.search).has('demo'));
  const deviceOnly=!configured&&!demo;
  const [deviceDraftCount,setDeviceDraftCount]=useState(0);
  const [view,setView]=useState<View>(()=>matchMedia('(max-width: 760px)').matches?'capture':'today');
  const [login,setLogin]=useState(false);const [editing,setEditing]=useState<Partial<Item>|null>(null);
  const [notice,setNotice]=useState('');const [actionError,setActionError]=useState('');const [busy,setBusy]=useState(false);
  const [filter,setFilter]=useState('all');const [search,setSearch]=useState('');const [online,setOnline]=useState(navigator.onLine);const [pending,setPending]=useState(0);
  const [theme,setTheme]=useState(()=>{try{return localStorage.getItem('ag-theme')||'dark';}catch{return 'dark';}});
  const workspace=useWorkspace(user?.uid||null,demo,deviceOnly);
  const {needRefresh:[needRefresh],updateServiceWorker}=useRegisterSW();
  useEffect(()=>{document.documentElement.dataset.theme=theme;try{localStorage.setItem('ag-theme',theme);}catch{}},[theme]);
  useEffect(()=>{if(user || (!configured&&!new URLSearchParams(location.search).has('demo')))setDemo(false);},[user?.uid]);
  useEffect(()=>{const refresh=()=>{void Promise.all([localEntries(DEVICE_OWNER),draftItems()]).then(([captures,items])=>setDeviceDraftCount(captures.length+items.length)).catch(()=>{});};refresh();window.addEventListener('outbox-change',refresh);return()=>window.removeEventListener('outbox-change',refresh);},[]);
  useEffect(()=>{if(!notice)return;const timeout=setTimeout(()=>setNotice(''),6500);return()=>clearTimeout(timeout);},[notice]);
  useEffect(()=>{
    const sync=()=>{setOnline(navigator.onLine);if(user&&!demo){void Promise.all([localEntries(user.uid),draftItems(user.uid)]).then(([entries,items])=>setPending(entries.length+items.length)).catch(()=>{});void syncOutbox(user.uid);}};
    sync();const timer=setInterval(sync,15000);
    window.addEventListener('online',sync);window.addEventListener('offline',sync);window.addEventListener('focus',sync);window.addEventListener('outbox-change',sync);
    return()=>{clearInterval(timer);window.removeEventListener('online',sync);window.removeEventListener('offline',sync);window.removeEventListener('focus',sync);window.removeEventListener('outbox-change',sync);};
  },[user?.uid,demo]);
  async function action(fn:()=>Promise<unknown>,message?:string) {
    if(busy)return;setBusy(true);setActionError('');
    try{await fn();if(message)setNotice(message);}catch(error){setActionError(friendlyError(error));}finally{setBusy(false);}
  }
  const toggle=(item:Item)=>void action(()=>workspace.save({...item,state:item.state==='done'?'open':'done'}),item.state==='done'?'To-do reopened.':'One less thing on your mind.');
  const linkedThought=(capture:Capture)=>workspace.items.find(item=>item.kind==='idea'&&item.sourceCaptureId===capture.id&&item.startsAt!=null)||workspace.items.find(item=>item.kind==='idea'&&item.sourceCaptureId===capture.id);
  const followUp=(capture:Capture)=>setEditing(linkedThought(capture)||{kind:'idea',title:(capture.summary||capture.text||'Follow up on my thought').slice(0,160),detail:capture.text,sourceCaptureId:capture.id});
  const projects=workspace.items.filter(i=>i.kind==='project');
  const today=workspace.items.filter(i=>i.startsAt&&dateKey(new Date(i.startsAt))===dateKey(new Date())&&i.state!=='done').sort((a,b)=>a.startsAt!-b.startsAt!);
  const priorities=workspace.items.filter(i=>i.kind==='task'&&i.state!=='done').sort((a,b)=>Number(b.priority==='high')-Number(a.priority==='high')).slice(0,3);
  const unread=workspace.captures.filter(c=>!c.reviewedAt);
  const pendingProposals=workspace.proposals.filter(p=>p.status==='pending');
  const approvable=pendingProposals.filter(p=>p.kind!=='question').slice(0,50);
  const firstName=demo?'':user?.displayName?.split(' ')[0]||'';
  const greeting=new Date().getHours()<12?'Good morning':new Date().getHours()<18?'Good afternoon':'Good evening';
  const showApp=demo||deviceOnly||Boolean(user);
  const saved=workspace.items.filter(i=>(filter==='all'||i.kind===filter)&&(!search||[i.title,i.detail].join(' ').toLowerCase().includes(search.toLowerCase()))).sort((a,b)=>b.updatedAt-a.updatedAt);
  const rawThoughts=['all','idea'].includes(filter)?workspace.captures.filter(c=>!workspace.items.some(i=>i.sourceCaptureId===c.id)&&(c.text+' '+(c.summary||'')).toLowerCase().includes(search.toLowerCase())):[];
  return <>
    <a className="skip-link" href="#main">Skip to content</a>
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" onClick={e=>{e.preventDefault();setView(matchMedia('(max-width:760px)').matches?'capture':'today');}}><span className="brand-mark"><img src="/thoughtsplat-mark.svg" width="34" height="34" alt=""/></span><span>Thought<span className="brand-light">Splat</span><small>Speak your thoughts. Organize your day.</small></span></a>
        <div className="sidebar-body"><p className="nav-label">YOUR SPACE</p><nav aria-label="Main navigation">{navigation.map(({id,label,icon:Icon})=><button key={id} aria-label={label} aria-current={view===id?'page':undefined} className={view===id?'active':''} onClick={()=>setView(id)}><Icon size={20}/><span>{label}</span>{id==='today'&&pendingProposals.length>0&&<span className="nav-count">{pendingProposals.length}</span>}</button>)}</nav>
        <div className="sidebar-note"><Lightbulb size={19}/><p>Good ideas don’t always<br/>happen at your desk.</p><span>Give them somewhere to land.</span></div></div>
        <div className="profile"><div className="avatar">{firstName?firstName[0].toUpperCase():demo?'A':<Lightbulb size={18}/>}</div><div><strong>{demo?'Example workspace':user?.displayName||'Your workspace'}</strong><small>{demo?'A little look around':user?.email||(deviceOnly?'Saved on this device':'Make yourself at home')}</small></div>{user&&!demo?<button className="icon-button" title="Sign out" aria-label="Sign out" onClick={()=>void logout()}><LogOut size={17}/></button>:<button className="text-button" onClick={()=>setLogin(true)}>Sign in</button>}</div>
      </aside>
      <div className="main-shell">
        <header className="topbar"><div className="mobile-brand"><img src="/thoughtsplat-mark.svg" width="29" height="29" alt=""/><strong>ThoughtSplat</strong></div><span className="desktop-date">{new Date().toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})}</span><div className="topbar-actions">{!online?<span className="connection offline"><WifiOff size={14}/>Offline</span>:demo?<span className="connection">Example</span>:pending>0?<button className="text-button" onClick={()=>setView('capture')}>{pending} waiting to sync</button>:user?<span className="connection">Cloud workspace</span>:deviceOnly?<span className="connection">This device</span>:null}<button className="icon-button" aria-label={theme==='dark'?'Switch to light mode':'Switch to dark mode'} onClick={()=>setTheme(theme==='dark'?'light':'dark')}>{theme==='dark'?<Sun size={18}/>:<Moon size={18}/>}</button>{user&&!demo?<button className="mobile-signout icon-button" aria-label="Sign out" onClick={()=>void logout()}><LogOut size={16}/></button>:<button className="mobile-signout text-button" onClick={()=>setLogin(true)}>Sign in</button>}</div></header>
        {demo&&<div className="example-banner"><span><Sparkles size={14}/>Example workspace · Explore freely. Planning changes reset on refresh.</span><button className="text-button" onClick={()=>setLogin(true)}>Use my own workspace<ChevronRight size={14}/></button></div>}
        {deviceOnly&&<div className="device-banner"><span>Your thoughts stay on this device until cloud sync is connected.</span></div>}
        {user&&!demo&&deviceDraftCount>0&&<div className="device-banner"><span>{deviceDraftCount} drafts are waiting on this device.</span><button className="text-button" disabled={busy} onClick={()=>void action(async()=>{await adoptDeviceDrafts(user.uid);await syncOutbox(user.uid);},'Your drafts are queued for this account. They stay on this device until synced.')}>Move drafts to my workspace</button></div>}
        <main id="main" className={'main-content view-'+view}>
          {authLoading?<Empty><LoaderCircle className="spin"/>Opening your space…</Empty>:!showApp?<section className="welcome"><div className="welcome-icon"><img src="/thoughtsplat-mark.svg" width="64" height="64" alt="ThoughtSplat"/></div><p className="eyebrow">A home for what’s on your mind</p><h1>Your ideas don’t<br/>keep office hours.</h1><p>Speak, type or paste a thought. Come back to it when you’re ready.<br/>Some become to-dos. Some just need a little time.</p><div className="inline-actions"><button className="button primary" onClick={()=>setLogin(true)}>Make room for your thoughts</button><button className="button secondary" onClick={()=>setDemo(true)}>Explore an example</button></div><div className="welcome-flow"><span><Mic/>Capture in the moment</span><span><Lightbulb/>Keep the idea</span><span><CalendarDays/>Give it some time</span></div></section>:<>
            {(workspace.error||actionError)&&<div className="error alert" role="alert">{workspace.error||actionError}<button className="text-button" onClick={()=>setActionError('')}>Dismiss</button></div>}
            {view==='capture'&&<CapturePanel key={demo?'example':user?.uid||DEVICE_OWNER} uid={user?.uid||null} demo={demo} onDemoCapture={workspace.addDemoCapture} onNotice={setNotice}/>}
            {view==='today'&&<>
              <div className="page-heading"><div><p className="eyebrow">{greeting}{firstName?', '+firstName:''}</p><h1>Your thoughts, ready when you are.</h1><p className="muted">{unread.length?unread.length+' thought'+(unread.length===1?' has':'s have')+' landed since your last review.':'A clear place to start. Capture a thought whenever it comes.'}</p></div><button className="button secondary desktop-only" onClick={()=>setView('capture')}><Plus size={16}/>Capture a thought</button></div>
              <div className="today-grid"><div className="today-main">
                <section className="briefing-card"><div className="briefing-heading"><span className="sparkle-icon"><Sparkles size={20}/></span><div><h2>A little clarity for your day</h2><p>{pendingProposals.length?'A few possibilities from what’s on your mind. You decide what stays.':'Your ideas don’t have to become a to-do list.'}</p></div></div><div className="briefing-stats"><div><strong>{unread.length}</strong><span>new thoughts</span></div><div><strong>{pendingProposals.length}</strong><span>suggestions to review</span></div><div><strong>{today.length}</strong><span>moments set aside</span></div></div></section>
                <section><div className="section-heading"><h2>Worth a look <span className="count">{pendingProposals.length}</span></h2>{approvable.length>1&&<button disabled={busy} className="text-button" onClick={()=>void action(()=>workspace.review(approvable.map(p=>p.id),'approve'),'Suggestions added to your workspace.')}>Keep all {approvable.length}</button>}</div>
                  {pendingProposals.length?pendingProposals.map(p=><ProposalCard key={p.id} proposal={p} busy={busy} onApprove={()=>void action(()=>workspace.review([p.id],'approve'),'Saved to your workspace.')} onDismiss={()=>void action(()=>workspace.review([p.id],'dismiss'),'Suggestion dismissed. Your original thought is still saved.')}/>):<Empty icon={<Lightbulb size={26}/>}>Nothing to decide right now. Your next thought can be just a thought.</Empty>}
                </section>
                <section><div className="section-heading"><h2>{unread.length?'Since you last checked in':'Recent thoughts'}</h2>{unread.some(c=>c.status==='ready'||c.localOnly)&&<button className="text-button" disabled={busy} onClick={()=>void action(workspace.markReviewed,'Caught up. Suggestions are still here until you decide.')}>Mark reviewed</button>}</div>
                  {(unread.length?unread:workspace.captures).slice(0,6).map(c=><ThoughtCard key={c.id} capture={c} startsAt={linkedThought(c)?.startsAt} demo={demo} uid={user?.uid||null} onFollowUp={()=>followUp(c)} onRetry={()=>void action(()=>workspace.retry(c.id),'Processing will try again.')}/>)}
                  {!workspace.captures.length&&<Empty>Late-night ideas, morning plans, little reminders. They’ll be waiting here.</Empty>}
                </section>
              </div><aside className="today-aside"><section className="agenda-card"><div className="section-heading"><h2>Today, gently planned</h2><CalendarDays size={19}/></div><p className="small muted">Thoughts, to-dos, and events.</p>{today.length?today.map(item=><div className="mini-agenda" key={item.id}><time>{timeLabel(item.startsAt!)}</time><button className={'mini-agenda-item '+itemColorClass(item.kind,item.startsAt)} onClick={()=>setEditing(item)}><span>{item.title}</span><small>{kindLabelForAgenda(item.kind)} · {item.durationMinutes} min</small></button></div>):<p className="muted">There’s room in your day. Give a thought a little time.</p>}<button className="button secondary full" onClick={()=>setView('calendar')}>Open calendar</button></section>
                <section className="priority-section"><div className="section-heading"><h2>A place to start</h2><Check size={19}/></div><p className="small muted">Your priorities, one at a time.</p>{priorities.map(item=><ItemCard key={item.id} item={item} onEdit={()=>setEditing(item)} onToggle={()=>toggle(item)}/>)}{!priorities.length&&<p className="muted small">No to-dos asking for your attention.</p>}<button className="text-button" onClick={()=>setEditing({kind:'task'})}><Plus size={14}/>Add a to-do</button></section>
              </aside></div>
            </>}
            {view==='calendar'&&<Calendar items={workspace.items} onEdit={setEditing} onToggle={toggle}/>}
            {view==='saved'&&<>
              <div className="page-heading"><div><p className="eyebrow">Nothing good gets lost</p><h1>A place for everything.</h1><p className="muted">Thoughts can stay thoughts. Find them when you need them.</p></div><button className="button primary" onClick={()=>setEditing({kind:'idea'})}><Plus size={16}/>Add something</button></div>
              <div className="saved-toolbar"><div className="filter-chips">{[['all','Everything'],['idea','Thoughts'],['task','To-dos'],['note','Notes'],['project','Projects'],['event','Events'],['captures','Originals']].map(([value,label])=><button key={value} className={'chip '+(filter===value?'selected':'')} aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</div><input type="search" aria-label="Search saved thoughts" placeholder="Find a thought…" value={search} onChange={e=>setSearch(e.target.value)}/></div>
              {filter==='captures'?<><div className="originals-list">{workspace.captures.filter(c=>(c.text+' '+c.summary).toLowerCase().includes(search.toLowerCase())).map(c=><ThoughtCard key={c.id} capture={c} startsAt={linkedThought(c)?.startsAt} demo={demo} uid={user?.uid||null} onFollowUp={()=>followUp(c)} onRetry={()=>void action(()=>workspace.retry(c.id))}/>)}</div>{workspace.hasMore&&<button className="button secondary" onClick={workspace.loadMore}>Load earlier thoughts</button>}</>:<><div className="saved-grid">{saved.map(item=><ItemCard key={item.id} item={item} onEdit={()=>setEditing(item)} onToggle={()=>toggle(item)}/>)}{!saved.length&&!rawThoughts.length&&<Empty>There’s room here for your next idea.</Empty>}</div>{rawThoughts.length>0&&<section className="unfiled-thoughts"><h2>Your thoughts</h2>{rawThoughts.map(c=><ThoughtCard key={c.id} capture={c} startsAt={linkedThought(c)?.startsAt} demo={demo} uid={user?.uid||null} onFollowUp={()=>followUp(c)} onRetry={()=>void action(()=>workspace.retry(c.id))}/>)}</section>}</>}
            </>}
            {workspace.loading&&<p className="loading-note" role="status">Bringing your workspace up to date…</p>}
          </>}
        </main>
      </div>
    </div>
    {showApp&&<nav className="bottom-nav" aria-label="Mobile navigation">{navigation.map(({id,label,icon:Icon})=><button key={id} aria-label={label} aria-current={view===id?'page':undefined} className={view===id?'active':''} onClick={()=>setView(id)}><Icon size={21}/><span>{label}</span></button>)}</nav>}
    {notice&&<div className="toast" role="status"><Check size={18}/>{notice}</div>}
    {needRefresh&&<div className="update-prompt">An update is ready. Finish your capture first.<button className="text-button" onClick={()=>void updateServiceWorker(true)}>Update</button></div>}
    {login&&<Login onClose={()=>setLogin(false)}/>}
    {editing&&<ItemEditor initial={editing} projects={projects} onSave={workspace.save} onDelete={workspace.remove} onClose={()=>setEditing(null)}/>}
  </>;
}
function kindLabelForAgenda(kind:string){return kind==='idea'?'Thought follow-up':kind==='task'?'To-do':'Event';}
