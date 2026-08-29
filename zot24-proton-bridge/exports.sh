# Proton Mail Bridge exports for sibling Umbrel apps (Hermes Himalaya, etc.)
# IMAP/SMTP are NOT on app_proxy. Reach them on the Umbrel app network only.

export APP_ZOT24_PROTON_BRIDGE_IP="zot24-proton-bridge_bridge_1"
# socat frontends: 143 -> Bridge IMAP 1143, 25 -> Bridge SMTP 1025
export APP_ZOT24_PROTON_BRIDGE_IMAP_PORT="143"
export APP_ZOT24_PROTON_BRIDGE_SMTP_PORT="25"
# ttyd operator console (behind Umbrel app_proxy auth)
export APP_ZOT24_PROTON_BRIDGE_UI_PORT="7681"
