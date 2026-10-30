import type { T3BudAnimal } from "@t3tools/contracts";

export const T3BUD_ANIMAL_LABELS: Record<T3BudAnimal, string> = {
  wolf: "Wolf",
  frog: "Frog",
  capybara: "Capybara",
  axolotl: "Axolotl",
};

/** Each animal's head on a transparent square, at 1x to 3x; T3Bud's background shows through. */
export const T3BUD_ANIMAL_IMAGES: Record<T3BudAnimal, number> = {
  wolf: require("../../../assets/t3bud/wolf.png"),
  frog: require("../../../assets/t3bud/frog.png"),
  capybara: require("../../../assets/t3bud/capybara.png"),
  axolotl: require("../../../assets/t3bud/axolotl.png"),
};
