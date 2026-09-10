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
  const ring = pickRing(world);
  if (!ring) return false;
  const sinceFlip = world.time - state.lastFlip;
  if (sinceFlip >= 0 && sinceFlip < FLIP_COOLDOWN) return false;

  // Slow-motion scales the player and the rings together, so it cancels out of
  // the reach calculation entirely.
  const distance = ring.travel - World.crossTravel(ring);
  if (distance <= 0) return false;
  const reach = (world.playerSpeed / (TUNE.ringSpeed * world.speedScale)) * distance;

  let target = ring.targetAngle;
  if (state.greedy) {
    const orb = ring.orbs.find((o) => !o.taken && o.gapIndex === ring.targetGap);
    if (orb) target = wrap(target + orb.offset);
  }
  if (state.sloppiness) {
    target = wrap(target + (Math.random() - 0.5) * state.sloppiness);
  }

  const stay = angleDist(wrap(world.player.angle + world.player.dir * reach), target);
  const flip = angleDist(wrap(world.player.angle - world.player.dir * reach), target);
  if (flip < stay - 0.02) {
    state.lastFlip = world.time;
    return true;
  }
  return false;
}

/** The nearest ring the player can still steer for: one not yet crossing. */
function pickRing(world) {
  let best = null;
  for (const r of world.rings) {
    if (r.state !== 'live') continue;
    if (r.travel <= World.crossTravel(r)) continue;
    if (!best || r.travel < best.travel) best = r;
  }
  return best;
}

export function stepAutopilot(world, state) {
  if (autopilotShouldFlip(world, state)) {
    world.flip();
    return true;
  }
  return false;
}
