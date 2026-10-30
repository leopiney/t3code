import {
  Box3,
  DirectionalLight,
  Euler,
  Group,
  HemisphereLight,
  MathUtils,
  Matrix4,
  Mesh,
  OrthographicCamera,
  Quaternion,
  Scene,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";

import { createRenderScheduler } from "../device/renderScheduler.ts";

// View tuning, from WolfBud's head.
const BASE_AZ = MathUtils.degToRad(-42);
const BASE_EL = MathUtils.degToRad(29);
const DRIFT_AZ = MathUtils.degToRad(4);
const DRIFT_EL = MathUtils.degToRad(2.5);
const IDLE_PITCH = 0.025;
const IDLE_ROLL = 0.03;
const IDLE_BOB = 0.012;
const TALK_LIFT = 0.05;
const NOD_ANGLE = MathUtils.degToRad(11);
const NOD_FREQ = 2.3;
const NOD_ZETA = 0.32;
const NOD_KICK = 22;
const NOD_REPEAT = 1.5;
const NOD_MAX = 1.4;
const NOD_WAG = 0.0015;
const JAW_OPEN = 0.38;
const CAM_DIST = 6;
const FIT_MARGIN = 1.06;
/** A curious tilt while the user talks: roll, and a little chin lift. */
const LISTEN_ROLL = MathUtils.degToRad(7);
const LISTEN_PITCH = MathUtils.degToRad(-4);
/** Off a call the head sinks a little. */
const SLEEP_PITCH = MathUtils.degToRad(6);
/** The snout follows the pointer anywhere in the window, easing out to LOOK_MAX off the line to the viewer. */
const LOOK_MAX = MathUtils.degToRad(42);
const LOOK_RANGE = 360;
const LOOK_TILT = MathUtils.degToRad(6);
const LOOK_TAU = 0.16;
/** Voice levels arrive quiet; these map them onto the jaw and the tilt. */
const OUTPUT_GAIN = 2.2;
const INPUT_GAIN = 6;
/** Talking redraws at most this often; a mouth needs no more. */
const FRAME_MS = 1000 / 30;
const SETTLED = 1e-3;
const ORIGIN = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Asleep: no call. Awake: on a call, quiet. Listening: the user talks. Speaking: the agent talks. */
export type WolfMood = "asleep" | "awake" | "listening" | "speaking";

export interface WolfHead {
  readonly setMood: (mood: WolfMood) => void;
  /** A nod, as when the user clicks the wolf. */
  readonly pet: () => void;
  readonly resize: (size: number, pixelRatio: number) => void;
  readonly dispose: () => void;
}

export interface WolfHeadOptions {
  readonly canvas: HTMLCanvasElement;
  readonly modelUrl: string;
  /** Raw 0..1 voice levels, read once a frame and only while speaking or listening. */
  readonly levels: { readonly output: () => number; readonly input: () => number };
  /** The model failed to load or WebGL went away: show the flat wolf instead. */
  readonly onUnavailable: () => void;
}

/** A syllable-like mouth envelope for when the voice level reads zero. */
function talkEnvelope(t: number): number {
  const wave =
    0.55 * Math.sin(t * 11.0) + 0.3 * Math.sin(t * 17.3 + 1.1) + 0.15 * Math.sin(t * 6.7 + 2.7);
  const gate = Math.min(1, Math.max(0, Math.sin(t * 1.7 + 0.6) * 0.5 + 0.78));
  return Math.max(0, wave) * gate;
}

function smoothing(dt: number, tau: number): number {
  return 1 - Math.exp(-dt / tau);
}

function saturate(value: number): number {
  return value / (1 + Math.abs(value));
}

function disposeObject(root: Object3D): void {
  root.traverse((object) => {
    if (!(object instanceof Mesh)) return;
    object.geometry.dispose();
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.dispose();
  });
}

/**
 * The WolfBud head. It draws only while something moves: the agent's voice, the user's,
 * the pointer moving, a nod, or a change of mood settling. Returns null without WebGL.
 */
export function createWolfHead(options: WolfHeadOptions): WolfHead | null {
  const { canvas } = options;
  let renderer: WebGLRenderer;
  try {
    renderer = new WebGLRenderer({
      canvas,
      alpha: true,
      antialias: true,
      powerPreference: "low-power",
    });
  } catch {
    return null;
  }
  renderer.setClearAlpha(0);

  const scene = new Scene();
  const camera = new OrthographicCamera(-0.6, 0.6, 0.6, -0.6, 0.1, 20);
  const key = new DirectionalLight(0xffffff, 3.1);
  key.position.set(-1.6, 2.4, 2.2);
  const fill = new DirectionalLight(0xa9b6ff, 0.95);
  fill.position.set(2.4, -0.4, 1.2);
  const rim = new DirectionalLight(0xc9d4ff, 1.7);
  rim.position.set(0.8, 1.1, -2.4);
  const hemi = new HemisphereLight(0xdfe4ff, 0x1a1836, 0.85);
  scene.add(key, fill, rim, hemi);

  let disposed = false;
  let model: Group | null = null;
  let jaw: Object3D | null = null;
  let jawRestX = 0;
  let mood: WolfMood = "asleep";
  let jawValue = 0;
  let listen = 0;
  let sleep = 1;
  let nodPos = 0;
  let nodVel = 0;
  let pointerX = 0;
  let pointerY = 0;
  let hasPointer = false;
  let tilt = 0;
  // Advances only while frames draw, so a sway resumes where it stopped instead of jumping.
  let time = 0;
  let lastFrameAt = -Infinity;
  const look = new Quaternion();
  const lookTarget = new Quaternion();
  const expression = new Quaternion();
  const expressionEuler = new Euler();

  /** Unit vector from the head toward a camera at azimuth `az`, elevation `el`. */
  const cameraDirection = (az: number, el: number, out: Vector3) => {
    const cosEl = Math.cos(el);
    return out.set(Math.sin(az) * cosEl, Math.sin(el), Math.cos(az) * cosEl);
  };
  const placeCamera = (az: number, el: number) => {
    cameraDirection(az, el, camera.position).multiplyScalar(CAM_DIST);
    camera.lookAt(0, 0, 0);
  };

  // The rest view's axes in world space: screen right, screen up, and back toward the viewer.
  const viewRight = new Vector3();
  const viewUp = new Vector3();
  const viewBack = new Vector3();
  new Matrix4()
    .lookAt(cameraDirection(BASE_AZ, BASE_EL, new Vector3()), ORIGIN, UP)
    .extractBasis(viewRight, viewUp, viewBack);
  const aim = new Vector3();
  const aimBasis = new Matrix4();

  /** The upright rotation that points the snout (+Z) at a pointer `dx`, `dy` px from the head. */
  const aimAt = (dx: number, dy: number, out: Quaternion) => {
    const distance = Math.hypot(dx, dy);
    const angle = LOOK_MAX * Math.tanh(distance / LOOK_RANGE);
    const side = distance > 0 ? Math.sin(angle) / distance : 0;
    aim
      .copy(viewBack)
      .multiplyScalar(Math.cos(angle))
      .addScaledVector(viewRight, dx * side)
      .addScaledVector(viewUp, -dy * side);
    return out.setFromRotationMatrix(aimBasis.lookAt(aim, ORIGIN, UP));
  };

  const collectPoints = (root: Group) => {
    const points: Vector3[] = [];
    root.updateWorldMatrix(true, true);
    root.traverse((object) => {
      if (!(object instanceof Mesh)) return;
      const position = object.geometry.getAttribute("position");
      for (let index = 0; index < position.count; index += 1) {
        points.push(
          new Vector3().fromBufferAttribute(position, index).applyMatrix4(object.matrixWorld),
        );
      }
    });
    return points;
  };

  /** Sizes the frustum to every pose the head can strike, so nothing clips. Runs once per model. */
  const fitFrustum = (root: Group) => {
    const poseSets: Vector3[][] = [];
    for (const open of jaw ? [0, JAW_OPEN] : [0]) {
      if (jaw) jaw.rotation.x = jawRestX + open;
      poseSets.push(collectPoints(root));
    }
    if (jaw) jaw.rotation.x = jawRestX;

    const maxPitch = NOD_ANGLE * NOD_MAX + IDLE_PITCH + TALK_LIFT + SLEEP_PITCH;
    const maxRoll = IDLE_ROLL + NOD_WAG * NOD_KICK * NOD_REPEAT + LISTEN_ROLL + LOOK_TILT;
    const swingAz = DRIFT_AZ * 1.4;
    const swingEl = DRIFT_EL * 1.4;
    // Every way it looks: at rest, at the viewer, and at a pointer near and far, all around.
    const looks = [new Quaternion(), aimAt(0, 0, new Quaternion())];
    for (const reach of [LOOK_RANGE, LOOK_RANGE * 1e4]) {
      for (let index = 0; index < 8; index += 1) {
        const angle = (index * Math.PI) / 4;
        looks.push(aimAt(Math.cos(angle) * reach, Math.sin(angle) * reach, new Quaternion()));
      }
    }
    const pose = new Matrix4();
    const euler = new Euler();
    const turn = new Quaternion();
    const project = new Matrix4();
    const point = new Vector3();
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (const lookAt of looks) {
      for (const pitch of [-maxPitch, 0, maxPitch]) {
        for (const roll of [-maxRoll, maxRoll]) {
          pose.makeRotationFromQuaternion(
            turn.setFromEuler(euler.set(pitch, 0, roll)).premultiply(lookAt),
          );
          for (const az of [BASE_AZ - swingAz, BASE_AZ, BASE_AZ + swingAz]) {
            for (const el of [BASE_EL - swingEl, BASE_EL, BASE_EL + swingEl]) {
              placeCamera(az, el);
              camera.updateMatrixWorld();
              project.multiplyMatrices(camera.matrixWorldInverse, pose);
              for (const points of poseSets) {
                for (const vertex of points) {
                  point.copy(vertex).applyMatrix4(project);
                  minX = Math.min(minX, point.x);
                  maxX = Math.max(maxX, point.x);
                  minY = Math.min(minY, point.y);
                  maxY = Math.max(maxY, point.y);
                }
              }
            }
          }
        }
      }
    }
    placeCamera(BASE_AZ, BASE_EL);
    if (!Number.isFinite(minX)) return;
    minY -= IDLE_BOB;
    maxY += IDLE_BOB;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const half = (Math.max(maxX - minX, maxY - minY) / 2) * FIT_MARGIN;
    camera.left = centerX - half;
    camera.right = centerX + half;
    camera.top = centerY + half;
    camera.bottom = centerY - half;
    camera.updateProjectionMatrix();
  };

  const scheduler = createRenderScheduler(() => {
    if (disposed) return;
    const now = performance.now();
    if (now - lastFrameAt < FRAME_MS) {
      scheduler.invalidate();
      return;
    }
    const dt = Math.min(0.1, (now - lastFrameAt) / 1000);
    lastFrameAt = now;
    time += dt;

    // Jaw: the agent's level when there is one, a procedural rhythm as its floor.
    const speaking = mood === "speaking";
    const voiceLevel = speaking ? Math.min(1, options.levels.output() * OUTPUT_GAIN) : 0;
    const envelope = talkEnvelope(time);
    const drive = voiceLevel > 0.02 ? Math.max(voiceLevel, envelope * 0.35) : envelope * 0.9;
    const jawTarget = speaking ? Math.min(1, drive) : 0;
    jawValue += (jawTarget - jawValue) * smoothing(dt, jawTarget > jawValue ? 0.035 : 0.09);
    if (jaw) jaw.rotation.x = jawRestX + jawValue * JAW_OPEN;

    const heard = mood === "listening" ? Math.min(1, options.levels.input() * INPUT_GAIN) : 0;
    const listenTarget = mood === "listening" ? Math.min(1, 0.35 + heard * 1.6) : 0;
    listen += (listenTarget - listen) * smoothing(dt, 0.25);
    const sleepTarget = mood === "asleep" ? 1 : 0;
    sleep += (sleepTarget - sleep) * smoothing(dt, 0.6);

    const omega = 2 * Math.PI * NOD_FREQ;
    const stiffness = omega * omega;
    const damping = 2 * NOD_ZETA * omega;
    const substeps = Math.max(1, Math.ceil(dt * 120));
    const step = dt / substeps;
    for (let index = 0; index < substeps; index += 1) {
      nodVel += (-stiffness * nodPos - damping * nodVel) * step;
      nodPos = MathUtils.clamp(nodPos + nodVel * step, -NOD_MAX, NOD_MAX);
    }

    // Look: ease toward the pointer (or back to rest), then layer the sway, nod and moods on top.
    // The head is measured here, once a drawn frame, so a drag or a resize never leaves it stale.
    const ease = smoothing(dt, LOOK_TAU);
    let dx = 0;
    if (hasPointer) {
      const rect = canvas.getBoundingClientRect();
      dx = pointerX - (rect.left + rect.width / 2);
      aimAt(dx, pointerY - (rect.top + rect.height / 2), lookTarget);
    } else lookTarget.identity();
    look.slerp(lookTarget, ease);
    const tiltTarget = hasPointer ? saturate(dx / LOOK_RANGE) * LOOK_TILT : 0;
    tilt += (tiltTarget - tilt) * ease;

    if (model) {
      const sway = 1 - sleep * 0.6;
      expressionEuler.set(
        Math.sin(time * 0.53 * sway + 1.3) * IDLE_PITCH -
          jawValue * TALK_LIFT +
          nodPos * NOD_ANGLE +
          listen * LISTEN_PITCH +
          sleep * SLEEP_PITCH,
        0,
        Math.sin(time * 0.7 * sway) * IDLE_ROLL + nodVel * NOD_WAG + listen * LISTEN_ROLL - tilt,
      );
      model.quaternion.copy(look).multiply(expression.setFromEuler(expressionEuler));
      model.position.y = Math.sin(time * 0.9 * sway) * IDLE_BOB;
    }
    placeCamera(
      BASE_AZ + Math.sin(time * 0.31) * DRIFT_AZ + Math.sin(time * 0.13 + 2) * DRIFT_AZ * 0.4,
      BASE_EL + Math.sin(time * 0.23 + 1) * DRIFT_EL,
    );
    renderer.render(scene, camera);

    const moving =
      speaking ||
      mood === "listening" ||
      Math.abs(jawTarget - jawValue) > SETTLED ||
      Math.abs(listenTarget - listen) > SETTLED ||
      Math.abs(sleepTarget - sleep) > SETTLED ||
      Math.abs(nodPos) > SETTLED ||
      Math.abs(nodVel) > SETTLED * 10 ||
      look.angleTo(lookTarget) > SETTLED ||
      Math.abs(tiltTarget - tilt) > SETTLED;
    if (moving) scheduler.invalidate();
  });

  const onPointerMove = (event: PointerEvent) => {
    hasPointer = true;
    pointerX = event.clientX;
    pointerY = event.clientY;
    scheduler.invalidate();
  };
  const onResize = () => scheduler.invalidate();
  const onPointerLeave = () => {
    if (!hasPointer) return;
    hasPointer = false;
    scheduler.invalidate();
  };
  const onContextLost = () => options.onUnavailable();
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  window.addEventListener("resize", onResize);
  document.documentElement.addEventListener("pointerleave", onPointerLeave);
  canvas.addEventListener("webglcontextlost", onContextLost);

  new GLTFLoader().loadAsync(options.modelUrl).then(
    (gltf) => {
      const root = gltf.scene;
      if (disposed) {
        disposeObject(root);
        return;
      }
      const box = new Box3().setFromObject(root);
      const extent = box.getSize(new Vector3());
      root.position.sub(box.getCenter(new Vector3()));
      const group = new Group();
      group.add(root);
      group.scale.setScalar(1 / Math.max(extent.x, extent.y, extent.z));
      scene.add(group);
      jaw = root.getObjectByName("jaw") ?? null;
      jawRestX = jaw?.rotation.x ?? 0;
      fitFrustum(group);
      model = group;
      scheduler.invalidate();
    },
    () => {
      if (!disposed) options.onUnavailable();
    },
  );

  return {
    setMood(next) {
      if (disposed || next === mood) return;
      mood = next;
      scheduler.invalidate();
    },
    pet() {
      if (disposed) return;
      nodVel = Math.min(nodVel + NOD_KICK, NOD_KICK * NOD_REPEAT);
      scheduler.invalidate();
    },
    resize(size, pixelRatio) {
      if (disposed || !Number.isFinite(size) || size <= 0) return;
      renderer.setPixelRatio(Math.min(2, Math.max(1, pixelRatio)));
      renderer.setSize(size, size, false);
      scheduler.invalidate();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      scheduler.dispose();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("resize", onResize);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      disposeObject(scene);
      renderer.dispose();
      renderer.forceContextLoss();
    },
  };
}
