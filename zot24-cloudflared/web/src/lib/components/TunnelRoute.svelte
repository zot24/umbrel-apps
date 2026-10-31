<script>
    /**
     * @type {string}
     */
    export let publicEndpoint;

    /**
     * @type {string}
     */
    export let serviceUrl;
</script>

<div class="route-row">
    <svg class="glyph" viewBox="0 0 32 32" aria-hidden="true">
        <path d="M3 29 V4 H29 V29" fill="none" stroke="#50ffa8" stroke-width="2" />
        <path d="M10 29 V13 H22 V29" fill="none" stroke="#28b870" stroke-width="2" />
        <path d="M16 13 V29" stroke="#ffc04d" stroke-width="2" />
    </svg>
    <div class="route-text">
        <p class="endpoint line-clamp" title={publicEndpoint}>
            <a href="https://{publicEndpoint}" target="_blank">
                {publicEndpoint}
            </a>
        </p>
        <small class="service line-clamp" title={serviceUrl}>
            {serviceUrl}
        </small>
    </div>
</div>

<style>
    .route-row {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
        border: 1px solid var(--line);
        background: rgba(6, 10, 13, 0.7);
        padding: 12px;
    }

    .glyph {
        width: 36px;
        height: 36px;
        flex: none;
    }

    .route-text {
        min-width: 0;
        flex: 1;
    }

    .endpoint {
        margin: 0 0 6px;
        font: 600 14px/1.3 var(--display);
        letter-spacing: 0.02em;
    }

    .service {
        color: var(--text-muted);
    }

    .line-clamp {
        overflow: hidden;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 1;
    }
</style>
