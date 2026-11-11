// "Add to home screen" instructions, worded for the phone in hand.
import { h, svg, toast } from "./dom.js";
import { glassIcon } from "./vessel.js";

function shareGlyph() {
  return svg("svg", { class: "inline-icon", viewBox: "0 0 24 24", "aria-hidden": "true" }, [
    svg("path", { d: "M12 3v12M12 3l-4 4M12 3l4 4M6 11H5a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-1" }),
  ]);
}

export function brandMark() {
  return h("div", { class: "brand" }, glassIcon(560), h("span", { text: "Water Pact" }));
}

/**
 * @param {{ platform: object, installPrompt: () => any, afterInstallNote?: string }} options
 * @returns {HTMLElement}
 */
export function installSteps({ platform, installPrompt, afterInstallNote = "" }) {
  const lastStep = "Open Water Pact from your home screen.";
  const steps = (items) => h("ol", { class: "steps" }, items.map((item) => h("li", {}, item)));

  if (platform.isIOS) {
    return h("div", { class: "install" },
      steps([
        h("span", {}, "Tap the Share button ", shareGlyph(), " in the browser's toolbar."),
        "Scroll down and tap “Add to Home Screen”.",
        `Tap Add. ${lastStep}`,
        afterInstallNote || null,
      ].filter(Boolean)),
      h("p", { class: "hint", text: "No Share button? Open this page in Safari first." }));
  }

  const prompt = installPrompt();
  if (prompt) {
    const button = h("button", {
      type: "button", class: "solid-btn", text: "Install Water Pact",
      onClick: async () => {
        button.disabled = true;
        try {
          await prompt.prompt();
        } catch {
          toast("Use your browser's menu and choose “Install app”.");
        }
        button.disabled = false;
      },
    });
    return h("div", { class: "install" }, button, h("p", { class: "hint", text: `Then: ${lastStep.toLowerCase()}` }));
  }

  return h("div", { class: "install" },
    steps([
      "Open your browser's menu (⋮).",
      "Tap “Install app” or “Add to Home screen”.",
      lastStep,
    ]));
}
