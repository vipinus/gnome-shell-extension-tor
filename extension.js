import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TorIndicator} from './ui/quickToggle.js';

export default class TorExtExtension extends Extension {
    enable() {
        this._indicator = new TorIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._indicator);
        console.log(`[${this.metadata.uuid}] enabled`);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
        console.log(`[${this.metadata.uuid}] disabled`);
    }
}
