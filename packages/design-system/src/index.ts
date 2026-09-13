/**
 * Telga design system.
 *
 * Tokens only. Components live with the surface that renders them: the merchant
 * screens are built in `apps/merchant-pos/src/ui`, the console in
 * `apps/operations-console/src/ui`, and neither shares a renderer with the
 * other. What they share is the vocabulary, and that is what this package is.
 */

export {
  VELLUM,
  LEATHER,
  PHASE,
  SPACE,
  TYPE,
  SIZE,
  SHADOW,
  LAYER,
  MOTION,
  SAFE,
  cssVariables,
  phaseRule,
} from './tokens';
export type { Token } from './tokens';
