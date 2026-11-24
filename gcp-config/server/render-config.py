#!/usr/bin/python3
# Render Xray, Hysteria 2 and client configs from secrets that are generated once and then kept.
# Output: /usr/local/etc/xray/config.json, /etc/hysteria/config.yaml and /etc/gcp-proxy/client.json
# (the Mihomo proxies that become the GCP_NODES Worker secret). Re-running never rotates credentials.

import json
import os
import secrets
import subprocess
import sys
import urllib.request
import uuid
from pathlib import Path

STATE = Path("/etc/gcp-proxy")
SECRETS = STATE / "secrets.json"
TLS_DIR = Path("/etc/hysteria/tls")
HY2_SNI = "gcp-proxy.invalid"
REALITY_TARGET = os.environ.get("REALITY_TARGET", "addons.mozilla.org")
HY2_MASQUERADE = os.environ.get("HY2_MASQUERADE", "https://www.bing.com/")
HOP_PORTS = os.environ.get("HOP_PORTS", "21000-21050")
LABEL = os.environ.get("NODE_LABEL", "GCP 俄勒冈")
# Client bandwidth turns on Hysteria's Brutal congestion control, which keeps its rate under the heavy
# loss of the China–US path. Set it to what the client's line really carries: too high only adds loss.
HY2_UP_MBPS = int(os.environ.get("HY2_UP_MBPS", "30"))
HY2_DOWN_MBPS = int(os.environ.get("HY2_DOWN_MBPS", "200"))
# Proxied requests must never reach the metadata server (instance credentials) or private ranges.
PRIVATE = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12",
           "192.168.0.0/16", "224.0.0.0/4", "::1/128", "fc00::/7", "fe80::/10"]
METADATA_HOSTS = ["metadata.google.internal", "metadata"]


def x25519():
    pairs = dict(line.split(": ", 1) for line in subprocess.check_output(["xray", "x25519"], text=True).splitlines() if ": " in line)
    private = next(v for k, v in pairs.items() if "private" in k.lower())
    public = next(v for k, v in pairs.items() if "public" in k.lower())
    return private.strip(), public.strip()


def load_secrets():
    if SECRETS.exists():
        return json.loads(SECRETS.read_text())
    private, public = x25519()
    values = {"vless_id": str(uuid.uuid4()), "reality_private": private, "reality_public": public,
              "short_id": secrets.token_hex(8), "hy2_password": secrets.token_urlsafe(32)}
    SECRETS.write_text(json.dumps(values, indent=2) + "\n")
    SECRETS.chmod(0o600)
    return values


def certificate():
    cert, key = TLS_DIR / "server.crt", TLS_DIR / "server.key"
    if not cert.exists():
        TLS_DIR.mkdir(parents=True, exist_ok=True)
        subprocess.run(["openssl", "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1",
                        "-days", "3650", "-nodes", "-subj", f"/CN={HY2_SNI}", "-addext", f"subjectAltName=DNS:{HY2_SNI}",
                        "-keyout", str(key), "-out", str(cert)], check=True, capture_output=True)
    subprocess.run(["chown", "-R", "root:hysteria", str(TLS_DIR)], check=True)
    os.chmod(key, 0o640)
    fingerprint = subprocess.check_output(["openssl", "x509", "-in", str(cert), "-noout", "-fingerprint", "-sha256"], text=True)
    return cert, key, fingerprint.strip().split("=", 1)[1]


def external_ip():
    request = urllib.request.Request(
        "http://169.254.169.254/computeMetadata/v1/instance/network-interfaces/0/access-configs/0/external-ip",
        headers={"Metadata-Flavor": "Google"})
    return urllib.request.urlopen(request, timeout=5).read().decode().strip()


def write(path, data, group, mode=0o640):
    path = Path(path)
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n")
    subprocess.run(["chown", f"root:{group}", str(path)], check=True)
    path.chmod(mode)


def main(xray_group):
    STATE.mkdir(mode=0o700, exist_ok=True)
    s = load_secrets()
    cert, key, fingerprint = certificate()
    write("/usr/local/etc/xray/config.json", {
        "log": {"loglevel": "warning"},
        "inbounds": [{
            "listen": "0.0.0.0", "port": 443, "protocol": "vless",
            "settings": {"clients": [{"id": s["vless_id"], "flow": "xtls-rprx-vision"}], "decryption": "none"},
            "streamSettings": {"network": "raw", "security": "reality", "realitySettings": {
                "target": f"{REALITY_TARGET}:443", "serverNames": [REALITY_TARGET],
                "privateKey": s["reality_private"], "shortIds": [s["short_id"]]}},
        }],
        "outbounds": [{"protocol": "freedom", "tag": "direct"}, {"protocol": "blackhole", "tag": "blocked"}],
        "routing": {"domainStrategy": "IPOnDemand", "rules": [
            {"type": "field", "outboundTag": "blocked", "domain": [f"full:{h}" for h in METADATA_HOSTS]},
            {"type": "field", "outboundTag": "blocked", "ip": PRIVATE}]},
    }, xray_group)
    # JSON is valid YAML; Hysteria reads it as its YAML config.
    write("/etc/hysteria/config.yaml", {
        "listen": ":443",
        "tls": {"cert": str(cert), "key": str(key)},
        "auth": {"type": "password", "password": s["hy2_password"]},
        "masquerade": {"type": "proxy", "proxy": {"url": HY2_MASQUERADE, "rewriteHost": True}},
        "acl": {"inline": [f"reject({h})" for h in METADATA_HOSTS] + [f"reject({c})" for c in PRIVATE] + ["direct(all)"]},
    }, "hysteria")
    server = external_ip()
    # HY2 first: fallback groups try nodes in this order, and QUIC copes better with the path's loss.
    nodes = [
        {"name": f"{LABEL} · HY2", "type": "hysteria2", "server": server, "port": 443, "ports": HOP_PORTS,
         "hop-interval": 30, "password": s["hy2_password"], "sni": HY2_SNI, "fingerprint": fingerprint,
         "skip-cert-verify": False, "alpn": ["h3"], "up": f"{HY2_UP_MBPS} Mbps", "down": f"{HY2_DOWN_MBPS} Mbps"},
        {"name": f"{LABEL} · Reality", "type": "vless", "server": server, "port": 443, "uuid": s["vless_id"],
         "network": "tcp", "tls": True, "udp": True, "flow": "xtls-rprx-vision", "packet-encoding": "xudp",
         "servername": REALITY_TARGET, "client-fingerprint": "chrome",
         # The target negotiates X25519MLKEM768; without it Mihomo fails REALITY authentication.
         "reality-opts": {"public-key": s["reality_public"], "short-id": s["short_id"], "support-x25519mlkem768": True}},
    ]
    write(STATE / "client.json", nodes, "root", 0o600)


if __name__ == "__main__":
    main(sys.argv[1])
