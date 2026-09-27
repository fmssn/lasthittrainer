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

/**
 * The framing, as the half-height of the view at the lane plane (see viewSize).
 *
 * The drill holds it fixed at ZOOM_DEFAULT. Dota's camera stays at its default
 * distance in a real match, and a zoom of your own changes how fast the lane
 * seems to move. That is the one thing a timing drill must not let drift. Only
 * the debug page zooms, between the two limits. At the outer limit a 16:9
 * window holds 2630 units of lane centreline, as much as lies between the two
 * towers (2600).
 *
 * The default is Dota's own framing, since the speeds are Dota's too: 325 a
 * second only looks like 325 across the amount of lane Dota shows. At 430 the
 * view was about a quarter tighter than that, so the lane swept past and a
 * playtester called the game too fast although every unit moved at its real
 * speed. Dota's camera sits 1134 from its target (`dota_camera_distance`) with
 * a 70 degree field of view across a 4:3 frame, widened for wider screens,
 * which is 55.4 degrees vertically: a half-height of 1134 * tan(27.7) = 595 at
 * the target. The distance is Valve's default; the field of view is the Source
 * default, not read out of Dota's files, and is the less certain of the two.
 */
const ZOOM_DEFAULT = 595;
const ZOOM_IN_LIMIT = 260;
const ZOOM_OUT_LIMIT = 650;
/** On the debug page, one wheel notch changes the framing by this ratio, the same both ways. */
const ZOOM_STEP = 1.1;

/**
 * Fog range as multiples of the camera distance. The ground in frame spans
 * 0.9 to 1.13 camera distances in depth at any zoom, so a fog fixed in world
 * units began just below the top of the screen at the default framing and had
 * swallowed the whole lane eight notches out. Scaled with the camera it keeps
 * the default look at every zoom: a faint haze at the far edge of the frame,
 * none on the lane.
 */
const FOG_NEAR = 1.07;
const FOG_FAR = 2.13;

/**
 * Half-size of the sun's shadow box per unit of viewSize. 1100 at a framing of
 * 430, which covers the frame with room to spare; fixed in world units, units
 * near the corners lost their shadows from two notches out. Scaling it with the
 * view also keeps shadow texels the same size on screen.
 */
const SHADOW_SPAN = 1100 / 430;

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
  private viewSize = ZOOM_DEFAULT;
  private readonly target = new THREE.Vector3();
  private readonly fog = new THREE.Fog(0x141d22);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap; // PCFSoft was removed in three 0.186

    this.scene.background = new THREE.Color(0x141d22);
    this.scene.fog = this.fog;

    this.camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 10, 12000);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // zoom is the camera distance, handled below
    this.controls.enabled = false;    // opt-in, see toggleOrbit()

    const sun = new THREE.DirectionalLight(0xffeedd, 3.1);
    sun.position.set(-700, 1500, 650);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.far = 5000;
    sun.shadow.bias = -0.0015;
    this.scene.add(sun, sun.target);
    this.sun = sun;

    this.scene.add(new THREE.HemisphereLight(0x9ec4e0, 0x3b3226, 1.9));

    this.buildGround();
    // After the sun exists: frame() sizes its shadow box and place() aims it.
    this.frame();
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

  /** Zoom by wheel notches: positive is out, fractions are fine. Debug page only. */
  zoom(notches: number) {
    this.viewSize = THREE.MathUtils.clamp(
      this.viewSize * Math.pow(ZOOM_STEP, notches),
      ZOOM_IN_LIMIT,
      ZOOM_OUT_LIMIT,
    );
    this.frame();
    this.place();
  }

  /** Everything whose size follows the zoom rather than the camera's position. */
  private frame() {
    this.fog.near = this.distance * FOG_NEAR;
    this.fog.far = this.distance * FOG_FAR;

    const s = this.viewSize * SHADOW_SPAN;
    const box = this.sun.shadow.camera;
    box.left = -s;
    box.right = s;
    box.top = s;
    box.bottom = -s;
    box.updateProjectionMatrix();
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

  dispose() {
    this.terrain.dispose();
    this.controls.dispose();
  }
}
