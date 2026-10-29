import {
  AdditiveBlending,
  AmbientLight,
  AssetManager,
  BackSide,
  BoxGeometry,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  CylinderGeometry,
  DirectionalLight,
  DoubleSide,
  EnvironmentType,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PointLight,
  RepeatWrapping,
  SphereGeometry,
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  World,
  createSystem,
  InputActions,
  InputComponent,
  LocomotionEnvironment,
  LocomotionSystem,
  type Entity,
  Quaternion,
  SlideSystem,
  XRHandVisualAdapter,
} from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { multiplayer, type HandState, type MultiplayerStatus } from './multiplayer';
import { RemoteAvatars } from './remote-avatars';

type Vec3 = [number, number, number];

type PortalDefinition = {
  name: string;
  shortName: string;
  // External URL, or `swap:<room id>` for an in-session room swap.
  url: string;
  color: string;
  // Placed portals stand here facing the room centre; portals without a
  // position are spaced evenly around the room's portalRing.
  position?: Vec3;
};

type PortalTarget = {
  definition: PortalDefinition;
  group: Group;
};

// Procedurally built holodeck set: circular floor, grid walls, ceiling, dais.
type HolodeckSet = {
  radius: number;
  wallHeight: number;
  segments: number;
  // Multiplies the floor and wall grid colours; also the dais glow colour.
  tint?: string;
  floor: { gridCells: number };
  // `grid` reuses the floor grid texture on the ceiling, darkened by `color`.
  ceiling: { color: string; grid?: boolean };
  base?: { color: string };
  dais: {
    radiusTop: number;
    radiusBottom: number;
    segments: number;
    color: string;
    glow?: number;
    emblemRadius?: number;
  };
};

// glTF set: the model is the whole room, walkable floor and walls included.
type ModelSet = {
  // Relative to the site base, e.g. rooms/vwm/model.glb.
  url: string;
  // Offset that puts the spot visitors arrive at on the origin, floor at y=0.
  position?: Vec3;
  rotationY?: number; // degrees
  scale?: number;
};

// A room is loaded from public/rooms/<id>.json and rendered by buildRoom().
// Its set is either a `model` or the holodeck fields.
type RoomDefinition = {
  id: string;
  sign: {
    // `banner` is the wide letter-spaced title; `panel` is the compact sign.
    style: 'banner' | 'panel';
    title: string;
    subtitle: string;
    // Supports {swaps} and {sessionEnds} placeholders.
    caption: string;
    color: string;
    position: Vec3;
  };
  portalRing?: { radius: number; height: number };
  portals: PortalDefinition[];
} & ({ model: ModelSet } | ({ model?: undefined } & HolodeckSet));

const DEFAULT_ROOM = 'hub';
const ROOM_ID_PATTERN = /^[a-z0-9-]+$/;

function modelUrl(model: ModelSet): string {
  return `${import.meta.env.BASE_URL}${encodeURI(model.url)}`;
}

// Fetches the room file and, for model sets, the glTF too, so a room only
// starts building once everything it needs is in memory.
async function loadRoom(id: string): Promise<RoomDefinition> {
  if (!ROOM_ID_PATTERN.test(id)) throw new Error(`Invalid room id "${id}"`);
  const response = await fetch(`${import.meta.env.BASE_URL}rooms/${id}.json`);
  if (!response.ok) throw new Error(`Room "${id}" failed to load (${response.status})`);
  const room = (await response.json()) as RoomDefinition;
  if (room.id !== id || !Array.isArray(room.portals)) {
    throw new Error(`rooms/${id}.json is not a valid room definition`);
  }
  if (!room.model && typeof room.radius !== 'number') {
    throw new Error(`rooms/${id}.json needs either a model or holodeck fields`);
  }
  if (room.portals.some((portal) => !portal.position) && !room.portalRing) {
    throw new Error(`rooms/${id}.json has ring portals but no portalRing`);
  }
  if (room.model) await AssetManager.loadGLTF(modelUrl(room.model));
  return room;
}

const portalTargets: PortalTarget[] = [];

type PortalFx = {
  shader: ShaderMaterial;
  ring: MeshStandardMaterial;
  glow: SpriteMaterial;
  phase: number;
};

const portalFx: PortalFx[] = [];

// ---------------------------------------------------------------------------
// Holodeck grid textures (TNG style: yellow grid on black)
// ---------------------------------------------------------------------------

function makeHolodeckGridTexture(size = 1024, cells = 16): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');

  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, size, size);

  const step = size / cells;
  for (let i = 0; i <= cells; i++) {
    const p = Math.round(i * step) + 0.5;
    const major = i % 4 === 0;
    ctx.strokeStyle = major ? 'rgba(245,197,24,0.95)' : 'rgba(245,197,24,0.42)';
    ctx.lineWidth = major ? 5 : 2;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, size);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, p);
    ctx.lineTo(size, p);
    ctx.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

function makeWallGridTexture(): CanvasTexture {
  // One grid cell per tile, repeated around and up the cylinder wall.
  // The wall is 2 * pi * 7 m around (~43.98 m) and 4.9 m tall (WALL_HEIGHT in
  // main). 72 columns x 8 rows gives cells of 0.611 m x 0.613 m: square, the
  // way the holodeck grid should read. Drawing only the left and top edge of
  // the tile keeps every seam line the same weight as the interior lines.
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');

  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(245,197,24,0.9)';
  ctx.lineWidth = 7;
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(canvas.width, 0);
  ctx.moveTo(0, 0);
  ctx.lineTo(0, canvas.height);
  ctx.stroke();

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.repeat.set(72, 8);
  texture.anisotropy = 4;
  return texture;
}

// ---------------------------------------------------------------------------
// Virtual Worlds Museum branding textures
// ---------------------------------------------------------------------------

function makeBannerSign(sign: RoomDefinition['sign']): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 2048;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';

  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '14px';
  } catch {
    // letterSpacing is a progressive enhancement; ignore where unsupported.
  }
  ctx.fillStyle = sign.color;
  ctx.font = '700 128px Arial';
  ctx.fillText(sign.title, 1024, 165);

  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '6px';
  } catch {
    // ignore
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 52px Arial';
  ctx.fillText(sign.subtitle, 1024, 285);

  ctx.fillStyle = 'rgba(255,255,255,0.66)';
  ctx.font = '44px Arial';
  ctx.fillText(sign.caption, 1024, 380);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, toneMapped: false }),
  );
  sprite.scale.set(8.4, 2.1, 1);
  return sprite;
}

function makeDaisEmblemTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.clearRect(0, 0, 512, 512);
  ctx.textAlign = 'center';

  ctx.strokeStyle = '#f5c518';
  ctx.lineWidth = 10;
  ctx.beginPath();
  ctx.arc(256, 256, 238, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(256, 256, 205, 0, Math.PI * 2);
  ctx.stroke();

  ctx.fillStyle = '#f5c518';
  ctx.font = '700 150px Arial';
  ctx.fillText('VWM', 256, 285);

  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.font = '700 34px Arial';
  ctx.fillText('VIRTUAL WORLDS MUSEUM', 256, 350);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function makePlacardTexture(title: string, color: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');

  const radius = 26;
  ctx.fillStyle = 'rgba(6,8,14,0.88)';
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.beginPath();
  ctx.roundRect(8, 8, canvas.width - 16, canvas.height - 16, radius);
  ctx.fill();
  ctx.stroke();

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 52px Arial';
  const words = title.split(' ');
  if (words.length > 1) {
    const split = Math.ceil(words.length / 2);
    ctx.fillText(words.slice(0, split).join(' '), 256, 105);
    ctx.fillText(words.slice(split).join(' '), 256, 165);
  } else {
    ctx.fillText(title, 256, 135);
  }

  ctx.fillStyle = color;
  ctx.font = '700 30px Arial';
  ctx.fillText('WALK THROUGH ▸', 256, 215);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function makeGlowTexture(color: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');

  const gradient = ctx.createRadialGradient(128, 128, 10, 128, 128, 128);
  gradient.addColorStop(0, color);
  gradient.addColorStop(0.45, color + '66');
  gradient.addColorStop(1, color + '00');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 256, 256);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

// ---------------------------------------------------------------------------
// Animated plasma shader for the portal interior
// ---------------------------------------------------------------------------

const PLASMA_VERTEX = /* glsl */ `
  varying vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PLASMA_FRAGMENT = /* glsl */ `
  uniform float uTime;
  uniform vec3 uColorA;
  uniform vec3 uColorB;
  uniform vec3 uColorC;
  varying vec2 vUv;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }
  float noise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(
      mix(hash(i), hash(i + vec2(1.0, 0.0)), u.x),
      mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), u.x),
      u.y
    );
  }
  float fbm(vec2 p) {
    float v = 0.0;
    float a = 0.5;
    for (int i = 0; i < 5; i++) {
      v += a * noise(p);
      p *= 2.03;
      a *= 0.55;
    }
    return v;
  }

  void main() {
    vec2 uv = vUv - 0.5;
    float r = length(uv) * 2.0;
    float ang = atan(uv.y, uv.x);

    // Slowly rotating swirl, tighter toward the rim.
    float swirl = ang + uTime * 0.55 - r * 3.0;
    vec2 p = vec2(cos(swirl), sin(swirl)) * r * 3.0;
    float n = fbm(p + vec2(uTime * 0.12, -uTime * 0.09));

    float filaments = pow(smoothstep(0.35, 0.92, n), 2.0);
    vec3 col = mix(uColorA, uColorB, smoothstep(0.18, 0.75, n));
    col = mix(col, uColorC, filaments * 0.85);

    // Darken toward the rim so the plasma melts into the ring.
    float edge = smoothstep(1.0, 0.5, r);
    col *= mix(0.2, 1.0, edge);
    // Soft bright core.
    col += uColorB * 0.22 * smoothstep(0.65, 0.0, r);

    gl_FragColor = vec4(col, 1.0);
  }
`;

function makePlasmaMaterial(color: string): ShaderMaterial {
  const base = new Color(color);
  return new ShaderMaterial({
    vertexShader: PLASMA_VERTEX,
    fragmentShader: PLASMA_FRAGMENT,
    uniforms: {
      uTime: { value: 0 },
      uColorA: { value: base.clone().multiplyScalar(0.1) },
      uColorB: { value: base.clone() },
      uColorC: { value: base.clone().lerp(new Color('#ffffff'), 0.72) },
    },
    side: DoubleSide,
  });
}

// ---------------------------------------------------------------------------
// Oval portal assembly
// ---------------------------------------------------------------------------

const OVAL_X = 0.98;
const OVAL_Y = 1.35;
const OPEN_RX = 0.86;
const OPEN_RY = 1.2;

// Builds a portal at `position`, facing the room centre. `phase` offsets its
// pulse so neighbouring portals don't throb in unison.
function createPortal(definition: PortalDefinition, position: Vector3, phase: number): Group {
  const group = new Group();
  group.position.copy(position);
  group.lookAt(0, position.y, 0);

  const portalColor = new Color(definition.color);

  // Soft halo glow behind the ring.
  const glowMaterial = new SpriteMaterial({
    map: makeGlowTexture(definition.color),
    transparent: true,
    opacity: 0.5,
    blending: AdditiveBlending,
    depthWrite: false,
    toneMapped: false,
  });
  const glow = new Sprite(glowMaterial);
  glow.scale.set(3.6, 4.6, 1);
  glow.position.z = -0.12;
  group.add(glow);

  // Oval sci-fi ring frame.
  const ringMaterial = new MeshStandardMaterial({
    color: portalColor.clone().multiplyScalar(0.35),
    emissive: portalColor.clone(),
    emissiveIntensity: 0.8,
    metalness: 0.65,
    roughness: 0.3,
  });
  const ring = new Mesh(new TorusGeometry(1, 0.085, 20, 72), ringMaterial);
  ring.scale.set(OVAL_X, OVAL_Y, 1);
  group.add(ring);

  // Thin bright inner trim line for extra sci-fi detail.
  const trimMaterial = new MeshBasicMaterial({ color: '#ffffff', toneMapped: false });
  const trim = new Mesh(new TorusGeometry(0.9, 0.018, 12, 72), trimMaterial);
  trim.scale.set(OVAL_X, OVAL_Y, 1);
  trim.position.z = 0.02;
  group.add(trim);

  // Animated plasma interior.
  const plasma = new Mesh(
    new CircleGeometry(0.94, 48),
    makePlasmaMaterial(definition.color),
  );
  plasma.scale.set(OVAL_X, OVAL_Y, 1);
  plasma.position.z = -0.02;
  group.add(plasma);

  // Museum placard floating in front of the portal.
  const placard = new Mesh(
    new PlaneGeometry(1.55, 0.78),
    new MeshBasicMaterial({
      map: makePlacardTexture(definition.shortName, definition.color),
      transparent: true,
      side: DoubleSide,
      toneMapped: false,
    }),
  );
  placard.position.set(0, -1.08, 1.2);
  placard.rotation.x = -0.38;
  group.add(placard);

  portalFx.push({
    shader: plasma.material as ShaderMaterial,
    ring: ringMaterial,
    glow: glowMaterial,
    phase,
  });

  group.updateMatrixWorld(true);
  return group;
}

class PortalEffectsSystem extends createSystem({}, {}) {
  private t = 0;

  update(delta: number) {
    this.t += delta;
    for (const fx of portalFx) {
      fx.shader.uniforms.uTime.value = this.t;
      const pulse = 0.5 + 0.5 * Math.sin(this.t * 2.1 + fx.phase);
      fx.ring.emissiveIntensity = 0.55 + 0.55 * pulse;
      fx.glow.opacity = 0.32 + 0.28 * pulse;
    }
  }
}

// Desktop preview look: ←/→ and horizontal mouse drag yaw the player rig;
// vertical drag pitches the camera. Kept separate from the built-in
// TurnSystem so the headset keeps its snap-turn behaviour.
const DESKTOP_TURN_SPEED = Math.PI / 2; // rad/s
const MOUSE_LOOK_SENSITIVITY = 0.0025; // rad per pixel dragged
const MAX_PITCH = (80 / 180) * Math.PI;

// Pointer listeners in main() accumulate drag deltas here; DesktopLookSystem
// consumes them once per frame.
const mouseLook = { dragging: false, dx: 0, dy: 0 };

class DesktopLookSystem extends createSystem({}, {}) {
  update(delta: number) {
    if (this.world.session) {
      // Headset owns orientation in XR.
      mouseLook.dx = 0;
      mouseLook.dy = 0;
      return;
    }
    const keyboard = this.world.input.keyboard;
    const dir =
      (keyboard.getKeyPressed('ArrowLeft') ? 1 : 0) - (keyboard.getKeyPressed('ArrowRight') ? 1 : 0);
    const yaw = dir * DESKTOP_TURN_SPEED * delta - mouseLook.dx * MOUSE_LOOK_SENSITIVITY;
    if (yaw !== 0) this.player.rotateY(yaw);

    if (mouseLook.dy !== 0) {
      const camera = this.camera;
      camera.rotation.x = Math.max(
        -MAX_PITCH,
        Math.min(MAX_PITCH, camera.rotation.x - mouseLook.dy * MOUSE_LOOK_SENSITIVITY),
      );
    }
    mouseLook.dx = 0;
    mouseLook.dy = 0;
  }
}

// Workaround for an IWSDK locomotor bug: jump() doesn't refresh the engine's
// idle timer, so a jump from standing still is put back to sleep before it is
// applied and fires on the next movement input instead. A zero slide wakes the
// engine in the same tick.
class JumpWakeSystem extends createSystem({}, {}) {
  private still = new Vector3();
  private move = { x: 0, y: 0 };

  update() {
    const actions = this.world.input.actions;
    if (!actions.getButtonDown(InputActions.LocomotionJump)) return;
    actions.getAxis2D(InputActions.LocomotionMove, this.move);
    if (this.move.x !== 0 || this.move.y !== 0) return; // SlideSystem keeps it awake
    const locomotor = this.world.getSystem(SlideSystem)?.config.locomotor.value as
      | { slide(movement: Vector3): void }
      | undefined;
    locomotor?.slide(this.still);
  }
}

// Arrival hold: pins the visitor to their arrival spot while a room loads, so
// gravity can't drop them before the room's floor exists. The locomotion
// engine has no gravity switch, but teleporting every frame also zeroes the
// fall speed. Rooms keep their floor at y = 0.
//
// The floor counts as ready once IWSDK has handed it to the locomotion worker
// (`_initialized`). The worker then builds its collision data synchronously,
// so the teleports we keep sending during `settle` queue up behind that work
// and land the visitor on a floor that exists.
const ARRIVAL_SETTLE = 0.5; // s of extra pinning once the floor is handed over
const ARRIVAL_TIMEOUT = 20; // s; never pin someone forever if a room breaks

const arrivalHold = {
  active: false,
  position: new Vector3(),
  settle: 0,
  elapsed: 0,
  environments: [] as Entity[],
};

function holdArrival(x: number, z: number) {
  arrivalHold.active = true;
  arrivalHold.position.set(x, 0, z);
  arrivalHold.settle = ARRIVAL_SETTLE;
  arrivalHold.elapsed = 0;
  arrivalHold.environments = [];
}

class ArrivalHoldSystem extends createSystem({}, {}) {
  update(delta: number) {
    if (!arrivalHold.active) return;
    this.world.getSystem(LocomotionSystem)?.setPlayerPosition(arrivalHold.position);
    arrivalHold.elapsed += delta;
    const ready =
      arrivalHold.environments.length > 0 &&
      arrivalHold.environments.every((entity) =>
        Boolean(entity.getValue(LocomotionEnvironment, '_initialized')),
      );
    if (ready) arrivalHold.settle -= delta;
    if (arrivalHold.settle <= 0 || arrivalHold.elapsed > ARRIVAL_TIMEOUT) {
      arrivalHold.active = false;
    }
  }
}

// Shared traversal gate. PortalTraversalSystem locks it while a jump or swap
// is in flight; WorldSwapSystem releases it when an in-session swap lands.
// `armed` requires the visitor to step out of a portal before it can trigger
// again, so arriving inside the return portal's space never double-fires.
const traversalGate = { navigating: false, warmup: 1.5, armed: true };

// Experiment B control channel: PortalTraversalSystem posts a swap request
// here, WorldSwapSystem consumes it.
const swapControl: { pendingLevel: string | null } = { pendingLevel: null };

class PortalTraversalSystem extends createSystem({}, {}) {
  private headWorld = new Vector3();
  private headLocal = new Vector3();

  update(delta: number) {
    if (traversalGate.navigating) return;
    traversalGate.warmup -= delta;
    if (traversalGate.warmup > 0) return;

    this.camera.getWorldPosition(this.headWorld);

    let insideAny = false;
    for (const target of portalTargets) {
      this.headLocal.copy(this.headWorld);
      target.group.worldToLocal(this.headLocal);

      const nx = this.headLocal.x / OPEN_RX;
      const ny = this.headLocal.y / OPEN_RY;
      const insidePortal = nx * nx + ny * ny < 1 && Math.abs(this.headLocal.z) < 0.42;

      if (insidePortal) {
        insideAny = true;
        if (traversalGate.armed) {
          traversalGate.navigating = true;
          traversalGate.armed = false;
          void this.jumpTo(target.definition);
          return;
        }
      }
    }
    if (!insideAny) traversalGate.armed = true;
  }

  private jumpTo(definition: PortalDefinition) {
    const status = document.getElementById('status');

    // Experiment B: swap portals never navigate. The world is exchanged
    // inside the live XR session by WorldSwapSystem via world.loadLevel().
    if (definition.url.startsWith('swap:')) {
      const level = definition.url.slice('swap:'.length);
      if (status) status.textContent = `Swapping to ${definition.name} without leaving VR…`;
      swapControl.pendingLevel = level;
      return;
    }

    if (status) status.textContent = `Opening ${definition.name}…`;
    document.body.classList.add('portal-jump');

    // Do NOT exit the XR session here. Navigating away while the session is
    // still active lets the browser fire `sessiongranted` on the destination
    // page, which can then re-enter VR without another click. Exiting first
    // would force every visitor through the Enter VR button again on arrival.
    window.setTimeout(() => {
      window.location.assign(definition.url);
    }, 320);
  }
}

// ---------------------------------------------------------------------------
// Experiment B: in-session world swapping (no page navigation)
// ---------------------------------------------------------------------------

let activeWorld: World | null = null;

const expStats = {
  firstSession: null as XRSession | null,
  sessionEnds: 0,
  sessionReplaced: 0,
  swaps: 0,
};

const fadeState = { mesh: null as Mesh | null, opacity: 0 };

function reportStats(note: string) {
  console.log(
    `[ExperimentB] ${note} · swaps=${expStats.swaps} sessionEnds=${expStats.sessionEnds} sessionReplaced=${expStats.sessionReplaced}`,
  );
  const status = document.getElementById('status');
  if (status) {
    status.textContent = `Experiment B: ${note}. Swaps: ${expStats.swaps} · VR session ends: ${expStats.sessionEnds}`;
  }
}

function pinSession(session: XRSession) {
  expStats.firstSession = session;
  session.addEventListener('end', () => {
    expStats.sessionEnds += 1;
    reportStats('session ended');
  });
}

function buildHolodeck(world: World, room: HolodeckSet): Entity {
  const tint = new Color(room.tint ?? '#ffffff');

  const floorGrid = makeHolodeckGridTexture(1024, room.floor.gridCells);
  const floor = new Mesh(
    new CircleGeometry(room.radius, room.segments),
    new MeshStandardMaterial({
      map: floorGrid,
      color: tint,
      roughness: 0.85,
      metalness: 0.05,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.001;
  const floorEntity = world.createTransformEntity(floor).addComponent(LocomotionEnvironment, {
    type: EnvironmentType.STATIC,
  });

  if (room.base) {
    const base = new Mesh(
      new CylinderGeometry(room.radius + 0.06, room.radius + 0.06, 0.14, room.segments),
      new MeshStandardMaterial({ color: new Color(room.base.color), roughness: 0.9 }),
    );
    base.position.y = -0.07;
    world.createTransformEntity(base);
  }

  const walls = new Mesh(
    new CylinderGeometry(room.radius, room.radius, room.wallHeight, room.segments, 1, true),
    new MeshBasicMaterial({
      map: makeWallGridTexture(),
      color: tint,
      side: BackSide,
      toneMapped: false,
    }),
  );
  walls.position.y = room.wallHeight / 2;
  world.createTransformEntity(walls);

  const ceiling = new Mesh(
    new CircleGeometry(room.radius, room.segments),
    new MeshBasicMaterial({
      map: room.ceiling.grid ? floorGrid : null,
      color: new Color(room.ceiling.color),
      toneMapped: false,
    }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = room.wallHeight;
  world.createTransformEntity(ceiling);

  const dais = new Mesh(
    new CylinderGeometry(room.dais.radiusTop, room.dais.radiusBottom, 0.16, room.dais.segments),
    new MeshStandardMaterial({
      color: new Color(room.dais.color),
      metalness: 0.45,
      roughness: 0.4,
      emissive: room.dais.glow ? tint : new Color('#000000'),
      emissiveIntensity: room.dais.glow ?? 1,
    }),
  );
  dais.position.y = 0.08;
  world.createTransformEntity(dais);

  if (room.dais.emblemRadius) {
    const emblem = new Mesh(
      new CircleGeometry(room.dais.emblemRadius, room.dais.segments),
      new MeshBasicMaterial({
        map: makeDaisEmblemTexture(),
        transparent: true,
        toneMapped: false,
      }),
    );
    emblem.rotation.x = -Math.PI / 2;
    emblem.position.y = 0.165;
    world.createTransformEntity(emblem);
  }
  return floorEntity;
}

function buildModelSet(world: World, model: ModelSet): Entity {
  // getGLTF returns a fresh clone of the cached scene each visit; geometry and
  // textures stay shared, and level unloads never dispose them.
  const gltf = AssetManager.getGLTF(modelUrl(model));
  if (!gltf) throw new Error(`Model ${model.url} is not loaded`);
  const set = gltf.scene;
  if (model.position) set.position.fromArray(model.position);
  set.rotation.y = ((model.rotationY ?? 0) / 180) * Math.PI;
  set.scale.setScalar(model.scale ?? 1);
  world.createTransformEntity(set);

  // The locomotor merges every mesh of an environment into one geometry, and
  // three's mergeGeometries fails when meshes carry different attribute sets
  // (e.g. only some have a second UV set). That failure leaves no walkable
  // floor at all. Hand it an invisible position-only copy instead.
  const collider = new Group();
  collider.visible = false;
  set.updateMatrixWorld(true);
  set.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    const source = child.geometry as BufferGeometry;
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', source.getAttribute('position'));
    const count = source.getAttribute('position').count;
    geometry.setIndex(source.index ?? Array.from({ length: count }, (_, i) => i));
    const mesh = new Mesh(geometry);
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(child.matrixWorld);
    collider.add(mesh);
  });
  return world.createTransformEntity(collider).addComponent(LocomotionEnvironment, {
    type: EnvironmentType.STATIC,
  });
}

function buildRoom(world: World, room: RoomDefinition) {
  const walkable = room.model ? buildModelSet(world, room.model) : buildHolodeck(world, room);
  arrivalHold.environments = [walkable];

  const sign = room.sign.style === 'banner' ? makeBannerSign(room.sign) : makePanelSign(room.sign);
  sign.position.fromArray(room.sign.position);
  world.createTransformEntity(sign);

  // Ring portals are spaced evenly starting straight ahead of the spawn;
  // placed portals use their own position and pulse phase 0.
  const ringPortals = room.portals.filter((portal) => !portal.position);
  const position = new Vector3();
  for (const definition of room.portals) {
    let phase = 0;
    if (definition.position) {
      position.fromArray(definition.position);
    } else {
      const ring = room.portalRing!;
      phase = (ringPortals.indexOf(definition) / ringPortals.length) * Math.PI * 2;
      const angle = phase - Math.PI / 2;
      position.set(Math.cos(angle) * ring.radius, ring.height, Math.sin(angle) * ring.radius);
    }
    const group = createPortal(definition, position, phase);
    world.createTransformEntity(group);
    portalTargets.push({ definition, group });
  }
}

function makePanelSign(sign: RoomDefinition['sign']): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.fillStyle = sign.color;
  ctx.font = '700 120px Arial';
  ctx.fillText(sign.title, 512, 180);
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 56px Arial';
  ctx.fillText(sign.subtitle, 512, 290);
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.font = '46px Arial';
  const caption = sign.caption
    .replaceAll('{swaps}', String(expStats.swaps))
    .replaceAll('{sessionEnds}', String(expStats.sessionEnds));
  ctx.fillText(caption, 512, 390);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, toneMapped: false }),
  );
  sprite.scale.set(4.4, 2.2, 1);
  return sprite;
}

class WorldSwapSystem extends createSystem({}, {}) {
  private phase: 'idle' | 'out' | 'swapping' | 'in' = 'idle';
  private target = DEFAULT_ROOM;
  private camPos = new Vector3();

  update(delta: number) {
    // Session instrumentation: pin the first XR session object and count
    // ends. If swaps work, the session object never changes and never ends.
    const session = activeWorld?.session;
    if (session && session !== expStats.firstSession) {
      if (expStats.firstSession) expStats.sessionReplaced += 1;
      pinSession(session);
      reportStats('session pinned');
    }

    if (this.phase === 'idle' && swapControl.pendingLevel) {
      this.target = swapControl.pendingLevel;
      swapControl.pendingLevel = null;
      this.phase = 'out';
    }
    if (this.phase === 'out') {
      fadeState.opacity = Math.min(1, fadeState.opacity + delta / 0.3);
      if (fadeState.opacity >= 1) {
        this.phase = 'swapping';
        void this.performSwap();
      }
    } else if (this.phase === 'in' && !arrivalHold.active) {
      // Stay black until the new room's floor is solid.
      fadeState.opacity = Math.max(0, fadeState.opacity - delta / 0.3);
      if (fadeState.opacity <= 0) this.phase = 'idle';
    }

    if (fadeState.mesh) {
      this.camera.getWorldPosition(this.camPos);
      fadeState.mesh.position.copy(this.camPos);
      (fadeState.mesh.material as MeshBasicMaterial).opacity = fadeState.opacity;
      fadeState.mesh.visible = fadeState.opacity > 0.001;
    }
  }

  private async performSwap() {
    const world = activeWorld;
    if (!world) {
      this.phase = 'in';
      return;
    }
    try {
      // Fetch first so a missing or broken room file leaves the current room
      // standing instead of an empty world.
      const room = await loadRoom(this.target);
      // The main scene document is empty by design (all content is built in
      // code), so loadLevel performs the level unload: every non-persistent
      // entity from the current room is cleared while the XR session, the
      // player rig and this system keep running.
      holdArrival(world.player.position.x, world.player.position.z);
      await world.loadLevel('scenes/main.iwsdk.scene.json');
      portalTargets.length = 0;
      portalFx.length = 0;
      expStats.swaps += 1;
      buildRoom(world, room);
      multiplayer.enterRoom(room.id);
      window.history.pushState(null, '', `?world=${room.id}`);
      reportStats(`swapped to ${room.id}`);
    } catch (error) {
      console.error('[ExperimentB] swap failed', error);
    }
    traversalGate.navigating = false;
    traversalGate.warmup = 1.0;
    this.phase = 'in';
  }
}

// ---------------------------------------------------------------------------
// Multiplayer: voice, video and presence (see multiplayer.ts)
// ---------------------------------------------------------------------------

let remoteAvatars: RemoteAvatars | null = null;
let controllerTagSprite: Sprite | null = null;

function describeMultiplayer(status: MultiplayerStatus): string {
  if (status.note) return status.note;
  const people = `${status.people} ${status.people === 1 ? 'person' : 'people'}`;
  const mic = status.joined ? (status.micOn ? 'mic on' : 'mic muted') : 'listening only';
  return `Room ${status.roomId ?? '…'} · ${people} · ${mic}`;
}

// Small status tag on the left controller, since the 2D panel is hidden in VR.
function makeControllerTag(): { sprite: Sprite; redraw: (status: MultiplayerStatus) => void } {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(
    new SpriteMaterial({ map: texture, transparent: true, toneMapped: false, depthWrite: false }),
  );
  sprite.scale.set(0.16, 0.04, 1);
  sprite.position.set(0, 0.07, 0.02);

  const redraw = (status: MultiplayerStatus) => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(6,8,14,0.82)';
    ctx.beginPath();
    ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 36);
    ctx.fill();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = '700 40px Arial';
    ctx.fillStyle = status.micOn ? '#55ffad' : '#ff755f';
    const mic = status.joined ? (status.micOn ? 'MIC ON' : 'MIC OFF') : 'X: JOIN';
    ctx.fillText(`${mic} · ${status.cameraOn ? 'CAM ON' : 'CAM OFF'} · ${status.people} here`, 256, 66);
    texture.needsUpdate = true;
  };
  return { sprite, redraw };
}

class MultiplayerSystem extends createSystem({}, {}) {
  private sendTimer = 0;
  private headPosition = new Vector3();
  private headQuaternion = new Quaternion();
  private gripPosition = new Vector3();
  private gripQuaternion = new Quaternion();

  // World pose of one hand or controller, plus joints when hand-tracked.
  private handState(side: 'left' | 'right'): HandState | undefined {
    const adapter = this.world.input.xr.visualAdapters[side].value;
    if (!adapter) return undefined;
    const grip = this.player.gripSpaces[side];
    grip.getWorldPosition(this.gripPosition);
    grip.getWorldQuaternion(this.gripQuaternion);
    const state: HandState = {
      p: this.gripPosition.toArray(),
      q: this.gripQuaternion.toArray() as [number, number, number, number],
    };
    // Joint matrices are relative to the grip space; keep only translations.
    const joints = adapter instanceof XRHandVisualAdapter ? adapter.jointTransforms : undefined;
    if (joints) {
      state.j = [];
      for (let i = 0; i < joints.length; i += 16) {
        state.j.push(
          Math.round(joints[i + 12] * 1000),
          Math.round(joints[i + 13] * 1000),
          Math.round(joints[i + 14] * 1000),
        );
      }
    }
    return state;
  }

  update(delta: number) {
    this.sendTimer -= delta;
    if (this.sendTimer <= 0) {
      this.sendTimer = 0.1; // 10 Hz pose updates
      this.camera.getWorldPosition(this.headPosition);
      this.camera.getWorldQuaternion(this.headQuaternion);
      const hands = this.world.session
        ? { left: this.handState('left'), right: this.handState('right') }
        : undefined;
      multiplayer.sendState(
        this.headPosition.toArray(),
        this.headQuaternion.toArray() as [number, number, number, number],
        hands,
      );
    }

    if (controllerTagSprite) controllerTagSprite.visible = !!this.world.session;
    if (this.world.session) {
      const left = this.world.input.xr.gamepads.left;
      if (left?.getButtonDown(InputComponent.X_Button)) void multiplayer.toggleMic();
      if (left?.getButtonDown(InputComponent.Y_Button)) void multiplayer.toggleCamera();
    }

    const peers = multiplayer.peers();
    // IWSDK's AudioSystem suspends the shared AudioContext when VR ends.
    if (peers.length > 0) remoteAvatars?.resumeAudio();
    remoteAvatars?.update(peers, delta);
  }
}

async function main() {
  const container = document.getElementById('scene-container');
  if (!container) throw new Error('Missing #scene-container');

  const world = await World.create(container, projectOptions);

  // Comfortable desktop preview. In XR, the headset owns the tracked camera pose.
  world.camera.position.set(0, 1.65, 0.4);
  world.camera.lookAt(0, 1.4, -3);
  world.scene.background = new Color('#050506');

  // Desktop keyboard locomotion. WASD and ↑/↓ drive the slide action; ←/→ are
  // left free for DesktopLookSystem (the stock browser preset would strafe).
  world.input.actions.addBindings([
    {
      source: 'keyboard',
      kind: 'axis2d',
      action: InputActions.LocomotionMove,
      negativeX: ['KeyA'],
      positiveX: ['KeyD'],
      negativeY: ['KeyW', 'ArrowUp'],
      positiveY: ['KeyS', 'ArrowDown'],
    },
    { source: 'keyboard', kind: 'button', action: InputActions.LocomotionJump, code: 'Space' },
  ]);

  // Desktop mouse look: drag on the scene to shift the view. The HUD is a
  // sibling of the container, so its button clicks never start a drag.
  container.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || world.session) return;
    mouseLook.dragging = true;
    container.setPointerCapture(event.pointerId);
    container.classList.add('dragging');
  });
  container.addEventListener('pointermove', (event) => {
    if (!mouseLook.dragging) return;
    mouseLook.dx += event.movementX;
    mouseLook.dy += event.movementY;
  });
  const endDrag = (event: PointerEvent) => {
    if (!mouseLook.dragging) return;
    mouseLook.dragging = false;
    container.releasePointerCapture(event.pointerId);
    container.classList.remove('dragging');
  };
  container.addEventListener('pointerup', endDrag);
  container.addEventListener('pointercancel', endDrag);

  const ambient = new AmbientLight(0xffffff, 0.85);
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 8, 2);
  const warmth = new PointLight(0xffd75e, 12, 22);
  warmth.position.set(0, 4.0, 0);
  world.scene.add(ambient, key, warmth);

  activeWorld = world;

  // In-session fade curtain (Experiment B): a black sphere that follows the
  // visitor's head. Persistent, so it survives level swaps.
  fadeState.mesh = new Mesh(
    new SphereGeometry(0.45, 24, 16),
    new MeshBasicMaterial({
      color: new Color('#000000'),
      side: BackSide,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }),
  );
  fadeState.mesh.renderOrder = 999;
  fadeState.mesh.frustumCulled = false;
  fadeState.mesh.visible = false;
  world.createTransformEntity(fadeState.mesh, { persistent: true });

  // --- First level (hub by default, ?world=<room id> to start elsewhere) ---
  // Pin the visitor at the origin until the room (a big model can take a
  // while to download) has a floor to stand on.
  world.registerSystem(ArrivalHoldSystem, { priority: 2 });
  holdArrival(0, 0);
  const loadingStatus = document.getElementById('status');
  if (loadingStatus) loadingStatus.textContent = 'Loading room…';
  const startRoom = new URLSearchParams(window.location.search).get('world') ?? DEFAULT_ROOM;
  let room: RoomDefinition;
  try {
    room = await loadRoom(startRoom);
  } catch (error) {
    if (startRoom === DEFAULT_ROOM) throw error;
    console.error(`[Rooms] falling back to ${DEFAULT_ROOM}`, error);
    room = await loadRoom(DEFAULT_ROOM);
  }
  buildRoom(world, room);
  if (loadingStatus) loadingStatus.textContent = 'Ready.';

  remoteAvatars = new RemoteAvatars(world.scene, world.camera);
  multiplayer.enterRoom(room.id);

  world.registerSystem(DesktopLookSystem, { priority: 3 });
  world.registerSystem(JumpWakeSystem, { priority: 3 });
  world.registerSystem(PortalEffectsSystem, { priority: 4 });
  world.registerSystem(PortalTraversalSystem, { priority: 5 });
  world.registerSystem(WorldSwapSystem, { priority: 6 });
  world.registerSystem(MultiplayerSystem, { priority: 7 });

  // --- Multiplayer controls ------------------------------------------------
  const joinButton = document.getElementById('mp-join') as HTMLButtonElement | null;
  const micButton = document.getElementById('mp-mic') as HTMLButtonElement | null;
  const cameraButton = document.getElementById('mp-camera') as HTMLButtonElement | null;
  const mpStatus = document.getElementById('mp-status');
  const controllerTag = makeControllerTag();
  world.player.gripSpaces.left.add(controllerTag.sprite);
  controllerTagSprite = controllerTag.sprite;

  const renderMultiplayer = () => {
    const state = multiplayer.status();
    if (joinButton) joinButton.hidden = state.joined;
    if (micButton) {
      micButton.hidden = !state.joined;
      micButton.textContent = state.micOn ? 'MUTE MIC' : 'UNMUTE MIC';
    }
    if (cameraButton) cameraButton.textContent = state.cameraOn ? 'CAMERA OFF' : 'CAMERA ON';
    if (mpStatus) {
      const hint =
        state.people > 1 && remoteAvatars?.audioSuspended ? ' · Click anywhere to hear others' : '';
      mpStatus.textContent = describeMultiplayer(state) + hint;
    }
    controllerTag.redraw(state);
  };
  multiplayer.onChange(renderMultiplayer);
  renderMultiplayer();

  joinButton?.addEventListener('click', () => void multiplayer.join());
  micButton?.addEventListener('click', () => void multiplayer.toggleMic());
  cameraButton?.addEventListener('click', () => void multiplayer.toggleCamera());
  // Browsers keep audio suspended until a user gesture.
  const unlockAudio = () => {
    remoteAvatars?.resumeAudio();
    renderMultiplayer();
  };
  window.addEventListener('pointerdown', unlockAudio);
  window.addEventListener('keydown', unlockAudio);

  const enterButton = document.getElementById('enter-xr') as HTMLButtonElement | null;
  const status = document.getElementById('status');

  enterButton?.addEventListener('click', async () => {
    // launchXR must start inside the click's user activation; the mic
    // request follows right behind it.
    const launching = enterXR();
    void multiplayer.join();
    await launching;
  });

  // Seamless portal returns: when a visitor arrives here through a portal
  // jump from a page that had an active XR session, the browser fires
  // `sessiongranted` on navigator.xr. Inside that handler we may enter VR
  // without requiring another click, so portal-to-portal travel stays
  // inside the headset.
  const xr = (navigator as Navigator & { xr?: EventTarget }).xr;
  xr?.addEventListener('sessiongranted', () => {
    void enterXR(true);
  });

  async function enterXR(fromPortal = false) {
    try {
      if (status) status.textContent = fromPortal ? 'Portal received. Entering VR…' : 'Starting immersive mode…';
      await world.launchXR();
      if (status) status.textContent = 'In VR. Walk into any glowing portal.';
    } catch (error) {
      console.error(error);
      if (status) status.textContent = 'Could not enter VR. See browser console for details.';
    }
  }
}

void main();
