#version 300 es
precision highp float;

uniform sampler2D uDepthTexture;
uniform sampler2D uNoiseTexture;
uniform vec2 uTexelSize;        // 1.0 / resolution
uniform vec2 uNoiseScale;       // resolution / 4.0 (tile the 4x4 noise)
uniform float uRadius;          // world-space AO radius
uniform float uIntensity;       // 0-1 strength multiplier
uniform float uBias;            // depth bias to prevent self-occlusion
uniform float uNear;
uniform float uFar;
uniform mat4 uProjection;       // camera projection matrix
uniform mat4 uInverseProjection; // inverse projection for position reconstruction
uniform int uSampleCount;       // 8, 16, or 32

// Pre-computed hemisphere kernel (max 32 samples)
uniform vec3 uKernel[32];

in vec2 vUv;
out vec4 fragColor;

// Linearize depth from perspective depth buffer [0,1] -> view-space Z
float linearizeDepth(float d) {
  float ndc = d * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

// Reconstruct view-space position from UV + depth
vec3 viewPositionFromDepth(vec2 uv, float depth) {
  float z = linearizeDepth(depth);
  // Map UV [0,1] to NDC [-1,1]
  vec4 ndc = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 viewPos = uInverseProjection * ndc;
  viewPos.xyz /= viewPos.w;
  return viewPos.xyz;
}

void main() {
  float depth = texture(uDepthTexture, vUv).r;

  // Background pixels: no occlusion
  if (depth >= 1.0) {
    fragColor = vec4(1.0);
    return;
  }

  vec3 fragPos = viewPositionFromDepth(vUv, depth);

  // Approximate normal from depth buffer using cross-product of neighbors
  vec3 posRight = viewPositionFromDepth(vUv + vec2(uTexelSize.x, 0.0),
    texture(uDepthTexture, vUv + vec2(uTexelSize.x, 0.0)).r);
  vec3 posUp = viewPositionFromDepth(vUv + vec2(0.0, uTexelSize.y),
    texture(uDepthTexture, vUv + vec2(0.0, uTexelSize.y)).r);
  vec3 normal = normalize(cross(posRight - fragPos, posUp - fragPos));

  // Random rotation from 4x4 noise texture
  vec3 randomVec = texture(uNoiseTexture, vUv * uNoiseScale).rgb * 2.0 - 1.0;

  // Gram-Schmidt to build TBN (tangent-space to view-space)
  vec3 tangent = normalize(randomVec - normal * dot(randomVec, normal));
  vec3 bitangent = cross(normal, tangent);
  mat3 TBN = mat3(tangent, bitangent, normal);

  float occlusion = 0.0;
  int count = uSampleCount;
  // Clamp to max 32
  if (count > 32) count = 32;

  for (int i = 0; i < 32; i++) {
    if (i >= count) break;

    // Offset sample in view space
    vec3 samplePos = fragPos + TBN * uKernel[i] * uRadius;

    // Project sample to screen space
    vec4 offset = uProjection * vec4(samplePos, 1.0);
    offset.xyz /= offset.w;
    vec2 sampleUv = offset.xy * 0.5 + 0.5;

    // Sample depth at projected position
    float sampleDepth = texture(uDepthTexture, sampleUv).r;

    // Skip background samples
    if (sampleDepth >= 1.0) continue;

    vec3 sampleViewPos = viewPositionFromDepth(sampleUv, sampleDepth);

    // Range check: only occlude within radius
    float rangeCheck = smoothstep(0.0, 1.0, uRadius / abs(fragPos.z - sampleViewPos.z));

    // If the sampled depth is closer than our sample point, it occludes
    occlusion += (sampleViewPos.z >= samplePos.z + uBias ? 1.0 : 0.0) * rangeCheck;
  }

  occlusion = 1.0 - (occlusion / float(count)) * uIntensity;
  occlusion = clamp(occlusion, 0.0, 1.0);

  fragColor = vec4(vec3(occlusion), 1.0);
}
