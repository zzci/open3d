precision highp float;

uniform sampler2D uInputTexture;

varying vec2 vUv;

void main() {
  vec4 color = texture2D(uInputTexture, vUv);

  // Apply sRGB gamma correction (linear -> sRGB)
  vec3 gamma = pow(color.rgb, vec3(1.0 / 2.2));

  gl_FragColor = vec4(gamma, color.a);
}
