#!/bin/sh
. /lib/functions.sh
. /usr/share/udpspeeder-luci/common.sh

umask 077
cfg="$1"
valid_id "$cfg" || exit 1
mkdir -p "$STATE_DIR"
load_rule "$cfg" || exit 1
validate_rule || exit 1

printf 'resolving\n\n' > "$STATE_DIR/$cfg.status"
peer=$(resolve_host "$remote_host" "$family" "$dns_server") || {
	rule_error "Cannot resolve $remote_host"
	exit 1
}
printf '%s\n' "$peer" > "$STATE_DIR/$cfg.resolved"
set -- /usr/bin/udpspeeder
if [ "$server" = 1 ]; then set -- "$@" -s; else set -- "$@" -c; fi
set -- "$@" -l "$local_endpoint" -r "$(format_endpoint "$peer" "$remote_port")"
[ -z "$key" ] || set -- "$@" -k "$key"
set -- "$@" --mode "$mode" --mtu "$mtu" --timeout "$timeout" --queue-len "$queue_len"
set -- "$@" --sock-buf "$sock_buf" --decode-buf "$decode_buf" --log-level "$log_level" --disable-color
set -- "$@" --interval "$interval" --jitter "$jitter" --random-drop "$random_drop"
if [ "${disable_fec:-0}" = 1 ]; then set -- "$@" --disable-fec; else set -- "$@" --fec "$fec"; fi
[ "${disable_obscure:-0}" != 1 ] || set -- "$@" --disable-obscure
[ "${disable_checksum:-0}" != 1 ] || set -- "$@" --disable-checksum
if [ "${fix_latency:-0}" = 1 ] && [ "$mode" = 0 ]; then set -- "$@" --fix-latency; fi
[ "$report" = 0 ] || set -- "$@" --report "$report"
[ -z "$out_interface" ] || set -- "$@" --out-interface "$out_interface"

fifo="$STATE_DIR/$cfg.pipe"
child=''; reader=''
cleanup() {
	trap '' TERM INT
	[ -z "$child" ] || kill "$child" 2>/dev/null
	[ -z "$child" ] || wait "$child" 2>/dev/null
	[ -z "$reader" ] || wait "$reader" 2>/dev/null
	rm -f "$fifo"
}
trap 'cleanup; exit 0' TERM INT
trap 'rm -f "$fifo"' EXIT
rm -f "$fifo"
mkfifo -m 600 "$fifo" || exit 1
printf 'running\n\n' > "$STATE_DIR/$cfg.status"
"$@" > "$fifo" 2>&1 &
child=$!
# The core prints its complete argv, including -k, even at info level.
# Discard that line and its debug key line before storing any logs.
awk -v file="$STATE_DIR/$cfg.log" -v max="$log_max" '
	function keep(line, i, start) {
		lines[count % max]=line; count++;
		start=count>max ? count-max : 0;
		printf "%s", "" > file;
		for(i=start;i<count;i++) print lines[i % max] > file;
		close(file);
	}
	BEGIN { while((getline line < file)>0) {lines[count % max]=line; count++} close(file) }
	/argc=[0-9]+|key=|key len/ { next }
	{ keep($0) }
' < "$fifo" &
reader=$!
wait "$child"
result=$?
child=''
wait "$reader"
reader=''
printf 'error\nProcess exited (%s); check rule logs\n' "$result" > "$STATE_DIR/$cfg.status"
exit "$result"
