// ════════════════════════════════════════════════════════════════
//  PIPELINE ADAPTER — applies red points detected by the external
//  Spark pipeline (topic red-points, relayed by the bridge over WS)
//  to the in-browser zone system. Only active in 'pipeline'
//  detection mode; in 'local' mode this module does nothing.
// ════════════════════════════════════════════════════════════════
import { kafka } from '../kafka/producer.js'

// The detector re-emits a cell while the condition persists (sliding window,
// update mode). If no refresh arrives within this TTL, the zone clears.
const PIPELINE_RED_TTL_S = 30

// Subscribes to bridge messages and forwards pipeline red points to the
// zone system. Returns a detach function for the view teardown.
export function attachPipeline(zoneSystem) {
  return kafka.subscribe(event => {
    if (!event || event.topic !== 'zone.red' || event.source !== 'pipeline') return
    if (!Number.isFinite(event.center_x) || !Number.isFinite(event.center_z)) return
    zoneSystem.applyExternalRedZone(event.center_x, event.center_z, PIPELINE_RED_TTL_S)
  })
}
