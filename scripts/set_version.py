#!/usr/bin/env python3
"""Synchronize Jelopathy package versions with a release tag (for example v1.2.3)."""
from __future__ import annotations
import json
import pathlib
import re
import sys

if len(sys.argv) != 2:
    raise SystemExit("Usage: python scripts/set_version.py VERSION")
version = sys.argv[1].removeprefix("v").strip()
if not re.fullmatch(r"\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?", version):
    raise SystemExit(f"Invalid semantic version: {version!r}")
root = pathlib.Path(__file__).resolve().parents[1]

for name in ("package.json", "package-lock.json", "src-tauri/tauri.conf.json"):
    path = root / name
    data = json.loads(path.read_text(encoding="utf-8"))
    data["version"] = version
    if name == "package-lock.json" and isinstance(data.get("packages"), dict) and isinstance(data["packages"].get(""), dict):
        data["packages"][""]["version"] = version
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")

cargo_toml = root / "src-tauri/Cargo.toml"
cargo_text = cargo_toml.read_text(encoding="utf-8")
# Update only the package version immediately following [package].
cargo_text, count = re.subn(r"(?s)(\[package\].*?^version\s*=\s*)\"[^\"]+\"", lambda m: m.group(1) + f'"{version}"', cargo_text, count=1, flags=re.MULTILINE)
if count != 1:
    raise SystemExit("Could not find [package] version in src-tauri/Cargo.toml")
cargo_toml.write_text(cargo_text, encoding="utf-8")

lock_path = root / "src-tauri/Cargo.lock"
if lock_path.exists():
    lock_text = lock_path.read_text(encoding="utf-8")
    pattern = r'(?s)(\[\[package\]\]\s*\nname\s*=\s*"jelopathy"\s*\nversion\s*=\s*)"[^"]+"'
    lock_text, lock_count = re.subn(pattern, lambda m: m.group(1) + f'"{version}"', lock_text, count=1)
    if lock_count == 1:
        lock_path.write_text(lock_text, encoding="utf-8")
print(f"Jelopathy version set to {version}")
