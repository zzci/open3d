# 室外点云处理方案 — 船体 + 甲板 (`hull.las` + `deck.las`)

## 数据概览

| 文件 | 大小 | 说明 | 几何特征 |
|------|------|------|----------|
| `hull.las` | ~1.34 GB | 船体外壳 | 大面积光滑曲面、左右对称 |
| `deck.las.gz` | ~386 MB | 甲板（露天） | 甲板平面 + 上层建筑外表面 + 甲板设备 |

hull 和 deck 同属室外扫描，共享相似的噪声特征：
- 水面镜面反射 / 多路径效应 / 环境散射
- hull 为光滑对称曲面；deck 以大平面为主，附带甲板设备和上层建筑
- 两者配准后合并为完整的船体外部模型

## 技术选型

| 库 | 用途 | 安装 |
|----|------|------|
| **laspy** | 读写 LAS 格式 | `pip install laspy` |
| **Open3D** | 滤波、配准、法线、Poisson 重建 | `pip install open3d` |
| **CGAL** (Python bindings) | Jet Smoothing、Bilateral Smoothing | `conda install -c conda-forge cgal` |
| **pclpy** | MLS (Moving Least Squares) 曲面平滑 | `pip install pclpy` |
| **scikit-learn** | DBSCAN 聚类去噪 | `pip install scikit-learn` |
| **geomdl** | NURBS/B-Spline 曲面拟合 | `pip install geomdl` |
| **pythonocc-core** | OpenCASCADE 引擎，工业级 NURBS + STEP 导出 | `pip install pythonocc-core` |
| **SciPy** | B-Spline 截面曲线拟合 | `pip install scipy` |

---

## 1. 数据加载与初步裁剪

```python
import laspy, open3d as o3d, numpy as np

# 分别加载 hull 和 deck
for name in ["hull", "deck"]:
    las = laspy.read(f"las/{name}.las")  # deck 需先解压 .gz
    points = np.vstack([las.x, las.y, las.z]).T.astype(np.float32)  # float32 节省一半内存

pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(points)
```

**关键预检查：**
- 确认坐标系和单位（米/毫米）
- 确认水线位置 — 水线以下的点大概率是水面镜面反射产生的幻影，直接裁剪

```python
# 裁剪水线以下的反射噪点（假设 Z 方向为垂直，waterline_z 需实际确认）
points = points[points[:, 2] > waterline_z]
```

## 2. 粗去噪：DBSCAN 聚类 + SOR

LiDAR 扫描船体的典型噪声源：
- **水面镜面反射** → 水线以下幻影点（步骤 1 已裁剪）
- **水雾/浪花** → 弥散噪声体积 → DBSCAN 去除
- **多路径效应** → 沿光束偏移的假点 → SOR/MLS 去除

```python
from sklearn.cluster import DBSCAN

# Step 1: DBSCAN — 保留船体主簇，去除浪花/弥散噪声
#   先体素降采样到可处理规模再做聚类
pcd_down = pcd.voxel_down_sample(voxel_size=0.05)
pts = np.asarray(pcd_down.points)
labels = DBSCAN(eps=0.1, min_samples=50).fit_predict(pts)
main_label = np.argmax(np.bincount(labels[labels >= 0]))
hull_mask = labels == main_label
# 将 mask 映射回原始点云（通过 KDTree 最近邻）

# Step 2: SOR — 去除主簇中的稀疏离群点
pcd, idx = pcd.remove_statistical_outlier(nb_neighbors=50, std_ratio=1.5)

# Step 3: ROR — 补充去除孤立小簇
pcd, idx = pcd.remove_radius_outlier(nb_points=16, radius=0.05)
```

## 3. 利用对称性降噪（hull 专用）

船体左右舷对称是最强的先验知识，可以有效压制非对称噪声。
**注意：** 此步仅适用于 hull，deck 甲板上的设备布局不一定对称，不做镜像处理。

```
        +-- 检测对称面 (PCA / 已知中纵剖面)
        |
原始点云 -+-- 将右舷点镜像到左舷
        |
        +-- 合并 + 体素平均 -> 对称化的半船点云 -> 镜像回完整船体
```

```python
# 1. 确定对称面（假设 Y=0 为中纵剖面，或用 PCA 自动检测）
pts = np.asarray(pcd.points)

# 2. 分离两侧
port = pts[pts[:, 1] >= 0]       # 左舷
starboard = pts[pts[:, 1] < 0]   # 右舷

# 3. 镜像右舷到左舷
starboard_mirrored = starboard.copy()
starboard_mirrored[:, 1] *= -1

# 4. 合并后体素平均（等效于对称去噪）
merged = np.vstack([port, starboard_mirrored])
pcd_sym = o3d.geometry.PointCloud()
pcd_sym.points = o3d.utility.Vector3dVector(merged)
pcd_sym = pcd_sym.voxel_down_sample(voxel_size=0.005)  # 体素平均

# 5. 后续只处理半船，最终结果再镜像
```

## 4. 精细平滑：MLS / Jet Smoothing

粗去噪后仍有高频噪声残留，需要曲面级别的平滑。

**hull vs deck 策略差异：**
- **hull（船体曲面）** → MLS `polynomial_order=2`，大邻域半径，追求极致光顺
- **deck（甲板平面 + 设备）** → 甲板大平面用 MLS 平滑或直接 RANSAC 平面投影；甲板上的设备（绞车、栏杆、通风筒等）用 Bilateral Smoothing 保边去噪，避免磨平棱角

### 方案 A：Moving Least Squares（推荐用于 hull，PCL）

为每个点在邻域内拟合局部多项式曲面，再将点投影到拟合面上。**对光滑船体极为合适。**

```python
# PCL MLS (via pclpy)
import pclpy
mls = pclpy.pcl.surface.MovingLeastSquaresOMP.PointXYZ.PointNormal()
mls.setInputCloud(cloud)
mls.setSearchRadius(0.05)          # 邻域半径，越大越平滑
mls.setPolynomialOrder(2)          # 多项式阶数：2=二次曲面，足够拟合船体曲率
mls.setComputeNormals(True)
mls.process(output)
```

| 参数 | 建议值 | 说明 |
|------|--------|------|
| `search_radius` | 3~5 倍平均点间距 | 太小则不够平滑，太大则丢失细节 |
| `polynomial_order` | 2 | 二次曲面足以拟合船体局部曲率 |

### 方案 B：CGAL Jet Smoothing

用局部多项式 jet（截断 Taylor 展开）拟合邻域，同时给出曲率估计：

```python
# CGAL jet_smooth_point_set
import CGAL.Point_set_processing_3 as psp
psp.jet_smooth_point_set(point_set, nb_neighbors=100)  # neighbors 越多越平滑
```

### 方案 C：CGAL Bilateral Smoothing

沿法线方向做双边滤波，兼顾平滑与特征保持（船体上龙骨、舭部等棱线不会被磨平）：

```python
psp.bilateral_smooth_point_set(point_set, k=100,
    sharpness_angle=25)  # 角度阈值：>25 度的法线突变视为特征保留
```

### 推荐组合

```
hull: SOR 粗去噪 -> 对称化 -> MLS 平滑 (1~2 轮) -> 法线估计
deck: SOR 粗去噪 -> 甲板面 RANSAC 平面投影 + 设备区 Bilateral Smoothing -> 法线估计
```

## 5. 表面重建

### 5.1 hull 船体曲面重建

船体外壳有三条重建路线，视下游需求选择：

#### 路线 1：截面-放样法（船舶工程标准做法）

这是造船业经典方法，将 3D 问题降维为一系列 2D 曲线拟合：

```
点云 -> 等距切片（肋位站） -> 每站拟合 B-Spline 截面线 -> 放样生成 NURBS 曲面
```

```python
import trimesh
from scipy.interpolate import splprep, splev

# 1. 沿纵向等距切片（例如每 0.5m 一个肋位站）
for x_station in np.arange(x_min, x_max, 0.5):
    section_pts = pts[np.abs(pts[:, 0] - x_station) < 0.05]  # +/-5cm 切片厚度

    # 2. 对每个截面拟合 B-Spline
    tck, u = splprep([section_pts[:, 1], section_pts[:, 2]], s=smoothing_factor)
    u_fine = np.linspace(0, 1, 200)
    y_fit, z_fit = splev(u_fine, tck)

# 3. 用 pythonocc 放样（Loft）所有截面线生成 NURBS 曲面
#    -> 导出 STEP/IGES 格式供 CAD 使用
```

**优势：** 天然利用船体纵向光顺性；每条截面线独立拟合，问题简单可控；输出即 CAD 标准格式。

#### 路线 2：直接 B-Spline 曲面拟合

将点云参数化为 (u, v) 后直接拟合张量积 B-Spline：

```python
# geomdl 方案
from geomdl import fitting
surface = fitting.approximate_surface(
    points_parameterized,
    size_u=80, size_v=40,  # 控制点数量
    degree_u=3, degree_v=3
)

# 或 pythonocc (OpenCASCADE) 方案 — 工业级精度
from OCC.Core.GeomAPI import GeomAPI_PointsToBSplineSurface
```

#### 路线 3：Screened Poisson（快速三角网格）

不需要 CAD 格式时的简单方案：

```python
mesh, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(pcd, depth=10)
# depth=10~12：越高细节越多，内存消耗也越大
# 裁剪低密度外推区域
mesh.remove_vertices_by_mask(densities < np.quantile(densities, 0.01))
```

| 方法 | 输出格式 | 精度 | 适用场景 |
|------|----------|------|----------|
| 截面-放样 | NURBS (STEP/IGES) | 最高 | 船舶工程、CAD/CAM |
| B-Spline 拟合 | NURBS | 高 | 参数化分析 |
| Screened Poisson | 三角网格 (PLY/OBJ) | 中 | 快速可视化、3D 打印 |

### 5.2 deck 甲板重建

甲板兼具大平面（甲板面本身）和结构设备（绞车、栏杆、通风筒、上层建筑外壁），采用混合策略：

```
deck 点云
  |
  +-> RANSAC 检测甲板大平面 -> 平面投影 -> 干净甲板面
  |
  +-> RANSAC 检测上层建筑外壁（垂直大平面） -> 平面重建
  |
  +-> 残余点（甲板设备） -> Screened Poisson 或 Bilateral Smooth + BPA
```

### 5.3 hull + deck 配准合并

hull 和 deck 有重叠扫描区域（甲板边缘/舷墙），利用此重叠配准：

```python
# 粗配准: FPFH + RANSAC
# 精配准: Point-to-Plane ICP
result = o3d.pipelines.registration.registration_icp(
    deck_pcd, hull_pcd, max_correspondence_distance=0.02,
    init=coarse_transform,
    estimation_method=o3d.pipelines.registration.TransformationEstimationPointToPlane())
# 合并后去冗余
combined = hull_pcd + deck_pcd.transform(result.transformation)
combined = combined.voxel_down_sample(voxel_size=0.005)
```

## 6. 质量评估

```python
# 1. 计算原始点云到重建面的 Hausdorff 距离
dist = original_pcd.compute_point_cloud_distance(reconstructed_pcd)
print(f"Mean: {np.mean(dist):.4f}, Max: {np.max(dist):.4f}, 95th: {np.percentile(dist, 95):.4f}")

# 2. 曲率图检查（船体应该光滑连续）
# 3. 关键截面对比（重建 vs 原始）
# 4. CloudCompare 可视化检查
```

---

## 参数速查表

| 阶段 | 参数 | 建议起始值 | 说明 |
|------|------|-----------|------|
| DBSCAN | eps | 0.1m | 聚类邻域，视点密度调整 |
| SOR | std_ratio | 1.5 | 越低越激进 |
| MLS | search_radius | 0.05m (3~5x 点间距) | 越大越平滑 |
| MLS | polynomial_order | 2 | 二次曲面足以 |
| Jet Smooth | nb_neighbors | 50~100 | 越多越平滑 |
| Bilateral | sharpness_angle | 25 度 | deck 设备保边 |
| Poisson | depth | 10~12 | 越高越精细 |
| B-Spline | 控制点数 | 50~200/方向 | 越多越贴合 |
| B-Spline | 平滑权重 lambda | 0.01~1.0 | 越大越光顺 |

## 执行计划

| 阶段 | 内容 | 输入 | 输出 |
|------|------|------|------|
| **P0** | 加载 + 预览 | `hull.las` + `deck.las.gz` | 基本统计 + 可视化截图 |
| **P1** | 裁剪 + DBSCAN + SOR + hull 对称化 + MLS/Bilateral | 原始点云 | 干净的船体+甲板点云 |
| **P2** | hull 截面放样/B-Spline + deck 混合重建 | 清洗后点云 | 船体曲面 + 甲板网格 |
| **P3** | hull + deck 配准合并 | 重建结果 | 完整船体外部模型 |
| **P4** | 质量评估 + 导出 | 合并模型 | PLY/OBJ/STEP |

## 脚本结构

```
scripts/
├── 00_load.py                # 加载与格式转换
├── 01_outdoor_denoise.py     # hull: DBSCAN+SOR+对称化+MLS / deck: SOR+Bilateral
├── 02_outdoor_recon.py       # hull 截面放样 + deck 混合重建 + 配准合并
├── 07_evaluate.py            # 质量评估
└── utils.py
```
