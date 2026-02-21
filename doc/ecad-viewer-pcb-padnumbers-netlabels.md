## PCB Pad编号 / Net Label 叠加显示（KiCad 对齐实现说明）

本文档记录 `editorjs-ecad-viewer` 中对 **PCB 的 Pad编号与 Net Label（Pad/走线/过孔）** 的叠加显示实现、与 KiCad(Pcbnew) 的对齐点、以及在多层板/高对比/性能方面的策略。

---

### 1. 目标能力

- **Pad编号**：在焊盘中心显示 `pad.number`
- **Net Label**
  - **Pad**：在焊盘上显示网络名（来自 `pad.net.name`）
  - **走线**：在走线段上显示网络名（来自 `board.getNetName(netNumber)`），并按视口长度 **重复显示**（KiCad 风格）
  - **过孔**：在过孔中心显示网络名（同上）
- **多层板显示策略**：不同铜层的走线 Net Label **不串层**，只在对应铜层可见时显示（KiCad 风格的 per-layer netname layer）
- **高对比模式对齐（近似）**：当用户在 Layers 面板“高亮某铜层”时，仅显示该“主层”的 netlabel（其余层隐藏）
- **LOD/缩放阈值抑制**：缩放不够时不绘制标签，减少每帧重建开销，提升速度

---

### 2. KiCad 参考实现点（kicad-source-mirror）

主要参考文件：
- `pcbnew/pcb_painter.cpp`
  - `PCB_PAINTER::draw(const PAD*, ...)`：Pad编号/Pad netname 分两行、字体大小与偏移估算
  - `PCB_PAINTER::renderNetNameForSegment(...)`：走线 netname 重复显示（与视口 bbox 相关）
  - `PCB_PAINTER::draw(const PCB_VIA*, ...)`：via netname 显示
- `pcbnew/pcb_track.cpp`
  - `PCB_TRACK::ViewGetLayers()`：走线与其 netname 分配到不同 layer（`GetNetnameLayer(trackLayer)`）
  - `PCB_TRACK::ViewGetLOD()`：netname 的 LOD/缩放与长度阈值（例如 `lodScaleForThreshold(..., 4.0mm)`）
  - `PCB_VIA::ViewGetLOD()`：via netname 的 LOD/缩放与可见性（例如 `lodScaleForThreshold(..., 10mm)`）
- `pcbnew/pcb_draw_panel_gal.cpp`
  - `setDefaultLayerDeps()`：`SetRequired(GetNetnameLayer(layer), layer)`，使 netname layer 的可见性依赖对应铜层
- `include/layer_ids.h`
  - `GetNetnameLayer()` / `IsNetnameLayer()`：PCB layer 到 netname layer 的映射

---

### 3. editorjs-ecad-viewer 的实现概览

#### 3.1 渲染与文字

- 渲染后端：WebGL2
- 文字绘制：`StrokeFont.default().draw(...)`
- 坐标：PCB 内部以 mm 为主；文字绘制使用 KiCad IU（输入时乘 `10000`），并在 `Font.draw_line()` 内部缩放回 mm（`0.0001`）

#### 3.2 图层设计（Label 虚拟层）

标签渲染使用虚拟图层（ViewLayer），通过 `opacity` 控制显隐，避免修改 PCB 数据本体。

主要 label 层（定义在 `packages/ecad-viewer/src/viewers/board/layers.ts`）：

- **Pad labels**
  - 通孔/NPTH（全局层）：`:Labels:PadNumbers`、`:Labels:PadNetNames`
  - SMD/connect（前后分层，避免串层）：  
    - `:Labels:F.Cu:PadNumbers`、`:Labels:B.Cu:PadNumbers`  
    - `:Labels:F.Cu:PadNetNames`、`:Labels:B.Cu:PadNetNames`
- **Track net labels（per-copper-layer）**
  - `:Labels:<CuLayer>:TrackNetNames`（例如 `:Labels:F.Cu:TrackNetNames`）
- **Via net labels（独立层，KiCad 风格）**
  - `:Labels:ViaNetNames`

> 注意：历史兼容保留了 `:Labels:TrackNetNames`（legacy 单层），但当前逻辑不再使用它绘制走线标签。

#### 3.3 Objects 面板开关与 viewState 持久化

Objects 面板提供 3 个开关（key 写入 `viewState.pcb.objects.objectVisibilities`）：

- `Pad Numbers`
- `Net Names (Pads)`
- `Net Names (Tracks/Vias)`

这些开关映射到 label layer 的 `opacity`：

- `Pad Numbers`：控制 `:Labels:PadNumbers` + `:Labels:F.Cu:PadNumbers` + `:Labels:B.Cu:PadNumbers`
- `Net Names (Pads)`：控制 `:Labels:PadNetNames` + `:Labels:F.Cu:PadNetNames` + `:Labels:B.Cu:PadNetNames`
- `Net Names (Tracks/Vias)`：控制
  - 所有 per-layer track label 层 `:Labels:<CuLayer>:TrackNetNames`
  - 以及 `:Labels:ViaNetNames`

回放/兜底逻辑在 `packages/ecad-viewer/src/ecad-viewer/ecad_viewer.ts`：即使 Objects 面板尚未渲染，也会直接对 `viewer.layers` 施加 `opacity`，保证渲染生效。

---

### 4. 关键规则

#### 4.1 Net Label 文本裁剪（路径形式）

若 netname 中包含 `/`，只显示最后一个 `/` 之后的内容：
- `/aaa/bbb` → `bbb`

该规则仅作用于 label 绘制文本，不修改 net 数据。

#### 4.2 走线标签重复显示（与视口相关）

走线 netname 的重复显示按 KiCad `renderNetNameForSegment()` 思路实现：

- 线段太短（按 `width * numChar` 估算）则不显示
- 根据线段长度与视口 bbox 尺寸估算重复次数 `num_names`
- 在 `1..num_names` 的均分点绘制，且点需落在当前视口 bbox 内

当前对 arc 走线不绘制文字（与 KiCad 一致：pcbnew 中也未实现文字沿弧路径）。

#### 4.3 多层板：per-layer track label（避免串层）

每个铜层独立 label layer：
- 只绘制该层 `LineSegment.layer == <CuLayer>` 的 netname
- 并通过 `ViewLayer.visible = () => copperLayer.visible` 使其可见性依赖该铜层（等价 KiCad `SetRequired(GetNetnameLayer(layer), layer)`）

#### 4.4 高对比（近似 KiCad：只显示主层标签）

KiCad 的高对比模式有明确配置；本项目中没有该开关，因此用 **“高亮铜层”** 近似：

- 当存在被高亮的铜层（primary layer）时：
  - 只绘制该铜层对应的 track labels
  - via labels 仅在“via 穿过该主层”时显示

主层获取接口：
- `LayerSet.primary_high_contrast_copper_layer_name()`

#### 4.5 LOD/缩放阈值抑制（性能）

参考 KiCad `lodScaleForThreshold`：

- Track netname：阈值约 `4.0mm`
- Via netname：阈值约 `10.0mm`

实现上用 `camera.zoom >= threshold_mm / width_mm` 进行近似判断；不满足则跳过绘制。

---

### 5. 主要改动文件索引

- 图层/label 层定义：`packages/ecad-viewer/src/viewers/board/layers.ts`
- Pad labels（静态，paint 后生成一次 retained graphics）：`packages/ecad-viewer/src/viewers/board/painter.ts`
- Track/Via labels（动态，每次 draw 前重建；含 per-layer/high-contrast/LOD）：`packages/ecad-viewer/src/viewers/board/viewer.ts`
- Objects 面板开关与映射：`packages/ecad-viewer/src/kicanvas/elements/kc-board/objects-visibility-ctrl.ts`
- viewState 持久化与回放兜底：`packages/ecad-viewer/src/ecad-viewer/ecad_viewer.ts`

---

### 6. 常见问题排查

- **只开 B.Cu，F.Cu 的标签还显示？**
  - 确认使用的是 `:Labels:F.Cu:*` / `:Labels:B.Cu:*` 的 SMD pad label 层（已实现），并确保 `F.Cu` 的 layer visibility 为 false。
- **缩放较小时卡顿/标签太多？**
  - LOD 阈值会抑制绘制；若仍过多，可进一步提高阈值或对重复次数上限做 clamp（后续可扩展）。
- **高亮某铜层后其它层标签仍出现？**
  - 高对比近似逻辑依赖“铜层是否处于 highlighted”。需要通过 Layers 面板触发 layer highlight。

