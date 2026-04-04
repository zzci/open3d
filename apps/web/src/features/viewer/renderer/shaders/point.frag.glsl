precision highp float;

uniform int uColorMode;
uniform int uPointShape; // 0 = hard circle (discard), 1 = gaussian splat
uniform int uSelectionActive;
uniform sampler2D uClassificationPalette;

varying vec3 vColor;
varying float vIntensity;
varying float vClassification;
varying float vHeightNorm;
varying float vReturnNumber;
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
    // Intensity heatmap
    color = heatmap(vIntensity);
  } else if (uColorMode == 2) {
    // Height gradient
    color = heatmap(vHeightNorm);
  } else if (uColorMode == 3) {
    // Classification palette via 1D texture lookup
    float u = (vClassification + 0.5) / 256.0;
    color = texture2D(uClassificationPalette, vec2(u, 0.5)).rgb;
  } else if (uColorMode == 4) {
    // White
    color = vec3(1.0);
  } else if (uColorMode == 5) {
    // Grayscale intensity — direct brightness
    color = vec3(vIntensity);
  } else if (uColorMode == 6) {
    // Intensity × Height — structural depth
    color = heatmap(vHeightNorm) * vIntensity;
  } else if (uColorMode == 7) {
    // Return number — distinct color per return (up to 5 returns + fallback)
    float rn = vReturnNumber;
    if (rn < 0.5) {
      color = vec3(0.26, 0.52, 0.96); // 1st return — blue
    } else if (rn < 1.5) {
      color = vec3(0.15, 0.68, 0.38); // 2nd return — green
    } else if (rn < 2.5) {
      color = vec3(0.98, 0.74, 0.02); // 3rd return — yellow
    } else if (rn < 3.5) {
      color = vec3(0.96, 0.42, 0.07); // 4th return — orange
    } else if (rn < 4.5) {
      color = vec3(0.85, 0.11, 0.38); // 5th return — red
    } else {
      color = vec3(0.62, 0.31, 0.87); // 6th+ return — purple
    }
  } else if (uColorMode == 8) {
    // Palette on Intensity — fallback to heatmap until palette texture available
    color = heatmap(vIntensity);
  } else if (uColorMode == 9) {
    // Palette on Height — fallback to heatmap until palette texture available
    color = heatmap(vHeightNorm);
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
