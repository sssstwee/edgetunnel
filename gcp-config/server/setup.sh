#!/usr/bin/env bash
# Provision the GCP proxy VM (Debian 13, run as root from a directory holding this folder's files):
#   Xray VLESS-Reality-Vision on TCP 443, Hysteria 2 on UDP 443 with port hopping,
#   a monthly egress cap that keeps the bill inside the $10 credit, BBR and swap.
# Safe to re-run: secrets, the certificate and quota accounting are kept.
set -euo pipefail

: "${EGRESS_LIMIT_GIB:=260}"
: "${HOP_PORTS:=21000-21050}"
export EGRESS_LIMIT_GIB HOP_PORTS
HERE=$(cd "$(dirname "$0")" && pwd)
export DEBIAN_FRONTEND=noninteractive

apt-get -qq update
apt-get -qq install -y --no-install-recommends nftables curl ca-certificates openssl python3 unattended-upgrades cloud-guest-utils >/dev/null
printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades

# ---- Kernel: tuned for a ~190 ms, lossy China–US path ----
# BBR + fq for TCP; 16 MiB socket buffers cover the bandwidth-delay product of QUIC and REALITY at
# 200+ Mbit/s; keep cwnd across idle gaps so reused connections don't restart slow start; cap unsent
# data per socket to bound queueing delay; probe MTU in case ICMP is filtered on the way.
# tcp_mem (4 KiB pages) lifts the kernel's ~82 MiB default for all TCP buffers to 96/128/192 MiB:
# 8 concurrent REALITY downloads already used 38 MiB, and pressure would shrink every socket's buffer.
cat > /etc/sysctl.d/90-gcp-proxy.conf <<'SYSCTL'
net.core.default_qdisc = fq
net.ipv4.tcp_congestion_control = bbr
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.ipv4.tcp_rmem = 4096 131072 16777216
net.ipv4.tcp_wmem = 4096 65536 16777216
net.ipv4.tcp_mem = 24576 32768 49152
net.ipv4.tcp_slow_start_after_idle = 0
net.ipv4.tcp_notsent_lowat = 131072
net.ipv4.tcp_mtu_probing = 1
vm.swappiness = 10
SYSCTL
sysctl -q --system

# ---- Root filesystem follows the disk size (30 GB fills the free tier's 30 GB-months) ----
growpart /dev/sda 1 >/dev/null 2>&1 && resize2fs /dev/sda1 >/dev/null 2>&1 || true

# ---- 1 GiB swap: the VM has 1 GB RAM ----
if ! swapon --show=NAME --noheadings | grep -qx /swapfile; then
  [ -f /swapfile ] || { fallocate -l 1G /swapfile; chmod 600 /swapfile; mkswap -q /swapfile; }
  swapon /swapfile
fi
grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab

# ---- Egress cap: loaded before any proxy may send ----
# Stop Debian's nftables.service first; its stop runs "flush ruleset" and would wipe the quota table.
systemctl disable --now nftables.service >/dev/null 2>&1 || true
install -d -m 700 /etc/gcp-proxy
printf 'EGRESS_LIMIT_GIB=%s\n' "$EGRESS_LIMIT_GIB" > /etc/gcp-proxy/quota.env
install -m 755 "$HERE/egress-quota.py" /usr/local/sbin/gcp-egress-quota
cat > /etc/systemd/system/gcp-egress-quota.service <<'UNIT'
[Unit]
Description=Enforce the monthly Internet egress cap
DefaultDependencies=no
Wants=network-pre.target
After=local-fs.target nftables.service
Before=network-pre.target shutdown.target
Conflicts=shutdown.target

[Service]
Type=oneshot
EnvironmentFile=/etc/gcp-proxy/quota.env
StateDirectory=gcp-egress-quota
StateDirectoryMode=0700
UMask=0077
LogLevelMax=notice
ExecStart=/usr/local/sbin/gcp-egress-quota

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/systemd/system/gcp-egress-quota.timer <<'UNIT'
[Unit]
Description=Replenish the egress cap in accounted blocks

[Timer]
OnBootSec=10s
OnUnitActiveSec=10s
AccuracySec=1s

[Install]
WantedBy=timers.target
UNIT
cat > /etc/systemd/system/gcp-usage-report.service <<'UNIT'
[Unit]
Description=Report egress usage to the subscription Worker
ConditionPathExists=/etc/gcp-proxy/usage-url
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
EnvironmentFile=/etc/gcp-proxy/quota.env
LogLevelMax=notice
ExecStart=/bin/sh -c '/usr/local/sbin/gcp-egress-quota report | curl -fsS --max-time 15 -H "Content-Type: application/json" --data-binary @- "$(cat /etc/gcp-proxy/usage-url)"'
UNIT
cat > /etc/systemd/system/gcp-usage-report.timer <<'UNIT'
[Unit]
Description=Report egress usage every 10 minutes

[Timer]
OnBootSec=2min
OnUnitActiveSec=10min

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now gcp-egress-quota.service gcp-egress-quota.timer gcp-usage-report.timer

# ---- Hysteria port hopping: UDP $HOP_PORTS lands on 443 ----
# Own unit instead of Debian's nftables.service: its stop/restart runs "flush ruleset", which would
# also drop the quota table and make the cap count the whole reserved block as spent.
cat > /etc/gcp-proxy/hy2-hop.nft <<NFT
destroy table inet gcp_hy2_hop
table inet gcp_hy2_hop {
    chain prerouting {
        type nat hook prerouting priority dstnat; policy accept;
        udp dport ${HOP_PORTS} redirect to :443
    }
}
NFT
cat > /etc/systemd/system/gcp-hy2-hop.service <<'UNIT'
[Unit]
Description=Redirect the Hysteria 2 port-hopping range to UDP 443
Before=hysteria-server.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/sbin/nft -f /etc/gcp-proxy/hy2-hop.nft
ExecStop=/usr/sbin/nft destroy table inet gcp_hy2_hop

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now gcp-hy2-hop.service
systemctl start gcp-egress-quota.service

# ---- Official installers ----
command -v xray >/dev/null || bash -c "$(curl -fsSL https://github.com/XTLS/Xray-install/raw/main/install-release.sh)" @ install
command -v hysteria >/dev/null || bash <(curl -fsSL https://get.hy2.sh/)

for unit in xray hysteria-server; do
  install -d "/etc/systemd/system/$unit.service.d"
  printf '[Unit]\nRequires=gcp-egress-quota.service\nAfter=gcp-egress-quota.service\n' > "/etc/systemd/system/$unit.service.d/10-egress-quota.conf"
done
systemctl daemon-reload

XRAY_USER=$(systemctl show -p User --value xray.service); XRAY_USER=${XRAY_USER:-root}
python3 "$HERE/render-config.py" "$(id -gn "$XRAY_USER")"
xray run -test -config /usr/local/etc/xray/config.json >/dev/null
systemctl enable xray.service hysteria-server.service >/dev/null 2>&1
systemctl restart xray.service hysteria-server.service
sleep 2
systemctl is-active xray.service hysteria-server.service gcp-egress-quota.timer gcp-hy2-hop.service
ss -lntupH 'sport = :443'
sync
