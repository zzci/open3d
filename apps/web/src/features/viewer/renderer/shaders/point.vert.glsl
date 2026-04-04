precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 aColor;        // RGB 0–1
attribute float aIntensity;   // 0–1
attribute float aClassification;
attribute float aSelected;    // 1.0 = selected, 0.0 = not

// Uniforms
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uPointSize;
uniform int uColorMode;
uniform float uHeightMin;
uniform float uHeightMax;
uniform int uSelectionActive; // 1 = selection exists, 0 = no selection

// Varyings
varying vec3 vColor;
varying float vIntensity;
varying float vClassification;
varying float vHeightNorm;
varying float vSelected;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Attenuate point size by distance for perspective-correct sizing
  float size = uPointSize * (300.0 / -mvPosition.z);

  // Selected points are 1.5× larger
  if (uSelectionActive == 1 && aSelected > 0.5) {
    size *= 1.5;
  }

  gl_PointSize = clamp(size, 1.0, 64.0);

  vColor = aColor;
  vIntensity = aIntensity;
  vClassification = aClassification;
  vSelected = aSelected;

  // Normalized height for height gradient mode
  float range = uHeightMax - uHeightMin;
  vHeightNorm = range > 0.0 ? clamp((position.y - uHeightMin) / range, 0.0, 1.0) : 0.5;
}
