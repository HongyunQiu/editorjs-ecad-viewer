# editorjs-ecad-viewer

把 [ecad-viewer](https://github.com/HongyunQiu/ecad-viewer) 以 **Editor.js Block Tool** 的形式嵌入。

> 当前实现已升级为原生模式：直接加载 `ecad-viewer` web component，并在块内挂载 `ecad-viewer-embedded`（非 iframe）。

## 功能

- 在 Editor.js 中插入 `ECAD Viewer` 块
- 原生挂载 `ecad-viewer-embedded`
- 可配置：
  - `viewerHostUrl`（默认 `http://localhost:8080/`）
  - `moduleUrl`（默认 `${viewerHostUrl}/ecad_viewer/ecad-viewer.js`）
  - `sourceUrl`（支持多个地址，分号 `;` 分隔）
  - `isBom`（是否 BOM 视图）
- 保存/回读为标准 Editor.js block data

## 本地开发

```bash
cd editorjs-ecad-viewer
npm install
npm run build
```

构建产物：
- `dist/ecadViewer.umd.js`
- `dist/ecadViewer.mjs`

## 测试页

打开：
- `test/editor-test-simple.html`

建议通过静态服务器访问页面（不要直接 file:// 打开）。

## 在 Editor.js 中使用

```js
import EcadViewerTool from '@editorjs/ecad-viewer';

const editor = new EditorJS({
  tools: {
    ecadViewer: {
      class: EcadViewerTool,
      config: {
        defaultViewerHostUrl: 'http://localhost:8080/',
        defaultSourceUrl: 'http://localhost:8080/video/video.kicad_pcb',
        iframeHeight: 560,
      },
    },
  },
});
```

## 后续可升级

- 支持上传本地 zip 并自动转临时 URL
- 与 QNotes 附件系统打通（自动识别附件地址）
- 优化只读模式加载体验与错误提示
