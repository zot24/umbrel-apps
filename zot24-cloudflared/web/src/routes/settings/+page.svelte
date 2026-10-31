<script lang="ts">
    import {
        PUBLIC_GUIDE_URL,
        PUBLIC_CLOUDFLARED_ARGUMENTS_GUIDE_URL,
    } from "$env/static/public";
    import TunnelSettings from "$lib/model/TunnelSettings";
    import { setTunnelStatusRestarting } from "$lib/stores/tunnel-status";

    const tokenRegex = /[A-Za-z0-9+/]+={0,2}$/g;

    let tokenInput = "";
    let extraArgsInput = "";
    let isSavingSettings = false;
    $: parsedToken = parseToken(tokenInput);
    $: isSaveEnabled = parsedToken != null && !isSavingSettings;
    let saveResult: string | null = null;

    async function onSaveClicked() {
        isSavingSettings = true;
        saveResult = null;
        try {
            await saveTunnelSettings();
            try {
                if (setTunnelStatusRestarting) {
                    setTunnelStatusRestarting();
                }
            } catch {}
            saveResult = "The connector will restart in a moment.";
        } catch (err) {
            console.error("onSaveClicked(): save_failed:", err);

            saveResult =
                "Failed to save the settings. Check the dev console for errors.";
        } finally {
            isSavingSettings = false;
        }
    }

    /**
     * @param input Base64 Cloudflare token or the whole cloudflared start command
     * @returns parsed Cloudflare token or null if the input is not valid
     */
    function parseToken(input: string): string | null {
        let matchedValue = input.match(tokenRegex)?.[0];
        if (!matchedValue) {
            return null;
        }

        let decodedValue = null;
        let decodedObject = null;
        try {
            decodedValue = atob(matchedValue);
            decodedObject = JSON.parse(decodedValue);
        } catch (err) {
            return null;
        }

        if (
            decodedObject &&
            "a" in decodedObject &&
            "s" in decodedObject &&
            "t" in decodedObject
        ) {
            return matchedValue;
        } else {
            return null;
        }
    }

    async function getTunnelSettings(): Promise<TunnelSettings> {
        let response = await fetch("/api/settings");
        if (!response.ok) {
            console.error("getTunnelSettings(): request_failed:", {
                status: response.status,
            });

            throw new Error("Tunnel settings loading failed");
        } else {
            return TunnelSettings.from(await response.json());
        }
    }

    async function loadTunnelSettings() {
        let tunnelSettings = await getTunnelSettings();
        onTunnelSettingsLoaded(tunnelSettings);
    }

    function onTunnelSettingsLoaded(tunnelSettings: TunnelSettings) {
        if (tunnelSettings.token != null) {
            tokenInput = tunnelSettings.token;
        }
        if (tunnelSettings.extraArgs != null) {
            extraArgsInput = tunnelSettings.extraArgs;
        }
    }

    async function saveTunnelSettings() {
        let tunnelSettings = new TunnelSettings(parsedToken, extraArgsInput);
        let response = await fetch("/api/settings", {
            method: "POST",
            body: JSON.stringify(tunnelSettings),
            headers: {
                "content-type": "application/json",
            },
        });
        if (!response.ok) {
            console.error("saveTunnelSettings(): request_failed:", {
                status: response.status,
                test: response.text,
            });

            throw new Error("Tunnel settings saving failed");
        } else {
            let updatedSettings = TunnelSettings.from(await response.json());
            onTunnelSettingsLoaded(updatedSettings);
        }
    }
</script>

<svelte:head>
    <title>Settings | Cloudflare Tunnel</title>
</svelte:head>

<header class="top">
    <h1>Settings</h1>
    <a class="button button-secondary" href="/">Back</a>
</header>

{#await loadTunnelSettings()}
    <p class="muted">Loading…</p>
{:then}
    <section class="panel">
        <div class="panel-header">Connector</div>
        <div class="panel-body">
            <label for="tokenInput">Connector token</label>
            <a class="hint" href={PUBLIC_GUIDE_URL} target="_blank">Guide</a>
            <textarea
                id="tokenInput"
                name="tokenInput"
                rows="5"
                placeholder="Paste the token or the complete connection command"
                bind:value={tokenInput}
            />

            <details>
                <summary>Advanced</summary>
                <label for="extraArgsInput">Extra cloudflared arguments</label>
                <a class="hint" href={PUBLIC_CLOUDFLARED_ARGUMENTS_GUIDE_URL} target="_blank">Arguments</a>
                <textarea
                    id="extraArgsInput"
                    name="extraArgsInput"
                    rows="5"
                    placeholder="Extra arguments to be inserted between cloudflared 'tunnel' and 'run'"
                    bind:value={extraArgsInput}
                />
            </details>

            <button
                class="button button-primary"
                disabled={!isSaveEnabled}
                on:click={onSaveClicked}
            >
                Save & Restart
            </button>
            {#if saveResult}
                <p class="result">{saveResult} <a href="/">Go back</a></p>
            {/if}
        </div>
    </section>
{:catch}
    <p class="bad">Failed to load</p>
{/await}

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
        padding: 16px;
    }

    label {
        display: inline-block;
        margin: 0 8px 8px 0;
    }

    .hint {
        font-size: 12px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
    }

    textarea {
        display: block;
        margin-bottom: 16px;
    }

    summary {
        cursor: pointer;
        margin: 8px 0 12px;
        font: 600 13px/1.2 var(--display);
        letter-spacing: 0.2em;
        text-transform: uppercase;
        color: var(--phosphor);
    }

    .result {
        margin-top: 14px;
    }

    .muted {
        color: var(--text-muted);
    }

    .bad {
        color: var(--red);
    }
</style>
