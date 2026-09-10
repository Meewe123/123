/**
 * A competent reference player.
 *
 * It is used for the attract-mode demo on the title screen, and by the balance
 * tests to prove that every generated ring really is passable — the same code
 * in both places, so the test is testing the shipped behaviour.
 *
 * It never reads anything a human could not: the aimed gap is exactly the gap
 * a player can see coming.
 */

import { World } from './world.js';
import { TUNE } from './config.js';
import { wrap, angleDist } from '../engine/util.js';

const FLIP_COOLDOWN = 0.07;

export function createAutopilot({ greedy = true, sloppiness = 0 } = {}) {
  return { lastFlip: -1, greedy, sloppiness };
}

/** Returns true when the autopilot wants to reverse this step. */
export function autopilotShouldFlip(world, state) {
  const ring = world.nextRing();
  if (!ring) return false;
  // A negative gap means the world was reset under a reused state object.
  const sinceFlip = world.time - state.lastFlip;
  if (sinceFlip >= 0 && sinceFlip < FLIP_COOLDOWN) return false;

  const speed = TUNE.ringSpeed * world.speedScale;
  const tc = (ring.travel - World.crossTravel(ring)) / speed;
  if (tc <= 0) return false;

  let target = ring.targetAngle;
  if (state.greedy) {
    const orb = ring.orbs.find((o) => !o.taken && o.gapIndex === ring.targetGap);
    if (orb) target = wrap(target + orb.offset);
  }
  if (state.sloppiness) {
    target = wrap(target + (Math.random() - 0.5) * state.sloppiness);
  }

  const reach = world.playerSpeed * tc;
  const stay = angleDist(wrap(world.player.angle + world.player.dir * reach), target);
  const flip = angleDist(wrap(world.player.angle - world.player.dir * reach), target);
  if (flip < stay - 0.02) {
    state.lastFlip = world.time;
    return true;
  }
  return false;
}

export function stepAutopilot(world, state) {
  if (autopilotShouldFlip(world, state)) {
    world.flip();
    return true;
  }
  return false;
}
