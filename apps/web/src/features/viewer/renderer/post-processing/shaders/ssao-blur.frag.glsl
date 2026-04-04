#version 300 es
precision highp float;

uniform sampler2D uSsaoTexture;
uniform vec2 uTexelSize;

in vec2 vUv;
out vec4 fragColor;

void main() {
  // 4x4 box blur to smooth out noise artifacts
  float result = 0.0;

  for (int x = -2; x < 2; x++) {
    for (int y = -2; y < 2; y++) {
      vec2 offset = vec2(float(x), float(y)) * uTexelSize;
      result += texture(uSsaoTexture, vUv + offset).r;
    }
  }

  result /= 16.0;

  fragColor = vec4(vec3(result), 1.0);
}
