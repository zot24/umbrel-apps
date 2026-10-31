<script>
    import "$lib/vendor/bootstrap/bootstrap-grid.min.css";
</script>

<div class="fx grid"></div>
<div class="fx glow"></div>
<div class="fx scan"></div>
<div class="fx vignette"></div>

<div id="content">
    <slot />
    <footer>
        <p class="who">zot24</p>
        <p class="legal">
            GPL-3.0. The tunnel client started from
            <a href="https://github.com/Radiokot/umbrel-cloudflared" target="_blank">Radiokot's app</a>.
        </p>
    </footer>
</div>

<style>
    :root {
        --phosphor: #50ffa8;
        --phosphor-dim: #28b870;
        --amber: #ffc04d;
        --red: #ff6060;
        --bg: #060a0d;
        --surface: #0b1016;
        --text: #d4e0d8;
        --text-muted: #7a8e82;
        --line: rgba(80, 255, 168, 0.16);
        --display: "Oxanium", "Fira Code", ui-monospace, monospace;
        --mono: "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace;

        --background-color: var(--bg);
        --text-color: var(--text);
        --link-color: var(--phosphor);
        --secondary-text-color: var(--text-muted);
        --primary-button-color: var(--phosphor);
        --primary-button-hover-color: var(--phosphor);
        --status-ok-color: var(--phosphor);
        --status-warning-color: var(--amber);
        --card-background-color: var(--surface);
        --card-shadow-color: transparent;

        background-color: var(--bg);
        color: var(--text);
        font-family: var(--mono);
        color-scheme: dark;
    }

    :global(html),
    :global(body) {
        margin: 0;
        min-height: 100%;
        background: var(--bg);
        color: var(--text);
    }

    :global(body) {
        font: 14px/1.55 var(--mono);
        overflow-x: hidden;
    }

    :global(a) {
        text-decoration: none;
        color: var(--phosphor);
    }

    :global(a:hover) {
        text-decoration: underline;
    }

    .fx {
        position: fixed;
        inset: 0;
        pointer-events: none;
    }

    .fx.grid {
        background-image:
            linear-gradient(rgba(80, 255, 168, 0.035) 1px, transparent 1px),
            linear-gradient(90deg, rgba(80, 255, 168, 0.035) 1px, transparent 1px);
        background-size: 32px 32px;
    }

    .fx.glow {
        background:
            radial-gradient(600px 400px at 12% 8%, rgba(80, 255, 168, 0.07), transparent 70%),
            radial-gradient(500px 500px at 92% 85%, rgba(255, 192, 77, 0.05), transparent 70%);
    }

    .fx.scan {
        background: repeating-linear-gradient(to bottom, rgba(0, 0, 0, 0.22) 0 1px, transparent 1px 3px);
        z-index: 50;
    }

    .fx.vignette {
        background: radial-gradient(ellipse at center, transparent 55%, rgba(0, 0, 0, 0.65) 100%);
        z-index: 51;
    }

    #content {
        position: relative;
        z-index: 1;
        max-width: 1024px;
        margin: 0 auto;
        padding: 28px 16px 64px;
    }

    footer {
        margin-top: 48px;
        text-align: center;
    }

    .who {
        margin: 0;
        font: 600 12px/1 var(--display);
        letter-spacing: 0.22em;
        text-transform: uppercase;
        color: var(--phosphor);
    }

    .legal {
        margin: 8px 0 0;
        color: var(--text-muted);
        font-size: 12px;
    }

    :global(h1),
    :global(h3) {
        font: 700 26px/1 var(--display);
        letter-spacing: 0.14em;
        margin: 0;
        color: var(--phosphor);
        text-shadow: 0 0 12px rgba(80, 255, 168, 0.45);
    }

    :global(.button) {
        display: inline-flex;
        align-items: center;
        background: transparent;
        border: 1px solid var(--phosphor-dim);
        border-radius: 0;
        padding: 9px 12px;
        text-align: center;
        font: 500 12px/1 var(--mono);
        letter-spacing: 0.1em;
        text-transform: uppercase;
        color: var(--phosphor);
        cursor: pointer;
        transition: background 150ms ease, box-shadow 150ms ease;
    }

    :global(.button::before) {
        content: "> ";
        color: var(--phosphor-dim);
    }

    :global(.button:hover) {
        text-decoration: none;
        background: rgba(80, 255, 168, 0.1);
        box-shadow: 0 0 12px rgba(80, 255, 168, 0.18);
    }

    :global(.button-secondary) {
        color: var(--text);
        border-color: var(--line);
    }

    :global(.button-primary) {
        background: rgba(80, 255, 168, 0.14);
    }

    :global(.button:disabled) {
        opacity: 0.4;
        cursor: not-allowed;
        background: transparent;
        box-shadow: none;
    }

    :global(label) {
        font-size: 11px;
        letter-spacing: 0.14em;
        text-transform: uppercase;
        color: var(--text-muted);
    }

    :global(textarea) {
        box-sizing: border-box;
        width: 100%;
        min-height: 110px;
        resize: vertical;
        font: 13px/1.5 var(--mono);
        color: var(--text);
        background: #05080b;
        border: 1px solid var(--line);
        border-radius: 0;
        padding: 9px 10px;
        outline: none;
    }

    :global(textarea:focus) {
        border-color: var(--phosphor-dim);
        box-shadow: 0 0 0 1px rgba(80, 255, 168, 0.25);
    }

    :global(.panel) {
        position: relative;
        background: rgba(11, 16, 22, 0.92);
        border: 1px solid var(--line);
        border-radius: 0;
        box-shadow: none;
    }

    :global(.panel::before) {
        content: "";
        position: absolute;
        left: 0;
        right: 0;
        top: 0;
        height: 1px;
        background: linear-gradient(90deg, transparent, var(--phosphor-dim), transparent);
    }

    @media (prefers-reduced-motion: reduce) {
        :global(*),
        :global(*::before),
        :global(*::after) {
            animation: none !important;
            transition: none !important;
        }
    }
</style>
