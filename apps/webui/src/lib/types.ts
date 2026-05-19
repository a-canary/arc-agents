export type IssueState =
  | 'ready'
  | 'claimed'
  | 'wip'
  | 'review'
  | 'merged'
  | 'blocked'
  | 'failed'
  | 'cancelled'
  | 'paused';

export interface IssueRow {
  id: string;
  project: string;
  parent_id: string | null;
  title: string;
  state: IssueState;
  kind: string;
  class: string;
  urgency: string;
  priority: number | null;
  paused: number;
  deferred_at: number | null;
  artifact_dir: string | null;
  draft_md: string | null;
  blocked_by: string | null;
  pr_url: string | null;
  claimed_by: string | null;
  created_at: number;
  updated_at: number;
}

export type SseEvent =
  | { type: 'row-added'; row: IssueRow }
  | { type: 'row-updated'; row: IssueRow }
  | { type: 'row-removed'; id: string }
  | { type: 'snapshot'; rows: IssueRow[] };
