<script lang="ts">
  import { afk, focusedRowId, activePanel } from '$lib/stores';

  $: rows = Array.from($afk.rows.values());
  $: status = $afk.connected ? 'live' : $afk.error ?? 'connecting…';

  function focusNode(id: string) {
    focusedRowId.set(id);
    activePanel.set('hitl');
  }

  function group(state: string): 'left' | 'center' | 'right' {
    if (state === 'merged') return 'left';
    if (state === 'wip' || state === 'claimed' || state === 'review' || state === 'blocked')
      return 'center';
    return 'right';
  }
</script>

<section class="afk">
  <div class="status" class:live={$afk.connected}>{status}</div>

  <div class="lanes">
    <div class="lane">
      <h3>completed</h3>
      {#each rows.filter((r) => group(r.state) === 'left') as row (row.id)}
        <button class="node merged" on:click={() => focusNode(row.id)} title={row.title}>
          {row.title}
        </button>
      {/each}
    </div>
    <div class="lane">
      <h3>in-flight</h3>
      {#each rows.filter((r) => group(r.state) === 'center') as row (row.id)}
        <button class="node live" on:click={() => focusNode(row.id)} title={row.title}>
          {row.title}
          <span class="state">{row.state}</span>
        </button>
      {/each}
    </div>
    <div class="lane">
      <h3>pending</h3>
      {#each rows.filter((r) => group(r.state) === 'right') as row (row.id)}
        <button class="node pending" on:click={() => focusNode(row.id)} title={row.title}>
          {row.title}
          <span class="state">{row.state}</span>
        </button>
      {/each}
    </div>
  </div>
</section>

<style>
  .afk {
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
  .lanes {
    display: grid;
    grid-template-columns: 1fr;
    gap: 0.75rem;
  }
  @media (min-width: 720px) {
    .lanes { grid-template-columns: 1fr 1fr 1fr; }
  }
  .lane {
    background: #0e1117;
    border: 1px solid #1a1f2b;
    border-radius: 10px;
    padding: 0.5rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    min-height: 120px;
  }
  .lane h3 {
    margin: 0 0 0.25rem;
    font-size: 0.75rem;
    color: #8a93a8;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .node {
    text-align: left;
    background: #141925;
    border: 1px solid #1a2233;
    color: inherit;
    border-radius: 8px;
    padding: 0.55rem 0.6rem;
    font-size: 0.85rem;
    cursor: pointer;
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }
  .node.live { border-color: #2e4a7a; }
  .node.merged { opacity: 0.65; }
  .node.pending { color: #aab3c5; }
  .state {
    font-size: 0.7rem;
    color: #8a93a8;
  }
</style>
