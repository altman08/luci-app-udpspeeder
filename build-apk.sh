#!/bin/sh
# Build this architecture-independent package using apk-tools 3.
set -eu
cd -- "$(dirname -- "$0")"
APK_TOOL=${APK_TOOL:-apk}
PO2LMO=${PO2LMO:-po2lmo}
command -v "$PO2LMO" >/dev/null 2>&1 || {
	printf '%s\n' 'po2lmo is required to build the Chinese translation (set PO2LMO or add it to PATH).' >&2
	exit 1
}
package_dir=luci-app-udpspeeder
field() { sed -n "s/^$1:=//p" "$package_dir/Makefile" | tr -d '\r\n'; }
name=$(field PKG_NAME)
version=$(field PKG_VERSION)
release=$(field PKG_RELEASE)
translation=luci-i18n-udpspeeder-zh-cn
dist_dir=${DIST_DIR:-dist}
mkdir -p "$dist_dir"
dist_dir=$(CDPATH='' cd -- "$dist_dir" && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
trap 'exit 1' HUP INT TERM
data="$work/$name/data"
mkdir -p "$data/www" "$data/usr/lib/opkg/info"
cp -R "$package_dir/root/." "$data/"
cp -R "$package_dir/htdocs/." "$data/www/"
chmod 0755 "$data/etc/init.d/udpspeeder-luci" "$data/etc/uci-defaults/90-udpspeeder-luci" "$data/usr/share/udpspeeder-luci/"*.sh

# OpenWrt default_postinst/default_prerm execute these package-specific hooks.
for hook in postinst prerm; do
	awk -v target="Package/$name/$hook" '
		$0 == "define " target {found=1; next}
		found && /^endef$/ {exit}
		found {gsub(/\$\$/, "$"); print}
	' "$package_dir/Makefile" > "$data/usr/lib/opkg/info/$name.$hook-pkg"
	test -s "$data/usr/lib/opkg/info/$name.$hook-pkg"
done

translation_data="$work/$translation/data"
mkdir -p "$translation_data/etc/uci-defaults" "$translation_data/usr/lib/lua/luci/i18n"
cat > "$translation_data/etc/uci-defaults/$translation" <<'EOF'
uci set luci.languages.zh_cn='简体中文 (Simplified Chinese)'; uci commit luci
EOF
"$PO2LMO" "$package_dir/po/zh_Hans/udpspeeder.po" \
	"$translation_data/usr/lib/lua/luci/i18n/udpspeeder.zh-cn.lmo"
test -s "$translation_data/usr/lib/lua/luci/i18n/udpspeeder.zh-cn.lmo"

pack() {
	package_name=$1
	package_data=$2
	dependencies=$3
	description=$4
	hooks="$work/$package_name"
	meta="$package_data/lib/apk/packages"
	mkdir -p "$meta"
	(cd "$package_data" && find . -type f | sed 's|^\.||' | LC_ALL=C sort) > "$hooks/files"
	cp "$hooks/files" "$meta/$package_name.list"
	for hook in post-install post-upgrade pre-deinstall pre-upgrade; do
		{
			printf '#!/bin/sh\n'
			case "$hook" in *upgrade) printf 'export PKG_UPGRADE=1\n';; esac
			case "$hook" in post-*) printf '[ "${IPKG_NO_SCRIPT:-}" = 1 ] && exit 0\n';; esac
			cat <<'EOF'
[ -s "$IPKG_INSTROOT/lib/functions.sh" ] || exit 0
. "$IPKG_INSTROOT/lib/functions.sh"
export root="$IPKG_INSTROOT"
EOF
			printf 'export pkgname=%s\n' "$package_name"
			case "$hook" in post-*) printf 'default_postinst\n';; pre-*) printf 'default_prerm\n';; esac
		} > "$hooks/$hook"
		sh -n "$hooks/$hook"
	done
	output="$dist_dir/$package_name-$version-r$release.apk"
	SOURCE_DATE_EPOCH=${SOURCE_DATE_EPOCH:-0} "$APK_TOOL" mkpkg \
		--info "name:$package_name" --info "version:$version-r$release" --info arch:noarch \
		--info "description:$description" --info "license:$(field PKG_LICENSE)" \
		--info "origin:$name" --info "url:$(field LUCI_URL)" --info "maintainer:$(field LUCI_MAINTAINER)" \
		--info "depends:$dependencies" \
		--script "post-install:$hooks/post-install" --script "post-upgrade:$hooks/post-upgrade" \
		--script "pre-deinstall:$hooks/pre-deinstall" --script "pre-upgrade:$hooks/pre-upgrade" \
		--files "$package_data" --output "$output"
	"$APK_TOOL" --allow-untrusted verify "$output"
	(cd "$dist_dir" && sha256sum "$(basename "$output")") > "$output.sha256"
	cat "$output.sha256"
}

pack "$name" "$data" "$(field LUCI_DEPENDS | tr -d '+')" "$(field LUCI_DESCRIPTION)"
pack "$translation" "$translation_data" "$name" 'Simplified Chinese translation for luci-app-udpspeeder'
