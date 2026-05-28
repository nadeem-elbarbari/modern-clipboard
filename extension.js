import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import St from 'gi://St';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import {ClipboardMonitor} from './clipboardMonitor.js';

// ─── Floating Popup (does NOT steal focus from the active window) ───
const ClipboardPopup = GObject.registerClass(
    {GTypeName: 'ClipboardHistoryPopup'},
    class ClipboardPopup extends St.Widget {
        _init(history, selectCallback, deleteCallback, clearCallback, pinCallback) {
            super._init({
                style_class: 'clipboard-popup',
                layout_manager: new Clutter.BinLayout(),
                reactive: true,
            });

            this._selectCallback = selectCallback;
            this._deleteCallback = deleteCallback;
            this._clearCallback = clearCallback;
            this._pinCallback = pinCallback;

            const mainBox = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                y_expand: true,
            });

            const headerBox = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'clipboard-header',
            });

            const titleLabel = new St.Label({
                text: 'Clipboard History',
                x_expand: true,
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'clipboard-title',
            });

            this._clearBtn = new St.Button({
                child: new St.Icon({icon_name: 'user-trash-symbolic', icon_size: 14}),
                can_focus: true,
                style_class: 'clipboard-clear-btn',
                y_align: Clutter.ActorAlign.CENTER,
            });

            this._clearBtn.connect('clicked', () => {
                if (this._clearCallback) {
                    this._clearCallback();
                }
            });

            headerBox.add_child(titleLabel);
            headerBox.add_child(this._clearBtn);

            const scroll = new St.ScrollView({
                hscrollbar_policy: St.PolicyType.NEVER,
                vscrollbar_policy: St.PolicyType.AUTOMATIC,
                style_class: 'clipboard-scroll',
            });

            this._list = new St.BoxLayout({
                vertical: true,
                x_expand: true,
                style_class: 'clipboard-list',
            });

            this.populate(history);

            scroll.set_child(this._list);
            
            mainBox.add_child(headerBox);
            mainBox.add_child(scroll);

            this.add_child(mainBox);
        }

        populate(history) {
            this._list.destroy_all_children();

            if (history.length === 0) {
                const emptyLabel = new St.Label({
                    text: 'Clipboard is empty',
                    style_class: 'clipboard-empty',
                });
                this._list.add_child(emptyLabel);
                this._clearBtn.hide();
            } else {
                this._clearBtn.show();
                history.forEach((item, index) => this._addRow(item, index));
            }
        }

        _addRow(item, index) {
            const row = new St.BoxLayout({
                vertical: false,
                x_expand: true,
                style_class: 'clipboard-row',
            });

            // ── Resolve type metadata ──────────────────────────────────
            let preview, iconName, badgeClass, typeLabel;

            if (item.type === 'text') {
                preview = item.content.trim().replace(/\n/g, ' ');
                if (preview.length > 48) preview = preview.substring(0, 48) + '…';
                iconName  = 'edit-copy-symbolic';
                badgeClass = 'type-badge-text';
                typeLabel  = 'TEXT';
            } else if (item.type === 'files') {
                const lines = item.content.trim().split('\n');
                const uris  = lines.filter(l => l.startsWith('file://'));
                let isSingleImage = false;
                if (uris.length === 1) {
                    let name = uris[0].split('/').pop();
                    try {
                        name = decodeURIComponent(name);
                    } catch (e) {}
                    preview = name.length > 44 ? name.substring(0, 44) + '…' : name;
                    const lowerName = name.toLowerCase();
                    if (lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || 
                        lowerName.endsWith('.jpeg') || lowerName.endsWith('.gif') || 
                        lowerName.endsWith('.svg') || lowerName.endsWith('.webp')) {
                        isSingleImage = true;
                    }
                } else {
                    preview = `${uris.length} files`;
                }
                if (item.operation === 'cut') {
                    iconName   = 'edit-cut-symbolic';
                    badgeClass = 'type-badge-cut';
                    typeLabel  = 'CUT';
                } else if (isSingleImage) {
                    iconName   = 'image-x-generic-symbolic';
                    badgeClass = 'type-badge-image';
                    typeLabel  = 'IMG';
                } else {
                    iconName   = 'edit-copy-symbolic';
                    badgeClass = 'type-badge-copy';
                    typeLabel  = 'COPY';
                }
            } else if (item.type === 'image') {
                preview    = 'Copied image';
                iconName   = 'image-x-generic-symbolic';
                badgeClass = 'type-badge-image';
                typeLabel  = 'IMG';
            } else {
                preview    = '[Unknown]';
                iconName   = 'dialog-question-symbolic';
                badgeClass = 'type-badge-unknown';
                typeLabel  = '?';
            }

            // ── Select button ──────────────────────────────────────────
            const btn = new St.Button({
                x_expand: true,
                can_focus: true,
                style_class: 'clipboard-item-btn',
            });
            const btnBox = new St.BoxLayout({vertical: false, x_expand: true});

            // ── Type badge (icon + short label pill) ───────────────────
            const badge = new St.BoxLayout({
                vertical: false,
                style_class: `type-badge ${badgeClass}`,
                y_align: Clutter.ActorAlign.CENTER,
            });
            badge.add_child(new St.Icon({
                icon_name: iconName,
                icon_size: 12,
                style_class: 'type-badge-icon',
            }));
            badge.add_child(new St.Label({
                text: typeLabel,
                style_class: 'type-badge-label',
                y_align: Clutter.ActorAlign.CENTER,
            }));
            btnBox.add_child(badge);

            // ── Preview text ───────────────────────────────────────────
            btnBox.add_child(new St.Label({
                text: preview,
                y_align: Clutter.ActorAlign.CENTER,
                x_expand: true,
                style_class: 'clipboard-item-label',
            }));
            btn.set_child(btnBox);
            btn.connect('clicked', () => this._selectCallback(item));

            // ── Pin button ──────────────────────────────────────────
            const pinBtn = new St.Button({
                child: new St.Icon({
                    icon_name: item.pinned ? 'starred-symbolic' : 'non-starred-symbolic', 
                    icon_size: 14
                }),
                can_focus: true,
                style_class: item.pinned ? 'clipboard-pin-btn pinned' : 'clipboard-pin-btn',
            });
            pinBtn.visible = (item.type === 'text');
            pinBtn.connect('clicked', () => {
                this._pinCallback(item);
            });

            // ── Delete button ──────────────────────────────────────────
            const delBtn = new St.Button({
                child: new St.Icon({icon_name: 'edit-delete-symbolic', icon_size: 14}),
                can_focus: true,
                style_class: 'clipboard-delete-btn',
            });
            delBtn.connect('clicked', () => {
                this._deleteCallback(item);
            });

            row.add_child(btn);
            row.add_child(pinBtn);
            row.add_child(delBtn);
            this._list.add_child(row);
        }
    }
);


// ─── Main Extension ─────────────────────────────────────────────────
export default class ClipboardHistoryExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._clipboard = St.Clipboard.get_default();
        this._popup = null;
        this._barrier = null;
        this._barrierClickId = null;
        this._pasteTimeoutId = null;
        this._stageKeyPressId = null;
        this._indicatorClickId = null;

        // Clipboard monitor (owner-changed signal)
        this._monitor = new ClipboardMonitor(this._settings, this.dir.get_path());

        // Virtual keyboard for paste simulation
        try {
            this._virtualDevice = Clutter.get_default_backend()
                .get_default_seat()
                .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        } catch (err) {
            this._virtualDevice = null;
        }

        // Panel indicator button
        this._indicator = new St.Button({
            style_class: 'panel-button',
            reactive: true,
            can_focus: true,
            child: new St.Icon({
                icon_name: 'edit-paste-symbolic',
                style_class: 'system-status-icon',
            }),
        });
        this._indicatorClickId = this._indicator.connect('clicked', () => this._togglePopup(false));
        Main.panel._rightBox.insert_child_at_index(this._indicator, 0);

        // Global keyboard shortcut
        Main.wm.addKeybinding(
            'history-shortcut',
            this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.ALL,
            () => this._togglePopup(true)
        );
    }

    _togglePopup(fromShortcut = false) {
        if (this._popup) {
            this._closePopup();
        } else {
            this._showPopup(fromShortcut);
        }
    }

    _showPopup(fromShortcut) {
        this._closePopup();

        // Full-screen invisible barrier to catch outside clicks
        this._barrier = new Clutter.Actor({
            reactive: true,
            width: 20000,
            height: 20000,
            x: -5000,
            y: -5000,
        });
        this._barrierClickId = this._barrier.connect('button-press-event', () => {
            this._closePopup();
        });
        Main.uiGroup.add_child(this._barrier);

        // Catch ESC key to close popup
        this._stageKeyPressId = global.stage.connect('captured-event', (actor, event) => {
            if (event.type() === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
                this._closePopup();
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        // Build popup
        this._popup = new ClipboardPopup(
            this._monitor.history,
            // ── select callback ──
            (item) => {
                // Tell monitor to skip the next owner-changed (we're setting it ourselves)
                this._monitor.skipNextChange();

                // Set clipboard content with correct MIME type
                if (item.type === 'text') {
                    this._clipboard.set_text(St.ClipboardType.CLIPBOARD, item.content);
                } else if (item.type === 'files') {
                    // Files need x-special/gnome-copied-files MIME type for Nautilus paste
                    const bytes = new GLib.Bytes(new TextEncoder().encode(item.content));
                    this._clipboard.set_content(St.ClipboardType.CLIPBOARD,
                        'x-special/gnome-copied-files', bytes);
                    // Remove file items from history after paste
                    if (!item.pinned) {
                        this._monitor.deleteItem(item);
                    }
                }
                this._closePopup();

                // Simulate Ctrl+V after focus returns
                if (this._virtualDevice) {
                    this._pasteTimeoutId = GLib.timeout_add(
                        GLib.PRIORITY_DEFAULT, 100, () => {
                            this._simulatePaste();
                            this._pasteTimeoutId = null;
                            return GLib.SOURCE_REMOVE;
                        });
                }
            },
            // ── delete callback ──
            (item) => {
                this._monitor.deleteItem(item);
                this._popup.populate(this._monitor.history);
                if (this._monitor.history.length === 0)
                    this._closePopup();
            },
            // ── clear callback ──
            () => {
                this._monitor.clearUnpinned();
                this._popup.populate(this._monitor.history);
                if (this._monitor.history.length === 0)
                    this._closePopup();
            },
            // ── pin callback ──
            (item) => {
                this._monitor.togglePin(item);
                this._popup.populate(this._monitor.history);
            }
        );
        Main.uiGroup.add_child(this._popup);

        // Grab key focus so the shell receives ESC when opened via shortcut
        this._popup.grab_key_focus();

        // Position popup based on how it was opened
        const monitor = Main.layoutManager.primaryMonitor;
        let px, py;
        
        if (fromShortcut) {
            const [cx, cy] = global.get_pointer();
            px = cx;
            py = cy;
        } else {
            const [ix, iy] = this._indicator.get_transformed_position();
            const [iw, ih] = this._indicator.get_transformed_size();
            px = ix + (iw / 2) - 190; // Center popup (assumed ~380 width) relative to indicator
            py = iy + ih + 8; // Slight margin below the panel
        }

        // Keep popup within monitor bounds
        if (px < monitor.x) px = monitor.x + 10;
        if (px + 380 > monitor.x + monitor.width) px = monitor.x + monitor.width - 390;
        if (py < monitor.y) py = monitor.y + 10;
        if (py + 400 > monitor.y + monitor.height) py = monitor.y + monitor.height - 410;

        this._popup.set_position(px, py);
    }

    _closePopup() {
        if (this._barrier) {
            if (this._barrierClickId) {
                this._barrier.disconnect(this._barrierClickId);
                this._barrierClickId = null;
            }
            this._barrier.destroy();
            this._barrier = null;
        }
        if (this._stageKeyPressId) {
            global.stage.disconnect(this._stageKeyPressId);
            this._stageKeyPressId = null;
        }
        if (this._popup) {
            this._popup.destroy();
            this._popup = null;
        }
    }

    _simulatePaste() {
        try {
            // Hardware scancodes: 29 = Ctrl, 47 = V
            this._virtualDevice.notify_key(GLib.get_monotonic_time(), 29, Clutter.KeyState.PRESSED);
            this._virtualDevice.notify_key(GLib.get_monotonic_time(), 47, Clutter.KeyState.PRESSED);
            this._virtualDevice.notify_key(GLib.get_monotonic_time(), 47, Clutter.KeyState.RELEASED);
            this._virtualDevice.notify_key(GLib.get_monotonic_time(), 29, Clutter.KeyState.RELEASED);
        } catch (err) {}
    }

    disable() {
        Main.wm.removeKeybinding('history-shortcut');

        if (this._pasteTimeoutId) {
            GLib.Source.remove(this._pasteTimeoutId);
            this._pasteTimeoutId = null;
        }

        this._closePopup();

        if (this._monitor) {
            this._monitor.destroy();
            this._monitor = null;
        }

        if (this._indicatorClickId) {
            this._indicator.disconnect(this._indicatorClickId);
            this._indicatorClickId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._virtualDevice = null;
        this._settings = null;
        this._clipboard = null;
    }
}
