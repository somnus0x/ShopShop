#!/usr/bin/env python3
"""Save the tunnel runtime key from a private terminal prompt."""
from getpass import getpass
from pathlib import Path
import os
import sys

if not sys.stdin.isatty():
    raise SystemExit("Run this script in your local Terminal so the key stays hidden.")

destination = Path(__file__).resolve().parents[1] / ".data" / "tunnel-runtime-key"
destination.parent.mkdir(mode=0o700, exist_ok=True)
if destination.exists():
    raise SystemExit("A runtime key is already saved. Ask to rotate it if needed.")

key = getpass("Paste the tunnel runtime API key (hidden), then press Return: ").strip()
if not key.startswith("sk-") or any(c.isspace() for c in key):
    raise SystemExit("That does not look like an OpenAI API key. Nothing was saved.")

fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
with os.fdopen(fd, "w") as output:
    output.write(key + "\n")
del key
print("Runtime key saved privately. Return to ChatGPT and say: key saved.")
