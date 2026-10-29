#!/bin/sh
. /lib/functions.sh
. /usr/share/udpspeeder-luci/common.sh

check_domain() {
	local cfg="$1" enabled remote family peer old
	config_get_bool enabled "$cfg" enabled 0
	[ "$enabled" = 1 ] || return 0
	config_get remote "$cfg" remote
	split_endpoint "$remote" || return 0
	ip_literal "$endpoint_host" && return 0
	config_get family "$cfg" family auto
	peer=$(resolve_host "$endpoint_host" "$family" "$dns_server") || return 0
	old=$(cat "$STATE_DIR/$cfg.resolved" 2>/dev/null)
	[ "$peer" = "$old" ] && return 0
	# Do not advance the baseline before the new instance has resolved it.
	/etc/init.d/udpspeeder-luci refresh_rule "$cfg"
}

while :; do
	config_load udpspeeder
	config_get check_interval global check_interval 60
	config_get dns_server global dns_server ''
	uint_range "$check_interval" 10 86400 || check_interval=60
	sleep "$check_interval"
	# Reload after the wait, so stopped/deleted rules cannot be revived.
	config_load udpspeeder
	config_get dns_server global dns_server ''
	config_foreach check_domain udpspeeder
done
