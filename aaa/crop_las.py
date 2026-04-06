"""Crop LAS using 2D convex hull from latest _save PLY. Output: *_fixed_{ts}.las"""
import sys
import glob
import datetime
import os
import numpy as np
import laspy
from scipy.spatial import ConvexHull, Delaunay

LAS_DIR = "las"

# Find the latest _save_ PLY file
save_files = sorted(glob.glob(f"{LAS_DIR}/*_save_*.las"), key=os.path.getmtime, reverse=True)
if not save_files:
    print("No _save_ LAS files found in las/")
    sys.exit(1)

EDITED = save_files[0]
# Determine source LAS from filename (e.g. hull_save_xxx.las -> hull.las)
base = os.path.basename(EDITED).split("_save_")[0]
SOURCE_LAS = f"{LAS_DIR}/{base}.las"

if not os.path.exists(SOURCE_LAS):
    print(f"Source LAS not found: {SOURCE_LAS}")
    sys.exit(1)

print(f"Edited mask: {EDITED}")
print(f"Source LAS:  {SOURCE_LAS}")

las_edited = laspy.read(EDITED)
edited_pts = np.vstack([las_edited.x, las_edited.y, las_edited.z]).T
print(f"  Mask: {len(edited_pts):,} points")

# 2D convex hull + 3% expansion
xy = edited_pts[:, :2]
hull = ConvexHull(xy)
hull_pts = xy[hull.vertices]
center = hull_pts.mean(axis=0)
expanded = center + (hull_pts - center) * 1.03
delaunay = Delaunay(expanded)

z_min = edited_pts[:, 2].min() - 0.5
z_max = edited_pts[:, 2].max() + 0.5
print(f"  Z: [{z_min:.2f}, {z_max:.2f}], Hull vertices: {len(hull_pts)}")

print(f"\nLoading: {SOURCE_LAS}")
las = laspy.read(SOURCE_LAS)
pts = np.vstack([las.x, las.y, las.z]).T
n_src = len(pts)
print(f"  Source: {n_src:,}")

print("Filtering...")
z_mask = (pts[:, 2] >= z_min) & (pts[:, 2] <= z_max)
z_idx = np.where(z_mask)[0]
in_hull = delaunay.find_simplex(pts[z_idx, :2]) >= 0
keep_idx = z_idx[in_hull]
print(f"  Result: {len(keep_idx):,} (removed {n_src - len(keep_idx):,})")

new_las = laspy.LasData(las.header)
new_las.points = las.points[keep_idx]

ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
out_path = f"{LAS_DIR}/{base}_fixed_{ts}.las"
new_las.write(out_path)
print(f"\nSaved: {out_path} ({os.path.getsize(out_path)/1024/1024:.1f} MB)")
print("Done!")
