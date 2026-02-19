/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { delegate } from "../../../base/events";
import { css, html } from "../../../base/web-components";
import { KCUIElement, type KCUIRangeElement } from "../../../kc-ui";
import {
    BoardViewer,
    ZONE_DEFAULT_OPACITY,
} from "../../../viewers/board/viewer";
import "./objects-visibility-ctrl";

const BOARD_OBJECTS_SETTINGS_CHANGE_EVENT =
    "ecad-viewer:board-objects-settings-change";

export class KCBoardObjectsPanelElement extends KCUIElement {
    viewer: BoardViewer;
    #check_highlight_track: HTMLInputElement;
    #pending_settings: {
        tracksOpacity?: number;
        viasOpacity?: number;
        padsOpacity?: number;
        zonesOpacity?: number;
        gridOpacity?: number;
        pageOpacity?: number;
        highlightTrack?: boolean;
        objectVisibilities?: Record<string, boolean>;
    } | null = null;
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                display: block;
                height: 100%;
                width: 100%;

                overflow-y: auto;
                overflow-x: hidden;
                user-select: none;
            }

            kc-ui-panel-title button {
                all: unset;
                flex-shrink: 0;
                margin-left: 1em;
                color: white;
                border: 0 none;
                background: transparent;
                padding: 0 0.25em 0 0.25em;
                margin-right: -0.25em;
                display: flex;
                align-items: center;
            }
        `,
    ];
    override connectedCallback() {
        (async () => {
            this.viewer = await this.requestLazyContext("viewer");
            await this.viewer.loaded;
            super.connectedCallback();
            this.setup_events();
            this.#apply_pending_settings();
        })();
    }

    private setup_events() {
        delegate(this.renderRoot, "kc-ui-range", "kc-ui-range:input", (e) => {
            const control = e.target as KCUIRangeElement;
            const opacity = control.valueAsNumber;
            switch (control.name) {
                case "tracks":
                    this.viewer.track_opacity = opacity;
                    break;
                case "vias":
                    this.viewer.via_opacity = opacity;
                    break;
                case "pads":
                    this.viewer.pad_opacity = opacity;
                    break;
                case "zones":
                    this.viewer.zone_opacity = opacity;
                    break;
                case "grid":
                    this.viewer.grid_opacity = opacity;
                    break;
                case "page":
                    this.viewer.page_opacity = opacity;
                    break;
            }
            this.#emit_settings_change();
        });
    }

    /**
     * 批量恢复 Objects 面板中的 UI 设置（透明度/高亮开关/对象可见性）。
     * 允许在 viewer 尚未 ready 时调用，内部会延迟应用。
     */
    public setSettings(settings: {
        tracksOpacity?: number;
        viasOpacity?: number;
        padsOpacity?: number;
        zonesOpacity?: number;
        gridOpacity?: number;
        pageOpacity?: number;
        highlightTrack?: boolean;
        objectVisibilities?: Record<string, boolean>;
    }) {
        this.#pending_settings = { ...(settings || {}) };
        this.#apply_pending_settings();
    }

    private #emit_settings_change() {
        try {
            const root = this.shadowRoot || this.renderRoot;
            const getRange = (name: string) =>
                root?.querySelector(`kc-ui-range[name="${name}"]`) as
                    | KCUIRangeElement
                    | null;

            const detail = {
                tracksOpacity: getRange("tracks")?.valueAsNumber,
                viasOpacity: getRange("vias")?.valueAsNumber,
                padsOpacity: getRange("pads")?.valueAsNumber,
                zonesOpacity: getRange("zones")?.valueAsNumber,
                gridOpacity: getRange("grid")?.valueAsNumber,
                pageOpacity: getRange("page")?.valueAsNumber,
                highlightTrack: !!this.#check_highlight_track?.checked,
            };

            this.dispatchEvent(
                new CustomEvent(BOARD_OBJECTS_SETTINGS_CHANGE_EVENT, {
                    detail,
                    bubbles: true,
                    composed: true,
                }),
            );
        } catch (_) {}
    }

    private #apply_pending_settings() {
        if (!this.#pending_settings) return;
        if (!this.viewer) return;

        const root = this.shadowRoot || this.renderRoot;
        const getRange = (name: string) =>
            root?.querySelector(`kc-ui-range[name="${name}"]`) as
                | KCUIRangeElement
                | null;

        // 需要控件渲染出来
        if (!root) return;

        const s = this.#pending_settings;
        this.#pending_settings = null;

        const applyRange = (name: string, value?: number) => {
            if (typeof value !== "number" || Number.isNaN(value)) return;
            const el = getRange(name);
            if (!el) return;
            el.setAttribute("value", String(value));
            el.value = String(value);
        };

        applyRange("tracks", s.tracksOpacity);
        applyRange("vias", s.viasOpacity);
        applyRange("pads", s.padsOpacity);
        applyRange("zones", s.zonesOpacity);
        applyRange("grid", s.gridOpacity);
        applyRange("page", s.pageOpacity);

        // 同步到 viewer
        if (typeof s.tracksOpacity === "number")
            this.viewer.track_opacity = s.tracksOpacity;
        if (typeof s.viasOpacity === "number") this.viewer.via_opacity = s.viasOpacity;
        if (typeof s.padsOpacity === "number") this.viewer.pad_opacity = s.padsOpacity;
        if (typeof s.zonesOpacity === "number") this.viewer.zone_opacity = s.zonesOpacity;
        if (typeof s.gridOpacity === "number") this.viewer.grid_opacity = s.gridOpacity;
        if (typeof s.pageOpacity === "number") this.viewer.page_opacity = s.pageOpacity;

        if (typeof s.highlightTrack === "boolean") {
            this.#check_highlight_track.checked = s.highlightTrack;
            this.viewer.set_highlighted_track(s.highlightTrack);
        }

        // 对象可见性由 ecad-visibility-ctrl-list 负责
        if (s.objectVisibilities && typeof s.objectVisibilities === "object") {
            const list = root?.querySelector(
                "ecad-visibility-ctrl-list",
            ) as any;
            if (list && typeof list.setObjectVisibilities === "function") {
                list.setObjectVisibilities(s.objectVisibilities);
            }
        }

        this.#emit_settings_change();
    }

    override renderedCallback(): void | undefined {
        this.#apply_pending_settings();
    }

    override render() {
        this.#check_highlight_track = html` <input
            type="checkbox"
            id="exampleCheckbox"
            name="exampleCheckbox"
            checked="true" />` as HTMLInputElement;

        this.#check_highlight_track.addEventListener("change", () => {
            this.viewer.set_highlighted_track(
                this.#check_highlight_track.checked,
            );
            this.#emit_settings_change();
        });

        return html`
            <kc-ui-panel>
                <kc-ui-panel-body padded>
                    <kc-ui-control-list>
                        <kc-ui-control>
                            <label>Tracks</label>
                            <kc-ui-range
                                min="0"
                                max="1.0"
                                step="0.01"
                                value="1"
                                name="tracks"></kc-ui-range>
                        </kc-ui-control>
                        <kc-ui-control>
                            <label>Vias</label>
                            <kc-ui-range
                                min="0"
                                max="1.0"
                                step="0.01"
                                value="1"
                                name="vias"></kc-ui-range>
                        </kc-ui-control>
                        <kc-ui-control>
                            <label>Pads</label>
                            <kc-ui-range
                                min="0"
                                max="1.0"
                                step="0.01"
                                value="1"
                                name="pads"></kc-ui-range>
                        </kc-ui-control>
                        <kc-ui-control>
                            <label>Zones</label>
                            <kc-ui-range
                                min="0"
                                max="1.0"
                                step="0.01"
                                value="${ZONE_DEFAULT_OPACITY}"
                                name="zones"></kc-ui-range>
                        </kc-ui-control>
                        <kc-ui-h-control-list>
                            <label>Highlight track:</label>
                            ${this.#check_highlight_track}
                        </kc-ui-h-control-list>
                        <ecad-visibility-ctrl-list></ecad-visibility-ctrl-list>
                    </kc-ui-control-list>
                </kc-ui-panel-body>
            </kc-ui-panel>
        `;
    }
}

window.customElements.define(
    "kc-board-objects-panel",
    KCBoardObjectsPanelElement,
);
