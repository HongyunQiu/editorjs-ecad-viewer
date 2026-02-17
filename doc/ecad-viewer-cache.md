## ECAD Viewer 缓存机制说明（QNotes 集成版）

本文档描述 QNotes 中 `editorjs-ecad-viewer` 为减少大 PCB 工程重复加载带来的等待时间而引入的缓存机制，包括：

- 缓存缓存了 viewer 的哪一部分数据
- 缓存的 Key 生成方式
- 缓存的生命周期（创建/命中/过期/淘汰/消失）
- 多个笔记加载相同输入源时是否共享缓存

> 结论先行：当前缓存**不缓存** `<ecad-viewer>` 的 DOM / Canvas / 交互事件；缓存的是 `Project` 的“解析结果快照”（数据模型层）。因此不会出现“复用 DOM 导致交互失效”的问题。

---

## 1. 为什么不能缓存 `<ecad-viewer>`（DOM 缓存会导致交互失效）

`ecad-viewer` 的组件基类 `CustomElement` 在 `disconnectedCallback()` 中会统一释放该元素注册的 `disposables`：

- 其中包含画布交互（缩放/拖动）绑定的事件监听器，以及尺寸观察器等资源
- 当元素从 DOM 中移除后，这些监听器被 dispose，再次插回 DOM 时不会自动恢复（除非重新构建实例）

因此，如果把 `<ecad-viewer>` 元素本身“缓存并复用”，一旦它经历过从 DOM 脱离，就可能变成“仍能显示最后一帧，但无法缩放/移动”的静态视图。

对应源码位置：

- `PlugIns/editorjs-ecad-viewer/packages/ecad-viewer/src/base/web-components/custom-element.ts`

---

## 2. 当前缓存缓存的是什么（缓存 viewer 的哪一部分）

当前采用的是 **Project 解析快照缓存**，缓存的是：

- 输入源（URL/Blob）被加载、解析、索引后形成的 **工程数据模型层**（`ProjectSnapshot`）
- 这些数据可用于新建的 `<ecad-viewer>` 实例快速进入 “loaded” 状态并渲染

缓存入口位置：

- `PlugIns/editorjs-ecad-viewer/packages/ecad-viewer/src/kicanvas/project.ts`
- 方法：`Project.load(sources: EcadSources)`

### 2.1 缓存快照内容（典型字段）

缓存的快照涵盖了“渲染所需的解析结果 + 派生索引”：

- **文件与解析产物**
  - `_files_by_name: Map<string, KicadPCB | KicadSch>`：解析后的 PCB/SCH 文档对象
  - `_file_content: Map<string, string>`：文件文本内容缓存
  - `_pcb: KicadPCB[]`、`_sch: KicadSch[]`
- **工程派生数据**
  - `_bom_items`：BOM 结果
  - `_label_name_refs`、`_net_item_refs`、`_designator_refs`：网络/标号/设计ator 索引
  - `_pages_by_path`、`_root_schematic_page`：页面层级与导航结构
  - `settings`、`_project_name`、`active_sch_name`、`_found_cjk`
  - `_ov_3d_url`：3D 模型 URL（如存在）

### 2.2 明确不缓存的部分

以下内容不缓存，确保交互可用且不会跨 viewer 串扰：

- `<ecad-viewer>` DOM 结构与 shadow DOM
- Canvas/WebGL Renderer 实例
- 事件监听器（缩放/拖动/点击选择）
- `SizeObserver`、`MoveAndZoom` 等与 DOM/Canvas 强绑定的对象

---

## 3. 缓存 Key：如何判定“同一输入源”

缓存 key 由输入源 `EcadSources` 计算得到（代码中为 `sourcesKey(sources)`），主要由两部分组成：

- **URL 部分**：`sources.urls` join 得到的字符串（远端文件系统/多文件来源场景）
- **Blob 部分**：对每个 blob 的 `filename + content` 做轻量 hash（`hashLite`），组合成 key

因此：

- 两个 viewer 只要输入源（URL 列表或 blob 内容）一致，就会命中同一个快照
- 输入源变化（例如上传了新 zip、同名文件内容变化）会形成新的 key，从而不命中旧快照

---

## 4. 生命周期：创建、命中、过期、淘汰、消失

该缓存是**内存缓存**，只存在于当前页面进程中（刷新/重启即消失）。

### 4.1 创建（写入缓存）

当 `Project.load(sources)` 完整解析完成并 `dispatchEvent("load")` 后，会将当前解析结果打包成 `ProjectSnapshot` 写入全局 `projectSnapshotCache: Map<string, ProjectSnapshot>`。

### 4.2 命中（读取缓存）

后续任意新的 `Project.load(sources)` 调用时：

- 先计算 key
- 若命中且未过期（TTL 内），走快速路径：
  - `this.dispose()` 清空当前 Project
  - 将快照的 Map/Array 恢复到当前实例字段
  - `this.loaded.open()` 并 `dispatchEvent("load")`

此路径跳过大量 fetch/解析/索引构建，显著缩短加载时间。

### 4.3 过期（TTL）

- TTL：10 分钟（`PROJECT_CACHE_TTL_MS = 10 * 60 * 1000`）
- 条目长时间未被访问会在后续 evict 检查中被删除

### 4.4 淘汰（LRU）

- 最大条目数：3（`PROJECT_CACHE_MAX = 3`）
- 超出后按 `lastUsedAt` 进行 LRU 淘汰

### 4.5 消失（进程级）

以下情况缓存会全部消失：

- 刷新页面
- 关闭/重开浏览器标签页
- 桌面应用容器重启（如 Electron 重启）

---

## 5. 多笔记加载相同输入源：是否共享同一个快照？

是的，会**共享同一个快照条目**。

原因：

- `projectSnapshotCache` 位于模块顶层，是“当前页面进程全局共享”的 Map
- 两个笔记只要输入源计算的 key 相同，就会命中同一条快照

注意：共享的是“快照条目”，但每个 viewer 仍各自拥有独立的 `<ecad-viewer>` 实例与交互绑定。

---

## 6. 注意事项与边界

- **引用共享风险**：当前快照恢复使用 `new Map(...)` / `Array.from(...)` 拷贝容器，但其中 `KicadPCB/KicadSch` 对象仍是同一引用。如果未来引入“会修改解析对象”的逻辑，可能造成跨实例影响。现阶段以只读渲染为主通常没有问题。
- **非持久化**：缓存不会跨刷新/重启持久化。如需跨会话秒开，需要引入 IndexedDB/CacheStorage，并解决解析对象的可序列化问题（通常需要库层支持可序列化快照或缓存中间格式）。

