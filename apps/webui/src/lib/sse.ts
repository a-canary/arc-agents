import { readable, type Readable } from 'svelte/store';
import type { IssueRow, SseEvent } from './types';

export interface PanelState {
  rows: Map<string, IssueRow>;
  connected: boolean;
  lastEventId: string | null;
  error: string | null;
}

function applyEvent(state: PanelState, ev: SseEvent): PanelState {
  const rows = new Map(state.rows);
  switch (ev.type) {
    case 'snapshot':
      rows.clear();
      for (const r of ev.rows) rows.set(r.id, r);
      break;
    case 'row-added':
    case 'row-updated':
      rows.set(ev.row.id, ev.row);
      break;
    case 'row-removed':
      rows.delete(ev.id);
      break;
  }
  return { ...state, rows };
}

export function sseStore(endpoint: string): Readable<PanelState> {
  return readable<PanelState>(
    { rows: new Map(), connected: false, lastEventId: null, error: null },
    (set) => {
      let state: PanelState = {
        rows: new Map(),
        connected: false,
        lastEventId: null,
        error: null
      };

      const headers: Record<string, string> = {};
      if (state.lastEventId) headers['Last-Event-ID'] = state.lastEventId;

      const es = new EventSource(endpoint);

      es.onopen = () => {
        state = { ...state, connected: true, error: null };
        set(state);
      };

      es.onerror = () => {
        state = { ...state, connected: false, error: 'sse disconnected' };
        set(state);
      };

      es.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data) as SseEvent;
          state = applyEvent(state, ev);
          if (msg.lastEventId) state.lastEventId = msg.lastEventId;
          set(state);
        } catch (e) {
          state = { ...state, error: `parse: ${(e as Error).message}` };
          set(state);
        }
      };

      return () => es.close();
    }
  );
}
