precision highp float;

uniform int uColorMode;
uniform int uPointShape; // 0 = hard circle (discard), 1 = gaussian splat
uniform int uSelectionActive;
uniform sampler2D uClassificationPalette;
uniform sampler2D uColorPalette;

varying vec3 vColor;
varying float vIntensity;
varying float vClassification;
varying float vHeightNorm;
varying float vSelected;

void main() {
  vec2 coord = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(coord, coord);

  // Discard outside unit circle (both modes — saves fill on corners)
  if (r2 > 1.0) discard;

  // Selected points override to yellow (always opaque)
  if (uSelectionActive == 1 && vSelected > 0.5) {
    gl_FragColor = vec4(1.0, 0.92, 0.23, 1.0);
    return;
  }

  vec3 color;

  if (uColorMode == 0) {
    // RGB
    color = vColor;
  } else if (uColorMode == 1) {
    // Intensity — palette texture lookup
    color = texture2D(uColorPalette, vec2(vIntensity, 0.5)).rgb;
  } else if (uColorMode == 2) {
    // Height — palette texture lookup
    color = texture2D(uColorPalette, vec2(vHeightNorm, 0.5)).rgb;
  } else if (uColorMode == 3) {
    // Classification palette via 1D texture lookup
    float u = (vClassification + 0.5) / 256.0;
    color = texture2D(uClassificationPalette, vec2(u, 0.5)).rgb;
  } else {
    // White (mode 4 and fallback)
    color = vec3(1.0);
  }

  if (uPointShape == 0) {
    // Hard circle — fully opaque
    gl_FragColor = vec4(color, 1.0);
  } else {
    // Gaussian splat — smooth alpha falloff (σ ≈ 0.58, ~5% at edge)
    float alpha = exp(-r2 * 3.0);
    // Pre-multiplied alpha output for correct compositing
    gl_FragColor = vec4(color * alpha, alpha);
  }
}
