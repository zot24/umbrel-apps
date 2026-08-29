#!/bin/bash
# Runs inside shenxn/protonmail-bridge (debian sid-slim).
# Compose must not embed shell $vars — Umbrel interpolates docker-compose.
set -euo pipefail

export HOME=/root
export GNUPGHOME=/root/.gnupg
export PATH="/root/.umbrel-bin:/usr/local/bin:/usr/bin:/bin"
mkdir -p /root/.umbrel-bin "$GNUPGHOME"
chmod 700 "$GNUPGHOME"

TTYD=/root/.umbrel-bin/ttyd
TTYD_VERSION=1.7.7
TTYD_SHA256_X86_64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
TTYD_SHA256_AARCH64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165

need_pkgs=0
command -v curl >/dev/null || need_pkgs=1
command -v pkill >/dev/null || need_pkgs=1
command -v gpg >/dev/null || need_pkgs=1
command -v pass >/dev/null || need_pkgs=1
if [ "$need_pkgs" -eq 1 ]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update
    apt-get install -y --no-install-recommends curl ca-certificates procps gnupg pass
    rm -rf /var/lib/apt/lists/*
fi

# shenxn image keychain: gpg key "pass-key" + `pass init`. Without this,
# proton-bridge --cli dies with "no keychain" / "password store is empty".
ensure_keychain() {
    if ! gpg --batch --list-keys pass-key >/dev/null 2>&1; then
        gpg --generate-key --batch /protonmail/gpgparams
    fi
    if [ ! -f /root/.password-store/.gpg-id ]; then
        pass init pass-key
    fi
}
ensure_keychain

if [ ! -x "$TTYD" ]; then
    arch=$(uname -m)
    case "$arch" in
        x86_64)  sha="$TTYD_SHA256_X86_64" ;;
        aarch64) sha="$TTYD_SHA256_AARCH64" ;;
        *) echo "unsupported arch: $arch" >&2; exit 1 ;;
    esac
    curl -fsSL -o "$TTYD" \
        "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${arch}"
    echo "${sha}  ${TTYD}" | sha256sum -c -
    chmod +x "$TTYD"
fi

cat > /root/.umbrel-bin/login-cli << 'EOF'
#!/bin/bash
set -euo pipefail
export HOME=/root
export GNUPGHOME=/root/.gnupg
if ! gpg --batch --list-keys pass-key >/dev/null 2>&1; then
    gpg --generate-key --batch /protonmail/gpgparams
fi
if [ ! -f /root/.password-store/.gpg-id ]; then
    pass init pass-key
fi
echo "Stopping IMAP daemon so the CLI can take the lock..."
pkill -f '/protonmail/proton-bridge' 2>/dev/null || true
sleep 1
echo "In the Bridge CLI:  login   then   info   then   exit"
echo "Mailbox password -> 1Password. Not Telegram."
/protonmail/proton-bridge --cli
echo "Restarting IMAP daemon..."
rm -f /tmp/bridge.fifo
mkfifo /tmp/bridge.fifo
# shellcheck disable=SC2002
cat /tmp/bridge.fifo | /protonmail/proton-bridge --cli &
disown || true
echo "Daemon up. Close this tab; mail keeps running."
EOF

cat > /root/.umbrel-bin/status << 'EOF'
#!/bin/bash
if pgrep -f '/protonmail/proton-bridge' >/dev/null 2>&1; then
    echo "proton-bridge: running"
else
    echo "proton-bridge: stopped (run login-cli)"
fi
if [ -f /root/.password-store/.gpg-id ]; then
    echo "keychain: pass ready"
else
    echo "keychain: missing — restart the app, or: gpg --generate-key --batch /protonmail/gpgparams && pass init pass-key"
fi
EOF

cat > /root/.umbrel-bin/info-hint << 'EOF'
#!/bin/bash
echo "Mailbox password is shown by Bridge 'info' during login-cli."
echo "IMAP 143 / SMTP 25 on this container, STARTTLS."
echo "Username = full Proton address. Password = mailbox password, not Proton login."
EOF

chmod +x /root/.umbrel-bin/login-cli /root/.umbrel-bin/status /root/.umbrel-bin/info-hint

# socat: Bridge only accepts IMAP/SMTP from 127.0.0.1
socat TCP-LISTEN:25,fork,reuseaddr TCP:127.0.0.1:1025 &
socat TCP-LISTEN:143,fork,reuseaddr TCP:127.0.0.1:1143 &

rm -f /tmp/bridge.fifo
mkfifo /tmp/bridge.fifo
cat /tmp/bridge.fifo | /protonmail/proton-bridge --cli &

cat > /tmp/bridge-console.sh << 'EOF'
#!/bin/bash
export HOME=/root
export GNUPGHOME=/root/.gnupg
export PATH="/root/.umbrel-bin:/usr/local/bin:/usr/bin:/bin"
export PS1='bridge> '
echo "Proton Mail Bridge  (Umbrel)"
echo "  login-cli   first-time Proton login (2FA) + mailbox password"
echo "  status      daemon / keychain"
echo "  info-hint   Himalaya connection notes"
echo
status || true
echo
exec bash --noprofile --norc -i
EOF
chmod +x /tmp/bridge-console.sh

exec "$TTYD" --port 7681 --interface 0.0.0.0 --writable /tmp/bridge-console.sh
