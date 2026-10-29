#!/bin/sh
. /lib/functions.sh
. /usr/share/udpspeeder-luci/common.sh

check_domain() {
	local cfg="$1" family peer old
	rule_uses_domain "$cfg" || return 0
	config_get family "$cfg" family auto
	peer=$(resolve_host "$endpoint_host" "$family" "$dns_server") || return 0
	old=$(cat "$STATE_DIR/$cfg.resolved" 2>/dev/null)
	[ "$peer" = "$old" ] && return 0
	# Do not advance the baseline before the new instance has resolved it.
	/etc/init.d/udpspeeder-luci refresh_rule "$cfg"
}

sleeper=''
cleanup() {
	trap '' TERM INT
	if [ -n "$sleeper" ]; then
		kill "$sleeper" 2>/dev/null
		wait "$sleeper" 2>/dev/null
	fi
}
trap 'cleanup; exit 0' TERM INT

while :; do
	config_load udpspeeder
	config_get check_interval global check_interval 60
	config_get dns_server global dns_server ''
	uint_range "$check_interval" 10 86400 || check_interval=60
	sleep "$check_interval" &
	sleeper=$!
	wait "$sleeper"
	sleeper=''
	# Reload after the wait, so stopped/deleted rules cannot be revived.
	config_load udpspeeder
	config_get dns_server global dns_server ''
	config_foreach check_domain udpspeeder
done
