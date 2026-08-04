/**
 * Recognises Jellyfin 10.11's MUI header back arrow.
 *
 * Lives in its own module because two unrelated features need the same test and neither should
 * drag the other in: osdHeaderRatings uses it to find the playback toolbar it mounts ratings into,
 * and playbackReturn uses it to notice the user leaving the player. osdHeaderRatings is a lazily
 * imported module, so a shared helper hosted there would force it to load eagerly.
 */

const BACK_LABEL_TOKENS = ["geri", "back", "zuruck", "zurück", "retour", "volver", "назад"];

export function isRenderableNode(el) {
  if (!(el instanceof Element)) return false;
  if (!el.isConnected) return false;
  if (el.closest(".hide,[hidden],[aria-hidden='true']")) return false;

  try {
    const style = window.getComputedStyle(el);
    if (!style) return true;
    if (style.display === "none" || style.visibility === "hidden") return false;
  } catch {}

  return true;
}

export function isArrowBackButton(button) {
  if (!(button instanceof HTMLElement)) return false;
  if (!isRenderableNode(button)) return false;

  try {
    if (button.querySelector('svg[data-testid="ArrowBackIcon"]')) return true;
  } catch {}

  const rawLabel = String(
    button.getAttribute("aria-label") ||
    button.getAttribute("title") ||
    button.textContent ||
    ""
  ).trim();
  if (!rawLabel) return false;

  const normalized = rawLabel
    .toLocaleLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return BACK_LABEL_TOKENS.some((token) => normalized.includes(token));
}
