/**
 * Test harness around the shipped autopilot: plays whole runs head-less.
 */

import { World } from '../www/src/game/world.js';
import { createAutopilot, stepAutopilot } from '../www/src/game/autopilot.js';

export function playRun(seed, { steps = 120 * 300, greedy = true, dt = 1 / 120, sloppiness = 0 } = {}) {
  const w = new World(seed);
  const state = createAutopilot({ greedy, sloppiness });
  const counts = Object.create(null);
  let flips = 0;
  for (let i = 0; i < steps && w.alive; i++) {
    if (stepAutopilot(w, state)) flips++;
    w.update(dt);
    w.drainEvents((e) => {
      counts[e.type] = (counts[e.type] || 0) + 1;
    });
  }
  return { world: w, counts, flips };
}
