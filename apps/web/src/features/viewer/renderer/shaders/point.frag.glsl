precision highp float;

uniform int uColorMode;
uniform int uPointShape; // 0 = hard circle (discard), 1 = gaussian splat
uniform int uSelectionActive;
uniform sampler2D uClassificationPalette;
uniform sampler2D uColorPalette;

varying vec3 vColor;
varying float vIntensity;
varying float vClassification;
varying float vReturnNumber;
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
    // 0: RGB
    color = vColor;
  } else if (uColorMode == 1) {
    // 1: Intensity — palette texture lookup
    color = texture2D(uColorPalette, vec2(vIntensity, 0.5)).rgb;
  } else if (uColorMode == 2) {
    // 2: Height — palette texture lookup
    color = texture2D(uColorPalette, vec2(vHeightNorm, 0.5)).rgb;
  } else if (uColorMode == 3) {
    // 3: Classification palette via 1D texture lookup
    float u = clamp((vClassification + 0.5) / 256.0, 0.0, 1.0);
    color = texture2D(uClassificationPalette, vec2(u, 0.5)).rgb;
  } else if (uColorMode == 4) {
    // 4: White
    color = vec3(1.0);
  } else if (uColorMode == 5) {
    // 5: Grayscale Intensity — direct intensity to brightness
    color = vec3(vIntensity);
  } else if (uColorMode == 6) {
    // 6: Intensity x Height — structural depth blend
    vec3 heightColor = texture2D(uColorPalette, vec2(vHeightNorm, 0.5)).rgb;
    color = heightColor * (0.3 + 0.7 * vIntensity);
  } else if (uColorMode == 7) {
    // 7: Return Number — color by return index
    float rn = clamp(vReturnNumber / 5.0, 0.0, 1.0);
    color = texture2D(uColorPalette, vec2(rn, 0.5)).rgb;
  } else if (uColorMode == 8) {
    // 8: Palette on Intensity
    color = texture2D(uColorPalette, vec2(vIntensity, 0.5)).rgb;
  } else if (uColorMode == 9) {
    // 9: Palette on Height
    color = texture2D(uColorPalette, vec2(vHeightNorm, 0.5)).rgb;
  } else {
    // Fallback
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
