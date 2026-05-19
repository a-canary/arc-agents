<script lang="ts">
  import { activePanel } from '$lib/stores';
</script>

<div class="shell">
  <header class="topbar">
    <span class="brand">arc</span>
    <nav class="tabs" role="tablist">
      <button
        role="tab"
        aria-selected={$activePanel === 'hitl'}
        class:active={$activePanel === 'hitl'}
        on:click={() => activePanel.set('hitl')}
      >
        HITL
      </button>
      <button
        role="tab"
        aria-selected={$activePanel === 'afk'}
        class:active={$activePanel === 'afk'}
        on:click={() => activePanel.set('afk')}
      >
        AFK
      </button>
    </nav>
  </header>

  <main class="panel">
    <slot />
  </main>
</div>

<style>
  :global(html, body) {
    margin: 0;
    padding: 0;
    background: #0b0d12;
    color: #e6e9ef;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    height: 100%;
  }

  .shell {
    display: flex;
    flex-direction: column;
    height: 100vh;
    height: 100dvh;
  }

  .topbar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0.75rem;
    border-bottom: 1px solid #1a1f2b;
    background: #0e1117;
  }

  .brand {
    font-weight: 700;
    letter-spacing: 0.05em;
    color: #8ab4ff;
  }

  .tabs {
    display: flex;
    gap: 0.25rem;
    margin-left: auto;
  }

  .tabs button {
    min-height: 44px;
    min-width: 64px;
    padding: 0 0.9rem;
    border: 1px solid #1a1f2b;
    border-radius: 8px;
    background: transparent;
    color: #aab3c5;
    font-size: 0.95rem;
    cursor: pointer;
  }

  .tabs button.active {
    background: #1a2233;
    color: #e6e9ef;
    border-color: #2a3349;
  }

  .panel {
    flex: 1;
    overflow: auto;
  }
</style>
