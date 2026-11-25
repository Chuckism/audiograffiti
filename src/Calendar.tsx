import { useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Plus } from 'lucide-react';
import type { Item } from '../functions/src/domain';
import { overlaps } from '../functions/src/domain';
import { Badge, dateKey, Empty, ItemCard, timeLabel } from './components';

export default function Calendar({items,onEdit,onToggle}: {items:Item[];onEdit:(item:Partial<Item>)=>void;onToggle:(item:Item)=>void}) {
  const [day,setDay] = useState(dateKey(new Date()));
  const [layer,setLayer] = useState<'thoughts'|'events'>('thoughts');
  const selected = new Date(day+'T12:00:00');
  const monday = new Date(selected);monday.setDate(monday.getDate()-((monday.getDay()+6)%7));
  const days = Array.from({length:7},(_,i)=>{const d=new Date(monday);d.setDate(d.getDate()+i);return d;});
  const forDay = (item:Item,d=day) => item.startsAt!==null && dateKey(new Date(item.startsAt))===d && item.state!=='done';
  const allScheduled = items.filter(i=>forDay(i));
  const scheduled = allScheduled.filter(i=>layer==='events'?i.kind==='event':['idea','task'].includes(i.kind)).sort((a,b)=>a.startsAt!-b.startsAt!);
  const unplanned = items.filter(i=>!i.startsAt && ['idea','task'].includes(i.kind) && i.state!=='done');
  const openTimes = Array.from({length:20},(_,i)=>new Date(day+'T08:00:00').getTime()+i*1800000)
    .filter(time=>time>Date.now() && !allScheduled.some(i=>overlaps(i,{startsAt:time,durationMinutes:30}))).slice(0,3);
  function move(delta:number) {const d=new Date(selected);d.setDate(d.getDate()+delta);setDay(dateKey(d));}
  const defaultTime = openTimes[0] || new Date(day+'T09:00:00').getTime();
  return <section className="calendar-view">
    <div className="page-heading"><div><p className="eyebrow">A little room in your day</p><h1>Your calendar</h1><p className="muted">Make time for what’s on your mind.</p></div><button className="button primary" onClick={()=>onEdit({kind:layer==='events'?'event':'idea',startsAt:defaultTime})}><Plus size={17}/>{layer==='events'?'Add event':'Make time'}</button></div>
    <div className="calendar-tabs" role="tablist" aria-label="Calendars">
      <button role="tab" aria-selected={layer==='thoughts'} className={layer==='thoughts'?'active':''} onClick={()=>setLayer('thoughts')}>Thoughts & To-dos</button>
      <button role="tab" aria-selected={layer==='events'} className={layer==='events'?'active events-tab':''} onClick={()=>setLayer('events')}>Events</button>
    </div>
    <div className={'calendar-layout '+(layer==='events'||!unplanned.length?'calendar-wide':'')}><div className="calendar-surface">
      <div className="calendar-toolbar"><h2>{selected.toLocaleDateString([],{month:'long',year:'numeric'})}</h2><div className="inline-actions"><button className="text-button" onClick={()=>setDay(dateKey(new Date()))}>Today</button><button className="icon-button" aria-label="Previous week" onClick={()=>move(-7)}><ChevronLeft size={18}/></button><button className="icon-button" aria-label="Next week" onClick={()=>move(7)}><ChevronRight size={18}/></button><label className="date-jump"><CalendarDays size={18}/><input type="date" aria-label="Choose calendar date" value={day} onChange={e=>e.target.value&&setDay(e.target.value)}/></label></div></div>
      <div className="week-strip">{days.map(d=><button key={dateKey(d)} className={(dateKey(d)===day?'selected ':'')+(dateKey(d)===dateKey(new Date())?'is-today':'')} onClick={()=>setDay(dateKey(d))} aria-label={d.toLocaleDateString([],{weekday:'long',month:'long',day:'numeric'})} aria-pressed={dateKey(d)===day}><span>{d.toLocaleDateString([],{weekday:'short'})}</span><strong>{d.getDate()}</strong><small>{items.filter(i=>forDay(i,dateKey(d))&&(layer==='events'?i.kind==='event':i.kind!=='event')).length||'—'}</small></button>)}</div>
      <div className="day-heading"><h3>{selected.toLocaleDateString([],{weekday:'long',month:'short',day:'numeric'})}</h3><span className="muted small">{Intl.DateTimeFormat().resolvedOptions().timeZone.replaceAll('_',' ')}</span></div>
      <div className="day-agenda" role="tabpanel" aria-label={layer==='thoughts'?'Thoughts and to-dos calendar':'Events calendar'}>
        {scheduled.length?scheduled.map(item=><div className="agenda-row" key={item.id}><div className="agenda-time"><strong>{timeLabel(item.startsAt!)}</strong><span>{timeLabel(item.startsAt!+item.durationMinutes*60000)}</span></div><div className={'calendar-block '+item.kind}><Badge kind={item.kind}/><button onClick={()=>onEdit(item)} className="block-title">{item.title}</button><p>{item.kind==='idea'?'A moment to revisit this thought':item.detail||'Time set aside for you'}</p><button className="text-button" onClick={()=>onEdit(item)}><Clock3 size={13}/>{item.durationMinutes} min · Adjust time</button></div></div>):<Empty icon={<CalendarDays size={30}/>}>{layer==='thoughts'?'Some breathing room. Give a thought or to-do a little time here.':'No events today. Your day has some room in it.'}</Empty>}
      </div>
      {openTimes.length>0&&<div className="open-time"><p className="small muted">Open in both calendars</p><div className="inline-actions">{openTimes.map(time=><button key={time} className="chip" onClick={()=>onEdit({kind:layer==='events'?'event':'idea',startsAt:time})}><Plus size={13}/>{timeLabel(time)}</button>)}</div></div>}
    </div>{layer==='thoughts'&&unplanned.length>0&&<aside className="calendar-aside">
      <section><div className="section-heading"><h3>Unscheduled</h3><span className="count">{unplanned.length}</span></div>{unplanned.slice(0,6).map(item=><ItemCard key={item.id} item={item} onEdit={()=>onEdit({...item,startsAt:defaultTime})} onToggle={()=>onToggle(item)}/>)}</section>
    </aside>}</div>
  </section>;
}
