#!/usr/bin/env python3
"""Upload tracked repository files to the server over FTPS/FTP.

Reads credentials from .deploy.env (gitignored) next to the repository root:

    DEPLOY_HOST=ftp.example.com
    DEPLOY_USER=username
    DEPLOY_PASS=secret
    DEPLOY_DIR=/greenly          # remote application root (NOT the document root)
    DEPLOY_TLS=1                 # 1 = FTPS (explicit TLS, default), 0 = plain FTP

Only `git ls-files` are uploaded, so config.js, data/ and node_modules/ never leave your machine.
After the first upload you still need, in Plesk: Node.js app setup, NPM install, config.js — see DEPLOY.md.

Usage:  python3 scripts/deploy.py [--dry-run]
"""
import ftplib
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ENV_FILE = ROOT / ".deploy.env"


def load_env():
    if not ENV_FILE.exists():
        sys.exit(f"Missing {ENV_FILE}. Copy .deploy.env.example and fill it in.")
    env = {}
    for line in ENV_FILE.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip("'\"")
    for key in ("DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_PASS", "DEPLOY_DIR"):
        if not env.get(key):
            sys.exit(f".deploy.env: {key} is required")
    return env


def tracked_files():
    out = subprocess.check_output(["git", "ls-files"], cwd=ROOT, text=True)
    return [Path(p) for p in out.split("\n") if p]


def ensure_dir(ftp, remote_dir):
    """mkdir -p over FTP."""
    parts = [p for p in remote_dir.split("/") if p]
    path = ""
    for part in parts:
        path += "/" + part
        try:
            ftp.mkd(path)
        except ftplib.error_perm:
            pass  # already exists


def main():
    dry = "--dry-run" in sys.argv
    env = load_env()
    files = tracked_files()
    print(f"{len(files)} tracked files → {env['DEPLOY_HOST']}:{env['DEPLOY_DIR']}" + (" (dry run)" if dry else ""))

    if dry:
        for f in files:
            print("  ", f)
        return

    if env.get("DEPLOY_TLS", "1") != "0":
        ftp = ftplib.FTP_TLS(env["DEPLOY_HOST"], timeout=30)
        ftp.login(env["DEPLOY_USER"], env["DEPLOY_PASS"])
        ftp.prot_p()
    else:
        ftp = ftplib.FTP(env["DEPLOY_HOST"], timeout=30)
        ftp.login(env["DEPLOY_USER"], env["DEPLOY_PASS"])

    base = env["DEPLOY_DIR"].rstrip("/")
    ensure_dir(ftp, base)
    ensure_dir(ftp, f"{base}/data")  # SQLite + photos live here; keep it even though it's empty in git
    made = set()
    for f in files:
        remote = f"{base}/{f.as_posix()}"
        remote_dir = remote.rsplit("/", 1)[0]
        if remote_dir not in made:
            ensure_dir(ftp, remote_dir)
            made.add(remote_dir)
        with open(ROOT / f, "rb") as fh:
            ftp.storbinary(f"STOR {remote}", fh)
        print("  up", f)
    ftp.quit()
    print("done. Next in Plesk: Node.js app → NPM install → config.js → Restart (DEPLOY.md §2–3).")


if __name__ == "__main__":
    main()
