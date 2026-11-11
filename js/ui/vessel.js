// The graduated tumbler: fills with water, marks the goal with a dashed line
// and shows where the drinker should be by now with a small arrow.
import { ML_PER_OZ, fmtNumber } from "../logic.js";
import { svg } from "./dom.js";

// Geometry in SVG user units (viewBox 0 0 100 170).
const RIM_Y = 6;
const CAP_Y = 16;          // water level when the glass is at capacity
const BASE_Y = 166;
const STRAIGHT_END_Y = 154; // where the tapered sides meet the rounded base
const EMPTY_Y = BASE_Y + 6; // pushes the wave below the base
const OUTLINE_D = "M10 6 L18 154 Q19 166 30 166 L70 166 Q81 166 82 154 L90 6";
const WAVE_D = "M-100 0 Q-87.5 -3 -75 0 T-50 0 T-25 0 T0 0 T25 0 T50 0 T75 0 T100 0 T125 0 T150 0 T175 0 T200 0 V12 H-100 Z";

const HEADROOM = 1.25;      // the glass holds a quarter more than the goal
const MAX_TICKS = 12;
const TICK_STEP_ML = Object.freeze({ ml: 250, oz: 8 * ML_PER_OZ });

const leftEdgeX = (y) => 10 + ((Math.min(y, STRAIGHT_END_Y) - RIM_Y) / (STRAIGHT_END_Y - RIM_Y)) * 8;
const rightEdgeX = (y) => 100 - leftEdgeX(y);

let clipSeq = 0;

/**
 * @returns {{ root: SVGElement, paint: (v: { totalMl: number, goalMl: number, expectedMl: number, showPace: boolean, unit: string }) => void }}
 */
export function createVessel() {
  const clipId = `vessel-clip-${++clipSeq}`;
  const ticks = svg("g");
  const marks = svg("g");
  const water = svg("g", { class: "water" }, [
    svg("g", { transform: "translate(0 -1.5)" }, [svg("path", { class: "wave-back", d: WAVE_D })]),
    svg("rect", { class: "water-body", x: -10, y: 4, width: 120, height: 200 }),
    svg("path", { class: "wave-front", d: WAVE_D }),
  ]);
  water.style.transform = `translateY(${EMPTY_Y}px)`;
  const root = svg("svg", { class: "vessel", viewBox: "0 0 100 170", "aria-hidden": "true" }, [
    svg("defs", {}, [svg("clipPath", { id: clipId }, [svg("path", { d: `${OUTLINE_D} Z` })])]),
    svg("g", { "clip-path": `url(#${clipId})` }, [water]),
    ticks,
    marks,
    svg("path", { class: "outline", d: OUTLINE_D }),
  ]);

  function paint({ totalMl, goalMl, expectedMl, showPace, unit }) {
    const baseStep = TICK_STEP_ML[unit] || TICK_STEP_ML.ml;
    const step = baseStep * Math.max(1, Math.ceil((goalMl * HEADROOM) / baseStep / MAX_TICKS));
    const capacity = Math.ceil((goalMl * HEADROOM) / step) * step;
    const yFor = (ml) => BASE_Y - (Math.min(ml, capacity) / capacity) * (BASE_Y - CAP_Y);

    water.style.transform = `translateY(${totalMl <= 0 ? EMPTY_Y : yFor(totalMl)}px)`;

    const tickNodes = [];
    for (let i = 1; step * i < capacity - 1; i++) {
      const y = yFor(step * i);
      const major = i % 2 === 0;
      const x = leftEdgeX(y) + 1.5;
      tickNodes.push(svg("line", { class: "tick", x1: x, y1: y, x2: x + (major ? 11 : 6), y2: y }));
      // The goal line carries its own label, so a tick number on top of it is left out.
      if (major && Math.abs(step * i - goalMl) > step / 2) {
        const label = svg("text", { class: "tick-label", x: x + 13.5, y: y + 2.6 });
        label.textContent = fmtNumber(step * i, unit);
        tickNodes.push(label);
      }
    }
    ticks.replaceChildren(...tickNodes);

    const goalY = yFor(goalMl);
    const goalLabel = svg("text", { class: "goal-label", x: rightEdgeX(goalY) - 3, y: goalY - 3.5, "text-anchor": "end" });
    goalLabel.textContent = "GOAL";
    const markNodes = [
      svg("line", { class: "goal-line", x1: leftEdgeX(goalY), y1: goalY, x2: rightEdgeX(goalY), y2: goalY }),
      goalLabel,
    ];
    if (showPace && expectedMl > 0 && expectedMl < goalMl) {
      const y = yFor(expectedMl);
      const x = rightEdgeX(y) + 1.5;
      markNodes.push(svg("path", { class: "pace-mark", d: `M${x} ${y} L${x + 8} ${y - 4.5} L${x + 8} ${y + 4.5} Z` }));
    }
    marks.replaceChildren(...markNodes);
  }

  return { root, paint };
}

/** A small glass icon filled in proportion to a preset's size. */
export function glassIcon(ml) {
  const level = Math.min(0.95, Math.max(0.2, ml / 800));
  const top = 2 + (1 - level) * 28;
  return svg("svg", { viewBox: "0 0 24 32", "aria-hidden": "true" }, [
    svg("path", { class: "glass-fill", d: `M4 ${top} L6 30 L18 30 L20 ${top} Z` }),
    svg("path", { class: "glass-outline", d: "M3 2 L6 30 L18 30 L21 2" }),
  ]);
}
