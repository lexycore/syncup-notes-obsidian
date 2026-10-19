import { App, PluginSettingTab, Setting } from "obsidian";
import type SyncUpNotesPlugin from "./main";
import type { BaselineEntry } from "./plan";

export interface SyncUpSettings {
	server: string;
	username: string;
	password: string;
	folder: string;
	intervalMinutes: number;
	syncOnStartup: boolean;
	syncOnSave: boolean;
	baseline: Record<string, BaselineEntry>;
}

export const DEFAULT_SETTINGS: SyncUpSettings = {
	server: "https://syncup.ru/webdav/",
	username: "",
	password: "",
	folder: "",
	intervalMinutes: 1,
	syncOnStartup: true,
	syncOnSave: true,
	baseline: {},
};

export class SyncUpSettingTab extends PluginSettingTab {
	private readonly plugin: SyncUpNotesPlugin;

	constructor(app: App, plugin: SyncUpNotesPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		new Setting(containerEl)
			.setName("Server")
			.setDesc("WebDAV address of the SyncUp vault.")
			.addText((text) => text.setPlaceholder(DEFAULT_SETTINGS.server).setValue(this.plugin.settings.server).onChange(async (value) => {
				this.plugin.settings.server = value.trim() || DEFAULT_SETTINGS.server;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Email")
			.setDesc("The SyncUp account email.")
			.addText((text) => text.setPlaceholder("you@example.com").setValue(this.plugin.settings.username).onChange(async (value) => {
				this.plugin.settings.username = value.trim();
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Application password")
			.setDesc("The password shown once when WebDAV is turned on. It stays on this device.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.password).onChange(async (value) => {
					this.plugin.settings.password = value;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("Remote folder")
			.setDesc("Server folder this vault mirrors. Leave it empty only when the vault is the whole WebDAV root.")
			.addText((text) => text.setPlaceholder("folder").setValue(this.plugin.settings.folder).onChange(async (value) => {
				this.plugin.settings.folder = cleanFolder(value);
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Sync every")
			.setDesc("Minutes between syncs while Obsidian is open. 0 turns the timer off.")
			.addText((text) => text.setValue(String(this.plugin.settings.intervalMinutes)).onChange(async (value) => {
				const minutes = Number(value);
				this.plugin.settings.intervalMinutes = Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Sync on startup")
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.syncOnStartup).onChange(async (value) => {
				this.plugin.settings.syncOnStartup = value;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Sync on save")
			.addToggle((toggle) => toggle.setValue(this.plugin.settings.syncOnSave).onChange(async (value) => {
				this.plugin.settings.syncOnSave = value;
				await this.plugin.saveSettings();
			}));
		new Setting(containerEl)
			.setName("Sync now")
			.addButton((button) => button.setButtonText("Sync").setCta().onClick(() => void this.plugin.sync()));
	}
}

export function cleanFolder(value: string): string {
	return value.split("/").map((part) => part.trim()).filter((part) => part && part !== "." && part !== "..").join("/");
}
