#!/usr/bin/env bash
# Installs the OmaSwitch Tabs native messaging host for every Chromium-based
# browser found (Edge, Chrome, Chromium, Brave). Safe to re-run.
set -euo pipefail

here="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
host_name="com.apuyana.omaswitch_tabs"
extension_id="mphgidpkjniiknflkklakckkdbfnihag"
bin_dir="$HOME/.local/bin"
host_path="$bin_dir/omaswitch-tab-host"

mkdir -p "$bin_dir"
install -m 755 "$here/omaswitch-tab-host" "$host_path"

manifest=$(cat <<EOF
{
  "name": "$host_name",
  "description": "OmaSwitch Tabs bridge for the Alt+Tab switcher",
  "path": "$host_path",
  "type": "stdio",
  "allowed_origins": ["chrome-extension://$extension_id/"]
}
EOF
)

installed=0
for profile_dir in microsoft-edge google-chrome chromium BraveSoftware/Brave-Browser; do
  base="$HOME/.config/$profile_dir"
  [[ -d $base ]] || continue
  mkdir -p "$base/NativeMessagingHosts"
  printf '%s\n' "$manifest" > "$base/NativeMessagingHosts/$host_name.json"
  echo "Host registered for $profile_dir"
  installed=1
done

(( installed )) || echo "No Chromium-based browser profile found under ~/.config."

# File pickers hide ~/.config; expose the extension at a visible path.
visible="$HOME/Extensions/omaswitch-tabs"
mkdir -p "$HOME/Extensions"
ln -sfn "$here/extension" "$visible"

cat <<EOF

Last step (once per browser): open edge://extensions or chrome://extensions,
turn on Developer mode, click "Load unpacked" and pick:
  $visible
The extension id should be $extension_id.
EOF
