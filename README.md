# luci-app-udpspeeder

适用于新版 JavaScript LuCI 的 UDPspeeder 多实例管理界面，菜单为 **网络 → UDP 流量加速**。

支持客户端与服务端、多规则启停、FEC 参数校验、IPv4/IPv6、域名解析与 DDNS 更新，以及按实例隔离的内存日志。界面参考 `luci-app-udp2raw-ultra`。

## 安装 APK

```sh
apk add --allow-untrusted ./luci-app-udpspeeder-1.0.0-r7.apk ./luci-i18n-udpspeeder-zh-cn-1.0.0-r7.apk
```

主包使用英文原文，简体中文由独立的 `luci-i18n-udpspeeder-zh-cn` 提供。安装中文包后，界面跟随 LuCI 的语言设置；未安装中文包时显示英文。中文菜单名称为 **UDP 流量加速**，英文为 **UDP Traffic Acceleration**。

主包依赖 `luci-base` 和 `UDPspeeder`，由设备的软件源安装。域名解析使用固件自带的 BusyBox `nslookup`，不依赖 `drill` 或 `libldns`。此包为 `noarch`，包含页面和服务脚本，核心二进制由 `UDPspeeder` 提供。

安装前可以备份已有配置：

```sh
cp /etc/config/udpspeeder /etc/config/udpspeeder.backup
```

沿用核心包的 `/etc/config/udpspeeder`，保留已有规则。插件不覆盖核心包拥有的配置及 init 文件；使用 `/etc/init.d/udpspeeder-luci` 管理进程，安装时停止并禁用原 `/etc/init.d/udpspeeder`，避免重复监听。升级插件保留配置；卸载插件保留配置，并按首次安装前的状态恢复原服务自启动设置。

上游核心包可能附带两条已启用的示例规则，安装后请在规则列表中按实际用途调整。服务端监听端口需要自行在防火墙放行 UDP。

## 示例：为 WireGuard 添加 FEC

服务端（公网设备）：

| 字段                | 示例                      |
| ------------------- | ------------------------- |
| 角色                | 服务端                    |
| 本地监听地址 / 端口 | `0.0.0.0` / `4096`    |
| 目标地址 / 端口     | `127.0.0.1` / `51820` |
| 密钥                | 自行设置，两端一致        |
| FEC 冗余参数        | `20:10`                 |

客户端：

| 字段                | 示例                           |
| ------------------- | ------------------------------ |
| 角色                | 客户端                         |
| 本地监听地址 / 端口 | `127.0.0.1` / `4096`       |
| 目标地址 / 端口     | `vpn.example.com` / `4096` |
| 密钥                | 与服务端一致                   |
| FEC 冗余参数        | `20:10`                      |

将客户端 WireGuard 的对端 Endpoint 设为 `127.0.0.1:4096`。密钥仅用于简单 XOR 混淆，WireGuard 自身负责加密。

FEC 编码参数可以两端不同。密钥、禁用随机混淆、禁用校验、禁用 FEC 等协议选项需要两端一致。

## 配置与操作

- 列表中的状态和操作分为两列；停止时显示“启动”和置灰的“停止”，运行时显示“重启”和“停止”。运行中或启动失败时可通过状态列的日志链接查看日志；未填写名称时显示规则的 section ID。
- “角色”对应原 UCI `server`；“FEC 模式”对应原 `mode`，两者独立。
- 地址和端口分开输入，保存为原有 `local`、`remote` 字段；IPv6 自动添加方括号。
- 新增规则默认禁用。“保存并应用”应用表单；行内启动、停止同步该规则的启用设置，使用已保存的其他参数。存在尚未应用的 UCI 更改时，先应用更改。
- 默认 FEC 为 `20:10`，模式 `0`，MTU `1250`，编码超时 `8ms`，队列长度 `200`。
- 报告间隔 `0` 表示不传 `--report`；核心程序不接受 `--report 0`。
- DNS 留空使用系统 DNS，也可指定 DNS IP。自动地址族先查 A 再查 AAAA。解析暂时失败时，由 procd 重试；域名 IP 改变后，只更新对应实例。只有存在已启用且目标为域名的规则时才启动 DNS 监控；纯 IP 目标、全部规则停用时不启动监控，停止最后一条域名规则时会移除监控及其等待进程。
- “运行中”表示进程存在；隧道是否实际可用，需要通过真实 UDP 应用确认。
- 日志保存在 `/var/run/udpspeeder-luci/<section>.log`，重启设备后清空，最多保留 1000 行。程序启动时输出的完整参数行和密钥调试行会被过滤。
- “目标出口设备”对应核心的 `--out-interface`，使用实际设备名，例如 `pppoe-wan`。它不会自动修改系统策略路由。

插件扩展的域名解析和报告关闭语义由增强服务处理。若卸载后改回原服务，需将域名目标改成 IP，并将报告间隔改为正整数或删除该选项，使原服务使用默认值。

服务命令：

```sh
/etc/init.d/udpspeeder-luci status
/etc/init.d/udpspeeder-luci restart
/etc/init.d/udpspeeder-luci rule_log tunnel1
```

单规则命令使用 UCI section ID，备注名称可以任意填写。插件不会自动添加防火墙、TTL 或策略路由规则。

## 加入固件编译

在 OpenWrt 或 ImmortalWrt 源码的 `feeds.conf.default` 中添加：

```text
src-git udpspeeder https://github.com/altman08/luci-app-udpspeeder.git
```

在固件源码根目录执行：

```sh
./scripts/feeds update udpspeeder
./scripts/feeds install -p udpspeeder luci-app-udpspeeder
make menuconfig
```

在 **LuCI → Applications** 中选中 `luci-app-udpspeeder`，对应配置为 `CONFIG_PACKAGE_luci-app-udpspeeder=y`。依赖由构建系统自动选择。需要中文时，在 **LuCI → Translations** 中启用 **Chinese Simplified**（`CONFIG_LUCI_LANG_zh_Hans=y`）；构建系统会自动选择 `luci-i18n-udpspeeder-zh-cn`，随后按正常流程编译固件。

只编译插件包：

```sh
make package/feeds/udpspeeder/luci-app-udpspeeder/compile V=s
```

## GitHub Actions

参考 `luci-proto-n2n` 的发布流程，使用 `openwrt/gh-action-sdk@v11`：

1. 推送仓库后进入 **Actions → Release OpenWrt packages → Run workflow**。
2. 填写发布标签，例如 `v1.0.0`，选择是否为预发布。
3. 分别填写两种格式的 SDK 版本：APK 的 `sdk` 默认 `25.12.5`，IPK 的 `ipk_sdk` 默认 `24.10.5`。每次运行都会并行构建两种格式。
4. 工作流先运行前后端和产物收集测试，再构建 IPK 主包、IPK 简体中文包、APK 主包、APK 简体中文包，共四个包，以及各 SDK 的 SHA256 校验文件，上传至 Actions artifacts 并创建 GitHub Release。缺少主包或中文包时，该构建会失败并阻止发布。

本插件是架构无关包，每种格式仅需一个 x86_64 SDK 构建。Release 包名附带 `_openwrt-<SDK版本>` 后缀，安装时以下载的实际文件名为准。发布内容包含插件和独立的简体中文包，不包含 SDK 为构建依赖生成的 x86_64 核心包；路由器从自身软件源安装匹配架构的核心。

## 本地打包

本地打包不需要完整 SDK 编译环境。先将 apk-tools 3 的 `apk` 和 LuCI 的主机工具 `po2lmo` 加入 `PATH`，也可通过 `APK_TOOL`、`PO2LMO` 环境变量指定工具位置，然后执行：

```sh
./build-apk.sh
```

输出 `dist/luci-app-udpspeeder-1.0.0-r7.apk`、`dist/luci-i18n-udpspeeder-zh-cn-1.0.0-r7.apk` 及各自的 `.sha256`。中文包包含由 PO 编译得到的 LMO 翻译文件。两个包均未签名，安装时使用 `--allow-untrusted`。脚本包含与 OpenWrt 对应的安装、升级、卸载生命周期处理，不会包含测试文件。

## 验证

```sh
node --test tests/*.test.js
python3 -m unittest discover -s tests -p '*_test.py' -v
```

测试覆盖 IPK/APK 主包和中文包的收集、缺包拦截及 SHA256 校验、中英文切换、翻译完整性、占位符替换、原 UCI 地址格式、FEC 边界校验、操作失败与只读权限、DNS 回退、报告关闭、日志截断和密钥过滤，以及停止包装进程时对子进程的回收。

可选的真实核心往返测试（IPv4/IPv6、FEC 模式 0/1）：

```sh
python3 tests/native_smoke.py /path/to/native/udpspeeder
```

许可证：Apache-2.0。
