trap "echo CONTROL: exiting; killall -w -2 cloudflared || echo CONTROL: tunnel is already stopped; exit;" INT TERM

# Check before the tunnel connects, then every 5 minutes. A failed check
# leaves the current binary running. Exit 0 means a new binary was installed.
sh update-bin.sh || true
echo cfd-start | sh process.sh

(
	while true
	do
		sleep 300
		if sh update-bin.sh; then
			echo cfd-restart | sh process.sh
		fi
	done
) &

while true 
do 
	sh accept.sh | sh process.sh
done

