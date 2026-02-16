# editorjs-ecad-viewer (monorepo)

已将 `ecad-viewer` 与 `editorjs-ecad-viewer` 合并为单仓多包，便于统一维护与一键构建。

## 目录结构

- `packages/ecad-viewer`：ECAD 渲染内核
- `packages/editorjs-ecad-viewer`：Editor.js Block Tool 封装
- `scripts/build_dist_copy.mjs`：一键构建并复制产物（参考 `build_dist_copy` 工作流）

## 一键构建（两者同时）

```bash
cd editorjs-ecad-viewer
npm install
npm run build:all
```

这会执行：
1. 构建 `ecad-viewer`
2. 构建 `editorjs-ecad-viewer`
3. 复制产物到仓库根目录 `dist/`

## 产物说明

- `dist/ecadViewer.umd.js`
- `dist/ecadViewer.mjs`
- `dist/index.d.ts`
- `dist/ecad_viewer/ecad-viewer.js`

> 兼容原有 `viewerHostUrl + /ecad_viewer/ecad-viewer.js` 的加载方式。

## 可选：自动复制到 QNotes vendor

如果存在以下目录，脚本会自动复制：

- `../qnotes/public/vendor/editorjs-ecad-viewer/`

复制内容：
- `ecadViewer.umd.js`
- `ecad_viewer/ecad-viewer.js`
