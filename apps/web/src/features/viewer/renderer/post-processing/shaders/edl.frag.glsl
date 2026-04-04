#version 300 es
precision highp float;

uniform sampler2D uColorTexture;
uniform sampler2D uDepthTexture;
uniform vec2 uTexelSize;       // 1.0 / resolution
uniform float uEdlRadius;      // 1-5 px, default 2
uniform float uEdlStrength;    // 0-1, default 0.5
uniform float uEdlExponent;    // 0.5-5, default 1.0
uniform float uNear;
uniform float uFar;

in vec2 vUv;
out vec4 fragColor;

// Linearize depth from perspective projection depth buffer
float linearizeDepth(float d) {
  // d is in [0,1] from the depth texture
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

void main() {
  vec4 color = texture(uColorTexture, vUv);
  float depth = texture(uDepthTexture, vUv).r;

  // Sky / background pixels: no EDL shading
  if (depth >= 1.0) {
    fragColor = color;
    return;
  }

  float centerDepth = log2(linearizeDepth(depth));

  // 8 directions: cardinal + diagonal
  vec2 neighbors[8];
  neighbors[0] = vec2( 1.0,  0.0);
  neighbors[1] = vec2(-1.0,  0.0);
  neighbors[2] = vec2( 0.0,  1.0);
  neighbors[3] = vec2( 0.0, -1.0);
  neighbors[4] = vec2( 0.707,  0.707);
  neighbors[5] = vec2(-0.707,  0.707);
  neighbors[6] = vec2( 0.707, -0.707);
  neighbors[7] = vec2(-0.707, -0.707);

  float edl = 0.0;
  for (int i = 0; i < 8; i++) {
    vec2 sampleUv = vUv + neighbors[i] * uEdlRadius * uTexelSize;
    float neighborRawDepth = texture(uDepthTexture, sampleUv).r;

    // Treat background neighbors as no contribution
    if (neighborRawDepth >= 1.0) continue;

    float neighborDepth = log2(linearizeDepth(neighborRawDepth));
    edl += max(0.0, centerDepth - neighborDepth);
  }
  edl /= 8.0;

  float shade = exp(-pow(edl * uEdlStrength * 300.0, uEdlExponent));
  shade = clamp(shade, 0.0, 1.0);

  fragColor = vec4(color.rgb * shade, color.a);
}
