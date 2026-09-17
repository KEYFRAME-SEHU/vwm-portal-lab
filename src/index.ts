import {
  AdditiveBlending,
  AmbientLight,
  BackSide,
  BoxGeometry,
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
  ShaderMaterial,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  TorusGeometry,
  Vector3,
  World,
  createSystem,
  LocomotionEnvironment,
} from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';

type PortalDefinition = {
  name: string;
  shortName: string;
  url: string;
  color: string;
};

type PortalTarget = {
  definition: PortalDefinition;
  group: Group;
};

const PORTALS: PortalDefinition[] = [
  {
    name: 'Arrival Space',
    shortName: 'ARRIVAL SPACE',
    url: 'https://live.arrival.space/virtualworldsmuseum',
    color: '#55d6ff',
  },
  {
    name: 'Horizon Worlds',
    shortName: 'HORIZON WORLDS',
    url: 'https://horizon.meta.com/world/478207822044529/?locale=en_US',
    color: '#9b8cff',
  },
  {
    name: 'Hyperfy',
    shortName: 'HYPERFY',
    url: 'https://hyperfy.io/virtualworldsmuseum/~luwj',
    color: '#55ffad',
  },
  {
    name: 'RP1',
    shortName: 'RP1',
    url: 'https://enter.rp1.com/?start_cid=104&lat=2.009970127790&lon=2.009992411959&rad=6371000',
    color: '#ffcb5c',
  },
  {
    name: 'VIVERSE',
    shortName: 'VIVERSE',
    url: 'https://www.viverse.com/HuoQZQX',
    color: '#ff70c9',
  },
  {
    name: 'Frame',
    shortName: 'FRAME',
    url: 'https://framevr.io/virtualworldsmuseum',
    color: '#ff755f',
  },
];

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
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');

  ctx.fillStyle = '#060606';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = 'rgba(245,197,24,0.5)';
  ctx.lineWidth = 2;
  for (let x = 0; x <= canvas.width; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x + 0.5, 0);
    ctx.lineTo(x + 0.5, canvas.height);
    ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(245,197,24,0.9)';
  ctx.lineWidth = 4;
  for (const y of [2, 128, 254]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
  }

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.repeat.set(10, 1);
  texture.anisotropy = 4;
  return texture;
}

// ---------------------------------------------------------------------------
// Virtual Worlds Museum branding textures
// ---------------------------------------------------------------------------

function makeTitleSprite(): Sprite {
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
  ctx.fillStyle = '#f5c518';
  ctx.font = '700 128px Arial';
  ctx.fillText('VIRTUAL WORLDS MUSEUM', 1024, 165);

  try {
    (ctx as CanvasRenderingContext2D & { letterSpacing: string }).letterSpacing = '6px';
  } catch {
    // ignore
  }
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 52px Arial';
  ctx.fillText('PORTAL LAB 01 — SIX INTEROPERABLE WORLDS', 1024, 285);

  ctx.fillStyle = 'rgba(255,255,255,0.66)';
  ctx.font = '44px Arial';
  ctx.fillText('virtualworlds.museum', 1024, 380);

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

function createPortal(definition: PortalDefinition, index: number): Group {
  const group = new Group();
  const radius = 4.6;
  const angle = (index / PORTALS.length) * Math.PI * 2 - Math.PI / 2;
  group.position.set(Math.cos(angle) * radius, 1.5, Math.sin(angle) * radius);
  group.lookAt(0, 1.5, 0);

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
    phase: (index / PORTALS.length) * Math.PI * 2,
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

class PortalTraversalSystem extends createSystem({}, {}) {
  private headWorld = new Vector3();
  private headLocal = new Vector3();
  private navigating = false;
  private warmup = 1.5;

  update(delta: number) {
    if (this.navigating) return;
    this.warmup -= delta;
    if (this.warmup > 0) return;

    this.camera.getWorldPosition(this.headWorld);

    for (const target of portalTargets) {
      this.headLocal.copy(this.headWorld);
      target.group.worldToLocal(this.headLocal);

      const nx = this.headLocal.x / OPEN_RX;
      const ny = this.headLocal.y / OPEN_RY;
      const insidePortal = nx * nx + ny * ny < 1 && Math.abs(this.headLocal.z) < 0.42;

      if (insidePortal) {
        this.navigating = true;
        void this.jumpTo(target.definition);
        return;
      }
    }
  }

  private async jumpTo(definition: PortalDefinition) {
    const status = document.getElementById('status');
    if (status) status.textContent = `Opening ${definition.name}…`;
    document.body.classList.add('portal-jump');

    try {
      await this.world.exitXR();
    } catch {
      // It is safe to continue if there is no active XR session.
    }

    window.setTimeout(() => {
      window.location.assign(definition.url);
    }, 260);
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

  const ambient = new AmbientLight(0xffffff, 0.85);
  const key = new DirectionalLight(0xffffff, 1.6);
  key.position.set(3, 8, 2);
  const warmth = new PointLight(0xffd75e, 12, 22);
  warmth.position.set(0, 3.0, 0);
  world.scene.add(ambient, key, warmth);

  // --- Circular holodeck room -------------------------------------------
  const ROOM_RADIUS = 7;
  const WALL_HEIGHT = 3.4;

  const floorGrid = makeHolodeckGridTexture(1024, 16);
  const floor = new Mesh(
    new CircleGeometry(ROOM_RADIUS, 72),
    new MeshStandardMaterial({
      map: floorGrid,
      roughness: 0.85,
      metalness: 0.05,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = 0.001;
  world.createTransformEntity(floor).addComponent(LocomotionEnvironment, {
    type: EnvironmentType.STATIC,
  });

  // Dark base ring under the floor for edge thickness.
  const base = new Mesh(
    new CylinderGeometry(ROOM_RADIUS + 0.06, ROOM_RADIUS + 0.06, 0.14, 72),
    new MeshStandardMaterial({ color: new Color('#0b0b0e'), roughness: 0.9 }),
  );
  base.position.y = -0.07;
  world.createTransformEntity(base);

  const walls = new Mesh(
    new CylinderGeometry(ROOM_RADIUS, ROOM_RADIUS, WALL_HEIGHT, 72, 1, true),
    new MeshBasicMaterial({
      map: makeWallGridTexture(),
      side: BackSide,
      toneMapped: false,
    }),
  );
  walls.position.y = WALL_HEIGHT / 2;
  world.createTransformEntity(walls);

  const ceiling = new Mesh(
    new CircleGeometry(ROOM_RADIUS, 72),
    new MeshBasicMaterial({
      map: floorGrid,
      color: new Color('#3d3d3d'),
      toneMapped: false,
    }),
  );
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = WALL_HEIGHT;
  world.createTransformEntity(ceiling);

  // --- Center dais with the VWM emblem -----------------------------------
  const dais = new Mesh(
    new CylinderGeometry(1.25, 1.35, 0.16, 48),
    new MeshStandardMaterial({
      color: new Color('#15171d'),
      metalness: 0.45,
      roughness: 0.4,
    }),
  );
  dais.position.y = 0.08;
  world.createTransformEntity(dais);

  const emblem = new Mesh(
    new CircleGeometry(1.14, 48),
    new MeshBasicMaterial({
      map: makeDaisEmblemTexture(),
      transparent: true,
      toneMapped: false,
    }),
  );
  emblem.rotation.x = -Math.PI / 2;
  emblem.position.y = 0.165;
  world.createTransformEntity(emblem);

  // --- Branding -----------------------------------------------------------
  const title = makeTitleSprite();
  title.position.set(0, 2.62, 0);
  world.createTransformEntity(title);

  // --- Portals ------------------------------------------------------------
  PORTALS.forEach((definition, index) => {
    const group = createPortal(definition, index);
    world.createTransformEntity(group);
    portalTargets.push({ definition, group });
  });

  world.registerSystem(PortalEffectsSystem, { priority: 4 });
  world.registerSystem(PortalTraversalSystem, { priority: 5 });

  const enterButton = document.getElementById('enter-xr') as HTMLButtonElement | null;
  const status = document.getElementById('status');

  enterButton?.addEventListener('click', async () => {
    try {
      if (status) status.textContent = 'Starting immersive mode…';
      await world.launchXR();
      if (status) status.textContent = 'In VR. Walk into any glowing portal.';
    } catch (error) {
      console.error(error);
      if (status) status.textContent = 'Could not enter VR. See browser console for details.';
    }
  });
}

void main();
