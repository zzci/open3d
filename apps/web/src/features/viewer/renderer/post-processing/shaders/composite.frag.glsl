precision highp float;

uniform sampler2D uInputTexture;
uniform sampler2D uSsaoTexture;
uniform int uSsaoEnabled;

in vec2 vUv;
out vec4 fragColor;

void main() {
  vec4 color = texture(uInputTexture, vUv);

  // Multiply by SSAO occlusion factor when enabled
  if (uSsaoEnabled == 1) {
    float occlusion = texture(uSsaoTexture, vUv).r;
    color.rgb *= occlusion;
  }

  // Apply sRGB gamma correction (linear -> sRGB)
  vec3 gamma = pow(color.rgb, vec3(1.0 / 2.2));

  fragColor = vec4(gamma, color.a);
}
