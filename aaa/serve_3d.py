"""Simple GLB/3D file viewer server on port 5001."""
import os
from flask import Flask, send_from_directory, render_template_string

app = Flask(__name__)
DIR_3D = os.path.join(os.path.dirname(__file__), "3d")

HTML = """<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>3D Model Viewer</title>
<style>
* { margin:0; padding:0; box-sizing:border-box; }
body { background:#0d1117; font-family:-apple-system,sans-serif; color:#c9d1d9; }
#panel {
    position:absolute; top:12px; left:12px; z-index:10;
    background:rgba(22,27,34,0.92); padding:14px 18px; border-radius:8px;
    border:1px solid #30363d; font-size:13px; max-width:280px;
}
#panel h2 { font-size:15px; color:#58a6ff; margin-bottom:8px; }
#panel a { color:#58a6ff; text-decoration:none; display:block; padding:4px 0; }
#panel a:hover { color:#79c0ff; }
#panel .active { color:#3fb950; font-weight:bold; }
#info { position:absolute; bottom:16px; left:50%; transform:translateX(-50%);
    background:rgba(22,27,34,0.9); padding:8px 16px; border-radius:8px;
    border:1px solid #30363d; font-size:12px; color:#8b949e; z-index:10; }
canvas { display:block; }
</style>
</head>
<body>
<div id="panel">
    <h2>3D Viewer</h2>
    <div id="file-list">Loading...</div>
</div>
<div id="info">Drag: rotate &middot; Scroll: zoom &middot; Right-drag: pan</div>

<script type="importmap">
{ "imports": {
    "three": "https://cdn.jsdelivr.net/npm/three@0.170.0/build/three.module.js",
    "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.170.0/examples/jsm/"
}}
</script>
<script type="module">
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1117);

const camera = new THREE.PerspectiveCamera(60, innerWidth/innerHeight, 0.01, 5000);
camera.position.set(20, 15, 20);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
document.body.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = true;

// Lighting
scene.add(new THREE.AmbientLight(0x404050, 2));
const dirLight = new THREE.DirectionalLight(0xffffff, 3);
dirLight.position.set(50, 50, 50);
scene.add(dirLight);
const dirLight2 = new THREE.DirectionalLight(0x8888ff, 1.5);
dirLight2.position.set(-30, 20, -30);
scene.add(dirLight2);

scene.add(new THREE.GridHelper(100, 20, 0x1f2937, 0x161b22));
scene.add(new THREE.AxesHelper(5));

const loader = new GLTFLoader();
let currentModel = null;

function loadModel(url) {
    if (currentModel) { scene.remove(currentModel); currentModel = null; }
    loader.load(url, (gltf) => {
        currentModel = gltf.scene;
        scene.add(currentModel);

        const box = new THREE.Box3().setFromObject(currentModel);
        const center = box.getCenter(new THREE.Vector3());
        const size = box.getSize(new THREE.Vector3());
        const maxDim = Math.max(size.x, size.y, size.z);

        controls.target.copy(center);
        camera.position.set(center.x + maxDim*0.8, center.y + maxDim*0.5, center.z + maxDim*0.8);
        camera.near = maxDim * 0.001;
        camera.far = maxDim * 100;
        camera.updateProjectionMatrix();
        controls.update();

        // Update active link
        document.querySelectorAll('#file-list a').forEach(a => {
            a.classList.toggle('active', a.dataset.url === url);
        });
    });
}

// Fetch file list
fetch('/api/files').then(r=>r.json()).then(files => {
    const list = document.getElementById('file-list');
    list.innerHTML = '';
    let firstGlb = null;
    files.forEach(f => {
        const a = document.createElement('a');
        const url = '/3d/' + f;
        if (f.endsWith('.usdz')) {
            // USDZ: direct link for Safari AR Quick Look on Vision Pro
            a.href = url;
            a.rel = 'ar';
            a.textContent = '🥽 ' + f;
            a.style.color = '#d2a8ff';
        } else {
            a.href = '#';
            a.textContent = f;
            a.dataset.url = url;
            a.onclick = (e) => { e.preventDefault(); loadModel(url); };
            if (!firstGlb) firstGlb = url;
        }
        list.appendChild(a);
    });
    if (firstGlb) loadModel(firstGlb);
});

addEventListener('resize', () => {
    camera.aspect = innerWidth/innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
});

(function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
})();
</script>
</body>
</html>"""


@app.route("/")
def index():
    return render_template_string(HTML)


@app.route("/api/files")
def list_files():
    files = sorted([f for f in os.listdir(DIR_3D) if f.endswith(('.glb', '.gltf', '.obj', '.usdz'))],
                   key=lambda f: os.path.getmtime(os.path.join(DIR_3D, f)), reverse=True)
    return files


@app.route("/3d/<path:filename>")
def serve_3d(filename):
    return send_from_directory(DIR_3D, filename)


if __name__ == "__main__":
    import socket
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
    except:
        ip = "0.0.0.0"
    print(f"3D Viewer: http://{ip}:5001")
    print(f"           http://localhost:5001")
    app.run(host="0.0.0.0", port=5001, debug=True)
