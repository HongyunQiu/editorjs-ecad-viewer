import { css, html } from "../base/web-components";
import { KCUIElement } from "../kc-ui/element";
import { ZipUtils } from "../utils/zip_utils";
import {
    TabMenuClickEvent,
    TabActivateEvent,
    SheetLoadEvent,
    OpenBarrierEvent,
} from "../viewers/base/events";
import { Sections, TabKind } from "./constraint";
import type { InputContainer } from "./input_container";
import "./ecad_viewer_global";

export interface TabData {
    title: string;
    content: HTMLElement;
}

export const is_ad = (name: string) => {
    const n = String(name || "").toLowerCase();
    return n.endsWith(".schdoc") || n.endsWith(".pcbdoc");
};

export const is_kicad = (name: string) => {
    const n = String(name || "").toLowerCase();
    return (
        n.endsWith(".kicad_pcb") ||
        n.endsWith(".kicad_sch") ||
        n.endsWith(".kicad_pro")
    );
};

export const is_3d_model = (name: string) =>
    String(name || "").toLowerCase().endsWith(".glb");

export class TabHeaderElement extends KCUIElement {
    #elements: Map<Sections, Map<TabKind, HTMLElement>>;
    #current_tab?: TabKind;
    #input_container: InputContainer;
    #collapse_btn?: HTMLElement;
    #file_name_label?: HTMLSpanElement;

    #sync_collapse_button_state() {
        const btn = this.#collapse_btn as any;
        if (!btn) return;
        const target = this.#input_container?.target as any;
        const in_fullscreen =
            !!target?.isPageFullscreenActive?.() || false;
        btn.disabled = in_fullscreen;
    }

    #sync_collapse_button_icon() {
        const btn = this.#collapse_btn as any;
        if (!btn) return;
        const target = this.#input_container?.target as any;
        const collapsed = !!target?.getViewerCollapsed?.();
        btn.icon = collapsed ? "svg:visibility_off" : "svg:visibility";
        btn.title = collapsed ? "Expand display area" : "Collapse display area";
    }

    #sync_file_name_label() {
        if (!this.#file_name_label) return;
        const target = this.#input_container?.target as any;
        const filename = String(target?.getDisplayFileName?.() || "").trim();
        try {
            console.info("[ECAD-HEADER] sync file name label =", filename);
        } catch (_) {}
        this.#file_name_label.textContent = filename || "";
        this.#file_name_label.title = filename || "";
        this.#file_name_label.style.display = filename ? "inline-block" : "none";
    }

    public constructor(
        public option: {
            has_3d: boolean;
            has_pcb: boolean;
            sch_count: number;
            has_bom: boolean;
        },
    ) {
        super();
    }

    public set tabMenuChecked(activate: boolean) {
        this.#elements
            .get(Sections.beginning)!
            .get(this.#current_tab!)
            ?.classList.toggle("checked", activate);
    }

    static override styles = [
        ...KCUIElement.styles,
        css`
            :host {
                height: var(--header-bar-size);
                width: 100%;
                flex: 1;
                display: flex;
                background-color: var(--panel-bg);
            }
            .horizontal-bar {
                display: flex;
                height: var(--header-bar-size);
                width: 100%;
                background-color: transparent;
                overflow: hidden;
            }
            .bar-section {
                height: 100%;
                flex: 1;
            }
            .beginning,
            .middle,
            .end {
                background-color: var(--panel-bg);
                display: flex;
                align-items: center;
            }
            .beginning,
            .middle {
                justify-content: left;
            }
            .middle {
                justify-content: center;
            }
            .end {
                justify-content: right;
            }
            .file-name-label {
                max-width: 260px;
                margin-right: 8px;
                color: var(--tab-button-color);
                opacity: 0.9;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
                font-size: 12px;
                line-height: 1;
            }
            .menu {
                display: none;
            }
            .menu.active {
                display: block;
            }
            tab-button.tab {
                height: 100%;
                border: none;
                width: 48px;
            }
            tab-button.beginning {
                height: 100%;
                min-width: 120px;
                display: none;
            }
            tab-button.end {
                height: 100%;
                width: 32px;
            }
            tab-button.beginning.active {
                display: block;
            }
        `,
    ];

    protected get sch_button() {
        return this.#elements?.get(Sections.beginning)?.get(TabKind.sch);
    }

    make_ecad_view = () => html`<ecad-viewer> </ecad-viewer>`;

    async load_zip_content(
        input_container: InputContainer,
        file: Blob,
        filename?: string,
    ) {
        const parent = input_container.target.parentElement;
        if (!parent) throw new Error("Parent element not found");

        const files = await ZipUtils.unzipFile(file);
        const designFilesToConvert: File[] = [];

        Array.from(files).forEach((file) => {
            if (is_ad(file.name)) {
                designFilesToConvert.push(file);
            }
        });

        if (designFilesToConvert.length && window.cli_server_addr) {
            this.dispatchEvent(new OpenBarrierEvent());
            await this.uploadDesignFiles(designFilesToConvert, input_container);
        } else {
            const viewer_target = input_container.target as any;
            if (viewer_target?.load_zip && file) {
                await viewer_target.load_zip(file, filename || "project.zip");
                return;
            }
            await this.readAndDisplayFiles(files, input_container);
        }
    }

    public set input_container(input_container: InputContainer) {
        this.#input_container = input_container;
        input_container.input.accept =
            ".zip,.kicad_sch,.kicad_pcb,.kicad_pro,.glb,.SchDoc,.PcbDoc,.schdoc,.pcbdoc";
        input_container.target.addEventListener(
            "ecad-viewer:fullscreen-change",
            () => {
                this.#sync_collapse_button_state();
                this.#sync_collapse_button_icon();
            },
        );
        input_container.target.addEventListener("ecad-viewer:file-meta-change", () => {
            this.#sync_file_name_label();
        });

        input_container.input.addEventListener("change", async (e) => {
            const files = (e.target as HTMLInputElement).files;
            if (!files) return;

            const designFilesToConvert: File[] = [];
            const zipFiles: File[] = [];

            Array.from(files).forEach((file) => {
                const file_name = String(file.name || "").toLowerCase();
                if (file_name.endsWith(".zip")) {
                    zipFiles.push(file);
                } else if (is_ad(file.name)) {
                    designFilesToConvert.push(file);
                }
            });

            if (zipFiles.length)
                return this.load_zip_content(
                    input_container,
                    zipFiles[0]!,
                    zipFiles[0]!.name,
                );

            if (designFilesToConvert.length && window.cli_server_addr) {
                this.dispatchEvent(new OpenBarrierEvent());
                await this.uploadDesignFiles(
                    designFilesToConvert,
                    input_container,
                );
            } else {
                await this.readAndDisplayFiles(files, input_container);
            }
        });
    }

    private async uploadDesignFiles(
        files: File[],
        input_container: InputContainer,
    ) {
        const formData = new FormData();
        files.forEach((file) => {
            formData.append("files", file);
            formData.append("file_names", file.name);
        });

        if (!window.cli_server_addr)
            throw new Error("CLI server address not found");

        try {
            const response = await fetch(window.cli_server_addr, {
                method: "POST",
                body: formData,
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const data = await response.json();
            const parent = input_container.target.parentElement;
            const ecad_view = this.make_ecad_view();

            data["files"].forEach((url: string) => {
                ecad_view.appendChild(
                    html`<ecad-source src="${url}"></ecad-source>`,
                );
            });

            if (parent) {
                parent.removeChild(input_container.target);
                parent.appendChild(ecad_view);
            }
        } catch (error) {
            console.log(error);
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

    private async readAndDisplayFiles(
        files: File[] | FileList,
        input_container: InputContainer,
    ) {
        const readFilePromises = Array.from(files).map((file) =>
            this.readFile(file),
        );

        try {
            const results = await Promise.all(readFilePromises);
            const parent = input_container.target.parentElement;
            const ecad_view = this.make_ecad_view();

            let idx = -1;
            results.forEach(({ name, content }) => {
                idx = idx + 1;
                const names = name.split("/");
                name = names[names.length - 1]!;

                if (is_kicad(name)) {
                    ecad_view.appendChild(
                        html`<ecad-blob
                            filename="${name}"
                            content="${content}"></ecad-blob>`,
                    );
                } else if (is_3d_model(name)) {
                    // TODO call revokeObjectURL
                    const it = URL.createObjectURL(files[idx]!);
                    ecad_view.appendChild(
                        html`<ecad-3d-source
                            src="
                           ${it}"></ecad-3d-source>`,
                    );
                }
            });

            if (parent) {
                parent.removeChild(input_container.target);
                parent.appendChild(ecad_view);
            }
        } catch (error) {
            console.error("Error reading files:", error);
        }
    }

    private createSection(sectionClass: Sections): HTMLDivElement {
        const section = document.createElement("div");
        section.classList.add("bar-section", sectionClass);

        const make_middle = (kind: TabKind) => {
            const btn = html`<tab-button>${kind}</tab-button>` as HTMLElement;
            btn.classList.add("tab");
            this.#elements.get(sectionClass)?.set(kind, btn);
            return btn;
        };

        const make_beginning = (kind: TabKind) => {
            const icon_map = {
                [TabKind.pcb]: "svg:layers",
                [TabKind.sch]: "svg:page",
                [TabKind.step]: "svg:layers",
                [TabKind.bom]: "svg:layers",
            };

            const icon = html`<tab-button icon="${icon_map[kind]}"
                >${kind === TabKind.pcb ? "Layers/Objects" : kind}</tab-button
            >` as HTMLElement;
            icon.classList.add("beginning");
            this.#elements.get(sectionClass)?.set(kind, icon);
            return icon;
        };

        switch (sectionClass) {
            case Sections.beginning:
                if (this.option.has_pcb)
                    section.appendChild(make_beginning(TabKind.pcb));
                if (this.option.sch_count > 1)
                    section.appendChild(make_beginning(TabKind.sch));

                break;
            case Sections.middle:
                if (this.option.sch_count > 0)
                    section.appendChild(make_middle(TabKind.sch));
                if (this.option.has_pcb)
                    section.appendChild(make_middle(TabKind.pcb));
                if (this.option.has_3d)
                    section.appendChild(make_middle(TabKind.step));
                if (this.option.has_bom)
                    section.appendChild(make_middle(TabKind.bom));
                break;
            case Sections.end:
                {
                    this.#file_name_label = document.createElement("span");
                    this.#file_name_label.classList.add("file-name-label");
                    this.#file_name_label.style.display = "none";
                    section.appendChild(this.#file_name_label);

                    const open_file = html`<tab-button
                        title="Open file"
                        icon="svg:open_file"
                        class="end"></tab-button>` as HTMLElement;
                    open_file.addEventListener("click", () => {
                        if (this.#input_container.on_open_file) {
                            this.#input_container.on_open_file();
                            return;
                        }
                        this.#input_container.input.click();
                    });
                    section.appendChild(open_file);

                    const download = html`<tab-button
                        title="Download file"
                        icon="svg:download"
                        class="end"></tab-button>` as HTMLElement;
                    download.addEventListener("click", () => {
                        const target = this.#input_container.target as any;
                        target?.downloadCurrentFile?.();
                    });
                    section.appendChild(download);

                    const collapse_btn = html`<tab-button
                        title="Collapse display area"
                        icon="svg:visibility"
                        class="end"></tab-button>` as HTMLElement;
                    collapse_btn.addEventListener("click", () => {
                        const target = this.#input_container.target as any;
                        if (target?.isPageFullscreenActive?.()) return;
                        target?.toggleViewerCollapsed?.();
                        this.#sync_collapse_button_icon();
                    });
                    this.#collapse_btn = collapse_btn;
                    section.appendChild(collapse_btn);

                    const full_screen = html`<tab-button
                        title="Switch full screen mode"
                        icon="svg:full_screen"
                        class="end"></tab-button>` as HTMLElement;
                    full_screen.addEventListener("click", () => {
                        this.#input_container.on_full_windows();
                        window.setTimeout(() => {
                            this.#sync_collapse_button_state();
                            this.#sync_collapse_button_icon();
                        }, 0);
                    });
                    section.appendChild(full_screen);
                }
                break;
        }

        return section;
    }

    override renderedCallback(): void | undefined {
        this.#sync_collapse_button_state();
        this.#sync_collapse_button_icon();
        this.#sync_file_name_label();
        if (!window.app || window.app === "full") {
            if (window.default_page) {
                this.activateTab(window.default_page.toUpperCase() as TabKind);
            } else {
                if (this.option.sch_count) {
                    this.activateTab(TabKind.sch);
                } else if (this.option.has_pcb) {
                    this.activateTab(TabKind.pcb);
                } else if (this.option.has_3d) {
                    this.activateTab(TabKind.step);
                } else if (this.option.has_bom) {
                    this.activateTab(TabKind.bom);
                }
            }
        } else {
            switch (window.app) {
                case "pcb":
                    this.activateTab(TabKind.pcb);
                    break;
                case "sch":
                case "design_block":
                    this.activateTab(TabKind.sch);
                    break;
                case "3d":
                    this.activateTab(TabKind.step);
                    break;
                case "bom":
                    this.activateTab(TabKind.bom);
                    break;
            }
        }
    }

    /**
     * 外部可调用的 tab 切换（用于恢复上次打开的页签）。
     */
    public setActiveTab(kind: TabKind) {
        this.activateTab(kind);
    }

    private activateTab(kind: TabKind) {
        if (this.#current_tab === kind) return;

        for (const [section, elements] of this.#elements) {
            switch (section) {
                case Sections.beginning:
                    elements.forEach((element, k) => {
                        element.classList.toggle("active", k === kind);
                    });
                    break;
                case Sections.middle:
                    elements.forEach((element, k) => {
                        element.classList.toggle("checked", k === kind);
                    });
                    break;
            }
        }

        this.dispatchEvent(
            new TabActivateEvent({
                previous: this.#current_tab,
                current: kind,
            }),
        );
        this.#current_tab = kind;
    }

    on_menu_closed() {
        this.#elements.get(Sections.beginning)?.forEach((v) => {
            v.classList.remove("active");
        });
    }

    override initialContentCallback(): void {
        super.initialContentCallback();
        this.#elements.forEach((section, sectionClass) => {
            section.forEach((element, kind) => {
                switch (sectionClass) {
                    case Sections.beginning:
                        element.addEventListener("click", () => {
                            section.forEach((v) =>
                                v.classList.remove("checked"),
                            );
                            element.classList.add("checked");
                            this.dispatchEvent(new TabMenuClickEvent(kind));
                        });
                        break;
                    case Sections.middle:
                        element.addEventListener("click", () => {
                            this.activateTab(kind);
                        });
                        break;
                }
            });
        });

        this.addEventListener(SheetLoadEvent.type, (e) => {
            if (this.sch_button) this.sch_button.textContent = e.detail;
        });
    }

    override render() {
        this.#elements = new Map();
        const container = html`<div class="horizontal-bar"></div>`;

        const do_add_section = (v: Sections) => {
            this.#elements.set(v, new Map());
            container.appendChild(this.createSection(v));
        };

        do_add_section(Sections.beginning);
        if (!window.app || window.app === "full") {
            do_add_section(Sections.middle);
        }
        do_add_section(Sections.end);

        return html`${container}`;
    }
}

window.customElements.define("tab-header", TabHeaderElement);
