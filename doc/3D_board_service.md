based on the info https://kicad.eda.cn/docs/open-source/ecad-viewer.html

kicad-cli server
将 AD 设计转换为 KiCad，以及从 PCB 生成 3D 模型都需要 kicad-cli。

kicad-cli docker image
基于华秋开发维护的 Kicad 分支 制作的 docker 镜像


# 打包了所有kicad官方3D模型的镜像
docker pull registry.cn-shanghai.aliyuncs.com/kicad/kicad:full

# 不包含3D模型的镜像
docker pull registry.cn-shanghai.aliyuncs.com/kicad/kicad:lite
kicad-cli-python
kicad-cli-python 是打包了 kicad-cli 命令行工具并对外提供服务的 python 项目，拉取了上述 kicad-cli docker 镜像之后，您可以执行以下命令启动文件服务和 kicad-cli 服务：


git clone https://github.com/Huaqiu-Electronics/kicad-cli-python.git
cd kicad-cli-python
pip install -r ./requirements.txt
# 开启文件服务和kicad-cli服务
python file_srv.py
python cli_srv.py
Credits
该项目包含副本或使用其他作品。这些作品及其各自的许可和条款是：

kicanvas 基于 MIT license
three-gltf-viewer 基于 MIT license
上次更新于: 2024/7/24 17:43