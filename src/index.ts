import {
  AmbientLight,
  BoxGeometry,
  CanvasTexture,
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
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
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

function makePortalTexture(title: string, color: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 1024;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');

  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, '#10182b');
  gradient.addColorStop(0.55, color);
  gradient.addColorStop(1, '#070a11');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalAlpha = 0.18;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  for (let y = 80; y < canvas.height; y += 90) {
    ctx.beginPath();
    ctx.moveTo(40, y);
    ctx.lineTo(canvas.width - 40, y);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 58px Arial';
  const words = title.split(' ');
  if (words.length > 1) {
    const split = Math.ceil(words.length / 2);
    ctx.fillText(words.slice(0, split).join(' '), 256, 430);
    ctx.fillText(words.slice(split).join(' '), 256, 500);
  } else {
    ctx.fillText(title, 256, 465);
  }

  ctx.font = '700 26px Arial';
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillText('WALK THROUGH', 256, 590);
  ctx.font = '22px Arial';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillText('VWM INTEROPERABILITY TEST', 256, 635);

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function makeTitleSprite(text: string): Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 256;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = '700 70px Arial';
  ctx.fillText(text, 512, 105);
  ctx.font = '32px Arial';
  ctx.fillStyle = 'rgba(255,255,255,0.72)';
  ctx.fillText('6 interoperable destination tests', 512, 160);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  const sprite = new Sprite(new SpriteMaterial({ map: texture, transparent: true }));
  sprite.scale.set(5.6, 1.4, 1);
  return sprite;
}

function createPortal(definition: PortalDefinition, index: number): Group {
  const group = new Group();
  const radius = 4.5;
  const angle = (index / PORTALS.length) * Math.PI * 2 - Math.PI / 2;
  group.position.set(Math.cos(angle) * radius, 1.5, Math.sin(angle) * radius);
  group.lookAt(0, 1.5, 0);

  const frameMaterial = new MeshStandardMaterial({
    color: new Color(definition.color),
    emissive: new Color(definition.color),
    emissiveIntensity: 0.35,
    metalness: 0.35,
    roughness: 0.35,
  });

  const sideGeometry = new BoxGeometry(0.14, 3.05, 0.18);
  const topGeometry = new BoxGeometry(1.95, 0.14, 0.18);
  const left = new Mesh(sideGeometry, frameMaterial);
  const right = new Mesh(sideGeometry, frameMaterial);
  const top = new Mesh(topGeometry, frameMaterial);
  left.position.x = -0.91;
  right.position.x = 0.91;
  top.position.y = 1.46;
  group.add(left, right, top);

  const portalSurface = new Mesh(
    new PlaneGeometry(1.68, 2.75),
    new MeshBasicMaterial({
      map: makePortalTexture(definition.shortName, definition.color),
      side: DoubleSide,
      toneMapped: false,
    }),
  );
  portalSurface.position.z = 0.01;
  group.add(portalSurface);

  group.updateMatrixWorld(true);
  return group;
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

      const insidePortal =
        Math.abs(this.headLocal.x) < 0.78 &&
        Math.abs(this.headLocal.y) < 1.35 &&
        Math.abs(this.headLocal.z) < 0.34;

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
  world.scene.background = new Color('#090d18');

  const ambient = new AmbientLight(0xffffff, 1.0);
  const key = new DirectionalLight(0xffffff, 2.1);
  key.position.set(3, 8, 2);
  world.scene.add(ambient, key);

  const floor = new Mesh(
    new BoxGeometry(13, 0.12, 13),
    new MeshStandardMaterial({
      color: new Color('#111827'),
      roughness: 0.82,
      metalness: 0.1,
    }),
  );
  floor.position.y = -0.08;
  world
    .createTransformEntity(floor)
    .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

  const center = new Mesh(
    new CylinderGeometry(1.25, 1.25, 0.16, 48),
    new MeshStandardMaterial({
      color: new Color('#20283a'),
      metalness: 0.35,
      roughness: 0.45,
    }),
  );
  center.position.y = 0.06;
  world.createTransformEntity(center);

  const title = makeTitleSprite('VWM PORTAL LAB 01');
  title.position.set(0, 2.55, 0);
  world.createTransformEntity(title);

  PORTALS.forEach((definition, index) => {
    const group = createPortal(definition, index);
    world.createTransformEntity(group);
    portalTargets.push({ definition, group });
  });

  world.registerSystem(PortalTraversalSystem, { priority: 5 });

  const enterButton = document.getElementById('enter-xr') as HTMLButtonElement | null;
  const status = document.getElementById('status');

  enterButton?.addEventListener('click', async () => {
    try {
      if (status) status.textContent = 'Starting immersive mode…';
      await world.launchXR();
      if (status) status.textContent = 'In VR. Walk into any portal.';
    } catch (error) {
      console.error(error);
      if (status) status.textContent = 'Could not enter VR. See browser console for details.';
    }
  });
}

void main();
