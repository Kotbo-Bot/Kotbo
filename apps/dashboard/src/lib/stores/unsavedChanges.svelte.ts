/**
 * Store global des modifications non enregistrées, délégué à @kotbo/ui et
 * branché sur la télémétrie locale du dashboard.
 */
import { unsavedChanges } from '@kotbo/ui';
import { trackEvent } from '../telemetry/telemetry';

unsavedChanges.setTracker(trackEvent);

export { unsavedChanges };
