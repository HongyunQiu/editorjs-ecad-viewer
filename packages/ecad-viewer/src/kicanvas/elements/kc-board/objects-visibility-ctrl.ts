/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { attribute, css, html } from "../../../base/web-components";
import { KCUIElement } from "../../../kc-ui";
import { LabelLayerNames, LayerSet } from "../../../viewers/board/layers";
import { BoardViewer } from "../../../viewers/board/viewer";

enum ObjVisibilities {
    FP_Values = "Values",
    FP_Reference = "Reference",
    FP_Txt = "Footprint Text",
    Hidden_Txt = "Hidden Text",
    Pad_Numbers = "Pad Numbers",
    NetNames_Pads = "Net Names (Pads)",
    NetNames_Tracks = "Net Names (Tracks/Vias)",
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
    #did_initial_sync_from_viewer = false;
    #listening_view_state_change = false;
    #on_view_state_change = () => {
        this.#sync_ctrls_from_viewer_layers(true);
    };

    public constructor() {
        super();
        this.provideContext("layer-visibility", this);
    }

    override connectedCallback() {
        (async () => {
            this.viewer = await this.requestLazyContext("viewer");
            await this.viewer.loaded;
            super.connectedCallback();
            this.#setup_view_state_sync();
            this.#apply_pending_object_visibilities();
        })();
    }

    override disconnectedCallback(): void {
        try {
            window.removeEventListener(
                "ecad-viewer:view-state-change",
                this.#on_view_state_change as any,
            );
        } catch (_) {}
        this.#listening_view_state_change = false;
        super.disconnectedCallback();
    }

    override renderedCallback(): void | undefined {
        this.#apply_pending_object_visibilities();
        this.#sync_ctrls_from_viewer_layers();
    }

    private #setup_view_state_sync() {
        if (this.#listening_view_state_change) return;
        this.#listening_view_state_change = true;
        try {
            window.addEventListener(
                "ecad-viewer:view-state-change",
                this.#on_view_state_change as any,
            );
        } catch (_) {}
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
            case ObjVisibilities.Pad_Numbers:
                {
                    // Through-hole pad labels (global)
                    const l = layers.by_name(LabelLayerNames.pad_numbers);
                    if (l) l.opacity = p ? 1 : 0;

                    // SMD pad labels (front/back)
                    for (const name of [
                        LabelLayerNames.pad_numbers_front,
                        LabelLayerNames.pad_numbers_back,
                    ]) {
                        const ll = layers.by_name(name);
                        if (ll) ll.opacity = p ? 1 : 0;
                    }
                }
                break;
            case ObjVisibilities.NetNames_Pads:
                {
                    // Through-hole pad netnames (global)
                    const l = layers.by_name(LabelLayerNames.pad_net_names);
                    if (l) l.opacity = p ? 1 : 0;

                    // SMD pad netnames (front/back)
                    for (const name of [
                        LabelLayerNames.pad_net_names_front,
                        LabelLayerNames.pad_net_names_back,
                    ]) {
                        const ll = layers.by_name(name);
                        if (ll) ll.opacity = p ? 1 : 0;
                    }
                }
                break;
            case ObjVisibilities.NetNames_Tracks:
                {
                    // Track netnames are per-copper-layer (KiCad-like). Toggle all at once.
                    for (const it of layers.track_netname_label_layers?.() ?? []) {
                        if (it) it.opacity = p ? 1 : 0;
                    }

                    // Via netnames are on a separate layer (KiCad-like).
                    const viaLayer = layers.by_name(LabelLayerNames.via_net_names);
                    if (viaLayer) viaLayer.opacity = p ? 1 : 0;
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

    /**
     * 初次渲染时，若外部没有显式调用 setObjectVisibilities()，控件会按默认值显示，
     * 但 viewer 可能已被 viewState 恢复为“非默认”的 layer opacity。
     *
     * 为避免 UI 与实际显示不一致（造成 Footprint Text / Pad Numbers / Net Names 等开关“混乱”观感），
     * 这里在控件已渲染且 viewer 已 ready 后，从当前 layers 的 opacity 反推一次 UI 状态。
     *
     * 注意：此同步**只更新控件外观**，不触发 apply_one / emit change，避免把“恢复状态”误判为用户修改。
     */
    private #sync_ctrls_from_viewer_layers(force = false) {
        if (this.#did_initial_sync_from_viewer && !force) return;
        if (!this.viewer) return;

        const root = this.shadowRoot || this.renderRoot;
        const ctrls = root?.querySelectorAll("ecad-visibility-ctrl");
        if (!ctrls || ctrls.length === 0) return;

        const layers = this.viewer.layers as any as LayerSet;
        if (!layers) return;

        const layerIsActuallyVisible = (name: string): boolean | null => {
            try {
                const l = (layers as any).by_name?.(name);
                if (!l) return null;
                const op = (l as any).opacity;
                const vis = (l as any).visible;
                if (typeof op !== "number") return null;
                if (typeof vis !== "boolean") return null;
                return op !== 0 && vis;
            } catch (_) {
                return null;
            }
        };

        const anyActuallyVisible = (names: string[]) =>
            names.some((n) => layerIsActuallyVisible(n) === true);

        const anyTrackNetLabelNonZero = () => {
            try {
                for (const it of (layers as any).track_netname_label_layers?.() ?? []) {
                    const op = (it as any)?.opacity;
                    const vis = (it as any)?.visible;
                    if (typeof op === "number" && op !== 0 && vis === true) return true;
                }
            } catch (_) {}
            return false;
        };

        const inferVisible = (obj_name: string): boolean | null => {
            try {
                switch (obj_name) {
                    case ObjVisibilities.FP_Reference:
                        return typeof (layers as any).is_fp_reference_txt_layers_visible === "function"
                            ? !!(layers as any).is_fp_reference_txt_layers_visible()
                            : null;
                    case ObjVisibilities.FP_Values:
                        return typeof (layers as any).is_fp_value_txt_layers_visible === "function"
                            ? !!(layers as any).is_fp_value_txt_layers_visible()
                            : null;
                    case ObjVisibilities.FP_Txt:
                        return typeof (layers as any).is_fp_txt_layers_visible === "function"
                            ? !!(layers as any).is_fp_txt_layers_visible()
                            : null;
                    case ObjVisibilities.Hidden_Txt:
                        return typeof (layers as any).is_hidden_txt_layers_visible === "function"
                            ? !!(layers as any).is_hidden_txt_layers_visible()
                            : null;
                    case ObjVisibilities.Pad_Numbers:
                        return anyActuallyVisible([
                            LabelLayerNames.pad_numbers,
                            LabelLayerNames.pad_numbers_front,
                            LabelLayerNames.pad_numbers_back,
                        ]);
                    case ObjVisibilities.NetNames_Pads:
                        return anyActuallyVisible([
                            LabelLayerNames.pad_net_names,
                            LabelLayerNames.pad_net_names_front,
                            LabelLayerNames.pad_net_names_back,
                        ]);
                    case ObjVisibilities.NetNames_Tracks: {
                        const viaOn =
                            layerIsActuallyVisible(LabelLayerNames.via_net_names) ===
                            true;
                        return viaOn || anyTrackNetLabelNonZero();
                    }
                }
            } catch (_) {}
            return null;
        };

        try {
            for (const el of Array.from(ctrls) as any[]) {
                const name = String(el.obj_name ?? "");
                if (!name) continue;
                const v = inferVisible(name);
                if (typeof v === "boolean") el.obj_visible = v;
            }
            this.#did_initial_sync_from_viewer = true;
        } catch (_) {}
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

        const default_on = new Set<string>([
            ObjVisibilities.FP_Reference,
            ObjVisibilities.FP_Values,
            ObjVisibilities.FP_Txt,
        ]);

        for (const obj of [
            ObjVisibilities.FP_Reference,
            ObjVisibilities.FP_Values,

            ObjVisibilities.FP_Txt,
            ObjVisibilities.Hidden_Txt,

            ObjVisibilities.Pad_Numbers,
            ObjVisibilities.NetNames_Pads,
            ObjVisibilities.NetNames_Tracks,
        ]) {
            const visible = default_on.has(obj) ? "" : undefined;
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
