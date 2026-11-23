// Placeholder for modules that are built in later stages. Shows no numbers and no sample data.
import { button, card, emptyState, pageHead } from "../ui.js";

export function stubPage(mod) {
  return function render(root) {
    const actions = [];
    if (mod.classicHash) actions.push(button("Open in classic interface", { kind: "primary", icon: "external", href: "/classic" + mod.classicHash }));
    root.replaceChildren(
      pageHead({ eyebrow: mod.eyebrow, title: mod.title, lede: mod.lede }),
      card(null, {}, emptyState({
        icon: mod.icon, title: `${mod.title} arrives in Stage ${mod.stage}`,
        text: mod.classicHash ? "This module is not rebuilt yet. The classic interface still provides this function and works exactly as before." : "This module is planned and not built yet. It will use real stored results only.",
        action: actions[0] || null,
      })));
  };
}
