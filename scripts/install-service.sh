#!/usr/bin/env bash
set -euo pipefail

# Run via `mise run service:install`, which exports the shipment first.
project_dir=$(dirname "$(dirname "$(realpath "$0")")")
shipment="$project_dir/build/erlang-shipment"
data_dir="$HOME/.local/share/herdr-web"
unit_dir="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"

if [[ ! -f "$shipment/entrypoint.sh" ]]; then
  printf 'Build the shipment first: mise run export\n' >&2
  exit 1
fi

erlang_dir=$(mise -C "$project_dir" where erlang)
herdr_executable=$(command -v herdr) || {
  printf 'Install Herdr and make its executable available on PATH first.\n' >&2
  exit 1
}
herdr_dir=$(dirname "$herdr_executable")

# Each install is a separate snapshot. Development builds and future installs
# cannot modify code loaded by a running service.
mkdir -p "$data_dir/releases" "$unit_dir"
release=$(mktemp -d "$data_dir/releases/release.XXXXXXXX")
cp -R "$shipment/." "$release/"

# systemd does not load interactive shell configuration or mise shims.
# Persist the resolved runtime locations, not the entire development environment.
runtime_path="$erlang_dir/bin:$herdr_dir:/usr/local/bin:/usr/bin:/bin"
runtime_path=${runtime_path//\\/\\\\}
runtime_path=${runtime_path//\"/\\\"}
printf 'PATH="%s"\n' "$runtime_path" > "$release/runtime.env"

install -m 644 "$project_dir/deploy/herdr-web.service" "$unit_dir/herdr-web.service"
ln -s "$release" "$release.link"
mv -Tf "$release.link" "$data_dir/current"
systemctl --user daemon-reload

printf 'Installed release: %s\n' "$release"
printf 'First start: mise run service:start\n'
printf 'Apply an update: systemctl --user restart herdr-web.service\n'
