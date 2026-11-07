// Adapted from the Marble generator in Shader Effects Inc. shaders 4.0.0.
export const backgroundShader = `/*
MIT License

Copyright (c) 2026 Shader Effects Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
struct Scene {
  width: f32,
  height: f32,
  time: f32,
  padding: f32,
}
@group(0) @binding(0) var<uniform> scene: Scene;

@vertex fn fullscreen(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let positions = array(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(positions[index], 0.0, 1.0);
}

fn hash(point: vec2f) -> f32 {
  return fract(sin(dot(point, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise(point: vec2f) -> f32 {
  let cell = floor(point);
  let f = fract(point);
  let blend = f * f * (3.0 - 2.0 * f);
  let lower = mix(hash(cell), hash(cell + vec2f(1.0, 0.0)), blend.x);
  let upper = mix(hash(cell + vec2f(0.0, 1.0)), hash(cell + vec2f(1.0, 1.0)), blend.x);
  return mix(lower, upper, blend.y);
}

fn lobe(distance: f32, width: f32) -> f32 {
  let position = distance / width;
  return exp(-position * position);
}

@fragment fn flow(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let uv = position.xy / vec2f(scene.width, scene.height);
  let wide = smoothstep(0.60, 1.4, scene.width / scene.height);
  let time = scene.time * 0.13;
  let curve = 0.083 * sin(5.25 * uv.x - 0.64 + 0.18 * sin(time));
  let axis = mix(0.80 - 0.38 * uv.x, 0.80 - 0.61 * uv.x, wide) + curve;
  let plane = vec2f(uv.x * 3.1, uv.y * 2.3);
  let warp = noise(plane + vec2f(1.6, time))
    + 0.37 * noise(plane * 2.2 + vec2f(5.8, time * 0.7));
  let distance = uv.y - axis + (warp - 0.68) * 0.055;

  // A wide satin surface and two tapered highlights, each with its own shape.
  let reveal = smoothstep(0.06, 0.69, uv.x);
  let falloff = (1.0 - smoothstep(0.77, 1.0, uv.y)) * smoothstep(0.0, 0.10, uv.y);
  let underlight = lobe(distance - 0.032, 0.166) * reveal;
  let surface = lobe(distance + 0.010, 0.071 + 0.027 * uv.x) * reveal;
  let shoulder = distance + 0.065 + 0.025 * sin(4.7 * uv.x + time * 0.8);
  let fold = lobe(shoulder, 0.022) * smoothstep(0.33, 0.86, uv.x);
  let edge = lobe(shoulder + 0.012, 0.007 + 0.005 * (1.0 - uv.x));
  let glint = edge * smoothstep(0.40, 0.77, uv.x) * (0.66 + 0.34 * sin(3.2 * uv.x + time));
  let turn = distance - 0.053 - 0.031 * sin(5.2 * uv.x - time);
  let reflected = lobe(turn, 0.019) * smoothstep(0.40, 0.76, uv.x)
    * (1.0 - smoothstep(0.91, 1.05, uv.x));

  let base = vec3f(0.0196, 0.0196, 0.0235);
  let blue = vec3f(0.012, 0.040, 0.148) * underlight
    + vec3f(0.016, 0.074, 0.198) * surface
    + vec3f(0.018, 0.115, 0.221) * fold
    + vec3f(0.038, 0.188, 0.278) * glint
    + vec3f(0.011, 0.058, 0.129) * reflected;
  let light = blue * falloff;
  // Screen-space grain stays still as the light moves and recedes into the shadows.
  let grainStrength = mix(2.0, 11.0, smoothstep(0.01, 0.32, light.b));
  let grain = (hash(position.xy) - 0.5) * grainStrength / 255.0;
  return vec4f(base + light + vec3f(grain), 1.0);
}
`;
