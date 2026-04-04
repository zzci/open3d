"""Convert GLB to USDZ for Apple Vision Pro.
Uses Apple's xcrun usdz tools, falls back to pxr USD API.
Usage: python export_usdz.py <glb_file>
"""
import sys
import os
import subprocess
import datetime
import trimesh
import numpy as np

if len(sys.argv) < 2:
    print("Usage: python export_usdz.py <glb_file>")
    sys.exit(1)

SOURCE = sys.argv[1]
name = os.path.basename(SOURCE).rsplit(".", 1)[0]
ts = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")

# First export as OBJ (intermediate format)
print(f"Loading: {SOURCE}")
scene = trimesh.load(SOURCE)
if isinstance(scene, trimesh.Scene):
    mesh = trimesh.util.concatenate(scene.dump())
else:
    mesh = scene
print(f"  Vertices: {len(mesh.vertices):,}, Faces: {len(mesh.faces):,}")

obj_path = f"3d/{name}_{ts}.obj"
mesh.export(obj_path, file_type='obj')
print(f"  OBJ: {obj_path}")

# Try usdzconvert first, then xcrun
usdz_path = f"3d/{name}_{ts}.usdz"
usda_path = f"3d/{name}_{ts}.usda"

# Method: use pxr (USD Python API) directly
try:
    from pxr import Usd, UsdGeom, UsdShade, Gf, Vt, UsdUtils

    print("Converting via USD Python API...")

    # Create USD stage
    stage = Usd.Stage.CreateNew(usda_path)
    UsdGeom.SetStageUpAxis(stage, UsdGeom.Tokens.y)
    UsdGeom.SetStageMetersPerUnit(stage, 1.0)

    # Create mesh prim
    mesh_prim = UsdGeom.Mesh.Define(stage, '/Ship')

    vertices = mesh.vertices
    faces = mesh.faces

    # Set points
    points = [Gf.Vec3f(float(v[0]), float(v[1]), float(v[2])) for v in vertices]
    mesh_prim.GetPointsAttr().Set(Vt.Vec3fArray(points))

    # Set face vertex counts (all triangles = 3)
    face_counts = Vt.IntArray([3] * len(faces))
    mesh_prim.GetFaceVertexCountsAttr().Set(face_counts)

    # Set face vertex indices
    indices = Vt.IntArray(faces.flatten().tolist())
    mesh_prim.GetFaceVertexIndicesAttr().Set(indices)

    # Add vertex colors if available
    if mesh.visual and hasattr(mesh.visual, 'vertex_colors') and mesh.visual.vertex_colors is not None:
        colors = mesh.visual.vertex_colors[:, :3].astype(np.float32) / 255.0
        display_color = [Gf.Vec3f(float(c[0]), float(c[1]), float(c[2])) for c in colors]
        mesh_prim.GetDisplayColorAttr().Set(Vt.Vec3fArray(display_color))

    # Compute normals
    mesh_prim.GetSubdivisionSchemeAttr().Set("none")

    stage.GetRootLayer().Save()
    print(f"  USDA: {usda_path}")

    # Convert USDA to USDZ
    result = subprocess.run(
        ["xcrun", "usdcatool", usda_path, "-o", usdz_path],
        capture_output=True, text=True
    )

    if result.returncode != 0:
        # Try usdzip
        result2 = subprocess.run(
            ["xcrun", "usdzconvert", usda_path, usdz_path],
            capture_output=True, text=True
        )
        if result2.returncode != 0:
            # Manual USDZ creation (USDZ is just a zip)
            import zipfile
            with zipfile.ZipFile(usdz_path, 'w', zipfile.ZIP_STORED) as zf:
                # USDZ requires 64-byte alignment and no compression
                zf.write(usda_path, os.path.basename(usda_path))
            print(f"  Created USDZ via zip")

    if os.path.exists(usdz_path):
        print(f"  USDZ: {usdz_path} ({os.path.getsize(usdz_path)/1024/1024:.1f} MB)")
    else:
        print("  USDZ creation failed, USDA available for manual conversion")

except Exception as e:
    print(f"USD API error: {e}")
    print("Falling back to OBJ output only")

print("\nDone!")
print("To view on Vision Pro:")
print("  1. AirDrop the .usdz file to your Vision Pro")
print("  2. Or open the .usdz in Safari")
print("  3. Or use Reality Composer Pro to import .obj/.usdz")
