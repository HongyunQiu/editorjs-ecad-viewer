/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { attribute, css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import { LayerSet } from "../../../viewers/board/layers";
import { BoardViewer } from "../../../viewers/board/viewer";

enum ObjVisibilities {
    FP_Values = "Values",
    FP_Reference = "Reference",
    FP_Txt = "Footprint Text",
    Hidden_Txt = "Hidden Text",
}

const BOARD_OBJECT_VIS_CHANGE_EVENT =
    "ecad-viewer:board-object-visibility-change";

export class ObjVisibilityCtrlList extends KCUIElement {
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
        `,
    ];

    viewer: BoardViewer;
    #pending_object_visibilities: Record<string, boolean> | null = null;

    public constructor() {
        super();
        this.provideContext("layer-visibility", this);
    }

    override connectedCallback() {
        (async () => {
            this.viewer = await this.requestLazyContext("viewer");
            await this.viewer.loaded;
            super.connectedCallback();
            this.#apply_pending_object_visibilities();
        })();
    }

    override renderedCallback(): void | undefined {
        this.#apply_pending_object_visibilities();
    }

    /**
     * 批量设置对象可见性（例如 Reference/Values/Footprint Text/Hidden Text）。
     * 用于外部恢复 UI 状态。
     */
    public setObjectVisibilities(vis: Record<string, boolean>) {
        this.#pending_object_visibilities = vis || {};
        this.#apply_pending_object_visibilities();
    }

    private #emit_object_visibility_change() {
        try {
            const current: Record<string, boolean> = {};
            const ctrls = Array.from(
                (this.shadowRoot || this.renderRoot)?.querySelectorAll(
                    "ecad-visibility-ctrl",
                ) ?? [],
            ) as any[];
            for (const c of ctrls) {
                const name = String(c.obj_name ?? "");
                if (!name) continue;
                current[name] = !!c.obj_visible;
            }
            this.dispatchEvent(
                new CustomEvent(BOARD_OBJECT_VIS_CHANGE_EVENT, {
                    detail: { objectVisibilities: current },
                    bubbles: true,
                    composed: true,
                }),
            );
        } catch (_) {}
    }

    private #apply_one(obj_name: string, visible: boolean) {
        const layers = this.viewer.layers as LayerSet;
        const p = !!visible;

        switch (obj_name) {
            case ObjVisibilities.FP_Reference:
                for (const it of layers.fp_reference_txt_layers())
                    if (it) it.opacity = p ? 1 : 0;
                break;
            case ObjVisibilities.FP_Txt:
                for (const it of layers.fp_txt_layers()) {
                    if (it) it.opacity = p ? 1 : 0;
                }
                // 同步 Values/Reference 两项（它们属于 Footprint Text 的子集）
                (this.shadowRoot || this.renderRoot)
                    ?.querySelectorAll("ecad-visibility-ctrl")
                    ?.forEach((e) => {
                        const b = e as any as ObjVisibilityCtrl;
                        if (
                            b.obj_name === ObjVisibilities.FP_Reference ||
                            b.obj_name === ObjVisibilities.FP_Values
                        ) {
                            b.obj_visible = p;
                        }
                    });
                break;
            case ObjVisibilities.FP_Values:
                for (const it of layers.fp_value_txt_layers()) {
                    if (it) it.opacity = p ? 1 : 0;
                }
                break;
            case ObjVisibilities.Hidden_Txt:
                for (const it of layers.hidden_txt_layers()) {
                    if (it) it.opacity = p ? 1 : 0;
                }
                break;
        }

        this.viewer.draw();
    }

    private #apply_pending_object_visibilities() {
        if (!this.#pending_object_visibilities) return;
        if (!this.viewer) return;

        // 需要等到控件渲染出来再应用，否则 querySelectorAll 拿不到子控件
        const root = this.shadowRoot || this.renderRoot;
        const ctrls = root?.querySelectorAll("ecad-visibility-ctrl");
        if (!ctrls || ctrls.length === 0) return;

        const vis = this.#pending_object_visibilities;
        this.#pending_object_visibilities = null;

        // 先设置控件状态，再批量应用到 viewer
        for (const el of Array.from(ctrls) as any[]) {
            const name = String(el.obj_name ?? "");
            if (!name) continue;
            if (Object.prototype.hasOwnProperty.call(vis, name)) {
                el.obj_visible = !!vis[name];
            }
        }

        // 再按既定逻辑同步到图层 opacity（会处理 FP_Txt 的级联）
        for (const el of Array.from(ctrls) as any[]) {
            const name = String(el.obj_name ?? "");
            if (!name) continue;
            if (Object.prototype.hasOwnProperty.call(vis, name)) {
                this.#apply_one(name, !!vis[name]);
            }
        }

        this.#emit_object_visibility_change();
    }

    override initialContentCallback() {
        // Toggle layer visibility when its item's visibility control is clicked
        this.renderRoot.addEventListener(
            ObjVisibilityCtrl.visibility_event,
            (e) => {
                const item = (e as CustomEvent).detail as ObjVisibilityCtrl;

                item.obj_visible = !item.obj_visible;
                this.#apply_one(item.obj_name, item.obj_visible);
                this.#emit_object_visibility_change();
            },
        );
    }

    override render() {
        const items: ReturnType<typeof html>[] = [];

        for (const obj of [
            ObjVisibilities.FP_Reference,
            ObjVisibilities.FP_Values,

            ObjVisibilities.FP_Txt,
            ObjVisibilities.Hidden_Txt,
        ]) {
            const visible = obj !== ObjVisibilities.Hidden_Txt ? "" : undefined;
            items.push(
                html`<ecad-visibility-ctrl
                    obj-name="${obj}"
                    obj-visible="${visible}"></ecad-visibility-ctrl>`,
            );
        }

        return html` ${items} `;
    }
}

class ObjVisibilityCtrl extends KCUIElement {
    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                box-sizing: border-box;
                padding: 0.1em 0.8em 0.1em 0.4em;
                color: white;
                text-align: left;
                display: flex;
                flex-direction: row;
                width: 100%;
                align-items: center;
            }

            button {
                all: unset;
                cursor: pointer;
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

            .name {
                display: block;
                flex-grow: 1;
            }

            .for-hidden {
                color: #888;
            }

            :host {
                background: var(--list-item-disabled-bg);
                color: var(--list-item-disabled-fg);
            }

            :host(:hover) {
                background: var(--list-item-hover-bg);
                color: var(--list-item-hover-fg);
            }

            :host(:hover) button {
                color: var(--list-item-fg);
            }

            :host(:hover) button:hover {
                color: var(--list-item-fg);
            }

            :host([obj-visible]) {
                background: var(--list-item-bg);
                color: var(--list-item-fg);
            }

            :host([obj-visible]:hover) {
                background: var(--list-item-hover-bg);
                color: var(--list-item-hover-fg);
            }

            :host kc-ui-icon.for-visible,
            :host([obj-visible]) kc-ui-icon.for-hidden {
                display: none;
            }

            :host kc-ui-icon.for-hidden,
            :host([obj-visible]) kc-ui-icon.for-visible {
                display: revert;
            }
        `,
    ];

    static visibility_event = "ecad-viewer:layer-control:visibility";

    override initialContentCallback() {
        super.initialContentCallback();

        this.renderRoot.addEventListener("click", (e) => {
            e.stopPropagation();
            this.dispatchEvent(
                new CustomEvent(ObjVisibilityCtrl.visibility_event, {
                    detail: this,
                    bubbles: true,
                }),
            );
        });
    }

    @attribute({ type: String })
    public obj_name: string;

    @attribute({ type: Boolean })
    public obj_visible: boolean;

    override render() {
        return html` <span class="name">${this.obj_name}</span>
            <button type="button" name="${this.obj_name}">
                <kc-ui-icon class="for-visible">svg:visibility</kc-ui-icon>
                <kc-ui-icon class="for-hidden">svg:visibility_off</kc-ui-icon>
            </button>`;
    }
}

window.customElements.define("ecad-visibility-ctrl", ObjVisibilityCtrl);

window.customElements.define(
    "ecad-visibility-ctrl-list",
    ObjVisibilityCtrlList,
);
