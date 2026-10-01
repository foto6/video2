export const MEDIA_SHORTFORM_PROFILE_VERSION = "media.shortform_profile.r11.v1";
export const MEDIA_SHORTFORM_BUNDLE_VERSION = "media.shortform_artifact_bundle.r11.v1";
export const MEDIA_SHORTFORM_TIMELINE_SPEC_VERSION = "media.shortform_timeline_spec.r11.v1";

export const SHORTFORM_R11_PROFILE = Object.freeze({
  contractVersion: MEDIA_SHORTFORM_PROFILE_VERSION,
  width: 1080,
  height: 1920,
  aspectRatio: "9:16",
  fps: 30,
  targetDurationMs: Object.freeze({ min: 5000, max: 90000 }),
  hookWindowMs: 3000,
  safeArea: Object.freeze({ left: 72, right: 72, top: 180, bottom: 260 }),
  loudness: Object.freeze({ integratedLufs: -16, truePeakDb: -1.5, lra: 11 })
});

export function isShortformR11Timeline(timeline) {
  return timeline?.profileVersion === MEDIA_SHORTFORM_PROFILE_VERSION;
}
