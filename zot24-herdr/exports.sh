# Herdr exports for other Umbrel apps
# Lets sibling apps reference the container hostname/port without hard-coding.

export APP_ZOT24_HERDR_IP="zot24-herdr_server_1"
export APP_ZOT24_HERDR_PORT="7681"

# SSH into the app itself (Moshi, `herdr --remote`). Published on the Umbrel
# host, so it must not collide with anything else on the box: 22 is the host's
# own sshd and 2222 belongs to the official Gitea app. Same pattern Gitea uses
# for APP_GITEA_SSH_PORT.
export APP_ZOT24_HERDR_SSH_PORT="7682"
