import type { Capture, Item, Proposal } from '../functions/src/domain';
export function exampleWorkspace() {
  const date = new Date(); date.setHours(0,0,0,0);
  const today = date.getTime();
  const at = (hour: number, minute = 0) => today + (hour*60+minute)*60000;
  const base = {detail:'',projectId:null,state:'open' as const,priority:'normal' as const,startsAt:null,durationMinutes:30,version:1,createdAt:at(7),updatedAt:at(7),sourceCaptureId:null};
  const items: Item[] = [
    {...base,id:'project-1',kind:'project',title:'A more human LinkedIn',detail:'Useful things worth sharing.'},
    {...base,id:'idea-1',kind:'idea',title:'What if my best notes became a weekly letter?',detail:'A short, honest letter about one thing I learned. Keep it personal. No need to make it a project yet.',startsAt:at(9),projectId:'project-1',sourceCaptureId:'capture-1'},
    {...base,id:'task-1',kind:'task',title:'Outline my next LinkedIn post',detail:'Start with the story from yesterday’s conversation.',startsAt:at(10),durationMinutes:45,priority:'high',projectId:'project-1'},
    {...base,id:'event-1',kind:'event',title:'Coffee with Alex',detail:'Corner café. Talk about the workshop.',startsAt:at(11,30),durationMinutes:45},
    {...base,id:'idea-2',kind:'idea',title:'A place for the ideas that aren’t ready yet',detail:'Some thoughts need a little time, not a checklist.'},
    {...base,id:'task-2',kind:'task',title:'Send the workshop outline to Jamie',detail:'Keep the first session focused on one useful outcome.',priority:'high'},
    {...base,id:'note-1',kind:'note',title:'A reminder to myself',detail:'Make room to think before filling every hour.'}
  ];
  const captures: Capture[] = [
    {id:'capture-3',source:'text',text:'Follow up on the weekly letter idea tomorrow. I don’t need to launch anything yet, just give it half an hour of thought.',mimeType:'',createdAt:at(7,12),updatedAt:at(7,13),timezone:Intl.DateTimeFormat().resolvedOptions().timeZone,status:'ready',summary:'Give the weekly letter idea a little room tomorrow.'},
    {id:'capture-2',source:'voice',text:'I should send Jamie the workshop outline. And maybe that conversation yesterday is the start of my next LinkedIn post.',mimeType:'audio/webm',createdAt:at(5,10),updatedAt:at(5,11),timezone:'America/Chicago',status:'ready',summary:'A workshop follow-up and the seed of your next post.'},
    {id:'capture-1',source:'voice',text:'What if I collected one thing I learned each week and sent it as a short letter? Not a polished newsletter. Just something honest and useful.',mimeType:'audio/webm',createdAt:at(2,30),updatedAt:at(2,31),timezone:'America/Chicago',status:'ready',summary:'A weekly letter built from things you’re already learning.'}
  ];
  const proposalBase = {captureId:'capture-3',projectId:'project-1',targetId:null,targetVersion:null,startsAt:null,durationMinutes:30,priority:'normal' as const,status:'pending' as const,createdAt:at(7,13)};
  const proposals: Proposal[] = [
    {...proposalBase,id:'proposal-1',kind:'schedule',title:'Revisit the weekly letter idea',detail:'Set aside 30 minutes tomorrow. It stays a thought.',targetId:'idea-1',targetVersion:1,startsAt:at(9)+86400000},
    {...proposalBase,id:'proposal-2',kind:'idea',title:'A post about making room for unfinished ideas',detail:'You don’t have to turn every spark into a to-do. This could be worth sharing.',captureId:'capture-2'}
  ];
  return {items,captures,proposals};
}
