#!/bin/sh
# SHELL for herdr-core terminals; the image installs it as
# /usr/local/lib/herdr-umbrel/login/bash (see entrypoint.sh).
#
# hc starts a new terminal with plain $SHELL, so without this every terminal
# the Herdr desktop app opens here would be a bare /bin/sh with the
# container's start-time environment. A login bash reads /data/.profile
# instead: the same PATH and /data/.env secrets an SSH login gets, so keys
# saved on the setup page reach new terminals without an app restart.
#
# The installed name is `bash` because the desktop app recognises a shell by
# the file name it was started as; under its own name every terminal here
# would be labelled as an unknown program instead of a shell.
exec /bin/bash -l "$@"
