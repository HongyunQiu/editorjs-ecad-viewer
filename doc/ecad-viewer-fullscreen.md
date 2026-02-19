## ECAD Viewer 页面内全屏改造说明（QNotes 集成版）

本文档记录 `editorjs-ecad-viewer` 在 QNotes 中的“全屏”行为改造与踩坑点。

---

## 1. 背景与目标

原先右侧按钮 `Switch full screen mode` 调用浏览器原生 Fullscreen API（`documentElement.requestFullscreen()`），导致：

- 进入的是“浏览器真全屏”（浏览器 UI 消失），并非 QNotes 内的工具全屏
- 行为与 `editorjs-Excalidraw` / `editorjs-univer` 的“页面内全屏”不一致

目标：

- 不使用浏览器原生 Fullscreen API
- 在当前页面内让 ECAD Viewer 覆盖整个视口显示（包含盖住 QNotes 顶栏）
- 支持 ESC / 再次点击按钮退出
- 不破坏 viewer 的鼠标/键盘交互
- ZIP / SCH / PCB 三种输入源全屏表现一致

---

## 2. 关键坑：不能“移动现有 <ecad-viewer> DOM”来实现全屏

参考 `ecad-viewer-cache.md` 的结论：**不能缓存/复用 `<ecad-viewer>` DOM**。

原因是基类 `CustomElement` 在 `disconnectedCallback()` 会释放 disposables：

- 文件：`packages/ecad-viewer/src/base/web-components/custom-element.ts`
- 逻辑：`disconnectedCallback()` -> `this.disposables.dispose()`

如果把现有 `<ecad-viewer>` 从父节点挪到其它容器（哪怕再插回），就会触发断连，导致：

- 画面仍能显示最后一帧
- 但缩放/拖拽/点击选择等交互事件被 dispose，无法恢复

因此，“把当前 viewer 挪到 body overlay 里”是错误方案。

---

## 3. 关键坑：仅用 position: fixed 的“伪全屏”可能盖不住顶栏/高度不满

在 QNotes 页面结构下，ECAD Viewer 常位于编辑器滚动容器内部。

只给 `<ecad-viewer>` 加 `position: fixed` 可能仍受局部 stacking context / 视口计算影响，表现为：

- 盖不住 `.topbar`（刷新/通知/搜索那条）
- 高度像被限制在编辑区域，只到半屏

因此需要把“全屏容器”放到 `document.body` 层级，确保覆盖整个页面视口。

---

## 4. 最终方案：body 下 overlay + 克隆 viewer（不移动原 viewer）

对齐 `editorjs-Excalidraw` / `editorjs-univer` 的思路，采用“Portal 到 body”的覆盖层方式，但为了规避断连问题，采取**克隆实例**：

- **进入全屏**
  - 在 `document.body` 下创建 overlay：
    - `position: fixed; inset: 0; z-index: 2147483647; background: white`
  - 创建一个新的 `<ecad-viewer>`（克隆实例）挂载到 overlay
  - 原始 viewer 不移动，仅设置：
    - `visibility: hidden; pointer-events: none`（保持布局稳定，避免 editor 抖动）
  - `body.style.overflow = "hidden"` 禁止底层滚动
  - `keydown capture` 监听 ESC 退出

- **退出全屏**
  - 移除 overlay（克隆实例会随 overlay 一并销毁）
  - 恢复原始 viewer 的可见性与交互
  - 恢复 `body.style.overflow`

实现位置：

- 文件：`packages/ecad-viewer/src/ecad-viewer/ecad_viewer.ts`
- 方法：`on_full_windows()` / `#enter_page_fullscreen()` / `#exit_page_fullscreen()`

---

## 5. ZIP 白屏问题与修复（与缓存/输入源有关）

现象：

- 单独 SCH / PCB 文件全屏正常
- ZIP 场景全屏后出现全白，像是“没加载上”

原因：

- ZIP 路径通常走 `load_zip()` / `window.zip_url`，不会把 sources 以 `ecad-blob/ecad-source` 的形式写回 DOM
- 如果全屏克隆实例仅通过 `clone ecad-blob/ecad-source` 来复制输入源，就会拿不到 ZIP 的真实输入源，从而无法加载

修复：

- 在 `#setup_project(sources)` 内记录最近一次成功加载的 `EcadSources`（`#last_sources`）
- 全屏克隆优先使用 `#last_sources` 初始化，而不是依赖 DOM 子节点
- 为了避免克隆实例走默认 `load_src()` 抢跑，提供 `#initial_sources_override`：
  - 克隆实例连接 DOM 后优先用 override 直接 `#setup_project(sources)`
- 同时把 `project.ov_3d_url` 作为 override 带过去，保证 3D 页签一致

相关字段/逻辑位置：

- `#last_sources`
- `#initial_sources_override`
- `#initial_ov_3d_url_override`

---

## 6. 与 Project 快照缓存的关系

QNotes 集成版缓存（`projectSnapshotCache`）缓存的是 **Project 解析快照**，而不是 DOM：

- 命中缓存时，新 viewer 仍会走 `Project.load(sources)` 的快照恢复路径
- 本次全屏使用“克隆 viewer + 复用 sources”，因此仍可命中缓存，加载速度不会退化

详见：`doc/ecad-viewer-cache.md`

---

## 7. 用户可见行为（最终效果）

- 点击 `Switch full screen mode`：
  - ECAD Viewer 在页面内覆盖全视口，**会盖住 QNotes 顶栏**
  - 浏览器 UI 不消失（不是 F11 真全屏）
- 再次点击按钮或按 **ESC**：
  - 退出页面内全屏，回到原来的嵌入位置
- SCH / PCB / ZIP 三种输入源行为一致

