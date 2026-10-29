# SPDX-License-Identifier: Apache-2.0
include $(TOPDIR)/rules.mk

PKG_NAME:=luci-app-udpspeeder
PKG_VERSION:=1.0.0
PKG_RELEASE:=7
PKG_PO_VERSION:=$(PKG_VERSION)-r$(PKG_RELEASE)
PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=Kwrt

LUCI_TITLE:=LuCI support for UDPspeeder
LUCI_DESCRIPTION:=Manage multiple UDPspeeder instances with FEC settings, DNS monitoring and per-instance logs
LUCI_DEPENDS:=+luci-base +UDPspeeder
LUCI_PKGARCH:=all
LUCI_URL:=https://github.com/altman08/luci-app-udpspeeder
LUCI_MAINTAINER:=Kwrt

define Package/luci-app-udpspeeder/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
/etc/init.d/rpcd reload
endef

define Package/luci-app-udpspeeder/prerm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] && exit 0
[ "$${PKG_UPGRADE}" = 1 ] && exit 0
/usr/share/udpspeeder-luci/lifecycle.sh remove
endef

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
