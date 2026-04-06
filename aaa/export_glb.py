"""Export LAS to GLB - supports point cloud mode and BPA mesh mode.
Usage:
  python export_glb.py <las_file> [--mode points|mesh] [--max-points N]
"""
import sys
import datetime
import os
import argparse
import numpy as np
import open3d as o3d
import laspy
import trimesh

parser = argparse.ArgumentParser()
parser.add_argument("las_file")
parser.add_argument("--mode", default="mesh", choices=["points", "mesh"])
parser.add_argument("--max-points", type=int, default=5_000_000)
args = parser.parse_args()

SOURCE = args.las_file
name = os.path.basename(SOURCE).rsplit(".", 1)[0]

print(f"Loading: {SOURCE}")
las = laspy.read(SOURCE)
points = np.vstack([las.x, las.y, las.z]).T
n_total = len(points)
print(f"  Points: {n_total:,}")

# Intensity for coloring
intensity = None
if hasattr(las, 'intensity'):
    intensity = np.asarray(las.intensity, dtype=np.float64)
    i_min, i_max = np.percentile(intensity, [2, 98])
    intensity = np.clip((intensity - i_min) / (i_max - i_min + 1e-6), 0, 1)

pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(points)
if intensity is not None:
    pcd.colors = o3d.utility.Vector3dVector(np.column_stack([intensity, intensity, intensity]))

# Downsample if needed
if n_total > args.max_points:
    voxel_size = 0.005
    pcd_down = pcd.voxel_down_sample(voxel_size)
    while len(pcd_down.points) > args.max_points:
        voxel_size *= 1.2
        pcd_down = pcd.voxel_down_sample(voxel_size)
    print(f"  Downsampled: {len(pcd_down.points):,} (voxel={voxel_size:.4f}m)")
    pcd = pcd_down

print("Estimating normals...")
pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.05, max_nn=30))
pcd.orient_normals_consistent_tangent_plane(k=20)

ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

if args.mode == "points":
    # Export as point cloud GLB
    print("Exporting point cloud GLB...")
    pts = np.asarray(pcd.points)
    cols = np.asarray(pcd.colors) if pcd.has_colors() else np.full((len(pts), 3), 0.6)
    colors_rgba = (np.column_stack([cols, np.ones(len(cols))]) * 255).astype(np.uint8)

    cloud = trimesh.PointCloud(vertices=pts, colors=colors_rgba)
    out_path = f"3d/{name}_points_{ts}.glb"
    cloud.export(out_path, file_type='glb')

else:
    # Ball Pivoting Algorithm - follows actual surface geometry
    print("Running Ball Pivoting Algorithm...")
    # Estimate ball radii from point spacing
    distances = pcd.compute_nearest_neighbor_distance()
    avg_dist = np.mean(distances)
    radii = [avg_dist * 1.5, avg_dist * 3, avg_dist * 6, avg_dist * 12]
    print(f"  Avg point spacing: {avg_dist*1000:.2f}mm, radii: {[f'{r*1000:.1f}mm' for r in radii]}")

    mesh = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
        pcd, o3d.utility.DoubleVector(radii)
    )
    print(f"  Mesh: {len(mesh.vertices):,} vertices, {len(mesh.triangles):,} faces")

    # Clean mesh
    mesh.remove_degenerate_triangles()
    mesh.remove_duplicated_triangles()
    mesh.remove_duplicated_vertices()
    mesh.remove_non_manifold_edges()
    print(f"  Cleaned: {len(mesh.vertices):,} vertices, {len(mesh.triangles):,} faces")

    # Export
    print("Exporting mesh GLB...")
    vertices = np.asarray(mesh.vertices)
    faces = np.asarray(mesh.triangles)
    colors_rgba = None
    if mesh.has_vertex_colors():
        c = np.asarray(mesh.vertex_colors)
        colors_rgba = (np.column_stack([c, np.ones(len(c))]) * 255).astype(np.uint8)

    tm = trimesh.Trimesh(vertices=vertices, faces=faces, vertex_colors=colors_rgba)
    out_path = f"3d/{name}_mesh_{ts}.glb"
    tm.export(out_path, file_type='glb')

print(f"\nSaved: {out_path} ({os.path.getsize(out_path)/1024/1024:.1f} MB)")
print("Done!")
