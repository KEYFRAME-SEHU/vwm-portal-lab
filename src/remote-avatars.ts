// 3D presence for other people in the room: a floating head panel showing
// their camera (or an initials badge), a name label, and positional voice.
//
// Avatars are plain scene objects rather than ECS entities so room swaps
// (world.loadLevel) never tear them down underneath the multiplayer layer.

import {
  AudioListener,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DoubleSide,
  Group,
  InstancedMesh,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  PositionalAudio,
  Quaternion,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  Vector3,
  VideoTexture,
  type Object3D,
  type Scene,
} from '@iwsdk/core';
import type { HandState, PeerState, RemotePeer } from './multiplayer';

function hueFor(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return Math.abs(hash) % 360;
}

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[words.length - 1][0] : name.slice(0, 2)).toUpperCase();
}

function makeBadgeTexture(name: string, id: string): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 192;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.fillStyle = `hsl(${hueFor(id)}, 55%, 32%)`;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 96px Arial';
  ctx.fillText(initials(name), 128, 96);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

function makeLabelTexture(name: string, mic: boolean): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 512;
  canvas.height = 96;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas is unavailable');
  ctx.fillStyle = 'rgba(6,8,14,0.78)';
  ctx.beginPath();
  ctx.roundRect(4, 4, canvas.width - 8, canvas.height - 8, 30);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '700 44px Arial';
  ctx.fillText(`${mic ? '🎙' : '🔇'} ${name}`, 256, 50);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

const HAND_JOINTS = 25;
const FINGERTIPS = new Set([4, 9, 14, 19, 24]);
// Joint index pairs in WebXR XRHand order: wrist, then thumb (1-4), index
// (5-9), middle (10-14), ring (15-19) and pinky (20-24) chains.
const HAND_BONES: [number, number][] = [];
for (const [first, last] of [[1, 4], [5, 9], [10, 14], [15, 19], [20, 24]]) {
  HAND_BONES.push([0, first]);
  for (let joint = first; joint < last; joint++) HAND_BONES.push([joint, joint + 1]);
}

// One remote hand: joint spheres and bones when its owner uses hand tracking,
// a simple palm shape at the grip pose when they hold a controller.
class RemoteHand {
  readonly group = new Group();
  private palm: Mesh;
  private joints: InstancedMesh;
  private bones: LineSegments;
  private bonePositions: Float32Array;
  private jointTarget = new Float32Array(HAND_JOINTS * 3);
  private jointCurrent = new Float32Array(HAND_JOINTS * 3);
  private tracked = false;
  private placed = false;
  private targetPosition = new Vector3();
  private targetQuaternion = new Quaternion();
  private matrix = new Matrix4();

  constructor(color: Color) {
    const material = new MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.1 });
    this.palm = new Mesh(new SphereGeometry(1, 16, 12), material);
    this.palm.scale.set(0.04, 0.022, 0.06);
    this.group.add(this.palm);

    this.joints = new InstancedMesh(new SphereGeometry(1, 10, 8), material.clone(), HAND_JOINTS);
    this.joints.frustumCulled = false;
    this.group.add(this.joints);

    this.bonePositions = new Float32Array(HAND_BONES.length * 6);
    const boneGeometry = new BufferGeometry();
    boneGeometry.setAttribute('position', new BufferAttribute(this.bonePositions, 3));
    this.bones = new LineSegments(boneGeometry, new LineBasicMaterial({ color }));
    this.bones.frustumCulled = false;
    this.group.add(this.bones);
    this.group.visible = false;
  }

  update(state: HandState | undefined, delta: number) {
    if (!state) {
      this.group.visible = false;
      this.placed = false;
      return;
    }
    const t = 1 - Math.exp(-delta * 14);
    this.targetPosition.fromArray(state.p);
    this.targetQuaternion.fromArray(state.q);
    if (!this.placed) {
      this.group.position.copy(this.targetPosition);
      this.group.quaternion.copy(this.targetQuaternion);
      this.placed = true;
      this.group.visible = true;
    } else {
      this.group.position.lerp(this.targetPosition, t);
      this.group.quaternion.slerp(this.targetQuaternion, t);
    }

    const tracked = state.j?.length === HAND_JOINTS * 3;
    this.palm.visible = !tracked;
    this.joints.visible = tracked;
    this.bones.visible = tracked;
    if (!state.j || !tracked) {
      this.tracked = false;
      return;
    }
    for (let i = 0; i < this.jointTarget.length; i++) this.jointTarget[i] = state.j[i] / 1000;
    if (!this.tracked) this.jointCurrent.set(this.jointTarget);
    this.tracked = true;
    for (let i = 0; i < this.jointCurrent.length; i++) {
      this.jointCurrent[i] += (this.jointTarget[i] - this.jointCurrent[i]) * t;
    }

    const c = this.jointCurrent;
    for (let joint = 0; joint < HAND_JOINTS; joint++) {
      const radius = joint === 0 ? 0.014 : FINGERTIPS.has(joint) ? 0.0065 : 0.0085;
      this.matrix.makeScale(radius, radius, radius);
      this.matrix.setPosition(c[joint * 3], c[joint * 3 + 1], c[joint * 3 + 2]);
      this.joints.setMatrixAt(joint, this.matrix);
    }
    this.joints.instanceMatrix.needsUpdate = true;
    HAND_BONES.forEach(([from, to], bone) => {
      this.bonePositions.set(c.subarray(from * 3, from * 3 + 3), bone * 6);
      this.bonePositions.set(c.subarray(to * 3, to * 3 + 3), bone * 6 + 3);
    });
    this.bones.geometry.attributes.position.needsUpdate = true;
  }
}

class RemoteAvatar {
  // Head and hands are posed independently in world space under one root.
  readonly root = new Group();
  private group = new Group();
  private hands: Record<'left' | 'right', RemoteHand>;
  private panel: Mesh<PlaneGeometry, MeshBasicMaterial>;
  private label: Sprite;
  private badge: CanvasTexture;
  private labelKey = '';
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private videoTexture: VideoTexture | null = null;
  private audioElement: HTMLAudioElement | null = null;
  private voice: PositionalAudio | null = null;
  private placed = false;
  private targetPosition = new Vector3();
  private targetQuaternion = new Quaternion();

  constructor(
    private readonly id: string,
    private readonly listener: AudioListener,
  ) {
    this.badge = makeBadgeTexture('?', id);
    this.panel = new Mesh(
      new PlaneGeometry(0.36, 0.27),
      new MeshBasicMaterial({ map: this.badge, side: DoubleSide, toneMapped: false }),
    );
    // The panel's front faces where its owner is looking (camera -Z).
    this.panel.rotation.y = Math.PI;
    this.group.add(this.panel);

    // Thin frame tinted per person so badges and video read as one object.
    const frame = new Mesh(
      new PlaneGeometry(0.39, 0.3),
      new MeshBasicMaterial({ color: new Color(`hsl(${hueFor(id)}, 70%, 60%)`), side: DoubleSide }),
    );
    frame.position.z = 0.002;
    frame.rotation.y = Math.PI;
    this.group.add(frame);

    this.label = new Sprite(new SpriteMaterial({ transparent: true, toneMapped: false, depthWrite: false }));
    this.label.scale.set(0.42, 0.079, 1);
    this.label.position.y = -0.22;
    this.group.add(this.label);
    this.group.visible = false;
    this.root.add(this.group);

    const handColor = new Color().setHSL(hueFor(id) / 360, 0.55, 0.68);
    this.hands = { left: new RemoteHand(handColor), right: new RemoteHand(handColor) };
    this.root.add(this.hands.left.group, this.hands.right.group);
  }

  update(remote: RemotePeer, delta: number) {
    if (remote.stream && remote.stream !== this.stream) this.attachStream(remote.stream);
    const state = remote.state;
    if (!state) return;
    this.applyState(state);

    this.targetPosition.fromArray(state.p);
    this.targetQuaternion.fromArray(state.q);
    if (!this.placed) {
      this.group.position.copy(this.targetPosition);
      this.group.quaternion.copy(this.targetQuaternion);
      this.placed = true;
      this.group.visible = true;
    } else {
      const t = 1 - Math.exp(-delta * 10);
      this.group.position.lerp(this.targetPosition, t);
      this.group.quaternion.slerp(this.targetQuaternion, t);
    }
    this.hands.left.update(state.hands?.left, delta);
    this.hands.right.update(state.hands?.right, delta);
  }

  private applyState(state: PeerState) {
    const labelKey = `${state.name}|${state.mic}`;
    if (labelKey !== this.labelKey) {
      if (this.labelKey.split('|')[0] !== state.name) {
        this.badge.dispose();
        this.badge = makeBadgeTexture(state.name, this.id);
      }
      this.labelKey = labelKey;
      this.label.material.map?.dispose();
      this.label.material.map = makeLabelTexture(state.name, state.mic);
      this.label.material.needsUpdate = true;
    }
    const map = state.video && this.videoTexture ? this.videoTexture : this.badge;
    if (this.panel.material.map !== map) {
      this.panel.material.map = map;
      this.panel.material.needsUpdate = true;
    }
  }

  private attachStream(stream: MediaStream) {
    this.detachStream();
    this.stream = stream;

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    void video.play().catch(() => undefined);
    this.video = video;
    this.videoTexture = new VideoTexture(video);
    this.videoTexture.colorSpace = SRGBColorSpace;

    // Chrome only feeds WebRTC audio into WebAudio while the stream is also
    // attached to a media element; keep a muted one alive for that.
    const audioElement = new Audio();
    audioElement.muted = true;
    audioElement.srcObject = stream;
    void audioElement.play().catch(() => undefined);
    this.audioElement = audioElement;

    const voice = new PositionalAudio(this.listener);
    voice.setMediaStreamSource(stream);
    voice.setRefDistance(1);
    voice.setRolloffFactor(1.5);
    this.group.add(voice);
    this.voice = voice;
  }

  private detachStream() {
    if (this.voice) {
      this.voice.disconnect();
      this.voice.removeFromParent();
      this.voice = null;
    }
    if (this.audioElement) {
      this.audioElement.srcObject = null;
      this.audioElement = null;
    }
    if (this.video) {
      this.video.srcObject = null;
      this.video = null;
    }
    if (this.videoTexture) {
      if (this.panel.material.map === this.videoTexture) this.panel.material.map = this.badge;
      this.videoTexture.dispose();
      this.videoTexture = null;
    }
    this.stream = null;
  }

  dispose() {
    this.detachStream();
    this.root.removeFromParent();
    this.root.traverse((object: Object3D) => {
      if (object instanceof Mesh || object instanceof LineSegments) {
        object.geometry.dispose();
        object.material.dispose();
      }
    });
    this.badge.dispose();
    this.label.material.map?.dispose();
    this.label.material.dispose();
  }
}

export class RemoteAvatars {
  // Our own listener: IWSDK's AudioSystem keeps its listener private. Both use
  // three's shared AudioContext.
  readonly listener = new AudioListener();
  private avatars = new Map<string, RemoteAvatar>();

  constructor(
    private readonly scene: Scene,
    camera: Object3D,
  ) {
    camera.add(this.listener);
  }

  get audioSuspended(): boolean {
    return this.listener.context.state !== 'running';
  }

  resumeAudio() {
    if (this.listener.context.state === 'suspended') void this.listener.context.resume();
  }

  update(peers: RemotePeer[], delta: number) {
    const live = new Set<string>();
    for (const remote of peers) {
      live.add(remote.id);
      let avatar = this.avatars.get(remote.id);
      if (!avatar) {
        avatar = new RemoteAvatar(remote.id, this.listener);
        this.avatars.set(remote.id, avatar);
        this.scene.add(avatar.root);
      }
      avatar.update(remote, delta);
    }
    for (const [id, avatar] of this.avatars) {
      if (live.has(id)) continue;
      avatar.dispose();
      this.avatars.delete(id);
    }
  }
}
