/**
 * Phase 5 PR8 — Inspect pane scroll windowing.
 *
 * Given a formatted tab (a `string[]`), the active scroll offset, and the
 * renderer's reported viewport height, `applyInspectWindow` returns a view
 * containing:
 *
 *   - an optional "above" indicator line summarising how many rows are
 *     hidden above the window
 *   - the visible window of content lines
 *   - an optional "below" indicator line summarising how many rows are
 *     hidden below the window
 *
 * The indicator lines reserve space inside the viewport — when both are
 * shown, the content window shrinks by 2, keeping the total line count at
 * most `height`. This makes the windowing loop-invariant: renderers can
 * paint exactly `height` rows regardless of offset.
 *
 * The helpers are pure and side-effect free; tests can feed them hand-built
 * inputs. See `inspectScroll.test.ts` for the axioms.
 */

export type InspectWindow = {
  /** Clamped scroll offset — always `[0, max(0, total - 1)]`. */
  offset: number;
  /** Visible lines (may include above/below indicator rows at the edges). */
  lines: string[];
  /** Rows hidden above the visible window. */
  hiddenAbove: number;
  /** Rows hidden below the visible window. */
  hiddenBelow: number;
};

/** Pretty-print `n` hidden-rows as a right-aligned indicator line. */
export const formatAboveIndicator = (hidden: number): string =>
  `↑ ${hidden} more above (PgUp / Ctrl+U)`;

export const formatBelowIndicator = (hidden: number): string =>
  `↓ ${hidden} more below (PgDn / Ctrl+D)`;

export type ApplyInspectWindowInput = {
  lines: readonly string[];
  offset: number;
  height: number;
};

/**
 * Slice `lines` into a viewport-sized window, injecting indicator rows when
 * content is hidden above or below.
 *
 * Contract:
 *  - `height >= 1`
 *  - `offset` is clamped into `[0, max(0, lines.length - 1)]`
 *  - when hidden rows exist above the window, the first visible line is an
 *    `↑ N more above` indicator; likewise for below
 *  - when `lines.length <= height`, the full content is returned and no
 *    indicators are emitted
 */
export const applyInspectWindow = (input: ApplyInspectWindowInput): InspectWindow => {
  const height = Math.max(1, Math.floor(input.height));
  const total = input.lines.length;
  if (total === 0) {
    return { offset: 0, lines: [], hiddenAbove: 0, hiddenBelow: 0 };
  }
  const maxOffset = Math.max(0, total - 1);
  const offset = Math.min(maxOffset, Math.max(0, Math.floor(input.offset)));

  if (total <= height) {
    return {
      offset: 0,
      lines: input.lines.slice(),
      hiddenAbove: 0,
      hiddenBelow: 0,
    };
  }

  // Start by reserving the window assuming no indicators.
  const showAbove = offset > 0;
  // Content available to show after the offset, capped by the viewport.
  // We budget indicator rows inside the viewport so the total stays `height`.
  const belowReserve = 1;
  const aboveReserve = showAbove ? 1 : 0;
  // First pass: figure out whether the below indicator will be needed.
  const naiveContentRoom = height - aboveReserve;
  const contentWindowEnd = Math.min(total, offset + naiveContentRoom);
  const willShowBelow = contentWindowEnd < total;
  const contentRoom = height - aboveReserve - (willShowBelow ? belowReserve : 0);
  const clampedRoom = Math.max(1, contentRoom);
  const start = offset;
  const end = Math.min(total, start + clampedRoom);
  const slice = input.lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = Math.max(0, total - end);

  const windowed: string[] = [];
  if (hiddenAbove > 0) {
    windowed.push(formatAboveIndicator(hiddenAbove));
  }
  for (const line of slice) {
    windowed.push(line);
  }
  if (hiddenBelow > 0) {
    windowed.push(formatBelowIndicator(hiddenBelow));
  }

  return {
    offset,
    lines: windowed,
    hiddenAbove,
    hiddenBelow,
  };
};
