#!/usr/bin/env bash
# Download the fastroute autorouter (https://github.com/parisxmas/fastroute, GPL-3.0)
# for this platform into vendor/fastroute/, where pcb_autoroute finds it.
#   bash scripts/install-fastroute.sh            # pinned version
#   FASTROUTE_VERSION=0.1.15 bash scripts/install-fastroute.sh
# The release checksum is verified before anything is unpacked.
set -euo pipefail

VERSION="${FASTROUTE_VERSION:-0.1.14}"
REPO="parisxmas/fastroute"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/vendor/fastroute"

case "$(uname -s)" in
	Darwin) os=macos ;;
	Linux) os=linux ;;
	*) echo "Unsupported OS $(uname -s). On Windows download fastroute-$VERSION-windows-x64.zip from https://github.com/$REPO/releases and set FASTROUTE_BIN." >&2; exit 1 ;;
esac
case "$(uname -m)" in
	arm64|aarch64) arch=arm64 ;;
	x86_64|amd64) arch=x64 ;;
	*) echo "Unsupported CPU $(uname -m)" >&2; exit 1 ;;
esac

asset="fastroute-$VERSION-$os-$arch.tar.gz"
base="https://github.com/$REPO/releases/download/v$VERSION"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "Downloading $asset"
curl -fsSL -o "$tmp/$asset" "$base/$asset"
curl -fsSL -o "$tmp/SHA256SUMS.txt" "$base/SHA256SUMS.txt"

expected="$(awk -v a="$asset" '$2 == a || $2 == "*"a {print $1}' "$tmp/SHA256SUMS.txt")"
actual="$(shasum -a 256 "$tmp/$asset" 2>/dev/null | awk '{print $1}' || sha256sum "$tmp/$asset" | awk '{print $1}')"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
	echo "Checksum mismatch for $asset (expected '${expected:-none}', got '$actual'); nothing installed." >&2
	exit 1
fi

mkdir -p "$tmp/x"
tar -xzf "$tmp/$asset" -C "$tmp/x"
bin="$(find "$tmp/x" -type f -name fastroute | head -n 1)"
[ -n "$bin" ] || { echo "No fastroute binary in $asset" >&2; exit 1; }

rm -rf "$DEST"
mkdir -p "$DEST"
cp "$bin" "$DEST/fastroute"
for f in LICENSE NOTICE; do
	src="$(find "$tmp/x" -type f -name "$f" | head -n 1)"
	[ -n "$src" ] && cp "$src" "$DEST/$f"
done
chmod +x "$DEST/fastroute"
# The release binaries are not code-signed; clear the download quarantine so macOS runs it.
if [ "$os" = macos ]; then xattr -d com.apple.quarantine "$DEST/fastroute" 2>/dev/null || true; fi

"$DEST/fastroute" --version
echo "Installed to $DEST/fastroute"
