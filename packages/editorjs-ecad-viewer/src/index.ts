import './index.css';
import type { API, BlockTool, ToolConfig } from '@editorjs/editorjs';

export interface EcadViewerData {
  viewerHostUrl: string;
  sourceUrl: string;
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

function isSupportedLocalFile(name: string): boolean {
  const n = String(name || '').toLowerCase();
  return n.endsWith('.zip') || n.endsWith('.kicad_sch') || n.endsWith('.kicad_pcb') || n.endsWith('.glb');
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
  private openBtn?: HTMLButtonElement;
  private hintEl?: HTMLElement;
  private mountEl?: HTMLElement;
  private currentViewerEl?: HTMLElement;

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

    const host = data?.viewerHostUrl || this.config.defaultViewerHostUrl || 'http://localhost:8080/';
    this.data = {
      viewerHostUrl: normalizeHost(host),
      sourceUrl: data?.sourceUrl || this.config.defaultSourceUrl || '',
      isBom: typeof data?.isBom === 'boolean' ? data.isBom : !!this.config.defaultIsBom,
      moduleUrl: data?.moduleUrl || toModuleUrl(host),
      viewState: (data as any)?.viewState,
    };
  }

  render() {
    const wrapper = document.createElement('div');
    wrapper.className = 'cdx-ecad-viewer';
    try {
      const toolbar = document.createElement('div');
      toolbar.className = 'cdx-ecad-viewer__toolbar';

      this.hintEl = document.createElement('div');
      this.hintEl.className = 'cdx-ecad-viewer__hint';
      this.hintEl.textContent = '提示：点击“打开文件”选择 ZIP / .kicad_sch / .kicad_pcb / .glb。';

      this.openBtn = document.createElement('button');
      this.openBtn.type = 'button';
      this.openBtn.className = 'cdx-ecad-viewer__btn';
      this.openBtn.textContent = '打开文件';
      this.openBtn.disabled = this.readOnly;

      this.fileInput = document.createElement('input');
      this.fileInput.type = 'file';
      this.fileInput.multiple = true;
      this.fileInput.accept = '.zip,.kicad_sch,.kicad_pcb,.glb';
      this.fileInput.style.display = 'none';

      if (!this.readOnly) {
        this.openBtn.addEventListener('click', () => {
          if (this.fileInput) this.fileInput.click();
        });
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

      toolbar.append(this.openBtn, this.fileInput, this.hintEl);

      this.mountEl = document.createElement('div');
      this.mountEl.className = 'cdx-ecad-viewer__preview';

      wrapper.append(toolbar, this.mountEl);

      this.refreshNativeViewer().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.setHint(`加载失败：${msg}`);
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
    if (this.openBtn) this.openBtn.disabled = readOnly;
  }

  private dispatchEditorChange() {
    try {
      const idx = this.api?.blocks?.getCurrentBlockIndex?.();
      if (typeof idx !== 'number') return;
      const block = this.api?.blocks?.getBlockByIndex?.(idx);
      if (block && typeof (block as any).dispatchChange === 'function') {
        (block as any).dispatchChange();
      }
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

  private async pickAndUploadFiles(files: File[]) {
    if (this.readOnly) return;
    if (!files || files.length === 0) return;

    const supported = files.filter((f) => f && isSupportedLocalFile(f.name));
    if (supported.length === 0) {
      this.setHint('不支持的文件类型：请选择 ZIP / .kicad_sch / .kicad_pcb / .glb。');
      return;
    }

    // 若包含 zip，则只使用第一个 zip（zip 内可打包完整工程）
    const zip = supported.find((f) => String(f.name || '').toLowerCase().endsWith('.zip'));
    const toUpload = zip ? [zip] : supported;

    try {
      this.setHint(zip ? `正在上传：${zip.name} ...` : `正在上传：${toUpload.length} 个文件...`);

      const urls: string[] = [];
      for (const f of toUpload) {
        // eslint-disable-next-line no-await-in-loop
        const url = await this.uploadAsAttachment(f);
        urls.push(url);
      }

      this.data.sourceUrl = urls.join(';');
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

  private async refreshNativeViewer(): Promise<boolean> {
    if (!this.mountEl) return false;
    try {

    const moduleUrl = this.data.moduleUrl || toModuleUrl(this.data.viewerHostUrl);
    try {
      await ensureEcadModule(moduleUrl);
    } catch (err) {
      this.mountEl.innerHTML = '';
      this.setHint(`加载 ecad-viewer 失败: ${String(err)}`);
      return false;
    }

    // 仅当真正需要渲染/重载时再清空
    const sources = buildSourceList(this.data.sourceUrl);
    const zipOnly = sources.length === 1 && sources[0]!.toLowerCase().endsWith('.zip');
    const height = this.config.iframeHeight || 560;

    this.mountEl.innerHTML = '';
    this.currentViewerEl = undefined;

    let viewer: HTMLElement;
    try {
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
      viewer.setAttribute('style', `display:block;width:100%;height:${height}px;border:0;`);
      // 如需默认打开 BOM，可通过全局 default_page 控制（ecad-viewer 会读取 window.default_page）
      try {
        if (this.data.isBom) (window as any).default_page = 'bom';
      } catch (_) {}
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.mountEl.innerHTML = '';
      this.setHint(`创建 viewer 失败：${msg}`);
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
      this.setHint(`创建 source 节点失败：${msg}`);
      return false;
    }

    this.mountEl.appendChild(viewer);

    // 强制触发一次加载（避免某些情况下 initialContentCallback 未触发导致空白）
    try {
      const anyViewer = viewer as any;
      // 等一帧，确保自定义元素已连接并完成首次渲染（否则某些内部字段可能尚未就绪，表现为一直“加载中”）
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      if (anyViewer && anyViewer.updateComplete && typeof anyViewer.updateComplete.then === 'function') {
        // 给 updateComplete 一个短等待
        await Promise.race([anyViewer.updateComplete, sleep(300)]);
      }

      // 资源探测：避免上传后 url 指向 404/HTML，导致内部加载卡住但无明显错误
      if (sources.length >= 1) {
        const probeUrl = sources[0]!;
        const probe = await fetchRangePrefix(probeUrl, 80);
        const ascii = u8ToAscii(probe.prefix).trim();
        if (!probe.ok) {
          this.setHint(`加载失败：资源不可访问（${probe.status}）`);
          return false;
        }
        if (zipOnly) {
          // ZIP 头应为 PK
          if (!(probe.prefix.length >= 2 && probe.prefix[0] === 0x50 && probe.prefix[1] === 0x4b)) {
            // 常见：返回了 HTML（如登录页/错误页）
            const preview = ascii.slice(0, 24).replace(/\s+/g, ' ');
            this.setHint(`加载失败：不是 ZIP 内容（${probe.contentType || 'unknown'}，前缀="${preview}"）`);
            return false;
          }
        } else {
          // 非 zip：如果返回 HTML，很可能是路由回退/鉴权页
          if (ascii.toLowerCase().startsWith('<!doctype') || ascii.toLowerCase().startsWith('<html')) {
            const preview = ascii.slice(0, 24).replace(/\s+/g, ' ');
            this.setHint(`加载失败：返回了 HTML（${probe.contentType || 'unknown'}，前缀="${preview}"）`);
            return false;
          }
        }
      }

      const loadPromise = (async () => {
        if (zipOnly && sources[0] && typeof anyViewer.load_window_zip_url === 'function') {
          this.setHint(`正在加载：${basenameFromUrl(sources[0])}`);
          await anyViewer.load_window_zip_url(sources[0]);
          return;
        }
        if (typeof anyViewer.load_src === 'function') {
          if (sources.length === 1) this.setHint(`正在加载：${basenameFromUrl(sources[0])}`);
          else if (sources.length > 1) this.setHint(`正在加载：${sources.length} 个文件`);
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

      // 恢复已保存的 viewer UI 状态（例如层可见性/透明度等）。
      // 注意：这里先回放状态，再绑定事件监听，避免“初始化回放”把 block 标记为已修改。
      try {
        const state = (this.data as any)?.viewState;
        if (state && typeof anyViewer?.setViewState === 'function') {
          await anyViewer.setViewState(state);
        } else if (state && anyViewer) {
          // 兜底：部分构建版本可能暴露为属性而非方法
          (anyViewer as any).viewState = state;
        }
      } catch (e) {
        console.warn('[ECAD] restore viewState failed:', e);
      }

      // 监听 viewer UI 状态变化并写回 block data，保证下次打开可恢复
      try {
        const el = viewer as any;
        el.addEventListener?.('ecad-viewer:view-state-change', (ev: any) => {
          try {
            const next = ev?.detail?.viewState ?? ev?.detail ?? null;
            if (!next) return;
            (this.data as any).viewState = next;
            this.dispatchEditorChange();
          } catch (_) {}
        });
      } catch (_) {}
    } catch (e) {
      console.warn('[ECAD] viewer load failed:', e);
      const msg = e instanceof Error ? e.message : String(e);
      this.setHint(`加载失败：${msg}`);
      return false;
    }

    // 若当前 hint 已经是“上传中/已上传”等用户态提示，则不覆盖；否则显示简短状态
    const currentHint = (this.hintEl && this.hintEl.textContent) ? String(this.hintEl.textContent) : '';
    const shouldKeep =
      currentHint.includes('正在上传') ||
      currentHint.includes('已上传') ||
      currentHint.includes('不支持的文件类型');
    if (!shouldKeep) {
      if (zipOnly) {
        this.setHint(`已加载：${basenameFromUrl(sources[0]!)}`);
      } else if (sources.length === 1 && sources[0]) {
        this.setHint(`已加载：${basenameFromUrl(sources[0])}`);
      } else if (sources.length > 1) {
        this.setHint(`已加载：${sources.length} 个文件`);
      } else {
        this.setHint('提示：点击“打开文件”选择 ZIP / .kicad_sch / .kicad_pcb / .glb。');
      }
    }

    return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.setHint(`加载失败：${msg}`);
      return false;
    }
  }

  private setHint(text: string) {
    if (this.hintEl) this.hintEl.textContent = text;
  }
}
