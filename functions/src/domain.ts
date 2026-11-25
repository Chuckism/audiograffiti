export type ItemKind = 'task' | 'idea' | 'note' | 'project' | 'event';
export type CaptureStatus = 'uploading' | 'queued' | 'transcribing' | 'organizing' | 'ready' | 'failed';
export interface Capture {
  id: string; source: 'voice' | 'text'; text: string; mimeType: string;
  createdAt: number; updatedAt: number; timezone: string; status: CaptureStatus;
  summary?: string; error?: string; reviewedAt?: number; attempts?: number;
  localOnly?: boolean;
}
export interface Item {
  id: string; kind: ItemKind; title: string; detail: string;
  projectId: string | null; state: 'open' | 'done'; priority: 'normal' | 'high';
  startsAt: number | null; durationMinutes: number; version: number;
  createdAt: number; updatedAt: number; sourceCaptureId: string | null;
}
export type ProposalKind = 'task' | 'idea' | 'event' | 'note' | 'update' | 'schedule' | 'question' | 'decision' | 'reminder' | 'project_update';
export interface Proposal {
  id: string; captureId: string; kind: ProposalKind; title: string; detail: string;
  projectId: string | null; targetId: string | null; targetVersion: number | null;
  startsAt: number | null; durationMinutes: number; priority: 'normal' | 'high';
  status: 'pending' | 'approved' | 'dismissed'; createdAt: number;
}
export const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_LENGTH = 20000;
export const MIME_TYPES = ['audio/webm', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/mpeg'];
export function validId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value);
}
export function cleanText(value: unknown, max = 20000): string {
  if (typeof value !== 'string') throw new Error('Expected text.');
  const text = value.trim();
  if (!text || text.length > max) throw new Error('Text must contain between 1 and ' + max + ' characters.');
  return text;
}
export function validTime(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 946684800000 || value > 4102444800000) {
    throw new Error('Choose a valid date and time.');
  }
  return value;
}
export function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 5 || value > 480) {
    throw new Error('Choose a duration between 5 and 480 minutes.');
  }
  return value;
}
export function validateItem(input: Record<string, unknown>): Omit<Item, 'id' | 'version' | 'createdAt' | 'updatedAt' | 'sourceCaptureId'> {
  if (!['task', 'idea', 'note', 'project', 'event'].includes(String(input.kind))) throw new Error('Unknown item type.');
  const kind = input.kind as ItemKind;
  const startsAt = validTime(input.startsAt);
  if (kind === 'event' && startsAt === null) throw new Error('Choose a time for this event.');
  if ((kind === 'project' || kind === 'note') && startsAt !== null) throw new Error('Schedule a thought or task.');
  if (input.projectId != null && !validId(input.projectId)) throw new Error('Invalid project.');
  if (!['open', 'done'].includes(String(input.state))) throw new Error('Invalid status.');
  return {
    kind, title: cleanText(input.title, 160),
    detail: typeof input.detail === 'string' ? input.detail.trim().slice(0, 20000) : '',
    projectId: (input.projectId as string) || null, state: input.state as 'open' | 'done',
    priority: input.priority === 'high' ? 'high' : 'normal', startsAt,
    durationMinutes: duration(input.durationMinutes ?? 30)
  };
}
export function overlaps(a: Pick<Item, 'startsAt' | 'durationMinutes'>, b: Pick<Item, 'startsAt' | 'durationMinutes'>): boolean {
  if (a.startsAt === null || b.startsAt === null) return false;
  return a.startsAt < b.startsAt + b.durationMinutes * 60000 && b.startsAt < a.startsAt + a.durationMinutes * 60000;
}
export function normalizeAnalysis(raw: unknown, context: Item[], captureId: string, now: number) {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid analysis.');
  const data = raw as Record<string, unknown>;
  const summary = cleanText(data.summary, 2000);
  if (!Array.isArray(data.proposals) || data.proposals.length > 12) throw new Error('Invalid suggestions.');
  const proposals = data.proposals.map((p: Record<string, unknown>, index): Proposal => {
    if (!p || !['task','idea','event','note','update','schedule','question','decision','reminder','project_update'].includes(String(p.kind))) {
      throw new Error('Invalid suggestion type.');
    }
    const target = p.targetId ? context.find(i => i.id === p.targetId) : null;
    const project = p.projectId ? context.find(i => i.id === p.projectId && i.kind === 'project') : null;
    if (p.targetId && !target || p.projectId && !project) throw new Error('Unknown context reference.');
    if (['update','schedule','project_update'].includes(String(p.kind)) && !target) throw new Error('Missing update target.');
    if (p.kind === 'project_update' && target?.kind !== 'project') throw new Error('Invalid project update.');
    const startsAt = validTime(p.startsAt);
    if (p.kind === 'schedule' && (startsAt === null || !['task','idea'].includes(target?.kind || ''))) throw new Error('Invalid schedule.');
    if (p.kind === 'event' && startsAt === null) throw new Error('Event time is missing.');
    if (startsAt !== null && !['task','idea','event','reminder','schedule','update'].includes(String(p.kind))) throw new Error('Invalid time block.');
    return {
      id: captureId + '_' + index, captureId, kind: p.kind as ProposalKind,
      title: cleanText(p.title, 160), detail: typeof p.detail === 'string' ? p.detail.trim().slice(0, 5000) : '',
      projectId: project?.id || null, targetId: target?.id || null, targetVersion: target?.version ?? null,
      startsAt, durationMinutes: duration(p.durationMinutes ?? 30), priority: p.priority === 'high' ? 'high' : 'normal',
      status: 'pending', createdAt: now
    };
  });
  return { summary, proposals };
}
export function applyProposal(proposal: Proposal, existing: Item | undefined, now: number): Item {
  if (proposal.kind === 'question') throw new Error('Answer this question in a new thought, then dismiss it.');
  if (proposal.targetId) {
    if (!existing || existing.id !== proposal.targetId || existing.version !== proposal.targetVersion) {
      throw new Error('This item changed on another device. Review it before applying this suggestion.');
    }
    return {
      ...existing,
      title: proposal.kind === 'schedule' ? existing.title : proposal.title,
      detail: proposal.kind === 'schedule' ? existing.detail : proposal.detail,
      startsAt: proposal.startsAt ?? existing.startsAt,
      durationMinutes: proposal.startsAt === null ? existing.durationMinutes : proposal.durationMinutes,
      updatedAt: now, version: existing.version + 1
    };
  }
  return {
    id: 'suggestion_' + proposal.id,
    kind: proposal.kind === 'idea' ? 'idea' : proposal.kind === 'event' ? 'event' : ['task','reminder'].includes(proposal.kind) ? 'task' : 'note',
    title: proposal.title, detail: proposal.detail, projectId: proposal.projectId,
    state: 'open', priority: proposal.priority, startsAt: proposal.startsAt,
    durationMinutes: proposal.durationMinutes, version: 1, createdAt: now, updatedAt: now,
    sourceCaptureId: proposal.captureId
  };
}
