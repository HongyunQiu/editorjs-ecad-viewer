## ECAD Viewer 视图状态持久化说明（QNotes 集成版）

本文档记录 `editorjs-ecad-viewer` 在 QNotes 中对“视图状态（view state）”的持久化与回放实现，覆盖：

- PCB `Layers` / `Objects` / `Nets` 面板的配置保存与恢复
- Net 的“选中 / 取消选中（无任何 net 选中）”的保存与恢复
- 与 `Project` 解析快照缓存（`projectSnapshotCache`）的兼容点与踩坑

> 目标：用户在编辑模式下调整图层/对象/网络显示后，提交保存；下次打开该笔记时能自动恢复到上次的显示状态。

---

## 1. 总体设计

### 1.1 保存载体：Editor.js block `data.viewState`

视图状态最终保存在 Editor.js block 的 `data.viewState` 中（而不是 localStorage），因此：

- **同一条笔记**内的同一个 ECAD block 能稳定恢复
- 不同笔记/不同 block 的状态**互不影响**
- 与 `Project` 缓存（模型层快照）**相互独立**，不会影响缓存命中率

相关文件：

- `PlugIns/editorjs-ecad-viewer/packages/editorjs-ecad-viewer/src/index.ts`
  - `EcadViewerData.viewState`
  - 监听 `ecad-viewer:view-state-change` 写回 block data 并触发 `dispatchChange()`
  - 加载后调用 `viewer.setViewState(viewState)` 回放

### 1.2 状态来源：`<ecad-viewer>` 对外派发事件

`<ecad-viewer>`（WebComponent）内部汇总 UI 变化并派发：

- 事件：`ecad-viewer:view-state-change`
- `detail`: `{ viewState: EcadViewerViewState }`

Editor.js 工具收到后写入 `data.viewState`。

相关文件：

- `PlugIns/editorjs-ecad-viewer/packages/ecad-viewer/src/ecad-viewer/ecad_viewer.ts`
  - `getViewState()` / `setViewState()`
  - `#emit_view_state_change()`
  - `#apply_view_state()` + 延迟重试（解决面板渲染时序差异）

---

## 2. `viewState` 数据结构（当前实现）

当前实现以 PCB 为主（SCH 可按同样方式扩展）。

```ts
type EcadViewerViewState = {
  activeTab?: "PCB" | "SCH" | "BOM" | "STEP";
  pcb?: {
    layers?: Record<string, boolean>;
    objects?: {
      tracksOpacity?: number;
      viasOpacity?: number;
      padsOpacity?: number;
      zonesOpacity?: number;
      gridOpacity?: number;
      pageOpacity?: number;
      highlightTrack?: boolean;
      objectVisibilities?: Record<string, boolean>; // Reference/Values/Footprint Text/Hidden Text
    };
    nets?: {
      filterText?: string | null;
      selectedNetNumber?: number | null; // null 表示“无任何 net 被选中”
    };
  };
};
```

说明：

- `pcb.layers`：来自 Layers 面板的逐层可见性
- `pcb.objects`：
  - 透明度滑块（tracks/vias/pads/zones/grid/page）
  - “Highlight track” 开关
  - 对象可见性（Reference/Values/Footprint Text/Hidden Text，本质映射到对应虚拟层 opacity）
- `pcb.nets`：
  - `filterText`：Nets 面板搜索过滤文本
  - `selectedNetNumber`：选中的 net（来自 Nets 面板选中、PCB 双击线路选中、或取消选中）

---

## 3. 事件与状态同步（PCB）

### 3.1 Layers 面板

事件来源：

- `kc-board-layers-panel` 派发 `ecad-viewer:board-layer-visibility-change`
  - `detail: { layerVisibility: Record<string, boolean> }`

`<ecad-viewer>` 监听后写入 `viewState.pcb.layers` 并派发 `ecad-viewer:view-state-change`。

相关文件：

- `.../kicanvas/elements/kc-board/layers-panel.ts`
- `.../ecad-viewer/ecad_viewer.ts`（`#setup_events()`）

### 3.2 Objects 面板

事件来源：

- `kc-board-objects-panel` 派发 `ecad-viewer:board-objects-settings-change`
  - 透明度/开关等
- `ecad-visibility-ctrl-list` 派发 `ecad-viewer:board-object-visibility-change`
  - `detail: { objectVisibilities: Record<string, boolean> }`

回放策略（关键点）：

- **不依赖 Objects 面板是否被打开**：回放时优先直接作用到 `BoardViewer` 与 `LayerSet`（设置 opacity / toggle），保证实际渲染生效。
- 若 Objects 面板已渲染，再调用面板的 `setSettings()` 同步 UI 值（让用户打开面板时看到一致的滑块/开关）。

相关文件：

- `.../kicanvas/elements/kc-board/objects-panel.ts`
- `.../kicanvas/elements/kc-board/objects-visibility-ctrl.ts`
- `.../ecad-viewer/ecad_viewer.ts`（`#apply_view_state()`）

### 3.3 Nets 面板（过滤 + 选中）

事件来源：

- `kc-board-nets-panel` 派发 `ecad-viewer:board-nets-settings-change`
  - `filterText`
  - `selectedNetNumber`

回放策略（满足“用面板自身选中流程驱动”的需求）：

- 回放时调用 `kc-board-nets-panel.setSettings({ selectedNetNumber })`
- 面板内部用 `kc-ui-menu.selected = "<netNumber>"` 完成选中：
  - 会自动触发 `kc-ui-menu:select`
  - 面板监听该事件并调用 `BoardViewer.focus_net(number)`，实现“选中驱动显示区”

为避免时序问题（回放可能早于 `initialContentCallback()`）：

- Nets 面板将 `kc-ui-menu:select` 的监听在 `constructor()` 中就安装，确保回放触发也能接住。

相关文件：

- `.../kicanvas/elements/kc-board/nets-panel.ts`
- `.../ecad-viewer/ecad_viewer.ts`（`#apply_view_state()`，含兜底 `viewer.focus_net(...)`）

---

## 4. Net 选中来源（不仅来自 Nets 面板）

Net 选中可能来自两条路径：

### 4.1 Nets 面板点选

- `kc-ui-menu.selected` -> `kc-ui-menu:select` -> `BoardViewer.focus_net(number)`
- 并派发 `ecad-viewer:board-nets-settings-change`，写入 `viewState.pcb.nets.selectedNetNumber`

### 4.2 PCB 双击线路选中

`BoardViewer.on_dblclick()` 会对带 `net` 的元素调用 `highlight_net(it.net)`，并通过 `KiCanvasSelectEvent` 派发选中信息。

`<ecad-viewer>` 在 `#setup_project()` 后对 `BoardViewer` 监听：

- `kicanvas:select`（`KiCanvasSelectEvent.type`）
- 若 `item.net` 可解析为 netNumber，则写入 `viewState.pcb.nets.selectedNetNumber`

相关文件：

- `.../viewers/board/viewer.ts`
- `.../ecad-viewer/ecad_viewer.ts`

---

## 5. Net 取消选中（无任何 net 被选中）

取消选中常见触发：用户点击空白处/其它元素导致 net focus 被清掉并恢复图层可见性。

为保证能被持久化，`BoardViewer` 在清理 net focus 时会派发：

- 事件：`kicanvas:net-focus-change`
- `detail: { netNumber: null }`

`<ecad-viewer>` 收到后：

- 写入 `viewState.pcb.nets.selectedNetNumber = null`
- 同步清空 Nets 面板高亮（`setSettings({ selectedNetNumber: null })`）

回放时若状态为 `null`：

- 优先调用 `BoardViewer.clear_net_focus()`（若存在）
- 并清空 Nets 面板选中

相关文件：

- `.../viewers/board/viewer.ts`（`on_document_clicked()`、`clear_net_focus()`）
- `.../ecad-viewer/ecad_viewer.ts`
- `.../kicanvas/elements/kc-board/nets-panel.ts`（支持 `selectedNetNumber: null`）

---

## 6. 与缓存（`projectSnapshotCache`）的兼容与坑

参考：`doc/ecad-viewer-cache.md`

关键结论：

- cache 缓存的是 `Project` 的解析快照（模型层），不包含 DOM，也不包含 `viewState`。
- `viewState` 回放必须在“内容已加载”后进行，但要避免触发 **组件重建**。

### 6.1 严禁在回放时调用 `<ecad-viewer>.update()`

`CustomElement.update()` 会清空并重建 renderRoot 内容，而 `ecad_viewer.ts` 的 `render()` 会创建新的子组件（如 `kc-board-app`）。

若在已 loaded 之后回放时调用 `this.update()`，可能导致：

- 子组件重建
- 错过 `project.on_loaded()` 已经派发的 change
- 结果表现为：先闪现 cache 内容，随后一直 spinner 不显示

因此：

- `#apply_view_state()` 内禁止调用 `this.update()`
- 使用“面板就绪检查 + later() 重试”来保证最终应用成功

---

## 7. 与宿主应用（QNotes）点击行为的兼容

原实现 `Viewer.setup()` 对 `document` 绑定全局 click，并调用 `on_document_clicked()`。

这会导致：

- 点击 QNotes 的“提交”等按钮也触发 BoardViewer 清理逻辑
- 造成 net focus 意外丢失（但 Nets 面板高亮仍在）

修复策略：

- 全局 click 监听改为可 dispose 的监听，并且仅当 click 发生在当前 viewer 的 `canvas` 内时才触发 `on_document_clicked()`。

相关文件：

- `PlugIns/editorjs-ecad-viewer/packages/ecad-viewer/src/viewers/base/viewer.ts`

