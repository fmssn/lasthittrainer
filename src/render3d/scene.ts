import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

/**
 * Three.js stage shared by the in-game 3D renderer and the debug page.
 *
 * Coordinate mapping, decided once here so nothing downstream has to think:
 *   sim (x, y) on a flat plane  ->  three (x, 0, y), with +Y up.
 * The sim's y axis (across the lane) becomes three's z axis.
 */
export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly controls: OrbitControls;

  /** Half-width of the view in sim units. Smaller = closer. */
  private viewSize = 620;
  private readonly target = new THREE.Vector3();

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.scene.background = new THREE.Color(0x141d22);
    this.scene.fog = new THREE.Fog(0x141d22, 2600, 5200);

    // Dota-ish pitch: high and tilted, but orthographic so the lane does not
    // fan out toward the edges of the screen.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 12000);
    this.camera.position.set(0, 1080, 1290);
    this.camera.lookAt(0, 0, 0);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enablePan = false;
    this.controls.enableZoom = false; // zoom is the ortho frustum, handled below
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
    this.resize();
  }

  private sun: THREE.DirectionalLight;

  private buildGround() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 8000),
      new THREE.MeshStandardMaterial({ color: 0x2c3d2e, roughness: 1 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);

    // The lane itself, so the eye has something to track along.
    const lane = new THREE.Mesh(
      new THREE.PlaneGeometry(20000, 620),
      new THREE.MeshStandardMaterial({ color: 0x47573d, roughness: 1 }),
    );
    lane.rotation.x = -Math.PI / 2;
    lane.position.y = 0.5;
    lane.receiveShadow = true;
    this.scene.add(lane);

    const grid = new THREE.GridHelper(20000, 100, 0x2c3a33, 0x22302a);
    grid.position.y = 1;
    (grid.material as THREE.Material).transparent = true;
    (grid.material as THREE.Material).opacity = 0.25;
    this.scene.add(grid);
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

  private place() {
    const offset = new THREE.Vector3(0, 1080, 1290);
    this.camera.position.copy(this.target).add(offset);
    this.camera.lookAt(this.target);

    // Keep the shadow frustum on the action instead of on the origin.
    this.sun.position.copy(this.target).add(new THREE.Vector3(-600, 1500, 700));
    this.sun.target.position.copy(this.target);
    this.sun.target.updateMatrixWorld();
  }

  zoom(delta: number) {
    this.viewSize = THREE.MathUtils.clamp(this.viewSize * (1 + delta), 350, 2200);
    this.resize();
  }

  resize() {
    const w = this.renderer.domElement.clientWidth || innerWidth;
    const h = this.renderer.domElement.clientHeight || innerHeight;
    this.renderer.setSize(w, h, false);

    const aspect = w / h;
    this.camera.left = -this.viewSize * aspect;
    this.camera.right = this.viewSize * aspect;
    this.camera.top = this.viewSize;
    this.camera.bottom = -this.viewSize;
    this.camera.updateProjectionMatrix();
  }

  render() {
    if (this.controls.enabled) this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }
}
