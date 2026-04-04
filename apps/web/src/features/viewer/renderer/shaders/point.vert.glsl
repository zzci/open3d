precision highp float;

// Attributes
attribute vec3 position;
attribute vec3 aColor;        // RGB 0–1
attribute float aIntensity;   // 0–1
attribute float aClassification;

// Uniforms
uniform mat4 modelViewMatrix;
uniform mat4 projectionMatrix;
uniform float uPointSize;
uniform int uColorMode;
uniform float uHeightMin;
uniform float uHeightMax;

// Varyings
varying vec3 vColor;
varying float vIntensity;
varying float vClassification;
varying float vHeightNorm;

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  // Attenuate point size by distance for perspective-correct sizing
  gl_PointSize = uPointSize * (300.0 / -mvPosition.z);
  gl_PointSize = clamp(gl_PointSize, 1.0, 64.0);

  vColor = aColor;
  vIntensity = aIntensity;
  vClassification = aClassification;

  // Normalized height for height gradient mode
  float range = uHeightMax - uHeightMin;
  vHeightNorm = range > 0.0 ? clamp((position.y - uHeightMin) / range, 0.0, 1.0) : 0.5;
}
