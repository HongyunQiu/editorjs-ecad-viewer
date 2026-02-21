import { later } from "../base/async";
import { Vec2 } from "../base/math";
import {
    CSS,
    CustomElement,
    attribute,
    css,
    html,
} from "../base/web-components";
import { KCUIElement } from "../kc-ui";
import kc_ui_styles from "../kc-ui/kc-ui.css";
import { AssertType, Project } from "../kicanvas/project";
import { type EcadBlob, type EcadSources } from "../kicanvas/services/vfs";
import { KCBoardAppElement } from "../kicanvas/elements/kc-board/app";
import { KCSchematicAppElement } from "../kicanvas/elements/kc-schematic/app";
import { BomApp } from "../kicanvas/elements/bom/app";

import { is_3d_model, is_kicad, TabHeaderElement } from "./tab_header";
import {
    BoardContentReady,
    CommentClickEvent,
    KiCanvasSelectEvent,
    Online3dViewerLoaded,
    OpenBarrierEvent,
    SheetLoadEvent,
    TabActivateEvent,
    TabMenuClickEvent,
    TabMenuVisibleChangeEvent,
} from "../viewers/base/events";
import { KicadPCB } from "../kicad";
import { LabelLayerNames } from "../viewers/board/layers";

export {
    CommentClickEvent,
    TabActivateEvent,
    SheetLoadEvent,
} from "../viewers/base/events";

import { TabKind } from "./constraint";
import type { InputContainer } from "./input_container";
import type { Online3dViewer } from "../3d-viewer/online_3d_viewer";
import "../kc-ui/spinner";
import { show_ecad_viewer } from "../eda_host/show_ecad_viewer";
import "./ecad_viewer_global";
import { ZipUtils } from "../utils/zip_utils";
import { length } from "../base/iterator";
import { HQ_LOGO } from "../kc-ui/hq_logo";

export type EcadViewerPcbObjectsViewState = {
    tracksOpacity?: number;
    viasOpacity?: number;
    padsOpacity?: number;
    zonesOpacity?: number;
    gridOpacity?: number;
    pageOpacity?: number;
    highlightTrack?: boolean;
    objectVisibilities?: Record<string, boolean>;
};

export type EcadViewerViewState = {
    /** 当前激活页签（pcb/sch/bom/step） */
    activeTab?: TabKind;
    pcb?: {
        /** PCB 图层可见性快照 */
        layers?: Record<string, boolean>;
        /** Objects 面板的 UI 设置（透明度、开关等） */
        objects?: EcadViewerPcbObjectsViewState;
        /** Nets 面板的 UI 设置（例如搜索过滤文本） */
        nets?: {
            filterText?: string | null;
            selectedNetNumber?: number | null;
        };
    };
};

function cloneViewState(v: EcadViewerViewState): EcadViewerViewState {
    try {
        // structuredClone 在部分环境可能不可用
        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
        // @ts-ignore
        if (typeof structuredClone === "function") return structuredClone(v);
    } catch (_) {}
    return JSON.parse(JSON.stringify(v || {}));
}

export class ECadViewer extends KCUIElement implements InputContainer {
    static override styles = [
        ...KCUIElement.styles,
        new CSS(kc_ui_styles),
        css`
            :host(.full-window) {
                width: 100vw; /* Full width of the viewport */
                height: 100vh; /* Full height of the viewport */
                max-height: none;
                aspect-ratio: auto;
                margin: 0;
                position: fixed;
                inset: 0;
                z-index: 2147483647; /* 盖过 QNotes 顶部栏等 UI（对齐 Excalidraw 思路） */
            }

            /* page fullscreen clone：挂在 body overlay 下，不需要 fixed，只需填满 overlay */
            :host(.page-fullscreen) {
                width: 100%;
                height: 100%;
                max-height: none;
                aspect-ratio: auto;
                margin: 0;
            }

            :host {
                margin: 0;
                display: flex;
                position: relative;
                width: 100%;
                max-height: 100%;
                aspect-ratio: 1.414;
                background-color: white;
                color: var(--fg);
                contain: layout paint;
            }

            .vertical {
                display: flex;
                flex-direction: column;
                height: 100%;
                width: 100%;
                overflow: hidden;
            }

            .tab-content {
                height: 100%;
                width: 100%;
                flex: 1;
                display: none;
            }

            .tab-content.active {
                display: inherit;
            }

            .bottom-left-icon {
                position: absolute;
                bottom: 16px;
                left: 16px; /* Adjusted to place it on the bottom-left */
                display: flex;
                align-items: center;
                justify-content: center;
                width: 40px;
                height: 40px;
                background-color: transparent;
                border-radius: 50%;
                box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
                text-decoration: none;
                color: var(--fg);
                transition:
                    transform 0.2s ease-in-out,
                    box-shadow 0.2s ease-in-out;
            }

            .bottom-left-icon:hover {
                transform: scale(1.1);
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            }
        `,
    ];

    constructor() {
        super();
        this.addDisposable(this.#project);
        this.provideContext("project", this.#project);
        this.addEventListener("contextmenu", function (event) {
            event.preventDefault();
        });

        // 在 ecad 内部直接显示加载状态（显示在 spinner 下方）。
        // 监听所有冒泡到此处的 loading-status（含 project 解析、PCB 绘制等）。
        try {
            this.addEventListener(
                "ecad-viewer:loading-status" as any,
                (e: any) => {
                    try {
                        const msg = e?.detail?.message || "";
                        if (!msg) return;
                        this.#set_global_spinner_text(String(msg));
                    } catch (_) {}
                },
                { capture: true } as any,
            );
        } catch (_) {}
    }

    override disconnectedCallback(): void | undefined {
        try {
            this.#board_viewer_select_disposable?.dispose();
        } catch (_) {}
        this.#board_viewer_select_disposable = null;
        return super.disconnectedCallback();
    }

    get input() {
        return this.#file_input;
    }
    public get target() {
        return this;
    }

    #tab_contents: Record<string, HTMLElement> = {};
    #active_tab: TabKind = TabKind.pcb;
    #project: Project = new Project();
    #schematic_app: KCSchematicAppElement;
    #ov_d_app: Online3dViewer;
    #board_app: KCBoardAppElement;
    #bom_app: BomApp;
    #tab_header: TabHeaderElement;
    #file_input: HTMLInputElement;
    #spinner: HTMLElement;
    #content: HTMLElement;
    #step_viewer_placeholder: HTMLElement;
    #viewers_container: HTMLDivElement;
    #is_full_screen = false;
    #fullscreen_prev_body_overflow: string | null = null;
    #fullscreen_keydown_handler: ((e: KeyboardEvent) => void) | null = null;
    #fullscreen_overlay: HTMLDivElement | null = null;
    // 当该实例本身就是“全屏克隆实例”时，指向原始 viewer，用于点击按钮退出全屏。
    #fullscreen_original: ECadViewer | null = null;

    // 记录当前 viewer 最近一次成功加载的 sources（用于全屏克隆快速复现内容，尤其是 ZIP/load_zip 路径）
    #last_sources: EcadSources | null = null;

    #loading_status_text = "";

    #set_global_spinner_text(text: string) {
        const t = String(text || "");
        this.#loading_status_text = t;
        try {
            (this.#spinner as any).text = t;
        } catch (_) {
            try {
                if (this.#spinner) {
                    if (t) this.#spinner.setAttribute("text", t);
                    else this.#spinner.removeAttribute("text");
                }
            } catch (_) {}
        }
    }

    // 用于“全屏克隆实例”在首次连接 DOM 时直接从 sources 初始化，避免走默认的 load_src()
    #initial_sources_override: EcadSources | null = null;
    #initial_ov_3d_url_override: string | null = null;

    // 当前 viewer 的 UI 视图状态快照（供外部持久化/恢复）
    #view_state: EcadViewerViewState = {};
    #pending_view_state: Partial<EcadViewerViewState> | null = null;
    // 用于“全屏克隆实例”在首次连接 DOM 时直接恢复视图状态
    #initial_view_state_override: Partial<EcadViewerViewState> | null = null;
    #view_state_retry_scheduled = false;
    #view_state_retry_count = 0;
    #board_viewer_select_disposable: { dispose: () => void } | null = null;
    get project() {
        return this.#project;
    }

    @attribute({ type: Boolean })
    public loading: boolean;

    @attribute({ type: Boolean })
    public loaded: boolean;

    /**
     * When true, clicking on the viewer dispatches CommentClickEvent
     * instead of selecting items. Used for design review commenting.
     */
    @attribute({ type: Boolean })
    public "comment-mode": boolean;

    /**
     * Enable or disable comment mode programmatically.
     * When enabled, clicks dispatch CommentClickEvent with coordinates.
     */
    public setCommentMode(enabled: boolean): void {
        this["comment-mode"] = enabled;

        // Helper to forward CommentClickEvent from internal viewer to this element
        const forwardEvent = (event: Event) => {
            const e = event as CommentClickEvent;
            // Re-dispatch the event from this element so React can listen
            this.dispatchEvent(new CommentClickEvent(e.detail));
        };

        if (this.#board_app?.viewer) {
            const viewer = this.#board_app.viewer as any;
            viewer.commentModeEnabled = enabled;
            if (enabled) {
                viewer.addEventListener(CommentClickEvent.type, forwardEvent);
            } else {
                viewer.removeEventListener(
                    CommentClickEvent.type,
                    forwardEvent,
                );
            }
        }

        if (this.#schematic_app?.viewer) {
            const viewer = this.#schematic_app.viewer as any;
            viewer.commentModeEnabled = enabled;
            if (enabled) {
                viewer.addEventListener(CommentClickEvent.type, forwardEvent);
            } else {
                viewer.removeEventListener(
                    CommentClickEvent.type,
                    forwardEvent,
                );
            }
        }
    }

    /**
     * Move the camera to a specific location (in world coordinates)
     */
    public zoomToLocation(x: number, y: number): void {
        const pos = new Vec2(x, y);
        // Helper to move camera on a viewer
        const moveCamera = (viewer: any) => {
            if (viewer?.viewport?.camera) {
                viewer.viewport.camera.center.set(pos.x, pos.y);
                viewer.draw();
            }
        };

        if (this.#board_app?.viewer) {
            moveCamera(this.#board_app.viewer);
        }
        if (this.#schematic_app?.viewer) {
            moveCamera(this.#schematic_app.viewer);
        }
    }

    /**
     * Switch to a specific schematic page (by filename or sheet path)
     */
    public switchPage(pageId: string): void {
        if (!this.#schematic_app) return;

        // Ensure we are on the schematic tab
        if (this.#tab_header) {
            // We can't easily programmatically click the tab header without exposing it or duplicating logic,
            // but we can simulate the tab switch if needed.
            // Ideally ecad-viewer should expose a method to set active tab.
            // For now, let's assume the caller handles tab switching or we just switch the internal view.
        }

        const project = this.#project;
        // Try to find by filename first
        const sch = project.file_by_name(pageId);
        if (sch) {
            this.#schematic_app.viewer.load(sch as any);
            return;
        }

        // Try to find by sheet path/UUID if needed - but filename is usually sufficient for now
        console.warn(`switchPage: Could not find page with ID ${pageId}`);
    }

    /**
     * Get screen coordinates from world coordinates
     */
    public getScreenLocation(
        x: number,
        y: number,
    ): { x: number; y: number } | null {
        const pos = new Vec2(x, y);

        let viewer: any = null;
        if (this.#active_tab === TabKind.pcb && this.#board_app) {
            viewer = this.#board_app.viewer;
        } else if (this.#active_tab === TabKind.sch && this.#schematic_app) {
            viewer = this.#schematic_app.viewer;
        } else {
            // Fallback
            viewer = (this.#board_app?.viewer ||
                this.#schematic_app?.viewer) as any;
        }

        if (viewer?.viewport?.camera) {
            // Note: Camera2 uses snake_case world_to_screen
            const screenPos = viewer.viewport.camera.world_to_screen(pos);
            return { x: screenPos.x, y: screenPos.y };
        }
        return null;
    }

    public getViewState(): EcadViewerViewState {
        return cloneViewState(this.#view_state);
    }

    /**
     * 外部设置/恢复 viewer 的 UI 状态。
     * - 可在 loaded=false 时调用，内部会延迟到加载完成后再应用
     */
    public async setViewState(state: Partial<EcadViewerViewState>): Promise<void> {
        if (!state || typeof state !== "object") return;

        this.#merge_view_state(state);

        if (!this.loaded) {
            // 延迟到 #setup_project 之后统一 apply
            this.#pending_view_state = {
                ...(this.#pending_view_state || {}),
                ...cloneViewState(state as any),
            };
            return;
        }

        const ok = await this.#apply_view_state(state);
        if (!ok) {
            this.#pending_view_state = {
                ...(this.#pending_view_state || {}),
                ...cloneViewState(state as any),
            };
            this.#schedule_view_state_retry();
        }
    }

    #merge_view_state(fragment: Partial<EcadViewerViewState>) {
        const next = cloneViewState(this.#view_state || {});
        if (fragment.activeTab) next.activeTab = fragment.activeTab;

        if (fragment.pcb) {
            next.pcb = next.pcb || {};
            if (fragment.pcb.layers) {
                next.pcb.layers = { ...(next.pcb.layers || {}), ...fragment.pcb.layers };
            }
            if (fragment.pcb.objects) {
                next.pcb.objects = { ...(next.pcb.objects || {}), ...fragment.pcb.objects };
            }
            if (fragment.pcb.nets) {
                next.pcb.nets = { ...(next.pcb.nets || {}), ...fragment.pcb.nets };
            }
        }

        this.#view_state = next;
    }

    #emit_view_state_change() {
        try {
            this.dispatchEvent(
                new CustomEvent("ecad-viewer:view-state-change", {
                    detail: { viewState: this.getViewState() },
                    bubbles: true,
                    composed: true,
                }),
            );
        } catch (_) {}
    }

    #schedule_view_state_retry() {
        if (this.#view_state_retry_scheduled) return;
        if (!this.loaded) return;
        if (!this.#pending_view_state) return;
        // 避免无限循环
        if (this.#view_state_retry_count > 50) return;
        this.#view_state_retry_scheduled = true;
        this.#view_state_retry_count += 1;

        later(() => {
            this.#view_state_retry_scheduled = false;
            if (!this.loaded) return;
            if (!this.#pending_view_state) return;

            const vs = this.#pending_view_state;
            // 不要在这里清空 pending：只有确认应用成功才清空
            void (async () => {
                const ok = await this.#apply_view_state(vs);
                if (ok) {
                    this.#pending_view_state = null;
                } else {
                    this.#schedule_view_state_retry();
                }
            })();
        });
    }

    async #apply_view_state(fragment: Partial<EcadViewerViewState>): Promise<boolean> {
        let complete = true;
        // 这里**不能**调用 this.update()：
        // 本项目的 render() 会创建新的子组件（例如 kc-board-app），
        // 若在“已加载并已显示内容”后触发 update()，会导致子组件被重建，
        // 从而错过 project.on_loaded() 已经派发过的 change 事件，最终卡在 spinner。

        // Tab
        if (fragment.activeTab && this.#tab_header) {
            try {
                const hdr: any = this.#tab_header as any;
                if (typeof hdr.setActiveTab === "function") hdr.setActiveTab(fragment.activeTab);
            } catch (_) {}
        } else if (fragment.activeTab && !this.#tab_header) {
            complete = false;
        }

        // PCB Layers / Objects
        const pcb = fragment.pcb;
        if (pcb && this.#board_app) {
            const root = (this.#board_app as any).shadowRoot as ShadowRoot | null;
            if (!root) complete = false;
            if (pcb.layers) {
                try {
                    const panel = root?.querySelector("kc-board-layers-panel") as any;
                    if (panel && typeof panel.setVisibilities === "function") {
                        panel.setVisibilities(pcb.layers);
                    } else {
                        // 兜底：直接改 layers 可见性
                        const viewer: any = (this.#board_app as any).viewer;
                        const ui_layers = viewer?.layers?.in_ui_order?.();
                        if (ui_layers) {
                            for (const l of ui_layers) {
                                if (Object.prototype.hasOwnProperty.call(pcb.layers, l.name)) {
                                    l.visible = !!pcb.layers[l.name];
                                }
                            }
                            viewer?.draw?.();
                        }
                        if (!ui_layers) complete = false;
                    }
                } catch (_) {}
            }

            if (pcb.objects) {
                try {
                    // 1) 优先直接作用到 BoardViewer（不依赖 Objects 面板是否被打开/是否已完成渲染）
                    const viewer: any = (this.#board_app as any).viewer;
                    if (viewer) {
                        if (typeof pcb.objects.tracksOpacity === "number") viewer.track_opacity = pcb.objects.tracksOpacity;
                        if (typeof pcb.objects.viasOpacity === "number") viewer.via_opacity = pcb.objects.viasOpacity;
                        if (typeof pcb.objects.padsOpacity === "number") viewer.pad_opacity = pcb.objects.padsOpacity;
                        if (typeof pcb.objects.zonesOpacity === "number") viewer.zone_opacity = pcb.objects.zonesOpacity;
                        if (typeof pcb.objects.gridOpacity === "number") viewer.grid_opacity = pcb.objects.gridOpacity;
                        if (typeof pcb.objects.pageOpacity === "number") viewer.page_opacity = pcb.objects.pageOpacity;
                        if (typeof pcb.objects.highlightTrack === "boolean" && typeof viewer.set_highlighted_track === "function") {
                            viewer.set_highlighted_track(pcb.objects.highlightTrack);
                        }

                        // 对象可见性：通过 LayerSet 的各类 txt_layers opacity 实现
                        const objVis = pcb.objects.objectVisibilities;
                        const layers: any = viewer.layers;
                        const applyOpacity = (gen: any, opacity: number) => {
                            try {
                                if (!gen) return;
                                for (const l of gen) if (l) l.opacity = opacity;
                            } catch (_) {}
                        };
                        if (objVis && typeof objVis === "object" && layers) {
                            const fpTxt = objVis["Footprint Text"];
                            const fpRef = objVis["Reference"];
                            const fpVal = objVis["Values"];
                            const hidTxt = objVis["Hidden Text"];
                            const padNums = objVis["Pad Numbers"];
                            const netPads = objVis["Net Names (Pads)"];
                            const netTracks = objVis["Net Names (Tracks/Vias)"];

                            // 先应用 Footprint Text（会覆盖 Reference/Values 的视觉效果，语义与 UI 一致）
                            if (typeof fpTxt === "boolean") {
                                applyOpacity(layers.fp_txt_layers?.(), fpTxt ? 1 : 0);
                                // 同步子项：Reference/Values
                                applyOpacity(layers.fp_reference_txt_layers?.(), fpTxt ? 1 : 0);
                                applyOpacity(layers.fp_value_txt_layers?.(), fpTxt ? 1 : 0);
                            } else {
                                if (typeof fpRef === "boolean") applyOpacity(layers.fp_reference_txt_layers?.(), fpRef ? 1 : 0);
                                if (typeof fpVal === "boolean") applyOpacity(layers.fp_value_txt_layers?.(), fpVal ? 1 : 0);
                            }

                            if (typeof hidTxt === "boolean") applyOpacity(layers.hidden_txt_layers?.(), hidTxt ? 1 : 0);

                            // Label layers (pads/tracks netnames, pad numbers)
                            try {
                                const setLayerOpacity = (name: string, on: boolean) => {
                                    const l = layers?.by_name?.(name);
                                    if (l) l.opacity = on ? 1 : 0;
                                };

                                if (typeof padNums === "boolean")
                                {
                                    setLayerOpacity(LabelLayerNames.pad_numbers, padNums);
                                    setLayerOpacity(LabelLayerNames.pad_numbers_front, padNums);
                                    setLayerOpacity(LabelLayerNames.pad_numbers_back, padNums);
                                }
                                if (typeof netPads === "boolean")
                                {
                                    setLayerOpacity(LabelLayerNames.pad_net_names, netPads);
                                    setLayerOpacity(LabelLayerNames.pad_net_names_front, netPads);
                                    setLayerOpacity(LabelLayerNames.pad_net_names_back, netPads);
                                }
                                if (typeof netTracks === "boolean") {
                                    // Track netnames: per-copper-layer label layers (KiCad-like)
                                    try {
                                        for (const it of layers.track_netname_label_layers?.() ?? [])
                                            if (it) it.opacity = netTracks ? 1 : 0;
                                    } catch (_) {}

                                    // Via netnames: separate layer (KiCad-like)
                                    setLayerOpacity(LabelLayerNames.via_net_names, netTracks);
                                }
                            } catch (_) {}
                        }

                        if (typeof viewer.draw === "function") viewer.draw();
                    }

                    // 2) 如果 Objects 面板已存在，也同步 UI 控件值（让用户打开 Objects 时看到一致的滑块/开关）
                    const panel = root?.querySelector("kc-board-objects-panel") as any;
                    if (panel && typeof panel.setSettings === "function") {
                        panel.setSettings(pcb.objects);
                    }
                } catch (_) {}
            }

            // Nets panel settings
            if (pcb.nets) {
                try {
                    // 兜底：即使 Nets 面板尚未 ready，也先尝试直接让 BoardViewer 聚焦该 net
                    if (pcb.nets.selectedNetNumber === null) {
                        const viewer: any = (this.#board_app as any).viewer;
                        if (typeof viewer?.clear_net_focus === "function") {
                            try {
                                viewer.clear_net_focus();
                            } catch (_) {}
                        } else if (viewer?.loaded?.isOpen) {
                            // 兜底：若没有 clear_net_focus，则至少尝试 highlight_net(null)
                            try {
                                viewer.focus_net(null);
                            } catch (_) {}
                        } else {
                            complete = false;
                        }
                    } else if (
                        typeof pcb.nets.selectedNetNumber === "number" &&
                        !Number.isNaN(pcb.nets.selectedNetNumber)
                    ) {
                        const viewer: any = (this.#board_app as any).viewer;
                        if (viewer?.loaded?.isOpen) {
                            try {
                                viewer.focus_net(pcb.nets.selectedNetNumber);
                            } catch (_) {}
                        } else {
                            complete = false;
                        }
                    }

                    const panel = root?.querySelector("kc-board-nets-panel") as any;
                    if (panel && typeof panel.setSettings === "function") {
                        panel.setSettings(pcb.nets);
                    } else {
                        complete = false;
                    }
                } catch (_) {}
            }
        } else if (pcb && !this.#board_app) {
            // 还未渲染出 board app，延迟重试
            complete = false;
        }

        this.#emit_view_state_change();
        return complete;
    }

    attributeChangedCallback(
        name: string,
        old_value: string,
        new_value: string,
    ) {
        // super.attributeChangedCallback(name, old_value, new_value);
        // Sync comment-mode attribute to viewer's commentModeEnabled property
        // Only update if loaded (viewers exist)
        if (name === "comment-mode" && this.loaded) {
            const enabled = new_value !== null && new_value !== "false";
            this.setCommentMode(enabled);
        }
    }
    override initialContentCallback() {
        this.#setup_events();
        later(() => {
            // 若外部（例如全屏克隆）提前注入了 viewState，则先记录，待加载完成后统一 apply
            if (this.#initial_view_state_override) {
                const vs = this.#initial_view_state_override;
                this.#initial_view_state_override = null;
                void this.setViewState(vs);
            }

            // 若外部（例如全屏克隆）提前注入了 sources，则优先按该 sources 初始化，避免走默认 load_src()
            if (this.#initial_sources_override) {
                const sources = this.#initial_sources_override;
                this.#initial_sources_override = null;

                if (this.#initial_ov_3d_url_override) {
                    this.#project.ov_3d_url = this.#initial_ov_3d_url_override;
                    this.#initial_ov_3d_url_override = null;
                }

                void this.#setup_project(sources);
                return;
            }

            this.load_src();
        });
    }

    async #setup_events() {
        // PCB Layers 面板：层可见性变化
        this.addEventListener(
            "ecad-viewer:board-layer-visibility-change",
            (e: Event) => {
                const detail: any = (e as any).detail || {};
                const layers = detail.layerVisibility;
                if (!layers || typeof layers !== "object") return;
                this.#merge_view_state({ pcb: { layers } });
                this.#emit_view_state_change();
            },
        );

        // PCB Objects 面板：透明度/开关等变化
        this.addEventListener(
            "ecad-viewer:board-objects-settings-change",
            (e: Event) => {
                const detail: any = (e as any).detail || {};
                if (!detail || typeof detail !== "object") return;
                this.#merge_view_state({ pcb: { objects: detail } });
                this.#emit_view_state_change();
            },
        );

        // PCB Objects 面板：对象可见性变化（Reference/Values/...）
        this.addEventListener(
            "ecad-viewer:board-object-visibility-change",
            (e: Event) => {
                const detail: any = (e as any).detail || {};
                const obj = detail.objectVisibilities;
                if (!obj || typeof obj !== "object") return;
                this.#merge_view_state({
                    pcb: { objects: { objectVisibilities: obj } },
                });
                this.#emit_view_state_change();
            },
        );

        // PCB Nets 面板：搜索过滤等设置变化
        this.addEventListener(
            "ecad-viewer:board-nets-settings-change",
            (e: Event) => {
                const detail: any = (e as any).detail || {};
                if (!detail || typeof detail !== "object") return;
                this.#merge_view_state({ pcb: { nets: detail } });
                this.#emit_view_state_change();
            },
        );
    }

    async load_zip(file: Blob) {
        try {
            this.dispatchEvent(
                new CustomEvent("ecad-viewer:loading-status", {
                    detail: { phase: "unzip", message: "正在解压缩 ZIP…" },
                }),
            );
        } catch (_) {}
        const files = await ZipUtils.unzipFile(file);
        try {
            this.dispatchEvent(
                new CustomEvent("ecad-viewer:loading-status", {
                    detail: {
                        phase: "unzip",
                        message: `正在读取 ZIP 内文件（${files.length}）…`,
                    },
                }),
            );
        } catch (_) {}
        const readFilePromises = Array.from(files).map((file) =>
            this.readFile(file),
        );

        try {
            const blobs: EcadBlob[] = [];

            const results = await Promise.all(readFilePromises);

            let idx = -1;
            results.forEach(({ name, content }) => {
                idx = idx + 1;
                const names = name.split("/");
                name = names[names.length - 1]!;

                if (is_kicad(name)) {
                    blobs.push({ filename: name, content });
                } else if (is_3d_model(name)) {
                    this.#project.ov_3d_url = URL.createObjectURL(files[idx]!);
                }
            });

            try {
                this.dispatchEvent(
                    new CustomEvent("ecad-viewer:loading-status", {
                        detail: {
                            phase: "project",
                            message: "正在解析工程文件…",
                        },
                    }),
                );
            } catch (_) {}
            await this.#setup_project({ urls: [], blobs });
        } catch (error) {
            console.error("Error while loading ZIP:", error);
        }
    }

    private readFile(file: File): Promise<{ name: string; content: string }> {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = (e) =>
                resolve({
                    name: file.name,
                    content: e.target!.result as string,
                });
            reader.onerror = (error) => reject(error);
            reader.readAsText(file);
        });
    }

    async load_window_zip_url(url: string) {
        try {
            this.dispatchEvent(
                new CustomEvent("ecad-viewer:loading-status", {
                    detail: { phase: "download", message: "正在下载资源…" },
                }),
            );
        } catch (_) {}
        const resp = await fetch(url);
        const blob = await resp.blob();
        try {
            this.dispatchEvent(
                new CustomEvent("ecad-viewer:loading-status", {
                    detail: { phase: "download", message: "下载完成，准备解析…" },
                }),
            );
        } catch (_) {}
        return this.load_zip(blob);
    }

    async load_src() {
        if (window.zip_url) {
            return this.load_window_zip_url(window.zip_url);
        }
        if (window.design_urls) {
            const do_load_glb = () => {
                if (window.design_urls?.glb_url) {
                    this.load_window_zip_url(window.design_urls.glb_url);
                }
            };

            const do_load_pcb = () => {
                if (window.design_urls?.pcb_url) {
                    this.load_window_zip_url(window.design_urls.pcb_url).then(
                        () => {
                            do_load_glb();
                        },
                    );
                }
            };

            if (window.design_urls.sch_url) {
                await this.load_window_zip_url(window.design_urls.sch_url);
                if (window.design_urls.pcb_url) return do_load_pcb();
                if (window.design_urls.glb_url) return do_load_glb();
            }

            if (window.design_urls.pcb_url) {
                return do_load_pcb();
            }

            if (window.design_urls.glb_url) {
                return do_load_glb();
            }
        }

        const urls = [];
        const blobs: EcadBlob[] = [];

        for (const src_elm of this.querySelectorAll<EcadSourceElement>(
            "ecad-source",
        )) {
            if (src_elm.src) {
                urls.push(src_elm.src);
            }
        }

        for (const blob_elm of this.querySelectorAll<EcadBlobElement>(
            "ecad-blob",
        )) {
            blobs.push({
                filename: blob_elm.filename,
                content: blob_elm.content,
            });
        }

        for (const src of this.querySelectorAll<Ov3dElement>(
            "ecad-3d-source",
        )) {
            if (src.src) {
                this.#project.ov_3d_url = src.src;
                break;
            }
        }

        await this.#setup_project({ urls, blobs });
    }

    async #setup_project(sources: EcadSources) {
        this.loaded = false;
        this.loading = true;

        try {
            try {
                this.dispatchEvent(
                    new CustomEvent("ecad-viewer:loading-status", {
                        detail: { phase: "project", message: "正在解析工程…" },
                    }),
                );
            } catch (_) {}

            // 保存一份 sources 的浅拷贝，避免外部数组/对象被后续修改
            this.#last_sources = {
                urls: [...(sources.urls ?? [])],
                blobs: [...(sources.blobs ?? [])].map((b) => ({
                    filename: b.filename,
                    content: b.content,
                })),
            };

            const forward_status = (e: any) => {
                try {
                    const d = e?.detail ?? null;
                    if (!d) return;
                    this.dispatchEvent(
                        new CustomEvent("ecad-viewer:loading-status", {
                            detail: d,
                        }),
                    );
                } catch (_) {}
            };
            try {
                this.#project.addEventListener(
                    "load-status",
                    forward_status as any,
                );
            } catch (_) {}

            try {
                await this.#project.load(sources);
            } finally {
                try {
                    this.#project.removeEventListener(
                        "load-status",
                        forward_status as any,
                    );
                } catch (_) {}
            }

            this.loaded = true;
            try {
                this.dispatchEvent(
                    new CustomEvent("ecad-viewer:loading-status", {
                        detail: {
                            phase: "ui",
                            message: "正在初始化界面…",
                        },
                    }),
                );
            } catch (_) {}
            await this.update();
            try {
                this.dispatchEvent(
                    new CustomEvent("ecad-viewer:loading-status", {
                        detail: { phase: "render", message: "渲染完成" },
                    }),
                );
            } catch (_) {}

            // 监听 PCB Viewer 的“选中”事件，用于持久化双击线路等触发的 net 选择
            try {
                this.#board_viewer_select_disposable?.dispose();
            } catch (_) {}
            this.#board_viewer_select_disposable = null;
            try {
                const boardViewer: any = this.#board_app?.viewer;
                if (boardViewer && typeof boardViewer.addEventListener === "function") {
                    this.#board_viewer_select_disposable =
                        boardViewer.addEventListener(
                            KiCanvasSelectEvent.type,
                            (e: any) => {
                                try {
                                    const item = e?.detail?.item;
                                    if (!item) return;

                                    // net 可能是 number（kicad item），也可能是 string（highlight_net 里派发的 {net: name,...}）
                                    let netNum: number | null = null;
                                    const rawNet = (item as any).net;
                                    if (typeof rawNet === "number" && !Number.isNaN(rawNet) && rawNet > 0) {
                                        netNum = rawNet;
                                    } else if (typeof rawNet === "string" && rawNet) {
                                        const pcb = boardViewer?.board;
                                        if (pcb instanceof KicadPCB) {
                                            const found = pcb.nets?.find((n: any) => n?.name === rawNet);
                                            const nnum = found?.number;
                                            if (typeof nnum === "number" && !Number.isNaN(nnum) && nnum > 0) {
                                                netNum = nnum;
                                            }
                                        }
                                    }

                                    if (!netNum) return;

                                    this.#merge_view_state({
                                        pcb: { nets: { selectedNetNumber: netNum } },
                                    });
                                    this.#emit_view_state_change();

                                    // 若 Nets 面板已渲染，顺便同步 UI 高亮（通过面板自身选中流程驱动）
                                    try {
                                        const root = (this.#board_app as any).shadowRoot as ShadowRoot | null;
                                        const panel = root?.querySelector("kc-board-nets-panel") as any;
                                        if (panel && typeof panel.setSettings === "function") {
                                            panel.setSettings({ selectedNetNumber: netNum });
                                        }
                                    } catch (_) {}
                                } catch (_) {}
                            },
                        ) as any;

                    // 监听 net focus 被取消（例如点击空白区域触发恢复可见性）
                    boardViewer.addEventListener(
                        "kicanvas:net-focus-change",
                        (e: any) => {
                            try {
                                const netNumber = e?.detail?.netNumber ?? null;
                                if (netNumber !== null) return;
                                this.#merge_view_state({
                                    pcb: { nets: { selectedNetNumber: null } },
                                });
                                this.#emit_view_state_change();

                                // 同步清空 Nets 面板高亮
                                try {
                                    const root = (this.#board_app as any).shadowRoot as ShadowRoot | null;
                                    const panel = root?.querySelector("kc-board-nets-panel") as any;
                                    if (panel && typeof panel.setSettings === "function") {
                                        panel.setSettings({ selectedNetNumber: null });
                                    }
                                } catch (_) {}
                            } catch (_) {}
                        },
                    );
                }
            } catch (_) {}

            // 若外部提前设置了 viewState（例如 Editor.js block 恢复/全屏克隆），在首次渲染后应用
            if (this.#pending_view_state) {
                const vs = this.#pending_view_state;
                const ok = await this.#apply_view_state(vs);
                if (ok) {
                    this.#pending_view_state = null;
                } else {
                    this.#schedule_view_state_retry();
                }
            }

            this.#project.on_loaded();
        } finally {
            this.loading = false;
        }
    }
    get has_3d() {
        // 只有确实存在 3D 模型来源时才显示 3D 页签：
        // - Project.has_3d 由 ov_3d_url 或 design_urls.glb_url 决定
        // 之前将 has_boards 也算入 has_3d 会导致“仅 PCB 无 glb”时 3D 页签一直转圈。
        return this.#project.has_3d;
    }
    get has_pcb() {
        return this.#project.has_boards;
    }
    get has_sch() {
        return this.#project.has_schematics;
    }

    get sch_count() {
        return length(this.#project.schematics());
    }
    get has_bom() {
        return this.has_pcb || this.has_sch;
    }

    #exit_page_fullscreen() {
        if (!this.#is_full_screen) return;

        const doc = window.document;

        // 移除 ESC 监听
        if (this.#fullscreen_keydown_handler) {
            doc.removeEventListener(
                "keydown",
                this.#fullscreen_keydown_handler,
                true,
            );
            this.#fullscreen_keydown_handler = null;
        }

        // 恢复 body 滚动
        if (this.#fullscreen_prev_body_overflow !== null) {
            doc.body.style.overflow = this.#fullscreen_prev_body_overflow;
            this.#fullscreen_prev_body_overflow = null;
        }

        // 移除 overlay（会连带销毁克隆 viewer，触发其 disconnectedCallback dispose 资源）
        if (this.#fullscreen_overlay?.parentNode) {
            this.#fullscreen_overlay.parentNode.removeChild(
                this.#fullscreen_overlay,
            );
        }
        this.#fullscreen_overlay = null;

        // 还原原始 viewer 的可见性与交互
        this.style.visibility = "";
        this.style.pointerEvents = "";

        this.#is_full_screen = false;

        later(() => {
            window.dispatchEvent(new Event("resize"));
        });

        if (this.#ov_d_app) this.#ov_d_app.on_show();
    }

    #enter_page_fullscreen() {
        const doc = window.document;
        const body = doc.body;

        // 覆盖层放在 body 下，确保覆盖 QNotes 顶栏（避免被 editor 容器的 stacking context 限制）
        const overlay = doc.createElement("div");
        overlay.className = "ecad-viewer__page-fullscreen-overlay";
        overlay.style.position = "fixed";
        overlay.style.inset = "0";
        overlay.style.zIndex = "2147483647";
        overlay.style.background = "white";
        overlay.style.margin = "0";
        overlay.style.padding = "0";
        overlay.style.display = "flex";
        overlay.style.alignItems = "stretch";
        overlay.style.justifyContent = "stretch";

        // 禁止页面滚动，避免底层 Editor.js/QNotes 跟随滚动
        this.#fullscreen_prev_body_overflow = body.style.overflow;
        body.style.overflow = "hidden";

        body.appendChild(overlay);

        // 创建一个新的 viewer（类似 Excalidraw/Univer 的 portal 思路），避免移动当前 DOM 导致交互 dispose
        const clone = doc.createElement("ecad-viewer") as ECadViewer;
        clone.#fullscreen_original = this;
        clone.classList.add("page-fullscreen");
        clone.style.width = "100%";
        clone.style.height = "100%";
        clone.style.flex = "1";

        // 复制必要的 attribute（例如 comment-mode）
        if (this.hasAttribute("comment-mode")) {
            const v = this.getAttribute("comment-mode");
            // 属性存在但为空时也视为开启
            clone.setAttribute("comment-mode", v ?? "true");
        }

        // ZIP / window.zip_url 等路径会走 load_zip()，不会把 sources 写回 DOM。
        // 因此优先用“最近一次加载的 sources”来初始化克隆实例，确保全屏内容一致。
        if (this.#last_sources) {
            clone.#initial_sources_override = this.#last_sources;
            clone.#initial_ov_3d_url_override = this.#project.ov_3d_url ?? null;
        } else {
            // 兜底：从 DOM 中 clone 数据源（适用于 ecad-blob/ecad-source 方式加载）
            // 注意：不能直接“移动”这些子元素，否则它们作为 CustomElement 也会在重连时触发 attachShadow 冲突。
            for (const src of this.querySelectorAll(
                "ecad-source, ecad-blob, ecad-3d-source",
            )) {
                clone.appendChild(src.cloneNode(true));
            }
        }

        // 复制当前视图设置（层可见性/透明度等），保证全屏与嵌入态一致
        try {
            clone.#initial_view_state_override = this.getViewState();
        } catch (_) {}

        overlay.appendChild(clone);

        // 原始 viewer 保留在原位（避免布局抖动），但隐藏并禁用交互
        this.style.visibility = "hidden";
        this.style.pointerEvents = "none";

        // ESC 退出全屏（绑定在 document，保证无论焦点在哪都能退出）
        this.#fullscreen_keydown_handler = (e: KeyboardEvent) => {
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                this.#exit_page_fullscreen();
            }
        };
        doc.addEventListener("keydown", this.#fullscreen_keydown_handler, true);

        this.#fullscreen_overlay = overlay;
        this.#is_full_screen = true;

        later(() => {
            window.dispatchEvent(new Event("resize"));
        });
    }

    on_full_windows() {
        if (window.is_module_lib) {
            console.log("is_module_lib " + window.is_module_lib);
            return show_ecad_viewer();
        }

        // 如果当前实例是“全屏克隆实例”，则点击按钮应退出全屏（由原始实例负责清理 overlay）
        if (this.#fullscreen_original) {
            this.#fullscreen_original.#exit_page_fullscreen();
            return;
        }

        if (this.#is_full_screen) {
            this.#exit_page_fullscreen();
        } else {
            this.#enter_page_fullscreen();
        }
    }

    override render() {
        this.#file_input = html` <input
            type="file"
            id="fileInput"
            style="display: none"
            multiple />` as HTMLInputElement;
        this.#spinner = html`<ecad-spinner></ecad-spinner>` as HTMLElement;
        // 将最新状态文案写入 spinner（不依赖外部容器）
        try {
            (this.#spinner as any).text = this.#loading_status_text || "";
        } catch (_) {}
        if (!this.loaded) return this.#spinner;
        this.#spinner.hidden = true;
        this.#tab_contents = {};

        this.#tab_header = new TabHeaderElement({
            has_3d: this.has_3d,
            has_pcb: this.has_pcb,
            sch_count: this.sch_count,
            has_bom: this.has_bom,
        });

        if (window.hide_header) {
            this.#tab_header.hidden = true;
        }

        this.#tab_header.input_container = this;
        this.#tab_header.addEventListener(TabActivateEvent.type, (event) => {
            const tab = (event as TabActivateEvent).detail;
            this.#active_tab = tab.current;
            this.dispatchEvent(new TabActivateEvent(tab));
            this.#merge_view_state({ activeTab: tab.current });
            this.#emit_view_state_change();
            if (tab.previous) {
                switch (tab.previous) {
                    case TabKind.pcb:
                        if (this.#board_app)
                            this.#board_app.tabMenuHidden = true;
                        break;
                    case TabKind.sch:
                        if (this.#schematic_app)
                            this.#schematic_app.tabMenuHidden = true;
                        break;
                    case TabKind.bom:
                        break;
                    case TabKind.step:
                        break;
                }
            }

            Object.values(this.#tab_contents).forEach((i) => {
                i.classList.remove("active");
            });
            this.#tab_contents[tab.current]?.classList.add("active");

            if (tab.current === TabKind.step) {
                if (this.#ov_d_app) this.#ov_d_app.on_show();
                else {
                    (async () => {
                        // 3D viewer 在运行时按需加载。
                        // 旧实现依赖 importmap 将裸模块名 "3d-viewer" 映射到实际文件；
                        // 在 QNotes 的 vendor 静态环境下更稳妥的方式是使用相对 URL。
                        const modUrl = new URL("./3d-viewer.js", import.meta.url).toString();
                        // eslint-disable-next-line @typescript-eslint/ban-ts-comment
                        // @ts-ignore dynamic import by url
                        await import(/* @vite-ignore */ modUrl);
                        this.#ov_d_app =
                            html`<ecad-3d-viewer></ecad-3d-viewer>` as Online3dViewer;
                        this.#viewers_container.appendChild(this.#ov_d_app);
                        const page = embed_to_tab(this.#ov_d_app, TabKind.step);
                        page.classList.add("active");
                        page.style.display = "none";
                    })();
                }
            }
        });

        this.#tab_header.addEventListener(TabMenuClickEvent.type, (event) => {
            const tab = (event as TabMenuClickEvent).detail;
            switch (tab) {
                case TabKind.pcb:
                    this.#board_app.tabMenuHidden =
                        !this.#board_app.tabMenuHidden;
                    break;
                case TabKind.sch:
                    this.#schematic_app.tabMenuHidden =
                        !this.#schematic_app.tabMenuHidden;
                    break;
                case TabKind.bom:
                    break;
            }
        });

        this.#tab_header.addEventListener(OpenBarrierEvent.type, (event) => {
            if (this.#spinner) {
                this.#spinner.hidden = false;
                this.#content.hidden = true;
            }
        });

        const embed_to_tab = (page: HTMLElement, index: TabKind) => {
            this.#tab_contents[index] = page;
            page.classList.add("tab-content");
            page.addEventListener(TabMenuVisibleChangeEvent.type, (event) => {
                const visible = (event as TabMenuVisibleChangeEvent).detail;
                this.#tab_header.tabMenuChecked = visible;
            });
            return page;
        };

        if (this.has_pcb) {
            this.#board_app = html`<kc-board-app>
            </kc-board-app>` as KCBoardAppElement;
            embed_to_tab(this.#board_app, TabKind.pcb);
            if (!this.#project.has_3d) {
                try {
                    this.#project
                        .get_file_text(
                            this.#project.get_first_page(AssertType.PCB)!
                                .filename,
                        )
                        .then((v) => {
                            if (v)
                                window.dispatchEvent(new BoardContentReady(v));
                        });
                } catch (e) {
                    alert(e);
                }
            }
        }

        if (this.has_sch) {
            this.#schematic_app = html`<kc-schematic-app>
            </kc-schematic-app>` as KCSchematicAppElement;
            this.#tab_contents[TabKind.sch] = this.#schematic_app;
            embed_to_tab(this.#schematic_app, TabKind.sch);
            this.#schematic_app.addEventListener(SheetLoadEvent.type, (e) => {
                this.#tab_header.dispatchEvent(new SheetLoadEvent(e.detail));
                // Re-dispatch from viewer so visualizer can track active sheet
                this.dispatchEvent(new SheetLoadEvent(e.detail));
            });
        }

        if (this.has_3d) {
            this.#step_viewer_placeholder =
                html`<ecad-spinner></ecad-spinner>` as HTMLElement;
            embed_to_tab(this.#step_viewer_placeholder, TabKind.step);
            this.project.addEventListener(Online3dViewerLoaded.type, () => {
                this.#step_viewer_placeholder.hidden = true;
                this.#ov_d_app.style.display = "";
            });
        }
        if (this.has_bom) {
            this.#bom_app = new BomApp();
            embed_to_tab(this.#bom_app, TabKind.bom);
        }

        this.#viewers_container = html` <div class="vertical">
            ${this.#board_app} ${this.#schematic_app} ${this.#bom_app}
            ${this.#step_viewer_placeholder}
        </div>` as HTMLDivElement;

        this.#content = html` <div class="vertical">
            ${this.#tab_header} ${this.#viewers_container}
            <a
                href=${window.ai_url}
                class="bottom-left-icon"
                target="_blank"
                rel="noopener noreferrer"
                aria-label="Visit EDA website">
                ${HQ_LOGO}
            </a>
        </div>` as HTMLElement;
        return html` ${this.#content} ${this.#spinner} `;
    }
}

window.customElements.define("ecad-viewer", ECadViewer);

class EcadSourceElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    src: string | null;
}

window.customElements.define("ecad-source", EcadSourceElement);

class EcadBlobElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    filename: string;

    @attribute({ type: String })
    content: string;
}

window.customElements.define("ecad-blob", EcadBlobElement);

class Ov3dElement extends CustomElement {
    constructor() {
        super();
        this.ariaHidden = "true";
        this.hidden = true;
        this.style.display = "none";
    }

    @attribute({ type: String })
    src: string | null;
}
window.customElements.define("ecad-3d-source", Ov3dElement);
