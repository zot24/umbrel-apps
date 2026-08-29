# Proton Mail Bridge for Umbrel

Unofficial Umbrel app that runs [Proton Mail Bridge](https://proton.me/mail/bridge)
as a sibling container on your Umbrel. Hermes (or any IMAP client on the box)
talks to it over Docker DNS. Proton keys stay in this app, not in the Telegram
bot container.

- **App ID**: `zot24-proton-bridge`
- **UI port**: 7681 (ttyd operator console, behind Umbrel auth — never expose)
- **IMAP**: 143 (STARTTLS, internal)
- **SMTP**: 25 (STARTTLS, internal)
- **Upstream**: [shenxn/protonmail-bridge](https://github.com/shenxn/protonmail-bridge-docker) `build` tag (pinned digest) wrapping Proton Bridge (GPL-3.0)

## How it's wired

```
  browser (Umbrel login)
        |
        v
  app_proxy :7681  ──►  ttyd operator console
                          login-cli / status / info-hint

  Hermes Himalaya  ──►  zot24-proton-bridge_bridge_1:143  (IMAP)
                   ──►  zot24-proton-bridge_bridge_1:25   (SMTP)
                          proton-bridge daemon
                          /root volume: pass + gpg + vault
```

IMAP and SMTP are **not** on `app_proxy` and **not** published as host ports.

## Installing on Umbrel

Community store is already:

```
https://github.com/zot24/umbrel-apps
```

Install **Proton Bridge**. Image is pinned (`shenxn/protonmail-bridge:build@sha256:…`).
No custom GHCR build required.

## First login

1. Open the app tile.
2. Type `login-cli`.
3. In the Bridge CLI: `login` — Proton email, password, 2FA.
4. Type `info`. Copy the **mailbox password** into 1Password. Not Telegram.
5. Type `exit`. The daemon comes back; close the tab.

Paid Proton plan required. Free accounts cannot activate Bridge.

## Himalaya / Hermes

```
host      zot24-proton-bridge_bridge_1
IMAP      143  STARTTLS
SMTP      25   STARTTLS
username  you@proton.me
password  <mailbox password from `info`>
```

If Docker DNS does not resolve from Hermes, use this app's `10.21.x.x` address
on the Umbrel network — still do not publish 143/25 on the host.

## Local dev

```bash
cd zot24-proton-bridge
docker compose -f docker-compose.local.yml up --build
# console: http://127.0.0.1:7681
# IMAP/SMTP bound to localhost only
```

## Security

- ttyd is a shell that can run `login-cli`. Umbrel login is the only lock.
- Do not port-forward 7681, 143, or 25.
- Not for the official Umbrel store (Proton trademark + unofficial image).
