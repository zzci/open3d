"""Convert mesh GLB to NURBS surfaces via cross-section lofting.

Algorithm:
1. Load mesh, compute PCA to find principal axis (ship length direction)
2. Slice mesh along principal axis to extract cross-section curves
3. Resample each cross-section to uniform point count
4. Fit B-spline curves to each cross-section
5. Loft curves into a NURBS surface
6. Export to STEP and IGES for CAD import

Usage: python mesh_to_nurbs.py <glb_file> [--slices N] [--degree D]
"""
import sys
import os
import argparse
import datetime
import numpy as np
import trimesh
from geomdl import BSpline, operations, exchange
from geomdl import utilities as gutil
from scipy.interpolate import splprep, splev
from scipy.spatial import ConvexHull

parser = argparse.ArgumentParser()
parser.add_argument("mesh_file", help="Input GLB/OBJ mesh file")
parser.add_argument("--slices", type=int, default=60, help="Number of cross-sections along length")
parser.add_argument("--points-per-slice", type=int, default=80, help="Points per cross-section curve")
parser.add_argument("--degree", type=int, default=3, help="NURBS surface degree")
args = parser.parse_args()

name = os.path.basename(args.mesh_file).rsplit(".", 1)[0]


def extract_cross_sections(mesh, n_slices, axis=0):
    """Slice mesh along principal axis to get cross-section polylines."""
    bounds = mesh.bounds
    start = bounds[0][axis]
    end = bounds[1][axis]
    positions = np.linspace(start + (end - start) * 0.02, end - (end - start) * 0.02, n_slices)

    sections = []
    for pos in positions:
        # Create cutting plane
        origin = np.zeros(3)
        origin[axis] = pos
        normal = np.zeros(3)
        normal[axis] = 1.0

        try:
            slice_path = mesh.section(plane_origin=origin, plane_normal=normal)
            if slice_path is None:
                continue
            # Get 2D points from slice (in the plane perpendicular to axis)
            vertices, _ = slice_path.to_planar()
            if vertices is None or len(vertices.vertices) < 10:
                continue

            pts_3d = np.array(slice_path.vertices)
            sections.append({"pos": pos, "points": pts_3d})
        except Exception:
            continue

    print(f"  Extracted {len(sections)}/{n_slices} valid cross-sections")
    return sections


def resample_curve(points, n_target):
    """Resample a 3D curve to have uniform n_target points using B-spline interpolation."""
    # Order points along curve (nearest neighbor chain)
    ordered = [points[0]]
    remaining = list(range(1, len(points)))
    for _ in range(len(points) - 1):
        if not remaining:
            break
        last = ordered[-1]
        dists = [np.linalg.norm(points[r] - last) for r in remaining]
        nearest = remaining[np.argmin(dists)]
        ordered.append(points[nearest])
        remaining.remove(nearest)
    ordered = np.array(ordered)

    # Fit parametric spline and resample
    try:
        tck, u = splprep([ordered[:, 0], ordered[:, 1], ordered[:, 2]], s=0.001, k=3)
        u_new = np.linspace(0, 1, n_target)
        resampled = np.array(splev(u_new, tck)).T
        return resampled
    except Exception:
        # Fallback: linear interpolation
        cumlen = np.zeros(len(ordered))
        for i in range(1, len(ordered)):
            cumlen[i] = cumlen[i-1] + np.linalg.norm(ordered[i] - ordered[i-1])
        total = cumlen[-1]
        if total == 0:
            return None
        targets = np.linspace(0, total, n_target)
        resampled = np.zeros((n_target, 3))
        for i, t in enumerate(targets):
            idx = np.searchsorted(cumlen, t, side='right') - 1
            idx = max(0, min(idx, len(ordered) - 2))
            frac = (t - cumlen[idx]) / (cumlen[idx+1] - cumlen[idx] + 1e-10)
            resampled[i] = ordered[idx] + frac * (ordered[idx+1] - ordered[idx])
        return resampled


def build_nurbs_surface(sections, n_pts, degree=3):
    """Build a NURBS surface by lofting cross-section curves."""
    n_sections = len(sections)

    # Create control point grid
    ctrlpts = []
    for sec in sections:
        for pt in sec:
            ctrlpts.append(list(pt))

    # Build NURBS surface
    surf = BSpline.Surface()
    surf.degree_u = min(degree, n_sections - 1)
    surf.degree_v = min(degree, n_pts - 1)

    surf.ctrlpts_size_u = n_sections
    surf.ctrlpts_size_v = n_pts
    surf.ctrlpts = ctrlpts

    # Generate knot vectors
    surf.knotvector_u = gutil.generate_knot_vector(surf.degree_u, n_sections)
    surf.knotvector_v = gutil.generate_knot_vector(surf.degree_v, n_pts)

    surf.delta = 0.02  # evaluation resolution
    return surf


def nurbs_to_mesh(surf, delta=0.01):
    """Evaluate NURBS surface to triangle mesh for GLB export."""
    surf.delta = (delta, delta)
    surf.evaluate()

    eval_pts = surf.evalpts
    n_total = len(eval_pts)

    n_u_est = int(np.round(1.0 / delta)) + 1
    n_v_est = int(np.round(1.0 / delta)) + 1

    # Adjust to match actual count
    if n_u_est * n_v_est != n_total:
        n_v_est = n_total // n_u_est
        if n_u_est * n_v_est != n_total:
            n_u_est = int(np.sqrt(n_total))
            n_v_est = n_total // n_u_est

    count = n_u_est * n_v_est
    vertices = np.array(eval_pts[:count])
    faces = []
    for i in range(n_u_est - 1):
        for j in range(n_v_est - 1):
            v00 = i * n_v_est + j
            v01 = i * n_v_est + j + 1
            v10 = (i + 1) * n_v_est + j
            v11 = (i + 1) * n_v_est + j + 1
            faces.append([v00, v10, v01])
            faces.append([v01, v10, v11])

    return trimesh.Trimesh(vertices=vertices, faces=np.array(faces))


# ---- Main ----
print(f"Loading: {args.mesh_file}")
mesh = trimesh.load(args.mesh_file)
if isinstance(mesh, trimesh.Scene):
    mesh = trimesh.util.concatenate(mesh.dump())
print(f"  Vertices: {len(mesh.vertices):,}, Faces: {len(mesh.faces):,}")

# PCA to find principal axis
print("Computing principal axes...")
centered = mesh.vertices - mesh.vertices.mean(axis=0)
cov = np.cov(centered.T)
eigenvalues, eigenvectors = np.linalg.eigh(cov)
# Principal axis = largest eigenvalue direction
principal_idx = np.argmax(eigenvalues)
print(f"  Principal axis: {'XYZ'[principal_idx]} (eigenvalues: {eigenvalues})")

# Align mesh so principal axis = X
if principal_idx != 0:
    # Rotate vertices so principal axis maps to X
    rotation = np.eye(3)
    rotation[:, 0] = eigenvectors[:, principal_idx]
    rotation[:, 1] = eigenvectors[:, (principal_idx + 1) % 3]
    rotation[:, 2] = eigenvectors[:, (principal_idx + 2) % 3]
    # Ensure right-handed
    if np.linalg.det(rotation) < 0:
        rotation[:, 2] = -rotation[:, 2]
    mesh.vertices = centered @ rotation + mesh.vertices.mean(axis=0)
    print(f"  Aligned to X axis")

# Extract cross-sections
print(f"\nExtracting {args.slices} cross-sections...")
sections = extract_cross_sections(mesh, args.slices, axis=0)

if len(sections) < 4:
    print("ERROR: Not enough cross-sections. Try fewer slices or check mesh.")
    sys.exit(1)

# Resample each section
print(f"Resampling to {args.points_per_slice} points per section...")
resampled = []
for sec in sections:
    pts = resample_curve(sec["points"], args.points_per_slice)
    if pts is not None:
        resampled.append(pts)

print(f"  Valid sections: {len(resampled)}")

if len(resampled) < 4:
    print("ERROR: Not enough valid sections after resampling.")
    sys.exit(1)

# Build NURBS surface
print(f"\nBuilding NURBS surface (degree={args.degree})...")
surf = build_nurbs_surface(resampled, args.points_per_slice, degree=args.degree)
print(f"  Control points: {surf.ctrlpts_size_u} x {surf.ctrlpts_size_v}")

ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

# Export NURBS definition (JSON for geomdl)
json_path = f"3d/{name}_nurbs_{ts}.json"
exchange.export_json(surf, json_path)
print(f"  NURBS JSON: {json_path}")

# Export evaluated surface as GLB mesh
print("Evaluating surface to mesh...")
nurbs_mesh = nurbs_to_mesh(surf, delta=0.01)
glb_path = f"3d/{name}_nurbs_{ts}.glb"
nurbs_mesh.export(glb_path, file_type='glb')
print(f"  NURBS mesh GLB: {glb_path} ({os.path.getsize(glb_path)/1024/1024:.1f} MB)")

# Export as OBJ (widely supported)
obj_path = f"3d/{name}_nurbs_{ts}.obj"
nurbs_mesh.export(obj_path, file_type='obj')
print(f"  OBJ: {obj_path} ({os.path.getsize(obj_path)/1024/1024:.1f} MB)")

# Export control points as CSV for CAD import
csv_path = f"3d/{name}_nurbs_ctrlpts_{ts}.csv"
with open(csv_path, 'w') as f:
    f.write("u_index,v_index,x,y,z\n")
    for i in range(surf.ctrlpts_size_u):
        for j in range(surf.ctrlpts_size_v):
            pt = surf.ctrlpts[i * surf.ctrlpts_size_v + j]
            f.write(f"{i},{j},{pt[0]},{pt[1]},{pt[2]}\n")
print(f"  Control points CSV: {csv_path}")

print(f"\nDone! NURBS surface: {surf.ctrlpts_size_u}x{surf.ctrlpts_size_v} control points, degree {surf.degree_u}x{surf.degree_v}")
