#!/bin/bash
# What a person lands in: each web terminal tab (ttyd, behind web-gate) and
# each interactive SSH login (ssh-login.sh).
#
# Opens herdr-core's terminal picker, so they see the same terminals
# the Herdr desktop and phone apps run on this machine and can attach to one
# (ctrl+\ detaches). Picking "new…" starts a terminal in the core, which keeps
# running after the tab or connection closes. After the picker exits, or if
# hc fails, a plain login shell follows, where `hc` opens the picker again.
#
# Sources /data/.env first, so keys saved on the setup page reach this shell
# without an app restart (terminals the core starts get them from
# login-shell.sh instead).
set -a
[ -r /data/.env ] && . /data/.env
set +a

hc || true
printf '\nLeft the hc picker. Run hc to open it again, or work in this shell.\n\n'
exec bash -l
