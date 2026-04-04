precision highp float;

uniform sampler2D uInputTexture;
uniform sampler2D uSsaoTexture;
uniform int uSsaoEnabled;

varying vec2 vUv;

void main() {
  vec4 color = texture2D(uInputTexture, vUv);

  // Multiply by SSAO occlusion factor when enabled
  if (uSsaoEnabled == 1) {
    float occlusion = texture2D(uSsaoTexture, vUv).r;
    color.rgb *= occlusion;
  }

  // Apply sRGB gamma correction (linear -> sRGB)
  vec3 gamma = pow(color.rgb, vec3(1.0 / 2.2));

  gl_FragColor = vec4(gamma, color.a);
}
