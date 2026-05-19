import { writable } from 'svelte/store';
import { sseStore } from './sse';

export type ActivePanel = 'hitl' | 'afk';

export const activePanel = writable<ActivePanel>('hitl');
export const focusedRowId = writable<string | null>(null);

export const hitl = sseStore('/sse/hitl');
export const afk = sseStore('/sse/afk');
