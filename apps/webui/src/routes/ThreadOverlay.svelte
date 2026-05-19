<script lang="ts">
  import { onDestroy } from 'svelte';
  import { focusedRowId } from '$lib/stores';
  import { fetchThread, type ThreadView } from '$lib/thread';

  let view: ThreadView | null = null;
  let error: string | null = null;
  let loading = false;
  let currentId: string | null = null;

  const unsubscribe = focusedRowId.subscribe(async (id) => {
    if (id === currentId) return;
    currentId = id;
    view = null;
    error = null;
    if (!id) return;
    loading = true;
    try {
      view = await fetchThread(id);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  });

  onDestroy(unsubscribe);

  function close() {
    focusedRowId.set(null);
  }

  function fmtTs(ts: number): string {
    return new Date(ts * 1000).toISOString().slice(11, 19);
  }
</script>

{#if currentId}
  <div class="overlay" role="dialog" aria-modal="true">
    <div class="panel">
      <header>
        <h2>{view?.issue.title ?? currentId}</h2>
        <button class="close" on:click={close} aria-label="Close">×</button>
      </header>

      {#if loading}
        <div class="status">loading…</div>
      {:else if error}
        <div class="status error">error: {error}</div>
      {:else if view}
        <div class="meta">
          <span>{view.issue.state}</span>
          <span>·</span>
          <span>{view.issue.kind}</span>
          {#if view.issue.pr_url}
            · <a href={view.issue.pr_url} target="_blank" rel="noopener">PR</a>
          {/if}
        </div>

        {#if view.issue.draft_md}
          <pre class="draft">{view.issue.draft_md}</pre>
        {/if}

        <section class="events">
          <h3>events ({view.events.length})</h3>
          {#each view.events as ev (ev.seq)}
            <div class="event">
              <span class="ts">{fmtTs(ev.ts)}</span>
              <span class="agent">{ev.agent}</span>
              <span class="kind">{ev.kind}</span>
              {#if ev.payload_md}
                <pre class="payload">{ev.payload_md}</pre>
              {/if}
            </div>
          {/each}
        </section>

        {#if view.related.length}
          <section class="related">
            <h3>thread siblings ({view.related.length})</h3>
            <ul>
              {#each view.related as r (r.id)}
                <li>
                  <button on:click={() => focusedRowId.set(r.id)}>
                    {r.title} <span class="state">{r.state}</span>
                  </button>
                </li>
              {/each}
            </ul>
          </section>
        {/if}
      {/if}
    </div>
  </div>
{/if}

<style>
  .overlay {
    position: fixed;
    inset: 0;
    background: rgba(5, 7, 12, 0.78);
    z-index: 100;
    display: flex;
    justify-content: center;
    align-items: stretch;
    padding: 2rem;
  }
  .panel {
    background: #0e1117;
    border: 1px solid #1a2233;
    border-radius: 12px;
    width: min(900px, 100%);
    max-height: 100%;
    overflow-y: auto;
    padding: 1rem 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }
  header h2 { margin: 0; font-size: 1rem; }
  .close {
    background: transparent;
    border: 1px solid #1a2233;
    color: inherit;
    border-radius: 6px;
    width: 32px;
    height: 32px;
    cursor: pointer;
    font-size: 1.1rem;
  }
  .status { color: #8a93a8; }
  .status.error { color: #ff9c6b; }
  .meta {
    font-size: 0.8rem;
    color: #8a93a8;
    display: flex;
    gap: 0.4rem;
  }
  .meta a { color: #6bd49a; }
  .draft, .payload {
    margin: 0;
    background: #0a0c12;
    border-radius: 6px;
    padding: 0.5rem;
    font-size: 0.8rem;
    white-space: pre-wrap;
  }
  .events { display: flex; flex-direction: column; gap: 0.4rem; }
  .events h3, .related h3 {
    margin: 0.5rem 0 0.25rem;
    font-size: 0.75rem;
    color: #8a93a8;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .event {
    border: 1px solid #161c28;
    border-radius: 8px;
    padding: 0.4rem 0.5rem;
    font-size: 0.8rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: baseline;
  }
  .event .ts { color: #6c7689; font-variant-numeric: tabular-nums; }
  .event .agent { color: #aab3c5; }
  .event .kind { color: #6bd49a; }
  .event .payload {
    flex-basis: 100%;
    margin-top: 0.25rem;
  }
  .related ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.25rem; }
  .related button {
    background: #141925;
    border: 1px solid #1a2233;
    color: inherit;
    border-radius: 6px;
    padding: 0.4rem 0.5rem;
    cursor: pointer;
    text-align: left;
    width: 100%;
    display: flex;
    justify-content: space-between;
    font-size: 0.85rem;
  }
  .related .state { color: #8a93a8; font-size: 0.75rem; }
</style>
