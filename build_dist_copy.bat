@echo off
setlocal
chcp 65001 >nul
echo 开始构建（ecad-viewer + editorjs-ecad-viewer）并复制产物...
call npm run build:all
if errorlevel 1 (
  echo 构建失败。
  exit /b 1
)
echo 完成。
