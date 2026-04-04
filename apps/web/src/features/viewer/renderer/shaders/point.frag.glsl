precision highp float;

uniform int uColorMode;
uniform int uSelectionActive;
uniform sampler2D uClassificationPalette;

varying vec3 vColor;
varying float vIntensity;
varying float vClassification;
varying float vHeightNorm;
varying float vSelected;

// Blue → Cyan → Green → Yellow → Red ramp
vec3 heatmap(float t) {
  float r = clamp(1.5 - abs(t - 1.0) * 2.0, 0.0, 1.0);
  float g = clamp(1.5 - abs(t - 0.5) * 2.0, 0.0, 1.0);
  float b = clamp(1.5 - abs(t) * 2.0, 0.0, 1.0);
  // Simplified 5-stop ramp
  if (t < 0.25) {
    return vec3(0.0, t * 4.0, 1.0);               // blue → cyan
  } else if (t < 0.5) {
    return vec3(0.0, 1.0, 1.0 - (t - 0.25) * 4.0); // cyan → green
  } else if (t < 0.75) {
    return vec3((t - 0.5) * 4.0, 1.0, 0.0);        // green → yellow
  } else {
    return vec3(1.0, 1.0 - (t - 0.75) * 4.0, 0.0); // yellow → red
  }
}

void main() {
  // Discard corners for round points
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  if (dot(coord, coord) > 1.0) discard;

  // Selected points override to yellow
  if (uSelectionActive == 1 && vSelected > 0.5) {
    gl_FragColor = vec4(1.0, 0.92, 0.23, 1.0); // bright yellow
    return;
  }

  vec3 color;

  if (uColorMode == 0) {
    // RGB
    color = vColor;
  } else if (uColorMode == 1) {
    // Intensity ramp
    color = heatmap(vIntensity);
  } else if (uColorMode == 2) {
    // Height gradient
    color = heatmap(vHeightNorm);
  } else if (uColorMode == 3) {
    // Classification palette via 1D texture lookup
    float u = (vClassification + 0.5) / 256.0;
    color = texture2D(uClassificationPalette, vec2(u, 0.5)).rgb;
  } else {
    // White (mode 4 and fallback)
    color = vec3(1.0);
  }

  gl_FragColor = vec4(color, 1.0);
}
