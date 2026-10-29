// Multiplayer voice + video over PeerJS, with no server of our own.
//
// PeerJS's public signalling server (0.peerjs.com) only brokers WebRTC
// connections; media and data then flow browser to browser. Rooms are found
// through a well-known "registry" peer id per session key: whichever tab
// claims it first answers "who is here" for everyone else, and any tab
// re-claims it if that tab leaves.
//
// Every connection always carries one audio and one video track. Until the
// visitor joins voice or turns the camera on, those are silent/blank
// placeholders; toggling swaps tracks with replaceTrack, so calls never need
// renegotiating.

import { Peer, type DataConnection, type MediaConnection } from 'peerjs';

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];

// A tracked hand or controller in world space. `j` is present for
// hand-tracking: the 25 WebXR joint positions relative to the grip pose, in
// millimetres (x, y, z per joint, WebXR joint order).
export type HandState = { p: Vec3; q: Quat; j?: number[] };

export type PeerState = {
  p: Vec3;
  q: Quat;
  name: string;
  mic: boolean;
  video: boolean;
  // Only sent from a headset session.
  hands?: { left?: HandState; right?: HandState };
};

export type RemotePeer = {
  id: string;
  data?: DataConnection;
  call?: MediaConnection;
  stream?: MediaStream;
  state?: PeerState;
  // Named in a roster at least once (so a later roster can retire it).
  listed?: boolean;
};

type Message =
  | { t: 'roster'; ids: string[] }
  | { t: 'full' }
  | ({ t: 'state' } & PeerState);

export type MultiplayerStatus = {
  roomId: string | null;
  people: number;
  joined: boolean;
  micOn: boolean;
  cameraOn: boolean;
  note: string;
};

const MAX_PEOPLE = 8; // full mesh: every person connects to every other
const REGISTRY_RETRY_MS = 3000;
const CONNECT_TIMEOUT_MS = 6000;
// After a registry change, rosters fill up as members reconnect; don't treat
// the early, partial ones as departures.
const ROSTER_GRACE_MS = 5000;

function cleanId(value: string | null, fallback: string, max = 24): string {
  const cleaned = (value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+|-+$/g, '')
    .slice(0, max);
  return cleaned || fallback;
}

function randomSuffix(length = 8): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function loadName(params: URLSearchParams): string {
  const fromUrl = params.get('name')?.trim().slice(0, 32);
  if (fromUrl) {
    localStorage.setItem('vwm-lab-name', fromUrl);
    return fromUrl;
  }
  const saved = localStorage.getItem('vwm-lab-name');
  if (saved) return saved;
  const generated = `Guest ${Math.floor(1000 + Math.random() * 9000)}`;
  localStorage.setItem('vwm-lab-name', generated);
  return generated;
}

class Multiplayer {
  readonly name: string;
  readonly session: string;

  private roomId: string | null = null;
  private key = '';
  private generation = 0;
  private participant: Peer | null = null;
  private registry: Peer | null = null;
  private registryMembers = new Map<string, DataConnection | null>();
  private registryConn: DataConnection | null = null;
  private registryTimer = 0;
  private remotes = new Map<string, RemotePeer>();
  private listeners = new Set<() => void>();
  private note = '';
  private full = false;
  private rosterGraceUntil = 0;

  private silentAudio: MediaStreamTrack;
  private blankVideo: MediaStreamTrack;
  private micTrack: MediaStreamTrack | null = null;
  private cameraTrack: MediaStreamTrack | null = null;
  private joining: Promise<void> | null = null;

  constructor() {
    const params = new URLSearchParams(window.location.search);
    this.session = cleanId(params.get('session'), 'public');
    this.name = loadName(params);

    // Placeholder tracks: a destination with no sources is pure silence, and
    // a black canvas stream stands in for the camera.
    const audioContext = new AudioContext();
    this.silentAudio = audioContext.createMediaStreamDestination().stream.getAudioTracks()[0];
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 48;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#000000';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    this.blankVideo = canvas.captureStream(2).getVideoTracks()[0];

    window.addEventListener('pagehide', () => this.leave());
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  peers(): RemotePeer[] {
    return [...this.remotes.values()];
  }

  status(): MultiplayerStatus {
    return {
      roomId: this.roomId,
      people: this.remotes.size + (this.roomId ? 1 : 0),
      joined: this.micTrack !== null,
      micOn: this.micTrack?.enabled ?? false,
      cameraOn: this.cameraTrack !== null,
      note: this.full ? 'Room is full (8 people)' : this.note,
    };
  }

  // Leave the current room's group (if any) and join `roomId`'s, listen-only
  // until the visitor joins voice. Local mic/camera tracks carry over.
  enterRoom(roomId: string) {
    this.leave();
    const generation = ++this.generation;
    this.roomId = roomId;
    this.key = `vwmlab-${this.session}-${cleanId(roomId, 'room', 40)}`;
    this.full = false;
    this.setNote('Connecting…');

    const participant = new Peer(`${this.key}-${randomSuffix()}`);
    this.participant = participant;

    participant.on('open', () => {
      if (generation !== this.generation) return;
      this.setNote('');
      this.claimRegistry(generation);
    });
    participant.on('connection', (conn) => {
      if (generation !== this.generation) return;
      if (conn.peer === this.registryId()) return; // we never accept those
      this.wireData(this.remote(conn.peer), conn);
    });
    participant.on('call', (call) => {
      if (generation !== this.generation) return;
      call.answer(this.outgoingStream());
      this.wireCall(this.remote(call.peer), call);
    });
    participant.on('disconnected', () => {
      // Lost the signalling server only; existing peer links keep working.
      if (generation === this.generation && !participant.destroyed) participant.reconnect();
    });
    participant.on('error', (error) => {
      if (generation !== this.generation) return;
      if (error.type === 'peer-unavailable') {
        // Usually the registry id is still held by a tab that just closed;
        // the server releases it shortly.
        if (String(error.message).includes(this.registryId())) {
          this.scheduleRegistry(generation, REGISTRY_RETRY_MS);
        }
        return;
      }
      console.warn('[MP] peer error', error.type, error);
      this.setNote(`Connection problem (${error.type})`);
    });
  }

  leave() {
    this.generation += 1;
    window.clearTimeout(this.registryTimer);
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
    this.registryConn?.close();
    this.registryConn = null;
    this.registryMembers.clear();
    this.registry?.destroy();
    this.registry = null;
    this.participant?.destroy();
    this.participant = null;
    this.roomId = null;
    this.emit();
  }

  // Ask for the microphone and start sending it. Safe to call repeatedly.
  join(): Promise<void> {
    if (this.micTrack) return Promise.resolve();
    this.joining ??= navigator.mediaDevices
      .getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      .then((stream) => {
        this.micTrack = stream.getAudioTracks()[0];
        this.replaceOnAllCalls('audio', this.micTrack);
        this.setNote('');
      })
      .catch((error: unknown) => {
        console.warn('[MP] microphone unavailable', error);
        this.setNote('Microphone blocked or unavailable');
      })
      .finally(() => {
        this.joining = null;
        this.emit();
      });
    return this.joining;
  }

  async toggleMic() {
    if (!this.micTrack) return this.join();
    this.micTrack.enabled = !this.micTrack.enabled;
    this.emit();
  }

  async toggleCamera() {
    if (this.cameraTrack) {
      this.cameraTrack.stop(); // releases the camera (and its light)
      this.cameraTrack = null;
      this.replaceOnAllCalls('video', this.blankVideo);
      this.emit();
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 320 }, height: { ideal: 240 }, frameRate: { ideal: 15 } },
      });
      this.cameraTrack = stream.getVideoTracks()[0];
      this.replaceOnAllCalls('video', this.cameraTrack);
      this.setNote('');
    } catch (error) {
      console.warn('[MP] camera unavailable', error);
      this.setNote('Camera blocked or unavailable');
    }
    this.emit();
  }

  // Broadcast this visitor's head pose to everyone in the room.
  sendState(p: Vec3, q: Quat, hands?: PeerState['hands']) {
    const message: Message = {
      t: 'state',
      p,
      q,
      hands,
      name: this.name,
      mic: this.micTrack?.enabled ?? false,
      video: this.cameraTrack !== null,
    };
    for (const remote of this.remotes.values()) {
      if (remote.data?.open) remote.data.send(message);
    }
  }

  // ---------------------------------------------------------------------------
  // Registry: one tab per session key answers "who is in this room"
  // ---------------------------------------------------------------------------

  private registryId() {
    return `${this.key}-registry`;
  }

  private scheduleRegistry(generation: number, delayMs: number) {
    window.clearTimeout(this.registryTimer);
    this.registryTimer = window.setTimeout(() => {
      if (generation === this.generation) this.claimRegistry(generation);
    }, delayMs);
  }

  private claimRegistry(generation: number) {
    const participant = this.participant;
    if (!participant || participant.destroyed) return;
    this.registryConn?.close();
    this.registryConn = null;
    this.rosterGraceUntil = Date.now() + ROSTER_GRACE_MS;

    const registry = new Peer(this.registryId());
    registry.on('open', () => {
      if (generation !== this.generation) {
        registry.destroy();
        return;
      }
      console.log('[MP] registry', this.registryId());
      this.registry = registry;
      this.registryMembers = new Map([[participant.id, null]]);
      this.publishRoster();
    });
    registry.on('connection', (conn) => {
      if (generation !== this.generation) return;
      conn.on('open', () => {
        if (this.registryMembers.size >= MAX_PEOPLE) {
          conn.send({ t: 'full' } satisfies Message);
          window.setTimeout(() => conn.close(), 500);
          return;
        }
        this.registryMembers.set(conn.peer, conn);
        this.publishRoster();
      });
      conn.on('close', () => {
        if (this.registryMembers.get(conn.peer) !== conn) return;
        this.registryMembers.delete(conn.peer);
        this.publishRoster();
      });
    });
    registry.on('error', (error) => {
      registry.destroy();
      if (generation !== this.generation) return;
      if (error.type === 'unavailable-id') {
        this.connectToRegistry(generation);
      } else {
        console.warn('[MP] registry error', error.type, error);
        this.scheduleRegistry(generation, REGISTRY_RETRY_MS);
      }
    });
  }

  private publishRoster() {
    const ids = [...this.registryMembers.keys()];
    const message: Message = { t: 'roster', ids };
    for (const conn of this.registryMembers.values()) if (conn?.open) conn.send(message);
    this.applyRoster(ids);
  }

  private connectToRegistry(generation: number) {
    const participant = this.participant;
    if (!participant || participant.destroyed) return;
    const conn = participant.connect(this.registryId(), { serialization: 'json', reliable: true });
    this.registryConn = conn;

    const timeout = window.setTimeout(() => {
      if (!conn.open && generation === this.generation) {
        conn.close();
        this.scheduleRegistry(generation, REGISTRY_RETRY_MS);
      }
    }, CONNECT_TIMEOUT_MS);

    conn.on('open', () => window.clearTimeout(timeout));
    conn.on('data', (raw) => {
      if (generation !== this.generation) return;
      const message = raw as Message;
      if (message.t === 'roster') this.applyRoster(message.ids);
      else if (message.t === 'full') {
        this.full = true;
        this.emit();
      }
    });
    conn.on('close', () => {
      window.clearTimeout(timeout);
      if (generation !== this.generation || this.registryConn !== conn || this.full) return;
      // The registry tab left: race to take over, with jitter so one wins.
      this.scheduleRegistry(generation, 200 + Math.random() * 1300);
    });
  }

  // ---------------------------------------------------------------------------
  // Peers: full mesh, the lexicographically smaller id dials
  // ---------------------------------------------------------------------------

  private applyRoster(ids: string[]) {
    const participant = this.participant;
    if (!participant || participant.destroyed) return;
    const self = participant.id;
    const others = new Set(ids.filter((id) => id !== self));

    for (const id of others) {
      const remote = this.remote(id);
      remote.listed = true;
      if (self < id && !remote.data && !remote.call) {
        this.wireData(remote, participant.connect(id, { serialization: 'json', reliable: false }));
        this.wireCall(remote, participant.call(id, this.outgoingStream()));
      }
    }
    // Real departures also close their data/call links; this is the backstop.
    if (Date.now() >= this.rosterGraceUntil) {
      for (const [id, remote] of this.remotes) {
        if (remote.listed && !others.has(id)) this.dropRemote(id);
      }
    }
    this.emit();
  }

  private remote(id: string): RemotePeer {
    let remote = this.remotes.get(id);
    if (!remote) {
      remote = { id };
      this.remotes.set(id, remote);
      this.emit();
    }
    return remote;
  }

  private wireData(remote: RemotePeer, conn: DataConnection) {
    remote.data?.close();
    remote.data = conn;
    conn.on('data', (raw) => {
      const message = raw as Message;
      if (message.t === 'state') {
        const first = !remote.state;
        remote.state = {
          p: message.p,
          q: message.q,
          name: message.name,
          mic: message.mic,
          video: message.video,
          hands: message.hands,
        };
        if (first) this.emit();
      }
    });
    conn.on('close', () => {
      if (remote.data === conn) this.dropRemote(remote.id);
    });
  }

  private wireCall(remote: RemotePeer, call: MediaConnection) {
    remote.call?.close();
    remote.call = call;
    call.on('stream', (stream) => {
      remote.stream = stream;
      this.emit();
    });
    call.on('close', () => {
      if (remote.call === call) this.dropRemote(remote.id);
    });
  }

  private dropRemote(id: string) {
    const remote = this.remotes.get(id);
    if (!remote) return;
    this.remotes.delete(id);
    remote.data?.close();
    remote.call?.close();
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Local media
  // ---------------------------------------------------------------------------

  private outgoingStream(): MediaStream {
    return new MediaStream([this.micTrack ?? this.silentAudio, this.cameraTrack ?? this.blankVideo]);
  }

  private replaceOnAllCalls(kind: 'audio' | 'video', track: MediaStreamTrack) {
    for (const remote of this.remotes.values()) {
      const connection = remote.call?.peerConnection;
      if (!connection) continue;
      for (const transceiver of connection.getTransceivers()) {
        if (transceiver.receiver.track.kind === kind) void transceiver.sender.replaceTrack(track);
      }
    }
  }

  private setNote(note: string) {
    this.note = note;
    this.emit();
  }

  private emit() {
    for (const listener of this.listeners) listener();
  }
}

export const multiplayer = new Multiplayer();
