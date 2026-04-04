"""Salon interior space analysis: detect walls/floor/ceiling, measure dimensions.

Algorithm:
1. Statistical outlier removal to denoise
2. RANSAC plane detection to find major planes (floor, ceiling, walls)
3. Classify planes by orientation (horizontal=floor/ceiling, vertical=walls)
4. Compute room dimensions from plane distances
5. Export clean model + measurement report
"""
import datetime
import os
import numpy as np
import open3d as o3d
import laspy

SOURCE = "las/salon_fixed_20260403_213935.las"
ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Loading: {SOURCE}")
las = laspy.read(SOURCE)
pts = np.vstack([las.x, las.y, las.z]).T
print(f"  Points: {len(pts):,}")

pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(pts)

# Step 1: Denoise
print("\n[1/5] Denoising...")
n0 = len(pcd.points)
pcd, _ = pcd.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
print(f"  Statistical: {n0:,} -> {len(pcd.points):,}")
n1 = len(pcd.points)
pcd, _ = pcd.remove_radius_outlier(nb_points=8, radius=0.05)
print(f"  Radius: {n1:,} -> {len(pcd.points):,}")

# Estimate normals
print("  Estimating normals...")
pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.1, max_nn=30))

# Step 2: RANSAC plane detection
print("\n[2/5] Detecting planes (RANSAC)...")
planes = []
remaining = pcd
min_points = len(pcd.points) // 50  # at least 2% of points

for i in range(10):  # find up to 10 planes
    if len(remaining.points) < min_points:
        break

    plane_model, inliers = remaining.segment_plane(
        distance_threshold=0.02, ransac_n=3, num_iterations=2000
    )
    a, b, c, d = plane_model
    normal = np.array([a, b, c])
    normal_len = np.linalg.norm(normal)
    if normal_len < 0.01:
        break
    normal /= normal_len

    inlier_cloud = remaining.select_by_index(inliers)
    remaining = remaining.select_by_index(inliers, invert=True)

    # Classify plane by normal direction
    abs_normal = np.abs(normal)
    if abs_normal[2] > 0.8:
        plane_type = "horizontal"  # floor or ceiling
    elif abs_normal[2] < 0.3:
        plane_type = "vertical"  # wall
    else:
        plane_type = "angled"

    # Compute plane center and extent
    plane_pts = np.asarray(inlier_cloud.points)
    center = plane_pts.mean(axis=0)
    distance_from_origin = -d / normal_len

    planes.append({
        "index": i,
        "normal": normal,
        "d": d,
        "type": plane_type,
        "n_points": len(inliers),
        "center": center,
        "distance": distance_from_origin,
        "points": plane_pts,
        "cloud": inlier_cloud,
    })

    print(f"  Plane {i}: {plane_type:10s} | normal=({normal[0]:.2f},{normal[1]:.2f},{normal[2]:.2f}) | "
          f"pts={len(inliers):,} | dist={distance_from_origin:.2f}m")

# Step 3: Classify and measure
print(f"\n[3/5] Classifying planes...")
horizontals = [p for p in planes if p["type"] == "horizontal"]
verticals = [p for p in planes if p["type"] == "vertical"]

# Sort horizontal by Z (lowest = floor, highest = ceiling)
horizontals.sort(key=lambda p: p["center"][2])
# Sort vertical by number of points (largest walls first)
verticals.sort(key=lambda p: p["n_points"], reverse=True)

measurements = {}

# Floor and ceiling
if len(horizontals) >= 2:
    floor = horizontals[0]
    ceiling = horizontals[-1]
    floor_z = floor["center"][2]
    ceiling_z = ceiling["center"][2]
    measurements["floor_z"] = floor_z
    measurements["ceiling_z"] = ceiling_z
    measurements["ceiling_height"] = ceiling_z - floor_z
    print(f"  Floor Z:        {floor_z:.3f}m")
    print(f"  Ceiling Z:      {ceiling_z:.3f}m")
    print(f"  Ceiling height: {measurements['ceiling_height']:.3f}m")
elif len(horizontals) == 1:
    measurements["floor_z"] = horizontals[0]["center"][2]
    print(f"  Floor Z: {measurements['floor_z']:.3f}m (ceiling not detected)")

# Walls - find opposing pairs
print(f"\n  Detected {len(verticals)} vertical planes (walls)")
wall_pairs = []
for i in range(len(verticals)):
    for j in range(i+1, len(verticals)):
        n1 = verticals[i]["normal"]
        n2 = verticals[j]["normal"]
        # Opposing walls have anti-parallel normals
        dot = np.dot(n1, n2)
        if dot < -0.8:
            c1 = verticals[i]["center"]
            c2 = verticals[j]["center"]
            dist = abs(np.dot(c2 - c1, n1))
            wall_pairs.append({
                "wall_a": verticals[i],
                "wall_b": verticals[j],
                "distance": dist,
                "direction": n1,
            })

wall_pairs.sort(key=lambda p: p["distance"], reverse=True)

for idx, wp in enumerate(wall_pairs[:4]):
    dir_name = ""
    d = wp["direction"]
    if abs(d[0]) > abs(d[1]):
        dir_name = "length (X)"
    else:
        dir_name = "width (Y)"
    measurements[f"wall_pair_{idx}"] = {
        "distance": wp["distance"],
        "direction": dir_name,
    }
    print(f"  Wall pair {idx}: {wp['distance']:.3f}m ({dir_name})")

# Step 4: Overall dimensions from point cloud extent
print(f"\n[4/5] Computing room dimensions...")
all_pts = np.asarray(pcd.points)

# Use percentiles to exclude outliers
for i, ax in enumerate(["Length (X)", "Width (Y)", "Height (Z)"]):
    p5 = np.percentile(all_pts[:, i], 2)
    p95 = np.percentile(all_pts[:, i], 98)
    dim = p95 - p5
    measurements[f"dim_{ax}"] = dim
    print(f"  {ax}: {dim:.3f}m  [{p5:.2f} to {p95:.2f}]")

# Step 5: Export
print(f"\n[5/5] Exporting...")

# Save denoised point cloud
clean_las_path = f"las/salon_clean_{ts}.las"
clean_pts = np.asarray(pcd.points)
las_header = laspy.LasHeader(point_format=6, version="1.4")
las_out = laspy.LasData(las_header)
las_out.x = clean_pts[:, 0]
las_out.y = clean_pts[:, 1]
las_out.z = clean_pts[:, 2]
las_out.write(clean_las_path)
print(f"  Clean LAS: {clean_las_path} ({os.path.getsize(clean_las_path)/1024/1024:.1f} MB)")

# Color-coded planes for visualization (save as PLY)
vis_pcd = o3d.geometry.PointCloud()
all_vis_pts = []
all_vis_colors = []
plane_colors = [
    [0.2, 0.6, 1.0],  # floor - blue
    [1.0, 0.3, 0.3],  # ceiling - red
    [0.3, 1.0, 0.3],  # wall 1 - green
    [1.0, 1.0, 0.2],  # wall 2 - yellow
    [1.0, 0.5, 0.0],  # wall 3 - orange
    [0.8, 0.2, 1.0],  # wall 4 - purple
    [0.0, 1.0, 1.0],  # cyan
    [1.0, 0.0, 1.0],  # magenta
    [0.5, 1.0, 0.5],  # light green
    [1.0, 0.8, 0.6],  # peach
]
for i, p in enumerate(planes):
    pts = p["points"]
    col = plane_colors[i % len(plane_colors)]
    all_vis_pts.append(pts)
    all_vis_colors.append(np.tile(col, (len(pts), 1)))

# Add remaining points in gray
rem_pts = np.asarray(remaining.points)
all_vis_pts.append(rem_pts)
all_vis_colors.append(np.tile([0.4, 0.4, 0.4], (len(rem_pts), 1)))

vis_pcd.points = o3d.utility.Vector3dVector(np.vstack(all_vis_pts))
vis_pcd.colors = o3d.utility.Vector3dVector(np.vstack(all_vis_colors))

vis_path = f"las/salon_planes_{ts}.ply"
o3d.io.write_point_cloud(vis_path, vis_pcd)
print(f"  Planes PLY: {vis_path} ({os.path.getsize(vis_path)/1024/1024:.1f} MB)")

# Measurements report
report_path = f"3d/salon_measurements_{ts}.txt"
with open(report_path, 'w') as f:
    f.write("Salon Interior Space Measurements\n")
    f.write("=" * 50 + "\n")
    f.write(f"Source: {SOURCE}\n")
    f.write(f"Date: {ts}\n")
    f.write(f"Total points (after cleaning): {len(pcd.points):,}\n\n")

    f.write("--- Room Dimensions ---\n")
    for key in ["dim_Length (X)", "dim_Width (Y)", "dim_Height (Z)"]:
        if key in measurements:
            f.write(f"  {key.replace('dim_', '')}: {measurements[key]:.3f} m\n")

    f.write("\n--- Plane Detection ---\n")
    if "ceiling_height" in measurements:
        f.write(f"  Floor Z:        {measurements['floor_z']:.3f} m\n")
        f.write(f"  Ceiling Z:      {measurements['ceiling_z']:.3f} m\n")
        f.write(f"  Ceiling Height: {measurements['ceiling_height']:.3f} m\n")

    f.write("\n--- Wall Distances ---\n")
    for key, val in measurements.items():
        if key.startswith("wall_pair"):
            f.write(f"  {key}: {val['distance']:.3f} m ({val['direction']})\n")

    f.write(f"\n--- Detected Planes ---\n")
    for p in planes:
        f.write(f"  Plane {p['index']}: {p['type']:10s} | "
                f"normal=({p['normal'][0]:.2f},{p['normal'][1]:.2f},{p['normal'][2]:.2f}) | "
                f"pts={p['n_points']:,} | center=({p['center'][0]:.2f},{p['center'][1]:.2f},{p['center'][2]:.2f})\n")

print(f"  Report: {report_path}")
print("\nDone!")
