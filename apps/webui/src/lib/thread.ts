import type { IssueRow } from './types';

export interface IssueEvent {
  seq: number;
  issue_id: string;
  ts: number;
  agent: string;
  kind: string;
  payload_md: string | null;
}

export interface ThreadView {
  issue: IssueRow;
  events: IssueEvent[];
  related: IssueRow[];
}

export async function fetchThread(id: string, fetchImpl: typeof fetch = fetch): Promise<ThreadView> {
  const res = await fetchImpl(`/thread/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`thread ${id}: ${res.status}`);
  return (await res.json()) as ThreadView;
}
