## ECAD Viewer 折叠状态加载 Bug 修复记录

**日期**：2026-02-22
**涉及文件**：

- `packages/editorjs-ecad-viewer/src/index.ts`
- `packages/ecad-viewer/src/ecad-viewer/ecad_viewer.ts`

---

## 1. 问题描述

当 ECAD Viewer 处于**折叠（collapsed）状态**时，重新打开页面会出现以下问题：

1. **spinner 无限转圈**：内部加载转圈动画一直显示，但实际上并没有（或不应该）触发文件加载
2. **可能意外触发真实的文件下载**：在特定时序下，`load_window_zip_url` / `load_src` 内部的 `getViewerCollapsed()` 判断可能返回 `false`，导致折叠态下仍然发起网络请求
3. **文件名不显示**：折叠态的 header 栏中，Open File 按钮左侧的文件名标签始终为空

用户期望：折叠态下**不加载文件**，只有展开时才加载（或加载缓存）；折叠态下 header 应正常显示文件名。

---

## 2. 根因分析

### 2.1 spinner 无限转圈

**时序竞态导致首次 render 时 `#is_viewer_collapsed` 为 `false`：**

1. `index.ts` 的 `refreshNativeViewer()` 通过 `safeCreateElement('ecad-viewer')`（内部使用 `template.innerHTML`）创建元素。此时元素可能**尚未被 Custom Element 升级为类实例**，`setViewerCollapsed()` 方法不可用，调用被可选链静默跳过。
2. 元素 append 到 DOM 后，首次 `render()` 运行时 `#is_viewer_collapsed` 仍为默认值 `false`——**spinner 被显示**。
3. 等待一帧后再次调用 `setViewerCollapsed(true, 'restore')`，此时方法存在并正确设置了 `#is_viewer_collapsed = true`，**但不会触发 `update()` 重新渲染**。
4. spinner 永远可见且转圈，因为没有任何加载完成来隐藏它。

**关键缺陷**：`setViewerCollapsed()` 在 `!loaded` 状态下修改了内部标记，但没有触发重渲染来更新 DOM（隐藏 spinner、显示 header）。

### 2.2 可能意外触发真实加载

`index.ts` 折叠分支中通过 `viewState.collapsed` 判断进入折叠路径后，调用 `load_window_zip_url` / `load_src` 来设置 `deferred_load`。但这些方法内部通过 `getViewerCollapsed()` 判断是否真正加载：

- 若 `setViewerCollapsed(true)` 因时序问题未生效 → `getViewerCollapsed()` 返回 `false` → **触发真实的网络加载**

### 2.3 折叠态文件名不显示

`getDisplayFileName()` 原实现仅从 `#last_download_target.filename` 取值：

- **ZIP 场景**：`load_window_zip_url()` 在折叠时会设置 `#last_download_target`，但 `update()` 异步完成时 header 的 `renderedCallback` 可能在此之前就已执行
- **非 ZIP 场景**：`load_src()` 在折叠时完全不设置 `#last_download_target`

而 `#preferred_original_filename` 和 `#source_name_map` 早已通过 `setPreferredOriginalFilename()` / `setSourceNameMap()` 注入，但 `getDisplayFileName()` 没有将它们作为回退。

---

## 3. 修复方案

### 3.1 `ecad_viewer.ts` — `setViewerCollapsed()` 增加未加载态的重渲染

在 `#is_viewer_collapsed` 赋值后、高度调整之前，增加：

```typescript
// 未加载时，直接同步切换 spinner 可见性（折叠隐藏、展开显示），
// 并触发一次 update() 重新渲染（正确显示/隐藏 header 和 spinner）。
// 已加载时不能调 update()——会重建子组件（kc-board-app 等）并丢失状态。
if (!this.loaded) {
    try {
        if (this.#spinner) {
            this.#spinner.hidden = next;
        }
    } catch (_) {}
    try {
        void this.update();
    } catch (_) {}
}
```

**效果**：

| 操作 | 修复前 | 修复后 |
|------|--------|--------|
| 折叠态打开页面 | spinner 永远转圈 | spinner 隐藏，仅显示 header 栏 |
| 折叠态点击展开 | — | spinner 出现 → deferred load 触发 → 加载完成 → 完整 UI |
| 已加载后折叠/展开 | 不变 | 不变（不触发 update，通过 `#viewers_container.style.display` 控制） |

### 3.2 `index.ts` — 折叠分支增加安全防护

在调用 `load_window_zip_url` / `load_src` 之前，先确认 viewer 内部确实处于折叠态；若不一致则补一次 `setViewerCollapsed(true)`，确认后再调用：

```typescript
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
```

**效果**：即使 `viewState.collapsed` 与 viewer 内部状态不一致，也不会意外触发真实网络请求。

### 3.3 `ecad_viewer.ts` — `getDisplayFileName()` 增加回退

```typescript
public getDisplayFileName(): string {
    if (this.#last_download_target?.filename) {
        return this.#last_download_target.filename;
    }
    if (this.#preferred_original_filename) {
        return this.#preferred_original_filename;
    }
    for (const v of Object.values(this.#source_name_map)) {
        if (v) return v;
    }
    return "";
}
```

**回退优先级**：`#last_download_target.filename` → `#preferred_original_filename` → `#source_name_map` 首条 → 空字符串。

这两个回退来源在 `index.ts` 的 `refreshNativeViewer()` 中通过 `setPreferredOriginalFilename()` 和 `setSourceNameMap()` 早于折叠判断就已注入，因此折叠态创建 header 时文件名始终可用。

---

## 4. 折叠/展开完整时序（修复后）

### 4.1 折叠态打开页面

```
refreshNativeViewer()
  ├─ ensureEcadModule()                   // 加载组件模块
  ├─ safeCreateElement('ecad-viewer')     // 创建元素（可能未升级）
  ├─ setAttribute('auto-load', 'false')   // 禁止 initialContentCallback 自动加载
  ├─ setViewerCollapsed(true) [尝试]      // 可能因未升级而跳过
  ├─ 添加 <ecad-source> 子元素
  ├─ mountEl.appendChild(viewer)          // 元素连接 DOM，触发升级
  ├─ 等待一帧 + updateComplete
  ├─ setSourceNameMap() / setPreferredOriginalFilename()
  ├─ setViewerCollapsed(true, 'restore')  // ← 此时方法可用
  │   ├─ #is_viewer_collapsed = true
  │   ├─ spinner.hidden = true            // [新增] 立即隐藏 spinner
  │   └─ void this.update()              // [新增] 触发重渲染
  ├─ collapsed = true → 进入折叠分支
  ├─ 确认 getViewerCollapsed() === true   // [新增] 安全检查
  ├─ load_window_zip_url / load_src       // 内部仅设置 deferred_load
  ├─ stopStatusTicker() + hideStatus()    // 隐藏外部状态层
  └─ return true
        │
        ↓ (异步: update() 完成)
  render() with #is_viewer_collapsed=true
  ├─ spinner.hidden = true
  ├─ 创建 TabHeaderElement（含文件名标签 + 折叠按钮）
  └─ renderedCallback → #sync_file_name_label()
       └─ getDisplayFileName() 返回 preferredOriginalFilename ✓
```

### 4.2 用户点击展开

```
toggleViewerCollapsed()
  └─ setViewerCollapsed(false, 'user')
      ├─ #is_viewer_collapsed = false
      ├─ spinner.hidden = false           // [新增] 显示 spinner
      ├─ void this.update()              // [新增] 重渲染
      ├─ 恢复展开态高度
      └─ #run_deferred_load_if_needed()
          ├─ 取出 deferred_load
          ├─ 调用 load_window_zip_url / load_src
          ├─ 实际发起网络请求 → 下载 → 解压 → 解析
          ├─ loaded = true → update() → 完整 UI 渲染
          └─ spinner 隐藏
```

---

## 5. 注意事项

- `setViewerCollapsed()` 中 **已加载时不能调 `update()`**：会重建 `kc-board-app` 等子组件，导致丢失 `project.on_loaded()` 已派发的事件，最终卡在 spinner。只有 `!loaded` 时才安全调用。
- `auto-load="false"` 必须在 `appendChild(viewer)` 之前设置，以阻止 `initialContentCallback` 中的自动 `load_src()` 调用。
- 折叠/展开按钮在全屏模式下被禁用（`isPageFullscreenActive()` 检查），无需额外处理。
