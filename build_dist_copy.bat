@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
echo 开始构建（ecad-viewer + editorjs-ecad-viewer）并复制产物...

REM 确保依赖已安装（monorepo workspace 依赖在根目录安装）
if not exist "node_modules\esbuild" (
  echo 未检测到依赖（node_modules/esbuild），先执行 npm install ...
  call npm install
  set INSTALL_RESULT=!ERRORLEVEL!
  if !INSTALL_RESULT! NEQ 0 (
    echo npm install 失败！错误代码: !INSTALL_RESULT!
    exit /b !INSTALL_RESULT!
  )
)

call npm run build:all
set BUILD_RESULT=!ERRORLEVEL!
if !BUILD_RESULT! NEQ 0 (
  echo 构建失败！错误代码: !BUILD_RESULT!
  exit /b !BUILD_RESULT!
)

REM 可选：校验 QNotes vendor 复制结果（如果工程目录存在）
if exist "..\..\QNotes\public" (
  if not exist "..\..\QNotes\public\vendor\editorjs-ecad-viewer\ecadViewer.umd.js" (
    echo 警告：未发现 QNotes/vendor 产物：vendor\editorjs-ecad-viewer\ecadViewer.umd.js
  )
  if not exist "..\..\QNotes\public\vendor\editorjs-ecad-viewer\ecad_viewer\ecad-viewer.js" (
    echo 警告：未发现 QNotes/vendor 产物：vendor\editorjs-ecad-viewer\ecad_viewer\ecad-viewer.js
  )
)
echo 完成。
