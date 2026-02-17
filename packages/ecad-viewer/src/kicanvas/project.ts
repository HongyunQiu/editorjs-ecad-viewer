/*
    Copyright (c) 2023 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

import { sorted_by_numeric_strings } from "../base/array";
import { Barrier } from "../base/async";
import { type IDisposable } from "../base/disposable";
import { first, length, map } from "../base/iterator";
import { Logger } from "../base/log";
import { type Constructor } from "../base/types";
import { KicadPCB, KicadSch, ProjectSettings } from "../kicad";
import {
    BoardBomItemVisitor,
    type DesignatorRef,
} from "../kicad/board_bom_visitor";
import type { BomItem } from "../kicad/bom_item";
import { ItemsGroupedByFpValueDNP } from "../kicad/ItemsGroupedByFpValueDNP";
import { NetRef } from "../kicad/net_ref";
import type {
    SchematicSheet,
    SchematicSheetInstance,
} from "../kicad/schematic";
import { SchematicBomVisitor } from "../kicad/schematic_bom_visitor";
import { NewStrokeGlyph } from "../kicad/text/newstroke-glyphs";

import {
    FetchFileSystem,
    type EcadBlob,
    type EcadSources,
} from "./services/vfs";
import "../ecad-viewer/ecad_viewer_global";

const log = new Logger("kicanvas:project");

type ProjectPageSnapshot = {
    filename: string;
    sheet_path: string;
    name?: string;
    page?: string;
};

type ProjectSnapshot = {
    createdAt: number;
    lastUsedAt: number;
    // core
    files_by_name: Map<string, KicadPCB | KicadSch>;
    file_content: Map<string, string>;
    pcb: KicadPCB[];
    sch: KicadSch[];
    ov_3d_url?: string;
    bom_items: BomItem[];
    label_name_refs: Map<string, NetRef[]>;
    net_item_refs: Map<string, NetRef>;
    designator_refs: Map<string, DesignatorRef>;
    project_name: string;
    settings: ProjectSettings;
    active_sch_name?: string;
    found_cjk: boolean;
    // pages
    root_page?: ProjectPageSnapshot;
    pages: ProjectPageSnapshot[];
};

// 解析缓存：避免相同工程在 editor 重新创建组件时重复解析
const PROJECT_CACHE_MAX = 3;
const PROJECT_CACHE_TTL_MS = 10 * 60 * 1000; // 10min
const projectSnapshotCache = new Map<string, ProjectSnapshot>();

function nowMs(): number {
    return Date.now();
}

function hashLite(s: string): string {
    // 轻量 hash，避免把大内容塞进 key
    let h = 5381;
    const n = Math.min(s.length, 4096);
    for (let i = 0; i < n; i++) {
        h = ((h << 5) + h) ^ s.charCodeAt(i);
    }
    // include length to reduce collisions
    return `${(h >>> 0).toString(16)}:${s.length}`;
}

function sourcesKey(sources: EcadSources): string {
    const urlsKey = (sources.urls ?? []).join("|");
    const blobsKey = (sources.blobs ?? [])
        .map((b) => `${b.filename}:${hashLite(String(b.content ?? ""))}`)
        .join("|");
    return `u:${urlsKey}#b:${blobsKey}`;
}

function evictProjectCacheIfNeeded() {
    const t = nowMs();
    for (const [k, v] of projectSnapshotCache) {
        if (t - v.lastUsedAt > PROJECT_CACHE_TTL_MS) projectSnapshotCache.delete(k);
    }
    if (projectSnapshotCache.size <= PROJECT_CACHE_MAX) return;
    const items = Array.from(projectSnapshotCache.entries()).sort(
        (a, b) => a[1].lastUsedAt - b[1].lastUsedAt,
    );
    while (projectSnapshotCache.size > PROJECT_CACHE_MAX && items.length) {
        const victim = items.shift()!;
        projectSnapshotCache.delete(victim[0]);
    }
}

export enum AssertType {
    SCH,
    PCB,
}

export class Project extends EventTarget implements IDisposable {
    _fs = new FetchFileSystem();
    _files_by_name: Map<string, KicadPCB | KicadSch> = new Map();
    _file_content: Map<string, string> = new Map();
    _pcb: KicadPCB[] = [];
    _sch: KicadSch[] = [];
    _ov_3d_url?: string;
    // jwfjewfj
    _bom_items: BomItem[] = [];
    _label_name_refs = new Map<string, NetRef[]>();
    _net_item_refs = new Map<string, NetRef>();
    _designator_refs = new Map<string, DesignatorRef>();
    _project_name: string;
    active_sch_file_name?: string;
    _found_cjk = false;

    find_labels_by_name(name: string) {
        return this._label_name_refs.get(name);
    }

    find_net_item(uuid: string) {
        return this._net_item_refs.get(uuid);
    }

    find_designator(d: string) {
        return this._designator_refs.get(d);
    }

    get bom_items() {
        return this._bom_items;
    }

    public active_sch_name: string;

    public loaded: Barrier = new Barrier();
    public settings: ProjectSettings = new ProjectSettings();
    _root_schematic_page?: ProjectPage;
    _pages_by_path: Map<string, ProjectPage> = new Map();

    get pages() {
        return Array.from(this._pages_by_path.values());
    }

    get project_name() {
        if (this._project_name) return this._project_name;

        const fn =
            (this._pcb.length
                ? this._pcb[0]?.filename
                : this._sch.length
                  ? this._root_schematic_page?.filename
                  : "") ?? "";

        const fns = fn.split(".");

        if (fns.length > 1) {
            return fns.slice(0, -1).join(".");
        }
        return fn;
    }

    public dispose() {
        for (const i of [this._pcb, this._sch]) i.length = 0;
        this._files_by_name.clear();
        this._pages_by_path.clear();
        this._file_content.clear();
        this._label_name_refs.clear();
        this._net_item_refs.clear();
        this._designator_refs.clear();
    }

    public static async import_cjk_glyphs() {
        // @ts-expect-error It's imported in the import map
        await import("glyph-full").then((mod) => {
            NewStrokeGlyph.glyph_data = mod.glyph_data;
        });
    }

    public async load(sources: EcadSources) {
        const key = sourcesKey(sources);
        const cached = projectSnapshotCache.get(key);
        if (cached && nowMs() - cached.lastUsedAt <= PROJECT_CACHE_TTL_MS) {
            cached.lastUsedAt = nowMs();
            evictProjectCacheIfNeeded();

            // Reset current state
            this.dispose();
            this._fs = new FetchFileSystem(sources.urls);

            this._files_by_name = new Map(cached.files_by_name);
            this._file_content = new Map(cached.file_content);
            this._pcb = Array.from(cached.pcb);
            this._sch = Array.from(cached.sch);
            this._ov_3d_url = cached.ov_3d_url;
            this._bom_items = Array.from(cached.bom_items);
            this._label_name_refs = new Map(cached.label_name_refs);
            this._net_item_refs = new Map(cached.net_item_refs);
            this._designator_refs = new Map(cached.designator_refs);
            this._project_name = cached.project_name;
            this.settings = cached.settings;
            this.active_sch_name = cached.active_sch_name as any;
            this._found_cjk = cached.found_cjk;

            this._pages_by_path = new Map();
            for (const p of cached.pages) {
                const page = new ProjectPage(
                    this,
                    p.filename,
                    p.sheet_path,
                    p.name,
                    p.page,
                );
                this._pages_by_path.set(page.project_path, page);
            }
            if (cached.root_page) {
                const rp = new ProjectPage(
                    this,
                    cached.root_page.filename,
                    cached.root_page.sheet_path,
                    cached.root_page.name,
                    cached.root_page.page,
                );
                this._root_schematic_page = rp;
            } else {
                this._root_schematic_page = undefined;
            }

            this.loaded.open();
            this.dispatchEvent(
                new CustomEvent("load", {
                    detail: this,
                }),
            );
            return;
        }

        this._fs = new FetchFileSystem(sources.urls);

        const promises = [];

        for (const filename of this._fs.list()) {
            promises.push(this._load_file(filename));
        }

        for (const blob of sources.blobs) {
            if (blob.filename.startsWith(".")) continue;
            if (blob.filename.endsWith(".kicad_pcb")) {
                promises.push(this._load_blob(KicadPCB, blob));
            } else if (blob.filename.endsWith(".kicad_sch")) {
                promises.push(this._load_blob(KicadSch, blob));
            } else if (blob.filename.endsWith(".kicad_pro")) {
                this._project_name = blob.filename.slice(
                    0,
                    blob.filename.length - ".kicad_pro".length,
                );
                const data = JSON.parse(blob.content);
                this.settings = ProjectSettings.load(data);
            }
        }

        await Promise.all(promises);

        if (this._found_cjk) {
            await Project.import_cjk_glyphs();
        }

        let has_root_sch = false;

        if (this.has_schematics)
            has_root_sch = this._determine_schematic_hierarchy();

        const bom_items = (() => {
            if (this.has_schematics) {
                const sch_visitor = new SchematicBomVisitor();
                if (has_root_sch) {
                    for (const page of this.pages) {
                        const doc = page.document;
                        if (doc instanceof KicadSch) sch_visitor.visit(doc);
                    }
                } else {
                    for (const sch of this.schematics()) {
                        sch_visitor.visit(sch);
                    }
                }

                this._designator_refs = sch_visitor.designator_refs;
                if (sch_visitor.bom_list.length) return sch_visitor.bom_list;
            }
            if (this.has_boards) {
                const visitor = new BoardBomItemVisitor();
                for (const b of this.boards()) visitor.visit(b);
                this._designator_refs = visitor.designator_refs;
                return visitor.bom_list;
            }
            return [];
        })();
        this._sort_bom(bom_items);

        this.loaded.open();

        this.dispatchEvent(
            new CustomEvent("load", {
                detail: this,
            }),
        );

        // 写入解析缓存（用于 editor 重建时复用）
        try {
            const snap: ProjectSnapshot = {
                createdAt: nowMs(),
                lastUsedAt: nowMs(),
                files_by_name: new Map(this._files_by_name),
                file_content: new Map(this._file_content),
                pcb: Array.from(this._pcb),
                sch: Array.from(this._sch),
                ov_3d_url: this._ov_3d_url,
                bom_items: Array.from(this._bom_items),
                label_name_refs: new Map(this._label_name_refs),
                net_item_refs: new Map(this._net_item_refs),
                designator_refs: new Map(this._designator_refs),
                project_name: this._project_name,
                settings: this.settings,
                active_sch_name: this.active_sch_name,
                found_cjk: this._found_cjk,
                root_page: this._root_schematic_page
                    ? {
                          filename: this._root_schematic_page.filename,
                          sheet_path: this._root_schematic_page.sheet_path,
                          name: this._root_schematic_page.name,
                          page: this._root_schematic_page.page,
                      }
                    : undefined,
                pages: Array.from(this._pages_by_path.values()).map((p) => ({
                    filename: p.filename,
                    sheet_path: p.sheet_path,
                    name: p.name,
                    page: p.page,
                })),
            };
            projectSnapshotCache.set(key, snap);
            evictProjectCacheIfNeeded();
        } catch (_) {}
    }

    _sort_bom(bom_list: BomItem[]) {
        const grouped_it_map: Map<string, ItemsGroupedByFpValueDNP> = new Map();

        const group_by_fp_value = (itm: BomItem) =>
            `${itm.Footprint}-${itm.Name}-${itm.DNP}`;

        for (const it of bom_list) {
            const key = group_by_fp_value(it);

            if (!grouped_it_map.has(key)) {
                grouped_it_map.set(
                    key,
                    new ItemsGroupedByFpValueDNP(
                        it.Name,
                        it.Datasheet,
                        it.Description,
                        it.Footprint,
                        it.DNP,
                    ),
                );
            }
            grouped_it_map.get(key)!.addReference(it.Reference);
        }
        this._bom_items = Array.from(grouped_it_map.values());
    }
    public get root_schematic_page() {
        return this._root_schematic_page;
    }

    async _load_file(filename: string) {
        log.info(`Loading file ${filename}`);

        if (filename.endsWith(".kicad_sch")) {
            return await this._load_doc(KicadSch, filename);
        }
        if (filename.endsWith(".kicad_pcb")) {
            return await this._load_doc(KicadPCB, filename);
        }
        if (filename.endsWith(".kicad_pro")) {
            return this._load_meta(filename);
        }

        log.warn(`Couldn't load ${filename}: unknown file type`);
    }

    async _load_doc(
        document_class: Constructor<KicadPCB | KicadSch>,
        filename: string,
    ) {
        if (this._files_by_name.has(filename)) {
            return this._files_by_name.get(filename);
        }

        const text = await this.get_file_text(filename);
        return this._load_blob(document_class, {
            filename,
            content: text!,
        });
    }

    async _load_blob(
        document_class: Constructor<KicadPCB | KicadSch>,
        blob: EcadBlob,
    ) {
        const file_content = blob.content;
        // Check if file content contains CJK characters
        if (
            !this._found_cjk &&
            file_content.match(
                /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff\u3040-\u309f\uac00-\ud7af]/,
            ) !== null
        ) {
            this._found_cjk = true;
        }

        if (this._files_by_name.has(blob.filename)) {
            return this._files_by_name.get(blob.filename);
        }
        const filename = blob.filename;
        const doc = new document_class(filename, file_content);
        this._files_by_name.set(filename, doc);
        if (doc instanceof KicadPCB) this._pcb.push(doc);
        else {
            this._sch.push(doc);

            for (const it of doc.labels) {
                if (it.uuid) {
                    const ref = new NetRef(doc.filename, it.text, it.uuid);
                    this._net_item_refs.set(it.uuid, ref);

                    if (!this._label_name_refs.has(it.text))
                        this._label_name_refs.set(it.text, []);

                    this._label_name_refs.get(it.text)!.push(ref);
                }
            }
        }
        this._files_by_name.set(filename, doc);
        this._file_content.set(filename, file_content);
        return doc;
    }

    async _load_meta(filename: string) {
        const text = await this.get_file_text(filename);
        const data = JSON.parse(text!);
        this.settings = ProjectSettings.load(data);
    }

    async get_file_text(filename: string) {
        if (this._file_content.has(filename))
            return this._file_content.get(filename);
        return await (await this._fs.get(filename)).text();
    }

    public *files() {
        yield* this._files_by_name.values();
    }

    *sch_in_order() {
        for (const p of this.pages) {
            yield this.file_by_name(p.filename) ??
                // AD HOC for ad converted sch
                this.file_by_name(p.sheet_path);
        }
    }

    public file_by_name(name: string) {
        if (this._files_by_name.has(name)) {
            return this._files_by_name.get(name);
        }

        // Fuzzy match: check if any stored filename ends with the requested name
        for (const [key, value] of this._files_by_name) {
            if (key.endsWith(`/${name}`)) {
                return value;
            }
        }

        return undefined;
    }

    public *boards() {
        for (const value of this._files_by_name.values()) {
            if (value instanceof KicadPCB) {
                yield value;
            }
        }
    }

    public get has_3d() {
        return (
            this._ov_3d_url !== undefined ||
            window.design_urls?.glb_url !== undefined
        );
    }

    public set ov_3d_url(url: string | undefined) {
        this._ov_3d_url = url;
    }

    public get ov_3d_url() {
        return this._ov_3d_url;
    }

    public get has_boards() {
        return (
            length(this.boards()) > 0 ||
            window.design_urls?.pcb_url !== undefined
        );
    }

    public *schematics() {
        for (const [, v] of this._files_by_name) {
            if (v instanceof KicadSch) {
                yield v;
            }
        }
    }

    public get has_schematics() {
        return (
            length(this.schematics()) > 0 ||
            window.design_urls?.sch_url !== undefined
        );
    }

    public get_first_page(kind: AssertType) {
        switch (kind) {
            case AssertType.SCH:
                return (
                    (this._files_by_name.get(
                        `${this._project_name}.kicad_sch`,
                    ) as KicadSch) ??
                    this.root_schematic_page?.document ??
                    first(this._sch)
                );
            case AssertType.PCB:
                return first(this._pcb);
        }
    }

    public page_by_path(project_path: string) {
        return this._files_by_name.get(project_path);
    }

    public get is_empty() {
        return length(this.files()) === 0;
    }

    public on_loaded() {
        this.dispatchEvent(
            new CustomEvent("change", {
                detail: this,
            }),
        );
    }

    public activate_sch(page_or_path: string) {
        this.active_sch_name = page_or_path;
        this.dispatchEvent(
            new CustomEvent("change", {
                detail: this,
            }),
        );
    }

    _determine_schematic_hierarchy() {
        const paths_to_schematics = new Map<string, KicadSch>();
        const paths_to_sheet_instances = new Map<
            string,
            { sheet: SchematicSheet; instance: SchematicSheetInstance }
        >();

        for (const schematic of this.schematics()) {
            paths_to_schematics.set(`/${schematic.uuid}`, schematic);

            for (const sheet of schematic.sheets) {
                const sheet_sch = this._files_by_name.get(
                    sheet.sheetfile ?? "",
                ) as KicadSch;

                if (!sheet_sch) {
                    continue;
                }

                for (const instance of sheet.instances.values()) {
                    // paths_to_schematics.set(instance.path, schematic);
                    paths_to_sheet_instances.set(
                        `${instance.path}/${sheet.uuid}`,
                        {
                            sheet: sheet,
                            instance: instance,
                        },
                    );
                }
            }
        }

        // Find the root sheet. This is done by sorting all of the paths
        // from shortest to longest and walking through the paths to see if
        // we can find the schematic for the parent. The first one we find
        // it the common ancestor (root).
        const paths = Array.from(paths_to_sheet_instances.keys()).sort(
            (a, b) => a.length - b.length,
        );

        let root: KicadSch | undefined;
        let found_root = false;
        for (const path of paths) {
            const parent_path = path.split("/").slice(0, -1).join("/");

            if (!parent_path) {
                continue;
            }

            root = paths_to_schematics.get(parent_path);

            if (root) {
                found_root = true;
                break;
            }
        }

        // If we found a root page, we can build out the list of pages by
        // walking through paths_to_sheet with root as page one.
        let pages = [];

        if (root) {
            this._root_schematic_page = new ProjectPage(
                this,
                root.filename,
                `/${root!.uuid}`,
                "Root",
                "1",
            );
            pages.push(this._root_schematic_page);

            for (const [path, sheet] of paths_to_sheet_instances.entries()) {
                pages.push(
                    new ProjectPage(
                        this,
                        sheet.sheet.sheetfile!,
                        path,
                        sheet.sheet.sheetname ?? sheet.sheet.sheetfile!,
                        sheet.instance.page ?? "",
                    ),
                );
            }
        }

        // Sort the pages we've collected so far and then insert them
        // into the pages map.
        pages = sorted_by_numeric_strings(pages, (p) => p.page!);

        for (const page of pages) {
            this._pages_by_path.set(page.project_path, page);
        }

        // Add any "orphan" sheets to the list of pages now that we've added all
        // the hierarchical ones.
        const seen_schematic_files = new Set(
            map(this._pages_by_path.values(), (p) => p.filename),
        );

        for (const schematic of this.schematics()) {
            if (!seen_schematic_files.has(schematic.filename)) {
                const page = new ProjectPage(
                    this,
                    "schematic",
                    schematic.filename,
                    `/${schematic.uuid}`,
                    schematic.filename,
                );
                this._pages_by_path.set(page.project_path, page);
            }
        }

        // Finally, if no root schematic was found, just use the first one we saw.
        this._root_schematic_page = first(this._pages_by_path.values());
        return found_root;
    }
}

export class ProjectPage {
    constructor(
        public project: Project,
        public filename: string,
        public sheet_path: string,
        public name?: string,
        public page?: string,
    ) {}

    /**
     * A unique identifier for this page within the project,
     * made from the filename and sheet path.
     */
    get project_path() {
        if (this.sheet_path) {
            return `${this.filename}:${this.sheet_path}`;
        } else {
            return this.filename;
        }
    }

    get document() {
        return this.project.file_by_name(this.filename)!;
    }
}
