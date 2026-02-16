import './index.css';
import type { API, BlockTool, ToolConfig } from '@editorjs/editorjs';

export interface EcadViewerData {
  viewerHostUrl: string;
  sourceUrl: string;
  isBom?: boolean;
  moduleUrl?: string;
}

export interface EcadViewerConfig extends ToolConfig {
  defaultViewerHostUrl?: string;
  defaultSourceUrl?: string;
  defaultIsBom?: boolean;
  iframeHeight?: number;
}

const ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Zm2 0a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-13Z" fill="currentColor"/><path d="M7 9h10v2H7V9Zm0 4h7v2H7v-2Z" fill="currentColor"/></svg>`;

function makeInput(placeholder: string, value: string, readOnly: boolean): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = placeholder;
  input.value = value;
  input.className = 'cdx-ecad-viewer__input';
  input.readOnly = readOnly;
  return input;
}

function normalizeHost(input: string): string {
  const fallback = 'http://localhost:8080/';
  if (!input) return fallback;
  try {
    const u = new URL(input);
    if (!u.pathname || u.pathname === '/') u.pathname = '/';
    return u.toString();
  } catch {
    return fallback;
  }
}

function toModuleUrl(host: string): string {
  const base = normalizeHost(host);
  return new URL('ecad_viewer/ecad-viewer.js', base).toString();
}

const loadedModules = new Set<string>();

async function ensureEcadModule(moduleUrl: string): Promise<void> {
  if (loadedModules.has(moduleUrl)) return;
  await import(/* @vite-ignore */ moduleUrl);
  loadedModules.add(moduleUrl);
}

function buildSourceList(sourceUrl: string): string[] {
  return sourceUrl
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

export default class EcadViewerTool implements BlockTool {
  private data: EcadViewerData;
  private config: EcadViewerConfig;
  private readOnly: boolean;

  private viewerHostInput?: HTMLInputElement;
  private sourceInput?: HTMLInputElement;
  private moduleInput?: HTMLInputElement;
  private bomCheckbox?: HTMLInputElement;
  private hintEl?: HTMLElement;
  private mountEl?: HTMLElement;

  static get isReadOnlySupported() {
    return true;
  }

  static get toolbox() {
    return {
      title: 'ECAD Viewer',
      icon: ICON,
    };
  }

  constructor({ data, config, readOnly }: { data?: Partial<EcadViewerData>; config?: EcadViewerConfig; api: API; readOnly: boolean }) {
    this.config = config || {};
    this.readOnly = readOnly;

    const host = data?.viewerHostUrl || this.config.defaultViewerHostUrl || 'http://localhost:8080/';
    this.data = {
      viewerHostUrl: normalizeHost(host),
      sourceUrl: data?.sourceUrl || this.config.defaultSourceUrl || '',
      isBom: typeof data?.isBom === 'boolean' ? data.isBom : !!this.config.defaultIsBom,
      moduleUrl: data?.moduleUrl || toModuleUrl(host),
    };
  }

  render() {
    const wrapper = document.createElement('div');
    wrapper.className = 'cdx-ecad-viewer';

    const controls = document.createElement('div');
    controls.className = 'cdx-ecad-viewer__controls';

    this.viewerHostInput = makeInput('Viewer Host URL (e.g. http://localhost:8080/)', this.data.viewerHostUrl, this.readOnly);
    this.moduleInput = makeInput('Module URL (auto)', this.data.moduleUrl || toModuleUrl(this.data.viewerHostUrl), this.readOnly);
    this.sourceInput = makeInput('Source URL(s), use ; to separate multiple files', this.data.sourceUrl, this.readOnly);

    const bomLabel = document.createElement('label');
    bomLabel.className = 'cdx-ecad-viewer__hint';
    this.bomCheckbox = document.createElement('input');
    this.bomCheckbox.type = 'checkbox';
    this.bomCheckbox.checked = !!this.data.isBom;
    this.bomCheckbox.disabled = this.readOnly;
    bomLabel.append(this.bomCheckbox, document.createTextNode(' 以 BOM 视图显示'));

    this.hintEl = document.createElement('div');
    this.hintEl.className = 'cdx-ecad-viewer__hint';
    this.hintEl.textContent = '原生模式：块内直接挂载 ecad-viewer-embedded 组件。';

    controls.append(this.viewerHostInput, this.moduleInput, this.sourceInput, bomLabel, this.hintEl);

    this.mountEl = document.createElement('div');
    this.mountEl.className = 'cdx-ecad-viewer__preview';

    wrapper.append(controls, this.mountEl);

    if (!this.readOnly) {
      this.viewerHostInput.addEventListener('input', () => {
        const host = normalizeHost(this.viewerHostInput?.value || '');
        this.data.viewerHostUrl = host;
        this.data.moduleUrl = toModuleUrl(host);
        if (this.moduleInput) this.moduleInput.value = this.data.moduleUrl;
        void this.refreshNativeViewer();
      });

      this.moduleInput.addEventListener('input', () => {
        this.data.moduleUrl = this.moduleInput?.value || '';
        void this.refreshNativeViewer();
      });

      this.sourceInput.addEventListener('input', () => {
        this.data.sourceUrl = this.sourceInput?.value || '';
        void this.refreshNativeViewer();
      });

      this.bomCheckbox.addEventListener('change', () => {
        this.data.isBom = !!this.bomCheckbox?.checked;
        void this.refreshNativeViewer();
      });
    }

    void this.refreshNativeViewer();
    return wrapper;
  }

  save(): EcadViewerData {
    return {
      viewerHostUrl: normalizeHost(this.viewerHostInput?.value || this.data.viewerHostUrl || ''),
      moduleUrl: this.moduleInput?.value || this.data.moduleUrl || '',
      sourceUrl: this.sourceInput?.value || '',
      isBom: !!this.bomCheckbox?.checked,
    };
  }

  validate(savedData: EcadViewerData): boolean {
    return typeof savedData?.viewerHostUrl === 'string';
  }

  private async refreshNativeViewer() {
    if (!this.mountEl) return;

    const moduleUrl = this.data.moduleUrl || toModuleUrl(this.data.viewerHostUrl);
    try {
      await ensureEcadModule(moduleUrl);
    } catch (err) {
      this.mountEl.innerHTML = '';
      this.setHint(`加载 ecad-viewer 失败: ${String(err)}`);
      return;
    }

    this.mountEl.innerHTML = '';

    const embedded = document.createElement('ecad-viewer-embedded');
    embedded.setAttribute('style', `display:block;width:100%;height:${this.config.iframeHeight || 560}px;border:0;`);

    if (this.data.isBom) {
      embedded.setAttribute('is-bom', 'true');
    }

    const sources = buildSourceList(this.data.sourceUrl);
    const zipOnly = sources.length === 1 && sources[0]!.toLowerCase().endsWith('.zip');

    // ecad-viewer 原生逻辑对 zip 依赖 window.zip_url（query/global），而不是 ecad-source。
    // 这里做最小兼容：当仅提供 zip 时，注入全局变量以触发 zip 加载路径。
    if (zipOnly) {
      (window as any).zip_url = sources[0];
    } else {
      try {
        delete (window as any).zip_url;
      } catch {
        (window as any).zip_url = undefined;
      }

      for (const src of sources) {
        if (src.endsWith('.glb')) {
          const s3d = document.createElement('ecad-3d-source');
          s3d.setAttribute('src', src);
          embedded.appendChild(s3d);
        } else {
          const source = document.createElement('ecad-source');
          source.setAttribute('src', src);
          embedded.appendChild(source);
        }
      }
    }

    this.mountEl.appendChild(embedded);
    this.setHint(zipOnly ? '已挂载（zip 模式：window.zip_url）。' : '已挂载 ecad-viewer-embedded（原生模式）。');
  }

  private setHint(text: string) {
    if (this.hintEl) this.hintEl.textContent = text;
  }
}
