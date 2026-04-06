"""Filter point cloud using 95th percentile distance to remove outliers.
Keeps points within the 95th percentile of nearest-neighbor distances.
Usage: python filter_95th.py <las_file> [--percentile 95]
"""
import sys
import os
import datetime
import argparse
import numpy as np
import open3d as o3d
import laspy

parser = argparse.ArgumentParser()
parser.add_argument("las_file")
parser.add_argument("--percentile", type=float, default=95)
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

# Compute nearest neighbor distances
print(f"Computing NN distances...")
dists = np.asarray(pcd.compute_nearest_neighbor_distance())

# 95th percentile threshold
threshold = np.percentile(dists, args.percentile)
print(f"  {args.percentile}th percentile NN distance: {threshold*1000:.2f} mm")
print(f"  Mean: {dists.mean()*1000:.2f} mm, Median: {np.median(dists)*1000:.2f} mm")

# Keep points with NN distance below threshold
keep_mask = dists <= threshold
keep_idx = np.where(keep_mask)[0]
print(f"  Keeping {len(keep_idx):,} / {n_orig:,} ({len(keep_idx)/n_orig*100:.1f}%)")

# Save filtered LAS
new_las = laspy.LasData(las.header)
new_las.points = las.points[keep_idx]

out_path = f"las/{name}_p{int(args.percentile)}_{ts}.las"
new_las.write(out_path)
print(f"\nSaved: {out_path} ({os.path.getsize(out_path)/1024/1024:.1f} MB)")
print("Done!")
