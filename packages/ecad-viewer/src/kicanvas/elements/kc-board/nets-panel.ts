/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { css, html, query } from "../../../base/web-components";
import {
    KCUIElement,
    KCUIFilteredListElement,
    KCUITextFilterInputElement,
    KCUIMenuElement,
    type KCUIMenuItemElement,
} from "../../../kc-ui";
import { KicadPCB } from "../../../kicad";
import { BoardViewer } from "../../../viewers/board/viewer";

const BOARD_NETS_SETTINGS_CHANGE_EVENT =
    "ecad-viewer:board-nets-settings-change";

export class KCBoardNetsPanelElement extends KCUIElement {
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
            ::-webkit-scrollbar {
                position: absolute;
                width: 6px;
                height: 6px;
                margin-left: -6px;
                background: var(--scrollbar-bg);
            }

            ::-webkit-scrollbar-thumb {
                position: absolute;
                background: var(--scrollbar-fg);
            }

            ::-webkit-scrollbar-thumb:hover {
                background: var(--scrollbar-hover-fg);
            }

            ::-webkit-scrollbar-thumb:active {
                background: var(--scrollbar-active-fg);
            }
        `,
    ];

    viewer: BoardViewer;
    #pending_settings:
        | { filterText?: string | null; selectedNetNumber?: number | null }
        | null = null;

    public constructor() {
        super();

        // 监听必须尽早安装：回放时可能在 initialContentCallback 之前就触发 menu.selected -> kc-ui-menu:select
        this.addEventListener("kc-ui-menu:select", (e) => {
            const item = (e as CustomEvent).detail as KCUIMenuItemElement;
            const number = parseInt(item?.name, 10);
            if (!number) return;

            // 若 viewer 尚未 ready（极端时序），延迟到 connectedCallback 后再应用
            if (!this.viewer) {
                this.#pending_settings = {
                    ...(this.#pending_settings || {}),
                    selectedNetNumber: number,
                };
                return;
            }

            this.viewer.focus_net(number);

            // 上报（用于持久化）
            this.dispatchEvent(
                new CustomEvent(BOARD_NETS_SETTINGS_CHANGE_EVENT, {
                    detail: { selectedNetNumber: number },
                    bubbles: true,
                    composed: true,
                }),
            );
        });
    }

    override connectedCallback() {
        (async () => {
            this.viewer = await this.requestLazyContext("viewer");
            await this.viewer.loaded;
            super.connectedCallback();
            this.#apply_pending_settings();
        })();
    }

    /**
     * 批量恢复 Nets 面板设置（目前主要是搜索过滤文本）。
     */
    public setSettings(settings: {
        filterText?: string | null;
        selectedNetNumber?: number | null;
    }) {
        this.#pending_settings = { ...(settings || {}) };
        this.#apply_pending_settings();
    }

    private #emit_settings_change() {
        try {
            const text = (this.search_input_elm?.value ?? "").toString();
            this.dispatchEvent(
                new CustomEvent(BOARD_NETS_SETTINGS_CHANGE_EVENT, {
                    detail: { filterText: text || null },
                    bubbles: true,
                    composed: true,
                }),
            );
        } catch (_) {}
    }

    private #apply_pending_settings() {
        if (!this.#pending_settings) return;
        if (!this.viewer) return;
        if (!this.search_input_elm || !this.item_filter_elem) return;
        if (!this.menu) return;

        const s = this.#pending_settings;
        this.#pending_settings = null;

        const text = (s.filterText ?? "").toString();
        try {
            this.search_input_elm.value = text;
        } catch (_) {}
        this.item_filter_elem.filter_text = text || null;

        // 通过 menu 自身的选中流程驱动（会自动派发 kc-ui-menu:select）
        if (s.selectedNetNumber === null) {
            try {
                // 清空高亮，但不会触发 kc-ui-menu:select（kc-ui-menu setter 内部会直接 return）
                this.menu.selected = null as any;
            } catch (_) {}
        } else if (typeof s.selectedNetNumber === "number" && !Number.isNaN(s.selectedNetNumber)) {
            try {
                this.menu.selected = String(s.selectedNetNumber);
            } catch (_) {}
        }
    }

    override initialContentCallback() {
        // Wire up search to filter the list
        this.search_input_elm.addEventListener("input", (e) => {
            this.item_filter_elem.filter_text =
                this.search_input_elm.value ?? null;
            this.#emit_settings_change();
        });
    }

    override renderedCallback(): void | undefined {
        this.#apply_pending_settings();
    }

    @query("kc-ui-text-filter-input", true)
    private search_input_elm!: KCUITextFilterInputElement;

    @query("kc-ui-filtered-list", true)
    private item_filter_elem!: KCUIFilteredListElement;

    @query("kc-ui-menu", true)
    private menu!: KCUIMenuElement;

    override render() {
        const board = this.viewer.board;

        const nets = [];
        if (board instanceof KicadPCB)
            for (const net of board.nets) {
                nets.push(
                    html`<kc-ui-menu-item
                        name="${net.number}"
                        data-match-text="${net.number} ${net.name}">
                        <span class="very-narrow"> ${net.number} </span>
                        <span>${net.name}</span>
                    </kc-ui-menu-item>`,
                );
            }

        return html`
            <kc-ui-panel>
                <!-- <kc-ui-panel-title title="Nets"></kc-ui-panel-title> -->
                <kc-ui-panel-body>
                    <kc-ui-text-filter-input></kc-ui-text-filter-input>
                    <kc-ui-filtered-list>
                        <kc-ui-menu class="outline">${nets}</kc-ui-menu>
                    </kc-ui-filtered-list>
                </kc-ui-panel-body>
            </kc-ui-panel>
        `;
    }
}

window.customElements.define("kc-board-nets-panel", KCBoardNetsPanelElement);
