/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import type { CrossHightAble } from "../../base/cross_highlight_able";
import { Logger } from "../../base/log";
import { Angle, Matrix3, Vec2 } from "../../base/math";
import { Color, Renderer } from "../../graphics";
import { WebGL2Renderer } from "../../graphics/webgl";
import type { BoardTheme } from "../../kicad";
import * as board_items from "../../kicad/board";
import { unescape_string } from "../../kicad/common";
import { StrokeFont, TextAttributes } from "../../kicad/text";
import {
    BoardBBoxVisitor,
    type BoardInteractiveItem,
    Depth,
    type NetProperty,
} from "../../kicad/board_bbox_visitor";
import type { KCBoardLayersPanelElement } from "../../kicanvas/elements/kc-board/layers-panel";
import { DocumentViewer } from "../base/document-viewer";
import { CommentClickEvent, KiCanvasFitterMenuEvent, KiCanvasSelectEvent } from "../base/events";
import type { VisibilityType } from "../base/view-layers";
import { ViewerType } from "../base/viewer";
import {
    LabelLayerNames,
    LayerNames,
    LayerSet,
    ViewLayer,
    track_netname_label_layer_for,
} from "./layers";
import { BoardPainter } from "./painter";
import { OrderedMap } from "immutable";
const log = new Logger("pcb:viewer");

export const ZONE_DEFAULT_OPACITY = 0.6;

export class BoardViewer extends DocumentViewer<
    board_items.KicadPCB,
    BoardPainter,
    LayerSet,
    BoardTheme
> {
    #should_restore_visibility = false;
    #zones_visibility = new Map<string, VisibilityType>();
    #layer_visibility_ctrl: KCBoardLayersPanelElement;

    set layer_visibility_ctrl(ctr: KCBoardLayersPanelElement) {
        this.#layer_visibility_ctrl = ctr;
    }
    public highlight_net(num: number | null) {
        this.#layer_visibility_ctrl.clear_highlight();
        if (this.painter.paint_net(this.board, num, this.layer_visibility)) {
            this.#should_restore_visibility = false;
            if (num) {
                this.#should_restore_visibility = true;
                for (const layer of this.layers.in_ui_order()) {
                    layer.visible = false;
                }
            }
            this.draw();
        }
        if (num) {
            this.dispatchEvent(
                new KiCanvasSelectEvent({
                    item: {
                        net: this.board.getNetName(num),
                        ...this.#net_info.get(num),
                    },
                    previous: null,
                }),
            );
        }
    }

    /**
     * 清除当前 net focus（恢复图层可见性、清 interactive），并派发事件通知外部状态已变为“未选中”。
     */
    public clear_net_focus() {
        if (this.#should_restore_visibility) {
            const visibilities = this.layer_visibility;
            for (const layer of this.layers.in_ui_order()) {
                layer.visible = visibilities.get(layer.name)!;
            }
            this.#should_restore_visibility = false;
            this.painter.clear_interactive();
            this.draw();
        }
        // 通知外部：当前没有任何 net 被选中
        try {
            this.dispatchEvent(
                new CustomEvent("kicanvas:net-focus-change", {
                    detail: { netNumber: null },
                }),
            );
        } catch (_) {}
    }
    protected override on_document_clicked(): void {
        if (this.#should_restore_visibility) {
            const visibilities = this.layer_visibility;
            for (const layer of this.layers.in_ui_order()) {
                layer.visible = visibilities.get(layer.name)!;
            }
            this.#should_restore_visibility = false;
            this.painter.clear_interactive();
            this.draw();

            // 点击空白/其它元素导致 net focus 被取消：上报给外部用于持久化
            try {
                this.dispatchEvent(
                    new CustomEvent("kicanvas:net-focus-change", {
                        detail: { netNumber: null },
                    }),
                );
            } catch (_) {}
        }

        if (this.#zones_visibility.size) {
            this.painter.clear_interactive();
            for (const layer of this.layers.zone_layers()) {
                layer.visible = this.#zones_visibility.get(layer.name)!;
            }
            this.#zones_visibility.clear();
            this.draw();
        }
    }

    public highlight_fp(fp: board_items.Footprint) {
        if (!this.#zones_visibility.size)
            for (const layer of this.layers.zone_layers()) {
                this.#zones_visibility.set(layer.name, layer.visibility);
                layer.visible = false;
            }
        this.painter.paint_footprint(fp);
        this.draw();
    }

    public focus_net(num: number | null) {
        this.highlight_net(num);
        const net_bbox = this.painter.net_bbox;
        if (net_bbox) {
            this.viewport.camera.bbox = net_bbox.grow(
                net_bbox.w * 0.5,
                net_bbox.h * 0.5,
            );
        }
    }

    override on_click(pos: Vec2, event?: MouseEvent): void {
        const items = this.find_items_under_pos(pos);

        // In comment mode, dispatch CommentClickEvent with element info
        if (this.commentModeEnabled && event) {
            // Only dispatch if we found an element
            if (items.length > 0) {
                const it = items[0]!;
                const item = it.item as any;

                // const rect = this.canvas.getBoundingClientRect();
                this.dispatchEvent(
                    new CommentClickEvent({
                        worldX: pos.x,
                        worldY: pos.y,
                        screenX: event.clientX,
                        screenY: event.clientY,
                        layer: it.is_on_layer?.("F.Cu") ? "F.Cu" : "B.Cu",
                        context: "PCB",
                        elementType: item?.typeId || "Unknown",
                        elementId: item?.uuid || "",
                        elementRef: item?.reference || item?.designator || "",
                        element: item,
                    }),
                );
            }
            // Don't dispatch select event in comment mode
            return;
        }

        // Normal mode - dispatch selection events
        if (items.length > 0) {
            if (items.length == 1) {
                const it = items[0];
                if (it) {
                    this.dispatchEvent(
                        new KiCanvasSelectEvent({
                            item: it.item,
                            previous: null,
                        }),
                    );
                    this.dispatchEvent(
                        new KiCanvasFitterMenuEvent({
                            items: [],
                        }),
                    );
                }
            } else {
                this.dispatchEvent(
                    new KiCanvasSelectEvent({
                        item: null,
                        previous: null,
                    }),
                );
                this.dispatchEvent(
                    new KiCanvasFitterMenuEvent({
                        items: items,
                    }),
                );
            }
        }
    }

    get layer_visibility() {
        return this.#layer_visibility_ctrl?.visibilities ?? null;
    }

    find_items_under_pos(pos: Vec2) {
        const items: BoardInteractiveItem[] = [];

        if (!this.#layer_visibility_ctrl) return items;

        const visible_layers: Set<string> = new Set();
        for (const [k, v] of this.layer_visibility)
            if (v) visible_layers.add(k);

        const is_item_visible = (item: BoardInteractiveItem) => {
            for (const layer of visible_layers)
                if (item.is_on_layer(layer)) return true;

            return false;
        };

        const check_depth = (depth: Depth) => {
            const layer_items = this.#interactive.get(depth) ?? [];
            if (layer_items.length)
                for (const i of layer_items) {
                    if (i.contains(pos) && is_item_visible(i)) {
                        items.push(i);
                    }
                }
        };

        for (const [depth] of this.#interactive) {
            switch (depth) {
                case Depth.GRAPHICS:
                    break;
                case Depth.VIA:
                case Depth.PAD:
                case Depth.LINE_SEGMENTS:
                    check_depth(depth);
                    break;
                case Depth.FOOT_PRINT:
                case Depth.ZONE:
                    break;
            }
        }

        // look up the footprints then
        if (!items.length) check_depth(Depth.FOOT_PRINT);

        // look up the zones finally
        if (!items.length) check_depth(Depth.ZONE);

        return items;
    }

    override on_dblclick(pos: Vec2): void {
        const items = this.find_items_under_pos(pos);

        if (items.length > 0) {
            {
                const it = items[0]!;
                if (it.net) {
                    this.highlight_net(it.net);
                } else if (it.item?.typeId === "Footprint") {
                    this.painter.filter_net = null;
                    this.highlight_fp(it.item as board_items.Footprint);
                }
            }
        }
    }
    override type: ViewerType = ViewerType.PCB;

    #interactive: OrderedMap<Depth, BoardInteractiveItem[]> = OrderedMap();

    #net_info: Map<number, NetProperty>;

    #last_hover: BoardInteractiveItem | null = null;

    #highlighted_track = true;

    set_highlighted_track(val: boolean) {
        this.#highlighted_track = val;
    }

    get_highlighted_track(): boolean {
        return this.#highlighted_track;
    }

    public override draw(): void {
        this.#update_dynamic_track_net_labels();
        super.draw();
    }

    #update_dynamic_track_net_labels() {
        try {
            const st = this.layers as LayerSet;
            if (!st) return;

            if (!this.viewport?.camera) return;
            const viewport = this.viewport.camera.bbox;
            if (!viewport?.valid) return;

            // LOD / zoom thresholds (KiCad-like):
            // - tracks: lodScaleForThreshold(width, 4.0mm)
            // - vias:   lodScaleForThreshold(width, 10.0mm)
            // We approximate this by requiring camera.zoom >= threshold_mm / width_mm.
            const track_netlabel_threshold_mm = 4.0;
            const via_netlabel_threshold_mm = 10.0;

            const mmToIU = 10000;
            const char_count = (s: string) => Array.from(s || "").length;
            const strip_net_path = (name: string) => {
                const idx = name.lastIndexOf("/");
                return idx >= 0 ? name.slice(idx + 1) : name;
            };
            const normalize_unconnected_netname = (name: string) => {
                if (!name) return name;
                return name.toLowerCase().startsWith("unconnected") ? "x" : name;
            };

            const normalize_upright_deg = (deg: number) => {
                let a = deg;
                while (a > 90) a -= 180;
                while (a <= -90) a += 180;
                return a;
            };

            const draw_text = (
                text: string,
                pos_mm: Vec2,
                glyph_mm: number,
                stroke_mm: number,
                angle_deg: number,
                color: Color,
            ) => {
                if (!text) return;
                const attrs = new TextAttributes();
                attrs.h_align = "center";
                attrs.v_align = "center";
                attrs.multiline = false;
                attrs.keep_upright = false;
                attrs.angle = Angle.from_degrees(angle_deg);
                attrs.color = color;
                attrs.size = new Vec2(glyph_mm * mmToIU, glyph_mm * mmToIU);
                attrs.stroke_width = stroke_mm * mmToIU;

                StrokeFont.default().draw(
                    this.renderer,
                    text,
                    new Vec2(pos_mm.x * mmToIU, pos_mm.y * mmToIU),
                    attrs,
                );
            };

            // "High contrast" approximation:
            // If a copper layer is highlighted, only show net labels for that layer.
            const high_contrast_primary_cu =
                st.is_any_layer_highlighted?.() === true
                    ? st.primary_high_contrast_copper_layer_name?.() ?? null
                    : null;

            // Early out if nothing is enabled
            const via_layer = st.by_name(LabelLayerNames.via_net_names);
            const any_via_enabled =
                !!via_layer && via_layer.opacity !== 0 && via_layer.visible;

            let any_track_enabled = false;
            if (high_contrast_primary_cu) {
                const l = st.by_name(
                    track_netname_label_layer_for(high_contrast_primary_cu),
                );
                any_track_enabled = !!l && l.opacity !== 0 && l.visible;
            } else {
                for (const it of st.track_netname_label_layers?.() ?? []) {
                    if (it && it.opacity !== 0 && it.visible) {
                        any_track_enabled = true;
                        break;
                    }
                }
            }

            if (!any_track_enabled && !any_via_enabled) return;

            // Bucket track segments by their copper layer to avoid O(Nlayers*Nsegs)
            const seg_by_layer: Map<string, board_items.LineSegment[]> = new Map();
            for (const seg of this.board.segments) {
                if (!(seg instanceof board_items.LineSegment)) continue;
                if (!seg_by_layer.has(seg.layer)) seg_by_layer.set(seg.layer, []);
                seg_by_layer.get(seg.layer)!.push(seg);
            }

            // Tracks: rebuild per-copper-layer netname label layers (KiCad-like)
            for (const cu_layer of st.copper_layers()) {
                if (high_contrast_primary_cu && cu_layer.name !== high_contrast_primary_cu)
                    continue;

                const label_name = track_netname_label_layer_for(cu_layer.name);
                const label_layer = st.by_name(label_name);
                if (!label_layer) continue;
                if (label_layer.opacity === 0) continue;
                if (!label_layer.visible) continue;

                const segs = seg_by_layer.get(cu_layer.name) ?? [];
                if (!segs.length) {
                    // Still clear old graphics so toggling layers doesn't leave stale labels.
                    label_layer.clear();
                    continue;
                }

                label_layer.clear();
                this.renderer.start_layer(label_layer.name);
                this.renderer.state.push();
                this.renderer.state.matrix = Matrix3.identity();

                for (const seg of segs) {
                    if (seg.net <= 0) continue;

                    // LOD/zoom threshold (KiCad-like)
                    const width_mm = Math.max(seg.width, 1e-6);
                    const zoom_req = track_netlabel_threshold_mm / width_mm;
                    if (this.viewport.camera.zoom < zoom_req) continue;

                    const netname = strip_net_path(
                        unescape_string(this.board.getNetName(seg.net) || ""),
                    );
                    const display_netname = normalize_unconnected_netname(netname);
                    if (!display_netname) continue;

                    const num_char = char_count(display_netname);
                    if (!num_char) continue;

                    const dx = seg.end.x - seg.start.x;
                    const dy = seg.end.y - seg.start.y;
                    const len_sq = dx * dx + dy * dy;
                    const min_len = seg.width * num_char;
                    if (len_sq < min_len * min_len) continue;

                    const len = Math.sqrt(len_sq);
                    let angle_deg = 0;
                    let num_names = 1;

                    const eps = 1e-9;
                    if (Math.abs(dy) <= eps) {
                        angle_deg = 0;
                        num_names = Math.max(1, Math.round(len / viewport.w));
                    } else if (Math.abs(dx) <= eps) {
                        angle_deg = 90;
                        num_names = Math.max(1, Math.round(len / viewport.h));
                    } else {
                        angle_deg = -Angle.rad_to_deg(Math.atan2(dy, dx));
                        angle_deg = normalize_upright_deg(angle_deg);

                        const min_size = Math.min(viewport.w, viewport.h);
                        num_names = Math.max(
                            1,
                            Math.round(len / (Math.SQRT2 * min_size)),
                        );
                    }

                    const divisions = num_names + 1;
                    const segV = new Vec2(dx, dy);

                    const text_size = seg.width;
                    const glyph_size = text_size * 0.55;
                    const stroke_w = text_size / 12.0;

                    const color = Color.white;

                    for (let ii = 1; ii < divisions; ii++) {
                        const t = ii / divisions;
                        const pos = seg.start.add(segV.multiply(t));
                        if (!viewport.contains_point(pos)) continue;

                        draw_text(
                            display_netname,
                            pos,
                            glyph_size,
                            stroke_w,
                            angle_deg,
                            color,
                        );
                    }
                }

                this.renderer.state.pop();
                label_layer.graphics = this.renderer.end_layer();
                label_layer.graphics.composite_operation = "source-over";
            }

            // Vias (KiCad-like: separate label layer)
            {
                if (via_layer && via_layer.opacity !== 0 && via_layer.visible) {
                    via_layer.clear();
                    this.renderer.start_layer(via_layer.name);
                    this.renderer.state.push();
                    this.renderer.state.matrix = Matrix3.identity();

                    const via_crosses_primary_layer = (via: board_items.Via, primary: string) => {
                        // through-hole vias cross all copper layers
                        if (via.type === "through-hole") return true;

                        const start = via.layers?.[0];
                        const end = via.layers?.[1];
                        if (!start || !end) return false;
                        if (primary === start || primary === end) return true;

                        // Blind/micro: only crosses between start & end layers (inclusive)
                        // Use CopperLayerNames ordering from LayerSet.copper_layers()
                        const order = Array.from(st.copper_layers()).map((l) => l.name);
                        const a = order.indexOf(start);
                        const b = order.indexOf(end);
                        const p = order.indexOf(primary);
                        if (a < 0 || b < 0 || p < 0) return false;
                        const lo = Math.min(a, b);
                        const hi = Math.max(a, b);
                        return p >= lo && p <= hi;
                    };

                    for (const via of this.board.vias) {
                        if (via.net <= 0) continue;

                        // High contrast: only show via labels if the via crosses the primary layer.
                        if (
                            high_contrast_primary_cu &&
                            !via_crosses_primary_layer(via, high_contrast_primary_cu)
                        )
                            continue;

                        const layer_vis = this.layer_visibility;
                        if (layer_vis) {
                            // Only show via netname if it crosses at least one visible copper layer.
                            const any_visible =
                                via.layers?.some((l) => layer_vis.get(l)) ??
                                false;
                            if (!any_visible) continue;
                        }

                        const netname = strip_net_path(
                            unescape_string(this.board.getNetName(via.net) || ""),
                        );
                        const display_netname =
                            normalize_unconnected_netname(netname);
                        if (!display_netname) continue;

                        const pos = via.at.position;
                        if (!viewport.contains_point(pos)) continue;

                        // LOD/zoom threshold (KiCad-like)
                        const width_mm = Math.max(via.size, 1e-6);
                        const zoom_req = via_netlabel_threshold_mm / width_mm;
                        if (this.viewport.camera.zoom < zoom_req) continue;

                        const num_char = Math.max(char_count(display_netname), 3);
                        let tsize = (1.5 * via.size) / num_char;
                        tsize = Math.min(tsize, via.size);
                        tsize *= 0.75;

                        const stroke_w = tsize / 10.0;
                        const color = Color.black;

                        draw_text(display_netname, pos, tsize, stroke_w, 0, color);
                    }

                    this.renderer.state.pop();
                    via_layer.graphics = this.renderer.end_layer();
                    via_layer.graphics.composite_operation = "source-over";
                }
            }
        } catch (_) {
            // Best-effort: labels must not break the viewer.
        }
    }

    get board(): board_items.KicadPCB {
        return this.document;
    }

    override async load(src: board_items.KicadPCB) {
        const emit_status = (phase: string, message: string, extra?: any) => {
            try {
                this.dispatchEvent(
                    new CustomEvent("kicanvas:load-status", {
                        detail: {
                            viewer: "pcb",
                            phase,
                            message,
                            ...(extra ?? {}),
                        },
                    }),
                );
            } catch (_) {}
        };
        const yield_frame = async () => {
            await new Promise<void>((resolve) =>
                window.requestAnimationFrame(() => resolve()),
            );
        };

        emit_status("pcb", "正在准备 PCB 渲染…");
        await yield_frame();
        try {
            emit_status("pcb-index", "正在构建 PCB 索引（交互/包围盒）…");
            await yield_frame();
            const visitor = new BoardBBoxVisitor();
            visitor.visit(src);

            for (let k = Depth.START; k < Depth.END; k++)
                this.#interactive = this.#interactive.set(k, []);

            for (const e of visitor.interactive_items)
                this.#interactive.get(e.depth)?.push(e);
            this.#net_info = visitor.net_info;
        } catch (e) {
            log.warn(`BoardBBoxVisitor error :${e}`);
        }
        // Painting is synchronous and can be heavy for large boards.
        // Emit a status before calling super.load() so UI can show it.
        emit_status("pcb-paint", "正在绘制 PCB 图层（可能需要较长时间）…");
        await yield_frame();
        await super.load(src);
        emit_status("pcb-post", "PCB 图层绘制完成，正在初始化视图…");
    }

    protected override create_renderer(canvas: HTMLCanvasElement): Renderer {
        const renderer = new WebGL2Renderer(canvas);
        renderer.background_color = Color.gray;
        return renderer;
    }

    protected override create_painter() {
        return new BoardPainter(this.renderer, this.layers, this.theme);
    }

    protected override create_layer_set() {
        const layers = new LayerSet(this.board, this.theme);

        for (const zone of layers.zone_layers())
            zone.opacity = ZONE_DEFAULT_OPACITY;

        for (const it of layers.hidden_txt_layers()) {
            it.opacity = 0;
        }

        return layers;
    }

    protected override get grid_origin() {
        return new Vec2(0, 0);
    }

    private set_layers_opacity(layers: Generator<ViewLayer>, opacity: number) {
        for (const layer of layers) {
            layer.opacity = opacity;
        }
        this.draw();
    }

    set track_opacity(value: number) {
        this.set_layers_opacity(
            (this.layers as LayerSet).copper_layers(),
            value,
        );
    }

    set via_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).via_layers(), value);
    }

    set zone_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).zone_layers(), value);
    }

    set pad_opacity(value: number) {
        const st = this.layers as LayerSet;

        for (const it of [st.pad_layers(), st.pad_hole_layers()])
            this.set_layers_opacity(it, value);
    }

    set grid_opacity(value: number) {
        this.set_layers_opacity((this.layers as LayerSet).grid_layers(), value);
    }

    set page_opacity(value: number) {
        this.layers.by_name(LayerNames.drawing_sheet)!.opacity = value;
        this.draw();
    }

    zoom_to_board() {
        const edge_cuts = this.layers.by_name(LayerNames.edge_cuts)!;
        const board_bbox = edge_cuts.bbox;
        this.viewport.camera.bbox = board_bbox.grow(board_bbox.w * 0.1);
    }

    findHighlightItem(pos: Vec2): CrossHightAble | null {
        return null;
    }

    findInteractive(pos: Vec2) {
        if (!this.#layer_visibility_ctrl) return null;

        const visible_layers: Set<string> = new Set();
        for (const [k, v] of this.layer_visibility)
            if (v) visible_layers.add(k);

        const is_item_visible = (item: BoardInteractiveItem) => {
            for (const layer of visible_layers)
                if (item.is_on_layer(layer)) return true;

            return false;
        };

        for (const [, v] of this.#interactive) {
            for (const e of v) {
                if (e.contains(pos) && is_item_visible(e)) {
                    return e;
                }
            }
        }
        return null;
    }

    override on_hover(_pos: Vec2) {
        const hover_item = this.findInteractive(_pos);

        if (hover_item === this.#last_hover) return;

        this.#last_hover = hover_item;

        if (
            !this.#highlighted_track &&
            hover_item?.depth === Depth.LINE_SEGMENTS
        )
            return;

        this.painter.highlight(hover_item);
        this.draw();
    }
}
