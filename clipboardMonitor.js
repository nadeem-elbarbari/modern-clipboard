import St from 'gi://St';
import Meta from 'gi://Meta';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';

const CLIPBOARD_TYPE = St.ClipboardType.CLIPBOARD;

let sessionHistory = null;

export class ClipboardMonitor extends GObject.Object {
    static {
        GObject.registerClass({
            Signals: {
                'history-changed': {},
            },
        }, this);
    }

    constructor(settings, extensionPath) {
        super();
        this._settings = settings;
        this._extensionPath = extensionPath;
        this._historyPath = GLib.get_user_cache_dir() + '/clipboard-history-data.json';
        this._imageCacheDir = GLib.get_user_cache_dir() + '/clipboard-history-images';
        this.history = sessionHistory ? [...sessionHistory] : [];
        this._skipNext = false;
        this._imageCounter = 0;
        
        // Ensure image cache directory exists
        GLib.mkdir_with_parents(this._imageCacheDir, 0o755);
        
        this._clipboard = St.Clipboard.get_default();
        this._selection = global.display.get_selection();
        
        this._ownerChangedId = this._selection.connect('owner-changed', (selection, type, source) => {
            if (type === Meta.SelectionType.SELECTION_CLIPBOARD) {
                if (this._skipNext) {
                    this._skipNext = false;
                    return;
                }
                if (this._timeoutId) {
                    GLib.source_remove(this._timeoutId);
                    this._timeoutId = null;
                }
                this._timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => {
                    this._onClipboardContentChanged();
                    this._timeoutId = null;
                    return GLib.SOURCE_REMOVE;
                });
            }
        });

        this._settingsChangedId = this._settings.connect('changed::clear-history', () => {
            this.clearAll();
        });
        
        if (!sessionHistory) {
            this._loadHistory();
        }
        this._cleanupOrphanedImages();
    }

    destroy() {
        if (this._ownerChangedId) {
            this._selection.disconnect(this._ownerChangedId);
            this._ownerChangedId = null;
        }
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }
        if (this._settingsChangedId) {
            this._settings.disconnect(this._settingsChangedId);
            this._settingsChangedId = null;
        }
        sessionHistory = this.history;
        this._saveHistory();
    }

    skipNextChange() {
        this._skipNext = true;
    }

    _onClipboardContentChanged() {
        const mimetypes = this._clipboard.get_mimetypes(CLIPBOARD_TYPE);
        if (!mimetypes || mimetypes.length === 0) return;
        
        // Ignore passwords copied from password managers
        if (mimetypes.includes('x-kde-passwordManagerHint') || 
            mimetypes.includes('x-set-by-password-manager') ||
            mimetypes.includes('application/x-keepass-clip')) {
            return;
        }
        
        if (mimetypes.includes('x-special/gnome-copied-files')) {
            this._clipboard.get_content(CLIPBOARD_TYPE, 'x-special/gnome-copied-files', (c, bytes) => {
                if (bytes) {
                    const text = new TextDecoder().decode(bytes.get_data());
                    // First line is "copy" or "cut"
                    const firstLine = text.split('\n')[0].trim().toLowerCase();
                    const operation = (firstLine === 'cut') ? 'cut' : 'copy';
                    this._addItem({type: 'files', content: text, operation});
                }
            });
        } else if (mimetypes.includes('image/png')) {
            // Save image to cache as a thumbnail file
            this._clipboard.get_content(CLIPBOARD_TYPE, 'image/png', (c, bytes) => {
                if (bytes) {
                    const hash = GLib.compute_checksum_for_bytes(GLib.ChecksumType.MD5, bytes);
                    const imagePath = `${this._imageCacheDir}/clip_${hash}.png`;
                    try {
                        const file = Gio.File.new_for_path(imagePath);
                        if (!file.query_exists(null)) {
                            const stream = file.replace(null, false, Gio.FileCreateFlags.NONE, null);
                            stream.write_bytes(bytes, null);
                            stream.close(null);
                        }
                        this._addItem({type: 'image', content: imagePath});
                    } catch (err) {
                        this._addItem({type: 'image', content: ''});
                    }
                }
            });
        } else if (
            mimetypes.includes('text/plain;charset=utf-8') ||
            mimetypes.includes('text/plain') ||
            mimetypes.includes('UTF8_STRING') ||
            mimetypes.includes('STRING')
        ) {
            this._clipboard.get_text(CLIPBOARD_TYPE, (c, text) => {
                if (text && text.trim() !== '') {
                    if (this._settings.get_boolean('trim-whitespaces')) {
                        text = text.trim();
                    }
                    this._addItem({type: 'text', content: text});
                }
            });
        }
    }

    _addItem(item) {
        const maxSize = this._settings.get_int('history-size') || 20;
        
        const idx = this.history.findIndex(i => {
            if (i.type !== item.type) return false;
            if (item.type === 'files') {
                const getFilesList = str => {
                    const nl = str.indexOf('\n');
                    return nl > -1 ? str.substring(nl).trim() : str.trim();
                };
                return getFilesList(i.content) === getFilesList(item.content);
            }
            if (item.type === 'text') {
                return i.content.trim() === item.content.trim();
            }
            return i.content === item.content;
        });

        if (idx > -1) {
            item.pinned = this.history[idx].pinned;
            this.history.splice(idx, 1);
        }
        
        this.history.unshift(item);
        
        this.history.sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return 0;
        });
        
        const pinnedCount = this.history.filter(i => i.pinned).length;
        const newSize = maxSize + pinnedCount;
        if (this.history.length > newSize) {
            const removed = this.history.splice(newSize);
            removed.forEach(i => this._deleteImageFile(i));
        }
        
        this._saveHistory();
        this.emit('history-changed');
    }

    _deleteImageFile(item) {
        if (item.type === 'image' && item.content) {
            try {
                const file = Gio.File.new_for_path(item.content);
                file.delete(null);
            } catch (err) {}
        }
    }

    _cleanupOrphanedImages() {
        try {
            const dir = Gio.File.new_for_path(this._imageCacheDir);
            const enumerator = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            
            const validPaths = new Set(this.history.filter(i => i.type === 'image').map(i => i.content));
            
            let fileInfo;
            while ((fileInfo = enumerator.next_file(null)) !== null) {
                const fileName = fileInfo.get_name();
                if (fileName.startsWith('clip_') && fileName.endsWith('.png')) {
                    const fullPath = `${this._imageCacheDir}/${fileName}`;
                    if (!validPaths.has(fullPath)) {
                        try {
                            Gio.File.new_for_path(fullPath).delete(null);
                        } catch (err) {}
                    }
                }
            }
            enumerator.close(null);
        } catch (err) {}
    }

    clearUnpinned() {
        const unpinned = this.history.filter(i => !i.pinned);
        unpinned.forEach(item => this._deleteImageFile(item));
        this.history = this.history.filter(i => i.pinned);
        this._saveHistory();
        this.emit('history-changed');
    }

    clearAll() {
        this.history.forEach(item => this._deleteImageFile(item));
        this.history = [];
        this._saveHistory();
        this.emit('history-changed');
    }

    togglePin(item) {
        item.pinned = !item.pinned;
        this.history.sort((a, b) => {
            if (a.pinned && !b.pinned) return -1;
            if (!a.pinned && b.pinned) return 1;
            return 0;
        });
        this._saveHistory();
        this.emit('history-changed');
    }

    deleteItem(item) {
        const idx = this.history.indexOf(item);
        if (idx > -1) {
            const [deleted] = this.history.splice(idx, 1);
            this._deleteImageFile(deleted);
            this._saveHistory();
            this.emit('history-changed');
        }
    }

    _loadHistory() {
        try {
            const file = Gio.File.new_for_path(this._historyPath);
            file.load_contents_async(null, (f, res) => {
                try {
                    const [ok, contents] = f.load_contents_finish(res);
                    if (ok) {
                        const text = new TextDecoder('utf-8').decode(contents);
                        const parsed = JSON.parse(text);
                        const persistHistory = this._settings.get_boolean('persist-history');
                        
                        if (Array.isArray(parsed)) {
                            // Restore pinned items, and all items if persist-history is true
                            this.history = parsed.filter(i => i.pinned || persistHistory).map(i => {
                                // Ensure pinned state is a boolean
                                i.pinned = !!i.pinned;
                                return i;
                            });
                            
                            // Maintain sort order after loading
                            this.history.sort((a, b) => {
                                if (a.pinned && !b.pinned) return -1;
                                if (!a.pinned && b.pinned) return 1;
                                return 0;
                            });
                            
                            this.emit('history-changed');
                        }
                    }
                } catch (e) {}
            });
        } catch (err) {}
    }

    _saveHistory() {
        try {
            const persistHistory = this._settings.get_boolean('persist-history');
            
            // Persist all pinned items, and all items if persist-history is true
            const serializable = this.history.filter(i => i.pinned || persistHistory);
            const file = Gio.File.new_for_path(this._historyPath);
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(serializable)));
            file.replace_contents_bytes_async(
                bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION,
                null,
                (f, res) => { try { f.replace_contents_finish(res); } catch (e) {} }
            );
        } catch (err) {}
    }
}
