import { musicPlayerState } from "../core/state.js";
import { initPlayer, togglePlayerVisibility } from "./mainIndex.js";
import { makeCleanupBag, addEvent } from "./cleanup.js";

export function createPlayButton() {
  const button = document.createElement("button");
  button.className = "music-button";
  button.innerHTML = '<i class="fas fa-music"></i>';
  const bag = makeCleanupBag(button);
  const onClick = () => {
    if (!musicPlayerState.playlist.length) {
      initPlayer();
    } else {
      togglePlayerVisibility();
    }
  };
  addEvent(bag, button, "click", onClick);

  return button;
}
