# 室内点云处理方案 — 机舱 + 客舱 (`engine.las` + `salon.las`)

> **目标：提取船体固定结构，用于改造设计模型。**
> 可移动物体（家具、软装、临时设备）视为噪声，需要识别并去除。

## 数据概览

| 文件 | 大小 | 说明 | 保留的结构 | 去除的物体 |
|------|------|------|-----------|-----------|
| `engine.las` | ~372 MB | 机舱 | 墙壁、舱壁、地板、天花板、固定管线、通风管道、固定机械基座 | 临时工具、可拆卸设备 |
| `salon.las` | ~451 MB | 沙龙/客舱 | 墙壁、地板、天花板、门框、窗框、固定隔断、内嵌灯具、固定柜体 | 沙发、桌椅、窗帘、地毯、装饰品、可移动家具 |

## 核心思路：结构 vs 物体分离

```
原始点云
  |
  +-> 1. 粗去噪（飞点/反射噪声）
  |
  +-> 2. 提取固定结构（RANSAC 平面 + 圆柱）  --> 保留：墙/地板/天花板/管道
  |
  +-> 3. 残余点分类                           --> 判断：固定结构 or 可移动物体？
  |     |
  |     +-> 与结构面连通 + 满足规则 --> 保留（固定柜体、门框等）
  |     +-> 完全悬空 or 不满足规则  --> 丢弃（家具、软装、噪声）
  |
  +-> 4. 只对保留的结构做重建
```

**核心原则：船舶室内不存在完全悬空的结构。** 任何固定构件必然连接到墙壁、地板、天花板或管道。完全悬空的点簇 = 噪声或可移动物体，直接丢弃。

**判断规则（按优先级）：**

| 优先级 | 规则 | 判定 | 示例 |
|--------|------|------|------|
| **0（最高）** | 不与任何已知结构面接触（悬空） | **丢弃** | 噪声、吊灯装饰、窗帘 |
| 1 | 顶天立地（同时接触地板+天花板） | 保留 | 柱子、隔断、门框 |
| 2 | 紧贴墙壁 + 体积大 | 保留 | 固定柜体、管线架 |
| 3 | 接触地板或天花板 + 体积大 | 保留 | 设备基座、天花板灯槽 |
| **4（兜底）** | 其余 | **丢弃** | 靠墙沙发、搭在管道上的物品 |

## 技术选型

| 库 | 用途 | 安装 |
|----|------|------|
| **laspy** | 读写 LAS 格式 | `pip install laspy` |
| **Open3D** | 滤波、法线、RANSAC 平面、DBSCAN、Poisson 重建 | `pip install open3d` |
| **CGAL** (Python bindings) | Efficient RANSAC 多基元检测、Bilateral Smoothing | `conda install -c conda-forge cgal` |
| **pyransac3d** | 轻量级 RANSAC 圆柱/平面拟合 | `pip install pyransac3d` |
| **scikit-learn** | DBSCAN 聚类 | `pip install scikit-learn` |
| **SciPy** | 形态学运算（舱室分割） | `pip install scipy` |

---

## 1. 数据加载

```python
import laspy, open3d as o3d, numpy as np

las = laspy.read("las/engine.las")
points = np.vstack([las.x, las.y, las.z]).T.astype(np.float32)

pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(points)
```

## 2. 粗去噪

```python
# Step 1: SOR — 参数比室外稍宽松（室内点密度不均匀）
pcd, _ = pcd.remove_statistical_outlier(nb_neighbors=30, std_ratio=2.0)

# Step 2: ROR
pcd, _ = pcd.remove_radius_outlier(nb_points=10, radius=0.03)

# Step 3: 体素降采样
pcd = pcd.voxel_down_sample(voxel_size=0.01)  # 1cm 体素
```

## 3. 提取固定结构（第一层：大几何基元）

### 3.1 迭代 RANSAC 平面提取 — 墙壁/地板/天花板/舱壁

```python
planes = []
remaining = pcd
for _ in range(max_planes):
    plane_model, inliers = remaining.segment_plane(
        distance_threshold=0.02,  # 点到平面容差
        ransac_n=3,
        num_iterations=1000
    )
    if len(inliers) < min_plane_points:
        break

    plane_pcd = remaining.select_by_index(inliers)
    remaining = remaining.select_by_index(inliers, invert=True)

    # 按法线方向分类
    [a, b, c, d] = plane_model
    normal = np.array([a, b, c])
    if abs(normal[2]) > 0.8:
        label = "floor" if d > 0 else "ceiling"  # 视坐标系调整
    else:
        label = "wall"

    planes.append({"model": plane_model, "points": plane_pcd, "label": label})
```

### 3.2 RANSAC 圆柱检测 — 管道/管线/立柱

对机舱 (`engine.las`) 尤其关键：

```python
# 方案 A: pyransac3d（轻量级，迭代提取多根管道）
import pyransac3d as pyrsc
cylinders = []
remaining_pts = np.asarray(remaining.points)
for _ in range(max_cylinders):
    cyl = pyrsc.Cylinder()
    center, axis, radius, inliers = cyl.fit(remaining_pts, thresh=0.02, maxIteration=1000)
    if len(inliers) < min_cylinder_points:
        break
    cylinders.append({"center": center, "axis": axis, "radius": radius})
    remaining_pts = np.delete(remaining_pts, inliers, axis=0)

# 方案 B: CGAL Efficient RANSAC（一次性检测平面+圆柱+球+锥+环面）
# 参数：
#   epsilon = 0.02        点到基元最大距离
#   normal_threshold = 0.9  法线偏差容差 (cos 25 度)
#   cluster_epsilon = 0.05  连通性网格间距
#   min_points = 200       每个基元最少支持点数
```

**到此为止，提取出的平面和圆柱全部归为固定结构，直接保留。**

## 4. 残余点分类：固定结构 vs 可移动物体

RANSAC 提取完平面和圆柱后，剩余点包含：
- **固定结构**：门框、窗框、固定柜体、嵌入式设备、梁/肋骨
- **可移动物体**：沙发、桌椅、窗帘、地毯、装饰品

### 4.1 DBSCAN 聚类分离独立物体

```python
labels = np.array(remaining.cluster_dbscan(eps=0.05, min_points=50))
# label == -1 为散点噪声，直接丢弃
clusters = []
for label_id in range(labels.max() + 1):
    cluster_idx = np.where(labels == label_id)[0]
    cluster_pcd = remaining.select_by_index(cluster_idx)
    clusters.append(cluster_pcd)
```

### 4.2 连通性检测 — 完全悬空的直接丢弃

**核心原则：船舶室内不存在完全悬空的结构，任何物体必然连接到墙壁、地板、天花板或管道。**
完全悬空的聚类 = 噪声或可移动物体，无需进一步判断，直接丢弃。

```python
# 已提取的结构面合集（地板/天花板/墙壁/管道的点云）
structural_points = np.vstack([
    np.asarray(p["points"].points) for p in planes
] + [
    np.asarray(c["points"].points) for c in cylinders
])
struct_tree = o3d.geometry.KDTreeFlann(
    o3d.geometry.PointCloud(o3d.utility.Vector3dVector(structural_points))
)

CONTACT_DIST = 0.05  # 5cm 以内视为接触

def is_connected_to_structure(cluster_pcd):
    """检查聚类是否有点与已知结构面接触"""
    pts = np.asarray(cluster_pcd.points)
    # 抽样检查（全量太慢），检查边界点即可
    for pt in pts[::max(1, len(pts) // 100)]:  # 均匀抽样 ~100 个点
        [k, idx, dist] = struct_tree.search_radius_vector_3d(pt, CONTACT_DIST)
        if k > 0:
            return True
    return False
```

### 4.3 分类规则（按优先级排序）

```python
structural_clusters = []
discarded_clusters = []  # 悬空/家具/噪声，全部丢弃

for cluster in clusters:
    pts = np.asarray(cluster.points)
    bbox = cluster.get_axis_aligned_bounding_box()
    bbox_min = bbox.get_min_bound()
    bbox_max = bbox.get_max_bound()

    # ========================================
    # 规则 0（最高优先级）：完全悬空 → 直接丢弃
    # 不与任何已知结构面（墙/地板/天花板/管道）接触
    # ========================================
    if not is_connected_to_structure(cluster):
        discarded_clusters.append(cluster)
        continue  # 不再检查后续规则

    # ========================================
    # 规则 1：接触地板+天花板（顶天立地）→ 保留
    # 柱子/隔断/门框
    # ========================================
    touches_floor = bbox_min[2] < floor_z + 0.05
    touches_ceiling = bbox_max[2] > ceiling_z - 0.05
    if touches_floor and touches_ceiling:
        structural_clusters.append(cluster)
        continue

    # ========================================
    # 规则 2：紧贴墙壁 + 足够大 → 保留
    # 固定柜体/管线架/嵌入式设备
    # ========================================
    is_wall_attached = False
    for plane in planes:
        if plane["label"] == "wall":
            [a, b, c, d] = plane["model"]
            dists = np.abs(pts @ np.array([a, b, c]) + d)
            if np.median(dists) < 0.05 and len(pts) > min_points:
                is_wall_attached = True
                break
    if is_wall_attached:
        structural_clusters.append(cluster)
        continue

    # ========================================
    # 规则 3：接触地板或天花板（单面接触）+ 足够大 → 保留
    # 矮柜、设备基座、天花板灯槽
    # ========================================
    if (touches_floor or touches_ceiling) and len(pts) > min_points:
        structural_clusters.append(cluster)
        continue

    # ========================================
    # 其余：虽然接触结构面但不满足以上条件 → 丢弃
    # 靠墙的沙发、搭在管道上的毛巾等
    # ========================================
    discarded_clusters.append(cluster)

print(f"保留固定结构: {len(structural_clusters)} 个聚类")
print(f"丢弃（悬空/家具/噪声）: {len(discarded_clusters)} 个聚类")
```

### 4.4 engine vs salon 的差异

| | engine（机舱） | salon（客舱） |
|--|---------------|--------------|
| 残余点主要是 | 固定机械设备、管线支架 | 家具、软装 |
| 处理策略 | **偏向保留**：机舱内大部分设备是焊接/螺栓固定的 | **偏向丢弃**：客舱内非基元物体基本是家具 |
| 规则 3 点数阈值 | 放宽到 200（小型阀门、仪表盘也要保留） | 收紧到 1000（小物体大概率是装饰品） |

两者共享同一套规则逻辑，只调参数：

```python
# engine: 更宽松，保留更多
MIN_POINTS_ENGINE = 200
# salon: 更严格，积极丢弃家具
MIN_POINTS_SALON = 1000
```

## 5. 精细去噪（仅对保留的结构）

| 类型 | 去噪方法 | 原因 |
|------|----------|------|
| 平面 (墙/地板) | 投影到 RANSAC 拟合平面 | 平面先验已知，直接投影最干净 |
| 圆柱 (管道) | 投影到拟合圆柱面 | 圆柱参数已知 |
| 保留的结构聚类 | Bilateral Smoothing | 保边去噪，不破坏结构细节 |

```python
# 平面区域：直接投影去噪
for plane in planes:
    [a, b, c, d] = plane["model"]
    pts = np.asarray(plane["points"].points)
    dist = pts @ np.array([a, b, c]) + d
    pts_proj = pts - np.outer(dist, [a, b, c])

# 保留的结构聚类：Bilateral Smoothing (CGAL)
import CGAL.Point_set_processing_3 as psp
psp.bilateral_smooth_point_set(structural_points, k=50, sharpness_angle=25)
```

## 6. 房间/舱室分割（可选）

去除家具后，舱室边界更清晰，分割效果更好：

```python
# 方法: 去除地板/天花板后，2D 投影 + 连通域分析
pts_mid = pts[(pts[:, 2] > floor_z + 0.3) & (pts[:, 2] < ceiling_z - 0.3)]

# 投影到 2D 占用栅格
resolution = 0.05  # 5cm
grid = np.zeros((grid_h, grid_w), dtype=bool)
# ... 填充栅格 ...

# 形态学开运算分离舱室
from scipy.ndimage import binary_opening, label
grid_open = binary_opening(grid, iterations=3)
labeled, num_rooms = label(grid_open)
```

## 7. 表面重建（仅固定结构）

```
平面（墙/地板/天花板） --> 多边形重建 (Clean polygonal mesh)
圆柱（管道/立柱）      --> 参数化圆柱生成
固定结构聚类           --> Screened Poisson (depth=9)
                              |
                              v
                        合并为改造基础模型
```

```python
# 平面 -> 直接三角化边界
for plane in planes:
    hull = plane["points"].compute_convex_hull()

# 圆柱 -> 参数化生成
mesh_cyl = o3d.geometry.TriangleMesh.create_cylinder(radius=r, height=h)
mesh_cyl.transform(alignment_matrix)

# 固定结构聚类 -> Poisson
mesh_struct, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
    structural_pcd, depth=9)
```

输出即为**净结构模型**，可直接导入 CAD 软件做改造设计。

## 8. 质量评估

```python
# 1. 计算保留点云到重建面的 Hausdorff 距离
dist = structural_pcd.compute_point_cloud_distance(reconstructed_pcd)
print(f"Mean: {np.mean(dist):.4f}, Max: {np.max(dist):.4f}, 95th: {np.percentile(dist, 95):.4f}")

# 2. 目视检查：确认家具被完全去除、门框/窗框/固定柜被保留
# 3. 截面检查：沿关键位置切截面，确认墙壁厚度/管道直径合理
# 4. CloudCompare：叠加原始点云和重建模型对比
```

---

## 参数速查表

| 阶段 | 参数 | 建议起始值 | 说明 |
|------|------|-----------|------|
| SOR | std_ratio | 2.0 | 室内密度不均，放宽 |
| 体素降采样 | voxel_size | 0.01m | 1cm |
| RANSAC 平面 | distance_threshold | 0.02m | 点到平面容差 |
| RANSAC 圆柱 | distance_threshold | 0.02m | 点到柱面容差 |
| CGAL RANSAC | epsilon | 0.02m | 多基元检测容差 |
| CGAL RANSAC | min_points | 200 | 每个基元最少支持点数 |
| DBSCAN | eps | 0.05m | 物体分离 |
| 连通性检测 | CONTACT_DIST | 0.05m | 与结构面距离 < 5cm 视为接触 |
| 固定结构判定 | 贴墙距离 | 0.05m | 中位距 < 5cm 视为贴墙 |
| 固定结构判定 | 最小点数 (engine) | 200 | 机舱保留小型阀门/仪表 |
| 固定结构判定 | 最小点数 (salon) | 1000 | 客舱积极丢弃家具 |
| Bilateral | sharpness_angle | 25 度 | 棱线保护角度 |
| Poisson (结构) | depth | 9 | 局部重建够用 |

## 执行计划

| 阶段 | 内容 | 输入 | 输出 |
|------|------|------|------|
| **P0** | 加载 + 预览 | `engine.las` + `salon.las` | 基本统计 + 可视化截图 |
| **P1** | SOR + ROR + 降采样 | 原始点云 | 粗清洗点云 |
| **P2** | RANSAC 平面/圆柱提取 | 粗清洗点云 | 固定结构 + 残余点 |
| **P3** | 残余点 DBSCAN 聚类 + 连通性检测 + 规则分类 | 残余点 | 固定结构 / 丢弃（悬空+家具） |
| **P4** | 精细去噪（平面投影 / 圆柱投影 / Bilateral） | 保留的结构点 | 干净结构点云 |
| **P5** | 混合重建（多边形 + 参数化圆柱 + Poisson） | 干净结构点云 | 净结构网格 |
| **P6** | 质量评估 + 导出 | 结构网格 | PLY/OBJ/STEP |

## 脚本结构

```
scripts/
├── 00_load.py                # 加载与格式转换
├── 03_indoor_denoise.py      # SOR + ROR
├── 04_indoor_segment.py      # RANSAC 平面/圆柱 + DBSCAN + 连通性检测 + 结构/家具分类
├── 05_indoor_recon.py        # 仅对固定结构做混合重建
├── 07_evaluate.py            # 质量评估
└── utils.py
```
