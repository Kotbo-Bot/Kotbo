/**
 * Édition à plusieurs en direct des pages d'un site (Yjs).
 *
 * Protocole de `y-websocket` côté serveur : synchronisation (étapes 1 et 2,
 * mises à jour) et présence (awareness : curseurs, noms, couleurs). Une
 * « salle » par page, en mémoire, tant qu'au moins un éditeur est connecté.
 *
 * Amorçage : la première connexion charge l'état Yjs enregistré ; à défaut,
 * le serveur construit le document depuis le brouillon. Le faire ici plutôt
 * que dans le premier navigateur évite que deux éditeurs arrivés ensemble
 * n'insèrent chacun le contenu (doublé à la fusion).
 *
 * Enregistrement : 1,5 s après la dernière modification, puis à la dernière
 * déconnexion, l'état Yjs et le brouillon JSON (relu à travers la liste
 * blanche) sont écrits sur la page.
 */

import * as Y from 'yjs';
import * as syncProtocol from 'y-protocols/sync';
import * as awarenessProtocol from 'y-protocols/awareness';
import * as encoding from 'lib0/encoding';
import * as decoding from 'lib0/decoding';
import { normalizeSiteDocument, type SiteDocument } from '@kotbo/shared';
import type { Prisma } from '@prisma/client';
import prisma from '../../utils/db.js';
import { logger } from '../../utils/logger.js';
import { COLLAB_FRAGMENT, fragmentToDocument, seedFragment } from './siteCollabCodec.js';
import { isSiteAgentLocked } from './siteAgentLock.js';

const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_QUERY_AWARENESS = 3;

const SAVE_DEBOUNCE_MS = 1500;
const ROOM_IDLE_MS = 30_000;
/** Message entrant le plus gros accepté (une image collée en base64 n'a rien à faire là). */
export const COLLAB_MAX_MESSAGE_BYTES = 512 * 1024;
/** Taille maximale de l'état d'une page, encodé. */
const MAX_STATE_BYTES = 5 * 1024 * 1024;

export interface CollabSocket {
  send(data: Uint8Array): unknown;
  close(code?: number, reason?: string): unknown;
}

interface Connection {
  socket: CollabSocket;
  userId: string;
  awarenessIds: Set<number>;
}

interface Room {
  pageId: string;
  guildId: string;
  doc: Y.Doc;
  awareness: awarenessProtocol.Awareness;
  connections: Map<CollabSocket, Connection>;
  saveTimer: ReturnType<typeof setTimeout> | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastEditorId: string | null;
  dirty: boolean;
}

const rooms = new Map<string, Promise<Room>>();
const roomBySocket = new Map<CollabSocket, string>();

function send(conn: Connection | CollabSocket, payload: Uint8Array): void {
  const socket = 'socket' in conn ? conn.socket : conn;
  try {
    socket.send(payload);
  } catch {
    // Socket déjà fermé : la déconnexion fera le ménage.
  }
}

async function save(room: Room): Promise<void> {
  if (!room.dirty) return;
  room.dirty = false;
  const state = Y.encodeStateAsUpdate(room.doc);
  if (state.byteLength > MAX_STATE_BYTES) {
    logger.warn('SiteCollab', `État de la page ${room.pageId} trop gros (${state.byteLength} o), non enregistré.`);
    return;
  }
  const draft = fragmentToDocument(room.doc.getXmlFragment(COLLAB_FRAGMENT));
  await prisma.sitePage
    .update({
      where: { id: room.pageId },
      data: {
        collabState: Buffer.from(state),
        draftContent: draft as unknown as Prisma.InputJsonValue,
        hasUnpublishedChanges: true,
        ...(room.lastEditorId ? { lastEditedById: room.lastEditorId } : {}),
      },
    })
    .catch((err) => {
      room.dirty = true;
      logger.error('SiteCollab', `Enregistrement de la page ${room.pageId} impossible :`, err);
    });
}

function scheduleSave(room: Room): void {
  room.dirty = true;
  if (room.saveTimer) clearTimeout(room.saveTimer);
  room.saveTimer = setTimeout(() => {
    room.saveTimer = null;
    void save(room);
  }, SAVE_DEBOUNCE_MS);
}

async function loadRoom(pageId: string, guildId: string): Promise<Room> {
  const page = await prisma.sitePage.findFirst({ where: { id: pageId, guildId }, select: { collabState: true, draftContent: true } });
  if (!page) throw new Error('page_missing');
  const doc = new Y.Doc({ gc: true });
  if (page.collabState && page.collabState.byteLength > 0) {
    Y.applyUpdate(doc, new Uint8Array(page.collabState));
  } else {
    seedFragment(doc.getXmlFragment(COLLAB_FRAGMENT), normalizeSiteDocument(page.draftContent) as SiteDocument);
  }
  const awareness = new awarenessProtocol.Awareness(doc);
  awareness.setLocalState(null);
  const room: Room = { pageId, guildId, doc, awareness, connections: new Map(), saveTimer: null, idleTimer: null, lastEditorId: null, dirty: false };

  doc.on('update', (update: Uint8Array, origin: unknown) => {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const message = encoding.toUint8Array(encoder);
    for (const conn of room.connections.values()) send(conn, message);
    const author = origin ? room.connections.get(origin as CollabSocket) : undefined;
    if (author) room.lastEditorId = author.userId;
    scheduleSave(room);
  });

  awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
    const conn = origin ? room.connections.get(origin as CollabSocket) : undefined;
    if (conn) {
      for (const id of added) conn.awarenessIds.add(id);
      for (const id of removed) conn.awarenessIds.delete(id);
    }
    const changed = [...added, ...updated, ...removed];
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(awareness, changed));
    const message = encoding.toUint8Array(encoder);
    for (const other of room.connections.values()) send(other, message);
  });

  return room;
}

function getRoom(pageId: string, guildId: string): Promise<Room> {
  let pending = rooms.get(pageId);
  if (!pending) {
    pending = loadRoom(pageId, guildId);
    rooms.set(pageId, pending);
    pending.catch(() => rooms.delete(pageId));
  }
  return pending;
}

export async function openCollabConnection(socket: CollabSocket, pageId: string, guildId: string, userId: string): Promise<void> {
  let room: Room;
  try {
    room = await getRoom(pageId, guildId);
  } catch {
    socket.close(4404, 'page_missing');
    return;
  }
  if (room.guildId !== guildId) {
    socket.close(4403, 'forbidden');
    return;
  }
  if (room.idleTimer) {
    clearTimeout(room.idleTimer);
    room.idleTimer = null;
  }
  const conn: Connection = { socket, userId, awarenessIds: new Set() };
  room.connections.set(socket, conn);
  roomBySocket.set(socket, pageId);

  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep1(encoder, room.doc);
  send(conn, encoding.toUint8Array(encoder));

  const states = room.awareness.getStates();
  if (states.size > 0) {
    const awarenessEncoder = encoding.createEncoder();
    encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
    encoding.writeVarUint8Array(awarenessEncoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
    send(conn, encoding.toUint8Array(awarenessEncoder));
  }
}

export async function handleCollabMessage(socket: CollabSocket, data: Uint8Array): Promise<void> {
  const pageId = roomBySocket.get(socket);
  if (!pageId) return;
  if (data.byteLength > COLLAB_MAX_MESSAGE_BYTES) {
    socket.close(1009, 'message_too_big');
    return;
  }
  const room = await rooms.get(pageId);
  const conn = room?.connections.get(socket);
  if (!room || !conn) return;
  try {
    const decoder = decoding.createDecoder(data);
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      // Un agent tient la main sur le site : les éditeurs humains lisent, mais
      // leurs modifications (étape 2, mises à jour) sont ignorées.
      if (decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1 && isSiteAgentLocked(room.guildId)) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, room.doc, socket);
      if (encoding.length(encoder) > 1) send(conn, encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(room.awareness, decoding.readVarUint8Array(decoder), socket);
    } else if (type === MESSAGE_QUERY_AWARENESS) {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(encoder, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
      send(conn, encoding.toUint8Array(encoder));
    }
  } catch (err) {
    logger.warn('SiteCollab', `Message illisible sur la page ${pageId}, connexion fermée :`, err);
    socket.close(1003, 'bad_message');
  }
}

export async function closeCollabConnection(socket: CollabSocket): Promise<void> {
  const pageId = roomBySocket.get(socket);
  roomBySocket.delete(socket);
  if (!pageId) return;
  const room = await rooms.get(pageId)?.catch(() => null);
  if (!room) return;
  const conn = room.connections.get(socket);
  room.connections.delete(socket);
  if (conn && conn.awarenessIds.size > 0) awarenessProtocol.removeAwarenessStates(room.awareness, [...conn.awarenessIds], null);
  if (room.connections.size === 0) {
    if (room.saveTimer) {
      clearTimeout(room.saveTimer);
      room.saveTimer = null;
    }
    await save(room);
    // Gardée un moment : un rechargement de page ne recharge pas l'état depuis la base.
    room.idleTimer = setTimeout(() => {
      if (room.connections.size === 0) {
        room.doc.destroy();
        rooms.delete(pageId);
      }
    }, ROOM_IDLE_MS);
  }
}

/**
 * Ferme la salle d'une page dont le brouillon vient d'être remplacé hors
 * collaboration (restauration d'une révision) : les éditeurs connectés se
 * reconnectent et repartent du nouveau brouillon.
 */
export async function resetCollabRoom(pageId: string): Promise<void> {
  const pending = rooms.get(pageId);
  if (!pending) return;
  rooms.delete(pageId);
  const room = await pending.catch(() => null);
  if (!room) return;
  if (room.saveTimer) clearTimeout(room.saveTimer);
  if (room.idleTimer) clearTimeout(room.idleTimer);
  for (const conn of room.connections.values()) {
    roomBySocket.delete(conn.socket);
    conn.socket.close(4409, 'reset');
  }
  room.doc.destroy();
}

/** Écrit tout de suite ce que la salle d'une page a en attente (avant une publication). */
export async function flushCollabRoom(pageId: string): Promise<void> {
  const room = await rooms.get(pageId)?.catch(() => null);
  if (!room) return;
  if (room.saveTimer) {
    clearTimeout(room.saveTimer);
    room.saveTimer = null;
  }
  await save(room);
}

/** Nombre d'éditeurs connectés à une page, pour l'interface. */
export async function collabPresenceCount(pageId: string): Promise<number> {
  const room = await rooms.get(pageId)?.catch(() => null);
  return room?.connections.size ?? 0;
}
