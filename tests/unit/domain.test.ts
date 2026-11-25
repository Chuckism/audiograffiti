import { describe, expect, it } from 'vitest';
import { applyProposal, normalizeAnalysis, overlaps, validateItem, type Item, type Proposal } from '../../functions/src/domain';
const now = new Date('2026-11-25T15:00:00Z').getTime();
const thought: Item = {id:'idea-1',kind:'idea',title:'A weekly letter',detail:'An idea, not a commitment.',projectId:null,state:'open',priority:'normal',startsAt:null,durationMinutes:30,version:2,createdAt:now,updatedAt:now,sourceCaptureId:'capture-1'};
const suggestion: Proposal = {id:'capture-2_0',captureId:'capture-2',kind:'schedule',title:'Follow up on my letter idea',detail:'Tomorrow morning.',projectId:null,targetId:'idea-1',targetVersion:2,startsAt:now+86400000,durationMinutes:30,priority:'normal',status:'pending',createdAt:now};
describe('thoughts, to-dos and the two calendars',()=>{
  it('schedules a thought without turning it into a task or replacing its original context',()=>{
    const result=applyProposal(suggestion,thought,now+1);
    expect(result.kind).toBe('idea');expect(result.title).toBe(thought.title);
    expect(result.detail).toBe(thought.detail);expect(result.startsAt).toBe(suggestion.startsAt);
    expect(result.sourceCaptureId).toBe('capture-1');expect(result.version).toBe(3);
  });
  it('keeps a new idea a thought, including an optional follow-up',()=>{
    const result=applyProposal({...suggestion,kind:'idea',targetId:null,targetVersion:null},undefined,now);
    expect(result.kind).toBe('idea');expect(result.sourceCaptureId).toBe('capture-2');
  });
  it('prevents applying a stale recommendation after a second device changed the thought',()=>{
    expect(()=>applyProposal(suggestion,{...thought,version:3},now)).toThrow('another device');
  });
  it('does not silently accept unresolved questions as commitments',()=>{
    expect(()=>applyProposal({...suggestion,kind:'question'},thought,now)).toThrow('Answer');
  });
  it('checks conflicts across thought and event blocks, while allowing adjacent times',()=>{
    const idea={startsAt:now,durationMinutes:30};
    expect(overlaps(idea,{startsAt:now+15*60000,durationMinutes:30})).toBe(true);
    expect(overlaps(idea,{startsAt:now+30*60000,durationMinutes:30})).toBe(false);
    expect(overlaps(idea,{startsAt:null,durationMinutes:30})).toBe(false);
  });
  it('requires a time for an event and permits unscheduled thoughts',()=>{
    expect(()=>validateItem({...thought,kind:'event'})).toThrow('Choose a time');
    expect(validateItem({...thought}).startsAt).toBeNull();
  });
  it('rejects invented project/task references from AI output',()=>{
    expect(()=>normalizeAnalysis({summary:'Thought',proposals:[{kind:'schedule',title:'Follow up',targetId:'someone-elses-task',startsAt:now}]},[thought],'capture-2',now)).toThrow('Unknown context');
  });
  it('uses deterministic recommendation IDs and binds the observed target version',()=>{
    const raw={summary:'Return to the letter idea.',proposals:[{kind:'schedule',title:'Revisit the idea',targetId:'idea-1',startsAt:now,durationMinutes:30}]};
    const a=normalizeAnalysis(raw,[thought],'capture-2',now);const b=normalizeAnalysis(raw,[thought],'capture-2',now);
    expect(a.proposals[0].id).toBe(b.proposals[0].id);expect(a.proposals[0].targetVersion).toBe(2);
  });
  it('preserves three overnight thoughts and separate suggestions without requiring categorization',()=>{
    const sources=[
      {summary:'An idea for a weekly letter.',proposals:[{kind:'idea',title:'A weekly letter',startsAt:null}]},
      {summary:'Send the outline.',proposals:[{kind:'task',title:'Send Jamie the outline',startsAt:null}]},
      {summary:'Revisit the letter tomorrow.',proposals:[{kind:'schedule',title:'Think about the weekly letter',targetId:thought.id,startsAt:now+86400000}]}
    ];
    const results=sources.map((raw,i)=>normalizeAnalysis(raw,[thought],'overnight-'+i,now));
    expect(results).toHaveLength(3);expect(results.flatMap(r=>r.proposals).map(p=>p.kind)).toEqual(['idea','task','schedule']);
    expect(results.every(r=>r.proposals.every(p=>p.status==='pending'))).toBe(true);
  });
});
