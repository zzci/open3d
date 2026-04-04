import os
import numpy as np
import open3d as o3d
import laspy
from flask import Flask, render_template, request, Response

app = Flask(__name__)

SOURCE_FILE = "las/salon_fixed_20260403_213935.las"

_pcd_full = None  # reload8
_centroid = None


def get_full_pcd():
    global _pcd_full
    if _pcd_full is None:
        print(f"Loading {SOURCE_FILE} ...")
        if SOURCE_FILE.endswith(".las") or SOURCE_FILE.endswith(".laz"):
            las = laspy.read(SOURCE_FILE)
            points = np.vstack([las.x, las.y, las.z]).T
            pcd = o3d.geometry.PointCloud()
            pcd.points = o3d.utility.Vector3dVector(points)
            # Use intensity for grayscale coloring
            if hasattr(las, 'intensity'):
                intensity = np.asarray(las.intensity, dtype=np.float64)
                i_min, i_max = np.percentile(intensity, [2, 98])
                intensity = np.clip((intensity - i_min) / (i_max - i_min + 1e-6), 0, 1)
                colors = np.column_stack([intensity, intensity, intensity])
                pcd.colors = o3d.utility.Vector3dVector(colors)
            # Estimate normals
            print("Estimating normals...")
            pcd.estimate_normals(search_param=o3d.geometry.KDTreeSearchParamHybrid(radius=0.1, max_nn=30))
            _pcd_full = pcd
        else:
            _pcd_full = o3d.io.read_point_cloud(SOURCE_FILE)
        print(f"Loaded {len(_pcd_full.points):,} points")
    return _pcd_full


def _generate_shading(points, normals):
    """Generate visible shading from normals + height when original colors are too dark."""
    n = len(points)
    colors = np.zeros((n, 3), dtype=np.float32)

    # Height-based color gradient (Z axis in open3d space)
    z = points[:, 2]
    z_min, z_max = np.percentile(z, [2, 98])
    z_norm = np.clip((z - z_min) / (z_max - z_min + 1e-6), 0, 1)

    # Cool-to-warm color map: blue(low) -> cyan -> white -> yellow -> red(high)
    colors[:, 0] = np.clip(z_norm * 2, 0, 1) * 0.6 + 0.3          # R
    colors[:, 1] = np.clip(1 - np.abs(z_norm - 0.5) * 2, 0, 1) * 0.5 + 0.3  # G
    colors[:, 2] = np.clip((1 - z_norm) * 2, 0, 1) * 0.6 + 0.3    # B

    # Add normal-based shading (diffuse lighting)
    if normals is not None and len(normals) == n:
        light_dir = np.array([0.3, 0.5, 0.8], dtype=np.float32)
        light_dir /= np.linalg.norm(light_dir)
        diffuse = np.clip(np.dot(normals, light_dir), 0.2, 1.0)
        colors *= diffuse[:, np.newaxis]

    return np.clip(colors, 0, 1).astype(np.float32)


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/files")
def list_files():
    """List available LAS/PLY files in las/ directory."""
    import glob
    files = []
    for ext in ("*.las", "*.ply"):
        for f in glob.glob(f"las/{ext}"):
            name = os.path.basename(f)
            size = os.path.getsize(f) / 1024 / 1024
            files.append({"name": name, "size": f"{size:.0f}MB"})
    files.sort(key=lambda x: x["name"])
    return files


@app.route("/api/switch", methods=["POST"])
def switch_file():
    """Switch to a different source file."""
    global SOURCE_FILE, _pcd_full, _centroid
    data = request.get_json()
    new_file = f"las/{data['file']}"
    if not os.path.exists(new_file):
        return {"ok": False, "error": "File not found"}
    SOURCE_FILE = new_file
    _pcd_full = None
    _centroid = None
    return {"ok": True, "file": new_file}


@app.route("/api/current")
def current_file():
    return {"file": os.path.basename(SOURCE_FILE)}


@app.route("/api/pointcloud.bin")
def pointcloud_bin():
    """Return point cloud as raw binary (float32) for fast transfer."""
    max_points = request.args.get("max_points", 0, type=int)
    pcd = get_full_pcd()

    if max_points > 0 and len(pcd.points) > max_points:
        indices = np.random.choice(len(pcd.points), max_points, replace=False)
        indices.sort()
        points = np.asarray(pcd.points)[indices].astype(np.float32)
        colors = np.asarray(pcd.colors)[indices].astype(np.float32) if pcd.has_colors() else None
        normals = np.asarray(pcd.normals)[indices].astype(np.float32) if pcd.has_normals() else None
    else:
        points = np.asarray(pcd.points).astype(np.float32)
        colors = np.asarray(pcd.colors).astype(np.float32) if pcd.has_colors() else None
        normals = np.asarray(pcd.normals).astype(np.float32) if pcd.has_normals() else None

    # If colors are too dark (uncolorized), generate shading from normals + height
    if colors is not None:
        brightness = colors.mean()
        if brightness < 0.15:
            colors = _generate_shading(points, normals)

    # Center around full point cloud centroid (consistent with save)
    global _centroid
    if _centroid is None:
        all_pts = np.asarray(pcd.points).astype(np.float32)
        _centroid = all_pts.mean(axis=0)
    points -= _centroid

    # Pack: [num_points(uint32), points(float32*3*N), colors(float32*3*N)]
    n = len(points)
    header = np.array([n], dtype=np.uint32)
    buf = header.tobytes() + points.tobytes()
    if colors is not None:
        buf += colors.tobytes()

    return Response(buf, mimetype="application/octet-stream")


@app.route("/api/save", methods=["POST"])
def save_pointcloud():
    """Save edited point cloud from browser back to PLY file."""
    import struct

    data = request.get_data()
    n = struct.unpack("<I", data[:4])[0]
    points = np.frombuffer(data[4:4 + n * 12], dtype=np.float32).reshape(n, 3)
    colors = np.frombuffer(data[4 + n * 12:], dtype=np.float32).reshape(n, 3)

    # Add back centroid offset (same one used during load)
    global _centroid
    if _centroid is None:
        pcd_orig = get_full_pcd()
        all_pts = np.asarray(pcd_orig.points).astype(np.float32)
        _centroid = all_pts.mean(axis=0)
    points = points + _centroid

    pcd_new = o3d.geometry.PointCloud()
    pcd_new.points = o3d.utility.Vector3dVector(points.astype(np.float64))
    pcd_new.colors = o3d.utility.Vector3dVector(colors.astype(np.float64))

    import datetime
    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    out_dir = SOURCE_FILE.rsplit("/", 1)[0]
    base_name = SOURCE_FILE.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    out_path = f"{out_dir}/{base_name}_save_{ts}.las"

    # Save as LAS
    las_header = laspy.LasHeader(point_format=6, version="1.4")
    las_out = laspy.LasData(las_header)
    las_out.x = points[:, 0].astype(np.float64)
    las_out.y = points[:, 1].astype(np.float64)
    las_out.z = points[:, 2].astype(np.float64)
    las_out.write(out_path)
    print(f"Saved {n:,} points to {out_path}")

    return {"ok": True, "path": out_path, "points": n}


@app.route("/api/crop", methods=["POST"])
def crop_pointcloud():
    """Crop full-res point cloud using 2D convex hull of selected points."""
    global _pcd_full, SOURCE_FILE
    import struct
    import datetime
    from scipy.spatial import ConvexHull, Delaunay

    data = request.get_data()
    n = struct.unpack("<I", data[:4])[0]
    sel_pts = np.frombuffer(data[4:4 + n * 12], dtype=np.float32).reshape(n, 3).copy()

    # Add back centroid (same one used during load)
    pcd_orig = get_full_pcd()
    if _centroid is None:
        all_pts = np.asarray(pcd_orig.points).astype(np.float32)
        _centroid = all_pts.mean(axis=0)
    sel_pts += _centroid

    print(f"Crop: {n:,} selected points received")

    # 2D convex hull on XY plane
    xy = sel_pts[:, :2]
    hull = ConvexHull(xy)
    hull_pts = xy[hull.vertices]

    # Expand hull 3%
    center = hull_pts.mean(axis=0)
    expanded = center + (hull_pts - center) * 1.03

    # Z range with margin
    z_min = sel_pts[:, 2].min() - 0.5
    z_max = sel_pts[:, 2].max() + 0.5

    delaunay = Delaunay(expanded)

    # Filter full-res
    src_pts = np.asarray(pcd_orig.points)
    z_mask = (src_pts[:, 2] >= z_min) & (src_pts[:, 2] <= z_max)
    z_idx = np.where(z_mask)[0]
    in_hull = delaunay.find_simplex(src_pts[z_idx, :2]) >= 0
    keep_idx = z_idx[in_hull]

    pcd_cropped = pcd_orig.select_by_index(keep_idx)
    print(f"Crop result: {len(pcd_cropped.points):,} points")

    ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    base_name = SOURCE_FILE.rsplit("/", 1)[-1].rsplit(".", 1)[0]
    out_dir = SOURCE_FILE.rsplit("/", 1)[0]

    # Save PLY
    ply_path = f"{out_dir}/{base_name}_cropped_{ts}.ply"
    o3d.io.write_point_cloud(ply_path, pcd_cropped)
    print(f"Saved PLY to {ply_path}")

    # Also save LAS if source was LAS
    las_path = None
    if SOURCE_FILE.endswith((".las", ".laz")):
        try:
            las_src = laspy.read(SOURCE_FILE)
            new_las = laspy.LasData(las_src.header)
            new_las.points = las_src.points[keep_idx]
            las_path = f"{out_dir}/{base_name}_cropped_{ts}.las"
            new_las.write(las_path)
            print(f"Saved LAS to {las_path}")
        except Exception as e:
            print(f"LAS save error: {e}")

    # Switch to cropped file
    SOURCE_FILE = ply_path
    _pcd_full = pcd_cropped

    return {"ok": True, "path": ply_path, "las_path": las_path, "points": len(pcd_cropped.points)}


if __name__ == "__main__":
    print("Open http://localhost:5000 in your browser")
    app.config['MAX_CONTENT_LENGTH'] = 500 * 1024 * 1024
    app.run(debug=True, port=5000)
