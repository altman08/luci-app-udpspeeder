#!/bin/sh
# Shared validation and DNS helpers. No shell evaluation of configuration values.
STATE_DIR=/var/run/udpspeeder-luci

valid_id() {
	case "$1" in ''|*[!A-Za-z0-9_]*) return 1 ;; esac
	[ "${#1}" -le 64 ]
}

uint_range() {
	case "$1" in ''|*[!0-9]*) return 1 ;; esac
	[ "${#1}" -le 8 ] && [ "$1" -ge "$2" ] && [ "$1" -le "$3" ]
}

valid_fec() {
	[ "${#1}" -le 2500 ] || return 1
	printf '%s\n' "$1" | awk -F, '
		{ prev=0; for(i=1;i<=NF;i++) {
			if($i !~ /^[0-9]+:[0-9]+$/) exit 1;
			split($i,p,":"); x=p[1]+0; y=p[2]+0;
			if(x<1 || y<0 || x+y>255 || x<=prev) exit 1;
			prev=x;
		} if(!NF) exit 1; }'
}

valid_window() {
	printf '%s\n' "$1" | awk -F: '
		NF==1 && $1 ~ /^[0-9]+$/ {exit !($1>=0 && $1<=10000)}
		NF==2 && $1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ {exit !($1>=0 && $1<=$2 && $2<=10000)}
		{exit 1}'
}

# Separate IPv6 literals from the port before passing them to the core.
split_endpoint() {
	local endpoint="$1"
	case "$endpoint" in
		\[*\]:*) endpoint_host="${endpoint#\[}"; endpoint_host="${endpoint_host%\]:*}"; endpoint_port="${endpoint##*\]:}" ;;
		*:*) endpoint_host="${endpoint%:*}"; endpoint_port="${endpoint##*:}"
			case "$endpoint_host" in *:*) return 1 ;; esac ;;
		*) return 1 ;;
	esac
	case "$endpoint_host" in ''|-*|*[!A-Za-z0-9_.:-]*) return 1 ;; esac
	[ "${#endpoint_host}" -le 253 ] && uint_range "$endpoint_port" 1 65535
}

ip_literal() {
	case "$1" in *:*) return 0 ;; *[!0-9.]*|'') return 1 ;; *.*.*.*) return 0 ;; esac
	return 1
}

rule_uses_domain() {
	local cfg="$1" enabled remote
	valid_id "$cfg" || return 1
	config_get_bool enabled "$cfg" enabled 0
	[ "$enabled" = 1 ] || return 1
	config_get remote "$cfg" remote
	split_endpoint "$remote" || return 1
	! ip_literal "$endpoint_host"
}

mark_dns_rule() {
	rule_uses_domain "$1" && dns_needed=1
	return 0
}

dns_monitor_needed() {
	local dns_needed=0
	config_foreach mark_dns_rule udpspeeder
	[ "$dns_needed" = 1 ]
}

valid_literal() {
	[ "${#1}" -le 45 ] || return 1
	case "$1" in
		*:*) case "$1" in *[!0-9a-fA-F:.]*) return 1 ;; esac ;;
		*) printf '%s\n' "$1" | awk -F. 'NF!=4 {exit 1} {for(i=1;i<=4;i++) if($i !~ /^[0-9]+$/ || $i>255) exit 1}' ;;
	esac
}

format_endpoint() {
	case "$1" in *:*) printf '[%s]:%s\n' "$1" "$2" ;; *) printf '%s:%s\n' "$1" "$2" ;; esac
}

stop_if_registered() {
	local service="$1" info
	case "$service" in udpspeeder|udpspeeder-luci) ;; *) return 1 ;; esac
	info=$(ubus call service list "{\"name\":\"$service\"}") || return 1
	# The list is filtered by this exact service name; an absent service is {}.
	case "$info" in
		*\""$service"\"*) "/etc/init.d/$service" stop ;;
		*) return 0 ;;
	esac
}

resolve_host() {
	local host="$1" family="$2" dns="$3" result type server
	if ip_literal "$host"; then printf '%s\n' "$host"; return 0; fi
	for server in "$dns" ''; do
		for type in A AAAA; do
			[ "$family" = ipv4 ] && [ "$type" = AAAA ] && continue
			[ "$family" = ipv6 ] && [ "$type" = A ] && continue
			if [ -n "$server" ]; then
				result=$(timeout 8 nslookup "-type=$type" "$host" "$server" 2>/dev/null)
			else
				result=$(timeout 8 nslookup "-type=$type" "$host" 2>/dev/null)
			fi
			# BusyBox/BIND both print the resolver's own address first. Only
			# consider records after Name:, and filter the requested family.
			result=$(printf '%s\n' "$result" | awk -v type="$type" '
				/^Name:[[:space:]]*/ { answer=1; next }
				answer && /^Address([[:space:]]+[0-9]+)?:[[:space:]]*/ {
					sub(/^Address([[:space:]]+[0-9]+)?:[[:space:]]*/, "");
					ip=$1;
					if(type=="A" && ip ~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/) {print ip; exit}
					if(type=="AAAA" && ip ~ /:/ && ip !~ /[^0-9a-fA-F:.]/) {print ip; exit}
				}')
			if [ -n "$result" ] && valid_literal "$result"; then printf '%s\n' "$result"; return 0; fi
		done
		[ -n "$dns" ] || break
	done
	return 1
}

rule_error() {
	local limit=${log_max:-100}
	uint_range "$limit" 10 1000 || limit=100
	printf '%s\n' "$*" >&2
	printf 'error\n%s\n' "$*" > "$STATE_DIR/$cfg.status"
	printf '%s\n' "$*" >> "$STATE_DIR/$cfg.log"
	tail -n "$limit" "$STATE_DIR/$cfg.log" > "$STATE_DIR/$cfg.log.tmp"
	mv "$STATE_DIR/$cfg.log.tmp" "$STATE_DIR/$cfg.log"
	return 1
}

load_rule() {
	cfg="$1"
	valid_id "$cfg" || return 1
	config_load udpspeeder
	local section_type
	config_get section_type "$cfg" TYPE
	[ "$section_type" = udpspeeder ] || return 1
	local field
	for field in server mode mtu timeout local remote key report disable_obscure interval fec disable_fec sock_buf log_level decode_buf fix_latency queue_len jitter random_drop disable_checksum out_interface family; do
		config_get "$field" "$cfg" "$field"
	done
	server=${server:-0}; mode=${mode:-0}; mtu=${mtu:-1250}; timeout=${timeout:-8}
	report=${report:-0}; interval=${interval:-0}; fec=${fec:-20:10}; sock_buf=${sock_buf:-1024}
	log_level=${log_level:-4}; decode_buf=${decode_buf:-2000}; queue_len=${queue_len:-200}
	jitter=${jitter:-0}; random_drop=${random_drop:-0}; family=${family:-auto}
	config_get dns_server global dns_server ''
	config_get log_max global log_max 100
}

validate_rule() {
	local field value
	for field in server disable_obscure disable_fec fix_latency disable_checksum; do
		config_get value "$cfg" "$field" 0
		case "$value" in 0|1) ;; *) rule_error "Invalid $field"; return 1 ;; esac
	done
	uint_range "$mode" 0 1 && uint_range "$mtu" 100 2000 && uint_range "$timeout" 0 1000 &&
	uint_range "$report" 0 86400 && uint_range "$sock_buf" 10 10240 &&
	uint_range "$log_level" 0 6 && uint_range "$decode_buf" 300 20000 &&
	uint_range "$queue_len" 1 10000 && uint_range "$random_drop" 0 10000 &&
	valid_fec "$fec" && valid_window "$interval" && valid_window "$jitter" || {
		rule_error 'Invalid FEC or numeric settings'; return 1;
	}
	uint_range "$log_max" 10 1000 || log_max=100
	case "$family" in auto|ipv4|ipv6) ;; *) rule_error 'Invalid address family'; return 1 ;; esac
	case "$key" in *[[:space:]]*) rule_error 'Key must not contain whitespace'; return 1 ;; esac
	[ "${#key}" -le 256 ] || { rule_error 'Key is too long'; return 1; }
	case "$out_interface" in *[!A-Za-z0-9_.:@-]*) rule_error 'Invalid output device'; return 1 ;; esac
	[ "${#out_interface}" -le 15 ] || { rule_error 'Output device is too long'; return 1; }
	case "$dns_server" in *[!0-9a-fA-F:.]*) rule_error 'DNS server must be an IP address'; return 1 ;; esac
	[ -z "$dns_server" ] || valid_literal "$dns_server" || { rule_error 'Invalid DNS server'; return 1; }
	split_endpoint "$local" && ip_literal "$endpoint_host" && valid_literal "$endpoint_host" || { rule_error 'Invalid local IP:port'; return 1; }
	local_endpoint=$(format_endpoint "$endpoint_host" "$endpoint_port")
	split_endpoint "$remote" || { rule_error 'Invalid remote address:port'; return 1; }
	remote_host="$endpoint_host"; remote_port="$endpoint_port"
	if ip_literal "$remote_host"; then
		valid_literal "$remote_host" || { rule_error 'Invalid remote IP'; return 1; }
	fi
}
