# One start/stop at a time. The update loop and the control port both call this.
exec 9>/tmp/cfd-process.lock
flock 9

start_cfd()
{
	echo "tunnel" > args

	echo "--metrics 0.0.0.0:$CLOUDFLARED_METRICS_PORT" >> args
	# Our update-bin.sh replaces the binary. cloudflared's own updater is
	# unchecked and would not survive a new container.
	echo "--no-autoupdate" >> args
	echo "--management-diagnostics=false" >> args

	cat "$CLOUDFLARED_EXTRA_ARGS_FILE" >> args
	echo >> args

	echo "run" >> args
	echo "--token-file $CLOUDFLARED_TOKEN_FILE" >> args

	# Prefer the checksum-verified binary on the data volume.
	bin=./cloudflared
	if [ -x /data/bin/cloudflared ]; then
		bin=/data/bin/cloudflared
	fi
	xargs "$bin" < args &
}

stop_cfd()
{
	timeout 3 killall -w -2 cloudflared 2>/dev/null || killall -9 cloudflared 2>/dev/null || echo "PROCESS: tunnel is already stopped"
}

read cmd
case $cmd in
	cfd-start)
		echo "PROCESS: starting"
		start_cfd
		;;
	cfd-stop)
		echo "PROCESS: stopping"
		stop_cfd
		;;
	cfd-restart)
		echo "PROCESS: restarting"
		stop_cfd
		start_cfd
		;;
esac
