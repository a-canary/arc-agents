<script lang="ts">
  import { hitl, focusedRowId } from '$lib/stores';

  $: rows = Array.from($hitl.rows.values());
  $: status = $hitl.connected ? 'live' : $hitl.error ?? 'connecting…';
</script>

<section class="hitl">
  <div class="status" class:live={$hitl.connected}>{status}</div>

  {#if rows.length === 0}
    <div class="empty">No HITL threads.</div>
  {:else}
    <ul class="threads">
      {#each rows as row (row.id)}
        <li>
          <button
            class="thread"
            class:focused={$focusedRowId === row.id}
            on:click={() => focusedRowId.set(row.id)}
          >
            <span class="title">{row.title}</span>
            <span class="meta">{row.kind} · {row.state}</span>
            {#if row.draft_md}
              <pre class="draft">{row.draft_md}</pre>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .hitl {
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .status {
    font-size: 0.75rem;
    color: #ff9c6b;
  }
  .status.live { color: #6bd49a; }
  .empty {
    color: #6c7689;
    padding: 2rem 0;
    text-align: center;
  }
  .threads {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .thread {
    width: 100%;
    text-align: left;
    background: #11141b;
    border: 1px solid #1a1f2b;
    border-radius: 10px;
    padding: 0.75rem;
    color: inherit;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .thread.focused { border-color: #3a4a78; background: #141b2c; }
  .title { font-weight: 600; }
  .meta { font-size: 0.75rem; color: #8a93a8; }
  .draft {
    margin: 0.25rem 0 0;
    padding: 0.5rem;
    background: #0a0c12;
    border-radius: 6px;
    font-size: 0.85rem;
    white-space: pre-wrap;
  }
</style>
