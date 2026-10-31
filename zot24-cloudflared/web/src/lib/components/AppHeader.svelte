<script>
    import tunnelStatus from "$lib/stores/tunnel-status";

    $: isTunnelStatusLoading = $tunnelStatus == null;
    $: tunnelStatusString = $tunnelStatus?.isUnreachable()
        ? "Unreachable"
        : $tunnelStatus?.isOk()
          ? "Running"
          : $tunnelStatus?.isRestarting()
            ? "Restarting"
            : $tunnelStatus?.status;
    $: isTunnelHealthy = $tunnelStatus?.isOk() == true;
    $: isRestarting = $tunnelStatus?.isRestarting() == true;
    $: connecorVersion = $tunnelStatus?.version;
</script>

<div class="head">
    <img class="mark" src="/logo.svg" alt="" />
    <div>
        <span class="badge" class:ok={isTunnelHealthy} class:warn={!isTunnelHealthy && !isTunnelStatusLoading} class:blink={isRestarting}>
            {#if isTunnelStatusLoading}
                <i class="dot"></i>
                Loading
            {:else}
                <i class="dot"></i>
                {tunnelStatusString}
            {/if}
        </span>
        <h1>Cloudflare Tunnel</h1>
        <div class="sub">
            {#if isTunnelHealthy && connecorVersion != null}
                {connecorVersion}
            {:else}
                zot24
            {/if}
        </div>
    </div>
</div>

<style>
    .head {
        display: flex;
        align-items: center;
        gap: 16px;
        min-width: 0;
    }

    .mark {
        width: 64px;
        height: 64px;
        flex: none;
        border: 1px solid var(--line);
    }

    h1 {
        margin-top: 8px;
    }

    .sub {
        margin-top: 8px;
        color: var(--text-muted);
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }

    .badge {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        border: 1px solid currentColor;
        padding: 4px 10px;
        font: 600 11px/1.4 var(--mono);
        letter-spacing: 0.14em;
        text-transform: uppercase;
    }

    .dot {
        width: 8px;
        height: 8px;
        background: currentColor;
        box-shadow: 0 0 8px currentColor;
    }

    .ok {
        color: var(--phosphor);
    }

    .warn {
        color: var(--amber);
    }

    .blink .dot {
        animation: blink 1s steps(2, start) infinite;
    }

    @keyframes blink {
        to {
            visibility: hidden;
        }
    }

    @media (max-width: 30em) {
        .mark {
            width: 48px;
            height: 48px;
        }

        h1 {
            font-size: 20px;
        }
    }
</style>
