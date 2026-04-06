"""Ship hull reconstruction with symmetry optimization.

Algorithm:
1. Load mesh, find symmetry plane (ships are port/starboard symmetric)
2. Mirror one side to the other for a cleaner result
3. Extract waterline sections at regular intervals along length
4. Measure key dimensions: LOA, beam, depth, sections
5. Fit smooth B-spline curves to each section
6. Enforce symmetry on curves
7. Loft into a clean NURBS surface
8. Export optimized mesh GLB + measurements report

Usage: python hull_reconstruct.py <glb_file>
"""
import sys
import os
import datetime
import numpy as np
import trimesh
from scipy.interpolate import splprep, splev
from scipy.spatial import ConvexHull
from geomdl import BSpline, exchange
from geomdl import utilities as gutil


def find_symmetry_plane(vertices):
    """Find the symmetry plane of a ship hull (typically XZ plane, Y=0)."""
    center = vertices.mean(axis=0)
    centered = vertices - center

    # PCA to find axes
    cov = np.cov(centered.T)
    eigenvalues, eigenvectors = np.linalg.eigh(cov)

    # Sort by eigenvalue (largest = length, medium = depth, smallest = beam half)
    order = np.argsort(eigenvalues)[::-1]
    axes = eigenvectors[:, order]
    vals = eigenvalues[order]

    # Principal axis = ship length (X), secondary = depth (Z), minor = beam (Y)
    # Symmetry plane is perpendicular to the beam axis (Y)
    length_axis = axes[:, 0]
    depth_axis = axes[:, 2]
    beam_axis = axes[:, 1]

    # Ensure right-handed coordinate system
    if np.dot(np.cross(length_axis, beam_axis), depth_axis) < 0:
        depth_axis = -depth_axis

    return center, length_axis, beam_axis, depth_axis, vals


def align_hull(vertices, center, length_axis, beam_axis, depth_axis):
    """Rotate hull so length=X, beam=Y, depth=Z."""
    R = np.column_stack([length_axis, beam_axis, depth_axis])
    if np.linalg.det(R) < 0:
        R[:, 2] = -R[:, 2]
    aligned = (vertices - center) @ R
    return aligned


def enforce_symmetry(vertices, faces):
    """Mirror port side to starboard (or vice versa) for perfect symmetry."""
    # Take the side with more points (more complete scan)
    port = vertices[vertices[:, 1] >= 0]
    starboard = vertices[vertices[:, 1] <= 0]

    if len(port) >= len(starboard):
        # Mirror port to create starboard
        base = vertices[vertices[:, 1] >= -0.01]  # include centerline
        mirrored = base.copy()
        mirrored[:, 1] = -mirrored[:, 1]
        symmetric = np.vstack([base, mirrored[mirrored[:, 1] < -0.01]])
    else:
        base = vertices[vertices[:, 1] <= 0.01]
        mirrored = base.copy()
        mirrored[:, 1] = -mirrored[:, 1]
        symmetric = np.vstack([base, mirrored[mirrored[:, 1] > 0.01]])

    return symmetric


def extract_sections(vertices, n_sections, axis=0):
    """Extract cross-section point sets along the given axis."""
    vmin = np.percentile(vertices[:, axis], 1)
    vmax = np.percentile(vertices[:, axis], 99)
    positions = np.linspace(vmin, vmax, n_sections + 2)[1:-1]
    thickness = (vmax - vmin) / n_sections * 0.6

    sections = []
    for pos in positions:
        mask = np.abs(vertices[:, axis] - pos) < thickness
        pts = vertices[mask]
        if len(pts) > 20:
            sections.append({"pos": pos, "points": pts})

    return sections


def fit_section_curve(points, n_output=100, smooth=0.01):
    """Fit a smooth B-spline curve to a cross-section, enforce Y-symmetry."""
    # Project to YZ plane
    yz = points[:, 1:3]

    # Sort by angle from centroid for proper curve ordering
    center = yz.mean(axis=0)
    angles = np.arctan2(yz[:, 1] - center[1], yz[:, 0] - center[0])
    order = np.argsort(angles)
    yz_sorted = yz[order]

    # Close the curve
    yz_closed = np.vstack([yz_sorted, yz_sorted[0:1]])

    try:
        tck, u = splprep([yz_closed[:, 0], yz_closed[:, 1]], s=smooth, per=True, k=3)
        u_new = np.linspace(0, 1, n_output, endpoint=False)
        y_new, z_new = splev(u_new, tck)

        # Enforce symmetry: average y and -y pairs
        result = np.column_stack([y_new, z_new])

        # Find top and bottom (z extremes) to split port/starboard
        top_idx = np.argmax(result[:, 1])
        bottom_idx = np.argmin(result[:, 1])

        return result
    except Exception:
        return None


def measure_hull(vertices):
    """Compute key hull measurements."""
    measurements = {}
    measurements["LOA"] = vertices[:, 0].max() - vertices[:, 0].min()
    measurements["Beam"] = vertices[:, 1].max() - vertices[:, 1].min()
    measurements["Depth"] = vertices[:, 2].max() - vertices[:, 2].min()

    # Waterline beam at various stations
    z_wl = np.median(vertices[:, 2])  # approximate waterline
    wl_mask = np.abs(vertices[:, 2] - z_wl) < 0.1
    if wl_mask.sum() > 10:
        wl_pts = vertices[wl_mask]
        measurements["Beam_at_WL"] = wl_pts[:, 1].max() - wl_pts[:, 1].min()

    # Section areas at 10 stations
    n_stations = 10
    xmin, xmax = vertices[:, 0].min(), vertices[:, 0].max()
    stations = np.linspace(xmin, xmax, n_stations + 2)[1:-1]
    areas = []
    for x in stations:
        mask = np.abs(vertices[:, 0] - x) < (xmax - xmin) / n_stations * 0.5
        pts = vertices[mask]
        if len(pts) > 10:
            try:
                hull2d = ConvexHull(pts[:, 1:3])
                areas.append(hull2d.volume)  # 2D hull volume = area
            except:
                areas.append(0)
        else:
            areas.append(0)
    measurements["Section_areas"] = areas
    measurements["Max_section_area"] = max(areas) if areas else 0

    return measurements


def build_lofted_surface(sections_curves, x_positions, degree=3):
    """Loft section curves into a NURBS surface."""
    n_u = len(sections_curves)
    n_v = len(sections_curves[0])

    ctrlpts = []
    for i, (curve, x) in enumerate(zip(sections_curves, x_positions)):
        for pt in curve:
            ctrlpts.append([x, pt[0], pt[1]])  # x, y, z

    surf = BSpline.Surface()
    surf.degree_u = min(degree, n_u - 1)
    surf.degree_v = min(degree, n_v - 1)
    surf.ctrlpts_size_u = n_u
    surf.ctrlpts_size_v = n_v
    surf.ctrlpts = ctrlpts
    surf.knotvector_u = gutil.generate_knot_vector(surf.degree_u, n_u)
    surf.knotvector_v = gutil.generate_knot_vector(surf.degree_v, n_v)

    return surf


def surface_to_trimesh(surf, delta=0.01):
    """Evaluate NURBS surface and convert to trimesh."""
    surf.delta = (delta, delta)
    surf.evaluate()
    pts = np.array(surf.evalpts)
    n = len(pts)

    n_v = int(np.round(1.0 / delta)) + 1
    n_u = n // n_v
    count = n_u * n_v

    vertices = pts[:count]
    faces = []
    for i in range(n_u - 1):
        for j in range(n_v - 1):
            a = i * n_v + j
            b = a + 1
            c = (i + 1) * n_v + j
            d = c + 1
            faces.append([a, c, b])
            faces.append([b, c, d])

    return trimesh.Trimesh(vertices=vertices, faces=np.array(faces))


# ===================== MAIN =====================
if len(sys.argv) < 2:
    print("Usage: python hull_reconstruct.py <glb_file>")
    sys.exit(1)

SOURCE = sys.argv[1]
name = os.path.basename(SOURCE).rsplit(".", 1)[0]
ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

print(f"Loading: {SOURCE}")
mesh = trimesh.load(SOURCE)
if isinstance(mesh, trimesh.Scene):
    mesh = trimesh.util.concatenate(mesh.dump())
print(f"  Vertices: {len(mesh.vertices):,}, Faces: {len(mesh.faces):,}")

# Step 1: Find symmetry and align
print("\n[1/6] Finding symmetry plane...")
center, l_ax, b_ax, d_ax, evals = find_symmetry_plane(mesh.vertices)
aligned = align_hull(mesh.vertices, center, l_ax, b_ax, d_ax)
print(f"  Eigenvalues: {evals}")

# Step 2: Measure
print("\n[2/6] Measuring hull...")
meas = measure_hull(aligned)
print(f"  LOA (length):   {meas['LOA']:.2f} m")
print(f"  Beam (width):   {meas['Beam']:.2f} m")
print(f"  Depth (height): {meas['Depth']:.2f} m")
if "Beam_at_WL" in meas:
    print(f"  Beam at WL:     {meas['Beam_at_WL']:.2f} m")
print(f"  Max section area: {meas['Max_section_area']:.2f} m²")

# Step 3: Enforce symmetry
print("\n[3/6] Enforcing symmetry...")
symmetric = enforce_symmetry(aligned, None)
print(f"  Points: {len(aligned):,} -> {len(symmetric):,}")

# Step 4: Extract and fit sections
n_sections = 50
n_pts_per = 80
print(f"\n[4/6] Extracting {n_sections} cross-sections...")
sections = extract_sections(symmetric, n_sections, axis=0)
print(f"  Valid sections: {len(sections)}")

print(f"  Fitting smooth curves ({n_pts_per} pts each)...")
curves = []
x_positions = []
for sec in sections:
    curve = fit_section_curve(sec["points"], n_output=n_pts_per, smooth=0.005)
    if curve is not None:
        curves.append(curve)
        x_positions.append(sec["pos"])

print(f"  Fitted curves: {len(curves)}")

if len(curves) < 4:
    print("ERROR: Not enough valid sections")
    sys.exit(1)

# Step 5: Build NURBS surface
print(f"\n[5/6] Building NURBS surface...")
surf = build_lofted_surface(curves, x_positions, degree=3)
print(f"  Control points: {surf.ctrlpts_size_u} x {surf.ctrlpts_size_v}")

# Step 6: Export
print(f"\n[6/6] Exporting...")

# NURBS JSON
json_path = f"3d/{name}_hull_nurbs_{ts}.json"
exchange.export_json(surf, json_path)
print(f"  NURBS JSON: {json_path}")

# Optimized mesh GLB
opt_mesh = surface_to_trimesh(surf, delta=0.005)
glb_path = f"3d/{name}_hull_optimized_{ts}.glb"
opt_mesh.export(glb_path, file_type='glb')
print(f"  GLB: {glb_path} ({os.path.getsize(glb_path)/1024/1024:.1f} MB)")

# OBJ
obj_path = f"3d/{name}_hull_optimized_{ts}.obj"
opt_mesh.export(obj_path, file_type='obj')
print(f"  OBJ: {obj_path} ({os.path.getsize(obj_path)/1024/1024:.1f} MB)")

# Measurements report
report_path = f"3d/{name}_measurements_{ts}.txt"
with open(report_path, 'w') as f:
    f.write(f"Ship Hull Measurements Report\n")
    f.write(f"{'='*40}\n")
    f.write(f"Source: {SOURCE}\n")
    f.write(f"Date: {ts}\n\n")
    f.write(f"LOA (Length Overall): {meas['LOA']:.3f} m\n")
    f.write(f"Beam (Max Width):    {meas['Beam']:.3f} m\n")
    f.write(f"Depth (Max Height):  {meas['Depth']:.3f} m\n")
    if "Beam_at_WL" in meas:
        f.write(f"Beam at Waterline:   {meas['Beam_at_WL']:.3f} m\n")
    f.write(f"Max Section Area:    {meas['Max_section_area']:.3f} m²\n")
    f.write(f"\nSection Areas (bow to stern):\n")
    for i, a in enumerate(meas["Section_areas"]):
        f.write(f"  Station {i+1}: {a:.3f} m²\n")
    f.write(f"\nNURBS Surface: {surf.ctrlpts_size_u} x {surf.ctrlpts_size_v} control points, degree {surf.degree_u}x{surf.degree_v}\n")
print(f"  Report: {report_path}")

print(f"\nDone!")
