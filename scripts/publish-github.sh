#!/bin/sh
set -eu

repo="lexycore/syncup-notes-obsidian"

if [ -z "${GITHUB_TOKEN:-}" ]; then
	echo "Set GITHUB_TOKEN in GitLab CI/CD variables. It needs contents write on ${repo}." >&2
	exit 1
fi

version=$(node -e "process.stdout.write(require('./manifest.json').version)")
min_app=$(node -e "process.stdout.write(require('./manifest.json').minAppVersion)")

node - "$version" "$min_app" <<'JS'
const fs = require("fs");
const [version, minApp] = process.argv.slice(2);
const known = JSON.parse(fs.readFileSync("versions.json", "utf8"));
if (known[version] !== minApp) {
	console.error(`Add "${version}": "${minApp}" to versions.json`);
	process.exit(1);
}
JS

for file in main.js manifest.json styles.css; do
	if [ ! -f "$file" ]; then
		echo "Missing ${file}. Run npm run build first." >&2
		exit 1
	fi
done

export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0=safe.directory
export GIT_CONFIG_VALUE_0='*'
export GH_TOKEN="$GITHUB_TOKEN"

echo "Pushing ${version} to github.com/${repo}"
git push --force "https://x-access-token:${GITHUB_TOKEN}@github.com/${repo}.git" HEAD:refs/heads/main

if gh release view "$version" --repo "$repo" >/dev/null 2>&1; then
	echo "GitHub release ${version} already exists"
else
	gh release create "$version" --repo "$repo" --title "$version" --notes "SyncUp Notes ${version}" \
		main.js manifest.json styles.css
	echo "Created GitHub release ${version}"
fi
