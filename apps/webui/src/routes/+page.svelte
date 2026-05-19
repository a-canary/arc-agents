<script lang="ts">
  import { activePanel } from '$lib/stores';
  import HitlPanel from './HitlPanel.svelte';
  import AfkPanel from './AfkPanel.svelte';
</script>

{#if $activePanel === 'hitl'}
  <HitlPanel />
{:else}
  <AfkPanel />
{/if}
