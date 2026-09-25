import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildTerrain } from './terrain.ts';

/**
 * Three.js stage shared by the in-game 3D renderer and the debug page.
 *
 * Coordinate mapping, decided once here so nothing downstream has to think:
 *   sim (x, y) on a flat plane  ->  three (x, 0, y), with +Y up.
 * The sim's y axis (across the lane) becomes three's z axis.
 */
/**
 * Vertical field of view. Narrow on purpose: a MOBA camera is a long lens. It
 * keeps the lane's shape toward the edges of the screen instead of fanning it
 * out, while still giving the rigs the depth an orthographic camera cannot.
 */
const CAMERA_FOV = 20;

/** Shared +Y axis, so place() is not allocating one every frame. */
const UP = new THREE.Vector3(0, 1, 0);

/**
 * Camera pitch above the horizon, in degrees. High enough to look down on the
 * lane and read creep spacing at a glance, shallow enough that the rigs are
 * still seen from the front rather than from the top of the head.
 */
const CAMERA_PITCH = 57;

/**
 * Camera yaw around the lane, in degrees.
 *
 * The sim lays the lane out along +x, and looking straight down it puts the
 * creeps on a dead-level line across the screen, which no MOBA ever looks
 * like. Dota's bottom lane runs east along the south edge of a map whose
 * camera faces north, with Radiant in the lower-left corner and Dire in the
 * upper-right, so you read it on a slant with the enemy side up and to the
 * right. Yawing the camera gives the lane that slant without the sim ever
 * knowing: it still thinks in x and y. Negative is the direction that puts
 * Dire up-right; positive sends the wave down-right, which is backwards.
 */
const CAMERA_YAW = -28;

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;

  /**
   * Half-height of the view at the lane plane, in sim units — the zoom knob.
   * Smaller = closer. The camera distance is derived from it and the FOV, so
   * zooming stays framing-based rather than something to tune in world units.
   */
  private viewSize = 430;
  private readonly target = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in three 0.186

    this.scene.background = new THREE.Color(0x141d22);
    this.scene.fog = new THREE.Fog(0x141d22, 2600, 5200);

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 10, 12000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // zoom is the camera distance, handled below
    this.controls.enabled = false;    // opt-in, see toggleOrbit()

    const sun = new THREE.DirectionalLight(0xffeedd, 3.1);
    sun.position.set(-700, 1500, 650);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const s = 1100;
    sun.shadow.camera.left = -s;
    sun.shadow.camera.right = s;
    sun.shadow.camera.top = s;
    sun.shadow.camera.bottom = -s;
    sun.shadow.camera.far = 5000;
    sun.shadow.bias = -0.0015;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    this.scene.add(new THREE.HemisphereLight(0x9ec4e0, 0x3b3226, 1.9));

    this.buildGround();
    // After the sun exists: place() aims its shadow frustum as well as the camera.
    this.place();
    this.resize();
  }

  private sun: THREE.DirectionalLight;
  private terrain!: ReturnType<typeof buildTerrain>;

  private buildGround() {
    // The grid helper that used to sit here was invisible at this zoom and told
    // you nothing when you could see it; terrain.ts gives the eye real things
    // to measure distance against instead.
    this.terrain = buildTerrain();
    this.scene.add(this.terrain.group);
  }

  toggleOrbit(on: boolean) {
    this.controls.enabled = on;
  }

  /** Jump the camera to a sim-space point, with no follow lag. */
  snap(x: number, y: number) {
    this.target.set(x, 0, y);
    this.place();
  }

  /** Keep the camera looking at a sim-space point. */
  follow(x: number, y: number, dt: number) {
    if (this.controls.enabled) return;
    const t = 1 - Math.pow(0.001, dt);
    this.target.lerp(new THREE.Vector3(x, 0, y), t);
    this.place();
  }

  /** Camera distance that frames `viewSize` at the lane plane, for this FOV. */
  private get distance(): number {
    return this.viewSize / Math.tan(THREE.MathUtils.degToRad(CAMERA_FOV) / 2);
  }

  private place() {
    const pitch = THREE.MathUtils.degToRad(CAMERA_PITCH);
    const offset = new THREE.Vector3(0, Math.sin(pitch), Math.cos(pitch))
      .applyAxisAngle(UP, THREE.MathUtils.degToRad(CAMERA_YAW))
      .multiplyScalar(this.distance);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    // Keep the shadow frustum on the action instead of on the origin.
    this.sun.position.copy(this.target).add(new THREE.Vector3(-600, 1500, 700));
    this.sun.target.position.copy(this.target);
    this.sun.target.updateMatrixWorld();
  }

  zoom(delta: number) {
    this.viewSize = THREE.MathUtils.clamp(this.viewSize * (1 + delta), 260, 1600);
    this.place();
  }

  resize() {
    const w = this.renderer.domElement.clientWidth || innerWidth;
    const h = this.renderer.domElement.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);

    // viewSize is a half-height, so only the aspect moves on a resize; how much
    // lane fits vertically stays put whatever the window does.
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  render() {
    if (this.controls.enabled) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
