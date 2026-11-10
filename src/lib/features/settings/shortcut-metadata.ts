import { m } from '#lib/paraglide/messages.js';

export type ShortcutGroup = {
	name: string;
	items: { action: string; keys: string[] }[];
};

/** The keyboard shortcuts the app ships, by area. Settings renders them; nothing else owns the list. */
export function shortcutGroups(): ShortcutGroup[] {
	return [
		{
			name: m.settings_shortcuts_records(),
			items: [
				{ action: m.settings_shortcuts_close_record(), keys: ['Esc'] },
				{ action: m.settings_shortcuts_save_note(), keys: ['⌘', '↵'] },
				{ action: m.settings_shortcuts_cancel_note(), keys: ['Esc'] }
			]
		},
		{
			name: m.settings_shortcuts_mapping(),
			items: [
				{ action: m.settings_shortcuts_pan(), keys: ['←', '↑', '→', '↓'] },
				{ action: m.settings_shortcuts_pan_further(), keys: ['⇧', '←↑→↓'] },
				{ action: m.settings_shortcuts_zoom(), keys: ['+', '−'] },
				{ action: m.settings_shortcuts_select_worker(), keys: ['↵'] },
				{ action: m.settings_shortcuts_clear_selection(), keys: ['Esc'] }
			]
		},
		{
			name: m.settings_shortcuts_configuration(),
			items: [
				{ action: m.settings_shortcuts_commit(), keys: ['↵'] },
				{ action: m.settings_shortcuts_cancel_edit(), keys: ['Esc'] },
				{ action: m.settings_shortcuts_remove_last(), keys: ['⌫'] }
			]
		}
	];
}
