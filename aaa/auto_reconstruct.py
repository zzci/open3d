"""Automatic 3D reconstruction from LAS point cloud.

Pipeline:
1. Adaptive denoising (density-aware)
2. RANSAC plane detection (walls, floor, ceiling)
3. Project plane inliers to fitted planes (noise-free flat surfaces)
4. Adaptive resampling (sparse on planes, dense on curves)
5. Hybrid reconstruction: planes→quads, curves→BPA mesh
6. Merge, clean, export

Usage: python auto_reconstruct.py <las_file> [--type interior|hull]
"""
import sys
import os
import datetime
import argparse
import numpy as np
import open3d as o3d
import laspy
import trimesh

parser = argparse.ArgumentParser()
parser.add_argument("las_file")
parser.add_argument("--type", default="auto", choices=["auto", "interior", "hull"],
                    help="interior=room/cabin, hull=ship exterior")
parser.add_argument("--max-points", type=int, default=5_000_000)
args = parser.parse_args()

SOURCE = args.las_file
name = os.path.basename(SOURCE).rsplit(".", 1)[0]
ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Loading: {SOURCE}")
las = laspy.read(SOURCE)
pts = np.vstack([las.x, las.y, las.z]).T
n_orig = len(pts)
print(f"  Points: {n_orig:,}")

pcd = o3d.geometry.PointCloud()
pcd.points = o3d.utility.Vector3dVector(pts)

# Auto-detect type: interior has more horizontal planes, hull has curved surfaces
if args.type == "auto":
    extent = pts.max(axis=0) - pts.min(axis=0)
    aspect = extent[2] / max(extent[0], extent[1])  # height/length ratio
    args.type = "interior" if aspect < 0.4 else "hull"
    print(f"  Auto-detected type: {args.type} (aspect={aspect:.2f})")

# ====== STEP 1: Adaptive Denoising ======
print(f"\n[1/6] Adaptive denoising...")
# Use statistical outlier removal with density-aware threshold
pcd_clean, _ = pcd.remove_statistical_outlier(nb_neighbors=20, std_ratio=2.0)
print(f"  {n_orig:,} -> {len(pcd_clean.points):,}")

# Downsample if too large for processing
if len(pcd_clean.points) > args.max_points:
    voxel = 0.005
    pcd_work = pcd_clean.voxel_down_sample(voxel)
    while len(pcd_work.points) > args.max_points:
        voxel *= 1.2
        pcd_work = pcd_clean.voxel_down_sample(voxel)
    print(f"  Downsampled for processing: {len(pcd_work.points):,} (voxel={voxel:.4f}m)")
else:
    pcd_work = pcd_clean
    voxel = 0

print("  Estimating normals...")
pcd_work.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.1, max_nn=30))

# ====== STEP 2: RANSAC Plane Detection ======
print(f"\n[2/6] Detecting major planes...")
planes = []
remaining = pcd_work
min_plane_pts = len(pcd_work.points) // 100  # 1% minimum

for i in range(15):
    if len(remaining.points) < min_plane_pts:
        break
    model, inliers = remaining.segment_plane(distance_threshold=0.015, ransac_n=3, num_iterations=3000)
    if len(inliers) < min_plane_pts:
        break

    a, b, c, d = model
    normal = np.array([a, b, c])
    nlen = np.linalg.norm(normal)
    if nlen < 0.01:
        break
    normal /= nlen

    inlier_pcd = remaining.select_by_index(inliers)
    remaining = remaining.select_by_index(inliers, invert=True)

    plane_pts = np.asarray(inlier_pcd.points)
    abs_n = np.abs(normal)

    if abs_n[2] > 0.8:
        ptype = "floor" if plane_pts[:, 2].mean() < pts[:, 2].mean() else "ceiling"
    elif abs_n[2] < 0.3:
        if abs_n[0] > abs_n[1]:
            ptype = "wall_x"
        else:
            ptype = "wall_y"
    else:
        ptype = "angled"

    planes.append({
        "model": model, "normal": normal, "type": ptype,
        "points": plane_pts, "pcd": inlier_pcd, "n_points": len(inliers),
    })
    print(f"  Plane {i}: {ptype:10s} | n=({normal[0]:.2f},{normal[1]:.2f},{normal[2]:.2f}) | {len(inliers):,} pts")

# ====== STEP 3: Project Plane Points to Fitted Planes ======
print(f"\n[3/6] Projecting points to planes (denoising flat surfaces)...")
all_plane_meshes = []

for p in planes:
    a, b, c, d = p["model"]
    normal = p["normal"]
    pts_p = p["points"]

    # Project each point onto the plane: p' = p - (n·p + d)*n
    dots = pts_p @ normal + d
    projected = pts_p - np.outer(dots, normal)

    # Create a mesh from projected points
    # For planar regions, create a 2D Delaunay triangulation
    # Find local 2D coordinate system on the plane
    if abs(normal[2]) > 0.8:
        # Horizontal plane: use X,Y
        pts_2d = projected[:, :2]
        up_idx = 2
    elif abs(normal[0]) > abs(normal[1]):
        # Wall perpendicular to X: use Y,Z
        pts_2d = projected[:, 1:3]
        up_idx = 0
    else:
        # Wall perpendicular to Y: use X,Z
        pts_2d = projected[:, [0, 2]]
        up_idx = 1

    try:
        from scipy.spatial import Delaunay
        tri = Delaunay(pts_2d)

        # Filter long triangles (artifacts at boundaries)
        simplices = tri.simplices
        good_faces = []
        max_edge = np.percentile(
            np.linalg.norm(np.diff(projected[simplices[:, [0,1,2,0]], :], axis=1), axis=2),
            95
        ) * 2

        for face in simplices:
            verts = projected[face]
            edges = np.array([
                np.linalg.norm(verts[1] - verts[0]),
                np.linalg.norm(verts[2] - verts[1]),
                np.linalg.norm(verts[0] - verts[2]),
            ])
            if edges.max() < max_edge:
                good_faces.append(face)

        if good_faces:
            mesh = trimesh.Trimesh(vertices=projected, faces=np.array(good_faces))
            all_plane_meshes.append(mesh)
            print(f"  {p['type']:10s}: {len(good_faces):,} faces")
    except Exception as e:
        print(f"  {p['type']:10s}: triangulation failed ({e})")

# ====== STEP 4: Reconstruct Non-Plane Regions ======
print(f"\n[4/6] Reconstructing curved/non-plane regions ({len(remaining.points):,} pts)...")

if len(remaining.points) > 1000:
    remaining.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.1, max_nn=30))
    remaining.orient_normals_consistent_tangent_plane(k=15)

    if args.type == "hull":
        # BPA for hull (follows surface better)
        dists = np.asarray(remaining.compute_nearest_neighbor_distance())
        avg_dist = np.mean(dists)
        radii = [avg_dist * 2, avg_dist * 4, avg_dist * 8]
        curved_mesh_o3d = o3d.geometry.TriangleMesh.create_from_point_cloud_ball_pivoting(
            remaining, o3d.utility.DoubleVector(radii)
        )
    else:
        # Poisson for interior (fills holes better)
        curved_mesh_o3d, densities = o3d.geometry.TriangleMesh.create_from_point_cloud_poisson(
            remaining, depth=8, n_threads=-1
        )
        # Remove low density
        densities = np.asarray(densities)
        curved_mesh_o3d.remove_vertices_by_mask(densities < np.percentile(densities, 10))

    curved_mesh = trimesh.Trimesh(
        vertices=np.asarray(curved_mesh_o3d.vertices),
        faces=np.asarray(curved_mesh_o3d.triangles),
    )
    print(f"  Curved: {len(curved_mesh.vertices):,} vertices, {len(curved_mesh.faces):,} faces")
else:
    curved_mesh = None
    print("  No significant curved regions")

# ====== STEP 5: Merge All Meshes ======
print(f"\n[5/6] Merging meshes...")
meshes = all_plane_meshes[:]
if curved_mesh is not None:
    meshes.append(curved_mesh)

if meshes:
    combined = trimesh.util.concatenate(meshes)
    print(f"  Combined: {len(combined.vertices):,} vertices, {len(combined.faces):,} faces")

    # Clean up
    combined.update_faces(combined.nondegenerate_faces())
    combined.update_faces(combined.unique_faces())
    print(f"  Cleaned:  {len(combined.vertices):,} vertices, {len(combined.faces):,} faces")
else:
    print("  ERROR: No meshes to merge")
    sys.exit(1)

# ====== STEP 6: Export ======
print(f"\n[6/6] Exporting...")

glb_path = f"3d/{name}_reconstructed_{ts}.glb"
combined.export(glb_path, file_type='glb')
print(f"  GLB: {glb_path} ({os.path.getsize(glb_path)/1024/1024:.1f} MB)")

obj_path = f"3d/{name}_reconstructed_{ts}.obj"
combined.export(obj_path, file_type='obj')
print(f"  OBJ: {obj_path} ({os.path.getsize(obj_path)/1024/1024:.1f} MB)")

# Measurements
all_pts_clean = np.asarray(pcd_clean.points)
dims = {}
for i, ax in enumerate(["Length(X)", "Width(Y)", "Height(Z)"]):
    p2, p98 = np.percentile(all_pts_clean[:, i], [2, 98])
    dims[ax] = p98 - p2

report_path = f"3d/{name}_report_{ts}.txt"
with open(report_path, 'w') as f:
    f.write(f"3D Reconstruction Report\n{'='*50}\n")
    f.write(f"Source: {SOURCE}\nType: {args.type}\nDate: {ts}\n\n")
    f.write(f"--- Dimensions ---\n")
    for k, v in dims.items():
        f.write(f"  {k}: {v:.3f} m\n")
    f.write(f"\n--- Planes Detected ---\n")
    for p in planes:
        f.write(f"  {p['type']:10s}: {p['n_points']:,} pts, "
                f"normal=({p['normal'][0]:.2f},{p['normal'][1]:.2f},{p['normal'][2]:.2f})\n")
    f.write(f"\n--- Mesh ---\n")
    f.write(f"  Plane meshes: {len(all_plane_meshes)}\n")
    f.write(f"  Total vertices: {len(combined.vertices):,}\n")
    f.write(f"  Total faces: {len(combined.faces):,}\n")
print(f"  Report: {report_path}")

print(f"\nDone! Reconstructed {args.type} model:")
print(f"  Dimensions: {dims.get('Length(X)',0):.1f} x {dims.get('Width(Y)',0):.1f} x {dims.get('Height(Z)',0):.1f} m")
print(f"  Mesh: {len(combined.vertices):,} vertices, {len(combined.faces):,} faces")
