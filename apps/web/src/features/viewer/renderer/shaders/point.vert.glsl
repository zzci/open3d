precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 aColor;        // RGB 0–1
attribute float aIntensity;   // 0–1
attribute float aClassification;
attribute float aReturnNumber; // 0–based return index
attribute float aSelected;    // 1.0 = selected, 0.0 = not

// Uniforms
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uNodeSpacing;    // meters — spatial extent per point at this LOD level
uniform float uSizeMultiplier;     // user override (0.5–3.0, default 1.0)
uniform float uRenderModeSizing;   // render mode sizing factor (0.5–1.5, default 1.0)
uniform float uScreenHeight;   // viewport height in pixels
uniform float uFov;            // vertical FOV in radians
uniform int uColorMode;
uniform float uHeightMin;
uniform float uHeightMax;
uniform int uSelectionActive; // 1 = selection exists, 0 = no selection

// Varyings
varying vec3 vColor;
varying float vIntensity;
varying float vClassification;
varying float vHeightNorm;
varying float vReturnNumber;
varying float vSelected;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Adaptive point sizing: project node spacing into screen pixels
  float projFactor = uScreenHeight / (2.0 * tan(uFov * 0.5));
  float size = uNodeSpacing * projFactor / (-mvPosition.z) * uSizeMultiplier * uRenderModeSizing;

  // aSelected > 1.5 means "deleted" — hide completely
  if (aSelected > 1.5) {
    gl_PointSize = 0.0;
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0); // off-screen
    return;
  }

  // Selected points are 1.5× larger
  if (uSelectionActive == 1 && aSelected > 0.5) {
    size *= 1.5;
  }

  gl_PointSize = clamp(size, 1.0, 64.0);

  vColor = aColor;
  vIntensity = aIntensity;
  vClassification = aClassification;
  vReturnNumber = aReturnNumber;
  vSelected = aSelected;

  // Normalized height for height gradient mode
  float range = uHeightMax - uHeightMin;
  vHeightNorm = range > 0.0 ? clamp((position.y - uHeightMin) / range, 0.0, 1.0) : 0.5;
}
