#!/bin/sh
# Keep the core package's files and UCI configuration intact.
set -eu
. /usr/share/udpspeeder-luci/common.sh
state=/etc/udpspeeder-luci
case "${1:-}" in
	install)
		mkdir -p "$state"
		if [ ! -f "$state/legacy-enabled" ]; then
			if /etc/init.d/udpspeeder enabled; then
				echo 1 > "$state/legacy-enabled"
			else
				echo 0 > "$state/legacy-enabled"
			fi
		fi
		stop_if_registered udpspeeder
		/etc/init.d/udpspeeder disable
		stop_if_registered udpspeeder-luci
		if ! uci -q get udpspeeder.global >/dev/null; then
			uci set udpspeeder.global=global
			uci set udpspeeder.global.check_interval=60
			uci set udpspeeder.global.log_max=100
			uci commit udpspeeder
		fi
		rm -f /tmp/luci-indexcache.*
		;;
	remove)
		stop_if_registered udpspeeder-luci
		/etc/init.d/udpspeeder-luci disable || true
		if [ "$(cat "$state/legacy-enabled" 2>/dev/null || true)" = 1 ]; then
			/etc/init.d/udpspeeder enable
			/etc/init.d/udpspeeder start
		fi
		rm -f "$state/legacy-enabled"
		rmdir "$state" 2>/dev/null || true
		;;
	*) exit 1 ;;
esac
