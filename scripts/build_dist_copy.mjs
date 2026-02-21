import { mkdir, copyFile, rm, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = process.cwd();
const pkgEditor = path.join(root, 'packages', 'editorjs-ecad-viewer');
const pkgEcad = path.join(root, 'packages', 'ecad-viewer');

const srcEditorDist = path.join(pkgEditor, 'dist');
const srcEcadBuild = path.join(pkgEcad, 'build', 'ecad-viewer.js');
const srcEcad3dBuild = path.join(pkgEcad, 'build', '3d-viewer.js');
const srcEcadGlyphBuild = path.join(pkgEcad, 'build', 'glyph-full.js');

const outRootDist = path.join(root, 'dist');
const outRootEcadDir = path.join(outRootDist, 'ecad_viewer');

const qnotesPublicDirCandidates = [
  // 本仓库结构：PlugIns/editorjs-ecad-viewer -> ../../QNotes/public
  path.resolve(root, '..', '..', 'QNotes', 'public'),
  // 兼容可能的目录命名
  path.resolve(root, '..', '..', 'qnotes', 'public'),
];

async function exists(p) {
  try {
    await access(p, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function safeCopy(src, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log(`copied: ${path.relative(root, src)} -> ${path.relative(root, dest)}`);
}

async function safeCopyDir(srcDir, destDir) {
  await mkdir(destDir, { recursive: true });
  const entries = await readdir(srcDir, { withFileTypes: true });
  for (const ent of entries) {
    const src = path.join(srcDir, ent.name);
    const dest = path.join(destDir, ent.name);
    if (ent.isDirectory()) {
      await safeCopyDir(src, dest);
    } else if (ent.isFile()) {
      await safeCopy(src, dest);
    }
  }
}

async function main() {
  console.log('开始执行 build_dist_copy...');

  if (!(await exists(srcEditorDist))) {
    throw new Error(`找不到 editorjs dist: ${srcEditorDist}，请先运行 npm run build`);
  }
  if (!(await exists(srcEcadBuild))) {
    throw new Error(`找不到 ecad-viewer 构建文件: ${srcEcadBuild}，请先运行 npm run build`);
  }
  if (!(await exists(srcEcad3dBuild))) {
    throw new Error(`找不到 3d-viewer 构建文件: ${srcEcad3dBuild}，请先运行 npm run build:3d`);
  }
  if (!(await exists(srcEcadGlyphBuild))) {
    throw new Error(`找不到 glyph-full 构建文件: ${srcEcadGlyphBuild}，请先运行 npm run build:glyph`);
  }

  await rm(outRootDist, { recursive: true, force: true });
  await mkdir(outRootDist, { recursive: true });
  await mkdir(outRootEcadDir, { recursive: true });

  await safeCopy(path.join(srcEditorDist, 'ecadViewer.umd.js'), path.join(outRootDist, 'ecadViewer.umd.js'));
  await safeCopy(path.join(srcEditorDist, 'ecadViewer.mjs'), path.join(outRootDist, 'ecadViewer.mjs'));
  await safeCopy(path.join(srcEditorDist, 'index.d.ts'), path.join(outRootDist, 'index.d.ts'));
  await safeCopy(srcEcadBuild, path.join(outRootEcadDir, 'ecad-viewer.js'));
  await safeCopy(srcEcad3dBuild, path.join(outRootEcadDir, '3d-viewer.js'));
  await safeCopy(srcEcadGlyphBuild, path.join(outRootEcadDir, 'glyph-full.js'));

  // 回灌到 editorjs 包自己的 dist，确保单包发布时也带上 ecad_viewer 产物
  await safeCopy(srcEcadBuild, path.join(srcEditorDist, 'ecad_viewer', 'ecad-viewer.js'));
  await safeCopy(srcEcad3dBuild, path.join(srcEditorDist, 'ecad_viewer', '3d-viewer.js'));
  await safeCopy(srcEcadGlyphBuild, path.join(srcEditorDist, 'ecad_viewer', 'glyph-full.js'));

  let qnotesPublicDir = null;
  for (const candidate of qnotesPublicDirCandidates) {
    if (await exists(candidate)) {
      qnotesPublicDir = candidate;
      break;
    }
  }

  if (qnotesPublicDir) {
    const qnotesVendorDir = path.join(qnotesPublicDir, 'vendor', 'editorjs-ecad-viewer');
    const qnotesVendorEcadDir = path.join(qnotesVendorDir, 'ecad_viewer');
    await mkdir(qnotesVendorDir, { recursive: true });
    await mkdir(qnotesVendorEcadDir, { recursive: true });

    await safeCopy(path.join(outRootDist, 'ecadViewer.umd.js'), path.join(qnotesVendorDir, 'ecadViewer.umd.js'));
    await safeCopy(path.join(outRootEcadDir, 'ecad-viewer.js'), path.join(qnotesVendorEcadDir, 'ecad-viewer.js'));
    await safeCopy(path.join(outRootEcadDir, '3d-viewer.js'), path.join(qnotesVendorEcadDir, '3d-viewer.js'));
    await safeCopy(path.join(outRootEcadDir, 'glyph-full.js'), path.join(qnotesVendorEcadDir, 'glyph-full.js'));

    // three 本地化：复制 three.module.js + examples/jsm（含 draco/basis 等 3D 解码器资源）。
    // QNotes/public/index.html 的 importmap 会指向 ./vendor/three/...
    try {
      // 注意：three 使用了 exports，无法直接 resolve 'three/package.json'。
      // 这里 resolve 'three' 本身（通常指向 build/three.module.js），再向上推导包根目录。
      const threeEntryUrl = import.meta.resolve('three');
      const threeEntryPath = fileURLToPath(threeEntryUrl);
      const threeRoot = path.dirname(path.dirname(threeEntryPath));
      const qnotesThreeDir = path.join(qnotesPublicDir, 'vendor', 'three');

      await safeCopy(
        path.join(threeRoot, 'build', 'three.module.js'),
        path.join(qnotesThreeDir, 'build', 'three.module.js'),
      );

      // 仅复制 3D 需要的子目录（比全量 jsm 更小）
      const jsmRoot = path.join(threeRoot, 'examples', 'jsm');
      const jsmOut = path.join(qnotesThreeDir, 'examples', 'jsm');
      await safeCopyDir(path.join(jsmRoot, 'loaders'), path.join(jsmOut, 'loaders'));
      await safeCopyDir(path.join(jsmRoot, 'controls'), path.join(jsmOut, 'controls'));
      await safeCopyDir(path.join(jsmRoot, 'environments'), path.join(jsmOut, 'environments'));
      await safeCopyDir(path.join(jsmRoot, 'libs'), path.join(jsmOut, 'libs'));
      await safeCopyDir(path.join(jsmRoot, 'utils'), path.join(jsmOut, 'utils'));

      console.log('已同步 three 静态资源到 qnotes vendor/three。');
    } catch (e) {
      console.log('未能复制 three 静态资源（可能未安装 three），将继续使用现有 importmap：', String(e?.message || e));
    }

    console.log('已同步复制到 qnotes vendor 目录。');
  } else {
    console.log('未检测到 qnotes 目录，跳过 vendor 复制。');
  }

  console.log('build_dist_copy 完成。');
}

main().catch((err) => {
  console.error('build_dist_copy 失败:', err);
  process.exit(1);
});
