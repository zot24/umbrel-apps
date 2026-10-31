<script lang="ts">
    import AppHeader from "$lib/components/AppHeader.svelte";
    import TunnelRoute from "$lib/components/TunnelRoute.svelte";
    import tunnelStatus from "$lib/stores/tunnel-status";
    import { PUBLIC_GUIDE_URL } from "$env/static/public";

    $: isTunnelHealthy = $tunnelStatus?.isOk() == true;
    $: isTunnelUnreachable = $tunnelStatus?.isUnreachable() == true;
    $: tunnelRoutes = $tunnelStatus?.routes;
</script>

<svelte:head>
    <title>Cloudflare Tunnel</title>
</svelte:head>

<header class="top">
    <AppHeader />
    <a class="button button-secondary" href="/settings">Settings</a>
</header>

{#if isTunnelHealthy && tunnelRoutes != null && tunnelRoutes.length == 0}
    <section class="panel">
        <div class="panel-header">Routes</div>
        <p class="empty">No active routes</p>
    </section>
{:else if tunnelRoutes != null && tunnelRoutes.length > 0}
    <section class="panel">
        <div class="panel-header">Routes</div>
        <div class="panel-body">
            <div class="row">
                {#each tunnelRoutes as tunnelRoute (tunnelRoute.id)}
                    <div class="col-12 col-md-4 mt-3 route-col">
                        <TunnelRoute
                            publicEndpoint={tunnelRoute.publicEndpoint}
                            serviceUrl={tunnelRoute.serviceUrl}
                        />
                    </div>
                {/each}
            </div>
        </div>
    </section>
{:else if isTunnelUnreachable}
    <section class="panel">
        <div class="panel-header">Set up your tunnel</div>
        <div class="panel-body setup">
            <p>1. <a href="/settings">Configure the app</a> with the start command of your Cloudflare tunnel.</p>
            <p>2. In the Cloudflare dashboard, create routes to access your Umbrel apps from the Internet.</p>
            <a class="button button-primary" target="_blank" href={PUBLIC_GUIDE_URL}>Read the guide</a>
        </div>
    </section>
{/if}

<style>
    .top {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 16px;
        flex-wrap: wrap;
        margin-bottom: 22px;
    }

    .panel-header {
        padding: 12px 16px;
        border-bottom: 1px solid var(--line);
        font: 600 13px/1.2 var(--display);
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--phosphor-dim);
    }

    .panel-body {
        padding: 4px 16px 16px;
    }

    .setup {
        padding-top: 16px;
    }

    .setup p {
        margin: 0 0 10px;
    }

    .empty {
        padding: 28px 16px;
        text-align: center;
        color: var(--text-muted);
    }

    /* Auto columns grow with the hostname, so a long name drops the row
       from three routes to two. A fixed third, and min-width 0, keeps
       three per row from the md breakpoint up and lets the label ellipsize. */
    .route-col {
        min-width: 0;
    }
</style>
