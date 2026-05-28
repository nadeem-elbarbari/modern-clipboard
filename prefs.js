import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import GObject from 'gi://GObject';
import { ExtensionPreferences } from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ShortcutRecorderRow = GObject.registerClass({
    GTypeName: 'ShortcutRecorderRow',
}, class ShortcutRecorderRow extends Adw.ActionRow {
    _init(settings, key) {
        super._init({
            title: 'Show Clipboard History',
            subtitle: 'Click the button to record a new shortcut',
        });

        this._settings = settings;
        this._key = key;

        this._button = new Gtk.Button({
            valign: Gtk.Align.CENTER,
        });

        this._shortcutLabel = new Gtk.ShortcutLabel({
            disabled_text: 'Disabled',
        });
        this._button.set_child(this._shortcutLabel);

        this.add_suffix(this._button);
        this.activatable_widget = this._button;

        this._updateLabel();

        this._button.connect('clicked', () => this._record());

        this._settings.connect(`changed::${this._key}`, () => this._updateLabel());
    }

    _updateLabel() {
        const value = this._settings.get_strv(this._key)[0];
        this._shortcutLabel.accelerator = value || '';
    }

    _record() {
        const dialog = new Adw.MessageDialog({
            heading: 'Record Shortcut',
            body: 'Press a new shortcut combination...\nPress <Esc> to cancel or <BackSpace> to clear.',
            transient_for: this.get_root(),
            modal: true,
        });

        dialog.add_response('cancel', 'Cancel');
        dialog.connect('response', () => dialog.close());

        const controller = new Gtk.EventControllerKey();
        controller.connect('key-pressed', (c, keyval, keycode, state) => {
            let mask = state & Gtk.accelerator_get_default_mod_mask();
            mask &= ~Gdk.ModifierType.LOCK_MASK;

            if (keyval === Gdk.KEY_Escape) {
                dialog.close();
                return true;
            }
            if (keyval === Gdk.KEY_BackSpace) {
                this._settings.set_strv(this._key, ['']);
                dialog.close();
                return true;
            }

            if (Gtk.accelerator_valid(keyval, mask) || (keyval === Gdk.KEY_Tab || keyval === Gdk.KEY_ISO_Left_Tab)) {
                const accel = Gtk.accelerator_name(keyval, mask);
                this._settings.set_strv(this._key, [accel]);
                dialog.close();
                return true;
            }
            return false;
        });
        dialog.add_controller(controller);
        dialog.present();
    }
});

export default class ClipboardHistoryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage();
        const group = new Adw.PreferencesGroup({
            title: 'General',
        });
        page.add(group);

        // Shortcut row
        const shortcutRow = new ShortcutRecorderRow(settings, 'history-shortcut');
        group.add(shortcutRow);

        // History Size row
        const sizeRow = new Adw.ActionRow({
            title: 'History Size',
            subtitle: 'Maximum number of items to keep in history',
        });

        const sizeSpinButton = new Gtk.SpinButton({
            adjustment: new Gtk.Adjustment({
                lower: 5,
                upper: 100,
                step_increment: 1,
            }),
            valign: Gtk.Align.CENTER,
        });
        settings.bind('history-size', sizeSpinButton, 'value', Gio.SettingsBindFlags.DEFAULT);

        sizeRow.add_suffix(sizeSpinButton);
        sizeRow.activatable_widget = sizeSpinButton;
        group.add(sizeRow);

        // Persist History row
        const persistRow = new Adw.ActionRow({
            title: 'Persist History',
            subtitle: 'Save clipboard history to disk across reboots',
        });

        const persistSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
        });
        settings.bind('persist-history', persistSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);

        persistRow.add_suffix(persistSwitch);
        persistRow.activatable_widget = persistSwitch;
        group.add(persistRow);

        // Trim Whitespaces row
        const trimRow = new Adw.ActionRow({
            title: 'Trim Whitespaces',
            subtitle: 'Trim whitespaces at the beginning and end of copied text',
        });

        const trimSwitch = new Gtk.Switch({
            valign: Gtk.Align.CENTER,
        });
        settings.bind('trim-whitespaces', trimSwitch, 'active', Gio.SettingsBindFlags.DEFAULT);

        trimRow.add_suffix(trimSwitch);
        trimRow.activatable_widget = trimSwitch;
        group.add(trimRow);

        // Clear History row
        const clearHistoryRow = new Adw.ActionRow({
            title: 'Clear History',
            subtitle: 'Delete all saved clipboard history',
        });

        const clearHistoryBtn = new Gtk.Button({
            label: 'Clear History',
            valign: Gtk.Align.CENTER,
        });
        clearHistoryBtn.add_css_class('destructive-action');

        clearHistoryBtn.connect('clicked', () => {
            const dialog = new Adw.MessageDialog({
                heading: 'Clear Clipboard History',
                body: 'Are you sure you want to delete all clipboard history? This action cannot be undone.',
                transient_for: window,
                modal: true,
            });
            dialog.add_response('cancel', 'Cancel');
            dialog.add_response('clear', 'Clear History');
            dialog.set_response_appearance('clear', Adw.ResponseAppearance.DESTRUCTIVE);

            dialog.connect('response', (d, response) => {
                if (response === 'clear') {
                    settings.set_boolean('clear-history', !settings.get_boolean('clear-history'));
                }
                d.close();
            });
            dialog.present();
        });

        clearHistoryRow.add_suffix(clearHistoryBtn);
        clearHistoryRow.activatable_widget = clearHistoryBtn;
        group.add(clearHistoryRow);

        window.add(page);
    }
}
