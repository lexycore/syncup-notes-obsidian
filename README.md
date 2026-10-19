# SyncUp Notes

Obsidian plugin that syncs a vault with [SyncUp](https://syncup.ru) over WebDAV. The id is `syncup-notes`.

Files in `.obsidian`, `.git`, and `node_modules` stay on the device. A file larger than 64 MB is skipped and named in the status bar. Sync runs while Obsidian is open: on startup, about two seconds after a save, and once a minute.

The open note and expanded folders are stored in `.syncup/view.json` and shared with the SyncUp Notes page. That folder is hidden in the file explorer. The web page picks up vault changes within a few seconds. Obsidian picks up a change made on the web on the next sync.

## Desktop

```sh
npm install
npm test
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/syncup-notes/`. Reload Obsidian, turn off Restricted mode, and enable SyncUp Notes.

A merge to `main` pushes this repo to [lexycore/syncup-notes-obsidian](https://github.com/lexycore/syncup-notes-obsidian) and, the first time that `manifest.json` version is seen, publishes a GitHub release of `main.js`, `manifest.json`, and `styles.css`. The GitLab variable `GITHUB_TOKEN` needs contents write on that repo. Add the new version to `versions.json` in the same change.

Settings: server `https://syncup.ru/webdav/`, the account email, the application password from the SyncUp Notes page, and the remote folder if this vault already lives in one.

## iPhone, iPad, and Android

Install BRAT from Community plugins. Run **Plugins: Add a beta plugin for testing** and point it at `lexycore/syncup-notes-obsidian`. Enable SyncUp Notes and enter the same settings.

Opening Obsidian runs a sync. The phone does not keep syncing after you leave the app.
