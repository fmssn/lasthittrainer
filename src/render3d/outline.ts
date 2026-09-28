import * as THREE from 'three';

/**
 * The outline Dota draws round whatever the cursor is over.
 *
 * Done in screen space rather than with an inflated hull: every unit is a
 * sprite, a flat card with nothing to push out. Instead the hovered unit is
 * drawn flat white into a mask (the sprite's own pixels, see spriteView.ts), and
 * a full-screen pass lights the pixels just outside it. That follows the silhouette exactly, mid-swing included, and
 * stays the same width in pixels at every zoom.
 *
 * The line is hidden wherever another unit stands in front of it. That takes
 * the depth of both: the outline pixel borrows the depth of the silhouette it
 * rings, and loses to any unit nearer than that. Only units count, through
 * {@link OCCLUDER_LAYER}. The lane in front of a creep's feet is nearer the
 * camera than the feet are, so testing against the whole scene would eat the
 * bottom of every outline.
 */

/** Layer the hovered unit is put on for the mask pass, and nothing else is. */
const MASK_LAYER = 1;

/** Every unit view sits on this layer as well as 0, so the occluder pass can draw units alone. */
export const OCCLUDER_LAYER = 2;

/** Outline width in CSS pixels. */
const WIDTH = 2.5;

/** The same white as the hovered health bar's outline in annotations.ts. */
const COLOR = new THREE.Color(1, 1, 1);
const OPACITY = 0.85;

/** Directions sampled round each pixel; enough that a thin limb never slips between two. */
const TAPS = 16;

/**
 * How much nearer, in sim units, a unit has to be to hide the line. Keeps two
 * creeps standing shoulder to shoulder from nibbling at each other's outlines.
 */
const DEPTH_SLACK = 6;

const EDGE_SHADER = {
  vertex: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragment: /* glsl */ `
    #include <packing>
    uniform sampler2D mask;
    uniform sampler2D maskDepth;
    uniform sampler2D occluderDepth;
    uniform vec2 texel;
    uniform float width;
    uniform float near;
    uniform float far;
    uniform float slack;
    uniform vec3 color;
    uniform float opacity;
    varying vec2 vUv;

    float dist(sampler2D depth, vec2 uv) {
      return -perspectiveDepthToViewZ(texture2D(depth, uv).r, near, far);
    }

    void main() {
      float inside = texture2D(mask, vUv).r;
      if (inside > 0.99) discard;
      float cover = 0.0;
      // Nearest point of the silhouette this pixel rings. -1 until a tap
      // lands squarely on the body: the depth resolved out of a multisampled
      // edge pixel may belong to the background rather than the unit.
      float body = -1.0;
      for (int i = 0; i < ${TAPS}; i++) {
        float a = 6.2831853 * float(i) / float(${TAPS});
        vec2 dir = vec2(cos(a), sin(a)) * texel;
        for (int j = 1; j <= 2; j++) {
          vec2 uv = vUv + dir * width * float(j) * 0.5;
          float m = texture2D(mask, uv).r;
          cover = max(cover, m);
          if (m > 0.5) {
            float d = dist(maskDepth, uv);
            body = body < 0.0 ? d : min(body, d);
          }
        }
      }
      if (cover <= 0.0) discard;
      if (body > 0.0 && dist(occluderDepth, vUv) < body - slack) discard;
      // Outside the body only: the unit itself is not tinted.
      gl_FragColor = vec4(color, cover * (1.0 - inside) * opacity);
    }
  `,
};

function depthTarget(samples: number) {
  const target = new THREE.WebGLRenderTarget(1, 1, { samples });
  target.depthTexture = new THREE.DepthTexture(1, 1);
  return target;
}

export class HoverOutline {
  /** The hovered unit alone: white where it is, plus its depth. Multisampled, or the stair-steps come through into the line. */
  private readonly mask = depthTarget(4);
  /** Depth of every other unit, so the line can go behind them. */
  private readonly occluders = depthTarget(0);

  private readonly maskCamera = new THREE.PerspectiveCamera();
  private readonly maskMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });

  private readonly edgeScene = new THREE.Scene();
  private readonly edgeCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly edgeMaterial: THREE.ShaderMaterial;
  private readonly quad: THREE.Mesh;

  private readonly clearColor = new THREE.Color();
  private readonly size = new THREE.Vector2();

  constructor(private readonly renderer: THREE.WebGLRenderer) {
    this.edgeMaterial = new THREE.ShaderMaterial({
      uniforms: {
        mask: { value: this.mask.texture },
        maskDepth: { value: this.mask.depthTexture },
        occluderDepth: { value: this.occluders.depthTexture },
        texel: { value: new THREE.Vector2() },
        width: { value: WIDTH },
        near: { value: 1 },
        far: { value: 2 },
        slack: { value: DEPTH_SLACK },
        color: { value: COLOR },
        opacity: { value: OPACITY },
      },
      vertexShader: EDGE_SHADER.vertex,
      fragmentShader: EDGE_SHADER.fragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.edgeMaterial);
    this.quad.frustumCulled = false;
    this.edgeScene.add(this.quad);
  }

  /** Draw the outline of `target` over what is already on screen. */
  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera, target: THREE.Object3D | null) {
    if (!target) return;
    const r = this.renderer;
    this.fit(camera);
    this.maskCamera.copy(camera);

    // Both passes reuse the real scene, so every unit keeps its pose and its
    // place in the hierarchy. The lights sit on layer 0 only, which keeps the
    // shadow pass from running again.
    const { background, overrideMaterial } = scene;
    scene.background = null;
    scene.overrideMaterial = this.maskMaterial;
    const autoClear = r.autoClear;
    r.getClearColor(this.clearColor);
    const clearAlpha = r.getClearAlpha();
    r.setClearColor(0x000000, 0);

    target.traverse((o) => {
      o.layers.enable(MASK_LAYER);
      o.layers.disable(OCCLUDER_LAYER);
    });
    this.pass(scene, this.mask, MASK_LAYER);
    this.pass(scene, this.occluders, OCCLUDER_LAYER);
    target.traverse((o) => {
      o.layers.disable(MASK_LAYER);
      o.layers.enable(OCCLUDER_LAYER);
    });

    r.setRenderTarget(null);
    scene.background = background;
    scene.overrideMaterial = overrideMaterial;
    r.setClearColor(this.clearColor, clearAlpha);

    r.autoClear = false;
    r.render(this.edgeScene, this.edgeCamera);
    r.autoClear = autoClear;
  }

  dispose() {
    for (const t of [this.mask, this.occluders]) {
      t.depthTexture?.dispose();
      t.dispose();
    }
    this.maskMaterial.dispose();
    this.edgeMaterial.dispose();
    this.quad.geometry.dispose();
  }

  private pass(scene: THREE.Scene, target: THREE.WebGLRenderTarget, layer: number) {
    this.maskCamera.layers.set(layer);
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.render(scene, this.maskCamera);
  }

  /** Keep both targets at the drawing buffer's size, so a mask pixel is a screen pixel. */
  private fit(camera: THREE.PerspectiveCamera) {
    this.renderer.getDrawingBufferSize(this.size);
    const w = Math.max(1, this.size.x);
    const h = Math.max(1, this.size.y);
    for (const t of [this.mask, this.occluders]) {
      if (t.width !== w || t.height !== h) t.setSize(w, h);
    }
    const u = this.edgeMaterial.uniforms;
    (u.texel.value as THREE.Vector2).set(1 / w, 1 / h);
    u.width.value = WIDTH * this.renderer.getPixelRatio();
    u.near.value = camera.near;
    u.far.value = camera.far;
  }
}
