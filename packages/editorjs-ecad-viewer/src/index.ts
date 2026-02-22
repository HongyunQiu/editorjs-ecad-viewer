import './index.css';
import type { API, BlockTool, ToolConfig } from '@editorjs/editorjs';

export interface EcadViewerData {
  viewerHostUrl: string;
  sourceUrl: string;
  /** 存储文件 URL 到用户原始文件名的映射（用于下载与头部展示） */
  sourceOriginalNames?: Record<string, string>;
  /** 本次上传时的主原始文件名（URL 命名不稳定时用于下载名兜底） */
  preferredOriginalFilename?: string;
  isBom?: boolean;
  moduleUrl?: string;
  /**
   * Viewer UI 状态快照（例如 PCB 层可见性、透明度滑块、对象可见性等）。
   * 由 `<ecad-viewer>` 在编辑时通过事件上报，存入 Editor.js block data，便于下次打开自动恢复。
   */
  viewState?: any;
}

export interface EcadViewerConfig extends ToolConfig {
  defaultViewerHostUrl?: string;
  defaultSourceUrl?: string;
  defaultIsBom?: boolean;
  iframeHeight?: number;
}

const ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 6.5A2.5 2.5 0 0 1 5.5 4h13A2.5 2.5 0 0 1 21 6.5v11a2.5 2.5 0 0 1-2.5 2.5h-13A2.5 2.5 0 0 1 3 17.5v-11Zm2 0a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5h-13Z" fill="currentColor"/><path d="M7 9h10v2H7V9Zm0 4h7v2H7v-2Z" fill="currentColor"/></svg>`;

function normalizeHost(input: string): string {
  const fallback = 'http://localhost:8080/';
  if (!input) return fallback;
  try {
    // 允许相对路径（如 "vendor/editorjs-ecad-viewer/"），以当前页面为基准解析
    const u = new URL(input, window.location.href);
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

function tryParseUrl(input: string): URL | null {
  try {
    return new URL(input, window.location.href);
  } catch {
    return null;
  }
}

function looksLikeBundledVendorHost(u: URL): boolean {
  // 典型路径：/vendor/editorjs-ecad-viewer/
  return u.pathname.includes('/vendor/editorjs-ecad-viewer/');
}

function chooseViewerHostUrl(
  dataHost: string | undefined,
  configHost: string | undefined,
): string {
  const fallback = 'http://localhost:8080/';
  const pageOrigin = (() => {
    try {
      return window.location.origin;
    } catch {
      return '';
    }
  })();

  const d = dataHost ? tryParseUrl(dataHost) : null;
  const c = configHost ? tryParseUrl(configHost) : null;

  // 如果块数据里保存的是“本地 vendor 路径”，但 origin 与当前页面不一致（例如从 172.* 打开创建，后来用 localhost 打开），
  // 则优先使用当前页面下的 vendor（configHost）以避免跨域 dynamic import 失败。
  if (d && pageOrigin && d.origin !== pageOrigin && looksLikeBundledVendorHost(d)) {
    if (c) return c.toString();
    // 没有 configHost 时，直接把 pathname rebased 到当前 origin
    try {
      const rebased = new URL(d.pathname, window.location.href);
      if (!rebased.pathname.endsWith('/')) rebased.pathname += '/';
      return rebased.toString();
    } catch {
      // ignore
    }
  }

  return (dataHost || configHost || fallback) as string;
}

function normalizeModuleKey(moduleUrl: string): string {
  try {
    const u = new URL(moduleUrl, window.location.href);
    // 只按 pathname 去重，忽略 ?v= / hash，避免重复执行导致 customElements.define 冲突
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return String(moduleUrl || '').split('#')[0]!.split('?')[0]!;
  }
}

async function ensureEcadModule(moduleUrl: string): Promise<void> {
  const key = normalizeModuleKey(moduleUrl);
  if (loadedModules.has(key)) return;

  // 如果自定义元素已存在，说明模块已执行过，直接认为已加载，避免重复 define
  try {
    if (typeof customElements !== 'undefined' && customElements.get('ecad-viewer')) {
      loadedModules.add(key);
      return;
    }
  } catch (_) {}

  await import(/* @vite-ignore */ moduleUrl);
  loadedModules.add(key);

  // 运行时依赖 ecad-viewer 的公开方法（如 setSourceNameMap / setPreferredOriginalFilename）。
  // import 完成后理论上已 define，但为了避免偶发的“已加载但未定义”窗口期，这里做一次短等待。
  try {
    if (typeof customElements !== 'undefined' && !customElements.get('ecad-viewer')) {
      await Promise.race([
        customElements.whenDefined('ecad-viewer'),
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error('custom element <ecad-viewer> not defined')), 2000),
        ),
      ]);
    }
  } catch (_) {
    // ignore: 失败时后续仍会走可选链调用，不阻塞整体加载流程
  }
}

function buildSourceList(sourceUrl: string): string[] {
  return sourceUrl
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

function basenameFromUrl(u: string): string {
  try {
    const url = new URL(u, window.location.href);
    const p = url.pathname || '';
    const parts = p.split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : u;
  } catch (_) {
    const parts = String(u || '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : String(u || '');
  }
}

function buildFallbackSourceNames(urls: string[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const u of urls) {
    if (!u) continue;
    map[u] = basenameFromUrl(u);
  }
  return map;
}

function isSupportedLocalFile(name: string): boolean {
  const n = String(name || '').toLowerCase();
  return (
    n.endsWith('.zip') ||
    n.endsWith('.kicad_sch') ||
    n.endsWith('.kicad_pcb') ||
    n.endsWith('.kicad_pro') ||
    n.endsWith('.schdoc') ||
    n.endsWith('.pcbdoc') ||
    n.endsWith('.glb')
  );
}

function isAltiumLocalFile(name: string): boolean {
  const n = String(name || '').toLowerCase();
  return n.endsWith('.schdoc') || n.endsWith('.pcbdoc');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchRangePrefix(url: string, maxBytes = 80): Promise<{ ok: boolean; status: number; contentType: string; prefix: Uint8Array }> {
  const r = await fetch(url, {
    method: 'GET',
    // 这里的探测只用于早期错误提示；允许浏览器缓存，减少重复探测开销
    cache: 'force-cache',
    headers: { Range: `bytes=0-${Math.max(0, maxBytes - 1)}` }
  });
  const status = r.status;
  const contentType = r.headers.get('content-type') || '';
  const buf = await r.arrayBuffer();
  const prefix = new Uint8Array(buf || []);
  return { ok: r.ok || r.status === 206, status, contentType, prefix };
}

function u8ToAscii(u8: Uint8Array): string {
  try {
    let s = '';
    const n = Math.min(u8.length, 120);
    for (let i = 0; i < n; i++) s += String.fromCharCode(u8[i]!);
    return s;
  } catch (_) {
    return '';
  }
}

function safeCreateElement(tagName: string): HTMLElement {
  const name = String(tagName || '').trim();
  const looksCustomElement = name.includes('-');
  try {
    // 在部分环境里，对自定义元素名调用 document.createElement 会抛出
    // “The result must not have attributes” 这类异常（尤其在重复加载/切换数据后更容易出现）。
    // 为了稳定，带 '-' 的自定义元素统一走 template 解析路径创建。
    if (looksCustomElement) {
      const tpl = document.createElement('template');
      tpl.innerHTML = `<${name}></${name}>`;
      const el = tpl.content.firstElementChild as HTMLElement | null;
      if (el) return el;
      throw new Error(`template createElement failed for <${name}>`);
    }
    return document.createElement(name);
  } catch (e) {
    try {
      // eslint-disable-next-line no-console
      console.error('[ECAD] document.createElement failed:', {
        tagName: name,
        defined: typeof (window as any).customElements !== 'undefined' && !!customElements.get(name),
        error: e,
      });
    } catch (_) {}
    // 兜底：用 template 解析创建（对自定义元素更稳）
    try {
      const tpl = document.createElement('template');
      tpl.innerHTML = `<${name}></${name}>`;
      const el = tpl.content.firstElementChild as HTMLElement | null;
      if (el) return el;
    } catch (_) {}
    throw new Error(`createElement("${name}") failed: ${String((e as any)?.message || e)}`);
  }
}

export default class EcadViewerTool implements BlockTool {
  private api: API;
  private data: EcadViewerData;
  private config: EcadViewerConfig;
  private readOnly: boolean;

  private fileInput?: HTMLInputElement;
  private mountEl?: HTMLElement;
  private currentViewerEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private statusTextEl?: HTMLElement;
  private statusAbort?: AbortController;
  private statusTimer: number | null = null;
  private statusBaseText = '';
  private statusStartedAt = 0;

  static get isReadOnlySupported() {
    return true;
  }

  static get toolbox() {
    return {
      title: 'ECAD Viewer',
      icon: ICON,
    };
  }

  constructor({ data, config, api, readOnly }: { data?: Partial<EcadViewerData>; config?: EcadViewerConfig; api: API; readOnly: boolean }) {
    this.api = api;
    this.config = config || {};
    this.readOnly = readOnly;

    const host = chooseViewerHostUrl(
      data?.viewerHostUrl,
      this.config.defaultViewerHostUrl,
    );
    const normalizedHost = normalizeHost(host);
    const moduleFromData = data?.moduleUrl || '';
    let moduleUrl = moduleFromData || toModuleUrl(normalizedHost);

    // 若数据里保存了跨 origin 的 vendor moduleUrl，则重算为当前 host 下的 moduleUrl
    try {
      const pageOrigin = window.location.origin;
      const mu = tryParseUrl(moduleUrl);
      if (
        mu &&
        pageOrigin &&
        mu.origin !== pageOrigin &&
        mu.pathname.includes('/vendor/editorjs-ecad-viewer/ecad_viewer/ecad-viewer.js')
      ) {
        moduleUrl = toModuleUrl(normalizedHost);
      }
    } catch (_) {}

    this.data = {
      viewerHostUrl: normalizedHost,
      sourceUrl: data?.sourceUrl || this.config.defaultSourceUrl || '',
      sourceOriginalNames:
        (data?.sourceOriginalNames && typeof data.sourceOriginalNames === 'object'
          ? { ...data.sourceOriginalNames }
          : undefined),
      isBom: typeof data?.isBom === 'boolean' ? data.isBom : !!this.config.defaultIsBom,
      moduleUrl,
      viewState: (data as any)?.viewState,
      preferredOriginalFilename: String(data?.preferredOriginalFilename || ''),
    };
    if (!this.data.sourceOriginalNames) {
      const urls = buildSourceList(this.data.sourceUrl || '');
      this.data.sourceOriginalNames = buildFallbackSourceNames(urls);
    }
  }

  render() {
    const wrapper = document.createElement('div');
    wrapper.className = 'cdx-ecad-viewer';
    try {
      this.fileInput = document.createElement('input');
      this.fileInput.type = 'file';
      this.fileInput.multiple = true;
      this.fileInput.accept = '.zip,.kicad_sch,.kicad_pcb,.kicad_pro,.SchDoc,.PcbDoc,.schdoc,.pcbdoc,.glb';
      this.fileInput.style.display = 'none';

      if (!this.readOnly) {
        this.fileInput.addEventListener('change', async () => {
          try {
            const files = Array.from(this.fileInput?.files || []);
            await this.pickAndUploadFiles(files);
          } finally {
            // 允许重复选择同一个文件也触发 change
            try {
              if (this.fileInput) this.fileInput.value = '';
            } catch (_) {}
          }
        });
      }

      this.mountEl = document.createElement('div');
      this.mountEl.className = 'cdx-ecad-viewer__preview';

      this.statusEl = document.createElement('div');
      this.statusEl.className = 'cdx-ecad-viewer__status';
      this.statusTextEl = document.createElement('div');
      this.statusTextEl.className = 'cdx-ecad-viewer__statusText';
      this.statusEl.appendChild(this.statusTextEl);
      this.mountEl.appendChild(this.statusEl);

      wrapper.append(this.fileInput, this.mountEl);

      this.refreshNativeViewer().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.setHint(`加载失败：${msg}`);
        this.showStatus(`加载失败：${msg}`);
      });
      return wrapper;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      wrapper.textContent = `ECAD Viewer 渲染失败：${msg}`;
      return wrapper;
    }
  }

  save(): EcadViewerData {
    return {
      viewerHostUrl: normalizeHost(this.data.viewerHostUrl || ''),
      moduleUrl: this.data.moduleUrl || toModuleUrl(this.data.viewerHostUrl),
      sourceUrl: this.data.sourceUrl || '',
      sourceOriginalNames: this.data.sourceOriginalNames || {},
      preferredOriginalFilename: String(this.data.preferredOriginalFilename || ''),
      isBom: !!this.data.isBom,
      viewState: this.data.viewState,
    };
  }

  validate(savedData: EcadViewerData): boolean {
    return typeof savedData?.viewerHostUrl === 'string';
  }

  onReadOnlyChanged(readOnly: boolean) {
    // 只做 UI 交互变更：避免因模式切换触发重载
    this.readOnly = readOnly;
    // Editor.js 的 readOnly.toggle() 可能重建块 DOM/实例，也可能复用现有实例。
    // 这里做轻量对齐，避免模式切换引入 auto-load 竞态或折叠状态被意外重置。
    try {
      this.currentViewerEl?.setAttribute?.('auto-load', 'false');
    } catch (_) {}
    try {
      const vs = (this.data as any)?.viewState;
      if (vs && Object.prototype.hasOwnProperty.call(vs, 'collapsed')) {
        const anyViewer = this.currentViewerEl as any;
        if (typeof anyViewer?.setViewerCollapsed === 'function') {
          anyViewer.setViewerCollapsed(!!vs.collapsed, 'restore');
        }
      }
    } catch (_) {}
  }

  private dispatchEditorChange() {
    try {
      const blocks = this.api?.blocks as any;
      if (!blocks) return;

      // 点击 viewer 内部按钮时，EditorJS 可能没有 caret，从而 getCurrentBlockIndex() 取不到。
      // 这里优先根据 DOM 定位到当前 tool 所在的 block，再调用 dispatchChange()。
      const holder = (this.mountEl as any)?.closest?.('.ce-block') as HTMLElement | null;
      if (holder && typeof blocks.getBlocksCount === 'function' && typeof blocks.getBlockByIndex === 'function') {
        const count = Number(blocks.getBlocksCount() || 0);
        for (let i = 0; i < count; i++) {
          const b = blocks.getBlockByIndex(i);
          const h = b && (b.holder || b.holderNode);
          if (h === holder || (h && typeof h.contains === 'function' && h.contains(this.mountEl))) {
            if (typeof b?.dispatchChange === 'function') b.dispatchChange();
            return;
          }
        }
      }

      // 兜底：使用当前 block index
      const idx = blocks.getCurrentBlockIndex?.();
      if (typeof idx !== 'number') return;
      const block = blocks.getBlockByIndex?.(idx);
      if (block && typeof block.dispatchChange === 'function') block.dispatchChange();
    } catch (_) {}
  }

  private async uploadAsAttachment(file: File): Promise<string> {
    // 优先走 QNotes 的鉴权 request（会自动带 token / session headers）
    try {
      const app = (window as any).QNotesApp;
      const fn = app && app.fn;
      if (fn && typeof fn.request === 'function') {
        const formData = new FormData();
        formData.append('file', file);
        const res = await fn.request('/uploadAttachment', { method: 'POST', body: formData });
        const url = res && res.file && res.file.url ? String(res.file.url) : '';
        if (!url) throw new Error('上传成功但未返回 url');
        return url;
      }
    } catch (e) {
      // 若失败则降级到 fetch（可能因缺少鉴权而失败）
      console.warn('[ECAD] uploadAttachment via QNotesApp.fn.request failed:', e);
    }

    const formData = new FormData();
    formData.append('file', file);
    const r = await fetch('/api/uploadAttachment', { method: 'POST', body: formData });
    if (!r.ok) throw new Error(`上传失败: ${r.status}`);
    const res = await r.json();
    const url = res && res.file && res.file.url ? String(res.file.url) : '';
    if (!url) throw new Error('上传成功但未返回 url');
    return url;
  }

  private getCliServerAddr(): string {
    const w = window as any;
    return String(w?.cli_server_addr || '').trim();
  }

  private async convertAltiumFiles(files: File[]): Promise<string[]> {
    const cli = this.getCliServerAddr();
    if (!cli) {
      throw new Error('检测到 Altium 文件，但未配置 cli_server_addr，无法转换 SchDoc/PcbDoc');
    }
    const formData = new FormData();
    for (const f of files) {
      formData.append('files', f);
      formData.append('file_names', f.name);
    }
    const resp = await fetch(cli, { method: 'POST', body: formData });
    if (!resp.ok) throw new Error(`Altium 转换失败: ${resp.status}`);
    const data = await resp.json();
    const urls = Array.isArray(data?.files) ? data.files.map((u: unknown) => String(u)).filter(Boolean) : [];
    if (!urls.length) {
      throw new Error('Altium 转换成功但未返回可加载文件');
    }
    return urls;
  }

  private async pickAndUploadFiles(files: File[]) {
    if (this.readOnly) return;
    if (!files || files.length === 0) return;

    const supported = files.filter((f) => f && isSupportedLocalFile(f.name));
    if (supported.length === 0) {
      this.setHint('不支持的文件类型：请选择 ZIP / .kicad_sch / .kicad_pcb / .kicad_pro / .SchDoc / .PcbDoc / .glb。');
      return;
    }

    // 若包含 zip，则只使用第一个 zip（zip 内可打包完整工程）
    const zip = supported.find((f) => String(f.name || '').toLowerCase().endsWith('.zip'));
    const toUpload = zip ? [zip] : supported;

    try {
      this.setHint(zip ? `正在上传：${zip.name} ...` : `正在上传：${toUpload.length} 个文件...`);

      const urls: string[] = [];
      const sourceOriginalNames: Record<string, string> = {};
      const preferredOriginalFilename = toUpload.length > 0 ? String(toUpload[0]!.name || '').trim() : '';
      if (zip) {
        // ZIP 维持原样上传，viewer 会按 ZIP 路径加载
        const url = await this.uploadAsAttachment(zip);
        urls.push(url);
        sourceOriginalNames[url] = zip.name;
      } else {
        const altiumFiles = toUpload.filter((f) => isAltiumLocalFile(f.name));
        const otherFiles = toUpload.filter((f) => !isAltiumLocalFile(f.name));

        if (altiumFiles.length > 0) {
          this.setHint(`正在转换 Altium 文件：${altiumFiles.length} 个...`);
          const convertedUrls = await this.convertAltiumFiles(altiumFiles);
          urls.push(...convertedUrls);
          if (convertedUrls.length === altiumFiles.length) {
            for (let i = 0; i < convertedUrls.length; i++) {
              const u = convertedUrls[i]!;
              const f = altiumFiles[i]!;
              sourceOriginalNames[u] = f.name;
            }
          } else if (convertedUrls.length === 1) {
            sourceOriginalNames[convertedUrls[0]!] =
              altiumFiles.length === 1
                ? altiumFiles[0]!.name
                : `${altiumFiles[0]!.name} 等${altiumFiles.length}个文件`;
          }
        }

        for (const f of otherFiles) {
          // eslint-disable-next-line no-await-in-loop
          const url = await this.uploadAsAttachment(f);
          urls.push(url);
          sourceOriginalNames[url] = f.name;
        }
      }

      this.data.sourceUrl = urls.join(';');
      this.data.sourceOriginalNames = sourceOriginalNames;
      this.data.preferredOriginalFilename = preferredOriginalFilename;
      try {
        // 调试：确认是否拿到了本地磁盘文件名并写入 block data
        console.info('[ECAD][upload] local selected filenames =', toUpload.map((f) => f.name));
        console.info('[ECAD][upload] preferredOriginalFilename =', this.data.preferredOriginalFilename);
        console.info('[ECAD][upload] sourceOriginalNames =', this.data.sourceOriginalNames);
      } catch (_) {}
      this.dispatchEditorChange();
      const ok = await this.refreshNativeViewer();

      if (!ok) {
        // refreshNativeViewer 内已写入错误提示
        return;
      }

      if (zip) {
        this.setHint(`已上传并加载：${zip.name}`);
      } else if (toUpload.length === 1) {
        this.setHint(`已上传并加载：${toUpload[0]!.name}`);
      } else {
        this.setHint(`已上传并加载：${toUpload.length} 个文件`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[ECAD] 上传或加载失败：', e);
      this.setHint(`上传或加载失败：${msg}`);
    }
  }

  private showStatus(baseText: string) {
    this.statusBaseText = String(baseText || '');
    if (this.statusEl) this.statusEl.style.display = this.statusBaseText ? 'flex' : 'none';
    this.updateStatusText();
  }

  private hideStatus() {
    if (this.statusEl) this.statusEl.style.display = 'none';
  }

  private updateStatusText() {
    if (!this.statusTextEl) return;
    const base = this.statusBaseText || '';
    if (!base) {
      this.statusTextEl.textContent = '';
      return;
    }
    const sec = this.statusStartedAt ? Math.max(0, Math.floor((Date.now() - this.statusStartedAt) / 1000)) : 0;
    this.statusTextEl.textContent = sec > 0 ? `${base}（已等待 ${sec}s）` : base;
  }

  private stopStatusTicker() {
    if (this.statusTimer != null) {
      try {
        window.clearInterval(this.statusTimer);
      } catch (_) {}
      this.statusTimer = null;
    }
    this.statusStartedAt = 0;
  }

  private startStatusTicker(baseText: string) {
    this.stopStatusTicker();
    this.statusStartedAt = Date.now();
    this.statusBaseText = String(baseText || '');
    if (this.statusEl) this.statusEl.style.display = 'flex';
    this.updateStatusText();
    this.statusTimer = window.setInterval(() => this.updateStatusText(), 1000);
  }

  private async refreshNativeViewer(): Promise<boolean> {
    if (!this.mountEl) return false;
    try {

    const moduleUrl = this.data.moduleUrl || toModuleUrl(this.data.viewerHostUrl);
    try {
      this.showStatus('正在初始化组件…');
      await ensureEcadModule(moduleUrl);
    } catch (err) {
      this.mountEl.innerHTML = '';
      if (this.statusEl) this.mountEl.appendChild(this.statusEl);
      this.setHint(`加载 ecad-viewer 失败: ${String(err)}`);
      this.stopStatusTicker();
      this.showStatus(`加载失败：${String(err)}`);
      return false;
    }

    // 仅当真正需要渲染/重载时再清空
    const sources = buildSourceList(this.data.sourceUrl);
    const sourceOriginalNames = this.data.sourceOriginalNames || {};
    const preferredOriginalFilename = String(this.data.preferredOriginalFilename || '');
    try {
      // 调试：确认从 block data 读到的原始文件名映射
      console.info('[ECAD][render] sources =', sources);
      console.info('[ECAD][render] preferredOriginalFilename =', preferredOriginalFilename);
      console.info('[ECAD][render] sourceOriginalNames =', sourceOriginalNames);
    } catch (_) {}
    const zipOnly = sources.length === 1 && sources[0]!.toLowerCase().endsWith('.zip');
    const height = this.config.iframeHeight || 560;

    this.mountEl.innerHTML = '';
    if (this.statusEl) this.mountEl.appendChild(this.statusEl);
    this.currentViewerEl = undefined;

    let viewer: HTMLElement;
    try {
      this.showStatus('正在创建视图…');
      // 强制显示顶部标签栏：
      // ecad-viewer 内部使用 `if (window.hide_header)` 来隐藏头部；
      // 而 load_ecad_viewer_conf 会把 URL 参数 hide-header 写到 window.hide_header（字符串 "false" 也会被当成 truthy）。
      // 为了避免在 QNotes 中莫名其妙看不到 SCH/PCB/BOM/3D 标签栏，这里统一覆盖为 boolean false。
      try {
        (window as any).hide_header = false;
      } catch (_) {}

      // 统一使用完整 ecad-viewer（自带 PCB/SCH/BOM/3D 标签页，可切换）
      viewer = safeCreateElement('ecad-viewer');
      this.currentViewerEl = viewer;
      // 由外层工具统一控制加载时机（避免与 ecad-viewer 内部的 auto load 竞态）
      try {
        viewer.setAttribute('auto-load', 'false');
      } catch (_) {}
      viewer.setAttribute('style', `display:block;width:100%;height:${height}px;border:0;`);
      (viewer as any).on_open_file = () => {
        if (!this.readOnly && this.fileInput) this.fileInput.click();
      };
      // 如需默认打开 BOM，可通过全局 default_page 控制（ecad-viewer 会读取 window.default_page）
      try {
        if (this.data.isBom) (window as any).default_page = 'bom';
      } catch (_) {}

      // 尽早恢复 viewState（尤其是 collapsed），避免组件初始自动 load_src 时做无谓加载
      try {
        const state = (this.data as any)?.viewState;
        const anyViewer = viewer as any;
        // 关键：在 append 到 DOM 之前就先折叠起来。
        // 因为 ecad-viewer 的 initialContentCallback 会 later(() => load_src())，
        // 若那一刻还是展开态，会直接触发资源加载；而折叠态下 load_src 只会记录 deferred_load。
        if (
          state &&
          Object.prototype.hasOwnProperty.call(state as any, 'collapsed') &&
          typeof anyViewer?.setViewerCollapsed === 'function'
        ) {
          anyViewer.setViewerCollapsed(!!(state as any).collapsed, 'restore');
        }
        if (state && typeof anyViewer?.setViewState === 'function') {
          // setViewState 在 loaded=false 时会内部缓存，且 collapsed 会立即生效
          void anyViewer.setViewState(state);
        } else if (state && anyViewer) {
          (anyViewer as any).viewState = state;
        }
      } catch (_) {}
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.mountEl.innerHTML = '';
      if (this.statusEl) this.mountEl.appendChild(this.statusEl);
      this.setHint(`创建 viewer 失败：${msg}`);
      this.stopStatusTicker();
      this.showStatus(`加载失败：${msg}`);
      return false;
    }

    // 统一用 viewer 的公开方法触发加载，避免依赖全局 window.zip_url（多块场景下会互相影响，也更容易造成“上传后空白”）
    try {
      for (const src of sources) {
        if (src.toLowerCase().endsWith('.glb')) {
          const s3d = safeCreateElement('ecad-3d-source');
          s3d.setAttribute('src', src);
          viewer.appendChild(s3d);
        } else if (!zipOnly) {
          const source = safeCreateElement('ecad-source');
          source.setAttribute('src', src);
          viewer.appendChild(source);
        }
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.mountEl.innerHTML = '';
      if (this.statusEl) this.mountEl.appendChild(this.statusEl);
      this.setHint(`创建 source 节点失败：${msg}`);
      this.stopStatusTicker();
      this.showStatus(`加载失败：${msg}`);
      return false;
    }

    this.mountEl.appendChild(viewer);

    // 强制触发一次加载（避免某些情况下 initialContentCallback 未触发导致空白）
    try {
      const anyViewer = viewer as any;
      let allowPersistViewState = false;

      // 尽早监听折叠状态变化：保证“加载中点击折叠”也能立刻收紧高度
      // 注意：初始化 restore viewState 时会临时关闭 allowPersist，避免把 block 标记为已修改
      try {
        const el = viewer as any;
        el.addEventListener?.('ecad-viewer:view-state-change', (ev: any) => {
          try {
            const origin = String(ev?.detail?.origin || '');
            const next = ev?.detail?.viewState ?? ev?.detail ?? null;
            if (!next) return;
            try {
              this.mountEl?.classList.toggle('is-collapsed', !!(next as any)?.collapsed);
            } catch (_) {}
            // setViewState(restore) 可能触发该事件，不应把 block 标记为已修改；
            // 但用户点击折叠等交互要立刻持久化（即使发生在初始化阶段）
            if (origin === 'restore') return;
            if (origin !== 'user' && !allowPersistViewState) return;
            (this.data as any).viewState = next;
            this.dispatchEditorChange();
          } catch (_) {}
        });
      } catch (_) {}

      // 监听 ecad-viewer 内部的加载状态事件（若存在），用于细粒度状态文案
      try {
        this.statusAbort?.abort();
      } catch (_) {}
      this.statusAbort = new AbortController();
      try {
        (viewer as any).addEventListener?.(
          'ecad-viewer:loading-status',
          (ev: any) => {
            const msg = ev?.detail?.message || ev?.detail?.text || '';
            if (!msg) return;
            this.showStatus(String(msg));
            // 内部加载完成后自动收起遮罩（展开后延迟加载路径需要）
            const phase = String(ev?.detail?.phase || '').toLowerCase();
            if (phase === 'render' || String(msg).includes('渲染完成')) {
              this.stopStatusTicker();
              this.hideStatus();
            }
          },
          { signal: this.statusAbort.signal } as any,
        );
      } catch (_) {}

      // 等一帧，确保自定义元素已连接并完成首次渲染（否则某些内部字段可能尚未就绪，表现为一直“加载中”）
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (anyViewer && anyViewer.updateComplete && typeof anyViewer.updateComplete.then === 'function') {
        // 给 updateComplete 一个短等待
        await Promise.race([anyViewer.updateComplete, sleep(300)]);
      }
      // 在 viewer 首次渲染后再注入文件名元信息：
      // 1) 避免方法尚不可用时被可选链跳过
      // 2) 避免 file-meta-change 早于 header 绑定监听导致 label 不刷新
      try {
        anyViewer?.setSourceNameMap?.(sourceOriginalNames);
      } catch (_) {}
      try {
        anyViewer?.setPreferredOriginalFilename?.(preferredOriginalFilename);
      } catch (_) {}

      // 再次确保折叠状态被真实应用到 ecad-viewer：
      // - 某些环境下早期 setViewState 可能因为元素尚未就绪而未生效
      // - 这里在首次渲染完成后，根据持久化的 viewState.collapsed 强制对齐一次
      try {
        const vs = (this.data as any)?.viewState;
        if (vs && Object.prototype.hasOwnProperty.call(vs, 'collapsed') && typeof anyViewer?.setViewerCollapsed === 'function') {
          anyViewer.setViewerCollapsed(!!vs.collapsed, 'restore');
        }
      } catch (_) {}

      // 若处于折叠态：不做资源探测、不触发实际加载；展开时由 ecad-viewer 内部自动触发延迟加载
      const collapsed = !!anyViewer?.getViewerCollapsed?.() || !!(this.data as any)?.viewState?.collapsed;
      if (collapsed) {
        try {
          this.mountEl?.classList.add('is-collapsed');
        } catch (_) {}

        // 让 ecad-viewer 记录一次“待加载”动作（内部会在展开时执行；折叠态下这里不会发起网络请求）
        try {
          const viewerConfirmedCollapsed = !!anyViewer?.getViewerCollapsed?.();
          if (!viewerConfirmedCollapsed && typeof anyViewer?.setViewerCollapsed === 'function') {
            anyViewer.setViewerCollapsed(true, 'restore');
          }
          if (anyViewer?.getViewerCollapsed?.()) {
            if (zipOnly && sources[0] && typeof anyViewer.load_window_zip_url === 'function') {
              void anyViewer.load_window_zip_url(sources[0]);
            } else if (typeof anyViewer.load_src === 'function') {
              void anyViewer.load_src();
            }
          }
        } catch (_) {}

        // 折叠态下没有“初始化回放导致的脏标记”问题，允许立刻持久化用户后续操作
        allowPersistViewState = true;
        this.stopStatusTicker();
        this.hideStatus();
        return true;
      }

      try {
        this.mountEl?.classList.remove('is-collapsed');
      } catch (_) {}

      // 资源探测：避免上传后 url 指向 404/HTML，导致内部加载卡住但无明显错误
      if (sources.length >= 1) {
        this.showStatus('正在校验资源…');
        const probeUrl = sources[0]!;
        const probe = await fetchRangePrefix(probeUrl, 80);
        const ascii = u8ToAscii(probe.prefix).trim();
        if (!probe.ok) {
          this.setHint(`加载失败：资源不可访问（${probe.status}）`);
          this.stopStatusTicker();
          this.showStatus(`加载失败：资源不可访问（${probe.status}）`);
          return false;
        }
        if (zipOnly) {
          // ZIP 头应为 PK
          if (!(probe.prefix.length >= 2 && probe.prefix[0] === 0x50 && probe.prefix[1] === 0x4b)) {
            // 常见：返回了 HTML（如登录页/错误页）
            const preview = ascii.slice(0, 24).replace(/\s+/g, ' ');
            this.setHint(`加载失败：不是 ZIP 内容（${probe.contentType || 'unknown'}，前缀="${preview}"）`);
            this.stopStatusTicker();
            this.showStatus(`加载失败：不是 ZIP 内容（${probe.contentType || 'unknown'}）`);
            return false;
          }
        } else {
          // 非 zip：如果返回 HTML，很可能是路由回退/鉴权页
          if (ascii.toLowerCase().startsWith('<!doctype') || ascii.toLowerCase().startsWith('<html')) {
            const preview = ascii.slice(0, 24).replace(/\s+/g, ' ');
            this.setHint(`加载失败：返回了 HTML（${probe.contentType || 'unknown'}，前缀="${preview}"）`);
            this.stopStatusTicker();
            this.showStatus(`加载失败：返回了 HTML（${probe.contentType || 'unknown'}）`);
            return false;
          }
        }
      }

      const loadPromise = (async () => {
        if (zipOnly && sources[0] && typeof anyViewer.load_window_zip_url === 'function') {
          this.setHint(`正在加载：${basenameFromUrl(sources[0])}`);
          this.startStatusTicker('正在加载工程…');
          await anyViewer.load_window_zip_url(sources[0]);
          return;
        }
        if (typeof anyViewer.load_src === 'function') {
          if (sources.length === 1) this.setHint(`正在加载：${basenameFromUrl(sources[0])}`);
          else if (sources.length > 1) this.setHint(`正在加载：${sources.length} 个文件`);
          this.startStatusTicker('正在加载工程…');
          await anyViewer.load_src();
        }
      })();

      // 超时保护：避免一直“正在加载”
      const timeoutMs = zipOnly ? 120000 : 60000;
      await Promise.race([
        loadPromise,
        (async () => {
          await sleep(timeoutMs);
          throw new Error(`加载超时（${Math.round(timeoutMs / 1000)}s）`);
        })(),
      ]);
      this.stopStatusTicker();

      // 恢复已保存的 viewer UI 状态（例如层可见性/透明度等）。
      // 注意：这里先回放状态，再绑定事件监听，避免“初始化回放”把 block 标记为已修改。
      try {
        const state = (this.data as any)?.viewState;
        if (state && typeof anyViewer?.setViewState === 'function') {
          allowPersistViewState = false;
          try {
            await anyViewer.setViewState(state);
          } finally {
            allowPersistViewState = true;
          }
        } else if (state && anyViewer) {
          // 兜底：部分构建版本可能暴露为属性而非方法
          (anyViewer as any).viewState = state;
        }
      } catch (e) {
        console.warn('[ECAD] restore viewState failed:', e);
      }

      // 初始化流程结束：允许开始持久化用户交互产生的 viewState
      allowPersistViewState = true;
    } catch (e) {
      console.warn('[ECAD] viewer load failed:', e);
      const msg = e instanceof Error ? e.message : String(e);
      this.setHint(`加载失败：${msg}`);
      this.stopStatusTicker();
      this.showStatus(`加载失败：${msg}`);
      return false;
    }

    this.stopStatusTicker();
    this.hideStatus();
    return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setHint(`加载失败：${msg}`);
      this.stopStatusTicker();
      this.showStatus(`加载失败：${msg}`);
      return false;
    }
  }

  private setHint(text: string) {
    this.showStatus(text);
  }
}
