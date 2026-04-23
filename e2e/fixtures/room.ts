import type { BrowserContext } from '@playwright/test';
import { BrowserUser } from '../utils/browser-user';
import type { RoomOptions } from '../types';

export interface RoomFixture {
  host: BrowserUser;
  guests: BrowserUser[];
  roomCode: string;
}

export async function createRoomFixture(
  context: BrowserContext,
  guestCount = 0,
  opts: RoomOptions = {}
): Promise<RoomFixture> {
  const host = await BrowserUser.create(context, 'Host');
  const { roomCode } = await host.createRoom({ ...opts, name: 'Host' });

  const guests: BrowserUser[] = [];
  const guestNames = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve'];

  for (let i = 0; i < guestCount; i++) {
    const guest = await BrowserUser.create(context, guestNames[i]);
    await guest.joinRoom(roomCode, { name: guestNames[i] });
    guests.push(guest);
  }

  return { host, guests, roomCode };
}
