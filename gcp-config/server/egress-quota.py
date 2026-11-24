#!/usr/bin/python3
# Monthly Internet egress cap for the GCP proxy VM, enforced by an nftables named quota.
# Google bills Standard Tier egress per calendar month in Pacific time; the cap resets on that boundary.
# Quota is granted in blocks that are written to disk before the kernel may spend them, so a crash or
# reboot can only under-use the month, never exceed it.
#   gcp-egress-quota          enforce (run by a 10 s systemd timer)
#   gcp-egress-quota report   print {"month", "used", "total"} for the subscription usage header

import json
import os
import subprocess
import sys
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

GIB = 1024**3
MONTHLY_LIMIT = int(os.environ.get("EGRESS_LIMIT_GIB", "260")) * GIB
GRANT = 4 * GIB
# Renew while 1 GiB remains: a 10 s timer then keeps up with ~800 Mbit/s without stalling.
RENEW_BELOW = 1 * GIB
TABLE = "gcp_egress"
NFT = "/usr/sbin/nft"
STATE_DIR = Path(os.environ.get("STATE_DIRECTORY", "/var/lib/gcp-egress-quota"))
STATE_FILE = STATE_DIR / "quota.json"


def billing_month():
    return datetime.now(ZoneInfo("America/Los_Angeles")).strftime("%Y-%m")


def live_quota():
    tables = json.loads(subprocess.check_output([NFT, "-j", "list", "tables"], text=True))["nftables"]
    if not any(entry.get("table", {}).get("name") == TABLE for entry in tables):
        return None
    output = subprocess.check_output([NFT, "-j", "list", "quota", "inet", TABLE, "monthly"], text=True)
    return next(entry["quota"] for entry in json.loads(output)["nftables"] if "quota" in entry)


def load_state():
    if not STATE_FILE.exists():
        return None
    saved = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    reserved = saved.get("reserved_bytes")
    # Validated on its own: a reservation made under a higher cap stays valid after the cap is lowered.
    if type(reserved) is not int or reserved < 0 or not isinstance(saved.get("month"), str):
        raise RuntimeError("Persistent quota state is invalid")
    return saved


def save_grant(month, limit):
    pending = STATE_FILE.with_suffix(".pending")
    with pending.open("w", encoding="utf-8") as stream:
        json.dump({"month": month, "reserved_bytes": limit}, stream)
        stream.flush()
        os.fsync(stream.fileno())
    pending.replace(STATE_FILE)
    parent_fd = os.open(STATE_DIR, os.O_DIRECTORY)
    try:
        os.fsync(parent_fd)
    finally:
        os.close(parent_fd)


def install_quota(limit, used):
    # Metadata, DHCP and SSH replies stay exempt so the VM remains manageable after the cap is hit.
    rules = f"""
destroy table inet {TABLE}
table inet {TABLE} {{
    quota monthly {{
        over {limit} bytes used {used} bytes
    }}
    chain output {{
        type filter hook output priority 100; policy accept;
        oifname "lo" return
        ip daddr 169.254.169.254 return
        udp sport 68 udp dport 67 return
        tcp sport 22 return
        quota name "monthly" counter drop
    }}
}}
"""
    subprocess.run([NFT, "-f", "-"], input=rules, text=True, check=True)


def enforce():
    month = billing_month()
    live = live_quota()
    saved = load_state()
    if saved is None:
        if live is not None:
            raise RuntimeError("Persistent quota state is missing")
        saved = {"month": month, "reserved_bytes": 0}
    if saved["month"] > month:
        raise RuntimeError("Clock precedes the recorded billing month")

    if saved["month"] != month:
        reserved, used = 0, 0
    else:
        reserved = saved["reserved_bytes"]
        if live and live["bytes"] == reserved:
            if reserved == MONTHLY_LIMIT or (reserved < MONTHLY_LIMIT and reserved - live.get("used", 0) > RENEW_BELOW):
                return
        # The live counter is exact; without one (after boot) the whole reserved block counts as spent.
        used = live.get("used", 0) if live else reserved

    # Above a lowered cap this shrinks the grant to the cap; spent bytes stay counted, so it blocks at once.
    limit = min(MONTHLY_LIMIT, reserved + GRANT)
    save_grant(month, limit)
    install_quota(limit, min(used, limit))
    print(f"<5>{month}: reserved {limit / GIB:.0f}/{MONTHLY_LIMIT // GIB} GiB, used {used / GIB:.2f} GiB", flush=True)


def report():
    saved = load_state()
    live = live_quota()
    month = billing_month()
    if saved is None or saved["month"] != month:
        used = 0
    else:
        used = live.get("used", 0) if live else saved["reserved_bytes"]
    print(json.dumps({"month": month, "used": min(used, MONTHLY_LIMIT), "total": MONTHLY_LIMIT}))


if __name__ == "__main__":
    report() if sys.argv[1:] == ["report"] else enforce()
